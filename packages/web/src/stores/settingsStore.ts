import { defineStore } from 'pinia';
import { ref } from 'vue';
import { DEFAULT_CONFIG, type AppConfig } from '@littlecycling/shared';
import { notifyError } from '@/utils/notify';

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig>(structuredClone(DEFAULT_CONFIG));

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

  /** Save partial config to server (PATCH deep merge). */
  async function saveConfig(partial: Partial<AppConfig>) {
    try {
      await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
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

  return { config, fetchConfig, saveConfig, updateSensor, updateTraining, updateServer, updateMap, updateSound, updateDebug, reset };
});
