/**
 * Agentic tool-use loop 的進度事件（前後端共用）。
 *
 * 後端把每一則 AgentEvent 序列化成一幀 SSE（`data: <json>\n\n`）推給前端，
 * 前端 useAgentStream 逐幀解析後驅動進度列 UI。型別搬到 shared 讓兩端
 * 共用同一份定義，避免各自維護漂移。
 */
export type AgentEvent =
  | { phase: 'start'; message: string }
  | { phase: 'thinking'; iteration: number }
  | { phase: 'tool_call'; iteration: number; toolName: string; args: unknown }
  | { phase: 'tool_result'; iteration: number; toolName: string; ok: boolean; summary: string }
  | { phase: 'reasoning'; delta: string }        // DeepSeek CoT（節流後）
  | { phase: 'final'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'result'; data: unknown };          // 最終結構化結果（如已存好的 plan）

/** AgentEvent 的 phase 字面量集合，前端做 switch/narrowing 時方便。 */
export type AgentEventPhase = AgentEvent['phase'];
