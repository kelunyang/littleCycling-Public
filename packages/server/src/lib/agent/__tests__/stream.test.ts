/**
 * P6：DeepSeek 串流 + tool_calls 分片拼接的單元測試。
 *
 * 不需要真網路——把「解析一串 SSE 行」抽成 parseSseStream（純函數），
 * 這裡模擬 chunk 序列驗證：content / reasoning 累積、reasoning 有轉發、
 * tool_calls 依 index 分片拼接（首片帶 id/name、後續片只有 arguments 片段、
 * 多個 index 交錯）、finish_reason 正確、以及 streamStateToTurn 的收斂。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseStream, createStreamState, applySseData } from '../../llm-client.js';
import { streamStateToTurn } from '../provider-adapter.js';

/** 把一組 chunk 物件包成 SSE 文字（每個 `data: <json>\n\n`，尾附 [DONE]）。 */
function toSse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test('串流：累積 content 與 reasoning，reasoning 有逐片轉發', () => {
  const forwarded: string[] = [];
  const sse = toSse([
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning_content: '一下' } }] },
    { choices: [{ delta: { content: '答案' } }] },
    { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] },
  ]);
  const state = parseSseStream(sse, (d) => forwarded.push(d));
  assert.equal(state.content, '答案完成');
  assert.equal(state.reasoning, '先想一下');
  assert.deepEqual(forwarded, ['先想', '一下']);
  assert.equal(state.finishReason, 'stop');
  assert.equal(state.toolCalls.length, 0);
});

test('串流：單一 tool_call 分片拼接（首片帶 id/name，後續只有 arguments 片段）', () => {
  const sse = toSse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'estimate_ftp', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"rid' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'eId":7}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const state = parseSseStream(sse);
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].id, 'call_1');
  assert.equal(state.toolCalls[0].name, 'estimate_ftp');
  assert.equal(state.toolCalls[0].arguments, '{"rideId":7}');
  assert.equal(state.finishReason, 'tool_calls');

  const turn = streamStateToTurn(state);
  assert.equal(turn.stopReason, 'tool_use');
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0], { id: 'call_1', name: 'estimate_ftp', input: { rideId: 7 } });
});

test('串流：多個 index 交錯的 tool_calls 分片拼接', () => {
  const sse = toSse([
    // 兩個 tool call 在同一幀開頭（各自首片）
    {
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'list_recent_rides', arguments: '{"li' } },
            { index: 1, id: 'call_b', function: { name: 'get_training_config', arguments: '' } },
          ],
        },
      }],
    },
    // 後續片交錯：先補 index 1、再補 index 0
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mit":5}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const state = parseSseStream(sse);
  assert.equal(state.toolCalls.length, 2);
  assert.equal(state.toolCalls[0].arguments, '{"limit":5}');
  assert.equal(state.toolCalls[1].arguments, '{}');

  const turn = streamStateToTurn(state);
  assert.equal(turn.toolCalls.length, 2);
  assert.deepEqual(turn.toolCalls[0], { id: 'call_a', name: 'list_recent_rides', input: { limit: 5 } });
  assert.deepEqual(turn.toolCalls[1], { id: 'call_b', name: 'get_training_config', input: {} });
});

test('串流：壞掉 / keep-alive 幀被忽略，不影響拼接', () => {
  const state = createStreamState();
  applySseData(state, '{bad json');                    // 壞掉的 JSON
  applySseData(state, JSON.stringify({ foo: 'bar' }));  // 無 choices
  applySseData(state, JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
  assert.equal(state.content, 'ok');
  assert.equal(state.finishReason, 'stop');
});

test('streamStateToTurn：arguments JSON 壞掉時退回空物件（交由 schema 驗證回填 error）', () => {
  const state = createStreamState();
  applySseData(state, JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'foo', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }],
  }));
  const turn = streamStateToTurn(state);
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0].input, {});
});

test('streamStateToTurn：保留 reasoning（供 DeepSeek 多輪回帶 reasoning_content）', () => {
  const sse = toSse([
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning_content: '一下' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'foo', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const turn = streamStateToTurn(parseSseStream(sse));
  assert.equal(turn.reasoning, '先想一下');
  assert.equal(turn.toolCalls.length, 1);
});

test('streamStateToTurn：無 reasoning 時 turn.reasoning 為 undefined', () => {
  const state = createStreamState();
  applySseData(state, JSON.stringify({ choices: [{ delta: { content: '答' }, finish_reason: 'stop' }] }));
  const turn = streamStateToTurn(state);
  assert.equal(turn.reasoning, undefined);
});

test('streamStateToTurn：缺 id 或 name 的空洞被過濾', () => {
  const state = createStreamState();
  // 只有 arguments、沒 id/name 的分片不該成為 tool call
  applySseData(state, JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }));
  const turn = streamStateToTurn(state);
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.stopReason, 'end');
});
