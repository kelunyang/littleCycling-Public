/**
 * Wires the shared AudioManager's BGM to app config, for any view that wants
 * the theme song playing.
 *
 * Both WelcomeView and GameView use this so the switches (master sound, BGM,
 * world style) behave identically in each, and — because the AudioManager is a
 * session singleton — the tune carries across the navigation between them
 * without restarting.
 *
 * The seed comes from the selected route, so each route keeps its own theme;
 * picking a different route on the welcome screen swaps the music immediately,
 * which doubles as a preview of what the ride will sound like.
 */

import { computed, watch, onBeforeUnmount } from 'vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRouteStore } from '@/stores/routeStore';
import { getAudioManager } from '@/game/audio/audio-manager';
import { seedFromString } from '@/game/audio/generative-bgm';

/** Theme used before any route is chosen (welcome screen, free roam). */
const LOBBY_SEED = 20250720;

export function useThemeBgm() {
  const settingsStore = useSettingsStore();
  const routeStore = useRouteStore();
  const audio = getAudioManager();

  const worldStyle = computed(
    () => settingsStore.config.map.worldStyle ?? 'plastic',
  );
  const seed = computed(() => {
    const id = routeStore.activeRoute?.id;
    return id ? seedFromString(id) : LOBBY_SEED;
  });

  // Push current config in before any watcher fires.
  audio.setEnabled(settingsStore.config.sound.enabled);
  audio.setBgmEnabled(settingsStore.config.sound.bgmEnabled);

  watch(
    () => settingsStore.config.sound.enabled,
    (on) => audio.setEnabled(on),
  );
  watch(
    () => settingsStore.config.sound.bgmEnabled,
    (on) => audio.setBgmEnabled(on),
  );
  // World style drives the musical idiom as well as the visuals — 樂器是從那個
  // 世界的**材料**推出來的:積木是音樂盒／玩具鋼琴的發條進行曲,紙板是打字機
  // 當脈搏的快三拍辦公室,電子是繼電器與方波的開機自檢。
  watch(worldStyle, (style) => audio.setWorldStyle(style));
  // Route changed → its own theme. startBgm no-ops when nothing actually
  // changed, so this never restarts the music needlessly.
  watch(seed, () => {
    audio.startBgm(worldStyle.value, seed.value);
  });

  /** Request the theme song. Silent until a user gesture unlocks audio. */
  function start(): void {
    audio.startBgm(worldStyle.value, seed.value);
  }

  const arm = () => {
    disarm();
    start();
  };
  function disarm(): void {
    window.removeEventListener('pointerdown', arm);
    window.removeEventListener('keydown', arm);
  }
  // Registered here rather than inside startOnFirstGesture: this function body
  // runs during setup, where the lifecycle hook reliably binds to the instance.
  onBeforeUnmount(disarm);

  /**
   * Start on the first user interaction. Browsers refuse to produce sound
   * before a gesture, so the welcome screen arms a one-shot listener instead
   * of trying (and silently failing) on mount.
   */
  function startOnFirstGesture(): void {
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
  }

  return { audio, worldStyle, seed, start, startOnFirstGesture };
}
