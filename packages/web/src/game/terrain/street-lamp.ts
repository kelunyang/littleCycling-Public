/**
 * Roadside lamps along the route — cuphead: pencil lamps whose sharpened tip
 * glows; plastic: brick lamps with a translucent yellow head.
 *
 * A small recycled pool (not one lamp per chunk): the manager keeps ~10 lamps
 * alive and slides them along the route as the rider advances, so the cost is
 * constant regardless of route length. Lamps alternate sides of the road and
 * light up with the day/night factor from `sky-and-fog`.
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
 * How many lamps carry a real PointLight at once. Every live point light adds a
 * loop iteration to every lit fragment, so a tunnel's 20 lamps do NOT all get
 * one: the nearest few light the road, the rest just glow. Nobody can tell.
 */
const MAX_LIVE_LIGHTS = 8;

/** Lamps behind the rider still visible in the chase view. */
const BEHIND_M = 80;

interface PooledLamp {
  parts: StreetLampParts;
  /** Route distance this lamp currently sits at (-1 = unplaced). */
  distanceM: number;
  /** Whether its PointLight is currently switched on. */
  lightOn: boolean;
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

  private build(strategy: TerrainStyleStrategy): void {
    // Always allocate for the worst case (a tunnel). Growing the pool on tunnel
    // entry would build 10 lamps mid-ride — a hitch exactly where the rider is
    // looking. The spares just stay invisible, and an invisible group's light is
    // skipped by the renderer.
    for (let i = 0; i < TUNNEL_POOL_SIZE; i++) {
      const parts = strategy.buildStreetLamp();
      parts.group.visible = false;
      parts.setNight(this.nightFactor);
      this.scene.add(parts.group);
      this.lamps.push({ parts, distanceM: -1, lightOn: true });
    }
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
    const activeCount = inTunnel ? TUNNEL_POOL_SIZE : POOL_SIZE;
    // Inside, the lamps ARE the daylight.
    const litFactor = inTunnel ? 1 : nightFactor;

    if (Math.abs(litFactor - this.nightFactor) > 0.005) {
      this.nightFactor = litFactor;
      for (const lamp of this.lamps) lamp.parts.setNight(litFactor);
    }

    // First lamp slot at or behind (rider − BEHIND_M), snapped to the grid so a
    // lamp keeps its identity (and its side of the road) as the rider passes.
    const firstIndex = Math.floor((riderDistanceM - BEHIND_M) / spacing);

    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];

      // Spares beyond the active pool (ordinary road) stay parked.
      if (i >= activeCount) {
        if (lamp.parts.group.visible) {
          lamp.parts.group.visible = false;
          lamp.distanceM = -1;
        }
        continue;
      }

      const slot = firstIndex + i;
      const distanceM = slot * spacing;

      // Only the nearest few lamps carry a real point light (see MAX_LIVE_LIGHTS).
      const wantLight = i < MAX_LIVE_LIGHTS;
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
