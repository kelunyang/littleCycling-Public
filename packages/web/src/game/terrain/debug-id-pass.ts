/**
 * Object-ID pass — a debug mode that repaints every mesh in the scene with its
 * own flat, unmistakable colour and writes the colour→name mapping to the debug
 * log.
 *
 * ## Why this exists
 *
 * A report of "black lines coming out of the hillside" survived five rounds of
 * inference (roads, depth precision, terrain walls, boundary skirts, the
 * mountain ring — all bisected, all exonerated). Every one of those rounds
 * guessed at WHICH object was responsible and then tested the guess, which is
 * an expensive way to ask a cheap question.
 *
 * This asks it directly. Flip it on, take one screenshot, read the colour of
 * the offending pixels, look the colour up in the log. No inference.
 *
 * Deliberately crude:
 *  - `MeshBasicMaterial`, so nothing depends on lighting, tone mapping, vertex
 *    colours or shader injection — an object's colour on screen is EXACTLY its
 *    id, which is the whole point.
 *  - `side: DoubleSide`, so a face pointed away still shows its id instead of
 *    vanishing (the thing we are hunting may well be a back face).
 *  - Original materials are kept and restored on the way out; nothing is
 *    disposed, because these are mostly shared strategy singletons.
 */

import * as THREE from 'three';
import { debugLog } from '@/game/debug-logger';

interface Saved {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
}

let saved: Saved[] = [];
let active = false;
let idMaterials: THREE.MeshBasicMaterial[] = [];

/**
 * Distinct, high-contrast colours. Golden-angle hue rotation with alternating
 * lightness so neighbours in the list never look alike — the mapping is only
 * useful if two objects can't be confused by eye.
 */
function idColour(i: number): THREE.Color {
  const hue = (i * 137.508) % 360;
  const light = i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.45 : 0.78;
  return new THREE.Color().setHSL(hue / 360, 1.0, light);
}

/** Anything without a name is far more suspicious than anything with one. */
function label(o: THREE.Object3D): string {
  if (o.name) return o.name;
  const parent = o.parent?.name;
  return parent ? `${parent}/<unnamed ${o.type}>` : `<unnamed ${o.type}>`;
}

export function isIdPassActive(): boolean {
  return active;
}

/** Repaint the scene by object id and log the legend. */
export function enableIdPass(scene: THREE.Scene): void {
  if (active) return;
  active = true;
  saved = [];
  idMaterials = [];

  const legend: { colour: string; name: string; tris: number; visible: boolean }[] = [];
  let i = 0;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    saved.push({ mesh, material: mesh.material });

    const colour = idColour(i++);
    const mat = new THREE.MeshBasicMaterial({
      color: colour,
      side: THREE.DoubleSide,
      fog: false,
    });
    idMaterials.push(mat);
    // A multi-material mesh (terrain: tops + walls) keeps its group count, so
    // each group still resolves — but every group gets the SAME id colour, so
    // the legend stays one row per object.
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => mat) : mat;

    const idx = mesh.geometry.index;
    const pos = mesh.geometry.getAttribute('position');
    legend.push({
      colour: `#${colour.getHexString()}`,
      name: label(mesh),
      tris: Math.floor(((idx ? idx.count : (pos?.count ?? 0))) / 3),
      visible: mesh.visible,
    });
  });

  debugLog('terrain', 'idPass/legend', { count: legend.length, legend });
  console.log('[idPass] %d meshes repainted:', legend.length);
  for (const l of legend) {
    console.log(`  %c${l.colour}%c ${l.name} (${l.tris} tris)`,
      `background:${l.colour};color:${l.colour}`, '');
  }
}

/** Put the real materials back. */
export function disableIdPass(): void {
  if (!active) return;
  for (const s of saved) s.mesh.material = s.material;
  for (const m of idMaterials) m.dispose();
  saved = [];
  idMaterials = [];
  active = false;
}
