<template>
  <div class="gauge" :class="{ 'gauge--on': isOnTarget }" :style="gaugeStyle">
    <!-- Scale track -->
    <div class="gauge__row">
      <span class="gauge__end-label">
        <font-awesome-icon icon="caret-down" rotation="90" />
        放鬆
      </span>
      <div class="gauge__track">
        <!-- Tolerance band (on-target zone), centered on the target -->
        <div class="gauge__band" :style="bandStyle" />
        <!-- Target tick (center) -->
        <div class="gauge__tick" :style="tickStyle">
          <span class="gauge__tick-value">{{ Math.round(target) }}</span>
        </div>
        <!-- Needle: current value -->
        <div class="gauge__needle" :style="needleStyle">
          <span class="gauge__needle-value">{{ Math.round(current) }}</span>
          <font-awesome-icon icon="caret-up" class="gauge__needle-caret" />
        </div>
      </div>
      <span class="gauge__end-label">
        加速
        <font-awesome-icon icon="caret-down" rotation="270" />
      </span>
    </div>

    <!-- Live steering hint -->
    <div class="gauge__hint" :class="hintClass">
      <font-awesome-icon :icon="hintIcon" />
      {{ hintText }}
      <span class="gauge__unit">{{ unit }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** Target value the rider should hold (watts or rpm). */
  target: number;
  /** Live effective value (gameStateStore.powerW or live cadence). */
  current: number;
  /** On-target tolerance as a fraction of target (server: power 0.10, cadence 0.15). */
  tolerance?: number;
  /** Unit suffix shown in the hint line. */
  unit?: string;
  /** Accent color (theme/event color). */
  color?: string;
}>(), {
  tolerance: 0.10,
  unit: 'W',
  color: 'var(--hud-cyan)',
});

/** Scale spans target ±40% — wide enough to show drift, tight enough to read. */
const SCALE_SPAN = 0.4;

const scaleMin = computed(() => props.target * (1 - SCALE_SPAN));
const scaleMax = computed(() => props.target * (1 + SCALE_SPAN));

/** Map a value onto the track as a 0-100 percentage (clamped). */
function toPct(value: number): number {
  const span = scaleMax.value - scaleMin.value;
  if (span <= 0) return 50;
  return Math.min(100, Math.max(0, ((value - scaleMin.value) / span) * 100));
}

const isOnTarget = computed(() =>
  props.target > 0 && Math.abs(props.current - props.target) <= props.target * props.tolerance,
);

const gaugeStyle = computed(() => ({ '--gauge-color': props.color }));

const bandStyle = computed(() => {
  const left = toPct(props.target * (1 - props.tolerance));
  const right = toPct(props.target * (1 + props.tolerance));
  return { left: `${left}%`, width: `${right - left}%` };
});

const tickStyle = computed(() => ({ left: `${toPct(props.target)}%` }));

const needleStyle = computed(() => ({ left: `${toPct(props.current)}%` }));

const delta = computed(() => Math.round(props.target - props.current));

const hintClass = computed(() => {
  if (isOnTarget.value) return 'gauge__hint--on';
  return delta.value > 0 ? 'gauge__hint--low' : 'gauge__hint--high';
});

const hintIcon = computed(() => {
  if (isOnTarget.value) return 'check';
  return delta.value > 0 ? 'caret-up' : 'caret-down';
});

const hintText = computed(() => {
  if (isOnTarget.value) return '穩住節奏';
  return delta.value > 0 ? `再加 ${delta.value}` : `收一點 ${-delta.value}`;
});
</script>

<style scoped>
.gauge {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gauge__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gauge__end-label {
  font-family: var(--font-body);
  font-size: 9px;
  letter-spacing: 1px;
  color: var(--hud-text-bright);
  opacity: 0.45;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 3px;
}

.gauge__track {
  position: relative;
  flex: 1;
  height: 10px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  /* Headroom for the needle value above and target value below */
  margin: 16px 0 14px;
}

.gauge__band {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 230, 118, 0.25);
  border-left: 1px solid rgba(0, 230, 118, 0.5);
  border-right: 1px solid rgba(0, 230, 118, 0.5);
  border-radius: 2px;
  transition: opacity 0.2s;
}

.gauge--on .gauge__band {
  background: rgba(0, 230, 118, 0.45);
  box-shadow: 0 0 10px rgba(0, 230, 118, 0.5);
}

.gauge__tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: var(--gauge-color);
  box-shadow: 0 0 6px var(--gauge-color);
}

.gauge__tick-value {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 2px;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  color: var(--gauge-color);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 4px var(--gauge-color);
}

.gauge__needle {
  position: absolute;
  bottom: 100%;
  width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  transition: left 0.3s ease-out;
}

.gauge__needle-value {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--hud-magenta);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  transition: color 0.2s;
}

.gauge__needle-caret {
  font-size: 10px;
  color: var(--hud-magenta);
  margin-top: -1px;
  transition: color 0.2s;
}

.gauge--on .gauge__needle-value,
.gauge--on .gauge__needle-caret {
  color: #00e676;
  text-shadow: 0 0 6px rgba(0, 230, 118, 0.6);
}

.gauge__hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  font-variant-numeric: tabular-nums;
  transition: color 0.2s;
}

.gauge__hint--on {
  color: #00e676;
  text-shadow: 0 0 6px rgba(0, 230, 118, 0.4);
}

.gauge__hint--low {
  color: var(--hud-magenta);
}

.gauge__hint--high {
  color: #ffab00;
}

.gauge__unit {
  opacity: 0.6;
  font-size: 9px;
}
</style>
