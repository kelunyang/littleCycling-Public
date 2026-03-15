import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { HrData, ScData, PwrData, DetectedSensor, LiveSessionState } from '@littlecycling/shared';

export const useSensorStore = defineStore('sensor', () => {
  const hr = ref<HrData | null>(null);
  const sc = ref<ScData | null>(null);
  const pwr = ref<PwrData | null>(null);
  const connected = ref(false);

  // Session state from server (via WS status messages)
  const sessionState = ref<LiveSessionState>('idle');
  const sensors = ref<DetectedSensor[]>([]);
  const rideId = ref<number | null>(null);

  function updateHr(data: HrData) {
    hr.value = data;
  }

  function updateSc(data: ScData) {
    sc.value = data;
  }

  function updatePwr(data: PwrData) {
    pwr.value = data;
  }

  function updateStatus(msg: { state: LiveSessionState; sensors: DetectedSensor[]; rideId: number | null }) {
    sessionState.value = msg.state;
    sensors.value = msg.sensors;
    rideId.value = msg.rideId;
    connected.value = msg.state === 'ready' || msg.state === 'recording';
  }

  function reset() {
    hr.value = null;
    sc.value = null;
    pwr.value = null;
    connected.value = false;
    sessionState.value = 'idle';
    sensors.value = [];
    rideId.value = null;
  }

  return { hr, sc, pwr, connected, sessionState, sensors, rideId, updateHr, updateSc, updatePwr, updateStatus, reset };
});
