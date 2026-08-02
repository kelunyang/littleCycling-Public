/**
 * Night lights on buildings (3D) — the ONE global write that tells every world
 * how dark it is, plus the batching for the one world whose lights are quads.
 *
 * ## What used to be here, and why it is gone
 *
 * Two generic window GRIDS lived in this file and in `building-renderer.ts`:
 *
 *  1. `collectBuildingWindows()` — walked every wall edge of every footprint,
 *     every ~3.5 m storey × every ~4 m slot, kept a hashed 35 %, and drew them
 *     as warm additive quads. It ran on EVERY building in EVERY world.
 *  2. `collectFacadeWindowPlacements()` + `facadeWindows` — took the oriented
 *     box, split it `width / colSpacing` × `height / rowSpacing`, and stamped
 *     one fixed-size window template on the two long faces.
 *
 * **Neither exists in any of the three demos, and the demos are the spec.**
 * `plan/plastic-town-demo.html` deletes its own version in as many words:
 *
 *   > 這裡原本有一個 addWindows(parent, w, h, d, rows, cols, yBase)… 它是
 *   > gameview 的 collectFacadeWindowPlacements() 的縮影,而且**已經沒有人呼叫
 *   > 它了** —— 現在連函式一起刪掉…那個網格完全不知道自己蓋在什麼上面。
 *
 * The rule that replaces them (CUSTOM_WORLD_INSTRUCTIONS §3.9) is that the
 * thing which decides a building's SHAPE decides its LIGHTS, and all three
 * demos take one of exactly two routes:
 *
 *  · **Route A — the light IS one of the body's own materials.** Registered
 *    once where the material is built, driven by one global write per frame.
 *    That is `glowAtNight()` in the toy demo, `nightLit()` in the corrugated
 *    one, and the `EMISSIVE_PARTS` table in the circuit one. Zero geometry,
 *    zero draw calls. **This is the route two of the three worlds use for
 *    everything**, and it is why `registerNightLitMaterial` below survives the
 *    cull: it is not part of the grid, it is the demos' own mechanism.
 *  · **Route B — the light is a QUAD over a face the body already has.** Only
 *    the toy demo has one (`emitSlabFaceLights` → `winLightMat` + `winQuadGeo`,
 *    one InstancedMesh per chunk). Every quad carries its OWN width and height
 *    — the demo's `lights: [[x, y, z, ry, w, h]]` — because it is sized to the
 *    slab end it covers. There is no such thing as "the window size".
 *
 * So: no grid, no shared window template, and a placement is only ever a light
 * the style itself declared.
 */

import * as THREE from 'three';

/** Cap on declared light quads batched per chunk (subsampled evenly past it). */
const BUILDING_LIGHT_MAX_PER_CHUNK = 3000;

/**
 * One light quad a style declared, in the building box's LOCAL frame — the
 * demo's `[x, y, z, ry, w, h]`, field for field.
 *
 * `w`/`h` are the quad's own size in metres and are NOT optional: the whole
 * point of retiring the facade grid is that a light is sized to the thing it
 * lights (a slab end, a lit voxel's face), not to one template stamped
 * world-wide. The renderer scales a unit plane by them.
 */
export interface WindowPlacement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  /**
   * Pitch and roll, for a light that sits on a part which is not upright.
   *
   * Both default to 0, which is every light this file was written for: a quad
   * standing flat against a facade needs a yaw and nothing else. The corrugated
   * world's tab dispenser is what forced them — its index tabs lean out of the
   * lid and droop out of the dispensing lip, each by its own angle, and a light
   * that could only yaw would have to either float off the tab it is supposed to
   * be coming out of or have the tab straightened to meet it. Straightening the
   * MODEL to fit the light is exactly backwards: §3.9's rule is that the thing
   * which decides the shape decides the lights.
   *
   * Read as a three `Euler` in its default XYZ order, the same order `BoxPart`
   * uses — and composed with the building's own yaw as QUATERNIONS on the way
   * out of the style's local frame, because `Ry · Rxyz` is not an Euler triple.
   * See `pushBodyBoxes`, which had already paid for this.
   */
  rotX?: number;
  rotZ?: number;
  /** Quad width, metres. */
  w: number;
  /** Quad height, metres. */
  h: number;
  /**
   * Which of the style's light materials this quad takes
   * (`createBuildingLightMaterial`). Omit when a style has only one, which is
   * the toy world's case; the corrugated world has two because its demo gives
   * the abacus bead and the pill-box compartment different glows.
   */
  lit?: string;
}

/**
 * Fixed-capacity reservoir (classic algorithm-R) for light placements, so a
 * dense chunk's peak memory is the cap rather than every candidate. Seed the
 * RNG for a stable sample across rebuilds of the same chunk.
 */
export class WindowReservoir {
  readonly items: WindowPlacement[] = [];
  private seen = 0;

  constructor(
    private readonly cap: number,
    private readonly rng: () => number = Math.random,
  ) {}

  push(p: WindowPlacement): void {
    if (this.items.length < this.cap) {
      this.items.push(p);
    } else {
      // seen = candidates already processed; this one is 0-based index `seen`.
      const j = Math.floor(this.rng() * (this.seen + 1));
      if (j < this.cap) this.items[j] = p;
    }
    this.seen++;
  }
}

/** Make a reservoir sized to the per-chunk light cap (keeps the cap private). */
export function createBuildingLightReservoir(rng?: () => number): WindowReservoir {
  return new WindowReservoir(BUILDING_LIGHT_MAX_PER_CHUNK, rng);
}

/**
 * Materials a STYLE wants to glow at night — route A above, and the mechanism
 * all three demos actually use.
 *
 * The corrugated world lights a shopfront's plate glass, a tape roll's hub, one
 * whole bead colour on the abacus and alternate compartments of the pill-box
 * lid this way; the circuit world lights the nixie digits, the tube filament,
 * the LED die, the capacitor's crimp ring, the DIP's pin-root windows and the
 * transformer's lamination leak; the toy world lights the cup walls, the domino
 * pips, the letter rims and the clay house's yellow voxel. **Every one of those
 * is a part the building already had.** Nothing here places anything.
 *
 * So the same global night write drives them all: one call per frame, no
 * per-chunk or per-building state, and a style declares its glow once at
 * construction.
 *
 * Registration is by material identity, so registering the same shared
 * singleton twice is a no-op rather than a double-drive.
 */
type NightLitMaterial = THREE.Material & { emissive: THREE.Color };

interface NightLitEntry {
  glow: THREE.Color;
  /**
   * Hide the material outright by day.
   *
   * For route B only. The toy demo's light film is an UNLIT quad whose colour
   * is `WIN_LIT × k`, so at noon it is a black rectangle stuck on the wall —
   * which is why the demo turns the whole batch off (`m.visible = lit`, and it
   * notes the saved draw call and blend as the second reason). `Material.visible`
   * is checked in three's `projectObject`, so one write here drops the batch
   * from the render list for every chunk at once — the same one-write property
   * the emissive drive has, without a per-chunk registry to leak.
   */
  hideByDay: boolean;
}

const _nightLit = new Map<NightLitMaterial, NightLitEntry>();

export function registerNightLitMaterial(
  mat: NightLitMaterial,
  glowHex: number,
  opts: { hideByDay?: boolean } = {},
): void {
  _nightLit.set(mat, {
    glow: new THREE.Color(glowHex),
    hideByDay: opts.hideByDay === true,
  });
  // A day-hidden material must start hidden: a chunk built before the first
  // night write would otherwise show its quads at full black until one lands.
  if (opts.hideByDay === true) mat.visible = false;
}

/** Drop a style's entries — call from the strategy's `dispose()`, or a style
 *  swap leaves the old world's materials being written every frame. */
export function unregisterNightLitMaterial(mat: NightLitMaterial): void {
  _nightLit.delete(mat);
}

let _nightK = 0;

/**
 * The last value `setNightLitFactor` was given — a READ of the one night number,
 * not a second one.
 *
 * It exists for materials whose night behaviour cannot ride `emissive`: the
 * circuit world's joint spark is an additive `MeshBasicMaterial` (the demo's
 * own choice — 「亮度靠 scale 動,不靠 opacity 動」 is about the pulse, while the
 * day→night level rides `opacity`), and a `MeshBasicMaterial` has no emissive
 * for `setNightLitFactor` to write. The alternative was for that style to take
 * a night factor through its own per-frame channel, which would have made two
 * numbers both called "how dark is it" — and the two would have drifted at the
 * first tweak to the dusk ramp. One writer, many readers.
 */
export function nightLitFactor(): number {
  return _nightK;
}

/** 0 day → 1 deep night. The one write the whole night pipeline runs on. */
export function setNightLitFactor(k: number): void {
  _nightK = k;
  for (const [mat, e] of _nightLit) {
    mat.emissive.copy(e.glow).multiplyScalar(k);
    // demo: `const lit = k > 0.02; … m.visible = lit`.
    if (e.hideByDay) mat.visible = k > 0.02;
  }
}

/**
 * Build one InstancedMesh from declared light quads, evenly subsampled past
 * `maxCount` (deterministic — same placements, same survivors).
 *
 * The instance matrix carries the quad's own `w`/`h` as a scale, which is the
 * demo's `ws.set(L[4], L[5], 1)`. A unit plane plus a per-instance scale is the
 * whole reason a style can size each light to what it lights.
 */
export function buildLightQuadInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  placements: WindowPlacement[],
  maxCount: number = BUILDING_LIGHT_MAX_PER_CHUNK,
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const step = Math.max(1, Math.ceil(placements.length / maxCount));
  const count = Math.ceil(placements.length / step);

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < placements.length && n < count; i += step) {
    const p = placements[i];
    pos.set(p.x, p.y, p.z);
    e.set(p.rotX ?? 0, p.rotY, p.rotZ ?? 0);
    q.setFromEuler(e);
    scl.set(p.w, p.h, 1);
    mesh.setMatrixAt(n++, m.compose(pos, q, scl));
  }
  mesh.instanceMatrix.needsUpdate = true;
  // InstancedMesh frustum culling uses one instance's bounds → can wrongly cull
  // the whole batch. Rely on chunk load/unload instead.
  mesh.frustumCulled = false;
  return mesh;
}

/** Dispose a light-quad batch (the material is a strategy-owned singleton). */
export function disposeLightQuadMesh(mesh: THREE.InstancedMesh): void {
  mesh.geometry.dispose();
  // Frees the instanceMatrix GPU buffer — geometry.dispose() does not reach it
  // (it lives on the mesh), and without this the buffer waits for JS GC.
  mesh.dispose();
}
