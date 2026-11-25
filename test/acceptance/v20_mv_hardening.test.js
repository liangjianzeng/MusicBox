'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
});
