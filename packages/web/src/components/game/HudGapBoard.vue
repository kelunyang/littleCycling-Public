<template>
  <!-- 環法轉播式差距看板(P8 幽靈車):終點 ◀─ 領先者 ─ 時間差 ─ 落後者。
       只在幽靈模式且有幀時出現;資料全部來自 server 幀的鏡像,零前端計算。 -->
  <div v-if="gs.ghostActive && gs.ghostDistanceM !== null" class="gap-board">
    <div class="gap-board__finish">
      <font-awesome-icon icon="flag-checkered" />
      <span class="gap-board__finish-km">{{ remainingKmStr }}</span>
    </div>
    <div class="gap-board__track">
      <span class="gap-board__dots">····</span>
      <span class="gap-board__chip" :class="leaderIsPlayer ? 'gap-board__chip--you' : 'gap-board__chip--ghost'">
        <font-awesome-icon :icon="leaderIsPlayer ? 'bicycle' : 'ghost'" />
        {{ leaderIsPlayer ? '你' : '幽靈' }}
      </span>
      <span class="gap-board__gap" :class="leaderIsPlayer ? 'gap-board__gap--ahead' : 'gap-board__gap--behind'">
        {{ gapStr }}
        <small class="gap-board__meters">{{ metersStr }}</small>
      </span>
      <span class="gap-board__chip gap-board__chip--trailing" :class="leaderIsPlayer ? 'gap-board__chip--ghost' : 'gap-board__chip--you'">
        <font-awesome-icon :icon="leaderIsPlayer ? 'ghost' : 'bicycle'" />
        {{ leaderIsPlayer ? '幽靈' : '你' }}
      </span>
    </div>
    <div v-if="lapDiff !== 0 || gs.ghostFinished" class="gap-board__note">
      <template v-if="gs.ghostFinished">幽靈已完賽</template>
      <template v-else>{{ lapDiff > 0 ? `領先 ${lapDiff} 圈` : `落後 ${-lapDiff} 圈` }}</template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useGameStateStore } from '@/stores/gameStateStore';

const props = defineProps<{
  /** 路線總長(m)— 算「終點剩餘」用;<=0 時不顯示剩餘距離。 */
  totalRouteDistM: number;
}>();

const gs = useGameStateStore();

/** 領先者:gapMs 正 = 玩家更早到達目前距離 = 玩家領先。 */
const leaderIsPlayer = computed(() => (gs.ghostGapMs ?? 0) >= 0);

/** 玩家本圈到終點的剩餘距離。 */
const remainingKmStr = computed(() => {
  if (props.totalRouteDistM <= 0) return '';
  const rem = Math.max(0, props.totalRouteDistM - gs.distanceTraveled);
  return rem >= 1000 ? `${(rem / 1000).toFixed(1)} km` : `${Math.round(rem)} m`;
});

/** 時間差 mm:ss(帶正負語意由顏色與排序表達,數字恆正)。 */
const gapStr = computed(() => {
  const ms = Math.abs(gs.ghostGapMs ?? 0);
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${leaderIsPlayer.value ? '+' : '−'}${mm}:${String(ss).padStart(2, '0')}`;
});

/** 距離差(公尺,次要顯示)。 */
const metersStr = computed(() => {
  const d = Math.abs(gs.cumulativeDistance - (gs.ghostDistanceM ?? gs.cumulativeDistance));
  return d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
});

/** 圈差(玩家 − 幽靈)。 */
const lapDiff = computed(() => gs.laps - gs.ghostLaps);
</script>

<style scoped>
/* 依 CLAUDE.md:不寫死主題 hex — 用語意 token(--hud-… 與 --el-…),
   由 App.vue 依 world style 指到各主題色票。 */
.gap-board {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 10px;
  border: 1px solid rgba(var(--hud-border-rgb, 255, 255, 255), 0.18);
  border-radius: 6px;
  background: var(--hud-bg, rgba(5, 8, 16, 0.55));
  color: var(--hud-text, #fff);
  font-size: 12px;
  line-height: 1.35;
  pointer-events: none;
  user-select: none;
}

.gap-board__finish {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.75;
  font-size: 11px;
}

.gap-board__track {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gap-board__dots {
  opacity: 0.35;
  letter-spacing: 2px;
}

.gap-board__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(var(--hud-border-rgb, 255, 255, 255), 0.12);
  font-weight: 700;
}

.gap-board__chip--ghost {
  opacity: 0.7;
}

.gap-board__gap {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.gap-board__gap--ahead {
  color: var(--el-color-success, #67c23a);
}

.gap-board__gap--behind {
  color: var(--el-color-danger, #f56c6c);
}

.gap-board__meters {
  margin-left: 3px;
  font-weight: 400;
  opacity: 0.65;
}

.gap-board__note {
  font-size: 11px;
  opacity: 0.8;
}
</style>
