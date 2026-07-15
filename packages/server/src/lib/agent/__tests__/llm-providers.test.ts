/**
 * llm-providers 純函數測試 —— key 對帳（reconcile）與遮罩（redact）。
 *
 * DB CRUD 走 better-sqlite3 native module，WSL 載不了，故此處只測純函數層
 * （對帳/遮罩），與 tools.test.ts 的假 DB 手法一致的取捨。
 *
 * 個資規範：所有 key 用明顯虛構的佔位字串（sk-test-000…）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProviderKeys, redactProviders } from '../../llm-providers.js';
import type { LlmProvider } from '@littlecycling/shared';

function provider(over: Partial<LlmProvider>): LlmProvider {
  return {
    id: 'id-a',
    name: '測試 Provider',
    key: '',
    endpoint: 'https://example.test/v1',
    model: 'test-model',
    enabled: true,
    ...over,
  };
}

// ── reconcileProviderKeys ──

test('空 key 以 id 對回舊 key（不變）', () => {
  const existing = [provider({ id: 'id-a', key: 'sk-test-000-old' })];
  const incoming = [provider({ id: 'id-a', key: '' })];
  const out = reconcileProviderKeys(incoming, existing);
  assert.equal(out[0].key, 'sk-test-000-old');
});

test('非空 key 覆蓋舊 key', () => {
  const existing = [provider({ id: 'id-a', key: 'sk-test-000-old' })];
  const incoming = [provider({ id: 'id-a', key: 'sk-test-000-new' })];
  const out = reconcileProviderKeys(incoming, existing);
  assert.equal(out[0].key, 'sk-test-000-new');
});

test('未知 id 的空 key 維持空（新 provider）', () => {
  const existing = [provider({ id: 'id-a', key: 'sk-test-000-old' })];
  const incoming = [provider({ id: 'id-new', key: '' })];
  const out = reconcileProviderKeys(incoming, existing);
  assert.equal(out[0].key, '');
});

test('剝掉暫時性 hasKey 欄位', () => {
  const incoming = [provider({ id: 'id-a', key: 'sk-test-000', hasKey: true })];
  const out = reconcileProviderKeys(incoming, []);
  assert.equal('hasKey' in out[0], false);
});

test('保留其餘欄位並維持順序', () => {
  const existing = [
    provider({ id: 'id-a', key: 'sk-test-000-a' }),
    provider({ id: 'id-b', key: 'sk-test-000-b' }),
  ];
  const incoming = [
    provider({ id: 'id-b', name: 'B', key: '' }),
    provider({ id: 'id-a', name: 'A', key: '' }),
  ];
  const out = reconcileProviderKeys(incoming, existing);
  assert.deepEqual(out.map((p) => p.id), ['id-b', 'id-a']);
  assert.equal(out[0].name, 'B');
  assert.equal(out[0].key, 'sk-test-000-b');
  assert.equal(out[1].key, 'sk-test-000-a');
});

// ── redactProviders ──

test('redact 清空 key 並依有無 key 設定 hasKey', () => {
  const out = redactProviders([
    provider({ id: 'id-a', key: 'sk-test-000' }),
    provider({ id: 'id-b', key: '' }),
  ]);
  assert.equal(out[0].key, '');
  assert.equal(out[0].hasKey, true);
  assert.equal(out[1].key, '');
  assert.equal(out[1].hasKey, false);
});
