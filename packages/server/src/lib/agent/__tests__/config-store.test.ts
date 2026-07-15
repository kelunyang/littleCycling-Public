import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMissingSettings,
  removeProvidedFromMissing,
  REQUIRED_PERSONAL_SETTINGS,
} from '../../config-store.js';

// computeMissingSettings 判定的是「原始 config.json」(deep-merge 預設值之前),
// 因為 save() 會把合併後的完整設定寫回檔案,hrMax/ftp/sensor 的預設值永遠會
// 落盤,只有沒有預設值的 training.age 與 setupCompleted 旗標可靠反映使用者意圖。

test('檔案不存在(null)→ 五個必填欄位全部缺', () => {
  const missing = computeMissingSettings(null);
  assert.deepEqual(missing.sort(), [...REQUIRED_PERSONAL_SETTINGS].sort());
});

test('有 hrMax/ftp/sensor 但缺 age → 只缺 training.age', () => {
  const raw = {
    training: { hrMax: 190, ftp: 200 },
    sensor: { wheelCircumference: 2.105, trainerModel: 'generic-fluid' },
  };
  assert.deepEqual(computeMissingSettings(raw), ['training.age']);
});

test('age 存在但 <= 0 視為未填', () => {
  const raw = {
    training: { hrMax: 190, ftp: 200, age: 0 },
    sensor: { wheelCircumference: 2.105, trainerModel: 'generic-fluid' },
  };
  assert.deepEqual(computeMissingSettings(raw), ['training.age']);
});

test('五個欄位都填齊(age > 0)→ 無缺漏', () => {
  const raw = {
    training: { hrMax: 190, ftp: 200, age: 30 },
    sensor: { wheelCircumference: 2.105, trainerModel: 'generic-fluid' },
  };
  assert.deepEqual(computeMissingSettings(raw), []);
});

test('setupCompleted === true → 一律回空陣列(永遠不再提示)', () => {
  const raw = { setupCompleted: true }; // 連 training/sensor 都沒有也不提示
  assert.deepEqual(computeMissingSettings(raw), []);
});

test('removeProvidedFromMissing:PATCH 帶到的欄位從缺漏清單移除', () => {
  const missing = ['training.age', 'sensor.trainerModel'];
  const patch = { training: { hrMax: 190, ftp: 200, age: 42 } };
  // age 有帶到且 > 0 → 移除;trainerModel 沒帶到 → 保留
  assert.deepEqual(removeProvidedFromMissing(missing, patch), ['sensor.trainerModel']);
});

test('removeProvidedFromMissing:age 帶了但 <= 0 仍算缺', () => {
  const missing = ['training.age'];
  const patch = { training: { age: 0 } };
  assert.deepEqual(removeProvidedFromMissing(missing, patch), ['training.age']);
});
