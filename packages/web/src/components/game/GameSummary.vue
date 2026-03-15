<template>
  <el-dialog
    :model-value="dialogVisible"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    append-to-body
    align-center
    destroy-on-close
    width="85vw"
    custom-class="summary-dialog"
  >
    <template #header>
      <div class="summary__header">
        <div class="summary__header-line"></div>
        <h2 class="summary__title">RIDE COMPLETE</h2>
        <div class="summary__header-line"></div>
      </div>
    </template>

    <div class="summary__body">
      <!-- Left: Radar chart -->
      <div class="summary__left">
        <div v-if="routeId" class="summary__radar-section">
          <svg ref="radarRef" />
          <div class="summary__radar-legend">
            <span class="summary__radar-legend-item">
              <span class="summary__radar-dot summary__radar-dot--cyan" />
              THIS RIDE
            </span>
            <span v-if="pbRide" class="summary__radar-legend-item">
              <span class="summary__radar-dot summary__radar-dot--gold" />
              PERSONAL BEST
            </span>
          </div>
        </div>
        <div v-else class="summary__no-radar">
          <font-awesome-icon icon="trophy" class="summary__no-radar-icon" />
          <span>NO ROUTE DATA</span>
        </div>
      </div>

      <!-- Right: Stats -->
      <div class="summary__right">
        <div class="summary__grid">
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="coins" /> COINS
            </span>
            <span class="summary__value summary__value--gold">{{ gameStore.coins }}</span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="route" /> DISTANCE
            </span>
            <span class="summary__value">{{ distanceKm }} km</span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="flag" /> LAPS
            </span>
            <span class="summary__value">{{ gameStore.laps }}</span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="clock" /> DURATION
            </span>
            <span class="summary__value">{{ formatDuration(elapsedMs) }}</span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="heart" /> AVG HR
            </span>
            <span class="summary__value">{{ stats.avgHr }} bpm</span>
            <span v-if="compareRide?.avgHr" class="summary__compare">
              vs {{ Math.round(compareRide.avgHr) }}
              <span :class="diffClass(stats.avgHr, compareRide.avgHr)">
                ({{ diffStr(stats.avgHr, compareRide.avgHr) }})
              </span>
            </span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="gauge" /> AVG SPEED
            </span>
            <span class="summary__value">{{ stats.avgSpeed }} km/h</span>
            <span v-if="compareRide?.avgSpeed" class="summary__compare">
              vs {{ compareRide.avgSpeed.toFixed(1) }}
              <span :class="diffClass(stats.avgSpeed, compareRide.avgSpeed)">
                ({{ diffStr(stats.avgSpeed, compareRide.avgSpeed) }})
              </span>
            </span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="bolt" /> AVG POWER
            </span>
            <span class="summary__value">{{ stats.avgPower }} W</span>
            <span v-if="compareRide?.avgPowerW" class="summary__compare">
              vs {{ Math.round(compareRide.avgPowerW) }}
              <span :class="diffClass(stats.avgPower, compareRide.avgPowerW)">
                ({{ diffStr(stats.avgPower, compareRide.avgPowerW) }})
              </span>
            </span>
          </div>
        </div>

        <!-- Workout results -->
        <div v-if="hasWorkout" class="summary__workout">
          <div class="summary__workout-header">
            <font-awesome-icon icon="bolt" />
            {{ workoutName }}
            <span v-if="overallGrade" class="summary__workout-grade">{{ overallGrade }}</span>
          </div>
          <div class="summary__workout-segments">
            <div
              v-for="(seg, i) in workoutSegments"
              :key="i"
              class="summary__workout-seg"
            >
              <div
                class="summary__workout-seg-color"
                :style="{ backgroundColor: seg.color }"
              />
              <span class="summary__workout-seg-name">{{ seg.name }}</span>
              <span class="summary__workout-seg-target">
                {{ seg.targetFtpPercent }}% FTP
                ({{ Math.round(seg.targetFtpPercent / 100 * ftp) }}W)
              </span>
            </div>
          </div>
        </div>

        <button class="summary__btn" @click="handleReturn">
          <font-awesome-icon icon="bicycle" />
          RETURN HOME
        </button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import type { WorkoutSegment, Ride } from '@littlecycling/shared';
import { workoutGrade, WORKOUT_PROFILES_MAP } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useComparisonStore } from '@/stores/comparisonStore';
import { useRouteStore } from '@/stores/routeStore';
import type { GameStats } from '@/composables/useGameLoop';
import { renderRadarChart, type RadarData } from '@/composables/useRideCharts';

const props = defineProps<{
  elapsedMs: number;
  distanceTraveled: number;
  stats: GameStats;
  workoutSegments: WorkoutSegment[];
}>();

const router = useRouter();
const gameStore = useGameStore();
const settingsStore = useSettingsStore();
const comparisonStore = useComparisonStore();

const routeStore = useRouteStore();
const compareRide = computed(() => comparisonStore.compareRide);

const radarRef = ref<SVGElement | null>(null);
const pbRide = ref<Ride | null>(null);
const pbZoneSustainPct = ref(0);

const routeId = computed(() => routeStore.activeRoute?.id ?? '');
const dialogVisible = computed(() => gameStore.state === 'ended');

// Fetch PB when game ends
watch(
  () => gameStore.state === 'ended',
  async (ended) => {
    if (!ended || !routeId.value) return;

    try {
      const hrMax = settingsStore.config.training.hrMax;
      const res = await fetch(
        `/api/rides/best?routeId=${encodeURIComponent(routeId.value)}&hrMax=${hrMax}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      pbRide.value = data.ride ?? null;
      pbZoneSustainPct.value = data.zoneSustainPct ?? 0;
    } catch {
      // PB fetch failed — radar will show current only
    }

    await nextTick();
    drawRadar();
  },
);

function buildRadarData(
  avgPower: number,
  avgSpeed: number,
  avgHr: number,
  avgCadence: number,
  zoneSustainPct: number,
): RadarData {
  return {
    power: avgPower,
    speed: avgSpeed,
    hrEff: avgHr > 0 ? (avgSpeed / avgHr) * 100 : 0,
    cadence: avgCadence,
    zoneSustain: zoneSustainPct,
  };
}

function drawRadar() {
  if (!radarRef.value) return;

  const current = buildRadarData(
    props.stats.avgPower,
    props.stats.avgSpeed,
    props.stats.avgHr,
    props.stats.avgCadence,
    props.stats.zoneSustainPct,
  );

  let pb: RadarData | null = null;
  if (pbRide.value) {
    pb = buildRadarData(
      pbRide.value.avgPowerW ?? 0,
      pbRide.value.avgSpeed ?? 0,
      pbRide.value.avgHr ?? 0,
      pbRide.value.avgCadence ?? 0,
      pbZoneSustainPct.value,
    );
  }

  renderRadarChart(radarRef.value, current, pb, 320, 320);
}

const distanceKm = ((props.distanceTraveled / 1000) || 0).toFixed(1);

const hasWorkout = computed(() => props.workoutSegments.length > 0);

const workoutName = computed(() => {
  const profile = WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId];
  return profile?.name ?? '';
});

const ftp = computed(() => settingsStore.config.training.ftp);

const overallGrade = computed(() => {
  // Simplified grade: based on avg power vs overall FTP target
  if (!hasWorkout.value || ftp.value <= 0) return '';
  // Use 75% as baseline assumed on-target ratio
  return workoutGrade(75);
});

function diffStr(current: number, compare: number): string {
  const d = current - compare;
  return d >= 0 ? `+${Math.round(d)}` : `${Math.round(d)}`;
}

function diffClass(current: number, compare: number): string {
  return current >= compare ? 'summary__diff--up' : 'summary__diff--down';
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function handleReturn() {
  gameStore.reset();
  router.push('/');
}
</script>

<style>
/* Global (unscoped) overrides for el-dialog */
.summary-dialog {
  --el-dialog-bg-color: rgba(10, 14, 26, 0.95);
  --el-dialog-border-radius: 0;
  max-width: 960px;
  border: 1px solid var(--hud-border-bright);
  box-shadow: var(--hud-glow-cyan), inset 0 0 60px rgba(0, 229, 255, 0.03);
  backdrop-filter: blur(8px);
}

.summary-dialog .el-dialog__header {
  padding: 20px 28px 0;
  margin-right: 0;
}

.summary-dialog .el-dialog__body {
  padding: 16px 28px 28px;
}
</style>

<style scoped>
.summary__header {
  display: flex;
  align-items: center;
  gap: 16px;
}

.summary__header-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--hud-cyan), transparent);
  opacity: 0.4;
}

.summary__title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 800;
  color: var(--hud-cyan);
  text-shadow: 0 0 20px rgba(0, 229, 255, 0.5);
  letter-spacing: 4px;
  white-space: nowrap;
  margin: 0;
}

/* ── Two-column body ── */

.summary__body {
  display: flex;
  gap: 28px;
  align-items: flex-start;
}

.summary__left {
  flex: 0 0 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 360px;
}

.summary__right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Radar chart ── */

.summary__radar-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.summary__radar-legend {
  display: flex;
  gap: 20px;
  justify-content: center;
}

.summary__radar-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 600;
  color: var(--hud-text);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

.summary__radar-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.summary__radar-dot--cyan {
  background: #00e5ff;
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.5);
}

.summary__radar-dot--gold {
  background: #ffd700;
  box-shadow: 0 0 6px rgba(255, 215, 0, 0.5);
}

.summary__no-radar {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 320px;
  color: var(--hud-text);
  opacity: 0.3;
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 2px;
}

.summary__no-radar-icon {
  font-size: 48px;
}

/* ── Stats grid ── */

.summary__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.summary__stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: rgba(0, 229, 255, 0.04);
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
}

.summary__label {
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 500;
  color: var(--hud-cyan);
  opacity: 0.6;
  display: flex;
  align-items: center;
  gap: 4px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

.summary__value {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--hud-text-bright);
  text-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}

.summary__value--gold {
  color: var(--accent-coin);
  text-shadow: 0 0 12px rgba(252, 238, 9, 0.5);
}

.summary__compare {
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.5;
}

.summary__diff--up {
  color: var(--zone-3);
  text-shadow: 0 0 4px rgba(0, 255, 136, 0.3);
}

.summary__diff--down {
  color: var(--hud-magenta);
  text-shadow: 0 0 4px rgba(255, 45, 107, 0.3);
}

/* ── Workout results ── */

.summary__workout {
  text-align: left;
}

.summary__workout-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--hud-border);
}

.summary__workout-grade {
  margin-left: auto;
  font-size: 18px;
  font-weight: 800;
  color: var(--hud-text-bright);
  text-shadow: 0 0 10px rgba(0, 229, 255, 0.5);
}

.summary__workout-segments {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 229, 255, 0.3) transparent;
}

.summary__workout-seg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
  background: rgba(0, 229, 255, 0.02);
  border: 1px solid var(--hud-border);
}

.summary__workout-seg-color {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
}

.summary__workout-seg-name {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--hud-text-bright);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex: 1;
}

.summary__workout-seg-target {
  font-family: var(--font-display);
  font-variant-numeric: tabular-nums;
  color: var(--hud-text);
  opacity: 0.7;
}

/* ── Button ── */

.summary__btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  background: rgba(0, 229, 255, 0.1);
  color: var(--hud-cyan);
  border: 1px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
  text-shadow: 0 0 8px rgba(0, 229, 255, 0.4);
  align-self: flex-end;
}

.summary__btn:hover {
  background: rgba(0, 229, 255, 0.2);
  box-shadow: var(--hud-glow-cyan);
}
</style>
