'use strict';
/*
 * V39 —— 界面里不许出现"解释控件不是什么"的说明句（2026-11-28 用户原话）
 *
 *   「单选 · 这是"人"，不是风格」这他妈的都可以做界面提示，是我疯了还是你疯了？
 *
 * 一句话说明白它的性质：**需要靠脚注才能被理解的控件，控件本身就不合格**。
 * 该删的是控件（或改它的形态），不是给用户加阅读负担。这类句子还是同一批 bug 的化石：
 * 女声/男声曾被塞进「风格点缀」，于是每处都要澄清"这次不是风格"——澄清句子活得比 bug 久。
 *
 * 同时钉住另一半：分组标签**不许在小屏上消失**。只留一排裸 chips 时，用户更无从判断
 * 这排是选人还是选风格 —— 那是把"看得懂"的代价转嫁给屏幕够大的人。
 *
 * 反向验证：把任意一句说明句塞回界面文本，本判词必红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'src', 'app', 'lib');

function dartFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dartFiles(p, out);
    else if (e.name.endsWith('.dart')) out.push(p);
  }
  return out;
}

// 只看**用户看得见的字符串**：Text('…') / hint: '…' / trailing: '…' / label: '…'
const USER_TEXT = /(?:Text\(\s*|hint:\s*|trailing:\s*|label:\s*|title:\s*)'([^']*)'/g;
// 澄清"不是什么"的句式（注释里出现不算，因为这里只扫字符串字面量）
const APOLOGY = /[^\s]不是(风格|曲风|BPM|bpm|唱法|质感)|而非(风格|曲风)|这是"人"/;

test('V39-① 界面文本里不许出现"这是 X 不是 Y"式澄清说明句', () => {
  const hits = [];
  for (const f of dartFiles(LIB)) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;   // 注释留给工程师，不算界面
      let m;
      USER_TEXT.lastIndex = 0;
      while ((m = USER_TEXT.exec(line)) !== null) {
        if (APOLOGY.test(m[1])) {
          hits.push(path.relative(LIB, f) + ':' + (i + 1) + ' 「' + m[1] + '」');
        }
      }
    });
  }
  assert.deepStrictEqual(hits, [],
    '这些地方在用脚注替控件解释自己不是什么 —— 该改的是控件：\n  ' + hits.join('\n  '));
});

test('V39-② 「谁来唱」的分组标签必须无条件存在（小屏不许只剩裸 chips）', () => {
  const src = fs.readFileSync(path.join(LIB, 'features/create/shell_easy.dart'), 'utf8');
  // 现场：标签曾挂在 `if (!shortScreen)` 下，320×568 上只剩一排裸 chips，比有标签更易误读
  const idx = src.indexOf("'谁来唱'");
  assert.ok(idx >= 0, '简约档必须保留「谁来唱」分组标签（三档一致，见 v5.6.6）');
  const before = src.slice(Math.max(0, idx - 260), idx);
  assert.ok(!/if\s*\(\s*!shortScreen\s*\)\s*(const\s+)?Row\(/.test(before),
    '「谁来唱」标签被 if (!shortScreen) 包住了：小屏/2 倍字号下它会整行消失，只剩裸 chips');
  assert.ok(/SingleChildScrollView\(\s*scrollDirection:\s*Axis\.horizontal/.test(src),
    'chips 必须单行横向滚动：Wrap 在 2 倍字号下折行会把 sticky dock 顶出屏（143px 事故）');
});
