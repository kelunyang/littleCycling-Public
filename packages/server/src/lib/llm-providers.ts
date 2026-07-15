/**
 * LLM provider helpers — key 對帳與遮罩（純函數，便於單元測試）。
 *
 * provider 現在存在 SQLite（table `llm_providers`），這些函數把 DB 的原始清單
 * 與外來的 PUT 內容做安全對帳：明碼 key 只存 DB、GET 一律遮罩。
 */

import type { LlmProvider } from '@littlecycling/shared';

/**
 * 讀出給前端時把 key 清空，改用 hasKey 標示是否已存 key，
 * 讓明碼 secret 永遠不離開後端。key 是 write-only：只能透過 PUT 設定。
 */
export function redactProviders(providers: LlmProvider[]): LlmProvider[] {
  return providers.map((p) => ({ ...p, key: '', hasKey: p.key.length > 0 }));
}

/**
 * 把外來的 provider 陣列（來自 PUT）與既有儲存的 key 對帳：
 * - 空 key＝「不變」→ 以 id 對回舊 key。
 * - 非空 key＝覆蓋成新值。
 * - 未知 id 且 key 為空＝維持空（新 provider）。
 * 同時剝掉暫時性的 hasKey 欄位，避免寫進 DB。
 */
export function reconcileProviderKeys(
  incoming: LlmProvider[],
  existing: LlmProvider[],
): LlmProvider[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  return incoming.map((p) => {
    const key = p.key ? p.key : (byId.get(p.id)?.key ?? '');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hasKey, ...rest } = p;
    return { ...rest, key };
  });
}
