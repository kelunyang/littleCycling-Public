<template>
  <div class="welcome" :data-world-style="worldStyle">
    <WelcomeBackdrop :style-variant="worldStyle" />
    <div class="welcome__card">
      <header class="welcome__header">
        <h1 class="welcome__title">
          <font-awesome-icon icon="bicycle" />
          littleCycling
        </h1>
      </header>

      <PlanBanner />

      <div ref="bodyRef" class="welcome__body">
        <section ref="layer1Ref" class="welcome__layer">
          <div class="welcome__layer-title">
            <span class="welcome__layer-heading">
              <font-awesome-icon icon="map-location-dot" />
              <span>1 &middot; Select Map</span>
            </span>
            <div class="welcome__layer-actions">
              <button
                type="button"
                class="welcome__layer-action"
                title="Upload GPX / TCX / FIT"
                @click="routeListRef?.openFilePicker()"
              >
                <font-awesome-icon icon="upload" />
              </button>
              <button
                type="button"
                class="welcome__layer-action"
                title="Browse EuroVelo catalog"
                @click="catalogOpen = true"
              >
                <font-awesome-icon icon="route" />
              </button>
            </div>
          </div>
          <RouteList ref="routeListRef" @selected="handleRouteSelected" />
        </section>

        <section ref="layer2Ref" class="welcome__layer">
          <div class="welcome__layer-title">
            <span class="welcome__layer-heading">
              <font-awesome-icon icon="sliders" />
              <span>2 &middot; Training Settings</span>
            </span>
          </div>
          <StartChecklist />
        </section>
      </div>

      <StartBar />

      <footer class="welcome__footer">
        <span>Kelunyang@2026 by claude with <font-awesome-icon icon="heart" class="welcome__heart" /></span>
        <a href="https://github.com/kelunyang/littleCycling" target="_blank" rel="noopener noreferrer" class="welcome__github-link">
          <font-awesome-icon :icon="['fab', 'github']" />
          GitHub
        </a>
      </footer>

      <div class="welcome__top-btns">
        <el-button class="welcome__top-btn" circle @click="calendar.open()">
          <font-awesome-icon icon="calendar-days" />
        </el-button>
        <el-button class="welcome__top-btn" circle @click="presetOpen = true">
          <font-awesome-icon icon="clipboard-list" />
        </el-button>
        <el-button class="welcome__top-btn" circle @click="settingsOpen = true">
          <font-awesome-icon icon="gear" />
        </el-button>
      </div>
    </div>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <TrainingCalendar :open="calendar.isOpen.value" @close="calendar.close()" />
    <PresetDrawer :open="presetOpen" @close="presetOpen = false" />
    <CatalogDrawer :open="catalogOpen" @close="catalogOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import RouteList from '@/components/welcome/RouteList.vue';
import StartChecklist from '@/components/welcome/StartChecklist.vue';
import StartBar from '@/components/welcome/StartBar.vue';
import SettingsPanel from '@/components/welcome/SettingsPanel.vue';
import TrainingCalendar from '@/components/welcome/TrainingCalendar.vue';
import PresetDrawer from '@/components/welcome/PresetDrawer.vue';
import CatalogDrawer from '@/components/welcome/CatalogDrawer.vue';
import PlanBanner from '@/components/welcome/PlanBanner.vue';
import WelcomeBackdrop from '@/components/welcome/WelcomeBackdrop.vue';
import { usePlanStore } from '@/stores/planStore';
import { useRouteStore } from '@/stores/routeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWebSocket } from '@/composables/useWebSocket';
import { useCalendar } from '@/composables/useCalendar';

const routeStore = useRouteStore();
const settingsStore = useSettingsStore();
const planStore = usePlanStore();
const ws = useWebSocket();
const settingsOpen = ref(false);
const presetOpen = ref(false);
const catalogOpen = ref(false);
const calendar = useCalendar();

/** Welcome theme follows the world style picked in StartChecklist. */
const worldStyle = computed(
  () => settingsStore.config.map.phaserStyle ?? 'plastic',
);

const bodyRef = ref<HTMLElement | null>(null);
const layer1Ref = ref<HTMLElement | null>(null);
const layer2Ref = ref<HTMLElement | null>(null);
const routeListRef = ref<InstanceType<typeof RouteList> | null>(null);

async function handleRouteSelected() {
  await nextTick();
  const body = bodyRef.value;
  const layer2 = layer2Ref.value;
  if (!body || !layer2) return;
  const offset = layer2.offsetTop - body.offsetTop;
  body.scrollTo({ top: offset, behavior: 'smooth' });
}

onMounted(() => {
  routeStore.fetchRoutes();
  settingsStore.fetchConfig();
  planStore.fetchPlans();
  planStore.fetchActivePlans();
  ws.connect();
});
</script>

<style scoped>
.welcome {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: radial-gradient(ellipse at center, #1a1a3e 0%, #0a0a1a 70%);
  position: relative;
  padding: 24px;
  box-sizing: border-box;
  overflow: hidden;
}

.welcome__card {
  position: relative;
  z-index: 1;
  width: 80vw;
  max-width: 1600px;
  min-width: 600px;
  background: var(--surface-gradient, var(--surface));
  border: 1.5px solid var(--hud-border-bright);
  border-radius: var(--card-radius);
  padding: 24px 28px;
  filter: var(--card-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.welcome__header {
  text-align: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1.5px solid var(--hud-border);
  flex-shrink: 0;
}

.welcome__title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.welcome__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--accent-strong) transparent;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-right: 4px;
}

.welcome__body::-webkit-scrollbar {
  width: 5px;
}

.welcome__body::-webkit-scrollbar-thumb {
  background: var(--accent-strong);
}

.welcome__layer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.welcome__layer-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0;
  padding-bottom: 6px;
  border-bottom: 1.5px solid var(--hud-border);
}

.welcome__layer-heading {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 1.5px;
}

.welcome__layer-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.welcome__layer-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: var(--accent-tint);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  color: var(--hud-cyan);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}

.welcome__layer-action:hover {
  background: var(--accent-hover);
  border-color: var(--hud-cyan);
  transform: translateY(-1px);
}

.welcome__top-btns {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 6px;
  z-index: 2;
}

.welcome__top-btn {
  font-size: 18px;
  color: var(--hud-cyan);
  border-color: var(--hud-border);
  background: var(--accent-soft);
}

.welcome__footer {
  text-align: center;
  margin-top: 12px;
  padding-top: 8px;
  flex-shrink: 0;
  border-top: 1.5px solid var(--hud-border);
  font-family: var(--font-display);
  font-size: 12px;
  color: var(--hud-text-dim);
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.welcome__github-link {
  color: var(--hud-text-dim);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color 0.2s;
}

.welcome__github-link:hover {
  color: var(--hud-cyan);
}

.welcome__heart {
  color: var(--hud-magenta, #ff0066);
}

.welcome__top-btn:hover {
  border-color: var(--hud-cyan);
  background: var(--accent-hover);
}

/* ── Plastic theme: welcome-specific decoration (tokens live in App.vue) ── */
.welcome[data-world-style="plastic"] .welcome__card {
  border: 3px solid #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__title {
  color: #ff3b8d;
  text-shadow: 2px 2px 0 #1a1140, 4px 4px 0 #00d8ff;
  letter-spacing: 1px;
  font-weight: 700;
}

.welcome[data-world-style="plastic"] .welcome__layer-heading {
  color: #1a1140;
  text-shadow: 2px 2px 0 #ffea00;
  letter-spacing: 0.5px;
  text-transform: none;
}

.welcome[data-world-style="plastic"] .welcome__layer-action {
  background: linear-gradient(180deg, #00e5ff 0%, #00b4d8 100%);
  border: 2px solid #1a1140;
  color: #ffffff;
  box-shadow: 0 3px 0 #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__layer-action:hover {
  background: linear-gradient(180deg, #76ff03 0%, #4caf50 100%);
  transform: translateY(-2px);
  box-shadow: 0 5px 0 #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__top-btn {
  background: linear-gradient(180deg, #ffea00 0%, #ffb300 100%);
  border: 2px solid #1a1140;
  color: #1a1140;
  box-shadow: 0 3px 0 #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__top-btn:hover {
  background: linear-gradient(180deg, #ff3b8d 0%, #d500f9 100%);
  color: #ffffff;
  border-color: #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__footer {
  border-top: 2px dashed rgba(26, 17, 64, 0.3);
  color: #1a1140;
  text-transform: none;
  letter-spacing: 0.5px;
}

.welcome[data-world-style="plastic"] .welcome__github-link {
  color: #1a1140;
}

.welcome[data-world-style="plastic"] .welcome__github-link:hover {
  color: #ff3b8d;
}

/* ── Cuphead theme: welcome-specific decoration (tokens live in App.vue) ── */
.welcome[data-world-style="cuphead"] .welcome__card {
  border: 4px double #2a2420;
  padding: 26px 30px;
  font-family: var(--font-body);
  color: var(--hud-text);
}

.welcome[data-world-style="cuphead"] .welcome__title {
  color: #a0523c;
  text-shadow: 3px 3px 0 #2a2420, 6px 6px 0 #c4a035;
  letter-spacing: 1px;
  font-weight: 700;
  text-transform: none;
  font-size: 36px;
}

.welcome[data-world-style="cuphead"] .welcome__layer-heading {
  color: #2a2420;
  letter-spacing: 0.5px;
  text-transform: none;
  font-weight: 700;
  font-size: 18px;
}

.welcome[data-world-style="cuphead"] .welcome__layer-action {
  background: #c4a035;
  border: 2px solid #2a2420;
  color: #2a2420;
  box-shadow: 2px 2px 0 #2a2420;
  transition: transform 0.1s, box-shadow 0.1s;
}

.welcome[data-world-style="cuphead"] .welcome__layer-action:hover {
  background: #a0523c;
  color: #f0e4cc;
  transform: translate(1px, 1px);
  box-shadow: 1px 1px 0 #2a2420;
}

.welcome[data-world-style="cuphead"] .welcome__top-btn {
  background: #6b7f3b;
  border: 2px solid #2a2420;
  color: #f0e4cc;
  box-shadow: 2px 2px 0 #2a2420;
}

.welcome[data-world-style="cuphead"] .welcome__top-btn:hover {
  background: #a0523c;
  color: #f0e4cc;
  border-color: #2a2420;
}

.welcome[data-world-style="cuphead"] .welcome__footer {
  border-top: 2px solid #2a2420;
  color: #4a3a2a;
  text-transform: none;
  letter-spacing: 0.5px;
  font-size: 14px;
}

.welcome[data-world-style="cuphead"] .welcome__github-link {
  color: #4a3a2a;
}

.welcome[data-world-style="cuphead"] .welcome__github-link:hover {
  color: #a0523c;
}

.welcome[data-world-style="cuphead"] .welcome__heart {
  color: #a0523c;
}
</style>

<style>
/* ── Non-scoped: theme overrides cascade into child welcome components ─ */

/* Soften the dark page gradient for cuphead so the paper card stands out. */
.welcome[data-world-style="cuphead"] {
  background: radial-gradient(ellipse at center, #2a2418 0%, #100c08 70%) !important;
}

/* Plastic: brighter playful page gradient. */
.welcome[data-world-style="plastic"] {
  background: radial-gradient(ellipse at center, #261a55 0%, #0a081a 70%) !important;
}

/* Buttons inside Element Plus pick up the plastic / cuphead vibe via tokens.
   We also override a few that hard-code rgba values. */

/* Start ride button — plastic: candy gradient */
.welcome[data-world-style="plastic"] .start-bar .el-button--success {
  background: linear-gradient(180deg, #76ff03 0%, #00c853 100%) !important;
  color: #ffffff !important;
  border: 2px solid #1a1140 !important;
  border-radius: 16px !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.25) !important;
  box-shadow: 0 4px 0 #1a1140, 0 8px 16px rgba(118, 255, 3, 0.45) !important;
  animation: none !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

.welcome[data-world-style="plastic"] .start-bar .el-button--success:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 0 #1a1140, 0 12px 20px rgba(118, 255, 3, 0.55) !important;
}

/* Start ride button — cuphead: solid mustard brick with sketchy lettering */
.welcome[data-world-style="cuphead"] .start-bar .el-button--success {
  background: #c4a035 !important;
  color: #2a2420 !important;
  border: 3px solid #2a2420 !important;
  border-radius: 0 !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
  text-transform: none !important;
  font-size: 18px !important;
  text-shadow: none !important;
  box-shadow: 4px 4px 0 #2a2420 !important;
  animation: none !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

.welcome[data-world-style="cuphead"] .start-bar .el-button--success:hover {
  background: #a0523c !important;
  color: #f0e4cc !important;
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 #2a2420 !important;
}

.welcome[data-world-style="plastic"] .route-card {
  border-radius: 14px;
  border: 2px solid #1a1140;
  background: linear-gradient(180deg, #ffffff 0%, #ffe5f1 100%);
}

.welcome[data-world-style="plastic"] .route-card .route-card__name {
  color: #1a1140;
}

.welcome[data-world-style="plastic"] .route-card--selected {
  background: linear-gradient(180deg, #b9f6ca 0%, #76ff03 100%);
  border-color: #1a1140;
  filter: none;
  box-shadow: 0 4px 0 #1a1140;
}

.welcome[data-world-style="cuphead"] .route-card {
  border-radius: 0;
  border: 2px solid #2a2420;
  background: rgba(255, 250, 235, 0.55);
}

.welcome[data-world-style="cuphead"] .route-card--selected {
  background: #c4a035;
  border-color: #2a2420;
  filter: none;
  box-shadow: 3px 3px 0 #2a2420;
}

.welcome[data-world-style="cuphead"] .route-card .route-card__name {
  color: #2a2420;
}
</style>
