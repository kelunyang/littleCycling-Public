/**
 * The tiny z-buffered Lambert rasteriser the headless previews share.
 *
 * Extracted so there is exactly ONE copy. This repo has already been bitten by
 * a duplicated probe helper (`makeGroundFn` existed in both render-probe and the
 * production path, and the two drifted), and a preview that renders differently
 * from the other previews is worse than no preview: it produces confident,
 * wrong conclusions about art nobody has otherwise seen.
 *
 * No WebGL, no browser. Shading is `material.color × vertex colour × Lambert`,
 * so this answers "is the FORM right" and nothing else. In particular it does
 * not do `emissive`, transparency, textures, or any post pass — see
 * CUSTOM_WORLD_INSTRUCTIONS §10 for the full list of what a probe will lie
 * about.
 */

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import type * as THREE_NS from 'three';

export interface RasterItem {
  geo: THREE_NS.BufferGeometry;
  /** Flat colour, or null to use the geometry's own vertex colours. */
  color: THREE_NS.Color | null;
}

export interface RasterOptions {
  THREE: typeof THREE_NS;
  width?: number;
  height?: number;
  eye: THREE_NS.Vector3;
  target: THREE_NS.Vector3;
  fovDeg?: number;
  /** Background fill, as `[r, g, b]` 0-255. */
  background?: [number, number, number];
  light?: THREE_NS.Vector3;
}

export interface RasterResult {
  width: number;
  height: number;
  pixels: Buffer;
  triangles: number;
}

/** Walk a scene graph into flat, world-transformed draw items (instances expanded). */
export function collectItems(THREE: typeof THREE_NS, root: THREE_NS.Object3D): RasterItem[] {
  const items: RasterItem[] = [];
  const matColor = (m: unknown): THREE_NS.Color | null => {
    const c = (m as { color?: THREE_NS.Color }).color;
    return c && (c as unknown as { isColor?: boolean }).isColor ? c : null;
  };
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE_NS.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute?.('position')) return;
    const inst = mesh as unknown as THREE_NS.InstancedMesh;
    const col = matColor(mesh.material);
    if (inst.isInstancedMesh) {
      const m = new THREE.Matrix4();
      // `instanceColor` is where a batched body keeps its colour — the geometry
      // itself carries a flat WHITE vertex colour so three's USE_COLOR shader
      // path has something to multiply. Read only the geometry and every
      // instanced building comes out white, which is how the first pass of the
      // instanced-bodies work "looked identical" while actually losing all its
      // colour.
      const ic = inst.instanceColor;
      const icol = new THREE.Color();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        const g = inst.geometry.clone();
        g.applyMatrix4(m);
        g.applyMatrix4(mesh.matrixWorld);
        let c = col;
        if (ic) {
          icol.fromBufferAttribute(ic as THREE_NS.BufferAttribute, i);
          c = col ? icol.clone().multiply(col) : icol.clone();
          // The white vertex-colour attribute would otherwise win: the
          // rasteriser prefers per-vertex colour when the buffer exists.
          g.deleteAttribute('color');
        }
        items.push({ geo: g, color: c });
      }
    } else {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      items.push({ geo: g, color: mesh.geometry.getAttribute('color') ? null : col });
    }
  });
  return items;
}

export function rasterise(items: RasterItem[], opts: RasterOptions): RasterResult {
  const { THREE } = opts;
  const W = opts.width ?? 960;
  const H = opts.height ?? 560;
  const bg = opts.background ?? [150, 172, 196];
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const img = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    img[i * 3] = bg[0]; img[i * 3 + 1] = bg[1]; img[i * 3 + 2] = bg[2];
  }

  const eye = opts.eye;
  const camF = opts.target.clone().sub(eye).normalize();
  const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
  const camU = new THREE.Vector3().crossVectors(camR, camF).normalize();
  const focal = (H / 2) / Math.tan(((opts.fovDeg ?? 42) * Math.PI / 180) / 2);
  const LIGHT = (opts.light ?? new THREE.Vector3(-0.45, 0.78, 0.44)).clone().normalize();

  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const project = (v: THREE_NS.Vector3): [number, number, number] | null => {
    const rx = v.x - eye.x, ry = v.y - eye.y, rz = v.z - eye.z;
    const zc = rx * camF.x + ry * camF.y + rz * camF.z;
    if (zc < 0.2) return null;
    const xc = rx * camR.x + ry * camR.y + rz * camR.z;
    const yc = rx * camU.x + ry * camU.y + rz * camU.z;
    return [W / 2 + (xc / zc) * focal, H / 2 - (yc / zc) * focal, zc];
  };

  let tris = 0;
  for (const { geo, color } of items) {
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    const idx = geo.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = idx ? idx.array[t] : t;
      const i1 = idx ? idx.array[t + 1] : t + 1;
      const i2 = idx ? idx.array[t + 2] : t + 2;
      va.fromBufferAttribute(pos as THREE_NS.BufferAttribute, i0);
      vb.fromBufferAttribute(pos as THREE_NS.BufferAttribute, i1);
      vc.fromBufferAttribute(pos as THREE_NS.BufferAttribute, i2);
      const pa = project(va), pb = project(vb), pc = project(vc);
      if (!pa || !pb || !pc) continue;
      tris++;
      nrm.copy(e1.subVectors(vb, va)).cross(e2.subVectors(vc, va));
      if (nrm.lengthSq() < 1e-12) continue;
      nrm.normalize();
      const lambert = 0.42 + 0.58 * Math.abs(nrm.dot(LIGHT));
      let r: number, g: number, b: number;
      if (col) {
        r = ((col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3) * 255;
        g = ((col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3) * 255;
        b = ((col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3) * 255;
      } else if (color) {
        r = color.r * 255; g = color.g * 255; b = color.b * 255;
      } else { r = 190; g = 190; b = 190; }
      r = Math.min(255, r * lambert); g = Math.min(255, g * lambert); b = Math.min(255, b * lambert);

      const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      if (maxX < minX || maxY < minY) continue;
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
          const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          const o = py * W + px;
          if (depth < zbuf[o]) {
            zbuf[o] = depth;
            img[o * 3] = r; img[o * 3 + 1] = g; img[o * 3 + 2] = b;
          }
        }
      }
    }
  }
  return { width: W, height: H, pixels: img, triangles: tris };
}

export function writePng(path: string, res: RasterResult): void {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const { width: W, height: H, pixels } = res;
  const scan = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    pixels.copy(scan, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
