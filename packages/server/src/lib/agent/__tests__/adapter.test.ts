import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAnthropicMessages,
  toOpenAiMessages,
  parseAnthropicResponse,
  parseOpenAiResponse,
  anthropicAdapter,
} from '../provider-adapter.js';
import type { AgentMessage } from '../types.js';
import type { LlmProvider } from '@littlecycling/shared';

// 一段含 assistant tool_use + 兩個 tool 結果的對話
const convo: AgentMessage[] = [
  { role: 'user', content: '請規劃課表' },
  {
    role: 'assistant',
    content: '我先查資料',
    toolCalls: [
      { id: 't1', name: 'get_training_config', input: {} },
      { id: 't2', name: 'list_recent_rides', input: { limit: 5 } },
    ],
  },
  { role: 'tool', toolCallId: 't1', toolName: 'get_training_config', content: '{"hrMax":190}' },
  { role: 'tool', toolCallId: 't2', toolName: 'list_recent_rides', content: '[]', isError: false },
];

test('Anthropic：多個 tool 結果合併進同一則 user 訊息', () => {
  const msgs = toAnthropicMessages(convo) as any[];
  // user / assistant(含2 tool_use) / user(含2 tool_result)
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.ok(Array.isArray(msgs[1].content));
  assert.equal(msgs[1].content[0].type, 'text');
  assert.equal(msgs[1].content[1].type, 'tool_use');
  assert.equal(msgs[1].content[2].type, 'tool_use');
  // 兩個 tool_result 併進第三則 user
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].content.length, 2);
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].content[0].tool_use_id, 't1');
  assert.equal(msgs[2].content[1].tool_use_id, 't2');
});

test('OpenAI：每個 tool 結果各一則 role:tool 訊息，system 前置', () => {
  const msgs = toOpenAiMessages('你是教練', convo) as any[];
  // system / user / assistant(tool_calls) / tool / tool
  assert.equal(msgs.length, 5);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].tool_calls.length, 2);
  // arguments 為字串化 JSON
  assert.equal(typeof msgs[2].tool_calls[1].function.arguments, 'string');
  assert.deepEqual(JSON.parse(msgs[2].tool_calls[1].function.arguments), { limit: 5 });
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 't1');
  assert.equal(msgs[4].role, 'tool');
  assert.equal(msgs[4].tool_call_id, 't2');
});

test('parseAnthropicResponse：抽 text 與 tool_use', () => {
  const turn = parseAnthropicResponse({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_recent_rides', input: { limit: 10 } },
    ],
  });
  assert.equal(turn.text, '好的');
  assert.equal(turn.stopReason, 'tool_use');
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0], { id: 'toolu_1', name: 'list_recent_rides', input: { limit: 10 } });
});

test('parseAnthropicResponse：end_turn 為終局', () => {
  const turn = parseAnthropicResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] });
  assert.equal(turn.stopReason, 'end');
  assert.equal(turn.toolCalls.length, 0);
});

test('parseOpenAiResponse：arguments 字串化 JSON 被 parse', () => {
  const turn = parseOpenAiResponse({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: '查一下',
          tool_calls: [{ id: 'call_1', function: { name: 'estimate_ftp', arguments: '{"rideId":7}' } }],
        },
      },
    ],
  });
  assert.equal(turn.text, '查一下');
  assert.equal(turn.stopReason, 'tool_use');
  assert.deepEqual(turn.toolCalls[0].input, { rideId: 7 });
});

test('parseOpenAiResponse：壞掉的 arguments 退回空物件不丟例外', () => {
  const turn = parseOpenAiResponse({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ id: 'call_x', function: { name: 'foo', arguments: '{bad json' } }] },
      },
    ],
  });
  assert.deepEqual(turn.toolCalls[0].input, {});
});

test('parseOpenAiResponse：finish_reason stop 為終局', () => {
  const turn = parseOpenAiResponse({ choices: [{ finish_reason: 'stop', message: { content: '結果文字' } }] });
  assert.equal(turn.stopReason, 'end');
  assert.equal(turn.text, '結果文字');
  assert.equal(turn.toolCalls.length, 0);
});

// ── DeepSeek thinking：reasoning_content 回帶 ──

test('toOpenAiMessages：assistant 帶 reasoning 時輸出 reasoning_content', () => {
  const msgs = toOpenAiMessages('你是教練', [
    { role: 'user', content: '請規劃課表' },
    {
      role: 'assistant',
      content: '我先查資料',
      reasoning: '使用者要課表，先取設定',
      toolCalls: [{ id: 't1', name: 'get_training_config', input: {} }],
    },
    { role: 'tool', toolCallId: 't1', toolName: 'get_training_config', content: '{}' },
  ] as AgentMessage[]) as any[];
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.equal(asst.reasoning_content, '使用者要課表，先取設定');
  assert.ok(Array.isArray(asst.tool_calls));
});

test('toOpenAiMessages：assistant 無 reasoning 時不輸出 reasoning_content 欄位', () => {
  const msgs = toOpenAiMessages('你是教練', [
    {
      role: 'assistant',
      content: '查一下',
      toolCalls: [{ id: 't1', name: 'foo', input: {} }],
    },
  ] as AgentMessage[]) as any[];
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.ok(!('reasoning_content' in asst));
});

test('parseOpenAiResponse：非串流回應抓 reasoning_content 進 turn', () => {
  const turn = parseOpenAiResponse({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: '查一下',
          reasoning_content: '先想一下',
          tool_calls: [{ id: 'c1', function: { name: 'foo', arguments: '{}' } }],
        },
      },
    ],
  });
  assert.equal(turn.reasoning, '先想一下');
});

// ── Anthropic：不送 temperature ──

const anthProvider: LlmProvider = {
  name: 'claude',
  endpoint: 'https://api.anthropic.com/v1',
  key: 'sk-test',
  model: 'claude-opus-4-8',
} as LlmProvider;

test('Anthropic adapter：即使 opts 有 temperature，request body 也不含 sampling 參數', async () => {
  const origFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '好' }] }),
    };
  }) as any;
  try {
    const turn = await anthropicAdapter.send(anthProvider, '系統', [{ role: 'user', content: 'hi' }], [], {
      temperature: 0.9,
    });
    assert.equal(turn.text, '好');
    assert.ok(!('temperature' in sentBody), 'body 不應含 temperature');
    assert.ok(!('top_p' in sentBody));
    assert.ok(!('top_k' in sentBody));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('parseAnthropicResponse：stop_reason refusal 會 throw', () => {
  assert.throws(
    () => parseAnthropicResponse({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal' } }),
    /拒絕/,
  );
});
