/**
 * Generic render-layer bisect — every mesh in the scene, grouped by what it is,
 * with a switch per group.
 *
 * ## Why generic
 *
 * Hunting one artefact by hand-writing a toggle per suspect (roads, terrain
 * walls, the mountain ring, cloud shadows…) costs a code change and a ride per
 * guess, and it can only ever test the suspects someone thought of. The thing
 * that stayed hidden longest here was the one mesh nobody had named. So this
 * derives the list FROM THE SCENE instead: whatever is in there shows up, named
 * or not, and can be switched off.
 *
 * Grouping follows the naming convention the renderers already use:
 *   `chunk3/landuse:park` → `landuse:park`   (per-chunk meshes group by kind)
 *   `route/core`          → `route`          (everything else groups by prefix)
 *   `mountainRing/near`   → `mountainRing`
 *   (no name)             → `<unnamed Mesh>` — always suspicious, never hidden
 *                                              in the noise of a shared bucket
 *
 * ## One caveat
 *
 * Un-hiding sets `visible = true`, which can briefly fight systems that own
 * visibility for their own reasons (chunk LOD, the entrance animation). They
 * re-assert themselves on their next update, so the worst case is a frame of
 * disagreement — acceptable for a debug tool, and the reason this never runs
 * unless the panel is open.
 */

import type * as THREE from 'three';

/**
 * Anything that puts pixels on screen — NOT just meshes. Checking `isMesh`
 * alone silently skipped sprites and lines, so a bisect that switched off
 * "everything" was not switching off everything.
 */
function isRenderable(o: THREE.Object3D): boolean {
  const any = o as unknown as {
    isMesh?: boolean; isPoints?: boolean; isSprite?: boolean;
    isLine?: boolean; isLineSegments?: boolean; isLineLoop?: boolean;
  };
  return !!(any.isMesh || any.isPoints || any.isSprite
    || any.isLine || any.isLineSegments || any.isLineLoop);
}

/** Group key for one object. */
export function layerKeyOf(o: THREE.Object3D): string {
  const name = o.name;
  if (!name) return `<unnamed ${o.type}>`;
  const slash = name.lastIndexOf('/');
  if (slash < 0) return name;
  const prefix = name.slice(0, slash);
  const suffix = name.slice(slash + 1);
  // Per-chunk meshes are `chunkN/<kind>` — group across chunks by kind, or
  // every chunk would get its own row and the list would be useless.
  if (/^chunk\d+$/.test(prefix)) return suffix.replace(/\d+$/, '');
  return prefix;
}

export interface SceneLayer {
  key: string;
  /** How many objects are in this group right now. */
  count: number;
  hidden: boolean;
}

const hiddenKeys = new Set<string>();

/** Walk the scene and report the layers present, with their current state. */
export function scanSceneLayers(scene: THREE.Object3D): SceneLayer[] {
  const counts = new Map<string, number>();
  scene.traverse((o) => {
    if (!isRenderable(o) || o.name === 'debug/hoverHighlight') return;
    const key = layerKeyOf(o);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts]
    .map(([key, count]) => ({ key, count, hidden: hiddenKeys.has(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function setSceneLayerHidden(key: string, hidden: boolean): void {
  if (hidden) hiddenKeys.add(key);
  else hiddenKeys.delete(key);
}

export function isSceneLayerHidden(key: string): boolean {
  return hiddenKeys.has(key);
}

export function anySceneLayerHidden(): boolean {
  return hiddenKeys.size > 0;
}

/**
 * Push the hidden set onto the scene. Must be re-run as chunks stream in —
 * a mesh built after the switch was flipped has never seen it.
 */
export function applySceneLayerVisibility(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    if (!isRenderable(o) || o.name === 'debug/hoverHighlight') return;
    const hide = hiddenKeys.has(layerKeyOf(o));
    // Only ever force FALSE. Forcing true would stomp on chunk LOD and the
    // entrance animation, which legitimately hide things.
    if (hide) o.visible = false;
    else if (o.userData._debugLayerHidden) o.visible = true;
    o.userData._debugLayerHidden = hide;
  });
}

/** Hide every layer currently present.
 *
 *  This is the question "is the artefact even WebGL?" as a single button. With
 *  nothing in the scene drawn and post-processing bypassed, the canvas should
 *  be flat clear-colour. Anything still visible after that is not coming from
 *  the 3D renderer at all, and the search moves to the DOM overlays. */
export function hideAllSceneLayers(scene: THREE.Object3D): void {
  for (const l of scanSceneLayers(scene)) hiddenKeys.add(l.key);
  applySceneLayerVisibility(scene);
}

/** Show ONE layer and hide the rest — far faster than un-ticking 30 boxes when
 *  you want to know what a single layer contributes. */
export function soloSceneLayer(scene: THREE.Object3D, key: string): void {
  hiddenKeys.clear();
  for (const l of scanSceneLayers(scene)) if (l.key !== key) hiddenKeys.add(l.key);
  applySceneLayerVisibility(scene);
}

/** Show everything again. */
export function resetSceneLayers(scene: THREE.Object3D): void {
  hiddenKeys.clear();
  applySceneLayerVisibility(scene);
}
