/**
 * Building window lights (F2, 3D) — warm emissive quads on building facades that
 * fade in at night. Generated per chunk alongside the extruded building mesh
 * (reusing its already-sampled base elevation) and collected into a single
 * InstancedMesh (one draw call per chunk). All chunks share one material whose
 * opacity is driven globally by the night factor, so a single write lights the
 * whole city.
 *
 * No real lights — these are unlit additive quads (a few hundred PointLights
 * would wreck the frame budget). One warm colour serves both world styles.
 */

import * as THREE from 'three';

/** Storeys are ~3.5m; windows every ~4m along a wall; ~35% are lit. */
const FLOOR_HEIGHT = 3.5;
const WINDOW_SPACING = 4;
const WINDOW_ON_PROB = 0.35;
const WINDOW_W = 1.1;
const WINDOW_H = 1.4;
/** Cap per chunk — a dense downtown chunk is seeded-subsampled past this. */
const WINDOW_MAX_PER_CHUNK = 1500;

export interface WindowPlacement {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/** Deterministic 0..1 hash so a building's lit windows are stable across rebuilds. */
function hash(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

// Shared singleton material — opacity driven globally by the night factor.
let _windowMat: THREE.MeshBasicMaterial | null = null;
export function windowLightMaterial(): THREE.MeshBasicMaterial {
  if (!_windowMat) {
    _windowMat = new THREE.MeshBasicMaterial({
      color: 0xffdd88,          // warm interior light
      transparent: true,
      opacity: 0,               // day: invisible
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
  }
  return _windowMat;
}

/** Set the shared window-light opacity (0 day → ~0.9 deep night). */
export function setWindowLightOpacity(o: number): void {
  if (_windowMat) _windowMat.opacity = o;
}

/**
 * Collect lit-window placements for one building footprint. Walks each wall edge
 * and, per floor per window slot, keeps a deterministic ~35%. `baseY` is the
 * origin-relative ground height the building sits on; `coords` are [lon,lat].
 */
export function collectBuildingWindows(
  coords: [number, number][],
  originLat: number,
  originLon: number,
  cosOrigin: number,
  baseY: number,
  height: number,
  out: WindowPlacement[],
): void {
  const floors = Math.max(1, Math.floor(height / FLOOR_HEIGHT));
  const pts = coords.map(([lon, lat]): [number, number] => [
    (lon - originLon) * 111320 * cosOrigin,
    -(lat - originLat) * 111320,
  ]);

  for (let e = 0; e < pts.length - 1; e++) {
    const [x0, z0] = pts[e];
    const [x1, z1] = pts[e + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz);
    if (L < 2) continue;
    // Wall-perpendicular (either side — DoubleSide quads don't care), as a Y rotation.
    const nx = dz / L, nz = -dx / L;
    const rotY = Math.atan2(nx, nz);
    const slots = Math.max(1, Math.floor(L / WINDOW_SPACING));

    for (let f = 0; f < floors; f++) {
      const y = baseY + f * FLOOR_HEIGHT + FLOOR_HEIGHT * 0.5;
      for (let s = 0; s < slots; s++) {
        if (hash(x0 * 0.7 + z0 * 0.31 + e * 13.1 + s * 2.7 + f * 5.3) >= WINDOW_ON_PROB) continue;
        const t = (s + 0.5) / slots;
        out.push({
          x: x0 + dx * t + nx * 0.08, // nudge just outside the wall
          y,
          z: z0 + dz * t + nz * 0.08,
          rotY,
        });
      }
    }
  }
}

/**
 * Build one InstancedMesh from placements, evenly subsampled past `maxCount`
 * (deterministic — same placements, same survivors). Shared by the window
 * lights and the facade-window batches in building-renderer.ts.
 */
export function buildPlacementInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  placements: WindowPlacement[],
  maxCount: number,
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const step = Math.max(1, Math.ceil(placements.length / maxCount));
  const count = Math.ceil(placements.length / step);

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  let n = 0;
  for (let i = 0; i < placements.length && n < count; i += step) {
    const p = placements[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.rotY, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(n++, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  // InstancedMesh frustum culling uses one instance's bounds → can wrongly cull
  // the whole batch. Rely on chunk load/unload instead.
  mesh.frustumCulled = false;
  return mesh;
}

/** Build one InstancedMesh from collected placements (subsampled to the cap). */
export function buildWindowLightMesh(placements: WindowPlacement[]): THREE.InstancedMesh | null {
  return buildPlacementInstancedMesh(
    new THREE.PlaneGeometry(WINDOW_W, WINDOW_H),
    windowLightMaterial(),
    placements,
    WINDOW_MAX_PER_CHUNK,
  );
}

/** Dispose a window-light mesh (material is a shared singleton — keep it). */
export function disposeWindowLightMesh(mesh: THREE.InstancedMesh): void {
  mesh.geometry.dispose();
  // Frees the instanceMatrix GPU buffer — geometry.dispose() does not reach it
  // (it lives on the mesh), and without this the buffer waits for JS GC.
  mesh.dispose();
}
