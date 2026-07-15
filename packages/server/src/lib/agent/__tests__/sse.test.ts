import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSseFrame, createReasoningThrottle } from '../sse.js';
import type { AgentEvent } from '../types.js';

test('formatSseFrame：序列化成單一 data 幀並以空行結尾', () => {
  const e: AgentEvent = { phase: 'tool_call', iteration: 1, toolName: 'list_recent_rides', args: { limit: 10 } };
  const frame = formatSseFrame(e);
  assert.equal(frame, `data: ${JSON.stringify(e)}\n\n`);
  assert.ok(frame.endsWith('\n\n'));
  // 幀主體可被還原成原事件。
  const body = frame.slice('data: '.length, -2);
  assert.deepEqual(JSON.parse(body), e);
});

test('formatSseFrame：result 事件 data 為巢狀物件仍完整序列化', () => {
  const e: AgentEvent = { phase: 'result', data: { name: '測試課表', totalDays: 28 } };
  const parsed = JSON.parse(formatSseFrame(e).slice('data: '.length, -2));
  assert.deepEqual(parsed, e);
});

test('reasoning 節流：累積達 maxChars 才 flush', () => {
  const out: string[] = [];
  let t = 0;
  const throttle = createReasoningThrottle((d) => out.push(d), { maxChars: 5, maxMs: 10_000, now: () => t });
  throttle.push('ab');   // 2 字，不 flush
  throttle.push('cd');   // 4 字，不 flush
  assert.deepEqual(out, []);
  throttle.push('ef');   // 6 字，達門檻 → flush
  assert.deepEqual(out, ['abcdef']);
});

test('reasoning 節流：距上次 flush 超過 maxMs 也會 flush', () => {
  const out: string[] = [];
  let t = 0;
  const throttle = createReasoningThrottle((d) => out.push(d), { maxChars: 999, maxMs: 200, now: () => t });
  throttle.push('x');   // 未達字數、未達時間
  assert.deepEqual(out, []);
  t = 250;              // 時間過門檻
  throttle.push('y');   // 觸發 flush（含先前緩衝）
  assert.deepEqual(out, ['xy']);
});

test('reasoning 節流：flush() 清空剩餘緩衝，空緩衝不誤發', () => {
  const out: string[] = [];
  const throttle = createReasoningThrottle((d) => out.push(d), { maxChars: 999, maxMs: 999_999 });
  throttle.push('剩餘內容');
  assert.deepEqual(out, []);
  throttle.flush();
  assert.deepEqual(out, ['剩餘內容']);
  throttle.flush(); // 再次 flush 不應重複發
  assert.deepEqual(out, ['剩餘內容']);
});
