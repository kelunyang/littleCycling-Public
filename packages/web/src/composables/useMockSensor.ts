import { ref, onUnmounted } from 'vue';
import { useSensorStore } from '@/stores/sensorStore';
import type { HrData, ScData, PwrData } from '@littlecycling/shared';

export function useMockSensor() {
  const active = ref(false);
  const sensorStore = useSensorStore();
  let timer: ReturnType<typeof setInterval> | null = null;

  // Random walk state
  let hr = 130;
  let speed = 25;
  let cadence = 85;
  let distance = 0;

  function tick() {
    // Heart rate: random walk 90-180
    hr += (Math.random() - 0.48) * 4;
    hr = Math.max(90, Math.min(180, hr));

    // Speed: oscillate 10-45 km/h
    speed += (Math.random() - 0.5) * 3;
    speed = Math.max(10, Math.min(45, speed));

    // Cadence: oscillate 60-110 rpm
    cadence += (Math.random() - 0.5) * 5;
    cadence = Math.max(60, Math.min(110, cadence));

    // Cumulative distance
    distance += (speed / 3.6); // 1 second at speed m/s

    const hrData: HrData = {
      heartRate: Math.round(hr),
      source: 'ble',
    };

    const scData: ScData = {
      speed: Math.round(speed * 10) / 10,
      cadence: Math.round(cadence),
      distance: Math.round(distance),
      source: 'ant',
    };

    sensorStore.updateHr(hrData);
    sensorStore.updateSc(scData);
  }

  function start() {
    if (timer) return;
    active.value = true;
    sensorStore.connected = true;
    tick();
    timer = setInterval(tick, 1000);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    active.value = false;
  }

  onUnmounted(() => {
    stop();
  });

  return { active, start, stop };
}
