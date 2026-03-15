import { ref, watch, onUnmounted, type Ref } from 'vue';

export interface CameraControlOptions {
  initialPitch?: number;
  minPitch?: number;
  maxPitch?: number;
  pitchStep?: number;
  /** If true, scroll up decreases pitch value (Three.js: less downward angle = more horizontal). */
  invertScroll?: boolean;
  initialHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  heightStep?: number;
  initialYaw?: number;
  minYaw?: number;
  maxYaw?: number;
  yawStep?: number;
}

const DEFAULT_PITCH = 78;
const DEFAULT_PITCH_STEP = 2;
const DEFAULT_HEIGHT_STEP = 1;
const DEFAULT_YAW_STEP = 3;

export function useCameraControl(
  containerRef: Ref<HTMLElement | null>,
  options?: CameraControlOptions,
) {
  const minPitch = options?.minPitch ?? 30;
  const maxPitch = options?.maxPitch ?? 85;
  const pitchStep = options?.pitchStep ?? DEFAULT_PITCH_STEP;
  const invertScroll = options?.invertScroll ?? false;

  const minHeight = options?.minHeight ?? 1;
  const maxHeight = options?.maxHeight ?? 30;
  const heightStep = options?.heightStep ?? DEFAULT_HEIGHT_STEP;

  const minYaw = options?.minYaw ?? -45;
  const maxYaw = options?.maxYaw ?? 45;
  const yawStep = options?.yawStep ?? DEFAULT_YAW_STEP;

  const pitch = ref(options?.initialPitch ?? DEFAULT_PITCH);
  const height = ref(options?.initialHeight ?? 15);
  const yaw = ref(options?.initialYaw ?? 0);

  let el: HTMLElement | null = null;

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    // scroll up (negative deltaY) → dir = +1
    const dir = e.deltaY < 0 ? 1 : -1;
    const delta = invertScroll ? -dir * pitchStep : dir * pitchStep;
    pitch.value = Math.min(maxPitch, Math.max(minPitch, pitch.value + delta));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      height.value = Math.min(maxHeight, height.value + heightStep);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      height.value = Math.max(minHeight, height.value - heightStep);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      yaw.value = Math.max(minYaw, yaw.value - yawStep);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      yaw.value = Math.min(maxYaw, yaw.value + yawStep);
    }
  }

  function bind(element: HTMLElement) {
    el = element;
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
  }

  function unbind() {
    window.removeEventListener('keydown', onKeyDown);
    if (el) {
      el.removeEventListener('wheel', onWheel);
      el = null;
    }
  }

  watch(containerRef, (newEl) => {
    unbind();
    if (newEl) bind(newEl);
  }, { immediate: true });

  onUnmounted(unbind);

  return { pitch, height, yaw };
}
