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
import { ElMessageBox } from 'element-plus';
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
import { useAnalysisStore } from '@/stores/analysisStore';
import { useWebSocket } from '@/composables/useWebSocket';
import { useCalendar } from '@/composables/useCalendar';
import { useThemeBgm } from '@/composables/useThemeBgm';

const routeStore = useRouteStore();
const settingsStore = useSettingsStore();
const planStore = usePlanStore();
const analysisStore = useAnalysisStore();
const ws = useWebSocket();
const settingsOpen = ref(false);
const presetOpen = ref(false);
const catalogOpen = ref(false);
const calendar = useCalendar();

/** Welcome theme follows the world style picked in StartChecklist. */
const worldStyle = computed(
  () => settingsStore.config.map.worldStyle ?? 'plastic',
);

// The theme song plays here too, and keeps playing into the ride (shared
// AudioManager). Picking a route swaps the music to that route's own tune, so
// the welcome screen doubles as a preview.
const { startOnFirstGesture } = useThemeBgm();

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

/**
 * Prompt a `git pull` when the server's update check found a newer public
 * release. The check itself runs on the backend (result lives in config.update);
 * here we only render the reminder. Same version nags once — we remember the
 * dismissed commit hash so only a genuinely newer commit prompts again.
 */
async function maybePromptUpdate() {
  const u = settingsStore.config.update;
  if (!u?.updateAvailable || !u.remoteHash) return;
  if (localStorage.getItem('lc-update-dismissed') === u.remoteHash) return;
  ElMessageBox.alert(
    '偵測到 littleCycling 有新版本。請在專案目錄執行 git pull 取得最新更新。',
    '有可用更新',
    { confirmButtonText: '知道了' },
  ).finally(() => localStorage.setItem('lc-update-dismissed', u.remoteHash!));
}

onMounted(async () => {
  routeStore.fetchRoutes();
  planStore.fetchPlans();
  planStore.fetchActivePlans();
  ws.connect();
  // Autoplay policy: audio can only start from a user gesture, so arm a
  // one-shot listener rather than trying (and silently failing) right here.
  startOnFirstGesture();
  await settingsStore.fetchConfig();
  settingsStore.fetchLlmProviders();
  // 首次使用:後端回報必填個人化設定尚未填齊 → 自動打開設定 drawer 提示。
  // 非強制,使用者仍可關掉繼續玩,下次啟動再提示(直到設定完成)。
  if ((settingsStore.config.missingSettings?.length ?? 0) > 0) {
    settingsOpen.value = true;
  }
  maybePromptUpdate();
  // 從遊戲結束「讓 AI 評論」帶旗標回來 → 自動開 PresetDrawer(內部再開 picker、預勾)。
  if (analysisStore.autoAnalyzeRideId != null) {
    presetOpen.value = true;
  }
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
  border: 3px solid var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__title {
  color: var(--pl-pink);
  text-shadow: 2px 2px 0 var(--pl-ink), 4px 4px 0 var(--pl-cyan);
  letter-spacing: 1px;
  font-weight: 700;
}

.welcome[data-world-style="plastic"] .welcome__layer-heading {
  color: var(--pl-ink);
  text-shadow: 2px 2px 0 var(--pl-yellow);
  letter-spacing: 0.5px;
  text-transform: none;
}

.welcome[data-world-style="plastic"] .welcome__layer-action {
  background: linear-gradient(180deg, #00e5ff 0%, var(--pl-cyan-deep) 100%);
  border: 2px solid var(--pl-ink);
  color: #ffffff;
  box-shadow: 0 3px 0 var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__layer-action:hover {
  background: linear-gradient(180deg, var(--pl-green) 0%, var(--pl-green-2) 100%);
  transform: translateY(-2px);
  box-shadow: 0 5px 0 var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__top-btn {
  background: linear-gradient(180deg, var(--pl-yellow) 0%, var(--pl-amber) 100%);
  border: 2px solid var(--pl-ink);
  color: var(--pl-ink);
  box-shadow: 0 3px 0 var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__top-btn:hover {
  background: linear-gradient(180deg, var(--pl-pink) 0%, var(--pl-purple) 100%);
  color: #ffffff;
  border-color: var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__footer {
  border-top: 2px dashed rgba(var(--pl-ink-rgb), 0.3);
  color: var(--pl-ink);
  text-transform: none;
  letter-spacing: 0.5px;
}

.welcome[data-world-style="plastic"] .welcome__github-link {
  color: var(--pl-ink);
}

.welcome[data-world-style="plastic"] .welcome__github-link:hover {
  color: var(--pl-pink);
}

/* ── Cuphead theme: welcome-specific decoration (tokens live in App.vue) ── */
.welcome[data-world-style="cuphead"] .welcome__card {
  border: 4px double var(--ck-ink);
  padding: 26px 30px;
  font-family: var(--font-body);
  color: var(--hud-text);
}

.welcome[data-world-style="cuphead"] .welcome__title {
  color: var(--ck-rust);
  text-shadow: 3px 3px 0 var(--ck-ink), 6px 6px 0 var(--ck-gold);
  letter-spacing: 1px;
  font-weight: 700;
  text-transform: none;
  font-size: 36px;
}

.welcome[data-world-style="cuphead"] .welcome__layer-heading {
  color: var(--ck-ink);
  letter-spacing: 0.5px;
  text-transform: none;
  font-weight: 700;
  font-size: 18px;
}

.welcome[data-world-style="cuphead"] .welcome__layer-action {
  background: var(--ck-gold);
  border: 2px solid var(--ck-ink);
  color: var(--ck-ink);
  box-shadow: 2px 2px 0 var(--ck-ink);
  transition: transform 0.1s, box-shadow 0.1s;
}

.welcome[data-world-style="cuphead"] .welcome__layer-action:hover {
  background: var(--ck-rust);
  color: var(--ck-paper-hi);
  transform: translate(1px, 1px);
  box-shadow: 1px 1px 0 var(--ck-ink);
}

.welcome[data-world-style="cuphead"] .welcome__top-btn {
  background: var(--ck-olive);
  border: 2px solid var(--ck-ink);
  color: var(--ck-paper-hi);
  box-shadow: 2px 2px 0 var(--ck-ink);
}

.welcome[data-world-style="cuphead"] .welcome__top-btn:hover {
  background: var(--ck-rust);
  color: var(--ck-paper-hi);
  border-color: var(--ck-ink);
}

.welcome[data-world-style="cuphead"] .welcome__footer {
  border-top: 2px solid var(--ck-ink);
  color: var(--ck-ink-soft);
  text-transform: none;
  letter-spacing: 0.5px;
  font-size: 14px;
}

.welcome[data-world-style="cuphead"] .welcome__github-link {
  color: var(--ck-ink-soft);
}

.welcome[data-world-style="cuphead"] .welcome__github-link:hover {
  color: var(--ck-rust);
}

.welcome[data-world-style="cuphead"] .welcome__heart {
  color: var(--ck-rust);
}
</style>

<style>
/* ── Non-scoped: theme overrides cascade into child welcome components ─ */

/* Soften the dark page gradient for cuphead so the paper card stands out. */
.welcome[data-world-style="cuphead"] {
  background: radial-gradient(ellipse at center, var(--ck-page-hi) 0%, var(--ck-page-lo) 70%) !important;
}

/* Plastic: brighter playful page gradient. */
.welcome[data-world-style="plastic"] {
  background: radial-gradient(ellipse at center, var(--pl-page-hi) 0%, var(--pl-page-lo) 70%) !important;
}

/* Buttons inside Element Plus pick up the plastic / cuphead vibe via tokens.
   We also override a few that hard-code rgba values. */

/* Start ride button — plastic: candy gradient */
.welcome[data-world-style="plastic"] .start-bar .el-button--success {
  background: linear-gradient(180deg, var(--pl-green) 0%, var(--pl-green-deep) 100%) !important;
  color: #ffffff !important;
  border: 2px solid var(--pl-ink) !important;
  border-radius: 16px !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.25) !important;
  box-shadow: 0 4px 0 var(--pl-ink), 0 8px 16px rgba(var(--pl-green-rgb), 0.45) !important;
  animation: none !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

.welcome[data-world-style="plastic"] .start-bar .el-button--success:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 0 var(--pl-ink), 0 12px 20px rgba(var(--pl-green-rgb), 0.55) !important;
}

/* Start ride button — cuphead: solid mustard brick with sketchy lettering */
.welcome[data-world-style="cuphead"] .start-bar .el-button--success {
  background: var(--ck-gold) !important;
  color: var(--ck-ink) !important;
  border: 3px solid var(--ck-ink) !important;
  border-radius: 0 !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
  text-transform: none !important;
  font-size: 18px !important;
  text-shadow: none !important;
  box-shadow: 4px 4px 0 var(--ck-ink) !important;
  animation: none !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

.welcome[data-world-style="cuphead"] .start-bar .el-button--success:hover {
  background: var(--ck-rust) !important;
  color: var(--ck-paper-hi) !important;
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 var(--ck-ink) !important;
}

.welcome[data-world-style="plastic"] .route-card {
  border-radius: 14px;
  border: 2px solid var(--pl-ink);
  background: linear-gradient(180deg, #ffffff 0%, var(--pl-paper) 100%);
}

.welcome[data-world-style="plastic"] .route-card .route-card__name {
  color: var(--pl-ink);
}

.welcome[data-world-style="plastic"] .route-card--selected {
  background: linear-gradient(180deg, var(--pl-mint) 0%, var(--pl-green) 100%);
  border-color: var(--pl-ink);
  filter: none;
  box-shadow: 0 4px 0 var(--pl-ink);
}

.welcome[data-world-style="cuphead"] .route-card {
  border-radius: 0;
  border: 2px solid var(--ck-ink);
  background: rgba(255, 250, 235, 0.55);
}

.welcome[data-world-style="cuphead"] .route-card--selected {
  background: var(--ck-gold);
  border-color: var(--ck-ink);
  filter: none;
  box-shadow: 3px 3px 0 var(--ck-ink);
}

.welcome[data-world-style="cuphead"] .route-card .route-card__name {
  color: var(--ck-ink);
}
</style>
