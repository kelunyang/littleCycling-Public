/**
 * Landuse renderer: builds flat polygon meshes for the ground cover the map
 * gives us — water, parks, forests, sand, urban zones, and (since the MVT survey
 * showed we were downloading and dropping them) wetland, farmland, and pitches.
 * Overlaid on terrain with slight height offsets to prevent z-fighting.
 *
 * ## The urban layer is the ZONE DECAL
 *
 * The demos lay a translucent zone-coloured wash over the ground so a rider can
 * see which district they are riding through (`zoneDecalMats` / `ZONE_DECAL_W`).
 * That layer is this one: `urban` has always been translucent (opacity 0.6,
 * polygon-offset onto the terrain) — what it lacked was the zone. It took ONE
 * dominant colour for the whole chunk, so a chunk that happened to be mostly
 * industrial painted its school, its hospital and its houses steel grey too.
 *
 * Now every polygon carries its own zone colour in a vertex attribute, and it is
 * still ONE mesh with ONE material. That is deliberate and it is the whole
 * design: a decal is a screen-covering translucent layer, the exact category
 * that makes gameview 7× more expensive per pixel than the demo
 * (plan/migrate-demo-worlds.md §5), so five zones had to cost zero extra layers,
 * zero extra draw calls and zero extra covered pixels. Same triangles, same
 * coverage, five colours instead of one.
 *
 * The trap the demos flag: a metric lift alone is not enough. 0.02 m separates
 * the decal from the ground beside the rider and z-fights into noise at
 * distance, which is what `applyOverlayDepth` (depth-buffer units, not metres)
 * is for. Both are applied here, as they always were.
 *
 * ## Two of these kinds get a LAMP, and it is the only night they have
 *
 * A sports field and a playground each stand one of this world's ordinary
 * street lamps on the edge facing the road, and that lamp is what lights them
 * after dark. Nothing here glows by itself: the pitch used to (its slab was
 * registered with `registerNightLitMaterial`) and a whole ground plane lighting
 * up reads as a SIGN — another component's identity (§3.3) and the exact
 * opposite of §3.10. See `LAMP_KINDS` and `patchSeed`.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { StreetLampParts, TerrainStyleStrategy } from './terrain-style-strategy';
import { zoneFromLanduseClass } from './land-zone';
import { applyOverlayDepth, type OverlayKind } from './overlay-depth';
import { createYielder, type MaybeYield } from './build-yield';
import { geoSeed } from './geo-seed';
import { isLandscapeWater } from './water-classes';
import { emptyMesh } from './empty-mesh';
import { registerFixedLamp, unregisterFixedLamp } from './street-lamp';

/** Height offsets above terrain to prevent z-fighting. Wetter/lower first. */
const WATER_HEIGHT_OFFSET = 0.1;
const WETLAND_HEIGHT_OFFSET = 0.09;
const PARK_HEIGHT_OFFSET = 0.05;
const FOREST_HEIGHT_OFFSET = 0.04;
const SPORTS_HEIGHT_OFFSET = 0.035;
/**
 * Playground — its own kind since 2026-07-28, wedged between the pitch and the
 * sand. The demos arbitrated the split (`plan/*-town-demo.html`, `LU_KINDS`):
 * a pitch is FLAT AND ONLY LINES, a playground is the one ground cover that gets
 * to STAND UP, and at the rider's eye height (6.3 m, grazing) silhouette is the
 * only signal that survives. Folding them together drew every playground as a
 * court plate.
 */
const PLAYGROUND_HEIGHT_OFFSET = 0.0345;
const SAND_HEIGHT_OFFSET = 0.03;
const FARMLAND_HEIGHT_OFFSET = 0.025;
const URBAN_HEIGHT_OFFSET = 0.02;

/** One ground-cover kind: its features, the mesh built from them. */
export interface LanduseLayer {
  kind: string;
  /** The merged flat slab. Standing props (if any) are its CHILDREN. */
  mesh: THREE.Mesh;
  count: number;
  /** How many patches grew standing props — measured, for the census. */
  props: number;
}

/** One polygon of ground cover, in LOCAL scene metres. Feeds `buildLanduseProps`. */
interface LandusePatch {
  centerX: number;
  centerZ: number;
  radius: number;
  /** Where the flat slab ended up (local metres, already floor-quantised). */
  slabY: number;
  /**
   * The SAME centroid in degrees. Carried alongside the local metres rather than
   * derived from them because it is the patch's IDENTITY (`patchSeed`), and an
   * identity that is reconstructed by inverting the origin transform is an
   * identity that quietly depends on the origin again.
   */
  centerLon: number;
  centerLat: number;
}

export interface LanduseRenderResult {
  /** Every overlay mesh, so callers never have to enumerate the kinds by hand. */
  layers: LanduseLayer[];
  /**
   * The lamps the sports fields and playgrounds stand (see `LAMP_KINDS`). Their
   * groups hang off the layer mesh so they rebase with it, but they are listed
   * here too because a lamp is freed by its OWN `dispose()`, not by the generic
   * traverse — see `disposeLanduseMeshes`.
   */
  lamps: StreetLampParts[];
}

/**
 * The two ground covers that get a lamp, and the ONLY two — the demos'
 * `if (kind === 'sports' || kind === 'playground')`, verbatim.
 *
 * The arbitration, in the user's words: 「球場亮起來很怪(變成一種招牌),給球場、
 * 遊樂場都配一個路燈吧,用路燈的燈去點亮他們」. The pitch used to light ITSELF
 * (`registerNightLitMaterial` on its own slab), and a whole ground plane glowing
 * reads as a SIGN, which is another component's identity (§3.3) and the exact
 * opposite of §3.10's "small, inside, wrapped in something translucent".
 *
 * Farmland, wetland and sand get nothing. "This thing has no light" is a
 * completely legal answer (§3.9) and it is the one the demos give.
 */
const LAMP_KINDS = new Set(['sports', 'playground']);

/**
 * How far off the route a patch may be and still get a lamp, in metres.
 *
 * **This is the demos' own number, not a new knob.** `luPatches` keeps a landuse
 * polygon only when `Math.abs(at.lat) <= boardW / 2 + info.r`, with
 * `boardW = 130` — so every patch a demo has at all is within 65 m + its own
 * radius of the road, and every one of those gets a lamp. gameview draws landuse
 * across the whole ±500 m chunk corridor, which is ~7.7× the area, and that
 * difference is the entire reason the rule does not survive a literal copy:
 *
 *   Dazhi chunk 2, measured — 150 sports + 21 playground polygons owned, 52 of
 *   them inside the corridor band the demo would have had. One lamp is 3 meshes
 *   and 2-3 fresh materials, so a literal copy took the plastic world from 152
 *   draw calls / 71 unique materials to **335 / 254** — the material count is
 *   3.6× the §6 budget of 70, on a metric §6 ranks above triangles.
 *
 * ⚠ This is the ONLY thing the port adds to the demos' rule, and it is applied
 * to the LAMP only: which polygons get a SLAB is gameview's corridor decision
 * and is left exactly as it was. A pitch 300 m off the road keeps its plate and
 * loses a 13 m lamp that nothing was ever going to see lit — the point-light
 * budget in `street-lamp.ts` only ever lights the four nearest anyway.
 */
const LAMP_CORRIDOR_HALF_M = 65;

/**
 * A patch's identity: its own position, quantised to 0.25 m and hashed. The
 * demos' expression, character for character (`buildLanduse` in
 * `plan/*-town-demo.html`) — see `geo-seed.ts`, which is where it now lives
 * because the shop signs need the same integer for the same reason.
 *
 * It feeds TWO things — the prop stream and the lamp — and that is deliberate:
 * the demo computes it once and passes the same integer to both, so a patch's
 * structures and its lamp are the same patch's.
 *
 * ⚠ **It takes lon/lat, not scene metres, and that is the whole point.** The
 * demo hands its hash `info.cx` / `info.cz`, metres from the page's single
 * origin. gameview's origin is the ROUTE's first point, so the same pitch got a
 * different seed — a different lamp colour and a different set of props — on
 * every route that rode past it, and a different one again after
 * `TerrainChunkManager.updateOrigin` re-bases the world. Same expression, same
 * 0.25 m grid, anchored to the globe instead of to whoever happened to press
 * start. (`plan/DEMO_POC_GUIDE.md` §2 case A: the demo's input cannot ask this.)
 *
 * ⚠ **Not the lamp pool's index.** `street-lamp.ts` hands out pool entries by
 * slot precisely because the pool SLIDES: bind a lamp's colour to an array
 * position and the lamp standing at a fixed spot becomes a different entry every
 * 70 m — same place, new colour, right in front of the rider. That was a bug
 * riders reported from the saddle (fixed in 2427d86), and a landuse lamp indexed
 * by "which patch is this in the array" brings it straight back: the array is
 * per-chunk and a chunk rebuild, a different tile window or one more polygon
 * upstream re-numbers everything after it.
 */
function patchSeed(lon: number, lat: number): number {
  return geoSeed(lon, lat);
}

/** Optional hooks the chunk manager can supply — see `buildLanduseMeshes`. */
export interface LanduseWorldHooks {
  /**
   * Terrain height at a point in LOCAL scene metres, or null off this chunk's
   * grid — the demos' `geoGroundY`. A lamp stands on the patch's EDGE, which on
   * a real MVT polygon can be a hundred metres from its centroid, so it asks for
   * the ground under ITSELF rather than borrowing the slab's height.
   */
  ground?: (x: number, z: number) => number | null;
  /**
   * The point ON THE ROUTE nearest a local-metre point, or null when there is no
   * route to face — the demos' `luRouteAt(cx, cz)` + `pathAt(near.d)`. It decides
   * which edge of the patch the lamp stands on: the one facing the road.
   */
  routePointNear?: (x: number, z: number) => { x: number; z: number } | null;
}

/** All overlay meshes of a result — add/remove/shift/dispose iterate this. */
export function landuseMeshes(result: LanduseRenderResult): THREE.Mesh[] {
  return result.layers.map((l) => l.mesh);
}

/**
 * Landuse materials are identical across chunks for a given (strategy, kind), so
 * share one instead of minting up to 8 fresh materials — and GL programs — per
 * chunk. Keyed by the strategy instance so a world-style switch (new strategy
 * object) starts a fresh cache and the old materials are GC'd with it.
 * Tagged `userData.shared` so the per-chunk dispose paths leave it to the cache.
 *
 * `urban` used to need the chunk's dominant colour in its key, which meant a
 * route could mint one more material and one more GL program per distinct
 * dominant class. Zone colour moved into the geometry, so the key is now just
 * the kind — one zone-decal material for the whole world.
 */
const landuseMaterialCache = new WeakMap<TerrainStyleStrategy, Map<string, THREE.Material>>();

function sharedLanduseMaterial(
  strategy: TerrainStyleStrategy,
  key: string,
  make: () => THREE.Material,
  kind: OverlayKind = 'urban',
): THREE.Material {
  let byKind = landuseMaterialCache.get(strategy);
  if (!byKind) {
    byKind = new Map();
    landuseMaterialCache.set(strategy, byKind);
  }
  let mat = byKind.get(key);
  if (!mat) {
    mat = make();
    applyOverlayDepth(mat, kind);
    mat.userData.shared = true;
    byKind.set(key, mat);
  }
  return mat;
}

/** Build flat overlay meshes for every ground-cover class we render. */
export async function buildLanduseMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
  owns: (lon: number, lat: number) => boolean = () => true,
  hooks: LanduseWorldHooks = {},
): Promise<LanduseRenderResult> {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // One spec per ground cover: what to match, how high to float it, and the
  // material. Adding a class means adding a row here — nothing else.
  const specs: {
    kind: string;
    match: (f: MVTFeature) => boolean;
    offset: number;
    material: () => THREE.Material;
    /** Per-polygon vertex tint. Only the zone decal needs one. */
    tint?: (f: MVTFeature) => number;
  }[] = [
    {
      kind: 'water',
      match: isLandscapeWaterFeature,
      offset: WATER_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'water', () => strategy.createWaterMaterial(), 'water'),
    },
    {
      kind: 'wetland',
      match: (f) => f.layer === 'landcover' && isWetlandLandcover(f),
      offset: WETLAND_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'wetland', () => strategy.createWetlandMaterial(), 'wetland'),
    },
    {
      kind: 'forest',
      match: (f) => f.layer === 'landcover' && isForestLandcover(f),
      offset: FOREST_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'forest', () => strategy.createForestMaterial(), 'forest'),
    },
    {
      kind: 'park',
      match: (f) => f.layer === 'park' || (f.layer === 'landcover' && isParkLandcover(f)),
      offset: PARK_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'park', () => strategy.createParkMaterial(), 'park'),
    },
    {
      kind: 'sports',
      match: (f) => f.layer === 'landuse' && isSportsLanduse(f),
      offset: SPORTS_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'sports', () => strategy.createSportsFieldMaterial(), 'sports'),
    },
    {
      kind: 'playground',
      match: (f) => f.layer === 'landuse' && isPlaygroundLanduse(f),
      offset: PLAYGROUND_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(
        strategy, 'playground', () => strategy.createPlaygroundMaterial(), 'playground',
      ),
    },
    {
      kind: 'sand',
      match: (f) => f.layer === 'landcover' && f.properties.class === 'sand',
      offset: SAND_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'sand', () => strategy.createSandMaterial(), 'sand'),
    },
    {
      kind: 'farmland',
      match: (f) => f.layer === 'landcover' && isFarmlandLandcover(f),
      offset: FARMLAND_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(strategy, 'farmland', () => strategy.createFarmlandMaterial(), 'farmland'),
    },
    {
      kind: 'urban',
      match: (f) => f.layer === 'landuse' && isUrbanLanduse(f),
      offset: URBAN_HEIGHT_OFFSET,
      material: () => sharedLanduseMaterial(
        strategy, 'zoneDecal', () => strategy.createZoneDecalMaterial(), 'urban',
      ),
      // The polygon's OWN class decides its zone — the map already said what the
      // district is for, and this is the last place that used to throw it away.
      // Not `ZoneIndex.zoneAt`: that resolves OVERLAPS by specificity (a school
      // inside a residential block wins), which is the right answer for "what
      // kind of building goes here" and the wrong one for painting the polygons
      // themselves. Each polygon gets the colour of the polygon it is.
      tint: (f) => strategy.zoneDecalColor(
        zoneFromLanduseClass(f.properties.class as string | undefined),
      ),
    },
  ];

  const matched = specs.map((s) => features.filter(s.match));

  // One yielder shared across all groups: the groups interleave at their await
  // points, so a single wall-clock budget keeps the combined work cooperative.
  const maybeYield = createYielder();
  const geomGroups = await Promise.all(
    specs.map((s, i) =>
      buildGeometryGroup(
        matched[i], sampler, originLat, originLon, originEle, cosOrigin, s.offset, strategy, maybeYield, owns,
        s.tint,
      ),
    ),
  );

  const lamps: StreetLampParts[] = [];
  const layers: LanduseLayer[] = specs.map((s, i) => {
    const mesh = createMeshFromGeoms(geomGroups[i].geometries, s.material());
    // ── The things that STAND UP ──
    //
    // Attached as CHILDREN of the layer mesh, on purpose. The layer mesh sits at
    // the origin with absolute local coordinates baked into its geometry, and
    // the floating-origin rebase moves `mesh.position` — so parenting gets the
    // scene add/remove, the rebase and the naming for free, and there is exactly
    // one place (`disposeLanduseMeshes`) that has to know props exist.
    let props = 0;
    for (const p of geomGroups[i].patches) {
      // Seeded from the patch's own GEOGRAPHIC position, quantised to 0.25 m —
      // the demos' rule, copied (`buildLanduse` in `plan/*-town-demo.html`), with
      // the one substitution `patchSeed` justifies: degrees in, not metres from
      // this route's origin. A stream taken from the chunk's shared rng would
      // make "does this patch have props" reorder everything built after it,
      // which is the exact bug the sign work left behind
      // (CUSTOM_WORLD_INSTRUCTIONS §5). The LAMP takes the same integer as its
      // identity — see `patchSeed`.
      const seed = patchSeed(p.centerLon, p.centerLat);
      if (strategy.buildLanduseProps) {
        const obj = strategy.buildLanduseProps({
          kind: s.kind,
          centerX: p.centerX, centerZ: p.centerZ, radius: p.radius, slabY: p.slabY,
          rng: mulberry32(seed),
        });
        if (obj) { mesh.add(obj); props++; }
      }
      // ── The lamp that lights a pitch / a playground ──
      //
      // The demos' block, line for line (`plan/*-town-demo.html`, LANDUSE):
      //
      //   const near = luRouteAt(info.cx, info.cz);
      //   const p = near ? pathAt(near.d) : null;
      //   const dx = p ? p.x - info.cx : 0;
      //   const dz = p ? p.z - info.cz : info.r;
      //   const dl = Math.hypot(dx, dz) || 1;
      //   const lx = info.cx + (dx / dl) * info.r;
      //   const lz = info.cz + (dz / dl) * info.r;
      //   LU_STYLE.lamp({ …, cx: lx, cz: lz, y: geoGroundY(lx, lz), id: seed });
      //
      // …so: on the patch's edge, on the side that faces the road, and when
      // there is no road to face (the demo's own `p === null` branch) on the +z
      // edge. `strategy.buildStreetLamp` is this world's EXISTING roadside lamp
      // — the demos add no vocabulary for this and neither does the port
      // (§3.3), and there is only one implementation of the part (§3.10).
      if (LAMP_KINDS.has(s.kind)) {
        const near = hooks.routePointNear?.(p.centerX, p.centerZ) ?? null;
        const dx = near ? near.x - p.centerX : 0;
        const dz = near ? near.z - p.centerZ : p.radius;
        const dl = Math.hypot(dx, dz) || 1;
        // The demos' own corridor test, `Math.abs(at.lat) > half + info.r`
        // (`luPatches`) — see LAMP_CORRIDOR_HALF_M. `dl` is the distance to the
        // nearest route point, which on a locally straight route IS `|lat|`.
        if (near && dl > LAMP_CORRIDOR_HALF_M + p.radius) continue;
        const lx = p.centerX + (dx / dl) * p.radius;
        const lz = p.centerZ + (dz / dl) * p.radius;
        const parts = strategy.buildStreetLamp(seed);
        parts.group.position.set(lx, hooks.ground?.(lx, lz) ?? p.slabY, lz);
        mesh.add(parts.group);
        // Night (and the point-light budget) comes from `street-lamp.ts` — the
        // same write that drives the roadside pool, because it is the same part.
        registerFixedLamp(parts);
        lamps.push(parts);
      }
    }
    return { kind: s.kind, mesh, count: matched[i].length, props };
  });

  return { layers, lamps };
}

/** Deterministic stream — the demos' generator, so a patch looks the same in both. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Feature classification ──

/**
 * Landscape water — the policy lives in `water-classes.ts` so the 2D renderer
 * reads the same one (`road-classes.ts`'s pattern, and the same failure it was
 * created for). Until this call the `class` on the `water` layer was never read
 * at all, which made every back-garden swimming pool a lake.
 */
function isLandscapeWaterFeature(feature: MVTFeature): boolean {
  return feature.layer === 'water' && isLandscapeWater(feature.properties);
}

/** Check if a landcover feature is forest/wood. */
function isForestLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'wood' || cls === 'forest';
}

/** Check if a landcover feature is grass/park (not forest). */
function isParkLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'grass' || cls === 'park';
}

/** Marsh/bog. */
function isWetlandLandcover(feature: MVTFeature): boolean {
  return feature.properties.class === 'wetland';
}

/** Fields — nurseries read as fields too. */
function isFarmlandLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'farmland' || cls === 'plant_nursery';
}

/**
 * Pitches, running tracks, stadiums — the court plate. FLAT, and only lines.
 *
 * `playground` used to be in here. It is not any more (2026-07-28): the demos
 * arbitrated the two as opposite ends of one axis — how much structure a ground
 * cover has — and a playground drawn as a court plate loses the only thing that
 * identifies it. See `isPlaygroundLanduse`.
 */
function isSportsLanduse(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'pitch' || cls === 'track' || cls === 'stadium';
}

/**
 * Playgrounds. Split out of the pitch because they are the one ground cover the
 * demos let stand up (slide / climbing frame / see-saw), and at a rider's eye
 * height that silhouette is the whole identification. Measured: 69 of them in
 * the Taipei 3×3 tile window, 3 at Alpe d'Huez — every one of which was being
 * painted as a sports field.
 */
function isPlaygroundLanduse(feature: MVTFeature): boolean {
  return feature.properties.class === 'playground';
}

/**
 * Urban ground. Institutional grounds (schools, hospitals, campuses) are folded
 * in deliberately: they read as built-up land, and their buildings already come
 * from the `building` layer — no separate art needed for the ground they sit on.
 */
export function isUrbanLanduse(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return (
    cls === 'residential' || cls === 'commercial' || cls === 'industrial' || cls === 'retail' ||
    cls === 'school' || cls === 'hospital' || cls === 'university' || cls === 'college' ||
    cls === 'kindergarten' || cls === 'library' || cls === 'education'
  );
}

// ── Geometry helpers ──

/** Build geometries for a group of features. */
async function buildGeometryGroup(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  heightOffset: number,
  strategy: TerrainStyleStrategy,
  maybeYield: MaybeYield,
  owns: (lon: number, lat: number) => boolean,
  tint?: (f: MVTFeature) => number,
): Promise<{ geometries: THREE.BufferGeometry[]; patches: LandusePatch[] }> {
  const geometries: THREE.BufferGeometry[] = [];
  const patches: LandusePatch[] = [];
  for (const feature of features) {
    const polys = extractPolygonCoords(feature);
    const color = tint?.(feature);
    for (const coords of polys) {
      // One owner per ring — the padded-corridor overlap band otherwise gets a
      // z-fighting twin slab from the neighbouring chunk.
      let cLon = 0, cLat = 0;
      for (const [lon, lat] of coords) { cLon += lon; cLat += lat; }
      if (coords.length > 0 && !owns(cLon / coords.length, cLat / coords.length)) continue;
      const built = await buildFlatPolygon(
        coords, sampler, originLat, originLon, originEle, cosOrigin, heightOffset, strategy,
      );
      if (!built) continue;
      const { geom, y } = built;
      // The patch record for `buildLanduseProps`. Centroid and radius in LOCAL
      // scene metres — the same projection the slab itself used, so a prop can
      // never land somewhere the slab is not.
      {
        const mLon = cLon / coords.length;
        const mLat = cLat / coords.length;
        const cx = (mLon - originLon) * 111320 * cosOrigin;
        const cz = -(mLat - originLat) * 111320;
        let r = 0;
        for (const [lon, lat] of coords) {
          const x = (lon - originLon) * 111320 * cosOrigin;
          const z = -(lat - originLat) * 111320;
          const d = Math.hypot(x - cx, z - cz);
          if (d > r) r = d;
        }
        patches.push({
          centerX: cx, centerZ: cz, radius: r, slabY: y, centerLon: mLon, centerLat: mLat,
        });
      }
      // Carried on the geometry rather than baked here: the merge is the only
      // place that knows the final vertex count, and a per-polygon Float32Array
      // that the merge then copies again is the exact allocation churn the
      // chunk-build budget cannot spare.
      if (color !== undefined) geom.userData.tint = color;
      geometries.push(geom);
    }
    // Yield roughly every ~10ms of triangulation so a park-heavy chunk paints.
    await maybeYield();
  }
  return { geometries, patches };
}

/** Create a mesh from geometries, or an empty mesh if none. */
function createMeshFromGeoms(
  geoms: THREE.BufferGeometry[],
  material: THREE.Material,
): THREE.Mesh {
  if (geoms.length === 0) {
    // Shared materials belong to the cache — only free a per-chunk one.
    if (!material.userData.shared) material.dispose();
    // NOT `new THREE.Mesh()`: that mints a private geometry AND a private
    // material, and 14 of the plastic world's 75 census materials were exactly
    // this. See `empty-mesh.ts`.
    return emptyMesh();
  }
  const merged = mergeGeometries(geoms);
  for (const g of geoms) g.dispose();
  const mesh = new THREE.Mesh(merged, material);
  // Shadows: receives only, like the road. Every ground overlay the demos build
  // does the same — the zone decal (`circuit:2947`), the park blob
  // (`plastic:2305`), the copper pour and the solder pool (`circuit:3067,3085`).
  // Same reason as the road: these sit ON the terrain, so one that ignores the
  // shadow map cuts a lit hole in whatever falls across it.
  mesh.receiveShadow = true;
  return mesh;
}

/** Extract polygon coordinate rings from a feature (handles Polygon and MultiPolygon). */
export function extractPolygonCoords(feature: MVTFeature): [number, number][][] {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return [(geom as GeoJSON.Polygon).coordinates[0] as [number, number][]];
  }
  if (geom.type === 'MultiPolygon') {
    return (geom as GeoJSON.MultiPolygon).coordinates.map(
      (poly) => poly[0] as [number, number][],
    );
  }
  return [];
}

/**
 * Build a flat triangulated polygon mesh at terrain elevation.
 */
async function buildFlatPolygon(
  coords: [number, number][],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  heightOffset: number,
  strategy: TerrainStyleStrategy,
): Promise<{ geom: THREE.BufferGeometry; y: number } | null> {
  if (coords.length < 3) return null;

  // rotateX(-90°) maps shape-Y to NEGATIVE world-Z: store +latitude metres
  // (NOT scene z) or every slab mirrors across the origin's east-west axis —
  // the April bug family that put a phantom river slab over the riverside
  // park. Ring order reversed so the winding (face orientation) is kept.
  const shape = new THREE.Shape();
  const last = coords[coords.length - 1];
  shape.moveTo(
    (last[0] - originLon) * 111320 * cosOrigin,
    (last[1] - originLat) * 111320,
  );
  for (let i = coords.length - 2; i >= 0; i--) {
    shape.lineTo(
      (coords[i][0] - originLon) * 111320 * cosOrigin,
      (coords[i][1] - originLat) * 111320,
    );
  }
  shape.closePath();

  // Create flat geometry from shape
  const shapeGeom = new THREE.ShapeGeometry(shape);

  // Get elevation at centroid for the whole polygon
  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  const cLon = sumLon / coords.length;
  const cLat = sumLat / coords.length;

  // Sync when the covering DEM tile is cached (the common case — terrain built
  // first); only a miss awaits a microtask.
  let baseEle = sampler.getElevationSync(cLat, cLon);
  if (baseEle === null) {
    try {
      baseEle = await sampler.getElevation(cLat, cLon);
    } catch {
      baseEle = originEle;
    }
  }

  // EVERY slab takes "ring-minimum + FLOOR quantise" (originally water-only):
  // centroid + ROUND could land a slab a whole layer ABOVE its local terrain
  // tread — the city ended up blanketed in green plates floating at 6m (you
  // rode under a ceiling, their unlit edges filled the sky with black lines,
  // and they pierced hillsides). Floor-min pins a slab to the LOWEST tread it
  // touches: on higher treads it hides under the terrain instead of hovering
  // over it, which is the right failure mode. Clamp to one layer below the
  // centroid so noisy DEM (rivers read −28m here) can't drag it into a pit.
  const step = Math.max(1, Math.floor(coords.length / 24));
  let minEle = baseEle;
  for (let i = 0; i < coords.length; i += step) {
    const s = sampler.getElevationSync(coords[i][1], coords[i][0]);
    if (s !== null && s < minEle) minEle = s;
  }
  const layer = strategy.params.layerHeight;
  const clamped = Math.max(minEle, baseEle - layer);
  const y =
    strategy.params.quantEnabled && layer > 0.01
      ? Math.floor(clamped / layer) * layer - originEle + heightOffset
      : clamped - originEle + heightOffset;

  // ShapeGeometry produces geometry in XY plane, we need XZ
  // Rotate -90° around X to lay flat, then translate to correct height
  shapeGeom.rotateX(-Math.PI / 2);
  shapeGeom.translate(0, y, 0);

  // `y` goes back out too: it is where the SLAB ended up, and a prop standing on
  // the patch has to stand on the slab, not on the raw DEM. The slab is flat and
  // floor-quantised (see the comment above), so re-deriving it from the sampler
  // at the prop's own position would put the feet a layer above or below it.
  return { geom: shapeGeom, y };
}

/** Scratch colour for the merge — one per module, not one per polygon. */
const mergeTint = new THREE.Color();

/**
 * Simple geometry merge.
 *
 * Carries `userData.tint` through as a vertex `color` attribute. Whether the
 * attribute exists at all is decided ONCE, up front, by whether ANY geometry in
 * the group is tinted — because `vertexColors` lives on the material, and a
 * half-tinted buffer would render the untinted half black in WebGL and nowhere
 * a headless probe can see it (the same trap `markInstanceTemplate` documents).
 * White is the identity for the `diffuse *= vColor` that follows, so an untinted
 * polygon inside a tinted group comes out unchanged rather than black.
 */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  const tinted = geometries.some((g) => g.userData.tint !== undefined);
  const colors = tinted ? new Float32Array(totalVerts * 3) : null;

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    g.computeVertexNormals();

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
      if (norm) normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
    }

    if (colors) {
      mergeTint.setHex(g.userData.tint ?? 0xffffff);
      for (let i = 0; i < count; i++) {
        colors[(vertOffset + i) * 3] = mergeTint.r;
        colors[(vertOffset + i) * 3 + 1] = mergeTint.g;
        colors[(vertOffset + i) * 3 + 2] = mergeTint.b;
      }
    }

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[idxOffset + i] = vertOffset + i;
      }
      idxOffset += count;
    }

    vertOffset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

/** Dispose all landuse mesh resources (geometry only — materials are shared). */
export function disposeLanduseMeshes(result: LanduseRenderResult): void {
  const freeMat = (m: THREE.Material): void => { if (!m.userData?.shared) m.dispose(); };
  // ── Lamps first, and OFF the graph before the walk below runs ──
  //
  // A lamp frees itself through `StreetLampParts.dispose()`, which is the only
  // thing that knows what it owns: the circuit lamp's legs take the strategy's
  // shared `pinMat()` while its lens and die are per-lamp, and its `owned` list
  // is the difference. Leaving the group attached would put the generic walk
  // over it as well — a second, less-informed dispose of the same resources.
  for (const parts of result.lamps ?? []) {
    unregisterFixedLamp(parts);
    parts.group.removeFromParent();
    parts.dispose();
  }
  for (const mesh of landuseMeshes(result)) {
    // The slab itself, then everything `buildLanduseProps` hung under it.
    // `traverse` includes the mesh, so this is one walk, not two.
    //
    // ⚠ `userData.shared` is the ONLY thing standing between a strategy-owned
    // singleton and a disposed texture on the chunks that still point at it
    // (CUSTOM_WORLD_INSTRUCTIONS §6). Props are expected to be built almost
    // entirely from shared unit geometry + shared materials — that is what keeps
    // them off the draw-call budget — so in practice most of this walk is a
    // no-op, and the walk exists for the handful that genuinely are per-patch.
    mesh.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && !g.userData?.shared) g.dispose();
      const mat = (o as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach(freeMat);
      else if (mat instanceof THREE.Material) freeMat(mat);
      // ⚠ An `InstancedMesh` owns a THIRD buffer — `instanceMatrix` (and
      // `instanceColor`) — that `geometry.dispose()` does NOT free, and props are
      // built almost entirely out of them (one per reed clump, two per
      // playground). CUSTOM_WORLD_INSTRUCTIONS §6 names this as the easy miss.
      // Its geometry is usually the SHARED unit template, so the branch above
      // deliberately leaves that alone — this is the per-instance buffer only.
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
  }
}
