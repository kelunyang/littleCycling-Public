import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../agent-loop.js';
import type { ProviderAdapter } from '../provider-adapter.js';
import type { AgentEvent, AgentMessage, AgentTool, AgentTurn, ToolContext } from '../types.js';
import type { LlmProvider } from '@littlecycling/shared';

const provider: LlmProvider = {
  id: 'test', name: 'test', key: 'k', endpoint: 'http://x', model: 'm', enabled: true,
};

const dummyCtx = {} as ToolContext;

/** 腳本化 mock adapter：每次 send 依序吐出預設 AgentTurn，並記錄收到的 messages 快照。 */
function scriptedAdapter(turns: AgentTurn[]): ProviderAdapter & { seen: AgentMessage[][] } {
  const seen: AgentMessage[][] = [];
  let i = 0;
  return {
    seen,
    async send(_p, _s, messages) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      return turn;
    },
  };
}

function collect(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const echoTool: AgentTool = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
  execute: (args: { v: string }) => ({ echoed: args.v }),
};

const doneTool: AgentTool = {
  name: 'done',
  description: 'final',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => ({ ok: true, value: 42 }),
};

const boomTool: AgentTool = {
  name: 'boom',
  description: 'throws',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => { throw new Error('炸了'); },
};

test('多輪：tool_call → 終局 tool，messages 累積、result 捕捉、事件序列正確', async () => {
  const adapter = scriptedAdapter([
    { text: '先 echo', toolCalls: [{ id: 'c1', name: 'echo', input: { v: 'hi' } }], stopReason: 'tool_use' },
    { text: '', toolCalls: [{ id: 'c2', name: 'done', input: {} }], stopReason: 'tool_use' },
  ]);
  const { events, onEvent } = collect();

  const res = await runAgent({
    provider, system: 'sys', initialUser: 'go', tools: [echoTool, doneTool], ctx: dummyCtx,
    adapter, finalToolNames: ['done'], onEvent,
  });

  // result 為 done 的回傳
  assert.deepEqual(res.result, { ok: true, value: 42 });
  // messages: user, assistant(echo), tool(echo), assistant(done), tool(done)
  assert.equal(res.messages.length, 5);
  assert.equal(res.messages[0].role, 'user');
  assert.equal(res.messages[2].role, 'tool');
  assert.equal((res.messages[2] as any).content, JSON.stringify({ echoed: 'hi' }));
  assert.equal((res.messages[2] as any).isError, false);
  // 第二輪 send 應看見前面累積的 4 則 messages
  assert.equal(adapter.seen[1].length, 3);
  // 事件序列含 result
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('start'));
  assert.ok(phases.includes('tool_call'));
  assert.ok(phases.includes('tool_result'));
  assert.equal(phases[phases.length - 1], 'result');
});

test('tool 執行失敗回填 isError，LLM 可續行至終局', async () => {
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c1', name: 'boom', input: {} }], stopReason: 'tool_use' },
    { text: '沒關係，改用文字結束', toolCalls: [], stopReason: 'end' },
  ]);
  const { events, onEvent } = collect();

  const res = await runAgent({
    provider, system: 'sys', initialUser: 'go', tools: [boomTool], ctx: dummyCtx, adapter, onEvent,
  });

  const toolMsg = res.messages.find((m) => m.role === 'tool') as Extract<AgentMessage, { role: 'tool' }>;
  assert.equal(toolMsg.isError, true);
  assert.ok(toolMsg.content.includes('炸了'));
  const failEvent = events.find((e) => e.phase === 'tool_result') as Extract<AgentEvent, { phase: 'tool_result' }>;
  assert.equal(failEvent.ok, false);
  assert.equal(res.finalText, '沒關係，改用文字結束');
});

test('未知 tool 名回填 error，不 throw', async () => {
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c1', name: 'nope', input: {} }], stopReason: 'tool_use' },
    { text: '結束', toolCalls: [], stopReason: 'end' },
  ]);
  const { onEvent } = collect();
  const res = await runAgent({
    provider, system: 's', initialUser: 'go', tools: [echoTool], ctx: dummyCtx, adapter, onEvent,
  });
  const toolMsg = res.messages.find((m) => m.role === 'tool') as Extract<AgentMessage, { role: 'tool' }>;
  assert.equal(toolMsg.isError, true);
  assert.ok(toolMsg.content.includes('未知的工具'));
});

test('參數不符 schema 回填 error', async () => {
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }], stopReason: 'tool_use' }, // 缺 v
    { text: '結束', toolCalls: [], stopReason: 'end' },
  ]);
  const { onEvent } = collect();
  const res = await runAgent({
    provider, system: 's', initialUser: 'go', tools: [echoTool], ctx: dummyCtx, adapter, onEvent,
  });
  const toolMsg = res.messages.find((m) => m.role === 'tool') as Extract<AgentMessage, { role: 'tool' }>;
  assert.equal(toolMsg.isError, true);
  assert.ok(toolMsg.content.includes('schema'));
});

test('maxIterations：一直要求工具則補強制終局訊息並發 error', async () => {
  // adapter 永遠回傳 tool call
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c', name: 'echo', input: { v: 'x' } }], stopReason: 'tool_use' },
  ]);
  const { events, onEvent } = collect();
  await runAgent({
    provider, system: 's', initialUser: 'go', tools: [echoTool], ctx: dummyCtx,
    adapter, maxIterations: 2, onEvent,
  });
  // 應出現強制終局的 user 訊息（透過 adapter 收到的最後一批 messages）
  const lastSeen = adapter.seen[adapter.seen.length - 1];
  assert.ok(lastSeen.some((m) => m.role === 'user' && m.content.includes('查詢上限')));
  // 最終仍要工具 → error 事件
  assert.ok(events.some((e) => e.phase === 'error'));
});

test('finalTool 回 {ok:false} 不視為終局', async () => {
  const badFinal: AgentTool = {
    name: 'submit',
    description: 'x',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => ({ ok: false, errors: ['bad'] }),
  };
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c1', name: 'submit', input: {} }], stopReason: 'tool_use' },
    { text: '放棄', toolCalls: [], stopReason: 'end' },
  ]);
  const { onEvent } = collect();
  const res = await runAgent({
    provider, system: 's', initialUser: 'go', tools: [badFinal], ctx: dummyCtx,
    adapter, finalToolNames: ['submit'], onEvent,
  });
  // 不應提前終局；result 未設定，走到文字終局
  assert.equal(res.result, undefined);
  assert.equal(res.finalText, '放棄');
});
