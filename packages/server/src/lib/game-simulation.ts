/**
 * GameSimulation — server-authoritative game simulation.
 *
 * Owns every quantity the frontend previously integrated per-rAF-frame:
 * distance, position, laps, speed, steering, HR zone/combo, coin total.
 * Runs on a fixed-step wall-clock timer so the simulation is immune to the
 * client's GPU stalls, background tabs, and PiP throttling — the root cause
 * of the "56-minute ride recorded as 25 minutes" bug.
 *
 * Clock model (load-bearing):
 * - `elapsed` is `Date.now() - recordingStartTime` — the SAME wall clock the
 *   recorder stamps on WsSensorMessage frames and writes to the ride's
 *   durationMs. 方案甲: pause freezes physics, never the clock.
 * - Integration uses `dt = now - lastTick` per tick. Unlike the frontend's
 *   100ms rAF cap (which guarded against ball tunneling on stalled frames),
 *   dt here is only clamped at MAX_TICK_DT as a suspend guard: if the event
 *   loop stalls briefly, the rider kept riding, so the full interval must be
 *   integrated at last-known power — matching how accumSpeed integrates the
 *   FIT distance. Capping tighter would re-introduce distance shrinkage on
 *   the server, defeating the migration.
 * - NOTE for Phase 5: coin collision must be span-based
 *   (coin.routeDistanceM ∈ (prevDist, newDist]) rather than
 *   proximity-per-tick, so a large dt can never tunnel past a coin.
 *
 * Distance model (load-bearing):
 * - `cumulativeDistance` (monotonic meters) is THE authoritative accumulator
 *   and the only value clients interpolate. `laps`/`distanceTraveled` are
 *   derived from it; `totalDist` is cumulativeDistances[last] — the exact
 *   value interpolateAlongRoute clamps against (see shared/route-geometry).
 *
 * Composition: LiveSession owns one GameSimulation per recording and injects
 * a snapshot getter — the sim never touches sensor I/O directly.
 */

import type { CoinDto, GameEventDto, RandomEventDef, RoutePoint, WsGameStateMessage } from '@littlecycling/shared';
import {
  buildCumulativeDistances,
  interpolateAlongRoute,
  getHrZone,
  estimateVirtualSpeedFromPower,
  VirtualPowerEstimator,
  pickRandomEvent,
  COIN_TICK_INTERVAL,
  COIN_SPAWN_AHEAD_MIN,
  COIN_SPAWN_AHEAD_MAX,
  COIN_COLLECT_THRESHOLD,
  COIN_CLEANUP_BEHIND,
  COIN_SPACING,
  WIND_STORM_COIN_COUNT,
  TAILWIND_COMBO_MULTIPLIER,
  type HrZone,
} from '@littlecycling/shared';
import type { ServerWind } from './server-weather.js';
import type { WsRelay } from './ws-relay.js';
import type { LiveSensorSnapshot } from './live-session.js';

/** Broadcast/tick rate: 20Hz. */
const TICK_MS = 50;

/**
 * Suspend guard: a single tick never integrates more than this much time.
 * Generous on purpose — see the clock-model note above. Only a host suspend
 * (laptop sleep) should ever hit it.
 */
const MAX_TICK_DT = 5_000;

/**
 * Sensor staleness cutoff: with no sensor frame for this long, treat power
 * and wheel speed as zero instead of riding forever on the last-known watts.
 * (Deliberate fix over frontend parity — the old client sim kept the stale
 * value indefinitely.)
 */
const SENSOR_STALE_MS = 5_000;

/** Combo multiplier ceiling (ported from useCoinSystem). */
const MAX_COMBO = 5;

/** Full coin-set reconcile interval — self-heals delta loss and reconnects. */
const RECONCILE_INTERVAL_MS = 2_000;

/** Prune the spawned-slot dedup set when it grows past this (long rides). */
const SLOT_SET_PRUNE_SIZE = 4_096;

// ── Random-event tuning (ported verbatim from useRandomEvents) ──
const EVENT_INITIAL_DELAY_MS = 180_000; // first event after 3 min of ACTIVE play
const EVENT_COOLDOWN_MIN_MS = 90_000;
const EVENT_COOLDOWN_MAX_MS = 180_000;
const EVENT_END_GUARD_MS = 60_000;      // no events within 60s of game end (wall clock)
const EVENT_POWER_TOLERANCE = 0.10;
const EVENT_CADENCE_TOLERANCE = 0.15;
const EVENT_CHECK_INTERVAL_MS = 1_000;
const EVENT_RESULT_DISPLAY_MS = 3_000;
const EVENT_COOLDOWN_KEEP_MS = 300_000; // re-pick suppression window per event id

type EventState = 'idle' | 'active' | 'result' | 'cooldown';

export interface GameSimConfig {
  ftp: number;
  hrMax: number;
  /** Key into POWER_CURVES for speed→power estimation on power-less setups. */
  trainerModel: string;
  freeRoam: boolean;
  targetDurationMs: number;
  randomEventsEnabled: boolean;
  selectedWorkoutId: string;
}

/**
 * Ride summary produced by the sim at stopRecording time (P7) — the
 * server-authoritative replacement for the client's per-rAF-frame stats.
 * Averages are dt-weighted over ACTIVE (unpaused, not-ended) game time, so
 * frame rate, tab visibility, and pause length cannot skew them — the exact
 * failure mode that motivated the whole migration.
 */
export interface GameRideSummary {
  totalCoins: number;
  totalLaps: number;
  /** Monotonic game distance (m) — the sim's cumulativeDistance. Reported
   *  alongside (never instead of) the FIT `distanceM`, which stays integrated
   *  from sensor wheel speed; both anchor on `recordingStartTime`. */
  gameDistanceM: number;
  /** Time-weighted over hr>0 time; undefined when no HR was ever seen. */
  avgHr?: number;
  maxHr?: number;
  /** Time-weighted over all active time — coasting at 0W counts, exactly
   *  like the ride felt. */
  avgPowerW?: number;
  maxPowerW?: number;
  /** Time-weighted over cadence>0 time (matches the old client, which
   *  excluded zero-cadence frames). */
  avgCadence?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  /** % of hr>0 time spent in Z2/Z3 (one decimal, 0-100). */
  zoneSustainPct: number;
}

export interface GameSimulationOptions {
  routePoints: RoutePoint[];
  config: GameSimConfig;
  relay: WsRelay;
  /** Injected by LiveSession — live sensor snapshot (no I/O in the sim). */
  getSnapshot: () => LiveSensorSnapshot;
  /** Epoch ms of the last received sensor frame (staleness detection). */
  getLastDataAt: () => number;
  /** The single authoritative clock — recording start epoch ms. */
  recordingStartTime: number;
  /** Wall-clock source. Defaults to Date.now; injectable for tests. */
  now?: () => number;
  /** Base wind for the random-event wind gate. Defaults to calm. */
  getWind?: () => ServerWind;
}

export class GameSimulation {
  private readonly routePoints: RoutePoint[];
  private readonly config: GameSimConfig;
  private readonly relay: WsRelay;
  private readonly getSnapshot: () => LiveSensorSnapshot;
  private readonly getLastDataAt: () => number;
  private readonly recordingStartTime: number;
  private readonly now: () => number;
  private readonly getWind: () => ServerWind;

  private readonly cumulativeDists: number[];
  private readonly totalDist: number;
  private readonly estimator: VirtualPowerEstimator;

  // ── Authoritative state ──
  private cumulativeDistance = 0; // monotonic meters
  private laps = 0;
  private distanceTraveled = 0;   // wrapped, derived
  private speedKmh = 0;
  private steeringAngle = 0;
  private position: { lat: number; lon: number; ele: number; bearing: number };
  private currentZone: HrZone | null = null;
  private combo = 1;
  private prevZoneNum = -1;
  private coinsTotal = 0;

  // ── Coins (P5) — server-authoritative slot grid in CUMULATIVE space ──
  // The old frontend spawner worked in wrapped per-lap space and had to
  // clear everything at each lap boundary; monotonic cumulative distances
  // make coins naturally lap-aware (each lap's slots are distinct indices)
  // and remove the boundary special case entirely.
  private nextCoinId = 1;
  /** Active coins keyed by id; `cum` is the collision axis. */
  private activeCoins = new Map<number, { cum: number; dto: CoinDto }>();
  /** Slot-grid dedup: `${spacing}:${slotIndex}` over cumulative distance. */
  private spawnedSlots = new Set<string>();
  // Per-tick delta accumulators, drained into the next broadcast.
  private pendingSpawned: CoinDto[] = [];
  private pendingCollected: { id: number; combo: number }[] = [];
  private pendingRemoved: number[] = [];
  private reconcileAccumMs = 0;
  private reconcileNow = false;

  // ── Random events (P6) — ported from useRandomEvents ──
  // Driven by `gameTimeMs`: active-play time that FREEZES on pause/end
  // (deliberate fix — the old client watcher ran on wall-clock elapsed and
  // fired events mid-pause). Game-end guard still uses wall clock, since the
  // ride ends on wall-clock elapsed regardless of pauses.
  private gameTimeMs = 0;
  private eventState: EventState = 'idle';
  private activeEvent: RandomEventDef | null = null;
  private eventStartGameMs = 0;
  private eventElapsedMs = 0;
  private timeOnTargetMs = 0;
  private eventSuccess = false;
  private nextTriggerMs = EVENT_INITIAL_DELAY_MS;
  private resultEndsAtMs = 0;
  private lastEventCheckMs = 0;
  private eventCooldownMap = new Map<string, number>();
  /** Snapshot cadence at the current tick — read by the on-target check. */
  private lastCadence = 0;
  /** Effective watts at the current tick (staleness-adjusted, virtual when
   *  power-less) — read by the on-target check and the stats accumulator. */
  private lastWatts = 0;
  /** Provenance of lastWatts — reflects the sensor setup (a rig with a real
   *  PWR sensor stays 'meter' even through a stale tick, so the UI badge
   *  doesn't flicker). Broadcast as game_state.powerSource. */
  private lastPowerSource: 'meter' | 'estimated' = 'estimated';

  // ── Ride-stat accumulators (P7) — dt-weighted, ACTIVE time only ──
  // The old client sampled once per rAF frame, so a 10fps background tab
  // contributed 6× fewer samples per second than a 60fps foreground one and
  // averages drifted with render performance. Weighting by the sim's dt makes
  // every active second count equally regardless of anything client-side.
  private statActiveMs = 0;   // Σ dt while !paused && !ended
  private hrTimeMs = 0;       // Σ dt while hr > 0
  private hrWeightedSum = 0;  // Σ hr·dt
  private statMaxHr = 0;
  private powerWeightedSum = 0; // Σ watts·dt (zeros included — see summary)
  private statMaxPower = 0;
  private cadenceTimeMs = 0;  // Σ dt while cadence > 0
  private cadenceWeightedSum = 0;
  private speedWeightedSum = 0;
  private statMaxSpeed = 0;
  private zoneSustainMs = 0;  // hr>0 time spent in Z2/Z3

  // Pause: sim starts paused at the "start prompt"; the first non-zero
  // power/cadence signal auto-starts it (the client-side auto-start rule,
  // moved server-side — the server sees the same sensor stream). After the
  // first unpause, only explicit setPaused() calls change it.
  //
  // clientControlled: once ANY explicit setPaused() arrives, a client is
  // alive and managing pause state, so server-side auto-start is disabled.
  // Without this gate, a sensor source that streams from second zero
  // (--replay, --mock, a trainer already spinning) auto-started the sim
  // while the client was still loading terrain at its start prompt — the
  // ball rode off alone, collecting coins the player could only hear.
  // A sim that never receives setPaused() (headless run, pause POST lost)
  // keeps the auto-start self-heal.
  private paused = true;
  private hasStarted = false;
  private clientControlled = false;
  private ended = false;

  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private comboAccumMs = 0;

  constructor(opts: GameSimulationOptions) {
    this.routePoints = opts.routePoints;
    this.config = opts.config;
    this.relay = opts.relay;
    this.getSnapshot = opts.getSnapshot;
    this.getLastDataAt = opts.getLastDataAt;
    this.recordingStartTime = opts.recordingStartTime;
    this.now = opts.now ?? Date.now;
    this.getWind = opts.getWind ?? (() => ({ baseSpeedKmh: 0, directionDeg: 0 }));

    this.cumulativeDists = buildCumulativeDistances(this.routePoints);
    // Always cumulativeDists[last], never an independent length — keeps lap
    // boundaries byte-aligned with interpolateAlongRoute's clamp.
    this.totalDist = this.cumulativeDists.length > 0
      ? this.cumulativeDists[this.cumulativeDists.length - 1]
      : 0;
    this.estimator = new VirtualPowerEstimator({ trainerModel: this.config.trainerModel });

    this.position = this.routePoints.length > 0
      ? interpolateAlongRoute(this.routePoints, this.cumulativeDists, 0)
      : { lat: 0, lon: 0, ele: 0, bearing: 0 };
  }

  // ── Lifecycle ──

  start(): void {
    if (this.timer) return;
    this.lastTickAt = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Run a single fixed step. Public for deterministic tests; the interval
   *  in start() calls it on a timer in production. */
  tickOnce(): void {
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Control ──

  /** Manual pause/resume (Space key → REST). Resume counts as "started". */
  setPaused(paused: boolean): void {
    if (this.ended) return;
    this.clientControlled = true;
    this.paused = paused;
    if (!paused) this.hasStarted = true;
  }

  /** Award coins (random events in P6; collisions credit via collideCoins). */
  addCoins(amount: number): void {
    this.coinsTotal += amount;
  }

  /**
   * Force a full coin reconcile on the next broadcast. Called when a WS
   * client (re)connects so it converges immediately instead of waiting out
   * the periodic interval.
   */
  requestReconcile(): void {
    this.reconcileNow = true;
  }

  // ── State access (P7 summary + tests) ──

  get state() {
    return {
      cumulativeDistance: this.cumulativeDistance,
      distanceTraveled: this.distanceTraveled,
      laps: this.laps,
      speedKmh: this.speedKmh,
      coinsTotal: this.coinsTotal,
      combo: this.combo,
      paused: this.paused,
      ended: this.ended,
      activeCoinCount: this.activeCoins.size,
      gameTimeMs: this.gameTimeMs,
      eventState: this.eventState,
      activeEventId: this.activeEvent?.id ?? null,
      eventSuccess: this.eventSuccess,
    };
  }

  /**
   * Server-authoritative ride summary (P7). Read by stopRecording AFTER
   * stop() — all fields are plain accumulator reads, so ordering vs the last
   * tick doesn't matter beyond one 50ms tick of slack.
   *
   * `undefined` means "this quantity was never observed" (no HR strap, never
   * unpaused, …) and maps to NULL in the DB, same as the sensor-frame
   * accumulators it replaces.
   */
  get summary(): GameRideSummary {
    return {
      totalCoins: this.coinsTotal,
      totalLaps: this.laps,
      gameDistanceM: this.cumulativeDistance,
      avgHr: this.hrTimeMs > 0 ? this.hrWeightedSum / this.hrTimeMs : undefined,
      maxHr: this.statMaxHr > 0 ? this.statMaxHr : undefined,
      avgPowerW: this.statActiveMs > 0 ? this.powerWeightedSum / this.statActiveMs : undefined,
      maxPowerW: this.statMaxPower > 0 ? this.statMaxPower : undefined,
      avgCadence: this.cadenceTimeMs > 0 ? this.cadenceWeightedSum / this.cadenceTimeMs : undefined,
      avgSpeed: this.statActiveMs > 0 ? this.speedWeightedSum / this.statActiveMs : undefined,
      maxSpeed: this.statMaxSpeed > 0 ? this.statMaxSpeed : undefined,
      zoneSustainPct: this.hrTimeMs > 0
        ? Math.round((this.zoneSustainMs / this.hrTimeMs) * 1000) / 10
        : 0,
    };
  }

  // ── Tick ──

  private tick(): void {
    const now = this.now();
    const dt = Math.min(now - this.lastTickAt, MAX_TICK_DT);
    this.lastTickAt = now;
    const elapsed = now - this.recordingStartTime;

    const snapshot = this.getSnapshot();
    const stale = now - this.getLastDataAt() > SENSOR_STALE_MS;

    // Auto-start: mirrors the frontend rule (first pedal stroke unpauses,
    // only before the game has ever started). Disabled as soon as a client
    // takes over pause control — see the clientControlled field note.
    if (this.paused && !this.hasStarted && !this.clientControlled && !stale) {
      const signal = Math.max(snapshot.power ?? 0, snapshot.cadence ?? 0);
      if (signal > 0) {
        this.paused = false;
        this.hasStarted = true;
      }
    }

    // Time up → freeze permanently, keep broadcasting until stopRecording.
    if (!this.ended && elapsed >= this.config.targetDurationMs) {
      this.ended = true;
    }

    if (!this.paused && !this.ended) {
      const prevCum = this.cumulativeDistance;
      this.lastCadence = stale ? 0 : (snapshot.cadence ?? 0);
      this.integrate(dt, snapshot, stale);

      // Summary stats accumulate on the same active-time clock as physics —
      // after integrate() so lastWatts/speedKmh reflect this tick.
      this.accumStats(dt, snapshot, stale);

      // Zone/combo advances on unpaused game time only, at the same cadence
      // as the old frontend coinTick interval. Coin spawning shares the
      // cadence (the old coinTick called both).
      this.comboAccumMs += dt;
      while (this.comboAccumMs >= COIN_TICK_INTERVAL) {
        this.comboAccumMs -= COIN_TICK_INTERVAL;
        this.zoneComboTick(snapshot, stale);
        this.spawnCoins();
      }

      // Span-based collision over (prevCum, cum] — immune to dt size, a
      // large tick can never tunnel past a coin (see clock-model note).
      this.collideCoins(prevCum);

      // Random-event state machine advances on the same frozen-on-pause
      // game time.
      this.tickEvents(dt, elapsed);
    }

    // Reconcile runs on wall time, not game time: a paused client that
    // reconnects still needs the full coin set to converge.
    this.reconcileAccumMs += dt;

    this.broadcast(now, elapsed);
  }

  /** Port of useBallEngine.tick — identical math, sim-owned clock. */
  private integrate(dtMs: number, snapshot: LiveSensorSnapshot, stale: boolean): void {
    if (this.routePoints.length === 0 || this.totalDist <= 0) return;

    // Watts: power meter wins; otherwise estimate from wheel speed via the
    // trainer power curve. Stale sensors read as zero (rider stopped or
    // sensor died — either way the ball must not coast forever).
    let watts = 0;
    if (!stale) {
      if (snapshot.power != null) {
        watts = snapshot.power;
      } else if (snapshot.speed != null) {
        watts = this.estimator.estimate(snapshot.speed);
      }
    }

    this.lastWatts = watts;
    // Source reflects the rig, not the tick: presence of a power reading in
    // the snapshot marks a real meter setup even when this tick is stale.
    if (snapshot.power != null) this.lastPowerSource = 'meter';

    const speed = estimateVirtualSpeedFromPower(watts);
    this.speedKmh = speed;

    const deltaDist = speed * (dtMs / 3_600_000) * 1000; // km/h → m
    this.cumulativeDistance += deltaDist;

    // Derive wrapped distance + laps from the monotonic accumulator.
    this.laps = Math.floor(this.cumulativeDistance / this.totalDist);
    this.distanceTraveled = this.cumulativeDistance - this.laps * this.totalDist;

    const pos = interpolateAlongRoute(this.routePoints, this.cumulativeDists, this.distanceTraveled);

    // Free-roam steering from dual-sided power balance (port of
    // useBallEngine:87-96 — per-tick visual offset, not accumulated).
    if (this.config.freeRoam && snapshot.leftPower != null && snapshot.rightPower != null) {
      const total = snapshot.leftPower + snapshot.rightPower;
      if (total > 0) {
        const leftRatio = snapshot.leftPower / total;
        this.steeringAngle = -((leftRatio - 0.5) * 2) * 30;
      } else {
        this.steeringAngle = 0;
      }
      const offsetM = Math.tan((this.steeringAngle * Math.PI) / 180) * deltaDist;
      const bearingRad = ((pos.bearing + 90) * Math.PI) / 180;
      pos.lat += (offsetM * Math.cos(bearingRad)) / 111320;
      pos.lon += (offsetM * Math.sin(bearingRad)) / (111320 * Math.cos((pos.lat * Math.PI) / 180));
    } else {
      this.steeringAngle = 0;
    }

    this.position = pos;
  }

  /** dt-weighted ride-stat accumulation (P7). Active time only — the caller
   *  gates on !paused && !ended, matching the old client stats, which froze
   *  during pause. */
  private accumStats(dtMs: number, snapshot: LiveSensorSnapshot, stale: boolean): void {
    this.statActiveMs += dtMs;

    this.powerWeightedSum += this.lastWatts * dtMs;
    if (this.lastWatts > this.statMaxPower) this.statMaxPower = this.lastWatts;

    this.speedWeightedSum += this.speedKmh * dtMs;
    if (this.speedKmh > this.statMaxSpeed) this.statMaxSpeed = this.speedKmh;

    const hr = stale ? 0 : (snapshot.hr ?? 0);
    if (hr > 0) {
      this.hrTimeMs += dtMs;
      this.hrWeightedSum += hr * dtMs;
      if (hr > this.statMaxHr) this.statMaxHr = hr;
      const zone = getHrZone(hr, this.config.hrMax);
      if (zone && (zone.zone === 2 || zone.zone === 3)) {
        this.zoneSustainMs += dtMs;
      }
    }

    if (this.lastCadence > 0) {
      this.cadenceTimeMs += dtMs;
      this.cadenceWeightedSum += this.lastCadence * dtMs;
    }
  }

  /** Port of useCoinSystem.tick — HR zone + combo state machine. */
  private zoneComboTick(snapshot: LiveSensorSnapshot, stale: boolean): void {
    const hr = stale ? undefined : snapshot.hr;

    if (hr == null || hr === 0) {
      this.currentZone = null;
      return;
    }

    const zone = getHrZone(hr, this.config.hrMax);
    this.currentZone = zone;

    // Z1/Z5: no coins, reset combo on zone change
    if (!zone || zone.coinsPerTick === 0) {
      if (zone && zone.zone !== this.prevZoneNum) {
        this.combo = 1;
      }
      this.prevZoneNum = zone?.zone ?? -1;
      return;
    }

    // Combo: same zone → increase, zone change → reset
    if (zone.zone === this.prevZoneNum) {
      this.combo = Math.min(this.combo + 1, MAX_COMBO);
    } else {
      this.combo = 1;
    }

    this.prevZoneNum = zone.zone;
  }

  /**
   * Port of useCoinSpawner.spawnBatch, re-based onto the cumulative-distance
   * slot grid. Same zone→spacing rules and spawn window; slot indices grow
   * monotonically with distance so each lap gets fresh slots (the wrapped
   * grid's per-lap clearAll is no longer needed).
   */
  private spawnCoins(): void {
    if (this.totalDist <= 0) return;
    const zone = this.currentZone;
    if (!zone) return;
    const spacing = COIN_SPACING[zone.zone];
    if (!spacing) return; // Z1 and Z5 don't spawn

    const windowMin = this.cumulativeDistance + COIN_SPAWN_AHEAD_MIN;
    const windowMax = this.cumulativeDistance + COIN_SPAWN_AHEAD_MAX;
    const startSlot = Math.ceil(windowMin / spacing);
    const endSlot = Math.floor(windowMax / spacing);

    for (let slot = startSlot; slot <= endSlot; slot++) {
      const key = `${spacing}:${slot}`;
      if (this.spawnedSlots.has(key)) continue;
      this.spawnedSlots.add(key);

      const cum = slot * spacing;
      const wrapped = cum % this.totalDist;
      const pos = interpolateAlongRoute(this.routePoints, this.cumulativeDists, wrapped);
      const dto: CoinDto = {
        id: this.nextCoinId++,
        routeDistanceM: wrapped,
        lat: pos.lat,
        lon: pos.lon,
        ele: pos.ele,
      };
      this.activeCoins.set(dto.id, { cum, dto });
      this.pendingSpawned.push(dto);
    }

    // The dedup set only ever grows; prune entries far behind the ball so a
    // multi-hour ride doesn't accumulate memory. (Key encodes its own
    // position: spacing * slotIndex.)
    if (this.spawnedSlots.size > SLOT_SET_PRUNE_SIZE) {
      const cutoff = this.cumulativeDistance - COIN_CLEANUP_BEHIND;
      for (const key of this.spawnedSlots) {
        const sep = key.indexOf(':');
        const slotCum = Number(key.slice(0, sep)) * Number(key.slice(sep + 1));
        if (slotCum < cutoff) this.spawnedSlots.delete(key);
      }
    }
  }

  /**
   * Collect coins inside (prevCum - threshold, cum + threshold]; drop coins
   * fallen behind the cleanup window. The ±threshold at both ends preserves
   * the old per-frame |diff| < 5m feel (a stationary ball still grabs a coin
   * within reach) while the span makes big ticks tunnel-proof.
   */
  private collideCoins(prevCum: number): void {
    // Tailwind event doubles pickup combo (port of the client tailwindBonus).
    // Bake the multiplier into the emitted combo so coinsTotal and the sum of
    // collected.combo stay equal (the wallet stays reconstructable).
    const mult =
      this.eventState === 'active' && this.activeEvent?.id === 'tailwind'
        ? TAILWIND_COMBO_MULTIPLIER
        : 1;
    for (const [id, coin] of this.activeCoins) {
      if (
        coin.cum <= this.cumulativeDistance + COIN_COLLECT_THRESHOLD &&
        coin.cum >= prevCum - COIN_COLLECT_THRESHOLD
      ) {
        const award = this.combo * mult;
        this.activeCoins.delete(id);
        this.coinsTotal += award;
        this.pendingCollected.push({ id, combo: award });
      } else if (coin.cum < this.cumulativeDistance - COIN_CLEANUP_BEHIND) {
        this.activeCoins.delete(id);
        this.pendingRemoved.push(id);
      }
    }
  }

  /**
   * Spawn a one-shot burst of coins ahead of the ball (30–150m), used at the
   * start of the wind-coin-storm event. They join the normal activeCoins map
   * (globally unique ids) and are collected by span collision like any coin —
   * the old client burst namespace is unnecessary now ids are server-owned.
   */
  private spawnCoinBurst(count: number): void {
    if (this.totalDist <= 0) return;
    const SPREAD_MIN = 30;
    const SPREAD_MAX = 150;
    for (let i = 0; i < count; i++) {
      const cum = this.cumulativeDistance + SPREAD_MIN + Math.random() * (SPREAD_MAX - SPREAD_MIN);
      const wrapped = cum % this.totalDist;
      const pos = interpolateAlongRoute(this.routePoints, this.cumulativeDists, wrapped);
      const dto: CoinDto = {
        id: this.nextCoinId++,
        routeDistanceM: wrapped,
        lat: pos.lat,
        lon: pos.lon,
        ele: pos.ele,
      };
      this.activeCoins.set(dto.id, { cum, dto });
      this.pendingSpawned.push(dto);
    }
  }

  // ── Random-event state machine (port of useRandomEvents) ──

  private tickEvents(dtMs: number, elapsedWall: number): void {
    // Freeride only, and only when random events are enabled.
    if (this.config.selectedWorkoutId !== 'none' || !this.config.randomEventsEnabled) return;

    this.gameTimeMs += dtMs; // active-play clock — frozen on pause/end

    if (this.eventState === 'active') {
      this.eventElapsedMs = this.gameTimeMs - this.eventStartGameMs;
      if (this.isEventOnTarget()) {
        this.timeOnTargetMs += Math.min(dtMs, 2000);
      }
      if (this.eventElapsedMs >= this.activeEvent!.durationMs) {
        this.endEvent();
      }
      return;
    }

    if (this.eventState === 'result') {
      if (this.gameTimeMs >= this.resultEndsAtMs) {
        this.activeEvent = null;
        this.eventState = 'cooldown';
        this.nextTriggerMs = this.gameTimeMs + randomBetween(EVENT_COOLDOWN_MIN_MS, EVENT_COOLDOWN_MAX_MS);
      }
      return;
    }

    // idle / cooldown: throttle the pick attempt to ~1s of game time.
    if (this.gameTimeMs - this.lastEventCheckMs < EVENT_CHECK_INTERVAL_MS) return;
    this.lastEventCheckMs = this.gameTimeMs;
    if (this.gameTimeMs < this.nextTriggerMs) return;

    // Don't start an event that can't finish before the game ends. The game
    // ends on WALL-clock elapsed, so guard against wall-clock remaining.
    const remaining = this.config.targetDurationMs - elapsedWall;
    if (remaining < EVENT_END_GUARD_MS) return;

    const event = pickRandomEvent(this.gameTimeMs, this.eventCooldownSet(), {
      windSpeedKmh: this.getWind().baseSpeedKmh,
    });
    if (!event) return;
    if (remaining < event.durationMs + EVENT_END_GUARD_MS) return;

    this.startEvent(event);
  }

  private startEvent(event: RandomEventDef): void {
    this.activeEvent = event;
    this.eventState = 'active';
    this.eventStartGameMs = this.gameTimeMs;
    this.eventElapsedMs = 0;
    this.timeOnTargetMs = 0;
    // wind-coin-storm scatters a coin burst at the start (now server-side).
    if (event.id === 'wind-coin-storm') {
      this.spawnCoinBurst(WIND_STORM_COIN_COUNT);
    }
    // Weather/darken/tint and start messages are PRESENTATION — the client
    // maps them from event.id. The server only owns state + coins.
  }

  private endEvent(): void {
    const ev = this.activeEvent!;
    const ratio = this.timeOnTargetMs / ev.durationMs;
    this.eventSuccess = ratio >= ev.successThreshold;
    this.eventState = 'result';
    if (this.eventSuccess) {
      this.addCoins(ev.coinReward);
    }
    this.eventCooldownMap.set(ev.id, this.gameTimeMs);
    this.resultEndsAtMs = this.gameTimeMs + EVENT_RESULT_DISPLAY_MS;
  }

  /**
   * On-target check. Power events compare the rider's EFFECTIVE WATTS
   * (`lastWatts` — power meter, or the trainer-curve estimate on power-less
   * setups; staleness-adjusted) against the FTP-derived target. This is a
   * deliberate fix over the old client, which fed virtual speed (km/h) in as
   * "currentPower" — making power events near-impossible to pass.
   */
  private isEventOnTarget(): boolean {
    const ev = this.activeEvent;
    if (!ev) return false;
    if (ev.targetCadence != null) {
      const t = ev.targetCadence;
      return Math.abs(this.lastCadence - t) <= t * EVENT_CADENCE_TOLERANCE;
    }
    const target = Math.round((ev.targetFtpPercent / 100) * this.config.ftp);
    if (target <= 0) return false;
    return Math.abs(this.lastWatts - target) <= target * EVENT_POWER_TOLERANCE;
  }

  private eventCooldownSet(): Set<string> {
    const set = new Set<string>();
    for (const [id, usedAt] of this.eventCooldownMap) {
      if (this.gameTimeMs - usedAt < EVENT_COOLDOWN_KEEP_MS) set.add(id);
    }
    return set;
  }

  private buildEventDto(): GameEventDto | undefined {
    if ((this.eventState !== 'active' && this.eventState !== 'result') || !this.activeEvent) {
      return undefined;
    }
    const ev = this.activeEvent;
    const dto: GameEventDto = {
      id: ev.id,
      state: this.eventState,
      elapsedMs: this.eventElapsedMs,
      durationMs: ev.durationMs,
      onTarget: this.eventState === 'active' ? this.isEventOnTarget() : false,
      targetWatts: Math.round((ev.targetFtpPercent / 100) * this.config.ftp),
    };
    if (this.eventState === 'result') dto.success = this.eventSuccess;
    return dto;
  }

  private broadcast(now: number, elapsed: number): void {
    const msg: WsGameStateMessage = {
      type: 'game_state',
      tsEpoch: now,
      elapsed,
      paused: this.paused,
      ended: this.ended,
      position: { ...this.position },
      cumulativeDistance: this.cumulativeDistance,
      distanceTraveled: this.distanceTraveled,
      laps: this.laps,
      speedKmh: this.speedKmh,
      powerW: this.lastWatts,
      powerSource: this.lastPowerSource,
      steeringAngle: this.steeringAngle,
      zone: this.currentZone?.zone ?? null,
      combo: this.combo,
      coinsTotal: this.coinsTotal,
    };

    const event = this.buildEventDto();
    if (event) msg.event = event;

    // Coin deltas (idempotent per id) + periodic/on-demand full reconcile.
    const dueReconcile = this.reconcileNow || this.reconcileAccumMs >= RECONCILE_INTERVAL_MS;
    if (
      dueReconcile ||
      this.pendingSpawned.length > 0 ||
      this.pendingCollected.length > 0 ||
      this.pendingRemoved.length > 0
    ) {
      msg.coins = {
        spawned: this.pendingSpawned,
        collected: this.pendingCollected,
        removed: this.pendingRemoved,
      };
      if (dueReconcile) {
        msg.coins.reconcile = [...this.activeCoins.values()].map((c) => c.dto);
        this.reconcileAccumMs = 0;
        this.reconcileNow = false;
      }
      this.pendingSpawned = [];
      this.pendingCollected = [];
      this.pendingRemoved = [];
    }

    this.relay.broadcast(msg);
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
