import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { HrData, ScData, PwrData, DetectedSensor, LiveSessionState, HostCapabilities } from '@littlecycling/shared';

const DEFAULT_CAPABILITIES: HostCapabilities = { ant: 'unknown', ble: 'unknown' };

export const useSensorStore = defineStore('sensor', () => {
  const hr = ref<HrData | null>(null);
  const sc = ref<ScData | null>(null);
  const pwr = ref<PwrData | null>(null);
  const connected = ref(false);

  // Authoritative wall-clock from the server. `serverElapsedMs` is the server's
  // `Date.now() - recordingStartTime` at the moment we received the last sensor
  // frame; `serverElapsedPerfNow` is our local `performance.now()` at receipt.
  // The game loop mirrors these (interpolating between frames) so the on-screen
  // timer equals the recorded ride duration — immune to rAF throttling, GPU
  // stutter, PiP, and backgrounding. Null until the first frame of a recording.
  const serverElapsedMs = ref<number | null>(null);
  const serverElapsedPerfNow = ref(0);

  // Session state from server (via WS status messages)
  const sessionState = ref<LiveSessionState>('idle');
  const sensors = ref<DetectedSensor[]>([]);
  const rideId = ref<number | null>(null);
  const capabilities = ref<HostCapabilities>({ ...DEFAULT_CAPABILITIES });

  function updateHr(data: HrData) {
    hr.value = data;
  }

  function updateSc(data: ScData) {
    sc.value = data;
  }

  function updatePwr(data: PwrData) {
    pwr.value = data;
  }

  /** Anchor the server clock from an incoming sensor frame's `elapsed` field. */
  function updateClock(elapsedMs: number) {
    serverElapsedMs.value = elapsedMs;
    serverElapsedPerfNow.value = performance.now();
  }

  function updateStatus(msg: {
    state: LiveSessionState;
    sensors: DetectedSensor[];
    rideId: number | null;
    capabilities?: HostCapabilities;
  }) {
    sessionState.value = msg.state;
    sensors.value = msg.sensors;
    rideId.value = msg.rideId;
    connected.value = msg.state === 'ready' || msg.state === 'recording';
    if (msg.capabilities) {
      capabilities.value = msg.capabilities;
    }
  }

  function reset() {
    hr.value = null;
    sc.value = null;
    pwr.value = null;
    connected.value = false;
    sessionState.value = 'idle';
    sensors.value = [];
    rideId.value = null;
    capabilities.value = { ...DEFAULT_CAPABILITIES };
    serverElapsedMs.value = null;
    serverElapsedPerfNow.value = 0;
  }

  return {
    hr, sc, pwr, connected, sessionState, sensors, rideId, capabilities,
    serverElapsedMs, serverElapsedPerfNow,
    updateHr, updateSc, updatePwr, updateClock, updateStatus, reset,
  };
});
