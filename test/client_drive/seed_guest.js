// 固定 device_key 建 guest 并灌足余额，供真机全流程复用。
const store = require('../../src/server/core/store');
const U = require('../../src/server/core/util');
const key = process.argv[2] || 'seed-1540';
const hash = U.sha256hex(key);
let user = store.get('SELECT * FROM users WHERE guest_key=?', hash);
if (!user) {
  const id = U.uid('u_');
  store.run('INSERT INTO users(id,guest_key,nickname,status,created_at) VALUES(?,?,?,?,?)',
    id, hash, '音乐旅人9999', 'active', U.nowIso());
  user = store.get('SELECT * FROM users WHERE id=?', id);
}
// 关键：先锁定今日已重置，确保 ensureDaily 不触发 daily_expire 清零
store.setPref(user.id, 'credit_reset_day', U.todayLocal());
const before = store.getBalance(user.id);
const after = store.appendLedger(user.id, 1000000, 'seed_manual', 'seed', 'c127-fullflow');
console.log(JSON.stringify({ device_key: key, user_id: user.id, nickname: user.nickname, before, after, reset_day: store.getPref(user.id, 'credit_reset_day') }));
