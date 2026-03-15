import { ref, shallowRef, computed, type Ref } from 'vue';
import type { RoutePoint } from '@littlecycling/shared';
import { VirtualPowerEstimator, isDualSidedPower, calcSteeringAngle } from '@littlecycling/shared';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useGameStore } from '@/stores/gameStore';
import {
  buildCumulativeDistances,
  interpolateAlongRoute,
  totalRouteDistance,
  type InterpolatedPosition,
} from '@/game/route-geometry';

/** Tuning constant: sqrt(watts) * SPEED_FACTOR = km/h */
const SPEED_FACTOR = 1.5;

export function useBallEngine(routePoints: Ref<RoutePoint[]>) {
  const sensorStore = useSensorStore();
  const settingsStore = useSettingsStore();
  const gameStore = useGameStore();

  const distanceTraveled = ref(0);
  const steeringAngle = ref(0);
  const currentPosition = ref<InterpolatedPosition>({
    lat: 0,
    lon: 0,
    ele: 0,
    bearing: 0,
  });
  const speedKmh = ref(0);

  // Pre-computed route data (exposed for coin spawner)
  const cumulativeDistsRef = shallowRef<number[]>([]);
  let cumulativeDists: number[] = [];
  let totalDist = 0;
  let estimator: VirtualPowerEstimator | null = null;

  const isReady = computed(() => routePoints.value.length > 0);

  function initialize() {
    const pts = routePoints.value;
    if (pts.length === 0) return;

    cumulativeDists = buildCumulativeDistances(pts);
    cumulativeDistsRef.value = cumulativeDists;
    totalDist = totalRouteDistance(pts);
    estimator = new VirtualPowerEstimator({
      trainerModel: settingsStore.config.sensor.trainerModel,
    });
    distanceTraveled.value = 0;
    currentPosition.value = interpolateAlongRoute(pts, cumulativeDists, 0);
  }

  function tick(dtMs: number) {
    const pts = routePoints.value;
    if (pts.length === 0 || totalDist === 0) return;

    // Determine watts
    let watts = 0;
    if (sensorStore.pwr) {
      watts = sensorStore.pwr.power;
    } else if (sensorStore.sc && estimator) {
      watts = estimator.estimate(sensorStore.sc.speed);
    }

    // Convert watts to game speed
    const speed = watts > 0 ? Math.sqrt(watts) * SPEED_FACTOR : 0;
    speedKmh.value = speed;

    // Advance distance
    const deltaDist = speed * (dtMs / 3600000) * 1000; // km/h → m
    distanceTraveled.value += deltaDist;

    // Lap detection
    if (distanceTraveled.value >= totalDist) {
      distanceTraveled.value -= totalDist;
      gameStore.addLap();
    }

    // Interpolate position
    const pos = interpolateAlongRoute(pts, cumulativeDists, distanceTraveled.value);

    // Free roam steering offset
    if (gameStore.freeRoam && sensorStore.pwr && isDualSidedPower(sensorStore.pwr)) {
      const angle = calcSteeringAngle(sensorStore.pwr);
      steeringAngle.value = angle;
      const offsetM = Math.tan((angle * Math.PI) / 180) * deltaDist;
      const bearingRad = ((pos.bearing + 90) * Math.PI) / 180;
      pos.lat += (offsetM * Math.cos(bearingRad)) / 111320;
      pos.lon += (offsetM * Math.sin(bearingRad)) / (111320 * Math.cos((pos.lat * Math.PI) / 180));
    } else {
      steeringAngle.value = 0;
    }

    currentPosition.value = pos;
  }

  function reset() {
    distanceTraveled.value = 0;
    speedKmh.value = 0;
    steeringAngle.value = 0;
    if (routePoints.value.length > 0 && cumulativeDists.length > 0) {
      currentPosition.value = interpolateAlongRoute(routePoints.value, cumulativeDists, 0);
    }
  }

  return {
    distanceTraveled,
    currentPosition,
    speedKmh,
    steeringAngle,
    isReady,
    cumulativeDistsRef,
    initialize,
    tick,
    reset,
  };
}
