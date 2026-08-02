/**
 * Maps CelestialState + weather + world style → concrete Three.js lighting.
 *
 * The old version blended between hard-coded "realistic" colour constants and
 * pushed `toneMappingExposure` down to 0.6–0.9 to stop the Preetham sky dome
 * from blowing out. With the sky replaced by a flat gradient dome (see
 * `gradient-sky.ts`), that crutch is gone: **exposure is constant** and the mood
 * comes entirely from the style's own day/night palette + fog.
 *
 * Both ends of the blend are the demos' hand-tuned values (`strategy.skyPalette`),
 * so the darkest this world can ever get is the demos' night — never a black
 * hole. Weather adds haze and flattens the key light; it must not add darkness.
 */

import * as THREE from 'three';
import type { CelestialState } from './sun-moon-calc';
import type { WeatherType } from './sky-and-fog';
import type { SkyMood, SkyPalette } from './terrain-style-strategy';
import { CHUNK_LENGTH, CHUNKS_AHEAD } from './terrain-chunk-manager';
import { MOUNTAIN_FAR_RADIUS } from './mountain-ring';

/** Maximum fog far distance — terrain edges must always be hidden. */
const MAX_FOG_FAR = CHUNK_LENGTH * CHUNKS_AHEAD; // 6000m

/**
 * How deep into the haze the FAR mountain ring is allowed to sit, in clear
 * weather. The fog's far end is held back until this holds.
 *
 * This is the demos' relationship, not a taste call. Every demo puts its fog's
 * far end well past its outer ring:
 *
 *   plastic   fog 260–780,  far ring 600         → 65% of the way in
 *   paper     fog 300–1060, far ring 640         → 45%
 *   circuit   fog 300–1060, fins out to 620+190  → 67%
 *
 * > 霧的遠端要拉到遠山之外,不然兩圈…會整個被霧吃掉,只剩剪影 —— 那就白做了。
 *
 * gameview had fog 800–3000 against a 2600 m ring: **82% fog**, i.e. the far
 * ring was 82% sky colour before anything about its shape mattered
 * (plan/migrate-demo-worlds.md §3.5). Taking the tightest of the three demos,
 * 65%, puts the clear-weather far end at ~3550 m — still well inside
 * MAX_FOG_FAR, so the terrain's own edge stays buried in full fog.
 *
 * Applied to the BASE distance, before the weather multipliers. Rain and snow
 * are still allowed to swallow the mountains whole; that is what weather is for,
 * and the demos have none.
 *
 * The paper world does not need this — its rings declare `fog: false`, which is
 * the demo's own answer for an ink wash. It is plastic and circuit, whose rings
 * are physical objects standing in real haze, that this keeps visible.
 */
const MOUNTAIN_RING_FOG_DEPTH = 0.65;

/**
 * Constant tone-mapping exposure (ACES), the demos' value. Never modulated: the
 * scene is lit by its palette, not by the camera's shutter. Dropping this was
 * the single biggest reason the world went muddy at dusk and in overcast.
 */
export const TONE_MAPPING_EXPOSURE = 1.05;

// ── Sun shadow map ──

/**
 * The demos' `sunLight.shadow` block, transplanted.
 *
 * ⚠ The three demos are NOT identical here, despite looking it: `normalBias` is
 * 1.5 in plastic and paper but **1.2 in circuit** — the electronics world's parts
 * are millimetre-scale (SMD bodies, fins, jumper caps) and 1.5 m of normal offset
 * lifts their shadows off their own feet. Everything else — `shadowMap.enabled`,
 * `PCFSoftShadowMap`, 2048², the ±180 box, near 20, bias −0.0006 — is byte-for-byte
 * the same in all three. The majority value is only the DEFAULT — each world's
 * own number reaches its light through `TerrainStyleStrategy.shadowNormalBias`;
 * see the note on SHADOW_NORMAL_BIAS.
 */
export const SHADOW_MAP_SIZE = 2048;

/**
 * Orthographic half-extent of the shadow camera, metres. The demos' 180, ported
 * 1:1 — and that is a decision, not a copy, because gameview sees 3–4× further.
 *
 * The box is not sized by sight distance; it is sized by **where ground contact
 * shadows land on screen**, and that follows from the lens and the eye height,
 * both of which gameview already takes from the demos: the same 55° lens
 * (`DEFAULT_FOV`) and the same chase rig scaled by `BIKE_SCALE` (fps-camera.ts),
 * which puts our eye at 6.3 m where the demos' sits at 9.5 m.
 *
 * A LOWER eye compresses distant ground toward the horizon faster, so the same
 * box covers MORE of our screen, not less:
 *
 *   ground at 180 m sits atan(9.5/180) = 3.02° below the horizon (demo)
 *                       atan(6.3/180) = 2.00°                     (gameview)
 *   half-FOV 27.5° → beyond the box lies 11.0% of the lower half-screen (demo)
 *                                         7.3%                     (gameview)
 *
 * The extra 3–4× of sight distance is all horizon and sky — the mountain rings at
 * 1700/2600 m and fog out to 3000 — and the demos put their own rings (600/640 m)
 * outside this box too. Scaling the box to gameview's fog while keeping 2048²
 * would take the texel from 0.176 m to 0.7 m, which destroys the contact shadow
 * this port exists for AND drags the whole mountain ring into the depth pass.
 * Hold the box, hold the texel; only the DEPTH range below is re-derived.
 */
export const SHADOW_HALF_EXTENT = 180;

/** The demos' shadow-camera near plane, metres. */
export const SHADOW_NEAR = 20;

/** The demos' constant depth bias (clip units). */
export const SHADOW_BIAS = -0.0006;

/**
 * The demos' offset along the surface normal, metres. plastic/paper's 1.5 —
 * and the DEFAULT, not the only value.
 *
 * Circuit's demo writes 1.2, and that is the one cell the three shadow blocks
 * disagree on. `bias`/`normalBias` are properties of the LIGHT, so the per-world
 * value rides `TerrainStyleStrategy.shadowNormalBias` and lands via
 * `GameRenderer.setSunShadowNormalBias`, pushed at both places a strategy is
 * built (`useTerrainRenderer.ts`) — including the mid-ride world swap.
 */
export const SHADOW_NORMAL_BIAS = 1.5;

/** Degrees → radians, the demos' `SKY_D2R`. */
const SKY_D2R = Math.PI / 180;

/**
 * The elevation at which the key light is worth its full intensity, degrees —
 * the demos' `skyKeyFullDeg`, transplanted (SKY 區塊, `plastic:2336`,
 * `paper:2906`, `circuit:2699`; the three are byte-for-byte identical).
 *
 * > 主光在地平線附近要**收掉**,而不是把它抬起來。
 *
 * gameview used to run `Math.max(MIN_LIGHT_ELEV = 15, elev)` — it hauled the
 * light UP to 15°. That 15 had no demo behind it, and what it did was lie: at
 * sunrise the light really is at 0°, and lifting it to 15° draws sunrise as 9am
 * while throwing away the long raking shadows that are the best thing about it.
 *
 * The demos answer in the opposite direction: the low angle is REAL, and what
 * has to be handled is its two consequences, neither of which moving the sun can
 * fix —
 *
 *  1. **Light parallel to the ground does not light the ground.** Lambert at 0°
 *     is 0, and that is correct: a sunrise ground is lit by the SKY (hemi + amb),
 *     not by the sun.
 *  2. **A grazing shadow is not a shadow, it is noise on the shadow map.** One
 *     texel covers `2E / mapSize` metres; on a surface at elevation θ the depth
 *     spread inside that texel is `texel / tanθ`, while `normalBias` pushes along
 *     the normal by `normalBias · sinθ`. Acne starts where the first exceeds the
 *     second, i.e. at
 *
 *         normalBias · (1 − c²) = texel · c,   c = cosθ
 *
 * So the threshold is not PICKED — it is what this world's own `shadow` block
 * (the box, the map size, and its own `normalBias`) computes. Circuit's 1.2 gives
 * a different angle from plastic/paper's 1.5, and that pre-existing, deliberate
 * divergence (`SHADOW_NORMAL_BIAS`, `setSunShadowNormalBias`) rides all the way
 * through to here rather than being flattened. Same reason the caller reads the
 * LIVE `mapSize`: a half-resolution tier has coarser texels, so it needs a
 * higher sun before its shadows are worth anything.
 *
 *   ±180 box, 2048², normalBias 1.5 → 19.42°   (plastic, paper)
 *                    normalBias 1.2 → 21.65°   (circuit)
 */
export function skyKeyFullDeg(halfExtent: number, mapSize: number, normalBias: number): number {
  const texel = (halfExtent * 2) / mapSize;
  const c = (-texel + Math.sqrt(texel * texel + 4 * normalBias * normalBias))
    / (2 * normalBias);
  return Math.acos(c) / SKY_D2R;
}

/**
 * How much of the key light survives, 0…1 — the demos' `skyKeyGainAt`.
 *
 * > 主光的有效程度:地平線以下(含 0°)是 0,到 fullDeg 以上是全額。
 *
 * Both consequences above share ONE ramp, so they cannot disagree: the instant
 * the shadow is switched off (gain = 0) the key light's intensity is 0 too — no
 * light, no shadow, one thing rather than two thresholds. `gain(0°) =
 * gain(−5°) = gain(−10°) = 0`; the sky (hemisphere + ambient) takes over.
 *
 * Noon is untouched: the demos' pinned sun sits at 47.36°, well past either
 * threshold, so `gain = 1` exactly and the default look does not move a pixel.
 */
export function skyKeyGainAt(elevDeg: number, fullDeg: number): number {
  return smoothstep(0, fullDeg, elevDeg);
}

/**
 * The NIGHT FLOOR under the key light's ILLUMINATION — not under its shadow.
 *
 * The demos' night is not keyless. On the demos' arc the body on duty is always
 * the sun's exact antipode (`skyCelestial`: `moon = -sun`, `key = isDay ? sun :
 * moon`), so `keyElev === |sunElev|` and `?night=1` is lit by a **+47.38° moon at
 * `skyPalette.night.sunColor / sunIntensity`** — that blue key IS the demos'
 * night, written down in the palette next to the sky and the fog.
 *
 * gameview's moon is not the antipode (`sun-moon-calc.ts`:
 * `moonElev = -sunElev × (0.3 + 0.7·fullMoonFactor)`), so as the moon wanes it
 * rides LOWER than the demos' and `skyKeyGainAt` takes a cut the demos never
 * take. At Taipei, 21:00, sun at −29°:
 *
 *   full moon  moon +27.6° → gain 1.0000 → key 0.700   (= the demos')
 *   new moon   moon  +8.7° → gain 0.4223 → key 0.296   (58% of the blue key gone)
 *
 * So the floor is the gain the DEMOS' key would have at this same hour —
 * `skyKeyGainAt(-sunElev)`, using this world's own threshold. Three properties
 * follow, and each is asserted:
 *
 *  1. **The day is untouched, byte for byte.** Above the horizon `-sunElev < 0`
 *     and `skyKeyGainAt` is 0 there, so `max(gain, floor) === gain` for the whole
 *     day, noon included. Sunrise/sunset stay at exactly 0 — the demos' answer
 *     ("平行地面的光照不亮地面") is not overridden.
 *  2. **It never exceeds the demos.** gameview's moon is never HIGHER than the
 *     antipode, so the floor only ever closes the gap; it cannot make a gameview
 *     night brighter than `?night=1`.
 *  3. **Shadows are not touched.** The caller keeps feeding the REAL
 *     `skyKeyGainAt(keyElev)` to `setKeyLightShadowGain`, so a low moon still
 *     casts nothing — the acne threshold `skyKeyFullDeg` derives is about the
 *     shadow MAP, and a floor on the illumination has no bearing on it.
 *
 * `keyElevDeg <= 0` returns 0 and that is the demos' rule, not a guard: a body
 * under the horizon is not on duty, so there is nothing to floor. gameview's own
 * moon model cannot produce that state at night (the elevation above is ≥ 0
 * whenever `sunElev ≤ 0`), which is exactly why `SkyAndFog.legacyCelestial` had
 * to stop handing the moon the sun's un-negated elevation — see the note there.
 */
export function nightKeyFloorGain(
  sunElevDeg: number,
  keyElevDeg: number,
  fullDeg: number,
): number {
  if (keyElevDeg <= 0) return 0;
  return skyKeyGainAt(-sunElevDeg, fullDeg);
}

/**
 * Vertical band around the rider's own road surface that the shadow camera must
 * contain, metres.
 *
 * The demos' `near = 20 / far = 600` are NOT ported. They are safe constants only
 * because the demos pin their sun: `sunLight.position.set(bp.x + 150, 190, bp.z + 90)`
 * every frame, a fixed 47.4° elevation, for the whole ride. gameview points the
 * key light at the real sun (`sky-and-fog.ts`) — at its REAL elevation, all the
 * way down to 0° and below, since `skyKeyGainAt` replaced the old
 * `MIN_LIGHT_ELEV = 15°` clamp — and the demos' numbers reach only
 * 238 × sin 15° = 62 m above the road even at 15°, never mind at 2°:
 * a hillside beside the route would fall behind the near plane and stop casting.
 *
 * Removing the clamp changes NONE of the numbers below, and that is the point of
 * deriving them the way they are derived: `SHADOW_HALF_DEPTH` is `hypot(E√2, V)`,
 * a closed form maximised over the whole sphere of light directions, so it never
 * depended on where the clamp sat. (The headless check sweeps the demos' own arc
 * down to 0° against it — worst corner 26.7 m, still clear of `near` 20.)
 *
 * So the depth range is derived from the box and this band instead. The band is
 * measured, not guessed, on the saved 45 km Taipei route:
 *
 *   terrain within 180 m of the road   +94.7 m … −107.5 m   (DEM, 45 m grid)
 *   tallest building extruded           161 m               (BOXSTATS p99)
 *
 * Widening an ORTHOGRAPHIC depth range is close to free — precision is uniform
 * (24-bit over 940 m still resolves 0.06 mm) and the only side effect is that
 * more bounds intersect the frustum, which for gameview's chunk-sized merged
 * meshes they already do. The failure mode at the top is soft and silent (a
 * caster stops casting), so the headroom is there for a route steeper than the
 * one that was measured.
 */
const SHADOW_TALLEST_CASTER_M = 94.7 + 161;
const SHADOW_DEEPEST_RECEIVER_M = 107.5;
const SHADOW_REACH_HEADROOM = 1.5;
export const SHADOW_VERTICAL_REACH =
  Math.max(SHADOW_TALLEST_CASTER_M, SHADOW_DEEPEST_RECEIVER_M) * SHADOW_REACH_HEADROOM;

/**
 * Half the shadow camera's depth range, metres — the largest projection onto the
 * light axis of the box (±SHADOW_HALF_EXTENT horizontally, ±SHADOW_VERTICAL_REACH
 * vertically) centred on the rider, maximised over every direction the key light
 * can take.
 *
 * For a unit light direction (dx, dy, dz) the projection is
 * `E·(|dx| + |dz|) + V·|dy|`, whose maximum over the sphere is `hypot(E√2, V)`.
 * Closed form, so the frustum is elevation-independent: nothing has to be
 * recomputed as the sun climbs, and there is no angle at which the box escapes.
 */
const SHADOW_HALF_DEPTH = Math.hypot(SHADOW_HALF_EXTENT * Math.SQRT2, SHADOW_VERTICAL_REACH);

/** Metres up the light axis the key light is parked, so `near` clears the box. */
export const SHADOW_LIGHT_DISTANCE = SHADOW_NEAR + SHADOW_HALF_DEPTH;

/** The shadow camera's far plane, metres. */
export const SHADOW_FAR = SHADOW_NEAR + 2 * SHADOW_HALF_DEPTH;

/**
 * Depth, along the light axis, of a point `offset` metres from the shadow box's
 * centre — i.e. where it lands between `near` and `far`. Exported for the
 * headless check, which sweeps the whole sun range against it.
 *
 * `dir` points from the target TOWARD the light, which is the direction three
 * derives the shadow camera's view from.
 */
export function shadowDepthOf(
  dir: { x: number; y: number; z: number },
  offset: { x: number; y: number; z: number },
): number {
  return SHADOW_LIGHT_DISTANCE - (dir.x * offset.x + dir.y * offset.y + dir.z * offset.z);
}

/**
 * Fallback palette, used only until `SkyAndFog.setPalette()` receives the world
 * style's own (the strategy loads async). Neutral daylight — not either style.
 */
export const DEFAULT_SKY_PALETTE: SkyPalette = {
  // Placeholder shape, like the placeholder colours around it: `setPalette` runs
  // before `init()` on every real path, so no dome is ever built from this. It
  // is deliberately not any world's — 500/5 is what two of the three demos say.
  gradient: { demoHeight: 500, steps: 5 },
  day: {
    skyTop: 0x8fd8ee, skyBottom: 0xf0e6e0, fog: 0xe6dcd0,
    sunColor: 0xfff4e0, sunIntensity: 2.0,
    hemiSky: 0xd8f0f8, hemiGround: 0x88a070, hemiIntensity: 0.9,
    ambientColor: 0xfff4ec, ambientIntensity: 0.35,
  },
  night: {
    skyTop: 0x1c1a44, skyBottom: 0x423560, fog: 0x2f2a50,
    sunColor: 0x9fb0e8, sunIntensity: 0.7,
    hemiSky: 0x323868, hemiGround: 0x33372c, hemiIntensity: 0.5,
    ambientColor: 0xfff4ec, ambientIntensity: 0.18,
  },
};

/** Lighting parameters computed from time of day + weather. */
export interface DayNightLightingParams {
  ambientIntensity: number;
  ambientColor: number;
  directionalIntensity: number;
  directionalColor: number;
  hemisphereIntensity: number;
  hemisphereColor: number;
  hemisphereGroundColor: number;
  /** Gradient dome, top and horizon. */
  skyTopColor: number;
  skyBottomColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  backgroundColor: number;
  toneMappingExposure: number;
}

// ── Twilight warmth ──

/**
 * Dawn/dusk tint. The day↔night blend alone goes straight from blue to blue; a
 * pass of warm orange around the horizon crossing gives back the golden hour
 * without darkening anything.
 */
const TWILIGHT_SUN = 0xff9a4a;
const TWILIGHT_SKY_BOTTOM = 0xffb27a;
const TWILIGHT_FOG = 0xe8b090;

// ── Weather ──

interface WeatherMultipliers {
  /** Fill light — overcast SCATTERS light, so this goes UP, not down. */
  ambientMul: number;
  /** Key light — clouds soften the sun; the scene flattens, it does not darken. */
  directionalMul: number;
  hemisphereMul: number;
  fogNearMul: number;
  fogFarMul: number;
  /** Grey the sky/fog is pulled toward, and how far (0 = none). */
  overcastColor: number;
  overcastMix: number;
}

const WEATHER: Record<WeatherType, WeatherMultipliers> = {
  sunny: {
    ambientMul: 1.0,
    directionalMul: 1.0,
    hemisphereMul: 1.0,
    fogNearMul: 1.0,
    fogFarMul: 1.0,
    overcastColor: 0x000000,
    overcastMix: 0,
  },
  cloudy: {
    // Flat, hazy, and BRIGHT — an overcast noon is not a dim noon.
    ambientMul: 1.3,
    directionalMul: 0.5,
    hemisphereMul: 1.25,
    fogNearMul: 0.4,
    fogFarMul: 0.45,
    overcastColor: 0xc4c8cc,
    overcastMix: 0.5,
  },
  rainy: {
    ambientMul: 1.1,
    directionalMul: 0.35,
    hemisphereMul: 0.9,
    fogNearMul: 0.25,
    fogFarMul: 0.3,
    overcastColor: 0xa8acb4,
    overcastMix: 0.6,
  },
  snowy: {
    ambientMul: 1.2,
    directionalMul: 0.42,
    hemisphereMul: 1.05,
    fogNearMul: 0.35,
    fogFarMul: 0.35,
    overcastColor: 0xd0d0d4,
    overcastMix: 0.7,
  },
};

/**
 * Hard floors, as a fraction of the style's NIGHT mood. No combination of hour
 * and weather may go below these — "the darkest night is the demo's night" is a
 * product requirement, so it is enforced at the exit rather than trusted to the
 * arithmetic. A stormy 3am lands here.
 */
const FLOOR = {
  ambient: 1.0,      // never dimmer than the night palette's fill
  directional: 0.35,
  hemisphere: 0.6,
};

// ── Helpers ──

const _a = new THREE.Color();
const _b = new THREE.Color();

/** Linearly interpolate two hex colours. t ∈ [0,1]. */
function mixHex(a: number, b: number, t: number): number {
  return _a.setHex(a).lerp(_b.setHex(b), Math.max(0, Math.min(1, t))).getHex();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Smooth 0→1 ramp between two thresholds — the demos' `skySmoothstep`.
 *
 * NOT rewritten to match it character for character, and that is deliberate. The
 * demos write `Math.min(1, Math.max(0, …))` and this writes the clamp the other
 * way round; the two are the same function on every input, including NaN (both
 * propagate) and −0 (both return +0), so re-ordering would be churn on working
 * code rather than a port. What makes that claim checkable rather than asserted
 * in prose is `[sky vs demo]`, which slices `skySmoothstep` out of the HTML,
 * RUNS it, and demands bit-for-bit agreement across 18 001 elevations plus both
 * edges — so if either side is ever edited, the check goes red.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the NIGHT mood is mixed in, from the sun's elevation.
 * 1 = deep night (sun below −12°), 0 = day (sun above +8°).
 *
 * The demos' `skyCelestial().night`, same two edges: `1 − skySmoothstep(−12, 8,
 * sunElev)`. −12° is the bottom of nautical twilight (the last light is still in
 * the sky) and +8° is the sun fully up. This side was written first and the demo
 * copied it (it says so, and `demo-gaps.md` recorded the invention), so the port
 * direction is reversed here — but the maintenance problem is identical, and
 * `[sky vs demo]` pins it the same way: it runs the demo's OWN arc, reads
 * `night` off the object `skyCelestial` ships, and compares to this function
 * bit-for-bit at every phase.
 */
export function nightFactorFromElevation(sunElevation: number): number {
  return 1 - smoothstep(-12, 8, sunElevation);
}

/** How "golden" the hour is — peaks as the sun crosses the horizon. */
function twilightFactor(sunElevation: number): number {
  if (sunElevation < -10 || sunElevation > 14) return 0;
  // Peak at ~2°, tapering either side.
  return sunElevation <= 2
    ? smoothstep(-10, 2, sunElevation)
    : 1 - smoothstep(2, 14, sunElevation);
}

/** Blend the two ends of a style's palette into one mood. */
function blendMood(day: SkyMood, night: SkyMood, k: number): SkyMood {
  return {
    skyTop: mixHex(day.skyTop, night.skyTop, k),
    skyBottom: mixHex(day.skyBottom, night.skyBottom, k),
    fog: mixHex(day.fog, night.fog, k),
    sunColor: mixHex(day.sunColor, night.sunColor, k),
    sunIntensity: lerp(day.sunIntensity, night.sunIntensity, k),
    hemiSky: mixHex(day.hemiSky, night.hemiSky, k),
    hemiGround: mixHex(day.hemiGround, night.hemiGround, k),
    hemiIntensity: lerp(day.hemiIntensity, night.hemiIntensity, k),
    ambientColor: mixHex(day.ambientColor, night.ambientColor, k),
    ambientIntensity: lerp(day.ambientIntensity, night.ambientIntensity, k),
  };
}

/**
 * Compute final lighting from celestial state, weather, and the world style's
 * palette.
 */
export function computeDayNightLighting(
  celestial: CelestialState,
  weather: WeatherType,
  palette: SkyPalette,
): DayNightLightingParams {
  const { sunElevation } = celestial;
  const w = WEATHER[weather];

  const night = nightFactorFromElevation(sunElevation);
  const mood = blendMood(palette.day, palette.night, night);

  // Golden hour: warm the key light, the horizon band, and the fog — colour
  // only, no intensity change.
  const golden = twilightFactor(sunElevation);
  if (golden > 0) {
    mood.sunColor = mixHex(mood.sunColor, TWILIGHT_SUN, golden * 0.8);
    mood.skyBottom = mixHex(mood.skyBottom, TWILIGHT_SKY_BOTTOM, golden * 0.65);
    mood.fog = mixHex(mood.fog, TWILIGHT_FOG, golden * 0.5);
  }

  // Weather: haze the sky/fog toward grey, flatten the key light, lift the fill.
  let skyTop = mood.skyTop;
  let skyBottom = mood.skyBottom;
  let fogColor = mood.fog;
  if (w.overcastMix > 0) {
    // Grey the overcast toward the current mood's own darkness so a cloudy night
    // stays a NIGHT (deep blue-grey), not a bright grey day with the lights off.
    const grey = mixHex(w.overcastColor, mood.skyTop, night * 0.75);
    skyTop = mixHex(skyTop, grey, w.overcastMix);
    skyBottom = mixHex(skyBottom, grey, w.overcastMix * 0.85);
    fogColor = mixHex(fogColor, grey, w.overcastMix);
  }

  // Fog distances: base spans lerped day→night, then hauled in by weather.
  //
  // The base far end is also held past the far mountain ring — see
  // MOUNTAIN_RING_FOG_DEPTH. Solving `depth = (r − near) / (far − near)` for
  // `far` is the whole of it; the ring is at a fixed radius, so this only ever
  // moves with `baseFogNear`.
  const baseFogNear = lerp(800, 600, night);
  const baseFogFar = Math.max(
    lerp(3000, 2600, night),
    baseFogNear + (MOUNTAIN_FAR_RADIUS - baseFogNear) / MOUNTAIN_RING_FOG_DEPTH,
  );
  const fogFar = Math.min(baseFogFar * w.fogFarMul, MAX_FOG_FAR);
  const fogNear = Math.min(baseFogNear * w.fogNearMul, fogFar * 0.3);

  // Floors — the demos' night is the darkest this world gets, whatever the sky
  // is doing. Applied AFTER the weather multipliers, which is the whole point.
  const n = palette.night;
  const ambientIntensity = Math.max(
    mood.ambientIntensity * w.ambientMul,
    n.ambientIntensity * FLOOR.ambient,
  );
  const directionalIntensity = Math.max(
    mood.sunIntensity * w.directionalMul,
    n.sunIntensity * FLOOR.directional,
  );
  const hemisphereIntensity = Math.max(
    mood.hemiIntensity * w.hemisphereMul,
    n.hemiIntensity * FLOOR.hemisphere,
  );

  return {
    ambientIntensity,
    ambientColor: mood.ambientColor,
    directionalIntensity,
    directionalColor: mood.sunColor,
    hemisphereIntensity,
    hemisphereColor: mood.hemiSky,
    hemisphereGroundColor: mood.hemiGround,
    skyTopColor: skyTop,
    skyBottomColor: skyBottom,
    fogColor,
    fogNear,
    fogFar,
    // The dome covers the whole view, so this only shows through if the dome is
    // ever culled — keep it on the horizon colour so it can't flash black.
    backgroundColor: skyBottom,
    toneMappingExposure: TONE_MAPPING_EXPOSURE,
  };
}
