/**
 * Paper-craft post-processing pass ("Paper Tank" 紙風格).
 *
 * Turns the neon plastic world into a paper-diorama look with a single
 * screen-space pass — no per-material changes required:
 *  1. Posterize    — quantize colors into flat printed bands.
 *  2. Desaturate   — pull neon saturation down toward matte construction paper.
 *  3. Warm tint    — shift whites toward cream / kraft-paper tone.
 *  4. Paper fiber  — multiply a procedural paper-grain texture (screen-space,
 *                    tiled at native pixel size so fibers stay crisp).
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
    /** How much of the posterized color to blend in (0-1). */
    uPosterize: { value: 0.75 },
    /** Desaturation amount toward matte paper (0-1). */
    uDesaturate: { value: 0.62 },
    /** Warm cream/kraft paper tint (multiplied). */
    uPaperColor: { value: new THREE.Vector3(1.0, 0.92, 0.76) },
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
    uniform vec3 uPaperColor;
    uniform float uStrength;

    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb;

      // 1. Posterize — flat printed color bands.
      vec3 post = floor(col * uLevels + 0.5) / uLevels;
      col = mix(col, post, uPosterize);

      // 2. Desaturate toward matte construction paper.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), uDesaturate);

      // 3. Warm cream / kraft-paper tint.
      col *= uPaperColor;

      // 4. Paper fiber — tiled at native pixel size, multiply blend.
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
