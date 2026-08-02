/**
 * Road renderer: builds 3D ribbon meshes from MVT transportation features.
 *
 * Each road polyline is resampled and laid ON the terrain (see
 * `ribbon-geometry.ts` — the roads used to compute their own quantised height
 * and sank into the steps). Roads are merged into ONE MESH PER ROAD MATERIAL —
 * a single mesh for a world whose six classes share one material (plastic,
 * paper), one per width for a world that does not (circuit: the solder-mask
 * border is a fixed world metre, so it needs one texture per road width).
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import {
  buildGroundRibbon, buildGroundRibbonWithRails, mergeRibbonGeometries,
  type GroundFn, type RibbonWidthProfile,
} from './ribbon-geometry';
import { applyOverlayDepth } from './overlay-depth';
import { createYielder } from './build-yield';
import { isDrawnRoad } from './road-classes';

/** Road height above the terrain surface. See the layering table in the plan:
 *  aeroway 0.12 < waterway 0.15 < road 0.30 < route-line glow 0.40 / core 0.45. */
export const ROAD_HEIGHT_OFFSET = 0.3;

/** Bridges drape like every other road (toy diorama — no elevated decks; the
 *  railings carry the "bridge" read), but float slightly higher so a bridge
 *  crossing over another road doesn't z-fight it (still under the route
 *  line's 0.40 glow). */
const BRIDGE_ROAD_OFFSET = ROAD_HEIGHT_OFFSET + 0.08;

/** Bridge railings OFF: Taipei's multi-kilometre viaducts (brunnel=bridge) all
 *  grew twin 1.1m rail strips, and dozens of them draped across the city read
 *  as a sky full of power cables (confirmed by the headless render probe's
 *  rail-only pass). Keep the machinery — a future refinement could enable
 *  rails only for short water crossings, where they actually look charming. */
const BRIDGE_RAILS_ENABLED = false;

/**
 * Road materials are identical across every chunk of a given style, so share one
 * per (strategy, colour, class) instead of minting a fresh material — and GL
 * program — per chunk. Keyed by the strategy instance, so a world-style switch
 * (new strategy object) starts a fresh cache and the old entry is GC'd with it.
 * Tagged `userData.shared` so `disposeRoadMesh` leaves it to the cache.
 *
 * The CLASS reaches the key through `strategy.roadMaterialKey`, so the split is
 * the STYLE's decision and not this file's: a world that omits the hook gets one
 * material and one merged mesh, exactly as before. Circuit declares it (keyed by
 * road WIDTH, demo `busMats`) because its solder-mask border is a process
 * parameter fixed at one world metre — the border's share of the texture is
 * therefore `1 / width`, so there is one texture per width.
 */
const roadMaterialCache =
  new WeakMap<TerrainStyleStrategy, Map<string, THREE.Material>>();

function sharedRoadMaterial(
  strategy: TerrainStyleStrategy, color: number, roadClass: string,
): THREE.Material {
  let byKey = roadMaterialCache.get(strategy);
  if (!byKey) {
    byKey = new Map();
    roadMaterialCache.set(strategy, byKey);
  }
  const key = `${color}|${strategy.roadMaterialKey?.(roadClass) ?? ''}`;
  let mat = byKey.get(key);
  if (!mat) {
    mat = strategy.createRoadMaterial(color, roadClass);
    applyOverlayDepth(mat, 'road');
    mat.userData.shared = true;
    byKey.set(key, mat);
  }
  return mat;
}

/**
 * Endpoint key. 1e-6° ≈ 0.11 m, which is finer than the MVT grid this all lands
 * on (z14 / extent 4096 ≈ 0.6 m per unit at Taipei's latitude), so two ways that
 * share an OSM junction node — identical integer coords in the same tile,
 * therefore identical decoded floats — always land in the same bucket.
 */
function endpointKey(coord: [number, number]): string {
  return `${Math.round(coord[0] * 1e6)},${Math.round(coord[1] * 1e6)}`;
}

/**
 * How wide the road is AT each junction: the widest drawn class that meets there.
 *
 * This is the order-free rule that stands in for the demo's "the wedge goes in
 * the NEW segment". The demo's roads are a chain along the route's mileage, so
 * it can name a downstream side; a road network cannot. Reading the MVT winding
 * instead breaks continuity outright — two ways meeting start-to-start would
 * BOTH ramp, and they would disagree about the width at the joint they share.
 *
 * So: **the junction is as wide as the widest trace entering it, and every
 * narrower one flares out to meet it over Δ/2 metres at 45°.** One rule, and it
 * covers what the demo's chain never has to answer — a T or a cross, where three
 * or four classes meet at one node (`plan/demo-gaps.md`: gameview 遇得到而 demo
 * 仲裁不了的情況). Two consequences worth naming:
 *
 *  - The wedge is always in the NARROWER feature, so during the wedge the actual
 *    width is ≥ that feature's nominal width. `busSeg`'s `hv` therefore stays
 *    ≤ 0.5 and `v` never leaves 0…1 — the road texture's ClampToEdge is a
 *    backstop here, not load-bearing.
 *  - A dangling endpoint (a tile-clipped line, a dead end) finds only itself, so
 *    its joint width IS its nominal width and the ramp length is 0: the ribbon is
 *    exactly the constant-width one this file built before.
 */
function buildJunctionWidths(
  roads: MVTFeature[], strategy: TerrainStyleStrategy,
): Map<string, number> {
  const widest = new Map<string, number>();
  for (const road of roads) {
    const w = strategy.roadWidth((road.properties.class as string) || 'minor');
    const lines: [number, number][][] =
      road.geometry.type === 'LineString'
        ? [(road.geometry as GeoJSON.LineString).coordinates as [number, number][]]
        : ((road.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][]);
    for (const coords of lines) {
      if (coords.length < 2) continue;
      for (const end of [coords[0], coords[coords.length - 1]]) {
        const k = endpointKey(end);
        const prev = widest.get(k);
        if (prev === undefined || w > prev) widest.set(k, w);
      }
    }
  }
  return widest;
}

export interface RoadRenderResult {
  /**
   * One mesh per distinct road MATERIAL in this chunk — a single merged mesh for
   * every world whose roads share one material, up to one per drawn road class
   * (≤ 6) for a world that varies it (circuit's per-width bus texture).
   *
   * An array rather than one merged mesh because the split is a MATERIAL split:
   * three's group mechanism could carry it on one geometry, but the census, the
   * scene inventory and the stud-blocker raster all read meshes, and a chunk's
   * roads are already a handful of draw calls out of ~100.
   */
  meshes: THREE.Mesh[];
  /** Tunnel mouths, already draped and turned to face out of the hillside. */
  portals: THREE.Object3D[];
  /** Bridge railings — separate mesh (plain material, not the road texture). */
  railMesh: THREE.Mesh | null;
  roadCount: number;
}

/** Railing material — one per style strategy, shared by every chunk. */
const railMaterialCache = new WeakMap<TerrainStyleStrategy, THREE.Material>();

function sharedRailMaterial(strategy: TerrainStyleStrategy): THREE.Material {
  let mat = railMaterialCache.get(strategy);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color: 0x8f8578 });
    mat.userData.shared = true;
    railMaterialCache.set(strategy, mat);
  }
  return mat;
}

/**
 * Build road ribbon meshes from MVT transportation features.
 *
 * @param ground  Terrain probe. Where it misses (terrain not streamed in), the
 *                old quantised-elevation formula is used instead.
 */
export async function buildRoadMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn = () => null,
  owns: (lon: number, lat: number) => boolean = () => true,
): Promise<RoadRenderResult> {
  const roads = features.filter(
    (f) =>
      f.layer === 'transportation' &&
      isDrawnRoad(f.properties) &&
      (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'),
  );

  if (roads.length === 0) {
    return { meshes: [], railMesh: null, roadCount: 0, portals: [] };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const proj = { originLat, originLon, cosOrigin };
  /**
   * Ribbons bucketed by the MATERIAL they will be drawn with, not by class.
   *
   * Keying on the material instance is what makes this free for the worlds that
   * do not care: without `roadMaterialKey` the cache above holds ONE entry, so
   * all six classes land in one bucket and the chunk still merges to one mesh —
   * byte-for-byte the geometry it built before. Circuit's per-width bus
   * materials are separate objects, so it gets one bucket per width present.
   *
   * A Map preserves insertion order, so the mesh order is the order the classes
   * were first met — deterministic for a given tile, which the census and the
   * render probe both depend on to diff two runs.
   */
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const railGeometries: THREE.BufferGeometry[] = [];
  const portals: THREE.Object3D[] = [];
  /** Use a single dark road material (most common colour) — shared across
   *  chunks; the per-road colour rides in the ribbon's vertex colours. */
  const ROAD_MATERIAL_COLOR = 0x3a3a3a;
  const pushRibbon = (roadClass: string, geom: THREE.BufferGeometry): void => {
    const mat = sharedRoadMaterial(strategy, ROAD_MATERIAL_COLOR, roadClass);
    const bucket = byMaterial.get(mat);
    if (bucket) bucket.push(geom);
    else byMaterial.set(mat, [geom]);
  };

  const sx = (lon: number) => (lon - originLon) * 111320 * cosOrigin;
  const sz = (lat: number) => -(lat - originLat) * 111320;

  /**
   * Put a tunnel mouth where a skipped tunnel meets the hillside.
   *
   * `outward` is the direction the opening should face — away from the bore.
   * A Y rotation of theta maps local +z to (sin, cos), and the portal is
   * authored with its opening on +z, so theta = atan2(ox, oz).
   */
  const addPortal = (
    lon: number, lat: number,
    towardLon: number, towardLat: number,
    width: number,
  ): void => {
    if (!strategy.buildTunnelPortal) return;
    const x = sx(lon);
    const z = sz(lat);
    const y = ground(x, z);
    // No ground = the mouth is outside this chunk's corridor, or buried under
    // another deck. Either way there is no hillside here to set it into, and
    // this doubles as the per-chunk clip: only a chunk whose own corridor grid
    // covers the mouth can build it.
    //
    // Note this deliberately does NOT use the `owns` rule the ribbons use.
    // Ownership is nearest-route-point with a 1200 m cutoff — sized for road
    // ribbons that run alongside the route. Tunnel mouths sit up a hillside,
    // well off it: measured on Dazhi chunks 2-4, ownership rejected 54 of 54
    // mouths, so every portal in the area would have been silently dropped.
    if (y === null) return;
    const ox = x - sx(towardLon);
    const oz = z - sz(towardLat);
    if (Math.hypot(ox, oz) < 1e-3) return;
    const portal = strategy.buildTunnelPortal(width);
    if (!portal) return;
    portal.position.set(x, y, z);
    portal.rotation.y = Math.atan2(ox, oz);
    portals.push(portal);
  };

  const maybeYield = createYielder();

  // Only built for a world that declares the wedge (circuit) — the other two get
  // `undefined` and every ribbon below is the constant-width one it always was.
  const junctionWidths = strategy.roadTaperLength
    ? buildJunctionWidths(roads, strategy)
    : null;

  /**
   * The width profile for one line: its own class width between the joints, the
   * junction width at each end, and the 45° wedge that gets from one to the other
   * (`strategy.roadTaperLength` = the demo's `taperLen`).
   */
  const widthProfileFor = (
    coords: [number, number][], width: number,
  ): RibbonWidthProfile | undefined => {
    if (!junctionWidths || !strategy.roadTaperLength) return undefined;
    const startWidth = junctionWidths.get(endpointKey(coords[0])) ?? width;
    const endWidth = junctionWidths.get(endpointKey(coords[coords.length - 1])) ?? width;
    const startLen = strategy.roadTaperLength(startWidth, width);
    const endLen = strategy.roadTaperLength(endWidth, width);
    // Nothing to interpolate: this line is the widest thing at both of its ends.
    // Returning undefined (rather than a profile with two zero-length ramps) is
    // what keeps the common case on the untouched constant-width path.
    if (startLen <= 0 && endLen <= 0) return undefined;
    const nominal = width;
    return {
      startWidth, startLen, endWidth, endLen, nominalWidth: nominal,
      uvHalfSpan: strategy.roadUvHalfSpan
        ? (actual) => strategy.roadUvHalfSpan!(actual, nominal)
        : undefined,
    };
  };

  for (const road of roads) {
    // Ribboning a dense chunk's roads is a long synchronous burst — yield ~10ms.
    await maybeYield();
    const roadClass = (road.properties.class as string) || 'minor';
    const color = new THREE.Color(strategy.roadColor(roadClass));
    const nominalWidth = strategy.roadWidth(roadClass);
    const halfWidth = nominalWidth / 2;
    const isBridge = road.properties.brunnel === 'bridge';
    const isTunnel = road.properties.brunnel === 'tunnel';

    const lines: [number, number][][] =
      road.geometry.type === 'LineString'
        ? [(road.geometry as GeoJSON.LineString).coordinates as [number, number][]]
        : ((road.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][]);

    for (const coords of lines) {
      if (isTunnel) {
        // A tunnel is INSIDE the hill, not on it. Draping one on the surface
        // paints a road over the ridge it is supposed to bore through — which
        // is how Ziqiang Tunnel ended up drawn across the face of Jiannan Shan.
        //
        // No bore is modelled, deliberately: the terrain is streamed and
        // rebuilt whenever a style knob changes, so CSG would have to re-run
        // every time, and tunnels routinely leave the ±500 m corridor entirely
        // — there would be nothing to cut. The same call is already made for
        // the RIDER's own tunnels, which are conveyed by packing street lamps
        // tight rather than by a hole (see street-lamp.ts).
        //
        // So: draw nothing. The road runs to the hillside, stops, and picks up
        // on the far side, which reads exactly as "it goes through".
        //
        // Mark both ends so the road does not merely stop dead: the tunnel's
        // first and last vertices ARE its portals in OSM.
        if (coords.length >= 2) {
          const a = coords[0], b = coords[1];
          const y = coords[coords.length - 1], x2 = coords[coords.length - 2];
          addPortal(a[0], a[1], b[0], b[1], halfWidth * 2);
          addPortal(y[0], y[1], x2[0], x2[1], halfWidth * 2);
        }
        continue;
      }
      if (isBridge) {
        // Bridges drape like any road; the railings are the visual marker.
        // Same per-sample ownership clip as every other ribbon.
        const res = buildGroundRibbonWithRails(coords, proj, ground, {
          halfWidth,
          widthProfile: widthProfileFor(coords, nominalWidth),
          heightOffset: BRIDGE_ROAD_OFFSET,
          color,
          emitUv: true,
          keep: owns,
        });
        if (res) {
          pushRibbon(roadClass, res.ribbon);
          if (BRIDGE_RAILS_ENABLED && res.rail) railGeometries.push(res.rail);
        }
        continue;
      }

      const geom = buildGroundRibbon(coords, proj, ground, {
        halfWidth,
        // 45° wedge at each end where a wider class meets this one (circuit only).
        widthProfile: widthProfileFor(coords, nominalWidth),
        heightOffset: ROAD_HEIGHT_OFFSET,
        color,
        // u = metres along the road, v = 0/1 across it. The style's road texture
        // (tape weave / dashed centre line) sets its own repeat from this, so the
        // dash pitch stays constant no matter how long the polyline is.
        emitUv: true,
        // Per-sample ownership clip: the overlap band between two chunks'
        // padded corridors is built by exactly one of them, split cleanly at
        // the ownership boundary (both sides drape on their own grid).
        keep: owns,
      });
      if (geom) pushRibbon(roadClass, geom);
    }
  }

  if (byMaterial.size === 0) {
    return { meshes: [], railMesh: null, roadCount: 0, portals };
  }

  const meshes: THREE.Mesh[] = [];
  for (const [material, geometries] of byMaterial) {
    const merged = mergeRibbonGeometries(geometries);
    for (const g of geometries) g.dispose();
    const mesh = new THREE.Mesh(merged, material);
    // Shadows: the road receives, it does not cast — the demos' own
    // `road.receiveShadow = true` (`plastic:2186`, `paper:2585`, and circuit's
    // bus ribbon at `:2965`), with castShadow left at false because a decal
    // lying on the ground has nothing to cast onto.
    //
    // Receiving is not optional decoration here: the ribbon is drawn OVER the
    // terrain on a polygon offset, so a road that does not sample the shadow map
    // punches a lit strip through every building shadow that crosses it — and the
    // road is exactly where a town's shadows are read.
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }

  let railMesh: THREE.Mesh | null = null;
  if (railGeometries.length > 0) {
    const railMerged = mergeRibbonGeometries(railGeometries);
    for (const g of railGeometries) g.dispose();
    railMesh = new THREE.Mesh(railMerged, sharedRailMaterial(strategy));
    railMesh.receiveShadow = true;
  }

  return { meshes, railMesh, roadCount: roads.length, portals };
}

/** Dispose road mesh resources (geometry only — the material is shared). */
export function disposeRoadMesh(result: RoadRenderResult): void {
  // Portals are per-chunk geometry over strategy-owned shared materials, same
  // ownership rule as everything else here.
  for (const p of result.portals) {
    p.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
        (mesh as unknown as THREE.InstancedMesh).dispose();
      }
      const m = mesh.material;
      if (m instanceof THREE.Material && !m.userData.shared) m.dispose();
    });
  }
  result.portals.length = 0;
  for (const mesh of result.meshes) {
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (mat instanceof THREE.Material && !mat.userData.shared) mat.dispose();
  }
  if (result.railMesh) {
    result.railMesh.geometry.dispose();
    const railMat = result.railMesh.material;
    if (railMat instanceof THREE.Material && !railMat.userData.shared) railMat.dispose();
  }
}
