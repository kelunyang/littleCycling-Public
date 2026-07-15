/**
 * Paper (corrugated CARDBOARD) terrain style — the "paper tank / hand-drawn"
 * look for the Three.js world.
 *
 * How the paper feel is built (geometry + materials do the heavy lifting; the
 * screen-space paper pass only converges it):
 *  - Terrain is the shared quantised engine with a TALL layer height → the
 *    ground reads as stacked contour cardboard sheets (P1 core).
 *  - Materials are matte, flat-shaded MeshToonMaterial over a soft gradient, and
 *    every colour is "paperified" (desaturated + warm kraft tint) so the same
 *    zone stays one muted construction-paper colour.
 *  - Ink outlines (inverted hull) on buildings + trees — the single biggest
 *    hand-drawn signal.
 *  - Trees are cut-card crosses on a paper-tube trunk.
 *
 * Zero external assets; blocks/paper are generic craft words (no branding).
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createPaperPass } from './paper-effect-pass';
import { createPlasticTerrainStyle } from './plastic-terrain-style';
import { disposeGroup } from './bike-ornament';
import { injectCloudShadow } from './cloud-shadow';
import {
  defaultStyleParams,
  mulberry32,
  quantizeToLayer,
  type BikeOrnamentParts,
  type StreetLampParts,
  type StyleParams,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';

/** The desk the whole paper world is built on. */
const DESK_COLOR = 0x8a6a48;

/** Two board tones for the distant mountain silhouette rings. */
const MOUNTAIN_FAR_COLOR = 0xa8845c;
const MOUNTAIN_NEAR_COLOR = 0x7a5838;

/** Metres of road per repeat of the masking-tape texture (sets the dash pitch). */
const ROAD_TEXTURE_METERS = 14;

/** Soft 3-step gradient → matte, low-contrast paper shading. */
function createPaperGradient(): THREE.DataTexture {
  const data = new Uint8Array([
    Math.round(0.58 * 255),
    Math.round(0.8 * 255),
    255,
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Desaturate toward luminance + warm kraft tint → construction-paper tone. */
function paperify(c: THREE.Color): THREE.Color {
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const desat = 0.45;
  c.r += (lum - c.r) * desat;
  c.g += (lum - c.g) * desat;
  c.b += (lum - c.b) * desat;
  c.r = Math.min(1, c.r * 1.02 + 0.04);
  c.g = Math.min(1, c.g * 0.98 + 0.02);
  c.b = Math.min(1, c.b * 0.86);
  return c;
}

function paperifyHex(hex: number): number {
  return paperify(new THREE.Color(hex)).getHex();
}

/** Raw kraft board colour for cut edges / box tops. */
const KRAFT_COLOR = 0xc9a670;

/**
 * Highlighter pen — the route is swiped onto the road with it. 3D-only (no CSS
 * counterpart), so it lives here rather than in themes.scss, same as KRAFT_COLOR.
 * The ink core and its bleed, straight from the paper demo.
 */
const HIGHLIGHTER_INK = 0xb8ec1e;
const HIGHLIGHTER_BLEED = 0xd8ff66;

/**
 * Procedural corrugated-cardboard cut-edge texture (tileable). Texture space:
 * one full v-repeat = ONE stacked sheet (liner – wavy flute – liner), u repeats
 * every WALL_U_METERS. This is what sells "瓦楞紙" on every vertical face:
 * kraft base, dark liner lines top/bottom, and a sine-wave flute band between.
 * `strength` (params.corrugationStrength) scales the pattern contrast.
 */
function createCorrugationTexture(strength: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = Math.max(0, Math.min(1.5, strength));

  // Kraft base.
  ctx.fillStyle = '#c9a670';
  ctx.fillRect(0, 0, size, size);

  // Subtle per-pixel paper noise (deterministic).
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  let seed = 0x2545f491;
  for (let i = 0; i < d.length; i += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const n = (((seed >>> 0) % 1000) / 1000 - 0.5) * 18 * (0.5 + s * 0.5);
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  if (s > 0.01) {
    // Wavy flute band — the corrugation core seen edge-on. Shadow stroke plus a
    // slightly offset highlight so the wave reads as a 3D ripple.
    const flutes = 5; // periods per u-repeat (WALL_U_METERS)
    const amp = size * 0.22;
    const mid = size / 2;
    const wave = (offsetY: number, style: string, width: number, alpha: number) => {
      ctx.strokeStyle = style;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 2) {
        const y = mid + offsetY + Math.sin((x / size) * Math.PI * 2 * flutes) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    wave(3, '#8a6a3e', size * 0.10, 0.55 * s);   // flute shadow
    wave(-4, '#e8cfa2', size * 0.05, 0.45 * s);  // flute highlight

    // Liner lines at the sheet boundaries (top + bottom of the repeat).
    ctx.globalAlpha = 0.65 * s;
    ctx.fillStyle = '#7d5f36';
    ctx.fillRect(0, 0, size, 3);
    ctx.fillRect(0, size - 3, size, 3);
    ctx.globalAlpha = 0.35 * s;
    ctx.fillStyle = '#f0dcb4';
    ctx.fillRect(0, 3, size, 2);
    ctx.fillRect(0, size - 5, size, 2);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** World metres per crayon-shading texture repeat (top surfaces). */
const CRAYON_SHADE_METERS = 18;

/** Bare-paper colour showing through the crayon tooth gaps (warm off-white). */
const PAPER_TOOTH_RGB = 'vec3(0.93, 0.89, 0.80)';

/**
 * Crayon surface-shading texture (tileable both axes). Channel encoding:
 *  - R: waxy streak multiplier (≈0.78–1.0) — uneven crayon pressure.
 *  - G: paper-tooth mask (mostly 0; speckles/scratches ≈0.4–0.9) — where the
 *    bare paper shows through the wax.
 * Applied by `crayonize()`: diffuse *= R, then mix(diffuse, paperWhite, G).
 * Strokes all lean one diagonal — the way a hand shades a whole area.
 */
function createCrayonShadeTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x1b873593);

  // Base: full crayon coverage (R=255), no tooth (G=0).
  ctx.fillStyle = 'rgb(255,0,0)';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';

  // Waxy streaks — one consistent diagonal (~-35°), varying pressure. Each
  // stroke is stamped on a 3×3 wrap grid for seamless tiling.
  const ang = -0.61; // radians
  const dirX = Math.cos(ang), dirY = Math.sin(ang);
  for (let i = 0; i < 170; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 26 + rng() * 80;
    const r = Math.round(205 + rng() * 42); // streak darkness (205–247)
    ctx.strokeStyle = `rgba(${r},0,0,${(0.3 + rng() * 0.4).toFixed(3)})`;
    ctx.lineWidth = 1.5 + rng() * 3.5;
    const jx = (rng() - 0.5) * 8; // slight per-stroke drift off the diagonal
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox - dirX * len / 2, y + oy - dirY * len / 2 + jx / 2);
        ctx.lineTo(x + ox + dirX * len / 2, y + oy + dirY * len / 2 - jx / 2);
        ctx.stroke();
      }
    }
  }

  // Paper tooth — speckles + a few short scratches where the wax skipped.
  // rgb(255,255,0): keeps R bright (no darkening) while raising the G mask.
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,0,${(0.3 + rng() * 0.5).toFixed(3)})`;
    const x = rng() * size;
    const y = rng() * size;
    const rr = 0.5 + rng() * 1.4;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = `rgba(255,255,0,${(0.25 + rng() * 0.35).toFixed(3)})`;
    ctx.lineWidth = 0.8 + rng() * 1.2;
    const x = rng() * size;
    const y = rng() * size;
    const len = 6 + rng() * 18;
    ctx.beginPath();
    ctx.moveTo(x - dirX * len / 2, y - dirY * len / 2);
    ctx.lineTo(x + dirX * len / 2, y + dirY * len / 2);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / CRAYON_SHADE_METERS, 1 / CRAYON_SHADE_METERS);
  texture.needsUpdate = true;
  return texture;
}

/** Small seeded RNG (xorshift32) for stable procedural textures. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** World metres per dent-bump texture repeat. */
const DENT_METERS = 26;

/** Bump strength for the cardboard dents (toon steps posterize the shading). */
const DENT_BUMP_SCALE = 2.2;

/**
 * Cardboard dent bump map (tileable): mid-grey base with soft dark hollows and
 * lighter bulges — the "坑坑巴巴" of handled cardboard. Used as `bumpMap` on the
 * crayoned surfaces; under the 3-step toon gradient the dents show up as
 * blotchy light/shadow patches instead of smooth shading.
 */
function createDentTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x85ebca6b);

  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, size, size);

  // Soft blobs stamped on a 3×3 wrap grid for seamless tiling:
  // dark = pressed-in hollows, light = pushed-out bulges.
  const blob = (x: number, y: number, r: number, lum: number, alpha: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${lum},${lum},${lum},${alpha.toFixed(3)})`);
        g.addColorStop(1, `rgba(${lum},${lum},${lum},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  };

  for (let i = 0; i < 26; i++) {
    // Hollows — bigger, softer.
    blob(rng() * size, rng() * size, 18 + rng() * 34, 70 + Math.round(rng() * 30), 0.22 + rng() * 0.2);
  }
  for (let i = 0; i < 18; i++) {
    // Bulges — smaller, brighter.
    blob(rng() * size, rng() * size, 10 + rng() * 22, 175 + Math.round(rng() * 45), 0.18 + rng() * 0.18);
  }
  // A few sharp creases (thin dark lines).
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(80,80,80,${(0.18 + rng() * 0.2).toFixed(3)})`;
    ctx.lineWidth = 1 + rng() * 2;
    const x = rng() * size;
    const y = rng() * size;
    const len = 30 + rng() * 90;
    const ang = rng() * Math.PI;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox - Math.cos(ang) * len / 2, y + oy - Math.sin(ang) * len / 2);
        ctx.lineTo(x + ox + Math.cos(ang) * len / 2, y + oy + Math.sin(ang) * len / 2);
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / DENT_METERS, 1 / DENT_METERS);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Turn a toon material's map into crayon shading: instead of the standard
 * multiply, R modulates the colour (wax pressure) and G mixes toward bare
 * paper (tooth gaps). Geometries need world-metre UVs (quantised tops,
 * ShapeGeometry landuse, ExtrudeGeometry buildings all qualify).
 */
function crayonize<T extends THREE.MeshToonMaterial>(mat: T, tex: THREE.Texture): T {
  mat.map = tex;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec4 crayonTex = texture2D( map, vMapUv );
        // R: waxy streak pressure; G: paper tooth (bare paper shows through).
        diffuseColor.rgb *= crayonTex.r;
        diffuseColor.rgb = mix( diffuseColor.rgb, ${PAPER_TOOTH_RGB}, crayonTex.g * 0.85 );
      #endif
      `,
    );
  };
  return mat;
}

/** Inverted-hull ink material: back faces pushed out along normals. */
function makeInkMaterial(color: number, thickness: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uThickness = { value: thickness };
    shader.vertexShader = 'uniform float uThickness;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed += normalize(normal) * uThickness;',
    );
  };
  return m;
}

/**
 * Masking-tape road surface: grey-blue tape with diagonal weave, white torn
 * edges, and a correction-fluid dashed centre line. Tiles along u (metres of
 * road); v spans the road width, so the dashes keep a constant pitch.
 */
function createTapeRoadTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#6d7684';
  ctx.fillRect(0, 0, w, h);

  // Diagonal weave of the tape.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 3;
  for (let i = -w; i < w * 2; i += 12) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 40, h);
    ctx.stroke();
  }

  // Torn white edges.
  ctx.fillStyle = 'rgba(240,240,235,0.5)';
  ctx.fillRect(0, 0, w, 5);
  ctx.fillRect(0, h - 5, w, 5);

  // Correction-fluid centre dashes — wobbly, drawn by hand.
  const rng = makeRng(0x9e3779b9);
  ctx.strokeStyle = '#f5f2e8';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + (rng() - 0.5) * 3);
  for (let x = 6; x <= w * 0.5; x += 6) {
    ctx.lineTo(x, h / 2 + (rng() - 0.5) * 3);
  }
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A crayon-scribbled window on a transparent background — stuck onto building
 * facades as alpha-cut cards (the walls are one merged mesh, so the windows
 * can't live in the wall texture the way the demo does it).
 */
function createCrayonWindowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0xc2b2ae35);
  ctx.clearRect(0, 0, size, size);

  const jitter = () => (rng() - 0.5) * 6;
  const x = 20;
  const y = 22;
  const w = size - 40;
  const h = size - 44;

  // Two passes of a wobbly outline + a diagonal scribble fill — how a hand
  // colours in a window with a crayon.
  ctx.strokeStyle = '#4a7dbd';
  ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(x + jitter(), y + jitter());
    ctx.lineTo(x + w + jitter(), y + jitter());
    ctx.lineTo(x + w + jitter(), y + h + jitter());
    ctx.lineTo(x + jitter(), y + h + jitter());
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 8;
  for (let i = 0; i < w + h; i += 11) {
    ctx.beginPath();
    ctx.moveTo(x + Math.min(i, w), y + Math.max(0, i - w));
    ctx.lineTo(x + Math.max(0, i - h), y + Math.min(i, h));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Cut-out tree silhouette on a transparent background (scissors-cut card):
 * a paper-tube trunk, a lobed canopy, and a few crayon arcs on top.
 */
function createTreeCutoutTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x27d4eb2f);
  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(118, 160, 22, 90);

  ctx.fillStyle = '#5aa646';
  for (const [cx, cy, r] of [[128, 96, 62], [88, 128, 42], [168, 126, 44], [128, 150, 46]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crayon shading, clipped to the cut shape.
  ctx.strokeStyle = '#3d7a30';
  ctx.lineWidth = 6;
  ctx.globalAlpha = 0.5;
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 24; i++) {
    const a = rng() * Math.PI * 2;
    const r = 60 + rng() * 55;
    ctx.beginPath();
    ctx.arc(128, 118, r, a, a + 0.5);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Sticky-note paper with ruled lines — the checkpoint flag. */
function createStickyTexture(color: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x1f123bb5);

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 2;
  for (let y = 34; y < size - 8; y += 22) {
    ctx.beginPath();
    ctx.moveTo(12, y);
    ctx.lineTo(size - 12, y + (rng() - 0.5) * 3);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Kraft-board colour used for box flaps + slab tops. */
function kraftMaterial(gradient: THREE.DataTexture, color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
}

// ── Ground-overlay textures (wetland / farmland / sports) ──
// ShapeGeometry UVs are scene metres, so `repeat = 1 / tile-metres` sets the
// real-world tile size. All hand-wobbled — ruler-straight lines break the craft.

/** One wetland tile = 24 m of teal marsh paper: pools + crayon reed tufts. */
function createWetlandTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x77e77a9d);

  ctx.fillStyle = '#69a292';
  ctx.fillRect(0, 0, size, size);

  // Darker water pools — irregular blobs of a wetter teal.
  ctx.fillStyle = '#4d8a80';
  for (let i = 0; i < 9; i++) {
    const x = rng() * size;
    const y = rng() * size;
    ctx.beginPath();
    ctx.ellipse(x, y, 14 + rng() * 22, 8 + rng() * 12, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Reed tufts — short crayon strokes fanning up from a point.
  ctx.strokeStyle = '#2f5e50';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = rng() * size;
    const y = rng() * size;
    for (let b = -1; b <= 1; b++) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + b * (3 + rng() * 3), y - 8 - rng() * 7);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 24, 1 / 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One farmland tile = 28 m of kraft field: wobbly plough stripes. */
function createFarmlandTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0xfa123bcd);

  ctx.fillStyle = '#c9a86e';
  ctx.fillRect(0, 0, size, size);

  // Alternating row shading, then furrow lines drawn twice with jitter.
  const ROWS = 8;
  const rowH = size / ROWS;
  for (let r = 0; r < ROWS; r++) {
    if (r % 2 === 0) continue;
    ctx.fillStyle = 'rgba(148, 110, 58, 0.28)';
    ctx.fillRect(0, r * rowH, size, rowH);
  }
  ctx.strokeStyle = '#8a6a3c';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let r = 0; r <= ROWS; r++) {
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      let y = r * rowH + (rng() - 0.5) * 4;
      ctx.moveTo(0, y);
      for (let x = 24; x <= size; x += 24) {
        y = r * rowH + (rng() - 0.5) * 5;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 28, 1 / 28);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One sports tile = 20 m of bright card pitch: mow stripes + correction-fluid court lines. */
function createSportsFieldTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x50a11ce5);

  // Mow stripes — two greens.
  const STRIPES = 6;
  for (let s = 0; s < STRIPES; s++) {
    ctx.fillStyle = s % 2 === 0 ? '#6fbf4e' : '#5fae40';
    ctx.fillRect(s * (size / STRIPES), 0, size / STRIPES, size);
  }

  // Court boundary + centre line, wobbled like the road's correction-fluid dashes.
  ctx.strokeStyle = '#f5f2e8';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  const inset = 22;
  const wob = () => (rng() - 0.5) * 4;
  ctx.beginPath();
  ctx.moveTo(inset + wob(), inset + wob());
  ctx.lineTo(size - inset + wob(), inset + wob());
  ctx.lineTo(size - inset + wob(), size - inset + wob());
  ctx.lineTo(inset + wob(), size - inset + wob());
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size / 2 + wob(), inset + wob());
  ctx.lineTo(size / 2 + wob(), size - inset + wob());
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 20, 1 / 20);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Plane-shaped balloon tethered over an aerodrome (the user's pick over a "real"
 * paper plane). Origin is the ground anchor: a little sandbag, a string, and a
 * fat balloon with card wings floating ~12 m up.
 */
function buildPlaneBalloon(gradient: THREE.DataTexture): THREE.Group {
  const group = new THREE.Group();

  const balloonMat = new THREE.MeshToonMaterial({ color: 0xe86a5a, gradientMap: gradient });
  const creamMat = kraftMaterial(gradient, 0xf2e8d0);
  const cardMat = kraftMaterial(gradient, KRAFT_COLOR);
  const stringMat = new THREE.MeshToonMaterial({ color: 0x8a8378, gradientMap: gradient });

  const FLOAT_H = 12;

  // Fat balloon body — a squashed sphere, nose slightly up like it is straining
  // at the string.
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), balloonMat);
  body.scale.set(3.1, 2.0, 2.0);
  body.position.y = FLOAT_H;
  body.rotation.z = 0.08;
  group.add(body);

  // Cream nose cap + a card propeller crossed on it.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), creamMat);
  nose.scale.set(0.7, 1, 1);
  nose.position.set(3.0, FLOAT_H + 0.25, 0);
  group.add(nose);
  for (const tilt of [0, Math.PI / 2]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.5), cardMat);
    blade.position.set(3.7, FLOAT_H + 0.25, 0);
    blade.rotation.x = tilt;
    group.add(blade);
  }

  // Card wings through the body, and a two-card tail.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 7.2), cardMat);
  wing.position.set(0.4, FLOAT_H + 0.4, 0);
  group.add(wing);
  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.6, 0.12), balloonMat);
  tailFin.position.set(-2.8, FLOAT_H + 1.3, 0);
  group.add(tailFin);
  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 3.0), cardMat);
  tailPlane.position.set(-2.8, FLOAT_H + 0.7, 0);
  group.add(tailPlane);

  // Tether: string from the belly down to a sandbag at the origin.
  const string = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, FLOAT_H - 1.6, 5),
    stringMat,
  );
  string.position.y = (FLOAT_H - 1.6) / 2 + 0.4;
  group.add(string);
  const sandbag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.9), cardMat);
  sandbag.position.y = 0.28;
  group.add(sandbag);

  return group;
}

/**
 * Paperclip bike — bent-wire frame, torus wheels with three spokes, an eraser
 * saddle. Local axes: forward = +x, axle = z (see bike-ornament.ts).
 * Recipe lifted from `plan/ref-demo-paper-src.js`.
 */
function buildPaperclipBike(gradient: THREE.DataTexture): BikeOrnamentParts {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);

  const wire = new THREE.MeshPhongMaterial({ color: 0xcdd3da, specular: 0xffffff, shininess: 140 });
  const wireGold = new THREE.MeshPhongMaterial({ color: 0xd9b04a, specular: 0xfff6d0, shininess: 140 });
  const eraser = kraftMaterial(gradient, 0xf0879a);
  const pedalMat = kraftMaterial(gradient, 0x5a5f66);

  const R = 2.1;
  const wheels: THREE.Object3D[] = [];
  for (const x of [-2.9, 2.9]) {
    const wheel = new THREE.Group();
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.17, 10, 42), wire));
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, R * 2 - 0.3, 6), wire);
      spoke.rotation.z = (i / 3) * Math.PI;
      wheel.add(spoke);
    }
    wheel.add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), wireGold));
    wheel.position.set(x, R, 0);
    lean.add(wheel);
    wheels.push(wheel);
  }

  const framePath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.9, R, 0),
    new THREE.Vector3(-1.0, 5.1, 0),
    new THREE.Vector3(-0.1, 2.3, 0),
    new THREE.Vector3(2.3, 5.3, 0),
    new THREE.Vector3(2.9, R, 0),
  ], false, 'catmullrom', 0.12);
  lean.add(new THREE.Mesh(new THREE.TubeGeometry(framePath, 48, 0.17, 8), wire));
  lean.add(new THREE.Mesh(new THREE.TubeGeometry(
    new THREE.LineCurve3(new THREE.Vector3(-1.0, 5.0, 0), new THREE.Vector3(2.25, 5.2, 0)),
    2, 0.15, 8,
  ), wire));

  // The paperclip's signature: the wire loops back on itself at the seat tube.
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.14, 8, 20), wireGold);
  loop.position.set(-1.0, 5.5, 0);
  lean.add(loop);

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.4, 8), wire);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(2.3, 5.6, 0);
  lean.add(bar);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), wireGold);
    grip.position.set(2.3, 5.6, 1.7 * s);
    lean.add(grip);
  }

  const saddle = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.7, 1.1), eraser);
  saddle.position.set(-1.05, 5.95, 0);
  saddle.rotation.z = 0.05;
  lean.add(saddle);

  const crank = new THREE.Group();
  crank.position.set(-0.1, 2.3, 0);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 6), wire);
    arm.position.set(0, 0.75 * s, 0.5 * s);
    crank.add(arm);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.6), pedalMat);
    pedal.position.set(0, 1.5 * s, 0.75 * s);
    crank.add(pedal);
  }
  lean.add(crank);

  return { root, lean, wheels, crank, dispose: () => disposeGroup(root) };
}

/** Pencil street lamp — the sharpened tip is the bulb. */
function buildPencilLamp(gradient: THREE.DataTexture): StreetLampParts {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 9, 6),
    kraftMaterial(gradient, 0xf2b830),
  );
  body.position.y = 4.5;
  group.add(body);

  const wood = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.55, 1.5, 6),
    kraftMaterial(gradient, 0xe8d5a8),
  );
  wood.position.y = 9.75;
  group.add(wood);

  const tipMat = new THREE.MeshToonMaterial({ color: 0x3a3a3a, gradientMap: gradient });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 6), tipMat);
  tip.position.y = 10.6;
  group.add(tip);

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffe9a0, transparent: true, opacity: 0, depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), glowMat);
  glow.position.y = 10.6;
  group.add(glow);

  const light = new THREE.PointLight(0xffd980, 0, 26, 1.8);
  light.position.y = 10.4;
  group.add(light);

  let night = 0;
  let lightEnabled = true;

  return {
    group,
    setNight: (k) => {
      night = k;
      glowMat.opacity = k * 0.75;
      light.intensity = k * 14;
      tipMat.emissive.setRGB(k * 0.9, k * 0.75, k * 0.3);
      // A dozen point lights in the scene cost real fragment work even at zero
      // intensity — hiding them by day takes them out of the render list.
      light.visible = lightEnabled && k > 0.02;
    },
    setLightEnabled: (enabled) => {
      lightEnabled = enabled;
      light.visible = enabled && night > 0.02;
    },
    dispose: () => disposeGroup(group),
  };
}

export function createPaperTerrainStyle(): TerrainStyleStrategy {
  const params: StyleParams = defaultStyleParams('paper');

  // Reuse the plastic base ONLY for the underlying zone/elevation colour logic;
  // every colour is then paperified and every material is paper-specific.
  const base = createPlasticTerrainStyle();
  const gradient = createPaperGradient();

  let buildingMaterial: THREE.MeshToonMaterial | null = null;

  // Corrugation texture cache — regenerated when the panel's strength changes
  // (wall materials are recreated per chunk build, so a rebuild picks it up).
  let corrTex: { tex: THREE.CanvasTexture; strength: number } | null = null;
  const corrugationTexture = (): THREE.CanvasTexture => {
    const strength = params.corrugationStrength;
    if (!corrTex || corrTex.strength !== strength) {
      corrTex?.tex.dispose();
      corrTex = { tex: createCorrugationTexture(strength), strength };
    }
    return corrTex.tex;
  };

  // Crayon shading texture — shared by every coloured surface (lazy singleton).
  let crayonTex: THREE.CanvasTexture | null = null;
  const crayonTexture = (): THREE.CanvasTexture => {
    if (!crayonTex) crayonTex = createCrayonShadeTexture();
    return crayonTex;
  };

  // Cardboard dent bump map — shared (lazy singleton).
  let dentTex: THREE.CanvasTexture | null = null;
  const dentTexture = (): THREE.CanvasTexture => {
    if (!dentTex) dentTex = createDentTexture();
    return dentTex;
  };

  // Prop textures — lazy singletons, all freed in dispose().
  const propTextures = new Map<string, THREE.CanvasTexture>();
  const propTexture = (key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture => {
    let tex = propTextures.get(key);
    if (!tex) {
      tex = make();
      propTextures.set(key, tex);
    }
    return tex;
  };

  // Shared building-trim materials (kraft flaps, tape, crayon windows). Tagged
  // `shared` so the chunk disposer leaves them to the strategy.
  const trimMaterials = new Map<string, THREE.Material>();
  const sharedTrim = (key: string, make: () => THREE.Material): THREE.Material => {
    let mat = trimMaterials.get(key);
    if (!mat) {
      mat = make();
      mat.userData.shared = true;
      trimMaterials.set(key, mat);
    }
    return mat;
  };

  const toon = (opts: THREE.MeshToonMaterialParameters) =>
    new THREE.MeshToonMaterial({ gradientMap: gradient, side: THREE.DoubleSide, ...opts });
  /** Toon material whose colour reads as crayon-on-paper (streaks + tooth),
   *  with dented-cardboard bumps under the toon light. */
  const crayonToon = (opts: THREE.MeshToonMaterialParameters) => {
    const mat = crayonize(toon(opts), crayonTexture());
    mat.bumpMap = dentTexture();
    mat.bumpScale = DENT_BUMP_SCALE;
    return mat;
  };
  /** Toon that keeps its OWN colour map (crayonize would overwrite it) but still
   *  gets the dented-cardboard bumps. */
  const dentedToon = (opts: THREE.MeshToonMaterialParameters) => {
    const mat = toon(opts);
    mat.bumpMap = dentTexture();
    mat.bumpScale = DENT_BUMP_SCALE;
    return mat;
  };

  const strategy: TerrainStyleStrategy = {
    style: 'paper',
    params,

    // ── Colours (paperified) ──
    terrainVertexColor: (ele, x, z) => paperify(base.terrainVertexColor(ele, x, z)),
    buildingColor: (lon, lat) => paperifyHex(base.buildingColor(lon, lat)),
    roadColor: (cls) => paperifyHex(base.roadColor(cls)),
    roadWidth: (cls) => base.roadWidth(cls),
    urbanColor: (cls) => paperifyHex(base.urbanColor(cls)),
    treeTrunkColor: paperifyHex(base.treeTrunkColor),
    treeCanopyColors: base.treeCanopyColors.map(paperifyHex),
    // Cardboard-box roofs: raw kraft top over printed coloured sides.
    buildingTopColor: KRAFT_COLOR,

    // ── Materials (matte kraft; coloured surfaces read as crayon-on-paper) ──
    // injectCloudShadow chains onto crayonize's onBeforeCompile (F3).
    createTerrainMaterial: () => injectCloudShadow(crayonToon({ vertexColors: true })),
    // Cut edges (step risers / skirts): raw corrugated cardboard — ignores
    // vertex colours so the board core contrasts with the crayoned top sheet.
    createTerrainWallMaterial: () => toon({ map: corrugationTexture() }),
    createBuildingMaterial: () => {
      if (!buildingMaterial) {
        buildingMaterial = crayonToon({ vertexColors: true }) as THREE.MeshToonMaterial;
      }
      return buildingMaterial;
    },
    // Masking tape laid down the road, with correction-fluid dashes. The road
    // ribbon supplies metre-scale u, so the dash pitch is constant.
    createRoadMaterial: () => {
      const map = propTexture('tape', createTapeRoadTexture);
      map.repeat.set(1 / ROAD_TEXTURE_METERS, 1);
      return toon({
        map,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
    },
    // Water = cellophane over blue paper: translucent with a hard white glint.
    createWaterMaterial: () => new THREE.MeshPhongMaterial({
      color: 0x7cc4e8,
      specular: 0xffffff,
      shininess: 140,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    }),
    createParkMaterial: () => crayonToon({
      color: paperifyHex(0x00e676), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createForestMaterial: () => crayonToon({
      color: paperifyHex(0x1b5e20), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createSandMaterial: () => crayonToon({
      color: paperifyHex(0xd2b48c), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createUrbanMaterial: (color) => crayonToon({
      color, transparent: true, opacity: 0.6,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // Scissors-cut card: the silhouette lives in the texture's alpha.
    createTreeMaterial: () => toon({
      map: propTexture('treeCutout', createTreeCutoutTexture),
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    }),
    // NOT crayonToon: crayonize() REPLACES mat.map with its shading mask, which
    // would silently discard these hand-drawn tiles. The strokes in the textures
    // already carry the crayon look; dented-cardboard bumps come along manually.
    createWetlandMaterial: () => dentedToon({
      map: propTexture('wetland', createWetlandTexture),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createFarmlandMaterial: () => dentedToon({
      map: propTexture('farmland', createFarmlandTexture),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createSportsFieldMaterial: () => dentedToon({
      map: propTexture('sportsField', createSportsFieldTexture),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),

    // ── Diorama props ──

    horizonColor: DESK_COLOR,

    // Warm paper daylight → ink-blue desk-lamp night. Straight from the paper
    // demo (ref-demo-paper-src.js DAY/NIGHT); tuned for exposure 1.05.
    skyPalette: {
      day: {
        skyTop: 0xa8d4e2, skyBottom: 0xf3e9d2, fog: 0xe8dcc0,
        sunColor: 0xfff1d6, sunIntensity: 2.0,
        hemiSky: 0xcfe8f0, hemiGround: 0xc9a06b, hemiIntensity: 0.9,
        ambientColor: 0xfff5e0, ambientIntensity: 0.35,
      },
      night: {
        skyTop: 0x232a4d, skyBottom: 0x4a4066, fog: 0x3a3355,
        sunColor: 0x9fb4e8, sunIntensity: 0.7,
        hemiSky: 0x3a4470, hemiGround: 0x4a3a30, hemiIntensity: 0.5,
        ambientColor: 0xfff5e0, ambientIntensity: 0.18,
      },
    },

    // Highlighter swipe down the road, ink bleeding out around it — the widths/
    // opacities are the paper demo's (hl 1.8 @ 0.9, glow 4.0 @ 0.25).
    routeLine: {
      coreColor: HIGHLIGHTER_INK,
      coreWidth: 1.8,
      coreOpacity: 0.9,
      glowColor: HIGHLIGHTER_BLEED,
      glowWidth: 4.0,
      glowOpacity: 0.25,
    },
    // The cut-out's own colours must survive: no instanceColor multiply, and no
    // inverted hull (it would be a solid black quad behind each card).
    tintTreeInstances: false,
    outlineTrees: false,

    mountainColor: (layer) =>
      layer === 'near' ? MOUNTAIN_NEAR_COLOR : MOUNTAIN_FAR_COLOR,

    // Jagged triangular peaks: a new peak height every 4–7 segments and linear
    // interpolation between them gives the folded-card skyline. ~10% of peaks
    // are clamped flat — the mesa variant, matching the 2D cuphead mountains.
    generateMountainProfile: (_layer, seed, segments) => {
      const rng = mulberry32(seed);
      const profile: number[] = [];
      let current = 0.3 + rng() * 0.4;
      for (let i = 0; i <= segments; i++) {
        if (i % (4 + Math.floor(rng() * 4)) === 0) current = 0.25 + rng() * 0.75;
        profile.push(current > 0.88 ? 0.88 : current);
      }
      return profile;
    },

    buildBikeOrnament: () => buildPaperclipBike(gradient),
    buildPlaneOrnament: () => buildPlaneBalloon(gradient),

    buildStreetLamp: () => buildPencilLamp(gradient),

    // Coin = a gold drawing pin: head disc + spike.
    buildCoinMesh: () => {
      const headMat = new THREE.MeshPhongMaterial({
        color: 0xe8b93a, specular: 0xfff2c0, shininess: 110, emissive: 0x5a4008,
      });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.35, 20), headMat);
      disc.geometry.rotateX(Math.PI / 2);
      const pin = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 1.2, 8),
        new THREE.MeshPhongMaterial({ color: 0xc8cdd4, specular: 0xffffff, shininess: 130 }),
      );
      pin.position.y = -1.6;
      pin.rotation.x = Math.PI;
      disc.add(pin);
      disc.userData.isCoin = true;
      return disc;
    },

    // Checkpoint = a map pin (silver shaft, red head) flying a sticky note.
    buildCheckpoint: (color) => {
      const group = new THREE.Group();
      const metal = new THREE.MeshPhongMaterial({
        color: 0xc8cdd4, specular: 0xffffff, shininess: 130,
      });

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 13, 8), metal);
      pole.position.y = 6.5;
      group.add(pole);

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 12),
        toon({ color: 0xe34a4a }),
      );
      head.position.y = 13.4;
      group.add(head);

      // The note takes the segment's colour, ruled like a real sticky note.
      const noteColor = `#${new THREE.Color(color).getHexString()}`;
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(6.5, 5),
        toon({ map: createStickyTexture(noteColor) }),
      );
      flag.position.set(3.4, 10.2, 0);
      flag.rotation.z = -0.06;
      group.add(flag);
      return group;
    },

    // Cardboard-box trim: folded flaps on the roof and a packing-tape band round
    // the top. The crayon windows are batched — see collectFacadeWindows.
    buildBuildingDecoration: (box) => {
      const group = new THREE.Group();
      const flapMat = sharedTrim('flap', () => kraftMaterial(gradient, KRAFT_COLOR));
      const tapeMat = sharedTrim('tapeStrip', () => new THREE.MeshPhongMaterial({
        color: 0xd9c79a, transparent: true, opacity: 0.85, shininess: 90, specular: 0xffffff,
      }));

      const top = box.baseY + box.height;

      // Two flaps folded open along the box's long axis.
      const flapDepth = Math.min(box.depth * 0.5, 6);
      const flapGeo = new THREE.BoxGeometry(box.width + 0.4, 0.4, flapDepth);
      for (const side of [-1, 1]) {
        const flap = new THREE.Mesh(flapGeo.clone(), flapMat);
        flap.position.set(0, top + 0.8, (box.depth / 2 - flapDepth / 2) * side);
        flap.rotation.x = -0.42 * side;
        group.add(flap);
      }
      flapGeo.dispose();

      // Packing tape round the box, just under the flaps.
      const tape = new THREE.Mesh(
        new THREE.BoxGeometry(box.width + 0.15, 1.4, box.depth + 0.15),
        tapeMat,
      );
      tape.position.y = top - 1.4;
      group.add(tape);

      group.position.set(box.cx, 0, box.cz);
      group.rotation.y = box.rotY;
      return group;
    },

    // Crayon windows — alpha cards standing just off the facade; the building
    // renderer grids, rotates, and batches them (one InstancedMesh per chunk).
    facadeWindows: {
      colSpacing: 6,
      rowSpacing: 6,
      skipProb: 0.15,
      faceOffset: 0.15,
      flipBackFace: true, // flip back-face cards so the crayon scribble faces out
      createTemplate: () => ({
        geometry: new THREE.PlaneGeometry(3, 2.6),
        material: sharedTrim('window', () => new THREE.MeshToonMaterial({
          map: propTexture('crayonWindow', createCrayonWindowTexture),
          gradientMap: gradient,
          transparent: true,
          alphaTest: 0.3,
          side: THREE.DoubleSide,
        })),
      }),
    },

    // ── Geometry hooks ──
    quantizeElevation: (absEle) => quantizeToLayer(absEle, params),

    // Cut-card trees: two crossed cards carrying the cut-out silhouette.
    buildTreeGeometry: () => buildCutCardTreeGeometry(),

    // Ink outline via inverted hull — works for Mesh and InstancedMesh.
    createOutline: (source) => {
      if (!params.inkEnabled || params.inkThickness <= 0) return null;
      const mat = makeInkMaterial(params.inkColor, params.inkThickness);
      const inst = source as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        const outline = new THREE.InstancedMesh(inst.geometry, mat, inst.count);
        (outline.instanceMatrix.array as Float32Array).set(inst.instanceMatrix.array as Float32Array);
        outline.instanceMatrix.needsUpdate = true;
        outline.frustumCulled = false;
        return outline;
      }
      return new THREE.Mesh(source.geometry, mat);
    },

    // ── Post (converged: geometry/materials carry most of the paper feel) ──
    createPostPass: (width, height) => {
      const pass = createPaperPass(width, height);
      strategy.applyPostParams(pass);
      return pass;
    },
    applyPostParams: (pass: ShaderPass) => {
      pass.uniforms['uPosterize'].value = params.paperPosterize;
      pass.uniforms['uDesaturate'].value = params.paperDesaturate;
      pass.uniforms['uFiberStrength'].value = params.paperFiber;
      pass.uniforms['uStrength'].value = params.paperStrength;
    },

    dispose: () => {
      base.dispose();
      buildingMaterial?.dispose();
      buildingMaterial = null;
      corrTex?.tex.dispose();
      corrTex = null;
      crayonTex?.dispose();
      crayonTex = null;
      dentTex?.dispose();
      dentTex = null;
      for (const tex of propTextures.values()) tex.dispose();
      propTextures.clear();
      for (const mat of trimMaterials.values()) mat.dispose();
      trimMaterials.clear();
      gradient.dispose();
    },
  };

  return strategy;
}

/**
 * Cut-card tree: two perpendicular cards, each carrying the scissors-cut tree
 * silhouette in the material's alpha (the classic cutout trick). The card is
 * 8 m square with its base at y = 0, so the renderer's 0.7–1.4 instance scale
 * lands trees in a believable 5–11 m range.
 *
 * The two quads are merged into ONE geometry so a chunk is still a single
 * InstancedMesh draw call.
 */
function buildCutCardTreeGeometry(): THREE.BufferGeometry {
  const SIZE = 8;
  const cards: THREE.BufferGeometry[] = [];
  for (const rotY of [0, Math.PI / 2]) {
    const card = new THREE.PlaneGeometry(SIZE, SIZE);
    card.rotateY(rotY);
    card.translate(0, SIZE / 2, 0);
    cards.push(card.toNonIndexed());
    card.dispose();
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const card of cards) {
    const pos = card.attributes.position.array as ArrayLike<number>;
    const nrm = card.attributes.normal.array as ArrayLike<number>;
    const uv = card.attributes.uv.array as ArrayLike<number>;
    for (let i = 0; i < card.attributes.position.count * 3; i++) {
      positions.push(pos[i]);
      normals.push(nrm[i]);
    }
    for (let i = 0; i < card.attributes.uv.count * 2; i++) uvs.push(uv[i]);
    card.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}
