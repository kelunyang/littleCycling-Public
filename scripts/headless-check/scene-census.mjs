/**
 * Scene census — one definition of "how expensive is this scene", shared by
 * `demo-probe` (the plan/ demos) and `render-probe` (the real game).
 *
 * The point of sharing it is that the two sets of numbers have to be COMPARABLE.
 * "The demo does 259 draw calls and the game does 400" is only a sentence worth
 * saying if both sides counted the same way — and counting draw calls has more
 * than one defensible definition (does a hidden mesh count? does an
 * InstancedMesh count once or `count` times? does a multi-material mesh count
 * once per group?). Two probes with two answers produce a comparison that is
 * confidently wrong, which is worse than no comparison.
 *
 * The definitions here, and why:
 *  · A mesh counts once. An InstancedMesh counts ONCE — that is the whole point
 *    of instancing, and counting its instances would make the batched world
 *    look worse than the unbatched one it replaced.
 *  · Invisible meshes do not count. `visible` is INHERITED in three, so this
 *    walks up the parents; a shallow `o.visible === false` check silently
 *    counts everything under a hidden group (it once made a toggle look like it
 *    did nothing).
 *  · Triangles are the SCENE TOTAL, not what a frame rasterises: there is no
 *    frustum culling and no occlusion here. Read it as "how much geometry is
 *    resident", not "how much the GPU draws".
 *  · Screen-filling transparency is estimated from the BOUNDING SPHERE, which
 *    is an upper bound and can be wildly pessimistic — a big sphere mostly
 *    hidden behind terrain fills almost nothing. A previous audit called an
 *    acrylic dome its top fill-rate risk on this metric; measured on real
 *    hardware it cost 0.2 ms. 大包圍球 ≠ 填得多.
 */

/** three's `visible` is inherited — walk up, don't test the leaf. */
export function isShown(o) {
  for (let n = o; n; n = n.parent) if (n.visible === false) return false;
  return true;
}

/**
 * Walk a scene and return the raw counts. `label` is only carried through for
 * the caller's own reporting.
 */
export function census(scene, label = '') {
  const geo = new Set();
  const mat = new Set();
  let calls = 0, instances = 0, instMeshes = 0, plain = 0, verts = 0, attrBytes = 0, tris = 0;
  const byCall = [];
  scene.traverse((o) => {
    if (!o.isMesh || !isShown(o)) return;
    calls++;
    if (o.isInstancedMesh) { instMeshes++; instances += o.count; } else plain++;
    if (o.geometry && !geo.has(o.geometry.uuid)) {
      geo.add(o.geometry.uuid);
      const p = o.geometry.getAttribute?.('position');
      if (p) {
        verts += p.count;
        for (const k of Object.keys(o.geometry.attributes || {})) {
          const a = o.geometry.attributes[k];
          attrBytes += a.count * a.itemSize * 4;
        }
      }
    }
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) mat.add(m.uuid);
    const p = o.geometry?.getAttribute?.('position');
    const t = p
      ? ((o.geometry.index ? o.geometry.index.count : p.count) / 3) * (o.isInstancedMesh ? o.count : 1)
      : 0;
    tris += t;
    byCall.push([o.name || o.geometry?.type || 'mesh', t, o.isInstancedMesh ? o.count : 1]);
  });
  byCall.sort((a, b) => b[1] - a[1]);

  let transparent = 0, screenFilling = 0;
  const bigNames = [];
  scene.traverse((o) => {
    if (!o.isMesh || !isShown(o)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || !m.transparent) return;
    transparent++;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere?.();
    const r = (o.geometry.boundingSphere?.radius ?? 0) * Math.max(o.scale.x, o.scale.y, o.scale.z);
    if (r > 300) { screenFilling++; bigNames.push(`${o.name || o.geometry.type}(r=${Math.round(r)})`); }
  });

  return {
    label, calls, plain, instMeshes, instances,
    geometries: geo.size, materials: mat.size,
    verts, attrBytes, triangles: tris,
    transparent, screenFilling, bigNames, byCall,
  };
}

/** The same report both probes print, so two runs can be diffed by eye. */
export function formatCensus(c, { top = 10 } = {}) {
  const lines = [];
  lines.push(`CENSUS${c.label ? ' ' + c.label : ''}  draw calls ${c.calls} `
    + `(plain ${c.plain} + instanced ${c.instMeshes} carrying ${c.instances} instances)`);
  lines.push(`        unique geometries ${c.geometries}  unique materials ${c.materials}  `
    + `verts ${(c.verts / 1e3).toFixed(0)}k  attr ${(c.attrBytes / 1e6).toFixed(1)}MB  `
    + `tris ${(c.triangles / 1e3).toFixed(0)}k`);
  lines.push(`        transparent draw calls ${c.transparent}  of which screen-filling ${c.screenFilling}`
    + (c.bigNames.length ? `  [${c.bigNames.join(' ')}]` : ''));
  if (top > 0) {
    lines.push('        heaviest draw calls (triangles):');
    for (const [n, t, k] of c.byCall.slice(0, top)) {
      lines.push(`          ${String(Math.round(t)).padStart(7)}  ${n}${k > 1 ? ` x${k}` : ''}`);
    }
  }
  return lines.join('\n');
}
