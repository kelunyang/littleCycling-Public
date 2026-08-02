/**
 * Roadside lamps along the route — cuphead: pencil lamps whose sharpened tip
 * glows; plastic: brick lamps with a translucent yellow head.
 *
 * A small recycled pool (not one lamp per chunk): the manager keeps ~10 lamps
 * alive and slides them along the route as the rider advances, so the cost is
 * constant regardless of route length. Lamps alternate sides of the road and
 * light up with the day/night factor from `sky-and-fog`.
 *
 * The pool is addressed BY SLOT, not by its own array order — see
 * `poolIndexFor`. Everything a rider can see about a lamp (where it stands,
 * which side it is on, what colour it is, which way it faces) is then a pure
 * function of its place on the route, which is what the demos give and what a
 * lamp that stops being one looks like: a light that changes colour as you
 * ride up to it.
 *
 * This module also owns the night of the lamps that are NOT on the road — the
 * one a sports field or a playground stands on its own edge. Same part, same
 * night, one implementation (§3.10). See the `fixedLamps` block below.
 */

import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import type { StreetLampParts, TerrainStyleStrategy } from './terrain-style-strategy';

/** Metres between lamps on an ordinary road. */
const SPACING = 70;

/**
 * Metres between lamps in a tunnel. We do not model the bore itself — instead a
 * tunnel announces itself the way a real one does: a dense row of lamps, lit
 * even at noon.
 */
const TUNNEL_SPACING = 18;

/** How far the lamp stands from the route centreline. */
const LATERAL_OFFSET = 7;

/** Pool size on an ordinary road — covers ~80 m behind to ~550 m ahead. */
const POOL_SIZE = 10;

/** Pool size in a tunnel — dense, so more lamps for a shorter span (~280 m). */
const TUNNEL_POOL_SIZE = 20;

/**
 * Default number of lamps carrying a real PointLight at once. Every live point
 * light adds a loop iteration to every lit fragment, so a tunnel's 20 lamps do
 * NOT all get one: the nearest few light the road, the rest just glow. Nobody
 * can tell. The quality tier overrides this via setLightBudget.
 *
 * ⚠ A budget of 0 is technically allowed and was once the `low` preset's value.
 * It is not a cheaper night — it is a DIFFERENT one. The demos light every
 * lamp, and with none lit the only things left illuminating the world are
 * ambient 0.18 and the moon; the frame reads as black. `check:3d` now holds
 * every tier above zero. Reduce the count if you must; do not zero it.
 */
const MAX_LIVE_LIGHTS = 8;

/** Lamps behind the rider still visible in the chase view. */
const BEHIND_M = 80;

// ── Lamps that are NOT in the pool ──────────────────────────────────────────
//
// A sports field and a playground each stand ONE lamp on their own edge, and
// that lamp is what lights them after dark — the demos' `LU_STYLE.lamp`
// (`plan/*-town-demo.html`, the LANDUSE block). They are built by
// `landuse-renderer.ts`, live and die with their chunk, and never move.
//
// They are the SAME part as the pool's (`strategy.buildStreetLamp`), so
// CUSTOM_WORLD_INSTRUCTIONS §3.10's last rule applies: one kind of component,
// one implementation. That is why their night is driven from HERE rather than
// from a second registry of their own — the demo drives every bulb in the world
// off one `applyBulb(b, nightBlend)` loop, and so does this.
//
// ⚠ They take the RAW night factor, not the pool's `litFactor`: a tunnel lights
// the lamps inside it, not a pitch two kilometres away.
const fixedLamps = new Set<StreetLampParts>();
let fixedNight = 0;

/**
 * How many fixed lamps carry a real PointLight at once — same reasoning as
 * `MAX_LIVE_LIGHTS`, and a smaller number because these are extra lights ON TOP
 * of the pool's eight. Measured on the Dazhi route (render-probe, chunks 2-4):
 * 2 pitches inside the lamp corridor. That is comfortably under the cap — but
 * the count is a property of the ROUTE, not of the world, and a route running
 * along the edge of a sports park would hand every one of them a point light
 * without this. The ones over the cap still read as lamps: their heads glow
 * (§3.10), which is the same trade the tunnel's dense row makes.
 */
const MAX_FIXED_LIGHTS = 4;

/**
 * Adopt a lamp that is not in the pool. Takes the current night immediately, so
 * a chunk that streams in at midnight does not show a dark lamp until the next
 * frame's write lands.
 */
export function registerFixedLamp(parts: StreetLampParts): void {
  fixedLamps.add(parts);
  parts.setNight(fixedNight);
  // Off until the budget pass below picks it — see MAX_FIXED_LIGHTS.
  parts.setLightEnabled(false);
}

/** Drop a lamp whose chunk was recycled. Callers dispose the parts themselves. */
export function unregisterFixedLamp(parts: StreetLampParts): void {
  fixedLamps.delete(parts);
}

/** How many fixed lamps are alive — the census/probe number, not a knob. */
export function fixedLampCount(): number {
  return fixedLamps.size;
}

/**
 * The one write that lights every non-pool lamp, plus the point-light budget.
 *
 * `riderX`/`riderZ` are scene metres; when they are given the budget goes to
 * the lamps NEAREST the rider (the pool's rule, for the same reason: a light
 * burning behind you lights nothing you can see). Without them the first
 * `MAX_FIXED_LIGHTS` in registration order keep theirs.
 */
export function setFixedLampNight(k: number, riderX?: number, riderZ?: number): void {
  if (fixedLamps.size === 0) { fixedNight = k; return; }
  // Same 0.005 epsilon the pool uses: `setNight` rewrites three or four colours
  // per lamp and the night factor barely moves between frames. A lamp that
  // registers in between still gets the current value — `registerFixedLamp`
  // hands it over on the way in.
  if (Math.abs(k - fixedNight) > 0.005) {
    fixedNight = k;
    for (const parts of fixedLamps) parts.setNight(k);
  }

  if (fixedLamps.size <= MAX_FIXED_LIGHTS) {
    for (const parts of fixedLamps) parts.setLightEnabled(true);
    return;
  }
  const ordered = [...fixedLamps];
  if (riderX !== undefined && riderZ !== undefined) {
    // ⚠ WORLD position, not `group.position`. A fixed lamp hangs off its
    // layer's slab mesh, whose geometry carries absolute local metres and whose
    // `position` is what the floating-origin rebase moves — so the group's own
    // position is in the PRE-rebase frame and the rider's is not. Comparing the
    // two directly picks the wrong four lamps the moment the origin shifts.
    const d2 = new Map<StreetLampParts, number>();
    for (const parts of ordered) {
      parts.group.getWorldPosition(scratchWorld);
      d2.set(parts, (scratchWorld.x - riderX) ** 2 + (scratchWorld.z - riderZ) ** 2);
    }
    ordered.sort((a, b) => d2.get(a)! - d2.get(b)!);
  }
  for (let i = 0; i < ordered.length; i++) ordered[i].setLightEnabled(i < MAX_FIXED_LIGHTS);
}

/** One scratch vector for the budget pass — not one per lamp per frame. */
const scratchWorld = new THREE.Vector3();

interface PooledLamp {
  parts: StreetLampParts;
  /** Route distance this lamp currently sits at (-1 = unplaced). */
  distanceM: number;
  /** Whether its PointLight is currently switched on. */
  lightOn: boolean;
  /** Claimed by a slot in this frame's window (see update). */
  claimed: boolean;
}

export class StreetLampManager {
  private readonly scene: THREE.Scene;
  private readonly points: RoutePoint[];
  private readonly cumulativeDistances: number[];
  private readonly originLat: number;
  private readonly originLon: number;
  private readonly cosLat: number;
  private readonly totalDistance: number;

  private lamps: PooledLamp[] = [];
  private nightFactor = 0;
  /** Quality-tier cap on simultaneously-lit lamps (see setLightBudget). */
  private maxLiveLights = MAX_LIVE_LIGHTS;

  constructor(
    scene: THREE.Scene,
    strategy: TerrainStyleStrategy,
    points: RoutePoint[],
    cumulativeDistances: number[],
    originLat: number,
    originLon: number,
  ) {
    this.scene = scene;
    this.points = points;
    this.cumulativeDistances = cumulativeDistances;
    this.originLat = originLat;
    this.originLon = originLon;
    this.cosLat = Math.cos((originLat * Math.PI) / 180);
    this.totalDistance = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
    this.build(strategy);
  }

  /** Rebuild every lamp for a new style (world-style switch). */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.disposeLamps();
    this.build(strategy);
  }

  /**
   * Quality-tier hook: cap how many lamps carry a real PointLight. `n === 0`
   * means no lamp ever enables its PointLight — they keep only their emissive
   * glow. Applies from the next update(), which re-picks the lit set (the n
   * lamps nearest the rider) from scratch.
   */
  setLightBudget(n: number): void {
    this.maxLiveLights = Math.max(0, n);
  }

  private build(strategy: TerrainStyleStrategy): void {
    // Always allocate for the worst case (a tunnel). Growing the pool on tunnel
    // entry would build 10 lamps mid-ride — a hitch exactly where the rider is
    // looking. On an ordinary road the spares just stay invisible, and an
    // invisible group's light is skipped by the renderer.
    //
    // The build index is what a style varies its colour by, and `poolIndexFor`
    // is what decides which slot gets which entry — those two together are the
    // lamp's colour. Read that function before changing this loop.
    for (let i = 0; i < TUNNEL_POOL_SIZE; i++) {
      const parts = strategy.buildStreetLamp(i);
      parts.group.visible = false;
      parts.setNight(this.nightFactor);
      this.scene.add(parts.group);
      this.lamps.push({ parts, distanceM: -1, lightOn: true, claimed: false });
    }
  }

  /**
   * Which pool entry stands at a route slot. **Addressed by slot, not by the
   * pool's own array order** — that difference is a bug users reported from the
   * saddle: 「路燈會在騎乘中突然變色」.
   *
   * A style varies its lamp colour by the index it was BUILT with
   * (`BUBBLE_COLS[index % 4]`, `HL_INKS[index % 3]`, `LED_COLORS[index % 4]`),
   * so a pool entry's colour is fixed for the life of the pool. The window of
   * slots, meanwhile, slides: every `spacing` metres ridden, `firstIndex` goes
   * up by one. Hand out entries in array order and the lamp standing at a fixed
   * spot on the road becomes a DIFFERENT entry every 70 m — same place, new
   * colour, right in front of the rider. (The demos never hit this: they build
   * a lamp per chunk with `lamp(idx + i)`, an index that IS the lamp's place on
   * the route, and a chunk is built once.)
   *
   * Modulo the pool size, slot s always maps to the same entry, so colour is a
   * pure function of position again — and it stays that way for the whole ride,
   * not just for the pool's first pass.
   *
   * Two properties this relies on, both held by `check:3d`:
   *  - the window is never longer than the pool (10 or 20 slots into 20
   *    entries), so no two visible lamps can land on the same entry;
   *  - the pool size is EVEN, so entry parity follows slot parity — which keeps
   *    the colour on the same side of the road as `place()` puts it, the way
   *    the demos' single `idx + i` decides both.
   */
  private poolIndexFor(slot: number): number {
    const n = this.lamps.length;
    return ((slot % n) + n) % n;
  }

  /**
   * Slide the pool to cover the road around the rider.
   *
   * @param riderDistanceM  Distance travelled along the route.
   * @param nightFactor  0 = day, 1 = night (bulbs on).
   * @param raycastGround  Terrain height probe; lamps fall back to route
   *                       elevation when the chunk under them isn't loaded.
   * @param inTunnel  Tunnel zone: lamps go dense AND stay lit in daylight — a
   *                  tunnel is lit by its lamps, which is the whole point.
   */
  update(
    riderDistanceM: number,
    nightFactor: number,
    raycastGround?: (x: number, z: number) => number | null | undefined,
    inTunnel = false,
  ): void {
    if (this.points.length < 2 || this.totalDistance <= 0) return;

    const spacing = inTunnel ? TUNNEL_SPACING : SPACING;
    // Never wider than the pool: the window must map to distinct entries (see
    // poolIndexFor), and a window longer than the pool would put two lamps on
    // one group.
    const activeCount = Math.min(inTunnel ? TUNNEL_POOL_SIZE : POOL_SIZE, this.lamps.length);
    // Inside, the lamps ARE the daylight.
    const litFactor = inTunnel ? 1 : nightFactor;

    if (Math.abs(litFactor - this.nightFactor) > 0.005) {
      this.nightFactor = litFactor;
      for (const lamp of this.lamps) lamp.parts.setNight(litFactor);
    }

    // The lamps that are NOT in this pool — one per sports field, one per
    // playground. Driven from here because they are the same part and must take
    // the same night (see the `fixedLamps` block at the top of this file); this
    // is the one per-frame call in the app that already carries it. `nightFactor`,
    // NOT `litFactor` — a tunnel does not light a pitch outside it.
    if (fixedLamps.size > 0) {
      const at = this.interpolate(riderDistanceM);
      if (at) {
        setFixedLampNight(
          nightFactor,
          (at.lon - this.originLon) * 111320 * this.cosLat,
          -(at.lat - this.originLat) * 111320,
        );
      } else setFixedLampNight(nightFactor);
    }

    // First lamp slot at or behind (rider − BEHIND_M), snapped to the grid so a
    // lamp keeps its identity — its place, its side of the road AND its colour
    // — as the rider passes.
    const firstIndex = Math.floor((riderDistanceM - BEHIND_M) / spacing);

    // Which slots in the window carry a real PointLight: the `maxLiveLights`
    // NEAREST THE RIDER. This used to be the window's first few entries, and
    // the window starts BEHIND_M behind — so the `low` tier's three lights all
    // burned behind the rider, and a tunnel lit its entrance instead of the
    // road ahead. Slot offsets sit on a uniform grid, so the nearest-k set is
    // the contiguous run of k centred as closely as possible on the rider.
    const riderOffset = riderDistanceM / spacing - firstIndex;
    const budget = Math.min(this.maxLiveLights, activeCount);
    const litFrom = Math.max(0, Math.min(activeCount - budget,
      Math.round(riderOffset - (budget - 1) / 2)));

    for (const lamp of this.lamps) lamp.claimed = false;

    for (let i = 0; i < activeCount; i++) {
      const slot = firstIndex + i;
      const lamp = this.lamps[this.poolIndexFor(slot)];
      lamp.claimed = true;
      const distanceM = slot * spacing;

      const wantLight = i >= litFrom && i < litFrom + budget;
      if (lamp.lightOn !== wantLight) {
        lamp.parts.setLightEnabled(wantLight);
        lamp.lightOn = wantLight;
      }

      if (distanceM < 0 || distanceM > this.totalDistance) {
        lamp.parts.group.visible = false;
        lamp.distanceM = -1;
        continue;
      }
      if (lamp.distanceM === distanceM && lamp.parts.group.visible) continue;

      const placed = this.place(lamp, slot, distanceM, raycastGround);
      lamp.parts.group.visible = placed;
      lamp.distanceM = placed ? distanceM : -1;
    }

    // Park whatever the window did not claim. Which entries those are moves as
    // the window slides (they are not a suffix of the array any more), so this
    // cannot be folded back into the loop above.
    for (const lamp of this.lamps) {
      if (lamp.claimed || !lamp.parts.group.visible) continue;
      lamp.parts.group.visible = false;
      lamp.distanceM = -1;
    }
  }

  /** Position one lamp at a route distance, on the side its slot parity says. */
  private place(
    lamp: PooledLamp,
    slot: number,
    distanceM: number,
    raycastGround?: (x: number, z: number) => number | null | undefined,
  ): boolean {
    const pt = this.interpolate(distanceM);
    if (!pt) return false;

    const x = (pt.lon - this.originLon) * 111320 * this.cosLat;
    const z = -(pt.lat - this.originLat) * 111320;

    // Left/right of the tangent, alternating slot by slot.
    const side = slot % 2 === 0 ? 1 : -1;
    const lx = x - pt.tz * LATERAL_OFFSET * side;
    const lz = z + pt.tx * LATERAL_OFFSET * side;

    const ground = raycastGround?.(lx, lz);
    const y = ground ?? pt.y;

    lamp.parts.group.position.set(lx, y, lz);
    // Face the road (lamp heads are symmetric, but the pencil's flat sides read
    // better when aligned to the tangent).
    lamp.parts.group.rotation.y = Math.atan2(pt.tx, -pt.tz);
    return true;
  }

  /**
   * Route point + unit tangent at a distance, in scene metres. `y` is the GPX
   * elevation relative to origin — only used until terrain is raycastable.
   */
  private interpolate(
    distanceM: number,
  ): { lon: number; lat: number; y: number; tx: number; tz: number } | null {
    const cum = this.cumulativeDistances;
    let i = 1;
    while (i < cum.length && cum[i] < distanceM) i++;
    if (i >= cum.length) i = cum.length - 1;
    if (i < 1) return null;

    const a = this.points[i - 1];
    const b = this.points[i];
    const segLen = cum[i] - cum[i - 1];
    const t = segLen > 0 ? (distanceM - cum[i - 1]) / segLen : 0;

    const lon = a.lon + (b.lon - a.lon) * t;
    const lat = a.lat + (b.lat - a.lat) * t;

    // Tangent in scene coordinates (x = east, z = −north).
    let tx = (b.lon - a.lon) * this.cosLat;
    let tz = -(b.lat - a.lat);
    const len = Math.hypot(tx, tz);
    if (len < 1e-12) return null;
    tx /= len;
    tz /= len;

    // Elevation is origin-relative; the caller's raycast overrides it once the
    // chunk is loaded, so an approximate GPX height is enough here.
    const y = a.ele + (b.ele - a.ele) * t - this.points[0].ele;

    return { lon, lat, y, tx, tz };
  }

  private disposeLamps(): void {
    for (const lamp of this.lamps) {
      this.scene.remove(lamp.parts.group);
      lamp.parts.dispose();
    }
    this.lamps = [];
  }

  dispose(): void {
    this.disposeLamps();
  }
}
