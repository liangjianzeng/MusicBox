// /v1/agent/llm 的**请求形状**用例（桩化 fetch，不联网、不起服务、不碰模型）。
//
// 为什么单独立一条：真机 K90（2026-11-28）上智能体回合报「我没连上后台」，追下去发现
// 客户端总是送 `tools`（无工具时是空数组），而我方原样把 `tools: []` + `tool_choice:"auto"`
// 发给 vLLM → vLLM 400 → 我方 `return null` → 回 503「当前模型不支持工具调用」。
// 也就是**纯聊天回合被整轮误杀**，而且报错把我们的请求形状问题说成了模型能力问题，
// 直接把人往错方向带（我本人在同一晚被它带偏两次）。
//
// 本用例只判一件事：没送工具时请求体里**不许**出现 tools/tool_choice；送了才带。
// 它是确定性的（桩响应），所以能进闸门；真模型的行为由人工复放验证，不进闸门以免抖动。
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  captured.push({ url, body: JSON.parse((init && init.body) || '{}') });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '好', reasoning: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
};

const P = require('../../src/server/prompts/intent');

test.after(() => { globalThis.fetch = realFetch; });

const MSGS = [{ role: 'user', content: '只回两个字：好' }];
const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather', description: '查城市天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

test('无工具回合：请求体里不许出现 tools / tool_choice（否则 vLLM 400 → 被误报成模型不支持工具）', async () => {
  captured.length = 0;
  const got = await P.chatToolCall(MSGS, [], { maxTokens: 200, timeoutMs: 5000 });
  assert.strictEqual(captured.length, 1, '必须且只发一次上游请求');
  const b = captured[0].body;
  assert.ok(!('tools' in b), `无工具时不得带 tools，实际带上来了：${JSON.stringify(b.tools)}`);
  assert.ok(!('tool_choice' in b), '无工具时不得带 tool_choice');
  assert.ok(!('parallel_tool_calls' in b), '无工具时不得带 parallel_tool_calls');
  assert.ok(Array.isArray(b.messages) && b.messages.length === 1, 'messages 必须原样带上');
  assert.strictEqual(got.content, '好', '纯聊天回合必须正常返回内容，而不是被当成工具失败');
  assert.deepStrictEqual(got.toolCalls, [], '无工具回合的 toolCalls 是空数组，不是 undefined');
});

test('有工具回合：必须带 tools + tool_choice:auto（否则智能体压根不会调工具）', async () => {
  captured.length = 0;
  await P.chatToolCall(MSGS, TOOLS, { maxTokens: 600, timeoutMs: 5000 });
  const b = captured[0].body;
  assert.ok(Array.isArray(b.tools) && b.tools.length === 1, '有工具时必须带上 tools');
  assert.strictEqual(b.tool_choice, 'auto', 'tool_choice 必须是 auto');
  assert.strictEqual(b.parallel_tool_calls, false, '并行工具关闭（一次一步，可归因）');
});
