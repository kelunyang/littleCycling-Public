/**
 * analysisStore — 訓練分析（agent SSE）+ 歷史報告瀏覽。
 *
 * 呼叫 `/api/analysis/generate`（POST + SSE），以自行車教練角色查詢訓練紀錄與
 * FTP 趨勢,最終輸出繁體中文的 Markdown 分析。UI（PresetDrawer 訓練分析摺疊區）
 * 從 events 讀進度、從 analysisText 讀最終結果。
 *
 * 報告落庫後可透過 `/api/analysis/reports`（列表）、`:id`（單筆）、DELETE 瀏覽/刪除;
 * generate() 完成即刷新列表。
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AnalysisFocus, AnalysisReport, AnalysisReportSummary, Ride } from '@littlecycling/shared';
import { MAX_ANALYSIS_RIDES } from '@littlecycling/shared';
import { notifyError } from '@/utils/notify';
import { useAgentStream } from '@/composables/useAgentStream';

// 沿用舊 importer（PresetDrawer）的匯入路徑,型別轉由 shared 提供。
export type { AnalysisFocus };

/**
 * 「隱藏 0 km / 0 W」開關狀態存 localStorage,由 RidePickerDrawer(寫)與
 * analysisStore.generate(讀)共用同一把 key,確保 AI 分析套用的過濾條件與
 * picker 顯示的一致。預設 ON(true)。
 */
export const RIDE_PICKER_EXCLUDE_EMPTY_KEY = 'lc.ridePicker.excludeEmpty';

export function readExcludeEmpty(): boolean {
  const raw = localStorage.getItem(RIDE_PICKER_EXCLUDE_EMPTY_KEY);
  return raw == null ? true : raw === 'true';
}

export const useAnalysisStore = defineStore('analysis', () => {
  const stream = useAgentStream();
  const analysisText = ref('');
  const reports = ref<AnalysisReportSummary[]>([]);
  const viewingReport = ref<AnalysisReport | null>(null);

  // ── 使用者指定的分析對象(RidePickerDrawer 勾選,上限 MAX_ANALYSIS_RIDES) ──
  // 存整筆 Ride 物件(非純 id),chips 要顯示日期 / 距離等摘要。
  const selectedRides = ref<Ride[]>([]);
  // 遊戲結束「讓 AI 評論」帶回 Welcome 的預勾 ride id(消化後清 null)。
  const autoAnalyzeRideId = ref<number | null>(null);

  /** 切換勾選:已在清單則移除,否則加入(達上限時忽略)。 */
  function toggleRide(ride: Ride) {
    const idx = selectedRides.value.findIndex((r) => r.id === ride.id);
    if (idx >= 0) {
      selectedRides.value = selectedRides.value.filter((r) => r.id !== ride.id);
    } else if (selectedRides.value.length < MAX_ANALYSIS_RIDES) {
      selectedRides.value = [...selectedRides.value, ride];
    }
  }

  /** 加入一筆(去重、達上限則忽略);game-end 預勾流程用。 */
  function addRide(ride: Ride) {
    if (selectedRides.value.some((r) => r.id === ride.id)) return;
    if (selectedRides.value.length >= MAX_ANALYSIS_RIDES) return;
    selectedRides.value = [...selectedRides.value, ride];
  }

  function removeRide(id: number) {
    selectedRides.value = selectedRides.value.filter((r) => r.id !== id);
  }

  function clearRides() {
    selectedRides.value = [];
  }

  function isSelected(id: number): boolean {
    return selectedRides.value.some((r) => r.id === id);
  }

  async function generate(params: { llmIndex: number; focus: AnalysisFocus; question?: string }) {
    analysisText.value = '';
    viewingReport.value = null;
    const rideIds = selectedRides.value.map((r) => r.id);
    await stream.start('/api/analysis/generate', {
      llmIndex: params.llmIndex,
      focus: params.focus,
      question: params.focus === 'custom' ? params.question : undefined,
      // 空陣列不帶,讓後端維持「自動掃描近況」的預設行為。
      rideIds: rideIds.length > 0 ? rideIds : undefined,
      rideFilter: { excludeEmpty: readExcludeEmpty() },
    });

    if (stream.error.value) {
      notifyError(stream.error.value);
      return;
    }
    analysisText.value = stream.finalText.value || '（模型未產生分析內容）';
    // 報告已落庫,刷新歷史列表（fire-and-forget）。
    void fetchReports();
  }

  /** 拉取歷史報告摘要（不含 content）。 */
  async function fetchReports() {
    try {
      const res = await fetch('/api/analysis/reports');
      if (!res.ok) return;
      const data = await res.json();
      reports.value = (data.reports ?? []) as AnalysisReportSummary[];
    } catch { /* 靜默:列表拉不到不阻斷分析主流程 */ }
  }

  /** 打開單筆歷史報告（含 content）。 */
  async function openReport(id: number) {
    try {
      const res = await fetch(`/api/analysis/reports/${id}`);
      if (!res.ok) {
        notifyError('報告不存在或已被刪除');
        return;
      }
      viewingReport.value = (await res.json()) as AnalysisReport;
    } catch {
      notifyError('讀取報告失敗');
    }
  }

  function closeReport() {
    viewingReport.value = null;
  }

  /** 刪除歷史報告,成功後從列表移除;若正在檢視則關閉。 */
  async function deleteReport(id: number) {
    try {
      const res = await fetch(`/api/analysis/reports/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        notifyError('刪除失敗');
        return;
      }
      reports.value = reports.value.filter((r) => r.id !== id);
      if (viewingReport.value?.id === id) viewingReport.value = null;
    } catch {
      notifyError('刪除失敗');
    }
  }

  function reset() {
    analysisText.value = '';
    viewingReport.value = null;
    stream.reset();
  }

  return {
    // analyzing 對映串流 running;events 供進度列顯示。
    analyzing: stream.running,
    agentEvents: stream.events,
    analysisText,
    reports,
    viewingReport,
    selectedRides,
    autoAnalyzeRideId,
    toggleRide,
    addRide,
    removeRide,
    clearRides,
    isSelected,
    generate,
    fetchReports,
    openReport,
    closeReport,
    deleteReport,
    reset,
  };
});
