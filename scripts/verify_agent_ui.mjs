// 伴创（智能体）迁移 UI 规范机检（契约 v5.5.17 / 方案 §11.7）
//
// 为什么要有这个脚本：§11 那套规则如果只是一份文档，移植 TongYi-Lite 时一定会被"顺手抄过来"击穿。
// 抄来的 UI 能跑、能过功能测试，只有人眼逐行看才会发现它带着 Material 依赖、裸色值和黑话文案。
// 所以把可机检的部分全部下沉到这里，红了就不许入仓。
//
// 扫描范围刻意只限 **新迁入的 agent 特性目录**：仓库存量代码本身有已知偏差
// （assistant_surface.dart 8 处裸 Color、main.dart 背景色与 CreationPalette 不一致），
// 那是 §11.3 登记过的既有债，登记在册不等于现在可以扩大污染面 —— 新代码必须干净。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AGENT_DIR = path.join(ROOT, 'src', 'app', 'lib', 'features', 'agent');
// 第 4 档位隐藏的闸门在档位表里，不在 agent 目录内 —— 只扫 agent/** 会漏掉真正的开关点
const TIER_CONFIG = path.join(ROOT, 'src', 'app', 'lib', 'features', 'creation', 'tier_config.dart');
const AGENT_TESTS = [
  path.join(ROOT, 'src', 'app', 'test', 'agent_engine_test.dart'),
  path.join(ROOT, 'src', 'app', 'test', 'agent_ui_test.dart'),
];

const fail = [];
const warn = [];
const ok = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.dart')) out.push(p);
  }
  return out;
}

const files = walk(AGENT_DIR);
if (!files.length) {
  warn.push(`未找到 ${path.relative(ROOT, AGENT_DIR)} 下的 Dart 文件（伴创尚未落地时属正常，落地后本项转为硬检查）`);
}

// 逻辑层：这些目录里出现 Material 依赖就是设计违约（引擎必须能在无 Flutter 环境下单测）
const LOGIC_DIRS = ['engine', 'tools', 'skills'];
const isLogic = (f) => {
  const rel = path.relative(AGENT_DIR, f).split(path.sep);
  return LOGIC_DIRS.includes(rel[0]);
};

// 用户可见文案里不许出现的技术黑话（§11.5）：引擎名/模型名/协议名/参数名
const JARGON = [
  [/\bqwen[\w.-]*/i, '模型名'], [/\bvllm\b/i, '推理引擎名'], [/\bDGX\b/, '硬件名'],
  [/\btool_calls\b/, '协议字段名'], [/\breasoning_tokens?\b/, '内部计量名'],
  [/\bprompt_tokens?\b/, '内部计量名'], [/\bmax_tokens\b/, '内部参数名'], [/\btemperature\s*[:=]/, '采样参数名'],
];

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const inUi = path.relative(AGENT_DIR, f).split(path.sep)[0] === 'ui';
  const hit = (re, why, where = lines) => {
    where.forEach((ln, i) => {
      if (re.test(ln)) fail.push(`${rel}:${i + 1} ${why}\n      ${ln.trim().slice(0, 110)}`);
    });
  };

  // §11.1 逻辑层零 Flutter 依赖
  if (isLogic(f)) {
    hit(/import\s+'package:flutter\/(material|widgets)\.dart'/,
      '逻辑层禁止依赖 Flutter（引擎必须可纯 Dart 单测，§11.1）');
  }
  // §11.1 禁止整体搬运 TongYi-Lite 的 screens/widgets（含 agent_workflow.dart 2334 行）
  hit(/\bAgentWorkflow\b|agent_workflow\.dart/, '疑似整体搬运 TongYi-Lite 工作流组件（§11.1 明令禁搬）');
  // §11.2 颜色只准取自 CreationPalette
  hit(/Color\(\s*0x[0-9a-fA-F]{6,8}\s*\)/, '裸色值，必须改用 CreationPalette token（§11.2）');
  hit(/Colors\.(red|green|blue|white|black|grey|orange|amber)\b/,
    '裸 Material 调色板，必须改用 CreationPalette token（§11.2）');
  // §11.3 已知偏差不得在新代码里重现
  hit(/InputDecoration\(\s*border:\s*OutlineInputBorder\(\)\s*\)/,
    '裸 OutlineInputBorder 输入框（§11.3 已登记为存量偏差，新代码不得再现）');
  // §11.5 面向用户的字符串不得出现技术黑话
  // §11.5 面向用户的字符串不得出现技术黑话。
  // 判定必须盯"文案"而不是"任何字符串"：`json['tool_calls']`、`'prompt_tokens': n` 是线协议字段，
  // 清洗黑话的正则里更要包含这些词 —— 早先版本把它们全判红，等于逼着代码绕开检查（断言粗糙惩罚正确代码）。
  // 因此只认两类：含中文的字符串（就是我们的用户文案），以及 UI 目录里显式当文案用的字面量。
  const CJK = /[一-鿿]/;
  const PROTOCOLISH = /RegExp\(|allMatches|replaceAll|json\[|\bcase\s|map\[|\[\s*'/;
  const strings = lines.filter((ln) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(ln)) return false;
    if (PROTOCOLISH.test(ln)) return false;
    const lits = ln.match(/'([^'\\\n]+)'/g) || [];
    // 丢掉 map key（'x' 紧跟冒号）：那是字段名不是文案
    return lits.some((l, i) => {
      const at = ln.indexOf(l);
      const after = ln.slice(at + l.length, at + l.length + 1);
      if (after === ':') return false;
      return CJK.test(l) || inUi;
    });
  });
  for (const [re, why] of JARGON) hit(re, `用户可见文案含技术黑话：${why}（§11.5）`, strings);
}

// §11.6 语义节点：测试不得用 warnIfMissed:false 掩盖漏挂
for (const t of AGENT_TESTS) {
  if (!fs.existsSync(t)) continue;
  const rel = path.relative(ROOT, t);
  fs.readFileSync(t, 'utf8').split('\n').forEach((ln, i) => {
    // 只看真代码：注释里写"此处禁止 warnIfMissed:false"是**好事**，不该被判红（否则等于逼人别写解释）
    if (/^\s*(\/\/|\/\*|\*)/.test(ln)) return;
    if (/warnIfMissed\s*:\s*false/.test(ln)) {
      fail.push(`${rel}:${i + 1} 禁止用 warnIfMissed:false 掩盖语义节点缺失（§11.6：tap 不到就是要红，不是要静音）`);
    }
  });
}

// 灰度关时第 4 档位必须整档隐藏（D-3）：只要 agent 特性存在，就必须有 createAgentMode 的读取点
if (files.length) {
  const gates = [...files];
  if (fs.existsSync(TIER_CONFIG)) gates.push(TIER_CONFIG);
  const all = gates.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  if (!/createAgentMode/.test(all)) {
    fail.push('agent 特性里找不到 createAgentMode 读取点：灰度关时第 4 档位必须整档隐藏，不能只靠后端 404（D-3）');
  }
}

// 底部导航红线（CONTRACTS.md:718 / :814 / v5.5.15）：恒 5 个一级页，第 4 槽位数据驱动。
// 为什么机检而不是 widget 测试：全量 pump 根壳要把 5 个业务页都拉起来，假件覆盖不全时
// 得到的是假红/假绿；这条是**结构性**约束，源码级判它最稳。
{
  const RS = path.join(ROOT, 'src', 'app', 'lib', 'root_shell.dart');
  const ME = path.join(ROOT, 'src', 'app', 'lib', 'features', 'me', 'me_page.dart');
  if (fs.existsSync(RS)) {
    const src = fs.readFileSync(RS, 'utf8');
    // 判**结构**而不是数字面量：第 4 槽位是三元（灰度开=智能体 / 关=人格），
    // 两个分支各一个字面量，所以正确写法下可见槽位 5 个、字面量 6 个。
    // 早先按"字面量必须 5 个"判，把正确代码判成违规 —— 机检宁可判结构，别拿字面量数量当真理。
    const plain = (src.match(/const NavigationDestination\(/g) || []).length;
    const cond = (src.match(/\?\s*const NavigationDestination\(/g) || []).length;
    const alt = (src.match(/:\s*const NavigationDestination\(/g) || []).length;
    if (!(plain === 6 && cond === 1 && alt === 1)) {
      fail.push(`底部 tab 结构不对：固定字面量 ${plain} 个、三元分支 ${cond}/${alt} —— 应为 5 个槽位（4 个固定 + 第 4 槽位随灰度二选一），且不新增底部一级页（V35-㉕㉙）`);
    }
    if (!/cocreateEnabledOf\(/.test(src) || !/AgentCocreatePage/.test(src)) {
      fail.push('第 4 槽位没有随 createAgentMode 分叉（缺 cocreateEnabledOf / AgentCocreatePage）：灰度关时必须回到「人格」，不能写死');
    }
    // 智能体那一格不许挂助手悬浮入口（2026-11-28 产品拍板，契约 v5.9.6）：
    // 那一格就是老大本人，底下再浮一个「助手」等于鼓动用户往下找小弟（与 v5.8.4 同向）。
    // 判法：每一处 AssistantDock() 的渲染都必须被 showAssistantDockAt 这个具名判据扣住 ——
    // 判据存在且真的排除了第 4 格，才认为这条口径还在。
    for (const [i, ln] of src.split('\n').entries()) {
      if (ln.includes('AssistantDock()') && !ln.includes('showAssistantDockAt(')) {
        fail.push(`root_shell.dart:${i + 1} 无条件渲染 AssistantDock()：智能体那一格必须扣住助手入口（v5.9.6）`);
      }
    }
    if (!/showAssistantDockAt\(RemoteConfig\? rc, int tab\)[\s\S]{0,120}cocreateEnabledOf\(rc\) && tab == 3/.test(src)) {
      fail.push('showAssistantDockAt 判据不见了或没排除第 4 格：助手入口的去留又变回没人守着（v5.9.6）');
    }
    // 换人与入口必须同批：tab 顶替了人格，「我的」里就必须还有一条路进人格页，否则人格成孤儿页（D-8）
    if (fs.existsSync(ME)) {
      const me = fs.readFileSync(ME, 'utf8');
      if (!/PersonaPage/.test(me)) {
        fail.push('第 4 槽位换成了智能体，但「我的」里没有进 PersonaPage 的入口 —— 人格页成了没人能打开的孤儿页（D-8 要求两条同批上线）');
      }
    }
  }
  // 层级只有一个方向（2026-11-27 产品更正）：小助理往上交给智能体；智能体不把难题推回小助理。
  const COMPOSER = path.join(ROOT, 'src', 'app', 'lib', 'features', 'agent', 'ui', 'agent_composer.dart');
  const PAGE = path.join(ROOT, 'src', 'app', 'lib', 'features', 'agent', 'ui', 'agent_cocreate_page.dart');
  if (fs.existsSync(COMPOSER) && fs.existsSync(PAGE)) {
    const page = fs.readFileSync(PAGE, 'utf8');
    if (/panelAssistantLabel:\s*'/.test(page)) {
      fail.push('智能体（老大）页面又挂上了「交给小助手」的下沉出口 —— 层级只能向上交，老大不许把难题推给本页小助理');
    }
  }
}

// riverpod 硬规矩（2026-11-27 K90 红屏的根因）：`ref.listen` 只能在 build 里调，
// 在 `initState` 里调会抛 debugDoingBuild 断言 —— release 关掉断言，线上完全隐形，
// 所以这条必须机检：谁哪天图省事把 listen 挪回 initState，闸门当场拦住。
{
  const offenders = [];
  for (const f of [...files, ...(fs.existsSync(TIER_CONFIG) ? [TIER_CONFIG] : [])]) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('ref.listen')) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/void\s+initState\s*\(/.test(lines[i])) continue;
      let depth = 0;
      let seen = false;
      for (let j = i; j < lines.length; j += 1) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth += 1; seen = true; }
          if (ch === '}') depth -= 1;
        }
        if (!lines[j].trimStart().startsWith('//') && /ref\.listen\s*\(/.test(lines[j])) {
          offenders.push(`${path.relative(ROOT, f)}:${j + 1}`);
        }
        if (seen && depth <= 0) break;
      }
    }
  }
  if (offenders.length) {
    fail.push(`ref.listen 写在 initState 里（真机红屏那类，release 看不见）：${offenders.join(', ')} —— 挪进 build()`);
  }
}

for (const s of ok) console.log('  ✓ ' + s);
for (const s of warn) console.log('  ! ' + s);
// —— 红线：智能体页不呈现计费（契约 v5.9，2026-11-28 产品拍板）——————————————
// 用户在 K90 上看到的第一屏原本是「每首 15⚡ × 3 首 = 合计 45⚡ · 余额 10005⚡」加
// 「要花钱的那步，后台真开始做才扣」——活还没干就先摆价目表，那是计费台不是产品。
//
// 判**代码**而不是全文：先把 // 行注释与 /* */ 块注释剥掉，否则「不报单价/合计/余额」
// 这种解释性注释会被自己判死（我自己就写过这种注释，第一版就这么误红过一次）。
//
// 范围刻意只限 **UI 层**（features/agent/ui/）：这条红线管的是"页面上摆不摆价目表"。
// 模型说话那侧由两处管着 —— ① agent_ui_test 的渲染文本断言（真渲染出来的字才算数）；
// ② skills/builtin_skills.dart 的 budget-explain 已退到「用户问了才报」，其触发条件里
// 不许再出现「要出草稿、要产出」。提示词里"给出不花钱的下一步"这类诚实护栏文案是内容，
// 不是页面，不该被这条机检误杀。
// 范围（2026-11-28 二次收紧）：**整个 features/agent/**，不再只限 ui/。
// 真机 K90 上实测到：UI 拆干净之后，模型照样在回复里说「这一步会用到你的额度」—— 那句话不是
// UI 写的，是**工具描述**喂的（proposal_tools 的 description 原本写着"会消耗用户额度"）与
// 内置技能 budget-explain 教的。所以这条红线必须连提示词、工具描述、技能正文一起管：
// 智能体这个产品里，一个字都不提钱。钱只在「我的」页与服务端。
const PRICE_WORDS = [
  '⚡', '积分', '余额', '额度', '单价', '合计', '刷新价格', '花钱', '扣费', '付费', '充钱', '充值',
  '花费', '价格', '计费', '收费',
  // 2026-11-28 补漏：只列「花钱/扣费」这类组合词，单字「钱」与「扣/费用/成本/免费」这一族就漏网 ——
  // agent_view_model 那句「钱要等它真开始做才扣」正是从这儿溜过去的（真机上线前自查抓到）。
  '钱', '扣', '费用', '成本', '免费', '涨价', '折扣',
];
const uiFiles = files;
if (uiFiles.length < 4) fail.push(`智能体目录只扫到 ${uiFiles.length} 个文件，红线形同虚设`);
for (const f of uiFiles) {
  const raw = fs.readFileSync(f, 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((ln) => !ln.trimStart().startsWith('//'))
    .join('\n');
  for (const w of PRICE_WORDS) {
    if (code.includes(w)) {
      fail.push(`${path.relative(ROOT, f)} 的代码里出现钱的字样「${w}」—— 智能体里一个字都不提钱（v5.9.8）`);
    }
  }
}
// 服务端也会**替智能体说话**：/v1/agent/llm 抛出的 ApiError.message 会被端侧原样贴进气泡，
// 红线只管 Dart 等于漏了半边 —— 真机查出来的那条就在 api/agent.js 的 SESSION_BROKEN 里：
// 「该额度按账号累计，新开会话不会把它清零」（2026-11-28 补漏，已拆成「这是护栏不是故障」）。
// 只扫**字符串字面量**，注释一律不参与：否则写注释解释红线反而被判红（这个坑踩过两次）。
{
  const f = path.join(ROOT, 'src', 'server', 'api', 'agent.js');
  if (fs.existsSync(f)) {
    const code = fs
      .readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((ln) => !ln.trimStart().startsWith('//'))
      .join('\n');
    for (const s of code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []) {
      for (const w of PRICE_WORDS) {
        if (s.includes(w)) {
          fail.push(`src/server/api/agent.js 发给用户的话里有钱的字样「${w}」：${s.slice(0, 46)} —— 智能体里一个字都不提钱（v5.9.8）`);
        }
      }
    }
  }
}
// 智能体的系统提示词必须还守着"服务端的数不许自己编"：删掉报价技能之后，这条是防模型
// 被问急了随口报个假数的唯一护栏（真机问过：它当时照着工具描述念了额度）。
{
  const CFG = path.join(AGENT_DIR, 'agent_config.dart');
  if (fs.existsSync(CFG)) {
    const src = fs.readFileSync(CFG, 'utf8');
    if (!/不许自己编、也不许猜/.test(src)) {
      fail.push('agent_config.dart 缺"服务端的数不许自己编"这条 —— 报价技能已删，没有它模型会自己编数（v5.9.8）');
    }
  }
}
// budget-explain 技能必须已经不存在（它存在的每一天，都在教模型主动念账本）。
{
  const SK = path.join(AGENT_DIR, 'skills', 'builtin_skills.dart');
  if (fs.existsSync(SK) && /budget-explain|_budgetExplainBody/.test(fs.readFileSync(SK, 'utf8'))) {
    fail.push('builtin_skills.dart 里又出现了 budget-explain —— 报价技能必须保持删除状态（v5.9.8）');
  }
}

if (fail.length) {
  console.error(`✗ 伴创 UI 迁移规范机检未通过（${fail.length} 项）：`);
  for (const s of fail) console.error('   ✗ ' + s);
  process.exit(1);
}
console.log(`  ✓ 伴创 UI 迁移规范机检通过（扫 ${files.length} 个 Dart 文件，§11.1/2/3/5/6 硬检查）`);
