// 运营后台控制台自检（零依赖，需服务端已启动）：node src/server/admin/selftest.js
// 覆盖此前真实发生过的故障：登录成功后容器不显示（旧标签页驻留旧脚本）、按钮连点重复提交、陈旧构建不自愈。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const API = { host: '127.0.0.1', port: Number(process.env.MB_PORT || 7900) };

function makeEl() {
  return { innerHTML: '', textContent: '', value: '', checked: false, disabled: false, children: [], style: {},
    classList: { _s: new Set(['hide']), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, f) { const w = f === undefined ? !this._s.has(c) : !!f; w ? this._s.add(c) : this._s.delete(c); } },
    appendChild(c) { this.children.push(c); }, remove() {}, addEventListener(e, f) { (this._ev = this._ev || {})[e] = f; } };
}
function makeFetch(counter) {
  return (p, o) => new Promise((resolve, reject) => {
    if (counter) counter.push(p);
    const req = http.request(Object.assign({ path: p, method: (o || {}).method || 'GET', headers: (o || {}).headers || {} }, API), res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode < 400 && res.statusCode >= 200, headers: res.headers, text: async () => b, json: async () => JSON.parse(b || '{}') }));
    });
    req.on('error', reject); req.end((o || {}).body);
  });
}
function run(src, opts) {
  opts = opts || {};
  const map = new Map();
  const doc = { getElementById: id => (map.has(id) ? map.get(id) : (map.set(id, makeEl()), map.get(id))), createElement: () => makeEl(), addEventListener() {} };
  const st = opts.storage || new Map();
  const ls = { getItem: k => (st.has(k) ? st.get(k) : null), setItem: (k, v) => st.set(k, String(v)), removeItem: k => st.delete(k) };
  const win = { addEventListener() {} };
  const loc = { reloaded: 0, reload() { loc.reloaded++; } };
  const fn = new Function('document', 'localStorage', 'fetch', 'setTimeout', 'confirm', 'alert', 'window', 'location',
    src + '\n;globalThis.__T = { doLogin, checkStale, boot };');
  fn(doc, ls, opts.fetch || makeFetch(opts.counter), setTimeout, () => true, () => {}, win, loc);
  return { E: id => doc.getElementById(id), T: () => globalThis.__T, loc, ls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : '')); }

(async () => {
  // 1) 正常登录：进入控制台，且无需兜底重载
  const A = run(script);
  await wait(150);
  A.E('lu').value = process.env.MB_ADMIN_USERNAME || 'admin';
  A.E('lp').value = process.env.MB_ADMIN_PASSWORD || 'admin1234';
  await A.E('btnLogin')._ev.click({ preventDefault() {} });
  await wait(900);
  check('登录成功后进入控制台', !A.E('app').classList.contains('hide') && A.E('login').classList.contains('hide'));
  check('正常路径不触发多余重载', A.loc.reloaded === 0);
  check('七个模块 Tab 渲染齐全', ['运营看板', '模型节点', '运营配置', '功能开关', '内容审核', '用户运营', '审计日志'].every(t => A.E('tabs').innerHTML.includes(t)));
  check('看板渲染出真实数据', A.E('pane').innerHTML.includes('kpi') && !A.E('pane').innerHTML.includes('加载失败'));

  // 2) 连点三次：只发一次登录请求
  const cnt = [];
  const B = run(script, { counter: cnt });
  await wait(150);
  B.E('lu').value = process.env.MB_ADMIN_USERNAME || 'admin';
  B.E('lp').value = process.env.MB_ADMIN_PASSWORD || 'admin1234';
  const click = B.E('btnLogin')._ev.click;
  click({ preventDefault() {} }); click({ preventDefault() {} }); click({ preventDefault() {} });
  await wait(900);
  const logins = cnt.filter(p => p === '/admin/login').length;
  check('连点 3 次仅一次登录请求（防重复提交）', logins === 1, '请求数=' + logins);

  // 3) 复现历史故障：boot 缺少 show(true)（等价于标签页驻留旧脚本）→ 必须自愈重载
  const broken = script.replace('show(true); renderTabs(); reloadTab();', 'renderTabs(); reloadTab();');
  if (broken === script) {
    check('可构造"旧脚本驻留"故障样本', false, 'boot() 结构已变，请同步本自检');
  } else {
    const C = run(broken);
    await wait(150);
    C.E('lu').value = process.env.MB_ADMIN_USERNAME || 'admin';
    C.E('lp').value = process.env.MB_ADMIN_PASSWORD || 'admin1234';
    await C.E('btnLogin')._ev.click({ preventDefault() {} });
    await wait(1200);
    check('容器未显示时自动重载自愈', C.loc.reloaded >= 1 && !!C.ls.getItem('mb_admin_token'));
  }

  // 4) 服务端构建号变化 → 陈旧标签页自动重载
  const loc4 = { reloaded: 0, reload() { loc4.reloaded++; } };
  const doc4 = { getElementById: () => makeEl(), createElement: () => makeEl(), addEventListener() {} };
  const hijack = (p, o) => (String(p).startsWith('/admin/?')
    ? Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => "<script>const PAGE_BUILD='v0000';</script>", json: async () => ({}) })
    : makeFetch()(p, o));
  const fn4 = new Function('document', 'localStorage', 'fetch', 'setTimeout', 'confirm', 'alert', 'window', 'location',
    script + '\n;globalThis.__T4 = { checkStale };');
  fn4(doc4, { getItem: () => null, setItem() {}, removeItem() {} }, hijack, setTimeout, () => true, () => {}, { addEventListener() {} }, loc4);
  await wait(200);
  await globalThis.__T4.checkStale();
  await wait(600);
  check('构建号变化时陈旧标签页自动重载', loc4.reloaded >= 1);

  const bad = results.filter(r => !r.ok);
  console.log('\n' + (bad.length ? '❌ 失败 ' + bad.length + ' 项' : '✅ 全部通过（' + results.length + ' 项）'));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('自检异常:', e && e.message || e); process.exit(2); });
