/**
 * Agentic tool-use loop — 統一中間表示（provider 無關）。
 *
 * adapter 負責把這裡的 AgentMessage / AgentTool 轉成各家 wire format
 * （Anthropic tool_use block、OpenAI-compatible tool_calls），主迴圈
 * 只認得這層抽象，換 provider 不必動 agent-loop。
 */

import type { AppConfig } from '@littlecycling/shared';
import type { RideDatabase } from '../database.js';
import type { RouteStore } from '../route-store.js';

// AgentEvent 已搬到 shared 供前後端共用；這裡 re-export 保持既有匯入路徑不變。
export type { AgentEvent, AgentEventPhase } from '@littlecycling/shared';

// ── JSON Schema（draft-07 子集，僅供 tool 參數描述與輕量驗證）──

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

// ── 對話訊息（統一表示）──

/** 一則對話訊息（統一表示，adapter 負責轉成各家 wire format） */
export type AgentMessage =
  | { role: 'user'; content: string }
  // reasoning：thinking 模式（如 DeepSeek V4）下這則 assistant 訊息的 CoT。
  // DeepSeek 官方要求後續請求必須完整回帶帶 tool call 之 assistant 訊息的
  // reasoning_content，否則多輪 tool calling 會出錯，故存進中間表示以便回帶。
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCall[]; reasoning?: string }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };

export interface AgentToolCall {
  id: string;            // Anthropic: tool_use.id；OpenAI: tool_calls[].id
  name: string;
  input: Record<string, unknown>;
}

/** provider 一輪回覆的統一結果 */
export interface AgentTurn {
  text: string;                 // 助手文字（可能為空）
  toolCalls: AgentToolCall[];   // 本輪要求呼叫的 tools（空＝終局）
  stopReason: 'tool_use' | 'end' | 'length';
  reasoning?: string;           // thinking 模式 CoT（DeepSeek 多輪回帶需要）
}

// ── Tool 定義 ──

/** Tool 定義。TArgs 為參數形狀，TResult 為 execute 回傳。 */
export interface AgentTool<TArgs = any, TResult = unknown> {
  name: string;
  description: string;          // 繁中，給 LLM 讀
  parameters: JsonSchema;       // JSON Schema（draft-07 子集）
  execute(args: TArgs, ctx: ToolContext): Promise<TResult> | TResult;
}

/** tool execute 可存取的後端資源。 */
export interface ToolContext {
  db: RideDatabase;
  config: AppConfig;
  /**
   * 使用者對騎乘列表的過濾條件（分析 picker 傳入）。tool 層強制套用，
   * 讓模型自行查詢時只看到符合過濾的紀錄，而非只靠 prompt 提醒。
   */
  rideFilter?: { excludeEmpty?: boolean };
  /**
   * 路線儲存（get_route_info 用）。server.ts 在 plan/analysis API 註冊處傳入；
   * 若未提供，get_route_info 會回傳明確錯誤而非崩潰。
   */
  routeStore?: RouteStore;
}

// ── 進度事件（推給前端）──
// AgentEvent 定義已搬到 shared（見檔首 re-export），前後端共用同一份。
