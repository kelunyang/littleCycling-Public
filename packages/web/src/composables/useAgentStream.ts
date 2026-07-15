/**
 * useAgentStream — 消費後端 agent tool-use loop 的 SSE 串流。
 *
 * 後端 `/api/plans/generate`、`/api/analysis/generate` 皆為 POST + SSE：因為要
 * 帶 JSON body，無法用瀏覽器內建 EventSource（只支援 GET），故改用 fetch +
 * response.body.getReader() 逐幀解析 `data: <json>\n\n`。
 *
 * 維護四個反應式狀態：
 * - events：依序累積收到的所有 AgentEvent（驅動進度列 UI）。
 * - running：串流進行中。
 * - result：phase:'result' 的結構化資料（如已建立的課表）。
 * - error：任一 error 事件或網路錯誤的訊息。
 * 另附 finalText：phase:'final' 的最終文字（訓練分析用）。
 */

import { ref, type Ref } from 'vue';
import type { AgentEvent } from '@littlecycling/shared';

export interface AgentStream {
  events: Ref<AgentEvent[]>;
  running: Ref<boolean>;
  result: Ref<unknown>;
  error: Ref<string | null>;
  finalText: Ref<string>;
  /** 送出 POST 並串流解析事件；resolve 時串流已結束。 */
  start(url: string, body: unknown): Promise<void>;
  /** 清空狀態（開新一輪前呼叫）。 */
  reset(): void;
}

export function useAgentStream(): AgentStream {
  const events = ref<AgentEvent[]>([]);
  const running = ref(false);
  const result = ref<unknown>(null);
  const error = ref<string | null>(null);
  const finalText = ref('');

  function reset(): void {
    events.value = [];
    result.value = null;
    error.value = null;
    finalText.value = '';
  }

  function handleFrame(frame: string): void {
    // 一幀可能含多行；取 data: 開頭那行的 JSON。
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) return;
    const json = dataLine.slice(dataLine.indexOf(':') + 1).trim();
    if (!json) return;

    let event: AgentEvent;
    try {
      event = JSON.parse(json) as AgentEvent;
    } catch {
      // 壞幀不能靜默吞掉——大幀(如含整份課表的 result)若被截斷,
      // 這裡是唯一能看到證據的地方。
      console.warn('[agent-stream] 無法解析的 SSE 幀(前 200 字):', json.slice(0, 200));
      return;
    }
    console.debug(`[agent-stream] ← ${event.phase}`);

    events.value = [...events.value, event];
    if (event.phase === 'result') {
      result.value = event.data;
    } else if (event.phase === 'final') {
      finalText.value = event.message;
    } else if (event.phase === 'error') {
      error.value = event.message;
    }
  }

  async function start(url: string, body: unknown): Promise<void> {
    reset();
    running.value = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // 非串流錯誤回應（如 400 provider 未設定）：讀 JSON 取 error。
      if (!res.ok || !res.body) {
        let msg = `請求失敗（${res.status}）`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* ignore */ }
        error.value = msg;
        events.value = [...events.value, { phase: 'error', message: msg }];
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        // SSE 幀以空行（\n\n）分隔。
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.trim()) handleFrame(frame);
        }
      }
      // 收尾剩餘（理論上串流結束前每幀都以空行收束，此為保險）。
      if (buffer.trim()) handleFrame(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      events.value = [...events.value, { phase: 'error', message: msg }];
    } finally {
      running.value = false;
      // 串流結束摘要:對照後端 [xx-api][sse] log 可判斷 result 幀是否送達。
      console.debug('[agent-stream] 串流結束', {
        url,
        events: events.value.length,
        phases: events.value.map((e) => e.phase).join(','),
        hasResult: result.value != null,
        finalTextLen: finalText.value.length,
        error: error.value,
      });
    }
  }

  return { events, running, result, error, finalText, start, reset };
}
