/**
 * Night grading for the 2D renderer — the one place where "it is night" turns
 * into numbers.
 *
 * ── Why this exists ──
 *
 * In 3D, night is free. `MeshToonMaterial` computes `baseColour × (sun + hemi +
 * ambient)`, so `day-night-lighting.ts` changes three intensities and EVERY
 * object in the scene reacts — including ones nobody enumerated.
 *
 * Phaser has no light term at all. `gfx.fillStyle(0xff3b3b)` writes a literal
 * colour into a vertex buffer; there is nothing for a night to multiply. Before
 * this module the 2D world's entire response to nightfall was
 * `lightsGfx.setAlpha(...)` — one additive layer fading in, while the terrain,
 * roads, trees, lamp posts and building bodies all stayed at noon brightness.
 * The measured proof is in `phaser-style-probe.mjs NIGHT=1`: on cells with no
 * lights, every channel's day↔night delta was ≤ 49 against a background delta
 * of 59, i.e. the day layer was very nearly untouched.
 *
 * The `CyclingGlassesPipeline` fragment shader is the ONLY place in the 2D
 * stack where a light term can reach every drawn pixel without rewriting all
 * 159 `fillStyle` + 98 `lineStyle` calls in the style files. So night lives
 * there, and the maths lives here — engine-free, for the same reason as
 * `land-zone.ts` and `road-classes.ts`: a headless check must be able to assert
 * on it without dragging in Phaser's WebGL pipeline base class.
 *
 * ── THE MISTAKE THIS FILE IS THE FIX FOR ──
 *
 * The first version of this module multiplied the frame by 0.42 at deep night,
 * a number derived from 3D's light sums (`sun+hemi+ambient`, 3.25 by day vs
 * 1.38 at night). It even carried an assertion tying the two together. That was
 * a confident, wrong check: **3D's light rig is not 2D's reference.** 2D's
 * reference is the 2D demo, and the demo does something arithmetically
 * different — a translucent veil, not a multiply.
 *
 *   multiply:  out = scene × 0.42                     → black stays black,
 *                                                       everything drives to 0
 *   veil:      out = scene × (1 − a) + veilColour × a  → keeps a FLOOR, and
 *                                                       adds a blue cast
 *
 * At paper's `a = 0.32` the veil is `scene × 0.68` plus a lift. The multiply
 * was 1.6× darker AND had no floor, which is exactly what "超級黑" looks like.
 *
 * So: match the demo. The veil is the mechanism, and the numbers below are the
 * demos' own, cited to the line.
 */

import type { ZoneType } from './phaser-zone-detector';

export interface ZoneModifier {
  tintMul: [number, number, number];
  brightnessMul: number;
  contrastAdd: number;
}

/**
 * The 2D renderer's environment-zone grade.
 *
 * Named `_2D` because it deliberately is NOT the 3D table in
 * `terrain/cycling-glasses-effect.ts`. 3D had every `brightnessMul` flattened
 * to 1.0 (it was a back door around the "never darker than the demos' night"
 * floor, and `check:3d` guards that); 2D still carries the original tunnel
 * ×0.45 / forest ×0.80.
 *
 * That drift is left alone on purpose. Night no longer multiplies — it veils —
 * so the two no longer compound into a black frame, which is what forced them
 * to be combined in one place before.
 */
export const ZONE_MODIFIERS_2D: Record<ZoneType, ZoneModifier> = {
  open:   { tintMul: [1, 1, 1],         brightnessMul: 1.00, contrastAdd: 0    },
  urban:  { tintMul: [1, 0.98, 0.95],   brightnessMul: 1.05, contrastAdd: 0.02 },
  forest: { tintMul: [0.85, 1, 0.85],   brightnessMul: 0.80, contrastAdd: -0.03 },
  tunnel: { tintMul: [0.7, 0.7, 0.75],  brightnessMul: 0.45, contrastAdd: 0.05 },
};

/** The 2D worlds. Mirrors `PhaserStyle` (phaser-style-strategy.ts). */
export type PhaserWorldStyle = 'plastic' | 'cuphead' | 'circuit';

export interface NightVeil {
  /** Veil colour, blended toward — NOT multiplied by. */
  color: number;
  /** Veil opacity at full night. */
  alpha: number;
}

/**
 * Each world's night veil, taken from its own 2D demo. These are the reference,
 * not a derivation — "跟 demo 一樣的光影" is the requirement.
 *
 *  · cuphead ← `plan/phaser-handdrawn-demo.html`, `fillStyle(0x0c0c28, 0.32)`
 *    on `nightGfx` (depth 880).
 *  · plastic ← `plan/phaser-plastic-demo.html` `drawNight()`,
 *    `fillStyle(0x0a0630, 0.44)` on `nightGfx` (depth 30).
 *
 *  · circuit ← `plan/phaser-circuit-demo.html`: **no veil, and that is the
 *    decision, not a default.** The demo's night changes the SKY (BG_NIGHT_*),
 *    lights the glow layer, and dims exactly one thing per element that needs
 *    it (`epaperLight` × 0.42); the board and the components stay at their day
 *    colours because the board is POWERED — a powered PCB at night is lit by
 *    itself. `alpha: 0` encodes "this world's night does not darken the frame";
 *    the colour is the demo's night fog (#08171c) so anything that ever scales
 *    the alpha up blends toward the right cast instead of toward black.
 *
 * ⚠ Demo-mirrored values. `check:3d` asserts them against the demo HTML so they
 * cannot drift silently.
 */
export const NIGHT_VEIL: Record<PhaserWorldStyle, NightVeil> = {
  cuphead: { color: 0x0c0c28, alpha: 0.32 },
  plastic: { color: 0x0a0630, alpha: 0.44 },
  circuit: { color: 0x08171c, alpha: 0 },
};

/** Dusk window: nothing happens before this, full night after it. */
export const DUSK_START = 0.25;
export const DUSK_END = 0.6;

/** Peak opacity of the additive window-light layer. */
export const LIGHTS_MAX_ALPHA = 0.9;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Smoothstep across dusk, 0 → 1.
 *
 * ONE curve, deliberately, because the world darkening and the windows lighting
 * up have to happen over the same window. Two curves would let the windows come
 * on while the street was still bright — which is the single most obvious way
 * this can look broken.
 */
export function duskRamp(nightFactor: number): number {
  const t = clamp01((nightFactor - DUSK_START) / (DUSK_END - DUSK_START));
  return t * t * (3 - 2 * t);
}

/**
 * Additive window-light layer opacity.
 *
 * Lives here rather than in `terrain-builder` so it shares `duskRamp` with the
 * veil. It was previously module-private there, which forced the headless probe
 * to hand-copy it — a mirror nobody could assert on.
 */
export function nightLightAlpha(nightFactor: number): number {
  return duskRamp(nightFactor) * LIGHTS_MAX_ALPHA;
}

/** How strongly the veil is blended in right now, 0 = none. */
export function nightVeilAmount(nightFactor: number, style: PhaserWorldStyle): number {
  return duskRamp(nightFactor) * NIGHT_VEIL[style].alpha;
}

/** Veil colour as linear-ish 0..1 components, for a shader uniform. */
export function nightVeilRgb(style: PhaserWorldStyle): [number, number, number] {
  const c = NIGHT_VEIL[style].color;
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/**
 * What one channel becomes under the veil — the same `mix()` the shader does.
 *
 * Exported so a check can assert the CURVE, not just the constants: the whole
 * bug this file replaced was using the right idea with the wrong arithmetic.
 */
export function veiledChannel(
  channel: number,
  veilChannel: number,
  amount: number,
): number {
  return channel * (1 - amount) + veilChannel * amount;
}
