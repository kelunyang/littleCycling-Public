/**
 * Cloud shadows (F3) — soft dark patches drifting across the terrain on clear
 * days. A single tiling noise texture is sampled in WORLD XZ (floating origin is
 * fixed, so world XZ is stable) and multiplied into the terrain albedo via an
 * `onBeforeCompile` injection. One shared uniform set drives every chunk's
 * terrain material at once; `SkyAndFog.update()` advances the drift + strength.
 *
 * Injected into BOTH world styles' terrain material (plastic plain toon, paper
 * crayon toon). The injector CHAINS onto any existing `onBeforeCompile` (paper's
 * crayonize) instead of clobbering it — the two shader edits touch different
 * chunks (`color_fragment` vs `map_fragment`) so they compose.
 *
 * Not applied to roads / landuse (different materials) — a slight albedo mismatch
 * there is an accepted limitation.
 */

import * as THREE from 'three';

/** World-metres → texture-UV scale. One noise tile ≈ 1/scale metres (~1100m). */
export const CLOUD_SHADOW_UV_SCALE = 0.0009;

/** Shared uniforms — the SAME objects are assigned into every injected shader,
 *  so updating `.value` here propagates to all chunk materials at once. */
/**
 * Live diagnostic: force cloud shadows off.
 *
 * This is the ONLY per-fragment multiply applied to the terrain albedo and to
 * nothing else, which makes it the only candidate that can darken a hillside
 * without touching the roads or buildings on it. Two properties matter:
 *
 *  - The texture bottoms out at ~0.13, not the 0.5 its per-blob alpha suggests:
 *    14 blobs are each stamped at 9 wrap offsets, and overlapping source-over
 *    composites multiply down (0.5 -> 0.25 -> 0.125 ...). So a "soft shadow"
 *    can take 87% of the albedo.
 *  - It is sampled in world XZ. On flat ground that is a soft round patch; on a
 *    steep slope the planar projection smears one texel down the whole face,
 *    which turns those patches into long dark STREAKS.
 *
 * Flat ground clean, hillsides streaked — switch it off and find out.
 */
let cloudShadowDisabled = false;
let cloudStrengthBeforeDisable = 0;

export function setCloudShadowEnabled(enabled: boolean): void {
  if (enabled === !cloudShadowDisabled) return;
  if (enabled) {
    cloudShadowDisabled = false;
    cloudShadowUniforms.uCloudStrength.value = cloudStrengthBeforeDisable;
  } else {
    cloudStrengthBeforeDisable = cloudShadowUniforms.uCloudStrength.value;
    cloudShadowDisabled = true;
    cloudShadowUniforms.uCloudStrength.value = 0;
  }
}

export function getCloudShadowEnabled(): boolean {
  return !cloudShadowDisabled;
}

/** True while the diagnostic is holding strength at zero — the weather driver
 *  must not fight it. */
export function isCloudShadowDisabled(): boolean {
  return cloudShadowDisabled;
}

export const cloudShadowUniforms = {
  uCloudOffset: { value: new THREE.Vector2(0, 0) },
  uCloudStrength: { value: 0 },
  uCloudMap: { value: null as THREE.Texture | null },
};

let _cloudTex: THREE.CanvasTexture | null = null;
function cloudShadowTexture(): THREE.CanvasTexture {
  if (_cloudTex) return _cloudTex;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  // Soft dark blobs (=shadow). Draw each at the 9 wrap offsets so the texture
  // tiles seamlessly with RepeatWrapping.
  for (let i = 0; i < 14; i++) {
    const bx = Math.random() * size;
    const by = Math.random() * size;
    const r = 30 + Math.random() * 70;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(bx + ox, by + oy, 0, bx + ox, by + oy, r);
        g.addColorStop(0, 'rgba(0,0,0,0.5)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(bx + ox - r, by + oy - r, r * 2, r * 2);
      }
    }
  }
  _cloudTex = new THREE.CanvasTexture(canvas);
  _cloudTex.wrapS = THREE.RepeatWrapping;
  _cloudTex.wrapT = THREE.RepeatWrapping;
  _cloudTex.needsUpdate = true;
  return _cloudTex;
}

/**
 * Inject cloud-shadow sampling into a terrain material. Chains onto any existing
 * onBeforeCompile / customProgramCacheKey so it composes with paper's crayonize.
 * Returns the same material for call chaining.
 */
export function injectCloudShadow<T extends THREE.Material>(material: T): T {
  if (!cloudShadowUniforms.uCloudMap.value) {
    cloudShadowUniforms.uCloudMap.value = cloudShadowTexture();
  }

  const prevOBC = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevOBC) prevOBC.call(material, shader, renderer);

    shader.uniforms.uCloudOffset = cloudShadowUniforms.uCloudOffset;
    shader.uniforms.uCloudStrength = cloudShadowUniforms.uCloudStrength;
    shader.uniforms.uCloudMap = cloudShadowUniforms.uCloudMap;

    shader.vertexShader = 'varying vec2 vCloudXZ;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
    );
    shader.fragmentShader =
      'uniform vec2 uCloudOffset;\nuniform float uCloudStrength;\nuniform sampler2D uCloudMap;\nvarying vec2 vCloudXZ;\n'
      + shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    float cloudShade = texture2D(uCloudMap, vCloudXZ * ${CLOUD_SHADOW_UV_SCALE.toFixed(6)} + uCloudOffset).r;
    diffuseColor.rgb *= mix(1.0, cloudShade, uCloudStrength);
  }`,
      );
  };

  // Cache key must distinguish this shader from other injected/uninjected
  // materials. Fold in any prior onBeforeCompile's source so plastic-terrain and
  // paper-terrain (different edits) never share a compiled program.
  const prevKeyFn = material.customProgramCacheKey?.bind(material);
  const prevTag = prevOBC ? prevOBC.toString() : '';
  material.customProgramCacheKey = () => (prevKeyFn ? prevKeyFn() : prevTag) + '|cloudShadow';

  return material;
}
