<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="settings-panel__header">
      <h3>
        <font-awesome-icon icon="gear" />
        Settings
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="settings-panel__body">
        <!-- 首次使用提示:必填個人化設定尚未填齊(後端 missingSettings 判定) -->
        <el-alert
          v-if="missingSettingLabels.length"
          class="settings-panel__setup-alert"
          type="warning"
          :closable="false"
          show-icon
        >
          <template #title>
            首次使用請完成以下設定：{{ missingSettingLabels.join('、') }}
          </template>
        </el-alert>

        <!-- Sensor settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="bicycle" />
            Sensor
          </legend>

          <label>
            Wheel Circumference
            <el-select v-model="wheelCircModel" size="small">
              <el-option
                v-for="(circ, size) in WHEEL_CIRCUMFERENCES"
                :key="size"
                :label="`${size} (${circ}m)`"
                :value="circ"
              />
            </el-select>
          </label>

          <label>
            Trainer Model
            <el-select v-model="trainerModel" size="small">
              <el-option
                v-for="(curve, key) in POWER_CURVES"
                :key="key"
                :label="curve.name"
                :value="key"
              />
            </el-select>
          </label>
        </fieldset>

        <!-- Training settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="bolt" />
            Training
          </legend>

          <label>
            Age (years)
            <el-input-number v-model="ageModel" :min="10" :max="100" size="small" controls-position="right" placeholder="optional" />
          </label>

          <label>
            HR Max (bpm)
            <el-input-number v-model="hrMaxModel" :min="100" :max="250" size="small" controls-position="right" />
            <span v-if="config.training.age" class="field-hint">
              由年齡 {{ config.training.age }} 推算 (Tanaka：208 − 0.7×age)，可手動覆寫
            </span>
          </label>

          <label>
            FTP (watts)
            <el-input-number v-model="ftpModel" :min="50" :max="600" size="small" controls-position="right" />
          </label>

          <label>
            體重 (kg)
            <el-input-number
              v-model="weightKgModel"
              :min="30"
              :max="200"
              :step="0.5"
              :precision="1"
              size="small"
              controls-position="right"
              placeholder="optional"
            />
            <span class="field-hint">
              選填;填了 AI 分析才能算 W/kg 與更精準的負荷指標
            </span>
          </label>
        </fieldset>

        <!-- Map settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="map" />
            Map
          </legend>

          <label>
            Render Mode
            <el-select v-model="renderModeModel" size="small">
              <el-option label="Three.js (FPS)" value="threejs" />
              <el-option label="MapLibre (Classic)" value="maplibre" />
              <el-option label="Phaser.js (2D)" value="phaser" />
            </el-select>
          </label>

          <label v-if="renderModeModel === 'threejs'">
            畫質
            <el-select v-model="graphicsQualityModel" size="small">
              <el-option label="自動" value="auto" />
              <el-option label="低" value="low" />
              <el-option label="中" value="medium" />
              <el-option label="高" value="high" />
            </el-select>
            <span class="field-hint">
              自動：依即時 FPS 動態調整效果強度；其餘為固定畫質。僅影響 3D (Three.js) 模式。
            </span>
          </label>

          <label>
            Basemap Style
            <el-select v-model="basemapModel" size="small">
              <el-option
                v-for="s in currentStyles"
                :key="s.key"
                :label="s.label"
                :value="s.key"
              />
            </el-select>
          </label>

          <label>
            Camera Height ({{ config.map.cameraHeight }})
            <el-slider v-model="cameraHeightModel" :min="1" :max="30" :step="1" />
          </label>

          <label>
            Camera Pitch ({{ config.map.cameraPitch }}&deg;)
            <el-slider v-model="cameraPitchModel" :min="1" :max="60" :step="1" />
          </label>

          <label>
            Look Ahead ({{ config.map.cameraLookAhead }}m)
            <el-slider v-model="cameraLookAheadModel" :min="10" :max="200" :step="5" />
          </label>

          <label>
            View Range ({{ config.map.viewRange }}m)
            <el-slider v-model="viewRangeModel" :min="100" :max="1000" :step="50" />
          </label>
        </fieldset>

        <!-- Server settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="wifi" />
            Server
          </legend>

          <label>
            WebSocket Port
            <el-input-number v-model="wsPortModel" :min="1024" :max="65535" size="small" controls-position="right" />
          </label>
        </fieldset>

        <!-- Sound settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="volume-high" />
            Sound
          </legend>

          <label class="checkbox-label">
            Enable Sound Effects
            <el-switch v-model="soundEnabledModel" />
          </label>

          <label class="checkbox-label">
            Background Music
            <el-switch v-model="bgmEnabledModel" :disabled="!soundEnabledModel" />
          </label>
          <p class="field-hint bgm-hint">
            每條路線會依世界風格生成專屬主題曲,踩踏速度帶動曲速。
          </p>
        </fieldset>

        <!-- Game Messages -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="comment-dots" />
            Game Messages
          </legend>

          <el-button class="tpl-btn" @click="tplEditorOpen = true">
            <font-awesome-icon icon="comment-dots" />
            Message Template Editor
          </el-button>

          <el-button
            class="tpl-btn"
            :loading="generatingAll"
            @click="generateDialogOpen = true"
          >
            <font-awesome-icon icon="wand-magic-sparkles" />
            Generate All Variants (LLM)
          </el-button>
          <el-progress
            v-if="generatingAll"
            :percentage="generateProgress"
            :stroke-width="4"
            :show-text="true"
            :format="(pct: number) => `${Math.round(pct)}%`"
            style="margin-top: 8px;"
          />
          <div v-if="generateStatus" class="msg-generate__status">{{ generateStatus }}</div>

          <!-- Generate settings dialog -->
          <el-dialog
            v-model="generateDialogOpen"
            title="Generate Message Variants"
            width="480px"
            :append-to-body="true"
            class="generate-dialog"
          >
            <div class="generate-dialog__body">
              <label>
                Style / Tone Prompt
                <el-input
                  v-model="generateStylePrompt"
                  type="textarea"
                  :rows="3"
                  placeholder="e.g. 像日式 RPG 的吐槽旁白、用幽默諷刺的語氣、像專業教練一樣鼓勵..."
                />
              </label>
              <label>
                Variants per type
                <el-input-number
                  v-model="generateCount"
                  :min="1"
                  :max="20"
                  size="small"
                  controls-position="right"
                />
              </label>
            </div>
            <template #footer>
              <el-button @click="generateDialogOpen = false">Cancel</el-button>
              <el-button type="primary" @click="startGenerate">
                <font-awesome-icon icon="wand-magic-sparkles" />
                Generate
              </el-button>
            </template>
          </el-dialog>
        </fieldset>

        <!-- LLM providers -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="wand-magic-sparkles" />
            LLM Providers
          </legend>

          <div v-for="(provider, idx) in llmProviders" :key="provider.id" class="llm-entry">
            <div class="llm-entry__row">
              <label>
                Name
                <el-input v-model="provider.name" size="small" placeholder="e.g. DeepSeek" @change="saveLlm" />
              </label>
              <label class="checkbox-label">
                Enabled
                <el-switch v-model="provider.enabled" @change="saveLlm" />
              </label>
            </div>
            <label>
              API Key
              <el-input
                v-model="provider.key"
                size="small"
                type="password"
                show-password
                :placeholder="provider.hasKey ? 'Saved — leave blank to keep' : 'sk-...'"
                @change="saveLlm"
              />
            </label>
            <label>
              Endpoint
              <el-input v-model="provider.endpoint" size="small" placeholder="https://api.deepseek.com/v1" @change="saveLlm" />
            </label>
            <label>
              Model
              <el-input v-model="provider.model" size="small" placeholder="deepseek-chat" @change="saveLlm" />
            </label>
            <el-button size="small" type="danger" @click="removeLlm(idx)">
              <font-awesome-icon icon="trash" /> Remove
            </el-button>
          </div>

          <div class="llm-presets">
            <el-button v-for="preset in LLM_PRESETS" :key="preset.name" size="small" @click="addPreset(preset)">
              <font-awesome-icon icon="plus" /> {{ preset.name }}
            </el-button>
          </div>

          <el-button size="small" @click="addLlm" class="tpl-btn">
            <font-awesome-icon icon="plus" /> Add Custom Provider
          </el-button>
        </fieldset>

        <!-- Debug settings -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="bug" />
            Debug
          </legend>

          <label class="checkbox-label">
            Enable Debug Logging
            <el-switch v-model="debugModel" />
          </label>
        </fieldset>

        <!-- Data sources / attribution -->
        <fieldset>
          <legend>
            <font-awesome-icon icon="scale-balanced" />
            Data Sources
          </legend>

          <p class="attribution-intro">
            Map, terrain and weather data come from free, openly-licensed sources.
            Their licences require the credits below. EuroVelo route data is credited
            in the route catalog.
          </p>

          <ul class="attribution-list">
            <li v-for="src in attributions" :key="src.role" class="attribution-item">
              <span class="attribution-role">{{ src.role }}</span>
              <span class="attribution-text">{{ src.text }}</span>
              <span v-if="src.links.length" class="attribution-links">
                <template v-for="(link, i) in src.links" :key="link.url">
                  <a :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.name }}</a>
                  <span v-if="i < src.links.length - 1"> · </span>
                </template>
              </span>
            </li>
          </ul>
        </fieldset>
      </div>

    <MessageTemplateEditor :open="tplEditorOpen" @close="tplEditorOpen = false" />
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { WHEEL_CIRCUMFERENCES, POWER_CURVES, GAME_MESSAGE_TYPES, hrMaxFromAge, DATA_ATTRIBUTIONS, type AppConfig, type LlmProvider } from '@littlecycling/shared';
import { OPENFREEMAP_STYLES } from '@/game/map-styles';
import MessageTemplateEditor from './MessageTemplateEditor.vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const settingsStore = useSettingsStore();
const tplEditorOpen = ref(false);
const config = computed(() => settingsStore.config);

// 首次設定提示:必填欄位 path → 中文顯示名稱(純顯示用,判定邏輯在後端)。
const SETTING_LABELS: Record<string, string> = {
  'training.hrMax': '最大心率',
  'training.ftp': 'FTP 功率',
  'training.age': '年齡',
  'sensor.wheelCircumference': '輪徑',
  'sensor.trainerModel': '訓練台型號',
};

// 後端回報尚未填齊的必填欄位 → 對照成中文清單;存檔後 missingSettings 更新即消失。
const missingSettingLabels = computed(() =>
  (config.value.missingSettings ?? []).map((key) => SETTING_LABELS[key] ?? key),
);

const currentStyles = OPENFREEMAP_STYLES;

// Map/terrain/weather attribution — server-injected via /api/config, render-only.
// Falls back to the bundled constant if the server read hasn't populated it.
const attributions = computed(() => config.value.attributions ?? DATA_ATTRIBUTIONS);

const wheelCircModel = computed({
  get: () => config.value.sensor.wheelCircumference,
  set: (val: number) => settingsStore.updateSensor({ wheelCircumference: val }),
});

const trainerModel = computed({
  get: () => config.value.sensor.trainerModel,
  set: (val: string) => settingsStore.updateSensor({ trainerModel: val }),
});

// Setting age derives hrMax via the Tanaka formula, but hrMax stays
// independently editable (a rider who knows their measured max can override).
const ageModel = computed({
  get: () => config.value.training.age,
  set: (val: number | undefined) => {
    if (val == null) {
      settingsStore.updateTraining({ age: undefined });
      return;
    }
    settingsStore.updateTraining({ age: val, hrMax: hrMaxFromAge(val) });
  },
});

const hrMaxModel = computed({
  get: () => config.value.training.hrMax,
  set: (val: number) => settingsStore.updateTraining({ hrMax: val }),
});

const ftpModel = computed({
  get: () => config.value.training.ftp,
  set: (val: number) => settingsStore.updateTraining({ ftp: val }),
});

// 體重為選填(同 age 的處理):清空 → 存回 undefined,讓後端知道未設定。
const weightKgModel = computed({
  get: () => config.value.training.weightKg,
  set: (val: number | undefined) => {
    settingsStore.updateTraining({ weightKg: val == null ? undefined : val });
  },
});

const renderModeModel = computed({
  get: () => config.value.map.renderMode,
  set: (val: AppConfig['map']['renderMode']) => settingsStore.updateMap({ renderMode: val }),
});

const graphicsQualityModel = computed({
  get: () => config.value.map.graphicsQuality,
  set: (val: AppConfig['map']['graphicsQuality']) => settingsStore.updateMap({ graphicsQuality: val }),
});

const basemapModel = computed({
  get: () => config.value.map.basemapStyle,
  set: (val: string) => settingsStore.updateMap({ basemapStyle: val }),
});

const cameraHeightModel = computed({
  get: () => config.value.map.cameraHeight,
  set: (val: number) => settingsStore.updateMap({ cameraHeight: val }),
});

const cameraPitchModel = computed({
  get: () => config.value.map.cameraPitch,
  set: (val: number) => settingsStore.updateMap({ cameraPitch: val }),
});

const cameraLookAheadModel = computed({
  get: () => config.value.map.cameraLookAhead,
  set: (val: number) => settingsStore.updateMap({ cameraLookAhead: val }),
});

const viewRangeModel = computed({
  get: () => config.value.map.viewRange,
  set: (val: number) => settingsStore.updateMap({ viewRange: val }),
});

const wsPortModel = computed({
  get: () => config.value.server.wsPort,
  set: (val: number) => settingsStore.updateServer({ wsPort: val }),
});

const soundEnabledModel = computed({
  get: () => config.value.sound.enabled,
  set: (val: boolean) => settingsStore.updateSound({ enabled: val }),
});

const bgmEnabledModel = computed({
  get: () => config.value.sound.bgmEnabled,
  set: (val: boolean) => settingsStore.updateSound({ bgmEnabled: val }),
});

const debugModel = computed({
  get: () => config.value.debug,
  set: (val: boolean) => settingsStore.updateDebug(val),
});

// LLM providers 改存 SQLite,走 settingsStore.llmProviders(/api/llm-providers)。
const llmProviders = computed(() => settingsStore.llmProviders);

function addLlm() {
  llmProviders.value.push({ id: crypto.randomUUID(), name: '', key: '', endpoint: '', model: '', enabled: true });
  saveLlm();
}

function removeLlm(idx: number) {
  llmProviders.value.splice(idx, 1);
  saveLlm();
}

function saveLlm() {
  settingsStore.saveLlmProviders([...llmProviders.value]);
}

// ── LLM Presets ──

const LLM_PRESETS: Omit<LlmProvider, 'id' | 'key' | 'enabled' | 'hasKey'>[] = [
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-flash-latest' },
  { name: 'Kimi', endpoint: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6' },
  { name: 'Qwen', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' },
  { name: 'GLM', endpoint: 'https://api.z.ai/api/paas/v4/', model: 'glm-5.2' },
  // 名稱含 "claude" 會自動走 Anthropic /messages 格式(見 llm-client.ts)
  { name: 'Claude', endpoint: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6' },
];

function addPreset(preset: Omit<LlmProvider, 'id' | 'key' | 'enabled' | 'hasKey'>) {
  llmProviders.value.push({ ...preset, id: crypto.randomUUID(), key: '', enabled: false });
  saveLlm();
}

// ── Generate variants ──

const generateDialogOpen = ref(false);
const generateStylePrompt = ref('像日式 RPG 的吐槽旁白，帶點幽默感');
const generateCount = ref(5);
const generatingAll = ref(false);
const generateProgress = ref(0);
const generateStatus = ref('');

function startGenerate() {
  generateDialogOpen.value = false;
  generateAllVariants();
}

async function generateAllVariants() {
  generatingAll.value = true;
  generateProgress.value = 0;
  generateStatus.value = '';

  const typeIds = Object.keys(GAME_MESSAGE_TYPES);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < typeIds.length; i++) {
    const typeId = typeIds[i];
    generateStatus.value = `Generating: ${typeId}...`;

    try {
      const res = await fetch(`/api/messages/generate/${typeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: generateCount.value,
          stylePrompt: generateStylePrompt.value,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        success += data.generated ?? 0;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    generateProgress.value = Math.round(((i + 1) / typeIds.length) * 100);
  }

  generateStatus.value = `Done! ${success} variants generated${failed > 0 ? `, ${failed} failed` : ''}`;
  generatingAll.value = false;
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

.settings-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1.5px solid var(--hud-border-bright);
  position: relative;
}

/* Neon line accent under header */
.settings-panel__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.settings-panel__header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.3);
}

.settings-panel__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.settings-panel__body {
  padding: 16px 20px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

/* 首次設定提示橫跨兩欄,置於面板最上方 */
.settings-panel__setup-alert {
  grid-column: 1 / -1;
}

fieldset {
  border: 1.5px solid var(--hud-border);
  border-radius: 0;
  clip-path: var(--clip-panel-sm);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(var(--accent-rgb), 0.02);
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

.checkbox-label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.field-hint {
  font-size: 9px;
  color: var(--hud-text);
  opacity: 0.6;
  text-transform: none;
  letter-spacing: 0;
  line-height: 1.3;
  margin-top: 2px;
}

/* .field-hint is used as an inline <span> elsewhere; as a block <p> it needs
   the browser's default paragraph margins cleared. */
.bgm-hint {
  margin: 2px 0 0;
}

.tpl-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--hud-cyan);
  border-color: var(--hud-border);
  background: rgba(var(--accent-rgb), 0.05);
}

.tpl-btn:hover {
  background: rgba(var(--accent-rgb), 0.15);
  border-color: var(--hud-cyan);
}

.llm-entry {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1.5px solid var(--hud-border);
  margin-bottom: 8px;
}

.llm-entry__row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.llm-entry__row label:first-child {
  flex: 1;
}

.llm-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.generate-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.generate-dialog__body label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.msg-generate__status {
  font-size: 10px;
  color: var(--hud-text);
  margin-top: 4px;
  letter-spacing: 0.5px;
}

.attribution-intro {
  font-size: 11px;
  color: var(--hud-text-dim);
  line-height: 1.5;
  margin: 0 0 10px;
}

.attribution-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attribution-item {
  font-size: 12px;
  color: var(--hud-text-dim);
  line-height: 1.5;
}

.attribution-role {
  display: inline-block;
  min-width: 64px;
  font-weight: 600;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
}

.attribution-links {
  margin-left: 4px;
}

.attribution-links a {
  color: var(--hud-accent, #4ea1ff);
  text-decoration: none;
}

.attribution-links a:hover {
  text-decoration: underline;
}
</style>
