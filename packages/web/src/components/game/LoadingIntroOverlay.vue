<template>
  <div class="loading-intro">
    <div class="loading-intro__card">
      <h2 class="loading-intro__title">
        <font-awesome-icon icon="bicycle" />
        操作說明
      </h2>

      <!-- The wait is the point of this screen, but it isn't what the rider is
           here for — so the controls get the room, and loading sits underneath. -->
      <ul class="loading-intro__controls">
        <li v-for="c in CONTROLS" :key="c.label">
          <span class="loading-intro__control-icon">
            <font-awesome-icon :icon="c.icon" />
          </span>
          <span class="loading-intro__control-label">{{ c.label }}</span>
          <span class="loading-intro__control-desc">{{ c.desc }}</span>
        </li>
      </ul>

      <div class="loading-intro__progress">
        <div class="loading-intro__bar" role="progressbar" :aria-valuenow="loading.percent">
          <div class="loading-intro__bar-fill" :style="{ width: `${loading.percent}%` }" />
        </div>
        <div class="loading-intro__percent">{{ loading.percent }}%</div>
      </div>

      <ul v-if="loading.visibleStages.length" class="loading-intro__stages">
        <li
          v-for="[id, stage] in loading.visibleStages"
          :key="id"
          class="loading-intro__stage"
          :class="`loading-intro__stage--${stage.status}`"
        >
          <font-awesome-icon
            :icon="stageIcon(stage.status)"
            :spin="stage.status === 'loading'"
          />
          <span>{{ stage.label }}</span>
          <span v-if="stage.total" class="loading-intro__stage-count">
            {{ stage.current }}/{{ stage.total }}
          </span>
        </li>
      </ul>

      <p v-if="loading.degradedReason" class="loading-intro__warn">
        <font-awesome-icon icon="triangle-exclamation" />
        {{ loading.degradedReason }}
      </p>

      <el-button
        type="primary"
        size="large"
        class="loading-intro__start"
        :disabled="!loading.unlocked"
        @click="emit('dismiss')"
      >
        <font-awesome-icon :icon="loading.unlocked ? 'play' : 'spinner'" :spin="!loading.unlocked" />
        <span class="loading-intro__start-label">
          {{ loading.unlocked ? '開始騎乘' : '地形載入中…' }}
        </span>
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useLoadingStore } from '@/stores/loadingStore';
import type { StageStatus } from '@/stores/loadingStore';

const loading = useLoadingStore();
const emit = defineEmits<{ dismiss: [] }>();

const CONTROLS = [
  { icon: 'bicycle', label: '踩踏', desc: '踩下踏板即開始，速度依功率與坡度計算' },
  { icon: 'play', label: 'Space', desc: '在起跑提示時開始；騎乘中按下則暫停 / 繼續' },
  { icon: 'rotate', label: '視角', desc: '畫面下方切換「跟車」與「自由」' },
  { icon: 'arrows-left-right', label: '自由視角', desc: '拖曳旋轉鏡頭，滾輪縮放' },
];

function stageIcon(status: StageStatus): string {
  switch (status) {
    case 'done':
      return 'circle-check';
    case 'failed':
      return 'circle-xmark';
    case 'loading':
      return 'spinner';
    default:
      return 'clock';
  }
}
</script>

<style scoped>
.loading-intro {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
}

.loading-intro__card {
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 28px;
  background: var(--surface);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius);
  clip-path: var(--clip-panel);
}

.loading-intro__title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--hud-cyan);
}

.loading-intro__controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.loading-intro__controls li {
  display: grid;
  grid-template-columns: 24px 84px 1fr;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--hud-text);
}

.loading-intro__control-icon {
  color: var(--hud-cyan);
  text-align: center;
}

.loading-intro__control-label {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--hud-text-bright);
}

.loading-intro__control-desc {
  opacity: 0.8;
}

.loading-intro__progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.loading-intro__bar {
  flex: 1;
  height: 10px;
  background: rgba(var(--accent-rgb), 0.12);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  overflow: hidden;
}

.loading-intro__bar-fill {
  height: 100%;
  background: var(--hud-cyan);
  transition: width 0.3s ease;
}

.loading-intro__percent {
  min-width: 44px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--hud-cyan);
}

.loading-intro__stages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.loading-intro__stage {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hud-text);
  opacity: 0.5;
}

.loading-intro__stage--loading,
.loading-intro__stage--done {
  opacity: 1;
}

.loading-intro__stage--done {
  color: var(--zone-3);
}

.loading-intro__stage--failed {
  opacity: 1;
  color: var(--accent-danger);
}

.loading-intro__stage-count {
  margin-left: auto;
  font-family: var(--font-display);
  opacity: 0.7;
}

.loading-intro__warn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--accent-danger);
}

.loading-intro__start {
  align-self: stretch;
}

.loading-intro__start-label {
  margin-left: 8px;
}
</style>
