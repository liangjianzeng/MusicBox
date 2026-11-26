// V22 · 多模态上下文（图片）mock-only 验收（契约 v5.0 / Phase 3）。
// 覆盖：PIPL/consent 继承、图片 ref 归属（跨用户 + 72h TTL）、VLM 离线降级（fail-open 只用文字）。
// LLM/GPU 端点均不可达（规则模式）；图片理解走 fail-open，模型离线时只用用户文字。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers.js');
const facade = require('../../src/server/l2assistant/facade');

let S;

function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); }
function ok(value, message) { assert.ok(value, message); }
function notOk(value, message) { assert.ok(!value, message); }

function uploadImage(ctx, guest, consent) {
  return ctx.api('POST', '/v1/assistant/image', {
    token: guest.token,
    multipart: {
      fields: consent === false ? {} : { consent: 'true' },
      files: [{ field: 'file', filename: 'a.png', data: H.makePng(), contentType: 'image/png' }],
    },
  });
}
function message(ctx, guest, text, extra) {
  return ctx.api('POST', '/v1/assistant/messages', {
    token: guest.token, json: Object.assign({ client_msg_id: H.uniq('cm_'), text }, extra || {}),
  });
}
async function newSession(ctx, guest, context) {
  const r = await ctx.api('POST', '/v1/assistant/sessions', { token: guest.token, json: { context } });
  eq(r.status, 201, '创建统一会话应 201，实际 ' + r.status + ' ' + r.text.slice(0, 180));
  return r.json.session;
}
function hasImageRef(session, imageId) {
  return (session.refs || []).some((r) => r.type === 'image' && r.id === imageId);
}

describe('V22 多模态上下文（图片）', () => {
  before(async () => {
    S = await H.boot('V22', { noFakeExecutor: true });
  });
  after(async () => { await S.close(); });

  it('PIPL/consent 继承：未授权图片拒绝上传', async () => {
    const guest = await S.newGuest();
    const r = await uploadImage(S, guest, false);
    eq(r.status, 400, '无 consent 上传应 400，实际 ' + r.status + ' ' + r.text.slice(0, 120));
  });

  it('PIPL/consent 继承：consent=true 可上传并返回 image_id', async () => {
    const guest = await S.newGuest();
    const r = await uploadImage(S, guest, true);
    eq(r.status, 200, 'consent=true 上传应 200，实际 ' + r.status + ' ' + r.text.slice(0, 120));
    ok(r.json.image_id, '应返回 image_id');
  });

  it('图片 ref 归属：只能解析本人未过期的上传', async () => {
    const owner = await S.newGuest();
    const other = await S.newGuest();
    const up = await uploadImage(S, owner, true);
    eq(up.status, 200, '前置上传应 200');
    const imageId = up.json.image_id;

    const sOwner = await newSession(S, owner, { refs: [{ type: 'image', id: imageId }] });
    ok(hasImageRef(sOwner, imageId), 'owner 的 image ref 应被解析');

    const sOther = await newSession(S, other, { refs: [{ type: 'image', id: imageId }] });
    notOk(hasImageRef(sOther, imageId), 'other 的 image ref 应被拒绝（跨用户）');
  });

  it('图片 ref 归属：过期上传被拒绝', async () => {
    const guest = await S.newGuest();
    const up = await uploadImage(S, guest, true);
    const imageId = up.json.image_id;
    const db = H.openWhiteDb(S.dbPath);
    try {
      db.prepare('UPDATE uploads SET expire_at=? WHERE id=?').run(new Date(Date.now() - 3600000).toISOString(), imageId);
    } finally { try { db.close(); } catch (e) { /* noop */ } }
    const s = await newSession(S, guest, { refs: [{ type: 'image', id: imageId }] });
    notOk(hasImageRef(s, imageId), '过期 image ref 应被拒绝');
  });

  it('VLM 离线降级：带图片的消息只用文字、不报错', async () => {
    const guest = await S.newGuest();
    const up = await uploadImage(S, guest, true);
    const imageId = up.json.image_id;
    const r = await message(S, guest, '帮我描述这张图', { context: { refs: [{ type: 'image', id: imageId }] } });
    eq(r.status, 200, '带图片消息应 200，实际 ' + r.status + ' ' + r.text.slice(0, 120));
    ok(r.json.meta, '应返回 meta（含 mode/status）');
    ok(r.json.reply, '应返回回复（fail-open 用文字）');
  });

  it('VLM 离线降级：describeImage 读不到图时 fail-open 返回 null（不抛错）', async () => {
    const desc = await facade.describeImage({ path: path.join(os.tmpdir(), 'v22_no_such_file_' + H.uniq('') + '.png') });
    eq(desc, null, '读不到图片时应 fail-open 返回 null，不抛错');
  });
});
