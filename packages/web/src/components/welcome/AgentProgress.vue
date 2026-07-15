<template>
  <div v-if="rows.length > 0" class="agent-progress">
    <div
      v-for="(row, i) in rows"
      :key="i"
      class="agent-progress__row"
      :class="`agent-progress__row--${row.status}`"
    >
      <font-awesome-icon
        :icon="iconFor(row.status)"
        :spin="row.status === 'running'"
        class="agent-progress__icon"
      />
      <span class="agent-progress__label">{{ row.label }}</span>
      <span v-if="row.detail" class="agent-progress__detail">{{ row.detail }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentEvent } from '@littlecycling/shared';

const props = defineProps<{ events: AgentEvent[] }>();

type RowStatus = 'running' | 'ok' | 'fail';
interface Row {
  status: RowStatus;
  label: string;
  detail?: string;
}

// 工具名 → 繁體中文顯示名。
const TOOL_LABELS: Record<string, string> = {
  list_recent_rides: '查詢最近騎乘',
  get_ride_detail: '查詢騎乘明細',
  get_ride_summary_stats: '分析騎乘時序',
  estimate_ftp: '估算 FTP',
  get_ride_counts: '統計訓練頻率',
  get_rides_by_date: '查詢當日騎乘',
  get_route_best: '查詢路線最佳成績',
  get_active_plans: '查詢啟用課表',
  get_plan_completions: '查詢課表完成度',
  get_training_config: '讀取訓練設定',
  submit_plan: '提交課表',
  get_plan_detail: '查詢課表內容',
  get_ride_zone_distribution: '分析心率區間分布',
  get_workout_profile_defs: '查詢訓練模板',
  get_ftp_trend: '分析 FTP 趨勢',
  get_ride_power_metrics: '計算功率指標',
  get_workout_compliance: '評估課表遵從度',
  get_weekly_load_summary: '彙總週訓練量',
  get_best_efforts: '查詢最佳功率輸出',
  get_hr_drift: '分析有氧脫鉤',
  get_route_info: '查詢路線資訊',
  compare_rides: '比較兩次騎乘',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function iconFor(status: RowStatus): string {
  if (status === 'ok') return 'check';
  if (status === 'fail') return 'triangle-exclamation';
  return 'magnifying-glass';
}

/**
 * 把事件流轉成進度列：每個 tool_call 產生一列（查詢中），對應的 tool_result
 * 到達時把該列標為完成/失敗並補上摘要；error 事件補一列失敗訊息。
 */
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  // 以 toolName 對映最後一個尚未完成的列，供 tool_result 回填。
  const pending: Record<string, number> = {};

  for (const e of props.events) {
    if (e.phase === 'tool_call') {
      out.push({ status: 'running', label: toolLabel(e.toolName) });
      pending[e.toolName] = out.length - 1;
    } else if (e.phase === 'tool_result') {
      const idx = pending[e.toolName];
      if (idx !== undefined && out[idx]) {
        out[idx].status = e.ok ? 'ok' : 'fail';
        out[idx].detail = e.ok ? '完成' : '失敗';
        delete pending[e.toolName];
      }
    } else if (e.phase === 'result') {
      // 終局 result(如課表已建立):給一列明確的完成終態,
      // 否則 user 只看到最後一個工具打勾,感受不到「已完成」。
      out.push({ status: 'ok', label: '已完成', detail: '結果已產生' });
    } else if (e.phase === 'error') {
      out.push({ status: 'fail', label: e.message });
    }
  }
  return out;
});
</script>

<style scoped>
.agent-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1.5px solid var(--hud-border);
  background: rgba(var(--accent-rgb), 0.03);
}

.agent-progress__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--hud-text);
  letter-spacing: 0.3px;
}

.agent-progress__icon {
  font-size: 10px;
  width: 12px;
  flex-shrink: 0;
}

.agent-progress__row--running .agent-progress__icon {
  color: var(--hud-cyan);
}

.agent-progress__row--ok .agent-progress__icon {
  color: var(--hud-cyan);
}

.agent-progress__row--fail {
  color: var(--hud-text-dim);
}

.agent-progress__row--fail .agent-progress__icon {
  color: var(--accent-danger);
}

.agent-progress__label {
  flex: 1;
}

.agent-progress__detail {
  font-size: 10px;
  color: var(--hud-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
