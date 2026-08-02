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
            <span class="summary__value summary__value--gold">{{ coins }}</span>
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
            <span class="summary__value">{{ laps }}</span>
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
            <span v-if="ghostRide?.avgHr" class="summary__compare">
              vs {{ Math.round(ghostRide.avgHr) }}
              <span :class="diffClass(stats.avgHr, ghostRide.avgHr)">
                ({{ diffStr(stats.avgHr, ghostRide.avgHr) }})
              </span>
            </span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="gauge" /> AVG SPEED
            </span>
            <span class="summary__value">{{ stats.avgSpeed }} km/h</span>
            <span v-if="ghostRide?.avgSpeed" class="summary__compare">
              vs {{ ghostRide.avgSpeed.toFixed(1) }}
              <span :class="diffClass(stats.avgSpeed, ghostRide.avgSpeed)">
                ({{ diffStr(stats.avgSpeed, ghostRide.avgSpeed) }})
              </span>
            </span>
          </div>
          <div class="summary__stat">
            <span class="summary__label">
              <font-awesome-icon icon="bolt" /> AVG POWER
            </span>
            <span class="summary__value">{{ stats.avgPower }} W</span>
            <span v-if="ghostRide?.avgPowerW" class="summary__compare">
              vs {{ Math.round(ghostRide.avgPowerW) }}
              <span :class="diffClass(stats.avgPower, ghostRide.avgPowerW)">
                ({{ diffStr(stats.avgPower, ghostRide.avgPowerW) }})
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

        <!-- Post-ride suggestions (history-driven, confirm before apply) -->
        <div v-if="showFtpCard || showHrCard" class="summary__suggest">
          <div v-if="showFtpCard" class="summary__suggest-card">
            <font-awesome-icon icon="bolt" class="summary__suggest-icon" />
            <span class="summary__suggest-text">
              <template v-if="appliedFtp != null">
                FTP 已更新為 <b>{{ appliedFtp }}W</b>
              </template>
              <template v-else-if="isFtpTest">
                FTP 測試完成 — 建議 FTP <b>{{ ftpSuggestion }}W</b>
                <span class="summary__suggest-cur">（目前 {{ ftp }}W）</span>
              </template>
              <template v-else>
                刷出新高 20 分功率 — 建議 FTP 提高到 <b>{{ ftpSuggestion }}W</b>
                <span class="summary__suggest-cur">（目前 {{ ftp }}W）</span>
              </template>
            </span>
            <button v-if="appliedFtp == null" class="summary__suggest-btn" @click="applyFtp">
              更新
            </button>
            <font-awesome-icon v-else icon="check" class="summary__suggest-done" />
          </div>

          <div v-if="showHrCard" class="summary__suggest-card">
            <font-awesome-icon icon="heart" class="summary__suggest-icon" />
            <span class="summary__suggest-text">
              <template v-if="appliedHr != null">
                HR Max 已更新為 <b>{{ appliedHr }} bpm</b>
              </template>
              <template v-else>
                實測最高心率 <b>{{ hrMaxSuggestion }} bpm</b> 超過設定
                <span class="summary__suggest-cur">（目前 {{ currentHrMax }} bpm）</span>
              </template>
            </span>
            <button v-if="appliedHr == null" class="summary__suggest-btn" @click="applyHrMax">
              更新
            </button>
            <font-awesome-icon v-else icon="check" class="summary__suggest-done" />
          </div>
        </div>

        <!-- 騎後主觀感受(RPE + 選填備註)→ PATCH /api/rides/:id/feedback。
             只在有 ride id 時顯示,送出後收合成一行「已記錄」。跳過(直接 RETURN
             HOME)完全不受影響。 -->
        <div v-if="exportRideId != null" class="summary__feedback">
          <template v-if="!feedbackSaved">
            <div class="summary__feedback-label">
              <font-awesome-icon icon="face-smile" /> 你的感受
            </div>
            <div class="summary__rpe" role="radiogroup" aria-label="你的感受">
              <button
                v-for="opt in RPE_OPTIONS"
                :key="opt.value"
                type="button"
                role="radio"
                :aria-checked="rpe === opt.value"
                class="summary__rpe-face"
                :class="{ 'summary__rpe-face--active': rpe === opt.value }"
                @click="pickRpe(opt.value)"
              >
                <font-awesome-icon :icon="opt.icon" class="summary__rpe-icon" />
                <span class="summary__rpe-text">{{ opt.label }}</span>
              </button>
            </div>
            <el-input
              v-model="notes"
              type="textarea"
              :rows="2"
              :maxlength="2000"
              resize="none"
              placeholder="今天狀態如何?(選填)"
              class="summary__feedback-notes"
              @focus="cancelAutoReturn"
            />
            <div v-if="feedbackError" class="summary__feedback-error">
              <font-awesome-icon icon="triangle-exclamation" /> {{ feedbackError }}
            </div>
            <button
              class="summary__btn summary__btn--secondary summary__feedback-submit"
              :disabled="!canSubmitFeedback || submittingFeedback"
              @click="submitFeedback"
            >
              <font-awesome-icon :icon="submittingFeedback ? 'spinner' : 'check'" :spin="submittingFeedback" />
              送出
            </button>
          </template>
          <div v-else class="summary__feedback-done">
            <font-awesome-icon icon="circle-check" class="summary__feedback-done-icon" />
            感受已記錄
          </div>
        </div>

        <div class="summary__actions">
          <button
            class="summary__btn summary__btn--secondary"
            :disabled="exportRideId == null"
            @click="exportFit"
          >
            <font-awesome-icon icon="file-export" />
            EXPORT
          </button>
          <button class="summary__btn summary__btn--secondary" @click="handleContinue">
            <font-awesome-icon icon="circle-play" />
            CONTINUE
          </button>
          <button
            v-if="exportRideId != null"
            class="summary__btn summary__btn--secondary"
            @click="handleAiReview"
          >
            <font-awesome-icon icon="comment-dots" />
            讓 AI 評論
          </button>
          <button
            class="summary__btn"
            :class="{ 'summary__btn--counting': returnCountdown != null }"
            @click="handleReturn"
          >
            <!-- Auto-return fill: grows left→right over the 30s countdown,
                 same treatment as the HUD pause button's idle fill. -->
            <span
              v-if="returnCountdown != null"
              class="summary__btn-fill"
              :style="{ width: `${returnProgress}%` }"
            />
            <span class="summary__btn-label">
              <font-awesome-icon icon="bicycle" />
              RETURN HOME{{ returnCountdown != null ? ` ${returnCountdown}s` : '' }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import type { WorkoutSegment, Ride } from '@littlecycling/shared';
import { workoutGrade, WORKOUT_PROFILES_MAP } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import { useGameStateStore } from '@/stores/gameStateStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useGhostStore } from '@/stores/ghostStore';
import { useRouteStore } from '@/stores/routeStore';
import { useAnalysisStore } from '@/stores/analysisStore';
import { renderRadarChart, type RadarData } from '@/composables/useRideCharts';
import { notifyError } from '@/utils/notify';

const props = defineProps<{
  workoutSegments: WorkoutSegment[];
}>();

// CONTINUE hands back to GameView, which reboots the loop into a fresh ride
// (new recording). RETURN HOME stays local (reset + route push).
const emit = defineEmits<{ continue: [] }>();

const router = useRouter();
const gameStore = useGameStore();
const gameStateStore = useGameStateStore();
const settingsStore = useSettingsStore();
const ghostStore = useGhostStore();
const analysisStore = useAnalysisStore();

// ── Server-authoritative summary (P7) ──
// Every number displayed here comes from /api/live/stop (the same values
// persisted to the ride record). Until that response lands (it arrives just
// after the dialog opens), fall back to the live game_state mirrors — also
// server-produced, so the numbers can only get more precise, never change
// source.
const summary = computed(() => gameStore.rideSummary);

const coins = computed(() => summary.value?.totalCoins ?? gameStore.coins);
const laps = computed(() => summary.value?.totalLaps ?? gameStore.laps);
const elapsedMs = computed(() => summary.value?.durationMs ?? gameStateStore.elapsed);
const distanceKm = computed(() =>
  (((summary.value?.gameDistanceM ?? gameStateStore.cumulativeDistance) || 0) / 1000).toFixed(1),
);

/** Display-rounded stats, shaped like the old client GameStats. */
const stats = computed(() => ({
  avgHr: Math.round(summary.value?.avgHr ?? 0),
  avgSpeed: Math.round((summary.value?.avgSpeed ?? 0) * 10) / 10,
  avgPower: Math.round(summary.value?.avgPowerW ?? 0),
  avgCadence: Math.round(summary.value?.avgCadence ?? 0),
  zoneSustainPct: summary.value?.zoneSustainPct ?? 0,
}));

const routeStore = useRouteStore();
const ghostRide = computed(() => ghostStore.ghostRide);

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

// Redraw once the stop response lands (the dialog usually opens first).
watch(summary, async () => {
  if (gameStore.state !== 'ended') return;
  await nextTick();
  drawRadar();
});

function drawRadar() {
  if (!radarRef.value) return;

  const current = buildRadarData(
    stats.value.avgPower,
    stats.value.avgSpeed,
    stats.value.avgHr,
    stats.value.avgCadence,
    stats.value.zoneSustainPct,
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

const hasWorkout = computed(() => props.workoutSegments.length > 0);

const workoutName = computed(() => {
  const profile = WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId];
  return profile?.name ?? '';
});

const ftp = computed(() => settingsStore.config.training.ftp);
const currentHrMax = computed(() => settingsStore.config.training.hrMax);

// ── Post-ride suggestions (history → training params, confirm before apply) ──

// C: after an FTP-test workout, suggest a new FTP from the ride's best
//    continuous 20-min power (server: FTP ≈ best20min × 0.95).
const suggestedFtp = ref<number | null>(null);
const appliedFtp = ref<number | null>(null);
// D: if the measured max HR this ride exceeded the configured HRmax, suggest
//    bumping HRmax up to the real value.
const appliedHr = ref<number | null>(null);

const isFtpTest = computed(() => gameStore.selectedWorkoutId === 'ftp-test');

watch(
  () => summary.value?.rideId,
  async (rideId) => {
    // New ride → clear any prior suggestion state.
    suggestedFtp.value = null;
    appliedFtp.value = null;
    appliedHr.value = null;
    // Only structured rides (a workout profile or a training-plan day) feed
    // FTP estimation — a free ride carries no training intent, so its best
    // 20-min power isn't a reliable FTP signal.
    if (!rideId || !gameStore.isWorkoutMode) return;
    try {
      const res = await fetch(`/api/rides/${rideId}/ftp-estimate`);
      if (!res.ok) return;
      const data = await res.json();
      suggestedFtp.value = data.estimatedFtp ?? null;
    } catch {
      // no estimate — card stays hidden
    }
  },
  { immediate: true },
);

/**
 * FTP suggestion, gated by ride type:
 * - FTP-test: a real measurement, so suggest on any meaningful change (up OR down).
 * - Other workouts: suggest only when the estimate is meaningfully HIGHER — an
 *   upward PR is genuine progress, whereas a lower number from an interval
 *   session (with rest blocks) is just noise, never a reason to drop FTP.
 */
const ftpSuggestion = computed(() => {
  const s = suggestedFtp.value;
  if (s == null || s <= 0) return null;
  const delta = s - ftp.value;
  if (isFtpTest.value) return Math.abs(delta) >= 2 ? s : null;
  return delta >= 3 ? s : null;
});

const hrMaxSuggestion = computed(() => {
  const maxHr = summary.value?.maxHr;
  if (!maxHr || maxHr <= currentHrMax.value) return null;
  return Math.round(maxHr);
});

const showFtpCard = computed(() => appliedFtp.value != null || ftpSuggestion.value != null);
const showHrCard = computed(() => appliedHr.value != null || hrMaxSuggestion.value != null);

function applyFtp() {
  cancelAutoReturn(); // an interaction means the rider is still here
  const v = ftpSuggestion.value;
  if (v == null) return;
  settingsStore.updateTraining({ ftp: v });
  appliedFtp.value = v;
}

function applyHrMax() {
  cancelAutoReturn(); // an interaction means the rider is still here
  const v = hrMaxSuggestion.value;
  if (v == null) return;
  settingsStore.updateTraining({ hrMax: v });
  appliedHr.value = v;
}

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

// ── FIT export ──
// rideId survives finaliseRide() (reset happens only on RETURN HOME), so it's
// available whether it came back on the stop summary or is still the live id.
const exportRideId = computed(() => summary.value?.rideId ?? gameStore.currentRideId);

function exportFit() {
  cancelAutoReturn(); // an interaction means the rider is still here
  const id = exportRideId.value;
  if (id == null) return;
  // Plain anchor download — the endpoint sets Content-Disposition, so no
  // fetch-blob dance is needed.
  const a = document.createElement('a');
  a.href = `/api/rides/${id}/export.fit`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Auto-return countdown ──
// Once the summary is up, hold 10s, then count 30s down and leave — an idle
// trainer shouldn't sit on the summary forever. Any interaction cancels it.
const RETURN_HOLD_MS = 10_000;
const RETURN_COUNTDOWN_S = 30;
const returnCountdown = ref<number | null>(null);
// Elapsed share of the countdown — drives the fill width (0% at 30s left,
// 100% at 0). The 1s-linear width transition matches the 1s tick.
const returnProgress = computed(() => {
  if (returnCountdown.value == null) return 0;
  return ((RETURN_COUNTDOWN_S - returnCountdown.value) / RETURN_COUNTDOWN_S) * 100;
});
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function clearReturnTimers() {
  if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
  if (countdownTimer != null) { clearInterval(countdownTimer); countdownTimer = null; }
}

function cancelAutoReturn() {
  clearReturnTimers();
  returnCountdown.value = null; // hide the "(nn)" and stop the auto-exit
}

function startAutoReturn() {
  clearReturnTimers();
  returnCountdown.value = null;
  holdTimer = setTimeout(() => {
    returnCountdown.value = RETURN_COUNTDOWN_S;
    countdownTimer = setInterval(() => {
      const next = (returnCountdown.value ?? 0) - 1;
      if (next <= 0) {
        clearReturnTimers();
        returnCountdown.value = null;
        handleReturn();
      } else {
        returnCountdown.value = next;
      }
    }, 1000);
  }, RETURN_HOLD_MS);
}

watch(dialogVisible, (visible) => {
  if (visible) startAutoReturn();
  else clearReturnTimers();
});

onUnmounted(clearReturnTimers);

function handleContinue() {
  cancelAutoReturn();
  emit('continue');
}

function handleReturn() {
  clearReturnTimers();
  gameStore.reset();
  router.push('/');
}

// 「讓 AI 評論」:先抓住 ride id（reset 會清掉 currentRideId）,設進 analysisStore
// 供 Welcome 開啟 PresetDrawer 時預勾,再照 RETURN HOME 流程回首頁。
function handleAiReview() {
  clearReturnTimers();
  const rid = exportRideId.value;
  if (rid == null) return;
  analysisStore.autoAnalyzeRideId = rid;
  gameStore.reset();
  router.push('/');
}

// ── 騎後主觀感受(RPE 1-5 + 選填備註)──
// CLAUDE.md 禁 emoji,五段感受以 FA 臉譜呈現(很輕鬆 → 力竭)。選 5 顆自製
// radio 臉譜按鈕而非 el-rate:el-rate 只吃「低/中/高」3 段分組 icon,無法一段
// 一張臉;自製按鈕每段獨立臉譜 + 標籤,且選中態全走主題 token,可控性最佳。
const RPE_OPTIONS = [
  { value: 1, icon: 'face-grin-beam', label: '很輕鬆' },
  { value: 2, icon: 'face-smile', label: '輕鬆' },
  { value: 3, icon: 'face-meh', label: '普通' },
  { value: 4, icon: 'face-frown', label: '辛苦' },
  { value: 5, icon: 'face-dizzy', label: '力竭' },
] as const;

const rpe = ref<number | null>(null);
const notes = ref('');
const submittingFeedback = ref(false);
const feedbackSaved = ref(false);
const feedbackError = ref('');

// 有選 RPE 或填了備註才可送出。
const canSubmitFeedback = computed(() => rpe.value != null || notes.value.trim().length > 0);

// 換一場 ride → 清空回饋狀態,避免沿用上一場的輸入。
watch(exportRideId, () => {
  rpe.value = null;
  notes.value = '';
  submittingFeedback.value = false;
  feedbackSaved.value = false;
  feedbackError.value = '';
});

function pickRpe(value: number) {
  cancelAutoReturn(); // 有互動代表人還在,停掉自動返回倒數
  rpe.value = rpe.value === value ? null : value;
  feedbackError.value = '';
}

async function submitFeedback() {
  cancelAutoReturn();
  const rid = exportRideId.value;
  if (rid == null || !canSubmitFeedback.value) return;
  submittingFeedback.value = true;
  feedbackError.value = '';
  const body: { rpe?: number; notes?: string } = {};
  if (rpe.value != null) body.rpe = rpe.value;
  const trimmed = notes.value.trim();
  if (trimmed) body.notes = trimmed;
  try {
    const res = await fetch(`/api/rides/${rid}/feedback`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feedbackSaved.value = true;
  } catch {
    feedbackError.value = '送出失敗,請再試一次';
    notifyError('感受記錄送出失敗');
  } finally {
    submittingFeedback.value = false;
  }
}
</script>

<style>
/* Global (unscoped) overrides for el-dialog */
.summary-dialog {
  --el-dialog-bg-color: rgba(10, 14, 26, 0.95);
  --el-dialog-border-radius: 0;
  max-width: 960px;
  border: 1.5px solid var(--hud-border-bright);
  box-shadow: var(--hud-glow-cyan), inset 0 0 60px rgba(var(--accent-rgb), 0.03);
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
  text-shadow: 0 0 20px rgba(var(--accent-rgb), 0.5);
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
  box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.5);
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
  background: rgba(var(--accent-rgb), 0.04);
  border: 1.5px solid var(--hud-border);
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
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.3);
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
  border-bottom: 1.5px solid var(--hud-border);
}

.summary__workout-grade {
  margin-left: auto;
  font-size: 18px;
  font-weight: 800;
  color: var(--hud-text-bright);
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.5);
}

.summary__workout-segments {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--accent-rgb), 0.3) transparent;
}

.summary__workout-seg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
  background: rgba(var(--accent-rgb), 0.02);
  border: 1.5px solid var(--hud-border);
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

/* ── Post-ride suggestions ── */

.summary__suggest {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary__suggest-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(252, 238, 9, 0.06);
  border: 1.5px solid var(--accent-coin);
  clip-path: var(--clip-panel-sm);
}

.summary__suggest-icon {
  font-size: 16px;
  color: var(--accent-coin);
  flex-shrink: 0;
}

.summary__suggest-text {
  flex: 1;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--hud-text-bright);
  letter-spacing: 0.5px;
}

.summary__suggest-text b {
  color: var(--accent-coin);
  font-weight: 700;
}

.summary__suggest-cur {
  color: var(--hud-text);
  opacity: 0.6;
}

.summary__suggest-btn {
  flex-shrink: 0;
  padding: 6px 16px;
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  transition: background 0.2s;
}

.summary__suggest-btn:hover {
  background: rgba(var(--accent-rgb), 0.25);
}

.summary__suggest-done {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--zone-3);
}

/* ── 騎後主觀感受(RPE + 備註)── */

.summary__feedback {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(var(--accent-rgb), 0.04);
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
}

.summary__feedback-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.summary__rpe {
  display: flex;
  gap: 6px;
}

.summary__rpe-face {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  background: rgba(var(--accent-rgb), 0.02);
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  color: var(--hud-text);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s, color 0.2s;
}

.summary__rpe-face:hover {
  background: rgba(var(--accent-rgb), 0.1);
  color: var(--hud-text-bright);
}

.summary__rpe-face--active {
  background: rgba(var(--accent-rgb), 0.18);
  border-color: var(--hud-border-bright);
  color: var(--hud-cyan);
  box-shadow: var(--hud-glow-cyan);
}

.summary__rpe-icon {
  font-size: 22px;
}

.summary__rpe-text {
  font-family: var(--font-body);
  font-size: 10px;
  letter-spacing: 0.5px;
}

.summary__feedback-notes :deep(.el-textarea__inner) {
  background: rgba(var(--accent-rgb), 0.04);
  border-color: var(--hud-border);
  color: var(--hud-text-bright);
  border-radius: 0;
  font-family: var(--font-body);
}

.summary__feedback-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--hud-magenta);
  letter-spacing: 0.5px;
}

.summary__feedback-submit {
  align-self: flex-end;
  padding: 8px 20px;
  font-size: 12px;
}

.summary__feedback-done {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--zone-3);
  letter-spacing: 0.5px;
}

.summary__feedback-done-icon {
  font-size: 16px;
}

/* ── Buttons ── */

.summary__actions {
  display: flex;
  gap: 12px;
  align-self: flex-end;
}

.summary__btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  background: rgba(var(--accent-rgb), 0.1);
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.4);
}

.summary__btn:hover {
  background: rgba(var(--accent-rgb), 0.2);
  box-shadow: var(--hud-glow-cyan);
}

/* Secondary actions (export / continue): quieter fill, dimmer border so
   RETURN HOME still reads as the primary exit. */
.summary__btn--secondary {
  background: rgba(var(--accent-rgb), 0.04);
  border-color: var(--hud-border);
}

.summary__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

/* Content sits above the countdown fill. */
.summary__btn-label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Auto-return countdown fill — grows left→right toward the automatic exit,
   mirroring the HUD pause button's idle fill. */
.summary__btn-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 45, 107, 0.35);
  box-shadow: 0 0 8px rgba(255, 45, 107, 0.4);
  transition: width 1s linear;
  z-index: 0;
}

/* Counting: magenta skin, same as hud-pause--counting. */
.summary__btn--counting {
  background: rgba(255, 45, 107, 0.12);
  color: var(--hud-magenta);
  border-color: rgba(255, 45, 107, 0.45);
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.5);
}

.summary__btn--counting:hover {
  background: rgba(255, 45, 107, 0.2);
  box-shadow: var(--hud-glow-magenta);
}
</style>
