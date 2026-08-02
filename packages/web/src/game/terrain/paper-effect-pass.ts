/**
 * Paper-craft post-processing pass — the paper GRAIN, and nothing else.
 *
 * ## What this pass is allowed to do, and why it is so little
 *
 * It was written in the "Paper Tank" era, when the corrugated world WAS a
 * screen-space filter laid over the neon plastic one: posterize, desaturate,
 * warm kraft tint, fibre. Since then the world grew its own geometry, its own
 * palette and its own materials — and `plan/paper-town-demo.html`, which is the
 * POC this world is ported from, has **no post-processing at all**: it draws
 * with a bare `renderer.render(scene, camera)`. Every bit of its paper feel is
 * carried by the gouache/kraft textures, the corrugated cut edges and the toon
 * gradient.
 *
 * Three of the four steps were therefore doing the job a SECOND time, to the
 * whole frame, including to colours that were never neon to begin with:
 *
 *  - **Warm kraft tint** (`× vec3(1, 0.92, 0.76)`). The palette is already
 *    kraft-shifted at source — `paperify()` bakes exactly that shift into the
 *    building/tree/road colours (and reproduces the demo's own `ERASER_COLORS`
 *    hex for hex), while `TERRAIN_BAND` / the gouache `PAINT` pigments are paper
 *    colours to begin with. Multiplying blue by 0.76 across the frame moved the
 *    ground's green `#6d9a46` to `#808457` — R ≈ G, i.e. khaki. Measured over
 *    the demo's own palette: hue drift up to 36°, saturation down 25–73%. That
 *    is the "整個顏色都偏棕色" the rider reported. Removed.
 *  - **Posterize.** The flat printed banding is the toon `gradientMap`, which
 *    every material in this world already carries. Doing it again in screen
 *    space is worse than redundant: the pass runs BEFORE `OutputPass` (chain is
 *    RenderPass → this → OutputPass), so it quantises LINEAR values, where four
 *    levels crush the whole mid-tone range onto 0 / 0.25. Kept as a knob,
 *    defaulted off (`defaultStyleParams` override in `paper-terrain-style.ts`).
 *  - **Desaturate.** Same story: `paperify()` already takes 45% out, at source,
 *    once. Kept as a knob, defaulted off.
 *
 * What survives is the fibre: a near-white grain sampled through its RED
 * channel only, so it is a pure grey multiply and cannot move a hue. That is
 * the one thing a screen-space pass can add that per-material textures cannot
 * (it sits at native pixel size, so the paper stays paper-sized no matter how
 * far away the surface is).
 *
 * The paper texture is generated procedurally on a <canvas> (no image assets),
 * matching the project's "所有視覺元素都是程序化" convention.
 *
 * Added as the final ShaderPass in CyclingGlassesEffect's composer chain and
 * toggled via `pass.enabled`. Master `uStrength` allows a smooth fade in/out.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** Size (px) of the procedural paper texture tile. */
const PAPER_TEX_SIZE = 512;

/** Small seeded RNG so the paper grain is stable across reloads. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/**
 * Generate a tileable grayscale paper-grain texture centered near white,
 * so a screen-space multiply only adds subtle fiber shadows.
 */
export function createPaperTexture(): THREE.CanvasTexture {
  const size = PAPER_TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x9e3779b1);

  // Base — near white (multiply-friendly).
  ctx.fillStyle = '#f2f0e8';
  ctx.fillRect(0, 0, size, size);

  // Fine per-pixel fiber noise via ImageData.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Grain around base, biased slightly dark for a papery tooth.
    const n = (rng() - 0.5) * 40;
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  // A few faint long fibers / creases for organic paper structure.
  ctx.strokeStyle = 'rgba(110, 100, 80, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 40 + rng() * 160;
    const ang = rng() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Paper-craft shader. */
const PaperShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Procedural paper-grain texture. */
    uPaper: { value: null as THREE.Texture | null },
    /** Canvas resolution (px) — for native-size fiber tiling. */
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** On-screen size (px) of one paper tile. */
    uTileSize: { value: PAPER_TEX_SIZE },
    /** Paper fiber multiply strength (0 = none). */
    uFiberStrength: { value: 0.4 },
    /** Posterize band count (higher = smoother). */
    uLevels: { value: 4.0 },
    /** How much of the posterized color to blend in (0-1). Off by default —
     *  the toon gradientMap already bands, and this one bands LINEAR values. */
    uPosterize: { value: 0.0 },
    /** Desaturation amount toward matte paper (0-1). Off by default —
     *  `paperify()` already takes 45% out, at source, once. */
    uDesaturate: { value: 0.0 },
    /** Master effect strength (0 = original, 1 = full paper). */
    uStrength: { value: 1.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D uPaper;
    uniform vec2 uResolution;
    uniform float uTileSize;
    uniform float uFiberStrength;
    uniform float uLevels;
    uniform float uPosterize;
    uniform float uDesaturate;
    uniform float uStrength;

    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb;

      // 1. Posterize — flat printed color bands. Off by default (see header).
      vec3 post = floor(col * uLevels + 0.5) / uLevels;
      col = mix(col, post, uPosterize);

      // 2. Desaturate toward matte construction paper. Off by default.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), uDesaturate);

      // 3. Paper fiber — tiled at native pixel size, multiply blend. RED channel
      //    only, so this is a grey multiply: it can dim, it cannot re-tint. The
      //    kraft tint that used to sit here is what turned the world brown.
      vec2 puv = vUv * uResolution / uTileSize;
      float fiber = texture2D(uPaper, puv).r;
      col *= mix(1.0, fiber, uFiberStrength);

      // Master blend against the original render.
      col = mix(src.rgb, col, uStrength);

      gl_FragColor = vec4(col, src.a);
    }
  `,
};

/** Build the paper post-processing pass, sized to the canvas. */
export function createPaperPass(width: number, height: number): ShaderPass {
  const pass = new ShaderPass(PaperShader);
  pass.uniforms['uPaper'].value = createPaperTexture();
  pass.uniforms['uResolution'].value.set(width, height);
  return pass;
}
