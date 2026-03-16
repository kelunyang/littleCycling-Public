<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="preset__header">
      <h3>
        <font-awesome-icon icon="clipboard-list" />
        Training Presets
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="preset__body">
      <!-- Generate new plan -->
      <fieldset class="preset__generate">
        <legend>
          <font-awesome-icon icon="wand-magic-sparkles" />
          Generate New Plan
        </legend>

        <template v-if="enabledLlms.length === 0">
          <p class="preset__no-llm">
            <font-awesome-icon icon="circle-info" />
            No LLM configured. Add one in Settings first.
          </p>
        </template>

        <template v-else>
          <label>
            LLM Provider
            <el-select v-model="llmIndex" size="small">
              <el-option
                v-for="{ provider, index } in enabledLlms"
                :key="index"
                :label="provider.name"
                :value="index"
              />
            </el-select>
          </label>

          <label>
            Goal
            <el-select v-model="goal" size="small">
              <el-option label="Weight Loss" value="減脂與體重控制" />
              <el-option label="Endurance" value="有氧耐力提升" />
              <el-option label="Power" value="功率與爆發力提升" />
              <el-option label="General Fitness" value="綜合體能維持" />
            </el-select>
          </label>

          <label>
            Notes
            <el-input
              v-model="userNotes"
              type="textarea"
              :rows="3"
              resize="vertical"
              placeholder="Any special instructions for the LLM (e.g. knee injury, avoid high cadence...)"
              class="preset__notes-input"
            />
          </label>

          <div class="preset__gen-row">
            <label>
              Weeks
              <el-input-number v-model="weeks" :min="1" :max="12" size="small" />
            </label>
            <label>
              Sessions/Week
              <el-input-number v-model="sessionsPerWeek" :min="1" :max="7" size="small" />
            </label>
            <label>
              Min/Session
              <el-input-number v-model="minutesPerSession" :min="15" :max="120" :step="5" size="small" />
            </label>
          </div>

          <!-- Collapsible prompt editor -->
          <el-collapse v-model="promptExpanded">
            <el-collapse-item name="prompt">
              <template #title>
                <font-awesome-icon icon="pen-to-square" />
                <span style="margin-left: 6px">Edit Prompt</span>
              </template>
              <el-input
                v-model="userPrompt"
                type="textarea"
                :rows="12"
                resize="vertical"
                class="preset__prompt-input"
              />
              <el-button size="small" @click="resetPrompt" style="margin-top: 8px">
                <font-awesome-icon icon="rotate-left" />
                Reset to Default
              </el-button>
            </el-collapse-item>
          </el-collapse>

          <div class="preset__gen-actions">
            <el-button
              type="primary"
              :loading="planStore.generating"
              @click="handleGenerate"
              class="preset__gen-btn"
            >
              <font-awesome-icon v-if="!planStore.generating" icon="wand-magic-sparkles" />
              {{ planStore.generating ? 'Generating...' : 'Generate' }}
            </el-button>
            <el-button @click="importDialogOpen = true" class="preset__import-btn">
              <font-awesome-icon icon="file-import" />
              Import JSON
            </el-button>
          </div>
        </template>
      </fieldset>

      <!-- Plan list -->
      <fieldset class="preset__list">
        <legend>
          <font-awesome-icon icon="list" />
          Your Presets ({{ planStore.plans.length }})
        </legend>

        <div v-if="planStore.plans.length === 0" class="preset__empty">
          No training plans yet. Generate one above or import a JSON file.
        </div>

        <div v-for="plan in planStore.plans" :key="plan.id" class="preset__card">
          <div class="preset__card-header" @click="toggleExpand(plan.id)">
            <div class="preset__card-info">
              <span class="preset__card-name">{{ plan.name }}</span>
              <span class="preset__card-meta">
                {{ plan.totalDays }} days
                <span class="preset__card-source">{{ plan.source }}</span>
              </span>
            </div>
            <div class="preset__card-actions">
              <template v-if="getActivePlan(plan.id)">
                <span class="preset__card-active">
                  <font-awesome-icon icon="circle-play" />
                  Day {{ getCurrentDay(plan.id) }}
                </span>
                <el-button size="small" @click.stop="planStore.deactivatePlan(plan.id)">
                  <font-awesome-icon icon="stop" />
                </el-button>
              </template>
              <el-button v-else size="small" @click.stop="openActivateDialog(plan.id)">
                <font-awesome-icon icon="play" />
              </el-button>
              <el-button size="small" @click.stop="exportPlan(plan.id)">
                <font-awesome-icon icon="file-export" />
              </el-button>
              <el-button size="small" type="danger" @click.stop="planStore.deletePlan(plan.id)">
                <font-awesome-icon icon="trash" />
              </el-button>
              <font-awesome-icon
                :icon="expandedPlanId === plan.id ? 'chevron-up' : 'chevron-down'"
                class="preset__card-chevron"
              />
            </div>
          </div>

          <!-- Day grid (expanded) — paginated by week -->
          <div v-if="expandedPlanId === plan.id && expandedPlanData" class="preset__day-grid-wrap">
            <p class="preset__card-desc">{{ expandedPlanData.description }}</p>

            <!-- Week navigation header -->
            <div class="preset__week-nav">
              <span class="preset__week-label">
                W{{ currentWeekData(plan.id)?.week }}: {{ currentWeekData(plan.id)?.focus }}
              </span>
              <span class="preset__week-counter">
                {{ getWeekPage(plan.id) + 1 }} / {{ expandedPlanData.weeks.length }}
              </span>
            </div>

            <!-- Week grid with arrows -->
            <div class="preset__week-row">
              <!-- Left arrow (prev week) -->
              <div
                class="preset__week-arrow"
                :class="{ 'preset__week-arrow--hidden': getWeekPage(plan.id) === 0 }"
                @click="prevWeek(plan.id)"
              >
                <font-awesome-icon icon="chevron-left" />
              </div>

              <!-- Sliding week content -->
              <div class="preset__week-slider">
                <transition :name="slideDirection">
                  <div :key="getWeekPage(plan.id)" class="preset__day-grid">
                    <el-popover
                      v-for="session in currentWeekData(plan.id)?.sessions ?? []"
                      :key="session.day"
                      placement="top"
                      :width="280"
                      trigger="click"
                    >
                      <template #reference>
                        <div
                          class="preset__day-cell"
                          :class="{
                            'preset__day-cell--rest': session.type === 'rest',
                            'preset__day-cell--training': session.type === 'training',
                            'preset__day-cell--interval': hasInterval(session),
                            'preset__day-cell--done': planStore.isCompleted(plan.id, session.day),
                            'preset__day-cell--today': isToday(plan.id, session.day),
                          }"
                        >
                          <span class="preset__day-num">{{ session.day }}</span>
                          <font-awesome-icon
                            v-if="planStore.isCompleted(plan.id, session.day)"
                            icon="check"
                            class="preset__day-check"
                          />
                        </div>
                      </template>
                      <!-- Popover content -->
                      <div class="preset__day-detail">
                        <div class="preset__day-detail-header">
                          Day {{ session.day }}
                          <el-tag size="small" :type="session.type === 'rest' ? 'info' : 'success'">
                            {{ session.type === 'rest' ? 'Rest' : `${session.durationMin} min` }}
                          </el-tag>
                        </div>
                        <div v-if="session.segments.length > 0" class="preset__segments">
                          <div
                            v-for="(seg, si) in session.segments"
                            :key="si"
                            class="preset__seg"
                            :style="{ borderLeftColor: SEGMENT_TYPE_COLORS[seg.type] }"
                          >
                            <span class="preset__seg-type">{{ seg.type }}</span>
                            <span>{{ seg.durationMin }}min</span>
                            <span>HR {{ seg.hrMin }}–{{ seg.hrMax }}</span>
                            <span v-if="seg.cadenceRpm">{{ seg.cadenceRpm }} rpm</span>
                          </div>
                        </div>
                        <!-- Manual complete button -->
                        <el-button
                          v-if="getActivePlan(plan.id) && !planStore.isCompleted(plan.id, session.day)"
                          size="small"
                          @click="planStore.recordCompletion(plan.id, session.day, undefined, true)"
                          style="margin-top: 8px"
                        >
                          <font-awesome-icon icon="check" />
                          Mark Complete
                        </el-button>
                      </div>
                    </el-popover>
                  </div>
                </transition>
              </div>

              <!-- Right arrow (next week) -->
              <div
                class="preset__week-arrow"
                :class="{ 'preset__week-arrow--hidden': getWeekPage(plan.id) >= (expandedPlanData?.weeks.length ?? 1) - 1 }"
                @click="nextWeek(plan.id)"
              >
                <font-awesome-icon icon="chevron-right" />
              </div>
            </div>
          </div>
        </div>
      </fieldset>
    </div>

    <!-- Activate dialog (date picker) -->
    <el-dialog v-model="activateDialogOpen" title="Activate Plan" width="320">
      <p>Choose the start date (Day 1):</p>
      <el-date-picker
        v-model="activateStartDate"
        type="date"
        format="YYYY-MM-DD"
        value-format="YYYY-MM-DD"
        style="width: 100%"
      />
      <template #footer>
        <el-button @click="activateDialogOpen = false">Cancel</el-button>
        <el-button type="primary" @click="confirmActivate">Activate</el-button>
      </template>
    </el-dialog>

    <!-- Import dialog -->
    <el-dialog v-model="importDialogOpen" title="Import Plan JSON" width="500">
      <el-input
        v-model="importJson"
        type="textarea"
        :rows="10"
        placeholder="Paste LLM-generated JSON here..."
        resize="vertical"
      />
      <template #footer>
        <el-button @click="importDialogOpen = false">Cancel</el-button>
        <el-button type="primary" @click="handleImport" :loading="importing">Import</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import dayjs from 'dayjs';
import {
  SEGMENT_TYPE_COLORS,
  getCurrentPlanDay,
  validatePlanInput,
  type TrainingPlan,
  type PlanSession,
} from '@littlecycling/shared';
import { usePlanStore } from '@/stores/planStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { notifyError, notifySuccess } from '@/utils/notify';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const planStore = usePlanStore();
const settingsStore = useSettingsStore();

const enabledLlms = computed(() =>
  settingsStore.config.llm
    .map((provider, index) => ({ provider, index }))
    .filter(({ provider }) => provider.enabled),
);

// ── Generate form state ──
const llmIndex = ref(0);
const goal = ref('減脂與體重控制');
const userNotes = ref('');
const weeks = ref(4);
const sessionsPerWeek = ref(3);
const minutesPerSession = ref(35);
const userPrompt = ref('');
const promptExpanded = ref<string[]>([]);

// ── Expand/collapse + week pagination ──
const expandedPlanId = ref<string | null>(null);
const expandedPlanData = ref<TrainingPlan | null>(null);
const weekPages = ref<Record<string, number>>({});
const slideDirection = ref<'slide-left' | 'slide-right'>('slide-left');

function getWeekPage(planId: string): number {
  return weekPages.value[planId] ?? 0;
}

function currentWeekData(planId: string) {
  if (!expandedPlanData.value) return null;
  const page = getWeekPage(planId);
  return expandedPlanData.value.weeks[page] ?? null;
}

function nextWeek(planId: string) {
  if (!expandedPlanData.value) return;
  const current = getWeekPage(planId);
  if (current < expandedPlanData.value.weeks.length - 1) {
    slideDirection.value = 'slide-left';
    weekPages.value = { ...weekPages.value, [planId]: current + 1 };
  }
}

function prevWeek(planId: string) {
  const current = getWeekPage(planId);
  if (current > 0) {
    slideDirection.value = 'slide-right';
    weekPages.value = { ...weekPages.value, [planId]: current - 1 };
  }
}

// ── Dialogs ──
const activateDialogOpen = ref(false);
const activatePlanId = ref('');
const activateStartDate = ref(dayjs().format('YYYY-MM-DD'));
const importDialogOpen = ref(false);
const importJson = ref('');
const importing = ref(false);

onMounted(async () => {
  await planStore.fetchPlans();
  await planStore.fetchActivePlans();
  await loadDefaultPrompt();
});

async function loadDefaultPrompt() {
  try {
    const res = await fetch(
      `/api/plans/default-prompt?weeks=${weeks.value}&sessionsPerWeek=${sessionsPerWeek.value}&minutesPerSession=${minutesPerSession.value}&goal=${encodeURIComponent(goal.value)}`,
    );
    if (res.ok) {
      const data = await res.json();
      userPrompt.value = data.prompt;
    }
  } catch { /* ignore */ }
}

function resetPrompt() {
  loadDefaultPrompt();
}

// Reload prompt when params change
watch([weeks, sessionsPerWeek, minutesPerSession, goal], () => {
  // Only reload if prompt hasn't been manually edited
  if (promptExpanded.value.length === 0) {
    loadDefaultPrompt();
  }
});

async function handleGenerate() {
  try {
    await planStore.generatePlan({
      llmIndex: llmIndex.value,
      weeks: weeks.value,
      sessionsPerWeek: sessionsPerWeek.value,
      minutesPerSession: minutesPerSession.value,
      goal: goal.value,
      notes: userNotes.value || undefined,
      userPrompt: userPrompt.value || undefined,
    });
  } catch { /* error already notified by store */ }
}

function toggleExpand(planId: string) {
  if (expandedPlanId.value === planId) {
    expandedPlanId.value = null;
    expandedPlanData.value = null;
    return;
  }
  expandedPlanId.value = planId;
  // Fetch full plan data
  fetch(`/api/plans/${planId}`)
    .then((res) => res.json())
    .then((data) => { expandedPlanData.value = data; })
    .catch(() => { notifyError('Failed to load plan details'); });
}

function hasInterval(session: PlanSession): boolean {
  return session.segments.some((s) => s.type === 'interval_work');
}

function getActivePlan(planId: string) {
  return planStore.activePlans.find((p) => p.plan.id === planId);
}

function getCurrentDay(planId: string): number {
  const active = getActivePlan(planId);
  if (!active) return 0;
  return getCurrentPlanDay(active.startDate);
}

function isToday(planId: string, day: number): boolean {
  const active = getActivePlan(planId);
  if (!active) return false;
  return getCurrentPlanDay(active.startDate) === day;
}

function openActivateDialog(planId: string) {
  activatePlanId.value = planId;
  activateStartDate.value = dayjs().format('YYYY-MM-DD');
  activateDialogOpen.value = true;
}

async function confirmActivate() {
  if (!activateStartDate.value) return;
  await planStore.activatePlan(activatePlanId.value, activateStartDate.value);
  activateDialogOpen.value = false;
}

async function exportPlan(planId: string) {
  try {
    const res = await fetch(`/api/plans/${planId}`);
    if (!res.ok) throw new Error('Failed to fetch plan');
    const plan = await res.json();
    // Export as TrainingPlanInput format (name, description, weeks only)
    const exported = { name: plan.name, description: plan.description, weeks: plan.weeks };
    const json = JSON.stringify(exported, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${planId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    notifyError(err.message || 'Export failed');
  }
}

async function handleImport() {
  if (!importJson.value.trim()) {
    notifyError('Please paste JSON content');
    return;
  }
  importing.value = true;
  try {
    const parsed = JSON.parse(importJson.value);
    const validation = validatePlanInput(parsed);
    if (!validation.valid) {
      notifyError(`Invalid JSON: ${validation.errors[0]}`);
      return;
    }
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importJson.value,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Import failed');
    }
    await planStore.fetchPlans();
    importDialogOpen.value = false;
    importJson.value = '';
    notifySuccess('Plan imported');
  } catch (err: any) {
    notifyError(err.message || 'Invalid JSON');
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
:deep(.el-drawer) {
  background: var(--surface) !important;
}

:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.preset__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hud-border-bright);
  position: relative;
}

.preset__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.preset__header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.preset__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.preset__body {
  padding: 16px 20px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

fieldset {
  border: 1px solid var(--hud-border);
  border-radius: 0;
  clip-path: var(--clip-panel-sm);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(0,229,255,0.02);
}

legend {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  padding: 0 4px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.preset__no-llm {
  color: var(--hud-text-dim);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.preset__gen-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}

.preset__gen-actions {
  display: flex;
  gap: 8px;
}

.preset__gen-btn {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.preset__import-btn {
  border-color: var(--hud-border);
  color: var(--hud-text);
}

.preset__notes-input :deep(.el-textarea__inner),
.preset__prompt-input :deep(.el-textarea__inner) {
  font-family: monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.3);
  color: var(--hud-text);
}

.preset__empty {
  color: var(--hud-text-dim);
  font-size: 12px;
  text-align: center;
  padding: 20px;
}

/* ── Plan card ── */
.preset__card {
  border: 1px solid var(--hud-border);
  background: rgba(0,229,255,0.02);
}

.preset__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
}

.preset__card-header:hover {
  background: rgba(0,229,255,0.05);
}

.preset__card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preset__card-name {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-text);
}

.preset__card-meta {
  font-size: 10px;
  color: var(--hud-text-dim);
}

.preset__card-source {
  background: rgba(0,229,255,0.1);
  color: var(--hud-cyan);
  padding: 0 4px;
  border-radius: 2px;
  margin-left: 6px;
  font-size: 9px;
  text-transform: uppercase;
}

.preset__card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.preset__card-active {
  color: var(--hud-cyan);
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}

.preset__card-chevron {
  color: var(--hud-text-dim);
  font-size: 10px;
  margin-left: 4px;
}

/* ── Day grid ── */
.preset__day-grid-wrap {
  padding: 8px 12px 12px;
  border-top: 1px solid var(--hud-border);
}

.preset__card-desc {
  font-size: 11px;
  color: var(--hud-text-dim);
  margin-bottom: 10px;
}

/* Week navigation header */
.preset__week-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.preset__week-label {
  font-size: 10px;
  color: var(--hud-cyan);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.preset__week-counter {
  font-size: 9px;
  color: var(--hud-text-dim);
  font-family: var(--font-display);
  letter-spacing: 1px;
}

/* Week row: [<] [grid] [>] */
.preset__week-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.preset__week-arrow {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--hud-cyan);
  border: 1px solid var(--hud-border);
  flex-shrink: 0;
  transition: all 0.15s;
  font-size: 11px;
}

.preset__week-arrow:hover {
  border-color: var(--hud-cyan);
  background: rgba(0, 229, 255, 0.1);
}

.preset__week-arrow--hidden {
  visibility: hidden;
  pointer-events: none;
}

/* Slider container */
.preset__week-slider {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-height: 40px;
}

.preset__day-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

/* Slide transitions */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
  position: absolute;
  width: 100%;
}

.slide-left-enter-from {
  transform: translateX(100%);
  opacity: 0;
}
.slide-left-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}
.slide-right-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}
.slide-right-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
.slide-left-enter-active,
.slide-right-enter-active {
  position: relative;
}

.preset__day-cell {
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--hud-border);
  cursor: pointer;
  position: relative;
  min-height: 36px;
  transition: border-color 0.15s;
}

.preset__day-cell:hover {
  border-color: var(--hud-cyan);
}

.preset__day-cell--rest {
  background: rgba(128,128,128,0.1);
}

.preset__day-cell--training {
  background: rgba(102,187,106,0.15);
  border-color: rgba(102,187,106,0.3);
}

.preset__day-cell--interval {
  background: rgba(255,109,0,0.15);
  border-color: rgba(255,109,0,0.3);
}

.preset__day-cell--done {
  background: rgba(0,229,255,0.1);
  border-color: var(--hud-cyan);
}

.preset__day-cell--today {
  box-shadow: 0 0 8px rgba(0,229,255,0.5);
  border-color: var(--hud-cyan);
}

.preset__day-num {
  font-size: 11px;
  font-weight: 600;
  color: var(--hud-text);
}

.preset__day-check {
  font-size: 8px;
  color: var(--hud-cyan);
  position: absolute;
  bottom: 2px;
  right: 2px;
}

/* ── Popover detail ── */
.preset__day-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  margin-bottom: 8px;
}

.preset__segments {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset__seg {
  display: flex;
  gap: 8px;
  font-size: 11px;
  padding: 4px 0 4px 8px;
  border-left: 3px solid;
}

.preset__seg-type {
  font-weight: 600;
  min-width: 80px;
}
</style>
