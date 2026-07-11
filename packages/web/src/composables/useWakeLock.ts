import { ref, onUnmounted, type Ref } from 'vue';

export interface WakeLockReturn {
  isSupported: Ref<boolean>;
  isActive: Ref<boolean>;
  request(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Screen Wake Lock — keeps the display awake during a ride so the OS
 * screensaver / display sleep never kicks in while the rider's hands are
 * on the bars instead of the mouse.
 *
 * The browser force-releases the lock whenever the page becomes hidden
 * (tab switch, window minimise), so we re-acquire on visibilitychange for
 * as long as request() has been called without a matching release().
 *
 * Requires a secure context (https or localhost) and Chrome/Edge 84+.
 * Unsupported browsers degrade silently — isSupported stays false and
 * request() is a no-op.
 */
export function useWakeLock(): WakeLockReturn {
  const isSupported = ref('wakeLock' in navigator);
  const isActive = ref(false);

  let sentinel: WakeLockSentinel | null = null;
  // True between request() and release() — drives visibilitychange re-acquire.
  let wanted = false;

  async function acquire(): Promise<void> {
    if (!isSupported.value || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      isActive.value = true;
      sentinel.addEventListener('release', () => {
        isActive.value = false;
        sentinel = null;
      });
    } catch {
      // NotAllowedError (e.g. battery saver mode) — best-effort, the game
      // works fine without it, the screen just isn't guaranteed to stay on.
      isActive.value = false;
    }
  }

  function handleVisibilityChange(): void {
    if (wanted && document.visibilityState === 'visible' && !sentinel) {
      void acquire();
    }
  }

  async function request(): Promise<void> {
    if (wanted) return;
    wanted = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    await acquire();
  }

  async function release(): Promise<void> {
    wanted = false;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (sentinel) {
      const s = sentinel;
      sentinel = null;
      await s.release().catch(() => {});
    }
    isActive.value = false;
  }

  onUnmounted(() => {
    void release();
  });

  return { isSupported, isActive, request, release };
}
