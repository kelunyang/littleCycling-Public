<template>
  <div v-if="planStore.todaySessions.length > 0" class="plan-banner">
    <div
      v-for="entry in planStore.todaySessions"
      :key="entry.plan.id"
      class="plan-banner__item"
    >
      <div class="plan-banner__left">
        <font-awesome-icon
          :icon="entry.session.type === 'rest' ? 'mug-hot' : 'clipboard-list'"
          class="plan-banner__icon"
        />
        <div class="plan-banner__text">
          <span class="plan-banner__plan-name">{{ entry.plan.name }}</span>
          <span class="plan-banner__day">Day {{ entry.day }}</span>
        </div>
      </div>

      <div class="plan-banner__center">
        <template v-if="entry.session.type === 'rest'">
          <span class="plan-banner__rest">Rest Day</span>
        </template>
        <template v-else>
          <span class="plan-banner__duration">{{ entry.session.durationMin }} min</span>
          <span class="plan-banner__segments">
            {{ entry.session.segments.length }} segments
          </span>
        </template>
      </div>

      <div class="plan-banner__right">
        <font-awesome-icon
          v-if="planStore.isCompleted(entry.plan.id, entry.day)"
          icon="circle-check"
          class="plan-banner__done"
        />
        <el-button
          v-else
          size="small"
          @click="planStore.recordCompletion(entry.plan.id, entry.day, undefined, true)"
        >
          <font-awesome-icon icon="check" />
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePlanStore } from '@/stores/planStore';

const planStore = usePlanStore();
</script>

<style scoped>
.plan-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.plan-banner__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid var(--hud-border);
  background: rgba(0, 229, 255, 0.04);
  gap: 12px;
}

.plan-banner__left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plan-banner__icon {
  color: var(--hud-cyan);
  font-size: 16px;
}

.plan-banner__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plan-banner__plan-name {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.plan-banner__day {
  font-size: 10px;
  color: var(--hud-text-dim);
}

.plan-banner__center {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--hud-text);
}

.plan-banner__rest {
  color: var(--hud-text-dim);
  font-style: italic;
}

.plan-banner__duration {
  font-weight: 600;
}

.plan-banner__segments {
  color: var(--hud-text-dim);
}

.plan-banner__done {
  color: var(--hud-cyan);
  font-size: 18px;
  filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.5));
}
</style>
