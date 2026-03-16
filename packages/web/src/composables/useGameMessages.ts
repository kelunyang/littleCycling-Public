/**
 * Game message queue composable.
 * Watches game events, manages a priority queue, and exposes the currently
 * visible message for GameBubble to display.
 *
 * Templates are preloaded from `/api/messages/batch-random` (LLM variants).
 * Falls back to GAME_MESSAGE_TYPES[typeId].baseTemplate when no DB variant exists.
 */

import { ref, watch, onUnmounted, type Ref, type ComputedRef } from 'vue';
import {
  GAME_MESSAGE_TYPES,
  fillTemplate,
  type GameMessageType,
  type HrZone,
  type WorkoutSegment,
} from '@littlecycling/shared';

export interface GameMessage {
  id: number;
  text: string;
  icon: string;
  color: string;
  priority: number;
  durationMs: number;
}

export interface GameMessagesDeps {
  currentZone: Ref<HrZone | null>;
  redLine: Ref<boolean>;
  comboMultiplier: Ref<number>;
  coins: Ref<number>;
  segmentChanged: Ref<boolean>;
  currentSegment: ComputedRef<WorkoutSegment | null>;
  laps: Ref<number>;
  distanceTraveled: Ref<number>;
  speedKmh: Ref<number>;
  maxSpeed: Ref<number>;
  maxPower: Ref<number>;
  isOnTarget: Ref<boolean>;
  weatherType: Ref<string>;
}

const MAX_QUEUE = 3;
const COIN_DEBOUNCE_MS = 500;
const COOLDOWN_RECORD_MS = 30_000;
const COOLDOWN_ON_TARGET_MS = 300_000;
const ON_TARGET_SUSTAIN_MS = 120_000;
const ZONE1_IDLE_MS = 120_000;
const HIGH_HR_MS = 300_000;

// Weather type → Chinese description
const WEATHER_DESCRIPTIONS: Record<string, string> = {
  sunny: '天氣放晴',
  cloudy: '天色轉陰',
  rainy: '開始下雨了',
  snowy: '開始下雪了',
};

export function useGameMessages(deps: GameMessagesDeps) {
  const currentMessage = ref<GameMessage | null>(null);

  let nextId = 1;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: GameMessage[] = [];

  // Preloaded templates from DB (typeId → template string)
  const variantMap = new Map<string, string>();
  let preloaded = false;

  // ── Preload variants from server ──

  async function preload(): Promise<void> {
    try {
      const res = await fetch('/api/messages/batch-random');
      if (res.ok) {
        const data = await res.json();
        const variants = data.variants as Record<string, string>;
        for (const [typeId, template] of Object.entries(variants)) {
          variantMap.set(typeId, template);
        }
      }
    } catch {
      // Silently fall back to base templates
    }
    preloaded = true;
  }

  // ── Core queue logic ──

  function getTemplate(typeId: string): string {
    return variantMap.get(typeId) ?? GAME_MESSAGE_TYPES[typeId]?.baseTemplate ?? typeId;
  }

  function buildMessage(
    type: GameMessageType,
    values?: Record<string, string | number>,
  ): GameMessage {
    const template = getTemplate(type.id);
    return {
      id: nextId++,
      text: fillTemplate(template, values ?? {}),
      icon: type.icon,
      color: type.color,
      priority: type.priority,
      durationMs: type.durationMs,
    };
  }

  function showMessage(msg: GameMessage): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    currentMessage.value = msg;
    // durationMs timer is started by GameBubble after typewriter finishes
    // via the onTypewriterDone callback. As fallback, set a max timeout.
    dismissTimer = setTimeout(() => dismiss(), msg.durationMs + 2000);
  }

  function dismiss(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    currentMessage.value = null;

    // Show next in queue
    if (queue.length > 0) {
      // Sort by priority descending
      queue.sort((a, b) => b.priority - a.priority);
      const next = queue.shift()!;
      showMessage(next);
    }
  }

  /** Called by GameBubble when typewriter animation finishes */
  function onTypewriterDone(durationMs: number): void {
    // Replace the fallback timer with the actual duration timer
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
    }
    dismissTimer = setTimeout(() => dismiss(), durationMs);
  }

  function pushMessage(typeId: string, values?: Record<string, string | number>): void {
    const type = GAME_MESSAGE_TYPES[typeId];
    if (!type) return;

    const msg = buildMessage(type, values);

    if (currentMessage.value === null) {
      showMessage(msg);
      return;
    }

    // Same or higher priority → replace immediately
    if (msg.priority >= currentMessage.value.priority) {
      showMessage(msg);
      return;
    }

    // Lower priority → queue (keep max size)
    if (queue.length >= MAX_QUEUE) {
      // Remove lowest priority in queue
      queue.sort((a, b) => b.priority - a.priority);
      queue.pop();
    }
    queue.push(msg);
  }

  // ── Event watchers ──

  let prevZoneNum = -1;
  let coinDelta = 0;
  let coinDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSpeedRecordAt = 0;
  let lastPowerRecordAt = 0;
  let lastOnTargetAt = 0;
  let onTargetStartMs: number | null = null;
  let zone1StartMs: number | null = null;
  let highHrStartMs: number | null = null;
  let prevWeather: string | null = null;
  let lastDistanceMilestone = 0;
  let prevMaxSpeed = 0;
  let prevMaxPower = 0;

  // Zone change
  watch(deps.currentZone, (zone) => {
    if (!zone || !preloaded) return;
    if (zone.zone === prevZoneNum) return;

    // Zone 5 → use zone5-warning, skip generic zone-change
    if (zone.zone === 5) {
      prevZoneNum = zone.zone;
      // zone5-warning is handled by redLine watcher
      return;
    }

    if (prevZoneNum !== -1) {
      pushMessage('zone-change', { zone: zone.zone });
    }
    prevZoneNum = zone.zone;
  });

  // Zone 5 redline
  watch(deps.redLine, (on) => {
    if (on && preloaded) {
      pushMessage('zone5-warning');
    }
  });

  // Coins (debounced)
  watch(deps.coins, (newVal, oldVal) => {
    if (!preloaded || oldVal === undefined) return;
    const delta = newVal - oldVal;
    if (delta <= 0) return;

    coinDelta += delta;
    if (coinDebounceTimer !== null) clearTimeout(coinDebounceTimer);
    coinDebounceTimer = setTimeout(() => {
      pushMessage('coin-collect', { amount: coinDelta });
      coinDelta = 0;
      coinDebounceTimer = null;
    }, COIN_DEBOUNCE_MS);
  });

  // Combo up
  watch(deps.comboMultiplier, (level, prev) => {
    if (!preloaded || prev === undefined) return;
    if (level > prev) {
      pushMessage('combo-up', { level });
    }
  });

  // Segment change
  watch(deps.segmentChanged, (changed) => {
    if (!changed || !preloaded) return;
    const seg = deps.currentSegment.value;
    if (seg) {
      pushMessage('segment-change', { name: seg.name });
    }
  });

  // Lap complete
  watch(deps.laps, (newLaps, oldLaps) => {
    if (!preloaded || oldLaps === undefined) return;
    if (newLaps > oldLaps) {
      pushMessage('lap-complete');
    }
  });

  // Weather change
  watch(deps.weatherType, (type) => {
    if (!preloaded) {
      prevWeather = type;
      return;
    }
    if (prevWeather !== null && type !== prevWeather) {
      const desc = WEATHER_DESCRIPTIONS[type] ?? type;
      pushMessage('weather-change', { description: desc });
    }
    prevWeather = type;
  });

  // Distance milestone (every 5km)
  watch(deps.distanceTraveled, (dist) => {
    if (!preloaded) return;
    const km = Math.floor(dist / 1000);
    const milestone = Math.floor(km / 5) * 5;
    if (milestone > 0 && milestone > lastDistanceMilestone) {
      lastDistanceMilestone = milestone;
      pushMessage('distance-milestone', { km: milestone });
    }
  });

  // Speed record (with cooldown)
  watch(deps.maxSpeed, (speed) => {
    if (!preloaded || speed <= 0) return;
    const now = Date.now();
    if (speed > prevMaxSpeed && prevMaxSpeed > 0 && now - lastSpeedRecordAt > COOLDOWN_RECORD_MS) {
      lastSpeedRecordAt = now;
      pushMessage('speed-record', { speed: Math.round(speed * 10) / 10 });
    }
    prevMaxSpeed = speed;
  });

  // Power record (with cooldown)
  watch(deps.maxPower, (power) => {
    if (!preloaded || power <= 0) return;
    const now = Date.now();
    if (power > prevMaxPower && prevMaxPower > 0 && now - lastPowerRecordAt > COOLDOWN_RECORD_MS) {
      lastPowerRecordAt = now;
      pushMessage('power-record', { power: Math.round(power) });
    }
    prevMaxPower = power;
  });

  // On-target sustained encouragement (120s sustained, 5min cooldown)
  watch(deps.isOnTarget, (on) => {
    if (!preloaded) return;
    if (on) {
      if (onTargetStartMs === null) onTargetStartMs = Date.now();
      const elapsed = Date.now() - onTargetStartMs;
      if (elapsed >= ON_TARGET_SUSTAIN_MS && Date.now() - lastOnTargetAt > COOLDOWN_ON_TARGET_MS) {
        lastOnTargetAt = Date.now();
        onTargetStartMs = null;
        pushMessage('on-target');
      }
    } else {
      onTargetStartMs = null;
    }
  });

  // Zone 1 idle warning (>120s, not warmup/recovery)
  watch(deps.currentZone, (zone) => {
    if (!preloaded) return;
    if (zone && zone.zone === 1) {
      if (zone1StartMs === null) zone1StartMs = Date.now();
      const elapsed = Date.now() - zone1StartMs;
      const seg = deps.currentSegment.value;
      const isRecovery = seg?.name?.toLowerCase().includes('warm') ||
                         seg?.name?.toLowerCase().includes('recovery') ||
                         seg?.name?.toLowerCase().includes('cool');
      if (elapsed >= ZONE1_IDLE_MS && !isRecovery) {
        pushMessage('zone1-idle');
        zone1StartMs = Date.now() + ZONE1_IDLE_MS; // Don't repeat immediately
      }
    } else {
      zone1StartMs = null;
    }
  });

  // High HR warning (zone ≥ 4 for >300s)
  watch(deps.currentZone, (zone) => {
    if (!preloaded) return;
    if (zone && zone.zone >= 4) {
      if (highHrStartMs === null) highHrStartMs = Date.now();
      const elapsed = Date.now() - highHrStartMs;
      if (elapsed >= HIGH_HR_MS) {
        pushMessage('high-hr-warning');
        highHrStartMs = Date.now() + HIGH_HR_MS; // Don't repeat immediately
      }
    } else {
      highHrStartMs = null;
    }
  });

  // Cleanup
  onUnmounted(() => {
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    if (coinDebounceTimer !== null) clearTimeout(coinDebounceTimer);
  });

  return {
    currentMessage,
    pushMessage,
    onTypewriterDone,
    preload,
  };
}
