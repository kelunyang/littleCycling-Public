import { defineStore } from 'pinia';
import { ref } from 'vue';
import { DEFAULT_CONFIG, type AppConfig, type LlmProvider } from '@littlecycling/shared';
import { notifyError } from '@/utils/notify';

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig>(structuredClone(DEFAULT_CONFIG));
  // LLM providers 已從 config.json 搬到 SQLite,改走 /api/llm-providers。
  // key 一律遮罩(只回 hasKey),明碼只存後端。
  const llmProviders = ref<LlmProvider[]>([]);

  /** Fetch config from server. */
  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        config.value = await res.json() as AppConfig;
      }
    } catch {
      notifyError('Failed to load settings');
    }
  }

  /** 讀取 LLM provider 清單(遮罩後)。 */
  async function fetchLlmProviders() {
    try {
      const res = await fetch('/api/llm-providers');
      if (res.ok) {
        const data = await res.json() as { providers: LlmProvider[] };
        llmProviders.value = data.providers ?? [];
      }
    } catch {
      notifyError('Failed to load LLM providers');
    }
  }

  /**
   * 整組覆蓋 LLM provider 清單(PUT)。空 key＝保留舊 key(後端以 id 對回)。
   * 存完以伺服器回傳的遮罩清單覆寫本地,確保前端副本不持有明碼 key。
   */
  async function saveLlmProviders(providers: LlmProvider[]) {
    try {
      const res = await fetch('/api/llm-providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      if (res.ok) {
        const data = await res.json() as { providers: LlmProvider[] };
        llmProviders.value = data.providers ?? [];
      }
    } catch {
      notifyError('Failed to save LLM providers');
    }
  }

  /** Save partial config to server (PATCH deep merge). */
  async function saveConfig(partial: Partial<AppConfig>) {
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      // 後端在 PATCH 回應裡帶回最新的 missingSettings(首次設定提示用);
      // 同步更新本地,已填的欄位一存檔提示就會消失。
      if (res.ok) {
        const updated = await res.json() as AppConfig;
        config.value.missingSettings = updated.missingSettings ?? [];
        config.value.setupCompleted = updated.setupCompleted;
      }
    } catch {
      notifyError('Failed to save settings');
    }
  }

  function updateSensor(partial: Partial<AppConfig['sensor']>) {
    Object.assign(config.value.sensor, partial);
    saveConfig({ sensor: config.value.sensor });
  }

  function updateTraining(partial: Partial<AppConfig['training']>) {
    Object.assign(config.value.training, partial);
    saveConfig({ training: config.value.training });
  }

  function updateServer(partial: Partial<AppConfig['server']>) {
    Object.assign(config.value.server, partial);
    saveConfig({ server: config.value.server });
  }

  function updateMap(partial: Partial<AppConfig['map']>) {
    Object.assign(config.value.map, partial);
    saveConfig({ map: config.value.map });
  }

  function updateSound(partial: Partial<AppConfig['sound']>) {
    Object.assign(config.value.sound, partial);
    saveConfig({ sound: config.value.sound });
  }

  function updateDebug(debug: boolean) {
    config.value.debug = debug;
    saveConfig({ debug });
  }

  function reset() {
    config.value = structuredClone(DEFAULT_CONFIG);
  }

  return { config, llmProviders, fetchConfig, saveConfig, fetchLlmProviders, saveLlmProviders, updateSensor, updateTraining, updateServer, updateMap, updateSound, updateDebug, reset };
});
