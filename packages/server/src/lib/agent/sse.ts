/**
 * SSE 序列化與 reasoning 節流工具。
 *
 * agent 生成走 SSE：每一則 AgentEvent 序列化成一幀 `data: <json>\n\n`。
 * DeepSeek 的思考鏈（reasoning）會以大量細碎 delta 湧入，若每片都推一幀
 * 會打爆 SSE，因此用節流器累積後再 flush（每 200ms 或每 40 字）。
 *
 * 這裡的函數皆為純函數 / 無 I/O，方便在 WSL 無法起 server（better-sqlite3
 * 是 Windows 原生模組）時仍能單元測試序列化與節流行為。
 */

import type { AgentEvent } from '@littlecycling/shared';

/** 把一則 AgentEvent 序列化成一幀 SSE（含結尾空行）。 */
export function formatSseFrame(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface ReasoningThrottleOpts {
  /** 最長多久 flush 一次（毫秒），預設 200。 */
  maxMs?: number;
  /** 累積多少字就 flush，預設 40。 */
  maxChars?: number;
  /** 由誰提供「現在的毫秒時間」，測試可注入假時鐘。預設 Date.now。 */
  now?: () => number;
}

export interface ReasoningThrottle {
  /** 餵入一段 reasoning delta；達門檻時透過 emit 推出。 */
  push(delta: string): void;
  /** 強制把緩衝區剩餘內容推出（串流結束時呼叫）。 */
  flush(): void;
}

/**
 * 建立 reasoning 節流器。累積達 maxChars 或距上次 flush 超過 maxMs 時，
 * 把緩衝合併成一次 `emit(delta)`。emit 通常是「推一幀 reasoning SSE」。
 *
 * 注意：本節流器不使用計時器（timer），時間門檻只在下一次 push 時檢查，
 * 避免 route 結束後仍有懸掛的 setTimeout。串流結束務必呼叫 flush()。
 */
export function createReasoningThrottle(
  emit: (delta: string) => void,
  opts: ReasoningThrottleOpts = {},
): ReasoningThrottle {
  const maxMs = opts.maxMs ?? 200;
  const maxChars = opts.maxChars ?? 40;
  const now = opts.now ?? Date.now;

  let buffer = '';
  let lastFlushAt = now();

  function doFlush(): void {
    if (buffer.length === 0) return;
    const out = buffer;
    buffer = '';
    lastFlushAt = now();
    emit(out);
  }

  return {
    push(delta: string): void {
      if (!delta) return;
      buffer += delta;
      if (buffer.length >= maxChars || now() - lastFlushAt >= maxMs) {
        doFlush();
      }
    },
    flush(): void {
      doFlush();
    },
  };
}
