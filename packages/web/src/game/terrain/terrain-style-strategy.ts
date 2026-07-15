/**
 * TerrainStyleStrategy — Strategy pattern for the Three.js world's visual style,
 * mirroring the Phaser 2D `PhaserStyleStrategy` (game/phaser/phaser-style-strategy.ts).
 *
 * One construction logic, two "hand-made" styles:
 *  - `plastic`  → toy BLOCKS: cubic-stepped terrain of slightly height-varied
 *                 blocks, glossy primary colours.
 *  - `paper`    → CORRUGATED cardboard: contour-stacked sheets with exposed
 *                 corrugated edges, matte kraft tones + ink outlines.
 *
 * Every renderer (terrain-chunk / building / road / landuse / tree) pulls its
 * materials + colours + geometry decisions from the injected strategy instead
 * of importing `cartoon-materials.ts` directly, so switching the strategy swaps
 * the whole pipeline.
 *
 * Zero external assets — everything procedural (DEVPLAN "所有視覺元素都是程序化").
 * Blocks/brick are generic craft words; no LEGO branding, models, or
 * trademarked proportions.
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** Config-level world style value (shared with Phaser + DOM `data-world-style`). */
export type WorldStyle = 'plastic' | 'cuphead';

/** Which ring of the distant mountain silhouette is being generated. */
export type MountainLayer = 'near' | 'far';

/**
 * The rider's bike ornament, handed to `BikeOrnament` (bike-ornament.ts) which
 * owns the per-frame animation. The style only decides what it looks like.
 */
export interface BikeOrnamentParts {
  /** Root — the manager sets world position + yaw on this. */
  root: THREE.Group;
  /** Child of root that takes the lean (roll) on corners. */
  lean: THREE.Group;
  /** Wheel groups — spun by forward motion (axle = local z). */
  wheels: THREE.Object3D[];
  /** Crank + pedals — spun at a slower, cadence-like rate. */
  crank: THREE.Object3D | null;
  /** Frees every geometry/material the ornament owns. */
  dispose(): void;
}

/** A roadside lamp: geometry plus a day→night dimmer. */
export interface StreetLampParts {
  group: THREE.Group;
  /** 0 = full day (bulb off), 1 = full night (bulb glowing). */
  setNight(nightFactor: number): void;
  /**
   * Whether this lamp carries a real PointLight, as opposed to just a glowing
   * head. Every live point light costs fragment work on every lit surface, so a
   * tunnel's dense row keeps only the nearest few switched on — the rest still
   * read as lamps because their heads glow. Default: on.
   */
  setLightEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * One end of the day↔night blend: sky gradient, fog, and the three lights.
 * Values are the demos' (see `plan/ref-demo-*-src.js`) — hand-tuned to look
 * right under a CONSTANT exposure of 1.05, which is why they can be this low at
 * night and still read as "a lit toy world after dark" rather than a black hole.
 */
export interface SkyMood {
  /** Gradient dome, top and horizon. */
  skyTop: number;
  skyBottom: number;
  fog: number;
  /** Key light (sun by day, moon by night). */
  sunColor: number;
  sunIntensity: number;
  /** Bounce light. */
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Fill light — the floor of how dark the world can ever get. */
  ambientColor: number;
  ambientIntensity: number;
}

/** The two ends the day/night system interpolates between, per world style. */
export interface SkyPalette {
  day: SkyMood;
  night: SkyMood;
}

/**
 * The route as a mark drawn on the road: a narrow, near-opaque marker stroke
 * over a wider, faint halo (highlighter pen / neon tape, per world style).
 * Widths are in world metres.
 */
export interface RouteLineStyle {
  coreColor: number;
  coreWidth: number;
  coreOpacity: number;
  glowColor: number;
  glowWidth: number;
  glowOpacity: number;
}

/** Oriented bounding box of one MVT building footprint, in scene metres. */
export interface BuildingBox {
  /** Centre in scene coordinates. */
  cx: number;
  cz: number;
  /** Footprint extents along the box's own axes. */
  width: number;
  depth: number;
  /** Rotation of the box around +y (radians). */
  rotY: number;
  /** Wall height in metres, and the (quantised) base y the walls start from. */
  height: number;
  baseY: number;
  /** The wall colour the strategy already picked for this building. */
  color: number;
}

/** Geometry + material for one facade-window instance. */
export interface FacadeWindowTemplate {
  /** Fresh per call — owned (and disposed) by the chunk that batches it. */
  geometry: THREE.BufferGeometry;
  /** Strategy-owned singleton, tagged `userData.shared`. */
  material: THREE.Material;
}

/**
 * A style's facade windows, described as data. Windows are the most numerous
 * prop in a city chunk (tens per building, dozens of buildings), so the
 * building renderer owns the whole pipeline — grid placement, baking the box
 * rotation into scene space, and batching one InstancedMesh per chunk. A style
 * only supplies the knobs; it never builds meshes or re-derives the transform.
 * Omit the whole group for a style with no windows.
 */
export interface FacadeWindowStyle {
  /** Wall metres per window column. */
  colSpacing: number;
  /** Wall metres per window row. */
  rowSpacing: number;
  /** Probability a grid slot is left blank (so it isn't a perfect grid). */
  skipProb: number;
  /** How far the window stands proud of the facade (metres). */
  faceOffset: number;
  /** Rotate back-face windows 180° — needed for one-sided textured cards. */
  flipBackFace: boolean;
  /** Instance geometry + material for the chunk's window batch. */
  createTemplate(): FacadeWindowTemplate;
}

/** Internal terrain-style id. `cuphead` maps to `paper`. */
export type TerrainStyle = 'plastic' | 'paper';

/** Map the config world-style value to the Three.js terrain style. */
export function terrainStyleFromWorldStyle(world: WorldStyle): TerrainStyle {
  return world === 'cuphead' ? 'paper' : 'plastic';
}

/**
 * Live-tunable parameters. Surfaced as sliders in the in-game debug panel so
 * the user can find the "good-looking but not laggy" sweet spot on Windows,
 * then hard-code the values. Split into geometry (needs a terrain rebuild) and
 * post/material (updates live).
 */
export interface StyleParams {
  // ── Quantised terrain engine (P1) ──
  /** Master toggle for height quantisation (stairs). */
  quantEnabled: boolean;
  /** Vertical step height in metres (blocks: small, paper: larger sheets). */
  layerHeight: number;
  /** Horizontal cell size in metres — world-aligned grid resolution. */
  gridSize: number;

  // ── Block height jitter (plastic, P2) ──
  /**
   * Max per-cell DOWNWARD sink in metres, applied after quantisation, so blocks
   * on the same layer sit at slightly different heights (toy-brick look).
   * Downward-only: overlays (roads, landuse, trees, buildings) are placed at
   * the quantised layer height, so a raised block would impale them. 0 = flat.
   */
  heightJitter: number;

  // ── Corrugated paper (paper, P3) ──
  /** Strength of the corrugation ripple on vertical sheet edges (0 = flat). */
  corrugationStrength: number;

  // ── Ink outline (paper, P3) ──
  inkEnabled: boolean;
  /** Inverted-hull thickness in metres. */
  inkThickness: number;
  /** Outline colour (hex). */
  inkColor: number;

  // ── Paper post-process (paper) ──
  paperPosterize: number;   // 0-1 blend of posterised colour
  paperDesaturate: number;  // 0-1 desaturation toward matte
  paperFiber: number;       // 0-1 fibre multiply strength
  paperStrength: number;    // 0-1 master fade of the whole pass
}

/**
 * Visual-style strategy consumed by every Three.js terrain renderer.
 *
 * Material factories follow the existing lifecycle:
 *  - `createBuildingMaterial()` returns a shared singleton (owned + disposed by
 *    the strategy). Renderers must NOT dispose it.
 *  - all other `create*Material()` return a fresh instance per call; the
 *    renderer that created the mesh disposes it (unchanged from today).
 */
export interface TerrainStyleStrategy {
  readonly style: TerrainStyle;
  readonly params: StyleParams;

  // ── Colours (same-zone-same-colour logic lives per style) ──
  terrainVertexColor(elevation: number, worldX: number, worldZ: number): THREE.Color;
  buildingColor(lon: number, lat: number): number;
  roadColor(roadClass: string): number;
  roadWidth(roadClass: string): number;
  urbanColor(cls: string): number;
  readonly treeTrunkColor: number;
  readonly treeCanopyColors: readonly number[];
  /**
   * Roof colour for extruded buildings. When set, up-facing vertices get this
   * colour instead of the wall colour — paper uses raw kraft so buildings read
   * as cardboard boxes (printed sides, raw board top). Omit for single-colour.
   */
  readonly buildingTopColor?: number;

  // ── Material factories ──
  createTerrainMaterial(): THREE.Material;
  /**
   * Material for the quantised terrain's vertical faces (step risers, drop
   * walls, boundary skirts — geometry group 1). Paper returns a raw-kraft
   * corrugated-texture material so every cut edge shows the board core; when
   * omitted the walls use `createTerrainMaterial()` (plastic: darkened
   * vertex-colour risers). Fresh instance per call; disposed with the chunk.
   */
  createTerrainWallMaterial?(): THREE.Material;
  /** Shared singleton — do NOT dispose from renderers. */
  createBuildingMaterial(): THREE.Material;
  createRoadMaterial(color: number): THREE.Material;
  createWaterMaterial(): THREE.Material;
  createParkMaterial(): THREE.Material;
  createForestMaterial(): THREE.Material;
  createSandMaterial(): THREE.Material;
  createUrbanMaterial(color: number): THREE.Material;
  createTreeMaterial(): THREE.Material;

  // Ground overlays for the landuse classes the map survey showed we fetch but
  // never drew (see plan/map-elements-expansion.md). Fresh instance per call,
  // same ownership as the factories above.
  /** Marsh / bog (`landcover: wetland`) — speckled teal paper / translucent jelly brick. */
  createWetlandMaterial(): THREE.Material;
  /** Fields (`landcover: farmland`) — ploughed-stripe kraft / picnic-check board. */
  createFarmlandMaterial(): THREE.Material;
  /** Pitches & playgrounds (`landuse: pitch|playground|track|stadium`) — bright green with white court lines. */
  createSportsFieldMaterial(): THREE.Material;

  // ── Third-person diorama props (all procedural, zero assets) ──

  /**
   * The rider's bike ornament — cuphead: a bent-paperclip bike; plastic: a toy
   * brick bike. Animation lives in `bike-ornament.ts`; this only builds parts.
   */
  buildBikeOrnament(): BikeOrnamentParts;

  /**
   * A toy aircraft for aerodromes — cuphead: a tethered plane-shaped balloon
   * (origin at the ground anchor, balloon floating above on its string);
   * plastic: a brick plane parked on the ground (origin at ground). Free it
   * with `disposeGroup` from bike-ornament.ts.
   */
  buildPlaneOrnament(): THREE.Group;

  /**
   * Normalised peak heights (0..1, `segments + 1` entries, first == last) for
   * one ring of the distant mountain silhouette. cuphead → jagged triangular
   * peaks with the odd flat top; plastic → sine mix quantised to brick steps.
   * Mirrors Phaser 2D's `generateMountainPoints` so both renderers agree.
   */
  generateMountainProfile(layer: MountainLayer, seed: number, segments: number): number[];

  /** Silhouette colour of a mountain ring (near ring reads darker). */
  mountainColor(layer: MountainLayer): number;

  /** Colour of the horizon disc the whole diorama sits on (desk / play-mat). */
  readonly horizonColor: number;

  /** The route mark laid over the road — highlighter pen / neon tape. */
  readonly routeLine: RouteLineStyle;

  /** Day/night end points — sky gradient, fog, and light colours/intensities. */
  readonly skyPalette: SkyPalette;

  /** A roadside lamp — cuphead: pencil lamp; plastic: brick lamp. */
  buildStreetLamp(): StreetLampParts;

  /** One collectible coin — cuphead: gold push-pin; plastic: stud-topped disc. */
  buildCoinMesh(): THREE.Mesh;

  /** A checkpoint marker — cuphead: pin + sticky-note flag; plastic: brick flag. */
  buildCheckpoint(color: THREE.ColorRepresentation, index: number): THREE.Group;

  /**
   * Roof trim for one building box (the walls themselves stay the merged
   * extrusion). Returns an object3D placed in scene coordinates, or null.
   * Materials used here MUST be strategy-owned singletons tagged
   * `material.userData.shared = true` so the chunk disposer leaves them alone.
   *
   * Windows do NOT belong here — see `facadeWindows`.
   */
  buildBuildingDecoration(box: BuildingBox, seed: number): THREE.Object3D | null;

  /** Facade-window knobs — the building renderer does the placing/batching. */
  readonly facadeWindows?: FacadeWindowStyle;

  /**
   * When false the tree renderer skips per-instance canopy tinting — paper's
   * cut-card trees carry their colours in the cutout texture and would be
   * washed green by an instanceColor multiply.
   */
  readonly tintTreeInstances: boolean;

  /**
   * When false the tree renderer skips the ink outline. An inverted hull of an
   * alpha-cut card is a SOLID black quad (the hull material has no alpha map),
   * which would stamp black rectangles behind every cut-out tree.
   */
  readonly outlineTrees: boolean;

  // ── Geometry hooks (P1-P3) ──
  /**
   * Quantise an ABSOLUTE elevation (metres, DEM/GPX — NOT origin-relative) to
   * the strategy's discrete layer grid. Absolute so the layer phase is fixed in
   * world space and stays seamless as the floating origin shifts. Identity when
   * `params.quantEnabled` is false. Callers subtract the origin afterwards.
   */
  quantizeElevation(absoluteElevation: number): number;

  /**
   * Build a geometry for one tree instance (blocks → stacked cuboids; paper →
   * cut card). When omitted the tree renderer uses its default cone+cylinder.
   */
  buildTreeGeometry?(): THREE.BufferGeometry;

  /**
   * Build a black ink outline for a source mesh via the inverted-hull method
   * (paper P3). Returns a mesh to add to the scene, or null.
   */
  createOutline?(source: THREE.Mesh): THREE.Mesh | null;

  // ── Post-processing ──
  /**
   * Create the style's screen-space post pass (paper → paper-craft pass;
   * plastic → null). Owned by the caller once returned.
   */
  createPostPass(width: number, height: number): ShaderPass | null;

  /** Push current `params` into a live post pass created by `createPostPass`. */
  applyPostParams(pass: ShaderPass): void;

  /** Dispose strategy-owned singletons (building material, etc.). */
  dispose(): void;
}

/**
 * Factory — dynamic import so each style is code-split (mirrors
 * `createStyleStrategy` for Phaser).
 */
export async function createTerrainStyleStrategy(
  style: TerrainStyle,
): Promise<TerrainStyleStrategy> {
  if (style === 'paper') {
    const { createPaperTerrainStyle } = await import('./paper-terrain-style');
    return createPaperTerrainStyle();
  }
  const { createPlasticTerrainStyle } = await import('./plastic-terrain-style');
  return createPlasticTerrainStyle();
}

/**
 * Deterministic RNG (mulberry32) — same generator the demos and the Phaser
 * mountains use, so a given seed reproduces the same skyline every time.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Snap an absolute elevation to the discrete layer grid. Shared by both styles.
 * Identity when quantisation is off or the layer height is degenerate.
 */
export function quantizeToLayer(absoluteElevation: number, params: StyleParams): number {
  if (!params.quantEnabled || params.layerHeight <= 0.01) return absoluteElevation;
  return Math.round(absoluteElevation / params.layerHeight) * params.layerHeight;
}

/** Default parameters per style. Tuned conservatively; user refines via panel. */
export function defaultStyleParams(style: TerrainStyle): StyleParams {
  if (style === 'paper') {
    return {
      quantEnabled: true,
      layerHeight: 12,     // taller cardboard sheets
      gridSize: 32,        // coarse (perf-safe default; user tunes finer)
      heightJitter: 0,     // sheets stay perfectly flat
      corrugationStrength: 1.0,
      inkEnabled: true,
      inkThickness: 0.35,
      inkColor: 0x1a1208,  // near-black warm brown
      paperPosterize: 0.6,
      paperDesaturate: 0.5,
      paperFiber: 0.35,
      paperStrength: 1.0,
    };
  }
  return {
    quantEnabled: true,
    layerHeight: 6,        // small cubic steps
    gridSize: 24,          // block size (perf-safe default; user tunes finer)
    heightJitter: 1.5,     // subtle per-block sink → same-layer blocks vary
    corrugationStrength: 0,
    inkEnabled: false,
    inkThickness: 0,
    inkColor: 0x000000,
    paperPosterize: 0,
    paperDesaturate: 0,
    paperFiber: 0,
    paperStrength: 0,
  };
}
