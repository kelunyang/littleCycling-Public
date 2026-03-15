/**
 * Route line mesh: renders the GPX route as a bright neon line
 * with animated arrow-shaped runway indicator lights.
 *
 * Visual: bright core line (bloom creates the neon glow) + arrow lights chasing forward.
 * Returns a THREE.Group containing all sub-objects.
 *
 * Objects are placed on BLOOM_LAYER so the selective bloom pass
 * in CyclingGlassesEffect creates the neon halo automatically.
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import type { RoutePoint } from '@littlecycling/shared';

/** Bloom layer index — objects on this layer are rendered by the bloom pass. */
export const BLOOM_LAYER = 1;

/** Route line color (warm gold, not too saturated). */
const ROUTE_COLOR = 0xe0a820;

/** Core line width in pixels. */
const CORE_WIDTH = 32;

/** Height offset above ground in meters. */
const HEIGHT_OFFSET = 5;

/** Distance between arrow lights in meters. */
const ARROW_SPACING = 12;

/** Arrow light plane size in meters (small — contained within line). */
const ARROW_SIZE = 0.75;

/** Arrow wave speed (meters per second). */
const ARROW_WAVE_SPEED = 30;

/** Arrow wave length (meters). */
const ARROW_WAVE_LENGTH = 80;

export interface RouteLineMeshOptions {
  color?: number;
  heightOffset?: number;
}

// ── Helpers ──

/** Convert RoutePoints to flat [x,y,z, ...] scene-meter array. */
function toScenePositions(
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  heightOffset: number,
): number[] {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const positions: number[] = [];
  for (const p of points) {
    positions.push(
      (p.lon - originLon) * 111320 * cosOrigin,
      heightOffset,
      -(p.lat - originLat) * 111320,
    );
  }
  return positions;
}

/** Create a procedural arrow/chevron glow texture on canvas. */
function createArrowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Clear
  ctx.clearRect(0, 0, size, size);

  // Draw a chevron arrow pointing up (^)
  const cx = size / 2;
  const tipY = size * 0.15;
  const baseY = size * 0.75;
  const wingX = size * 0.42;
  const innerX = size * 0.12;
  const innerY = size * 0.5;

  ctx.beginPath();
  // Left arm
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - wingX, baseY);
  ctx.lineTo(cx - innerX, innerY);
  // Right arm
  ctx.lineTo(cx, tipY + (innerY - tipY) * 0.3);
  ctx.lineTo(cx + innerX, innerY);
  ctx.lineTo(cx + wingX, baseY);
  ctx.closePath();

  // Glow fill with gradient
  const gradient = ctx.createLinearGradient(cx, tipY, cx, baseY);
  gradient.addColorStop(0, 'rgba(255, 255, 240, 1.0)');
  gradient.addColorStop(0.4, 'rgba(255, 225, 100, 0.9)');
  gradient.addColorStop(1, 'rgba(255, 200, 50, 0.4)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Soft outer glow via shadow trick
  ctx.globalCompositeOperation = 'destination-over';
  ctx.shadowColor = 'rgba(255, 215, 0, 0.6)';
  ctx.shadowBlur = 8;
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Build arrow InstancedMesh along the route positions. */
function buildArrowLights(
  positions: number[],
  _color: number,
): {
  mesh: THREE.InstancedMesh;
  distances: Float32Array;
  totalDist: number;
} | null {
  const pointCount = positions.length / 3;
  if (pointCount < 2) return null;

  // Walk along route, collect arrow placements
  const placements: { x: number; y: number; z: number; angle: number; dist: number }[] = [];
  let cumDist = 0;
  let accumulated = ARROW_SPACING * 0.5;

  for (let i = 0; i < pointCount - 1; i++) {
    const i3 = i * 3;
    const x0 = positions[i3],     y0 = positions[i3 + 1], z0 = positions[i3 + 2];
    const x1 = positions[i3 + 3], y1 = positions[i3 + 4], z1 = positions[i3 + 5];

    const dx = x1 - x0;
    const dz = z1 - z0;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.001) continue;

    const angle = Math.atan2(dx, dz); // rotation around Y

    accumulated += segLen;
    while (accumulated >= ARROW_SPACING) {
      accumulated -= ARROW_SPACING;
      const t = Math.max(0, Math.min(1, 1 - accumulated / segLen));
      placements.push({
        x: x0 + dx * t,
        y: y0 + (y1 - y0) * t + 0.1, // tiny offset above line
        z: z0 + dz * t,
        angle,
        dist: cumDist + segLen * t,
      });
    }
    cumDist += segLen;
  }

  if (placements.length === 0) return null;

  // Flat plane geometry lying in XZ, arrow texture points in +Z
  const geo = new THREE.PlaneGeometry(ARROW_SIZE, ARROW_SIZE);
  // Rotate plane from XY to XZ (face up); +PI/2 so chevron tip (+Y) maps to +Z,
  // aligning with atan2(dx, dz) heading. DoubleSide ensures visibility from above.
  geo.rotateX(Math.PI / 2);

  const texture = createArrowTexture();
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: true,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.InstancedMesh(geo, material, placements.length);
  mesh.name = 'arrowLights';
  // Enable bloom layer so arrows also get neon glow
  mesh.layers.enable(BLOOM_LAYER);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(placements.length * 3),
    3,
  );

  const distances = new Float32Array(placements.length);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.angle, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    distances[i] = p.dist;
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;

  return { mesh, distances, totalDist: cumDist };
}

// ── Public API ──

/**
 * Create a route line group: bright core (bloom creates neon halo) + arrow runway lights.
 */
export function createRouteLine(
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  _originEle: number,
  resolution: { width: number; height: number },
  options?: RouteLineMeshOptions,
): THREE.Group {
  const color = options?.color ?? ROUTE_COLOR;
  const heightOffset = options?.heightOffset ?? HEIGHT_OFFSET;
  const res = new THREE.Vector2(resolution.width, resolution.height);
  const positions = toScenePositions(points, originLat, originLon, heightOffset);

  const group = new THREE.Group();
  group.userData._routeColor = color;
  group.userData._routeRes = res;
  group.userData._routePositions = positions.slice();

  // Solid core line — bright, opaque.
  // Bloom pass will pick this up and create the neon glow halo.
  const coreGeo = new LineGeometry();
  coreGeo.setPositions(positions);
  const coreMat = new LineMaterial({
    color,
    linewidth: CORE_WIDTH,
    resolution: res,
    transparent: false,
    fog: true,
  });
  const core = new Line2(coreGeo, coreMat);
  core.name = 'core';
  core.renderOrder = 2;
  // Enable bloom layer for neon glow
  core.layers.enable(BLOOM_LAYER);
  group.add(core);

  // Arrow runway lights
  const arrows = buildArrowLights(positions, color);
  if (arrows) {
    arrows.mesh.renderOrder = 3;
    group.add(arrows.mesh);
    group.userData._arrowDistances = arrows.distances;
    group.userData._arrowTotalDist = arrows.totalDist;
  }

  return group;
}

/**
 * Animate arrow runway lights — call once per frame.
 * Creates a "chase" wave of brightness traveling forward along the route.
 */
export function animateRouteLine(group: THREE.Group, time: number): void {
  const mesh = group.getObjectByName('arrowLights') as THREE.InstancedMesh | undefined;
  if (!mesh || !mesh.instanceColor) return;

  const distances = group.userData._arrowDistances as Float32Array | undefined;
  const totalDist = group.userData._arrowTotalDist as number | undefined;
  if (!distances || !totalDist) return;

  const colorArr = mesh.instanceColor.array as Float32Array;
  const wavePos = (time * ARROW_WAVE_SPEED) % totalDist;

  for (let i = 0; i < distances.length; i++) {
    const delta = (distances[i] - wavePos + totalDist) % totalDist;
    const phase = (delta % ARROW_WAVE_LENGTH) / ARROW_WAVE_LENGTH;
    // Sharp bright pulse at wave front, fading behind
    const intensity = 0.15 + 0.85 * Math.exp(-phase * 4);
    const i3 = i * 3;
    colorArr[i3] = intensity;
    colorArr[i3 + 1] = intensity;
    colorArr[i3 + 2] = intensity;
  }

  mesh.instanceColor.needsUpdate = true;
}

/**
 * Update the route line when the floating origin changes.
 */
export function updateRouteLineOrigin(
  group: THREE.Group,
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  _originEle: number,
  heightOffset = HEIGHT_OFFSET,
): void {
  const color = group.userData._routeColor as number;
  const positions = toScenePositions(points, originLat, originLon, heightOffset);
  group.userData._routePositions = positions.slice();

  // Update line geometry
  const core = group.getObjectByName('core') as Line2 | undefined;
  if (core) (core.geometry as LineGeometry).setPositions(positions);

  // Rebuild arrow lights
  disposeChild(group, 'arrowLights');
  const arrows = buildArrowLights(positions, color);
  if (arrows) {
    arrows.mesh.renderOrder = 3;
    group.add(arrows.mesh);
    group.userData._arrowDistances = arrows.distances;
    group.userData._arrowTotalDist = arrows.totalDist;
  }
}

/**
 * Project the route line onto terrain by raycasting.
 */
export function projectRouteLineOntoTerrain(
  group: THREE.Group,
  raycastFn: (x: number, z: number) => number | null,
  heightOffset = HEIGHT_OFFSET,
): number {
  const positions = group.userData._routePositions as number[] | undefined;
  if (!positions) return 0;

  const pointCount = positions.length / 3;
  let projected = 0;

  for (let i = 0; i < pointCount; i++) {
    const i3 = i * 3;
    const groundY = raycastFn(positions[i3], positions[i3 + 2]);
    if (groundY !== null) {
      positions[i3 + 1] = groundY + heightOffset;
      projected++;
    }
  }

  // Update line geometry
  const core = group.getObjectByName('core') as Line2 | undefined;
  if (core) (core.geometry as LineGeometry).setPositions(positions);

  // Rebuild arrow lights with updated heights
  const color = group.userData._routeColor as number;
  disposeChild(group, 'arrowLights');
  const arrows = buildArrowLights(positions, color);
  if (arrows) {
    arrows.mesh.renderOrder = 3;
    group.add(arrows.mesh);
    group.userData._arrowDistances = arrows.distances;
    group.userData._arrowTotalDist = arrows.totalDist;
  }

  return projected;
}

/** Dispose all route line resources. */
export function disposeRouteLine(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof Line2) {
      child.geometry.dispose();
      (child.material as LineMaterial).dispose();
    } else if (child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
      const mat = child.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  }
  group.clear();
}

// ── Internal ──

function disposeChild(group: THREE.Group, name: string): void {
  const obj = group.getObjectByName(name);
  if (!obj) return;
  group.remove(obj);
  if (obj instanceof THREE.InstancedMesh) {
    obj.geometry.dispose();
    const mat = obj.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  } else if (obj instanceof Line2) {
    obj.geometry.dispose();
    (obj.material as LineMaterial).dispose();
  }
}
