/**
 * Land-use zoning — the single source of truth for BOTH renderers.
 *
 * The map already tells us what a district is FOR. `mvt-fetcher` pulls eleven
 * `landuse` classes (residential, commercial, retail, industrial, school,
 * hospital, university, college, kindergarten, library, education) and the game
 * has been throwing all of it away: `URBAN_COLORS` has four keys, `retail` and
 * `commercial` share one, and the other seven fall back to residential grey.
 * Recognised, fetched, projected into geometry — and then drawn identically.
 *
 * Buildings had it worse: buildings and zoning were two pipes that never met.
 * `buildBuildingMeshes` had no parameter with anything to do with land use, so
 * every style had exactly one building body and a hospital looked like a house.
 *
 * This module is the join. Deliberately free of any THREE / Phaser import (same
 * reason as `road-classes.ts`): the 2D renderer decodes MVT inside a Web Worker
 * and must be able to zone without dragging a 3D engine in behind it.
 */

/**
 * The five kinds DEVPLAN's zone→building table is written against. Eleven MVT
 * classes collapse into these — `retail` is commercially indistinguishable from
 * `commercial` at building scale, and the six education classes are all "a
 * school" as far as the model is concerned.
 */
export type ZoneKind = 'residential' | 'commercial' | 'industrial' | 'school' | 'hospital';

export const ZONE_KINDS: readonly ZoneKind[] = [
  'residential', 'commercial', 'industrial', 'school', 'hospital',
];

/**
 * MVT `landuse.class` → zone. Returns null for anything not urban land use, so
 * a caller can tell "outside every zone" from "inside a residential one" — the
 * two must not both mean residential, or a rural route silently becomes a
 * suburb.
 */
export function zoneFromLanduseClass(cls: string | undefined): ZoneKind | null {
  switch (cls) {
    case 'residential': return 'residential';
    case 'commercial':
    case 'retail': return 'commercial';
    case 'industrial': return 'industrial';
    case 'school':
    case 'university':
    case 'college':
    case 'kindergarten':
    case 'library':
    case 'education': return 'school';
    case 'hospital': return 'hospital';
    default: return null;
  }
}

/** Looks up the zone at a lon/lat. Null = outside every known zone. */
export type ZoneAtFn = (lon: number, lat: number) => ZoneKind | null;

/**
 * A Fisher–Yates shuffle bag: draws every entry once before any repeats.
 *
 * Use this, not independent random draws, wherever a run of choices has to stay
 * MIXED over distance. Independent draws skew badly at route scale — the demos
 * measured whole 8 km stretches coming out one single zone, which reads as a
 * bug even though each draw was fair. A bag cannot do that.
 *
 * `weights` repeats an entry that many times in the bag, so a zone can BIAS a
 * choice (80 % its signature building, 20 % a neighbour) without hard-mapping
 * it — a district where every building is identical does not look like a city.
 */
export function createShuffleBag<T>(
  items: readonly T[],
  rng: () => number,
  weights?: readonly number[],
): () => T {
  const pool: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const n = Math.max(1, Math.round(weights?.[i] ?? 1));
    for (let k = 0; k < n; k++) pool.push(items[i]);
  }
  let bag: T[] = [];
  return () => {
    if (bag.length === 0) {
      bag = pool.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop() as T;
  };
}

/**
 * Winding-number point-in-polygon. Handles self-touching rings, which the
 * even-odd crossing test gets wrong on exactly the shapes OSM produces most
 * (a landuse polygon with an inner courtyard traced back along its own edge).
 */
export function pointInRing(lon: number, lat: number, ring: readonly [number, number][]): boolean {
  let wind = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yj <= lat) {
      if (yi > lat && (xi - xj) * (lat - yj) - (lon - xj) * (yi - yj) > 0) wind++;
    } else if (yi <= lat && (xi - xj) * (lat - yj) - (lon - xj) * (yi - yj) < 0) {
      wind--;
    }
  }
  return wind !== 0;
}

/**
 * Spatial index from lon/lat to zone.
 *
 * ONE implementation, used by the chunk manager and by `render-probe`. The
 * probe is a mirror of the production chunk pipeline, and this repo has already
 * lost time to a mirror that drifted (`makeGroundFn` existed twice and the two
 * copies disagreed) — a probe that zones differently from the game would report
 * confident nonsense about art nobody has otherwise seen.
 *
 * Cells are ~110 m (0.001°), so a lookup is one map hit plus a handful of
 * point-in-polygon tests. Rings are stored by reference: the caller has already
 * decoded them for something else, and re-decoding MVT to zone would double the
 * cost of the single most expensive thing a dense chunk does.
 */
export class ZoneIndex {
  private static readonly CELL_DEG = 0.001;

  private readonly cells = new Map<number, {
    ring: readonly [number, number][];
    minLon: number; maxLon: number; minLat: number; maxLat: number;
    zone: ZoneKind;
  }[]>();

  private readonly seen = new Set<number>();

  private static key(lon: number, lat: number): number {
    const c = ZoneIndex.CELL_DEG;
    return (Math.floor(lon / c) + 200000) * 400000 + (Math.floor(lat / c) + 200000);
  }

  /**
   * Register one ring. Returns false if this ring was already registered — the
   * padded chunk windows overlap, so the same polygon arrives several times.
   */
  add(ring: readonly [number, number][], zone: ZoneKind): boolean {
    if (ring.length < 3) return false;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let cLon = 0, cLat = 0;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      cLon += lon;
      cLat += lat;
    }
    const seenKey = Math.round((cLon / ring.length) * 1e5) * 4e7
      + Math.round((cLat / ring.length) * 1e5) + 1;
    if (this.seen.has(seenKey)) return false;
    this.seen.add(seenKey);

    const entry = { ring, minLon, maxLon, minLat, maxLat, zone };
    const c = ZoneIndex.CELL_DEG;
    for (let gx = Math.floor(minLon / c); gx <= Math.floor(maxLon / c); gx++) {
      for (let gy = Math.floor(minLat / c); gy <= Math.floor(maxLat / c); gy++) {
        const key = (gx + 200000) * 400000 + (gy + 200000);
        let arr = this.cells.get(key);
        if (!arr) { arr = []; this.cells.set(key, arr); }
        arr.push(entry);
      }
    }
    return true;
  }

  /**
   * What kind of district is this point in? Null = outside every known zone,
   * which is NOT residential — see `zoneFromLanduseClass`.
   *
   * Overlapping polygons are the norm (a school sits inside a residential
   * block), so the MORE SPECIFIC zone wins: residential is the backdrop and
   * only wins uncontested.
   */
  zoneAt(lon: number, lat: number): ZoneKind | null {
    const arr = this.cells.get(ZoneIndex.key(lon, lat));
    if (!arr) return null;
    let best: ZoneKind | null = null;
    let bestRank = -1;
    for (const e of arr) {
      if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
      const rank = ZONE_SPECIFICITY[e.zone];
      if (rank <= bestRank) continue;
      if (!pointInRing(lon, lat, e.ring)) continue;
      best = e.zone;
      bestRank = rank;
    }
    return best;
  }

  /** How many distinct rings are indexed (diagnostics / probes). */
  get size(): number {
    return this.seen.size;
  }
}

/** Which zone wins where polygons overlap. */
const ZONE_SPECIFICITY: Record<ZoneKind, number> = {
  residential: 0,
  industrial: 1,
  commercial: 2,
  school: 3,
  hospital: 4,
};
