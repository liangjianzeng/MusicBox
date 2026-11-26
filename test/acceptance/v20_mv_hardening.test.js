'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 契约：契约 v5.1（MV 加固回归口径 —— 审核词库 fail closed、机审指纹、JSON 数组归一）
describe('MV hardening unit regressions', () => {
  it('moderation read failures fail closed and retain the last known-good rules', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mv-rules-'));
    const previousRoot = process.env.MB_VAR_ROOT;
    process.env.MB_VAR_ROOT = root;
    const configPath = path.join(root, 'config', 'moderation_words.txt');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'blocked_one\n', 'utf8');
    try {
      const rules = require('../../src/server/core/rules.js');
      assert.equal(rules.moderate('contains blocked_one').ok, false);
      const originalRead = fs.readFileSync;
      const mocked = t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (path.resolve(String(file)) === path.resolve(configPath)) {
          const error = new Error('simulated read failure');
          error.code = 'EACCES';
          throw error;
        }
        return originalRead.call(this, file, ...args);
      });
      assert.throws(() => rules.moderate('ordinary text'), (error) => error.code === 'MODERATION_UNAVAILABLE');
      const stale = rules.stats();
      assert.equal(stale.available, false);
      assert.equal(stale.stale, true);
      assert.equal(stale.plain, 1);
      mocked.mock.restore();
      assert.equal(rules.moderate('contains blocked_one').ok, false);
      fs.writeFileSync(configPath, 'blocked_one\nblocked_two\n', 'utf8');
      assert.equal(rules.stats().plain, 2);
      assert.equal(rules.moderate('contains blocked_two').ok, false);
    } finally {
      if (previousRoot === undefined) delete process.env.MB_VAR_ROOT;
      else process.env.MB_VAR_ROOT = previousRoot;
      try { require('../../src/server/core/store.js').db().close(); } catch (e) { /* no database opened */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('review hash ignores generated IDs and timing windows but tracks script content', () => {
    const aireview = require('../../src/server/core/mv_aireview.js');
    const script = { shots: [{ id: 'mvs_a', seq: 1, kind: 'singing', sec: 8, lyric_from: 0, lyric_to: 1, desc: '窗边演唱', camera: '中景', cast_ids: ['mvc_a'] }], timings: [{ start: 0, end: 4 }] };
    const before = aireview.scriptHash(script);
    const derived = JSON.parse(JSON.stringify(script));
    derived.shots[0].id = 'mvs_generated';
    derived.shots[0].window = { start: 0, end: 4 };
    derived.shots[0].storyboard_url = '2026-11/f_board.png';
    derived.timings[0].start = 0.2;
    assert.equal(aireview.scriptHash(derived), before, '派生身份与对齐结果不得让机审过期');
    derived.shots[0].desc = '改成另一个画面';
    assert.notEqual(aireview.scriptHash(derived), before, '用户面剧本变更必须让机审过期');
  });

  it('database JSON arrays are decoded instead of returned as one string', () => {
    const U = require('../../src/server/core/util.js');
    assert.deepEqual(U.toArr('[]'), []);
    assert.deepEqual(U.toArr('["mvc_a","mvc_b"]'), ['mvc_a', 'mvc_b']);
    assert.deepEqual(U.toArr('mvc_a,mvc_b'), ['mvc_a', 'mvc_b']);
  });
});
