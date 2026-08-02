/**
 * Toon-shading mechanism.
 *
 * What is left here is deliberately small, and the reason is
 * `plan/world-modularity-refactor.md` step 1: this file used to be 297 lines of
 * which 20 exports were the PLASTIC world's palette and material factories,
 * with `plastic-terrain-style.ts` as the only importer. A shelf exactly one
 * world uses is not a shared shelf — it is that world, split in half, with the
 * half that carries its look wearing a mechanism's name.
 *
 * That is not tidiness. It is the one class of porting drift per-item demo
 * diffing cannot catch: a diff compares geometry and material parameters, it
 * does not read imports, so when the plastic tree took `TREE_CANOPY_COLORS` off
 * this shelf instead of the demo's `COIL_GREENS`, the triangle stream looked
 * perfectly healthy — the colour it got was *a* colour, just the wrong one.
 *
 * Those 20 exports (palettes, `create*ToonMaterial`, `ROAD_WIDTHS` /
 * `roadWidthForClass`, the terrain colour ramp) now live in
 * `plastic-materials.ts`. `scripts/headless-check/world-boundary.ts` reads the
 * import graph and fails if any `*-terrain-style.ts` reaches for another
 * world's shelf, or for a palette / material factory on a shared one.
 *
 * What stays is mechanism — nothing here decides how a world looks:
 *  - `GRADIENT_MAP`: the ramp texture a `MeshToonMaterial` samples. The look
 *    decision is the colour fed to the material, not the ramp.
 *  - `simpleNoise2D`: a hash-based 2D value noise.
 */

import * as THREE from 'three';

// ── Gradient map (shared by all toon materials) ──

/** 4-step gradient → discrete light/shadow bands like plastic toys. */
function createGradientMap(): THREE.DataTexture {
  const data = new Uint8Array([
    Math.round(0.15 * 255),
    Math.round(0.4 * 255),
    Math.round(0.75 * 255),
    255,
  ]);
  const texture = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export const GRADIENT_MAP = createGradientMap();

// ── Utilities ──

/**
 * Simple 2D value noise (not true Perlin, but sufficient for terrain color patches).
 * Returns value in [0, 1].
 */
export function simpleNoise2D(x: number, y: number): number {
  // Hash-based pseudo-random using sin
  const dot = x * 12.9898 + y * 78.233;
  const s = Math.sin(dot) * 43758.5453;
  return s - Math.floor(s);
}
