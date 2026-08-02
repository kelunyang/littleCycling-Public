/**
 * The one mesh that stands for "this layer exists but has nothing in it".
 *
 * ## Why this file exists
 *
 * Several renderers hand back a fixed set of layers per chunk whether or not the
 * map put anything in them — `landuse-renderer` builds nine ground covers,
 * `aeroway-renderer` one paving mesh — and the empty ones used to be
 * `new THREE.Mesh()`. That constructor is not free: three gives every one of
 * them **its own `BufferGeometry` and its own `MeshBasicMaterial`**, and both
 * land in the census as a unique geometry and a unique material.
 *
 * Measured on the Dazhi route (chunks 2-4, `render-probe.ts CENSUS=1`,
 * plastic): of **75 unique materials, 14 were this** — a white
 * `MeshBasicMaterial` belonging to a layer with no polygons, e.g.
 *
 * ```
 *   chunk2/landuse:wetland  chunk2/landuse:sand  chunk2/landuse:farmland  chunk2/aeroway
 *   chunk3/landuse:wetland  chunk3/landuse:sand  chunk3/landuse:farmland  chunk3/aeroway  chunk3/landuse:water
 *   chunk4/landuse:forest   chunk4/landuse:sand  chunk4/landuse:farmland  chunk4/aeroway  chunk4/landuse:playground
 * ```
 *
 * CUSTOM_WORLD_INSTRUCTIONS §6 puts unique material/geometry count third in the
 * priority order and sets the budget at **≤ 70**. Nineteen per cent of that
 * budget was going to three.js's defaults for objects that draw nothing — and
 * worse, they were making every census anyone took unreadable: a world could not
 * tell how close it was to the budget because a sixth of the number was noise.
 *
 * ## Why not `visible = false`
 *
 * Tried, and it does not survive: `TerrainChunkManager` re-writes `visible` on
 * every chunk mesh each frame (`m.visible = showOverlays`, the far-LOD rule), so
 * a flag set at build time is gone one frame later. Sharing the resources is the
 * fix that cannot be undone from outside.
 *
 * An empty geometry has no `position` attribute, so its bounding sphere keeps
 * three's default radius of −1 and the frustum test drops it before any GL call.
 * The cost was never the draw — it was the two objects per empty layer per
 * chunk, allocated, tracked, and counted.
 *
 * Both are tagged `userData.shared`, which every disposer in this package
 * already honours (`disposeLanduseMeshes`, `disposeGroup`,
 * `disposeAerowayMeshes`).
 */

import * as THREE from 'three';

let sharedGeometry: THREE.BufferGeometry | null = null;
let sharedMaterial: THREE.Material | null = null;

/**
 * A mesh with nothing in it, drawing nothing, costing one shared geometry and
 * one shared material for the whole application.
 *
 * The returned `Mesh` object itself is per-call — callers name it, position it
 * and re-parent it, and those are per-chunk facts.
 */
export function emptyMesh(): THREE.Mesh {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.BufferGeometry();
    sharedGeometry.userData.shared = true;
  }
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshBasicMaterial();
    sharedMaterial.userData.shared = true;
  }
  return new THREE.Mesh(sharedGeometry, sharedMaterial);
}

/** Whether this mesh is one of the empties — for checks and probes. */
export function isEmptyMesh(mesh: THREE.Object3D): boolean {
  const g = (mesh as THREE.Mesh).geometry;
  return !!sharedGeometry && g === sharedGeometry;
}
