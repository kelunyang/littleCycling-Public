/**
 * P5：訊息變體 parseVariants 回歸測試。
 *
 * LlmService 底層已收斂到統一 client（singleTurn），但 parseVariants 的語意
 * 完全不動：解析 LLM 回覆的 JSON string array、剝除 markdown code fence、
 * 過濾空字串、且必須保留所有 {placeholder} 佔位符。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_MESSAGE_TYPES } from '@littlecycling/shared';
import { parseVariants } from '../../llm-service.js';

// coin-collect 帶 {amount} 佔位符；lap-complete 無佔位符。
const withPlaceholder = GAME_MESSAGE_TYPES['coin-collect'];
const noPlaceholder = GAME_MESSAGE_TYPES['lap-complete'];

test('parseVariants：純 JSON array 直接解析', () => {
  const out = parseVariants('["金幣 +{amount}", "撿到 {amount} 金幣"]', withPlaceholder);
  assert.deepEqual(out, ['金幣 +{amount}', '撿到 {amount} 金幣']);
});

test('parseVariants：剝除 markdown code fence', () => {
  const raw = '```json\n["拿了 {amount} 幣", "金幣 x{amount}"]\n```';
  const out = parseVariants(raw, withPlaceholder);
  assert.deepEqual(out, ['拿了 {amount} 幣', '金幣 x{amount}']);
});

test('parseVariants：過濾缺少必要佔位符的變體', () => {
  // 第二個缺 {amount}，應被剔除
  const out = parseVariants('["金幣 +{amount}", "撿到金幣了"]', withPlaceholder);
  assert.deepEqual(out, ['金幣 +{amount}']);
});

test('parseVariants：過濾空字串與非字串', () => {
  const out = parseVariants('["完成一圈!", "", "   ", 123, "衝線啦!"]', noPlaceholder);
  assert.deepEqual(out, ['完成一圈!', '衝線啦!']);
});

test('parseVariants：夾雜前後文字時仍能抽出 JSON array', () => {
  const raw = '好的，這是變體：\n["完成一圈!", "繞完囉!"]\n希望有幫助';
  const out = parseVariants(raw, noPlaceholder);
  assert.deepEqual(out, ['完成一圈!', '繞完囉!']);
});

test('parseVariants：完全無法解析時回空陣列', () => {
  assert.deepEqual(parseVariants('抱歉我不會', noPlaceholder), []);
});
