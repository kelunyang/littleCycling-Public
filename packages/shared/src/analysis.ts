/**
 * 訓練分析報告（LLM 產出，markdown 內容）。
 *
 * 報告由 POST /api/analysis/generate 的 agent loop 產生後存進 SQLite
 * `analysis_reports` 表；前端透過 GET /api/analysis/reports 瀏覽歷史。
 */

/** 分析焦點：訓練回顧 / FTP 趨勢 / 自訂問題。 */
export type AnalysisFocus = 'review' | 'ftp_trend' | 'custom';

/** 一份完整的分析報告（含 markdown 內容）。 */
export interface AnalysisReport {
  id: number;
  /** 產生時間，ms timestamp（專案慣例）。 */
  createdAt: number;
  focus: AnalysisFocus;
  /** 僅 focus === 'custom' 時存在：使用者的原始提問。 */
  question?: string;
  /** 繁體中文 markdown。 */
  content: string;
  /** 產生此報告的 LLM provider 名稱與模型（供歷史列表辨識）。 */
  providerName: string;
  providerModel: string;
  /** user 指定分析的騎乘 ID（無指定時 undefined）。 */
  rideIds?: number[];
}

/** 歷史列表用的摘要（不含 content，列表保持輕量）。 */
export type AnalysisReportSummary = Omit<AnalysisReport, 'content'>;
