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
            HR Max (bpm)
            <el-input-number v-model="hrMaxModel" :min="100" :max="250" size="small" controls-position="right" />
          </label>

          <label>
            FTP (watts)
            <el-input-number v-model="ftpModel" :min="50" :max="600" size="small" controls-position="right" />
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
      </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { WHEEL_CIRCUMFERENCES, POWER_CURVES, type AppConfig } from '@littlecycling/shared';
import { OPENFREEMAP_STYLES } from '@/game/map-styles';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const settingsStore = useSettingsStore();
const config = computed(() => settingsStore.config);

const currentStyles = OPENFREEMAP_STYLES;

const wheelCircModel = computed({
  get: () => config.value.sensor.wheelCircumference,
  set: (val: number) => settingsStore.updateSensor({ wheelCircumference: val }),
});

const trainerModel = computed({
  get: () => config.value.sensor.trainerModel,
  set: (val: string) => settingsStore.updateSensor({ trainerModel: val }),
});

const hrMaxModel = computed({
  get: () => config.value.training.hrMax,
  set: (val: number) => settingsStore.updateTraining({ hrMax: val }),
});

const ftpModel = computed({
  get: () => config.value.training.ftp,
  set: (val: number) => settingsStore.updateTraining({ ftp: val }),
});

const renderModeModel = computed({
  get: () => config.value.map.renderMode,
  set: (val: AppConfig['map']['renderMode']) => settingsStore.updateMap({ renderMode: val }),
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

const debugModel = computed({
  get: () => config.value.debug,
  set: (val: boolean) => settingsStore.updateDebug(val),
});
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
  border-bottom: 1px solid var(--hud-border-bright);
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
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
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

.checkbox-label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
</style>
