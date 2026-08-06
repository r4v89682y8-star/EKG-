#!/usr/bin/env node
/* فاحص آلي لـ index.html — يعمل بـ: node scripts/check.js
   لا يعدّل الملف، ولا يحتاج أي حزمة خارجية.
   يفحص خمسة أمور: صحة الصياغة، ومعالِجات الأحداث، وحراسة الرسم،
   والأساس المحاسبي، وتهريب البيانات. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');
const lineOf = idx => src.slice(0, idx).split('\n').length;

const findings = [];
const report = (severity, check, line, message, snippet) =>
  findings.push({ severity, check, line, message, snippet: (snippet || '').trim().slice(0, 110) });

/* ═══ استخراج كتل السكربت المضمّنة ═══ */
const blocks = [];
for (const m of src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  blocks.push({ code: m[1], start: lineOf(m.index) });
}

/* ═══ ١ — صحة الصياغة ═══ */
for (const b of blocks) {
  try {
    new vm.Script(b.code, { filename: 'index.html' });
  } catch (e) {
    const rel = Number((e.stack || '').match(/index\.html:(\d+)/)?.[1] || 1);
    report('حرج', 'الصياغة', b.start + rel - 1, 'خطأ صياغة يمنع تشغيل السكربت: ' + e.message);
  }
}

/* ═══ جمع أسماء الدوال المعرّفة ═══ */
const defined = new Set();
const allCode = blocks.map(b => b.code).join('\n');
for (const re of [
  /(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/g,
]) for (const m of allCode.matchAll(re)) defined.add(m[1]);

/* أسماء عامة وكلمات محجوزة لا تُعدّ دوالًا مفقودة */
const GLOBALS = new Set([
  'alert', 'confirm', 'prompt', 'console', 'event', 'this', 'window', 'document',
  'location', 'setTimeout', 'clearTimeout', 'Number', 'String', 'Boolean', 'Math', 'JSON',
  /* كلمات محجوزة تسبق قوسًا فتبدو استدعاءً */
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
]);

/* ═══ ٢ — معالِجات الأحداث: هل الدالة معرّفة؟ ═══ */
for (const m of src.matchAll(/\bon(click|change|input|keydown|submit|pointerdown|pointerup|pointerleave)\s*=\s*"([^"]*)"/g)) {
  const line = lineOf(m.index);
  const body = m[2];
  /* كل استدعاء دالة في بداية جملة داخل المعالِج */
  for (const c of body.matchAll(/(?:^|[;{}]|\?\s*|:\s*)\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = c[1];
    if (GLOBALS.has(name) || defined.has(name)) continue;
    if (/^\$\{/.test(body.slice(c.index))) continue;
    report('حرج', 'معالِج حدث', line, `المعالِج ينادي «${name}» وهي غير معرّفة في الملف`, body);
  }
}

/* ═══ ٣ — الكتابة في innerHTML بلا حراسة ═══ */
/* نقسّم الشيفرة إلى دوال، ونفحص كل دالة تجلب عنصرًا ثم تكتب فيه */
const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
const fnStarts = [...allCode.matchAll(fnRe)].map(m => ({
  name: m[1], idx: m.index + m[0].length, line: m.index,
}));
for (let i = 0; i < fnStarts.length; i++) {
  const from = fnStarts[i].idx;
  const to = i + 1 < fnStarts.length ? fnStarts[i + 1].idx : allCode.length;
  const body = allCode.slice(from, to);
  /* المتغيّرات التي جاءت من getElementById داخل هذه الدالة */
  const vars = [...body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(/g)].map(m => m[1]);
  if (!vars.length) continue;
  const guarded = new Set(
    [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*dataset\s*\.\s*ghost/g)].map(m => m[1])
  );
  for (const v of vars) {
    const writes = body.match(new RegExp('\\b' + v + '\\s*\\.\\s*innerHTML\\s*(\\+?=)'));
    /* if(!box) return لا تكشف شيئًا: العنصر الصوري كائن صحيح المنطق */
    const fakeGuard = new RegExp('if\\s*\\(\\s*!\\s*' + v + '\\s*\\)\\s*return').test(body);
    if (writes && !guarded.has(v) && fakeGuard) {
      const at2 = allCode.slice(0, from).split('\n').length + blocks[0].start - 1;
      report('متوسط', 'حراسة الرسم', at2,
        `«${fnStarts[i].name}» تحرس «${v}» بـ if(!${v}) return — والعنصر الصوري ليس falsy فلا تعمل`, 'if(!' + v + ') return');
    }
    if (writes && !guarded.has(v)) {
      const at = allCode.slice(0, from + body.indexOf(writes[0])).split('\n').length;
      const abs = blocks.find(b => true) ? at : at;
      report('متوسط', 'حراسة الرسم', abs + blocks[0].start - 1,
        `«${fnStarts[i].name}» تكتب في «${v}.innerHTML» بلا فحص dataset.ghost`, writes[0]);
    }
  }
}

/* ═══ ٤ — حسابات مالية تتجاوز الأساس المحاسبي ═══ */
const MONEY_FIELDS = /\.(amount|paid_amount|vat_amount)\b/;
/* paid_amount و vat_amount حقلا الدفعات وحدها؛ أما amount فيوجد أيضًا في
   المصروفات والتحويلات وحركات الصيانة، فلا يُحاسَب إلا في سياق دفعة. */
const PAYMENT_CTX = /\b(payments?|dueOf|paidOf|restOf|vat_amount|paid_amount|lease_id|due_date|have|want)\b/;
/* الأسطر المسموح لها بالوصول المباشر: تعريف الدوال الثلاث، وبناء صفوف الإدراج */
const ALLOW = /^\s*(const\s+(dueOf|paidOf|restOf)|\/\*|\/\/|\*)/;
allCode.split('\n').forEach((ln, i) => {
  if (!MONEY_FIELDS.test(ln)) return;
  if (ALLOW.test(ln)) return;
  /* حساب = يظهر الحقل داخل جمع أو طرح أو Number() ضمن تعبير حسابي */
  const arithmetic = /[+\-*/]\s*Number\([^)]*\.(amount|paid_amount|vat_amount)|Number\([^)]*\.(amount|paid_amount|vat_amount)[^)]*\)\s*[+\-*/]|\+\s*[A-Za-z_$][\w$]*\.(amount|paid_amount|vat_amount)|\.(amount|paid_amount|vat_amount)\s*[+\-*/]/;
  const insert = /(amount|paid_amount|vat_amount)\s*:/;
  if (insert.test(ln) && !arithmetic.test(ln)) return;
  if (!arithmetic.test(ln)) return;
  if (!PAYMENT_CTX.test(ln)) return;                 /* مصروف أو تحويل، لا دفعة */
  const abs = i + 1 + blocks[0].start - 1;
  report('متوسط', 'الأساس المحاسبي', abs,
    'حساب مالي يقرأ الحقل مباشرةً بدل dueOf / paidOf / restOf', ln);
});

/* ═══ ٥ — بيانات تُعرض بلا تهريب ═══ */
/* حقول نصية مصدرها قاعدة البيانات، ويجب أن تمرّ بـ esc قبل العرض */
const TEXT_FIELDS = [
  'full_name', 'building_name', 'unit_number', 'notes', 'description', 'vendor',
  'owner_name', 'phone', 'national_id', 'email', 'reference', 'receipt_number', 'name',
];
const fieldRe = new RegExp('\\$\\{([^}]*\\.(?:' + TEXT_FIELDS.join('|') + ')\\b[^}]*)\\}', 'g');
for (const m of allCode.matchAll(fieldRe)) {
  const expr = m[1];
  if (/\besc\s*\(|\bescJs\s*\(|\bmoney\s*\(|\bNumber\s*\(/.test(expr)) continue;
  /* مقارنات وشروط لا تُعرض */
  if (/[=!]==?|\.includes\(|\.filter\(|\.map\(|\.some\(|\.find\(/.test(expr)) continue;
  /* قيمة تُبنى لتُكتب في قاعدة البيانات (notes: `…`) لا تُعرض، فلا تُهرَّب */
  const ctx = allCode.slice(Math.max(0, m.index - 90), m.index);
  if (/\b(notes|description|details|full_name)\s*:\s*`[^`]*$/.test(ctx)) continue;
  const abs = allCode.slice(0, m.index).split('\n').length + blocks[0].start - 1;
  report('متوسط', 'التهريب', abs, 'بيانات تُعرض بلا esc', '${' + expr + '}');
}

/* ═══ التقرير ═══ */
const ORDER = { 'حرج': 0, 'متوسط': 1, 'منخفض': 2 };
findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.line - b.line);

const BAR = '─'.repeat(64);
console.log('\n' + BAR);
console.log('  تقرير فحص index.html');
console.log(`  ${lines.length} سطرًا · ${blocks.length} كتلة سكربت · ${defined.size} دالة معرّفة`);
console.log(BAR + '\n');

if (!findings.length) {
  console.log('  لا ملاحظات. الملف مطابق لقيود المشروع.\n');
} else {
  let current = '';
  for (const f of findings) {
    if (f.check !== current) {
      current = f.check;
      console.log(`\n  ▸ ${f.check}`);
    }
    console.log(`    [${f.severity}] سطر ${f.line} — ${f.message}`);
    if (f.snippet) console.log(`             ${f.snippet}`);
  }
  const bySev = s => findings.filter(f => f.severity === s).length;
  console.log('\n' + BAR);
  console.log(`  الإجمالي: ${findings.length} ملاحظة · حرج ${bySev('حرج')} · متوسط ${bySev('متوسط')} · منخفض ${bySev('منخفض')}`);
  console.log(BAR + '\n');
}

process.exit(findings.some(f => f.severity === 'حرج') ? 1 : 0);
