/**
 * LLM provider CRUD — Fastify plugin。
 *
 * provider 設定改存在 SQLite（明碼 key 只存 DB，不再進 config.json）。
 * - GET  /api/llm-providers：回傳遮罩後的清單（key 清空、附 hasKey）。
 * - PUT  /api/llm-providers：整組覆蓋；沿用「空 key＝保留舊 key」的對帳語意。
 */

import type { FastifyInstance } from 'fastify';
import type { LlmProvider } from '@littlecycling/shared';
import type { RideDatabase } from '../lib/database.js';
import { redactProviders, reconcileProviderKeys } from '../lib/llm-providers.js';

export default async function llmProvidersApi(
  fastify: FastifyInstance,
  opts: { db: RideDatabase },
): Promise<void> {
  const { db } = opts;

  /** 讀出 provider 清單 — key 遮罩（write-only，永不讀回）。 */
  fastify.get('/api/llm-providers', async () => {
    return { providers: redactProviders(db.listLlmProviders()) };
  });

  /** 整組覆蓋 provider 清單。空 key＝保留舊 key（以 id 對回）。 */
  fastify.put('/api/llm-providers', async (req) => {
    const body = req.body as { providers?: LlmProvider[] };
    const incoming = Array.isArray(body?.providers) ? body.providers : [];
    const reconciled = reconcileProviderKeys(incoming, db.listLlmProviders());
    // 防禦性補 id：前端理應帶 id，缺了就補一個穩定 id（key 對帳靠 id）。
    for (const p of reconciled) {
      if (!p.id) p.id = globalThis.crypto.randomUUID();
    }
    db.replaceLlmProviders(reconciled);
    // 回遮罩後的清單，讓前端副本同樣不持有明碼 key。
    return { providers: redactProviders(db.listLlmProviders()) };
  });
}
