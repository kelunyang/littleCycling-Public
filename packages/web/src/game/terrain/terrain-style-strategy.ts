/**
 * TerrainStyleStrategy — Strategy pattern for the Three.js world's visual style,
 * mirroring the Phaser 2D `PhaserStyleStrategy` (game/phaser/phaser-style-strategy.ts).
 *
 * One construction logic, two "hand-made" styles:
 *  - `plastic`  → toy BLOCKS: cubic-stepped terrain of slightly height-varied
 *                 blocks, glossy primary colours.
 *  - `paper`    → CORRUGATED cardboard: contour-stacked sheets with exposed
 *                 corrugated edges, matte kraft tones + ink outlines.
 *
 * Every renderer (terrain-chunk / building / road / landuse / tree) pulls its
 * materials + colours + geometry decisions from the injected strategy instead
 * of importing `cartoon-materials.ts` directly, so switching the strategy swaps
 * the whole pipeline.
 *
 * Zero external assets — everything procedural (DEVPLAN "所有視覺元素都是程序化").
 * Blocks/brick are generic craft words; no LEGO branding, models, or
 * trademarked proportions.
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { WorldStyle, WorldOptionKey } from '@littlecycling/shared';
import type { ZoneKind } from './sign-spec';
import type { WindowPlacement } from './building-lights';
import type { GroundStudStyle } from './ground-studs';

/**
 * Config-level world style value (shared with Phaser + DOM `data-world-style`).
 * Re-exported from `@littlecycling/shared` so there is ONE list of worlds: the
 * per-world option table (world-options.ts) keys off the same union, which is
 * what makes a fourth world a compile error there instead of a silent `else`.
 */
export type { WorldStyle };

/** Which ring of the distant mountain silhouette is being generated. */
export type MountainLayer = 'near' | 'far';

/**
 * How one mountain ring is FINISHED — the half of the far scenery that is not
 * its outline.
 *
 * `plan/paper-town-demo.html` builds each ring as `{ wash, line }`: a flat wash
 * with a darker band along the crest. That band is the ink line a brush leaves
 * where it lifts off the ridge, and it is the whole reason the paper world's
 * horizon reads as painted rather than as a coloured wall. It had no home in
 * gameview at all (`plan/migrate-demo-worlds.md` §3.5) — `mountainColor(layer)`
 * was one number per ring and nothing else.
 *
 * `fog` is the other half of that decision, and it is not a performance knob:
 *
 * > **不吃霧**。同理:它已經是「遠」的表現手法本身,再被霧吃一次就糊了。
 * > 濃淡直接由兩圈的顏色決定(遠淡近濃),那才是水墨處理距離的方式。
 *
 * A painted horizon is already the world's way of SAYING "far"; running it
 * through the haze a second time says it twice and the ring dissolves. A world
 * whose rings are physical objects (plastic's moulded brick terraces, circuit's
 * copper fins) wants the opposite and should leave `fog` on — the demos differ
 * here on purpose.
 */
export interface MountainRingFinish {
  /**
   * Crest band colour, or `null` for a ring that is one flat wash (the plastic
   * and circuit demos have no ink line — "this world does not draw one" is a
   * legitimate answer, not a gap).
   */
  ridgeLineColor: number | null;
  /**
   * Band depth as a FRACTION of the ring's peak height — the demo's
   * `lineH = o.maxH * 0.035`. A fraction rather than metres so it survives the
   * rescale from the demo's 640 m ring to gameview's 2600 m one.
   */
  ridgeLineThickness: number;
  /** Does the silhouette take scene fog? See above — this is an art decision. */
  fog: boolean;
}

/**
 * The rider's bike ornament, handed to `BikeOrnament` (bike-ornament.ts) which
 * owns the per-frame animation. The style only decides what it looks like.
 */
export interface BikeOrnamentParts {
  /** Root — the manager sets world position + yaw on this. */
  root: THREE.Group;
  /** Child of root that takes the lean (roll) on corners. */
  lean: THREE.Group;
  /** Wheel groups — spun by forward motion (axle = local z). */
  wheels: THREE.Object3D[];
  /** Crank + pedals — spun at a slower, cadence-like rate. */
  crank: THREE.Object3D | null;
  /** Frees every geometry/material the ornament owns. */
  dispose(): void;
}

/**
 * The finish-line airship — a themed aircraft hovering above the route's last
 * point (cuphead → 1930s zeppelin; plastic → toy UFO), carrying a hanging banner
 * with the live "remaining km · min" text. `FinishAirshipManager`
 * (finish-airship.ts) owns the world placement, bob, and banner feed; the style
 * only builds the parts and drives its own theme animation.
 *
 * CONTRACT: every material this builds MUST set `fog: false`. The airship is a
 * far-visible finish beacon — like the moon/stars (see sky-and-fog.ts) it has to
 * punch through weather fog (which eats the terrain by ~3 km) and stay readable
 * out to the camera's far plane. Depth testing stays normal — it is a real world
 * object, not a sky sprite.
 */
export interface FinishAirshipParts {
  /** Root — the manager sets world position (x, hover-y, z) on this. */
  root: THREE.Group;
  /** Redraw the hanging banner's CanvasTexture with new text (~1 Hz). */
  setBannerText(text: string): void;
  /** Show/hide the banner (the manager hides it when the camera is far). */
  setBannerVisible(visible: boolean): void;
  /** Per-frame theme animation — propeller spin / rim-light chase, etc. */
  update(dt: number, elapsed: number): void;
  /** Frees every geometry/material AND the banner CanvasTexture. */
  dispose(): void;
}

/** A roadside lamp: geometry plus a day→night dimmer. */
export interface StreetLampParts {
  group: THREE.Group;
  /** 0 = full day (bulb off), 1 = full night (bulb glowing). */
  setNight(nightFactor: number): void;
  /**
   * Whether this lamp carries a real PointLight, as opposed to just a glowing
   * head. Every live point light costs fragment work on every lit surface, so a
   * tunnel's dense row keeps only the nearest few switched on — the rest still
   * read as lamps because their heads glow. Default: on.
   */
  setLightEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * One end of the day↔night blend: sky gradient, fog, and the three lights.
 * Values are the demos' (see `plan/ref-demo-*-src.js`) — hand-tuned to look
 * right under a CONSTANT exposure of 1.05, which is why they can be this low at
 * night and still read as "a lit toy world after dark" rather than a black hole.
 */
export interface SkyMood {
  /** Gradient dome, top and horizon. */
  skyTop: number;
  skyBottom: number;
  fog: number;
  /** Key light (sun by day, moon by night). */
  sunColor: number;
  sunIntensity: number;
  /** Bounce light. */
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Fill light — the floor of how dark the world can ever get. */
  ambientColor: number;
  ambientIntensity: number;
}

/**
 * The SHAPE of the dome's vertical gradient, as this world's own demo wrote it.
 * Both numbers are read straight off the demo's fragment shader:
 *
 *     float h = clamp(vP.y / 260.0, 0.0, 1.0);   // demoHeight
 *     h = floor(h * 5.0) / 5.0;                  // steps
 *
 * and both DIVERGE between the demos: plastic reaches `topColor` at 260 m while
 * paper and circuit reach it at 500 m, and circuit posterises into 6 bands where
 * the other two use 5. Neither is a shared constant — the port hard-coded
 * plastic's 260 for all three, which drew paper's and circuit's horizon band
 * 500 / 260 = 1.923× too low, and plastic's 5 steps over circuit's 6.
 *
 * `demoHeight` is in the DEMO's metres, i.e. against `DEMO_SKY_DOME_RADIUS`;
 * `skyGradientHeight` scales it to whatever dome this renderer uses.
 */
export interface SkyGradientStyle {
  /** `vP.y / <this>` — where the gradient reaches `topColor`, on the demo dome. */
  demoHeight: number;
  /** `floor(h * <this>) / <this>` — the hard banding is the point (hand-made look). */
  steps: number;
}

/**
 * This world's star field, as its own demo wrote it — every number here is read
 * straight off the demo's `const stars = (() => { … })()` block:
 *
 *     const n = 260, pos = new Float32Array(n * 3);              // count
 *     ph = Math.random() * Math.PI * 0.42 + 0.08;                // polarSpan / polarMin
 *     sg.fillStyle = '#fff2a0';                                  // color
 *     sg.arc(16, 16, 7, 0, Math.PI * 2);                         // spriteRadius
 *     new THREE.PointsMaterial({ size: 28.42105263157895, … });  // size
 *
 * and all five DIVERGE between the demos, exactly like `SkyGradientStyle` next
 * door: circuit draws 300 stars at size 25.26 in a 10.96°–86.56° band with a
 * 6 px pale-blue disc, plastic and paper 260 at 28.42 in 9.82°–85.42° with a
 * 7 px warm one. The port had ONE hard-coded set for all three worlds (400
 * stars, 10°–85°, an 8×8 radial gradient) — none of which is any demo's.
 */
export interface StarFieldStyle {
  /** The demo's `const n` — how many stars on the shell. */
  count: number;
  /**
   * The demo's `PointsMaterial.size`, in WORLD METRES on `DEMO_SKY_SHELL_R`
   * (`sizeAttenuation: true`). Turn it into this renderer's metres with
   * `starPointSize` — do NOT read it as screen pixels.
   */
  size: number;
  /**
   * The demo's `ph = Math.random() * Math.PI * <polarSpan> + <polarMin>` — the
   * POLAR angle from +Y in radians, so elevation is `90° − ph`. `polarSpan` is
   * in multiples of π, `polarMin` in plain radians, both as the demo writes them.
   */
  polarSpan: number;
  polarMin: number;
  /** The demo's `sg.arc(16, 16, <this>, …)` — a SOLID disc, no gradient. */
  spriteRadius: number;
  /** The demo's `sg.fillStyle` — the star's tint lives in the sprite, not the material. */
  color: string;
}

/**
 * The demos' star sprite canvas: all three write `spr.width = spr.height = 32`
 * and centre the disc at (16, 16), word for word — shared for the same reason
 * `DEMO_SKY_DOME_RADIUS` is, while the disc's RADIUS diverges and lives per
 * world in `StarFieldStyle`.
 */
export const DEMO_STAR_SPRITE_PX = 32;

/**
 * The demos' `SKY_SHELL_R` — the shell their stars, sun and moon all hang on.
 * All three declare 3000 (it is gameview's `MOON_DISTANCE`, transcribed the
 * other way round for once), so `starPointSize` below is the identity today.
 */
export const DEMO_SKY_SHELL_R = 3000;

/**
 * The point size, in scene metres, that reproduces the demo's star at whatever
 * shell this renderer hangs its sky on. `celestialDiscRadius` for the star
 * field, and it exists for a reason with a commit number on it:
 *
 * `sizeAttenuation: true` means `size` is metres on the shell, so the apparent
 * size is `size / shellRadius` — **the two move together or the stars change
 * size.** 17c0f86 pushed the demos' `SKY_SHELL_R` from 950 to 3000 and left
 * `size: 9` alone, shrinking their own stars to 0.317× (5.12 px → 1.62 px on a
 * 1080-tall viewport); the sun and moon were untouched by the same commit only
 * because `skyPlaceDisc` already scaled them by `skyShell / r`. This is that
 * missing scale, on our side of the port.
 *
 * At `shellRadius === DEMO_SKY_SHELL_R` the ratio is exactly 1.0, so the result
 * is BIT-IDENTICAL to the demo's literal — which is the state we are in, and
 * why the styles carry the demo's number verbatim.
 */
export function starPointSize(demoSize: number, shellRadius: number): number {
  return demoSize * (shellRadius / DEMO_SKY_SHELL_R);
}

/** The two ends the day/night system interpolates between, per world style. */
export interface SkyPalette {
  day: SkyMood;
  night: SkyMood;
  /** The gradient's shape, alongside the `skyTop` / `skyBottom` that colour it. */
  gradient: SkyGradientStyle;
  /**
   * This world's star field. Optional only because `DEFAULT_SKY_PALETTE` (the
   * placeholder that stands in until the async strategy loads) would otherwise
   * have to invent one; every real style declares it, and `[sky vs demo]`
   * asserts all three against their demos.
   */
  stars?: StarFieldStyle;
}

/**
 * The demos' gradient dome radius: all three write
 * `new THREE.SphereGeometry(1100, 24, 12)` word for word, so this is shared —
 * like `DEMO_SKY_MOUNT` below, and for the same reason.
 */
export const DEMO_SKY_DOME_RADIUS = 1100;

/**
 * The gradient height, in scene metres, that reproduces the demo's horizon band
 * at whatever dome radius this renderer uses. `celestialDiscRadius` for the sky
 * dome: one shared ratio, one number per world kept at the world's own call
 * site (`skyPalette.gradient.demoHeight`).
 */
export function skyGradientHeight(demoHeight: number, domeRadius: number): number {
  return (demoHeight / DEMO_SKY_DOME_RADIUS) * domeRadius;
}

/**
 * Where the demos hang their sun and moon, verbatim. All three 3D demos share
 * this block word for word (`DEMO_POC_GUIDE` §5): a rider-following `skyAnchor`
 * with `sunDisc.position.set(340, 330, -420)` and
 * `moonDisc.position.set(-380, 300, -400)` — 633.17 m and 628.00 m out.
 *
 * The reference distance is the mount's LENGTH, not the distance to the
 * `lookAt(0, 40, 0)` target: `lookAt` only turns the disc to face the rider,
 * and the demo's own on-screen angle readout (`skyAngleDeg(geoR, SKY_SUN_R)`,
 * with `SKY_SUN_R = sunDisc.position.length()`) measures from the anchor. Using
 * the look target's 613.27 m instead is what made gameview's sun 3.0% too big
 * (and its moon 2.8%) from the day the port was written — those numbers sat in
 * the old `SUN_DISC_RADIUS = 205 // 42 / 613 × MOON_DISTANCE` comment the whole
 * time, correctly derived from the wrong distance.
 */
export const DEMO_SKY_MOUNT: Record<'sun' | 'moon', readonly [number, number, number]> = {
  sun: [340, 330, -420],
  moon: [-380, 300, -400],
};

/**
 * The disc radius, in scene metres, that reproduces the demo's apparent size
 * at whatever shell this renderer hangs its sky on.
 *
 * `demoRadius` is the world's OWN `CircleGeometry` radius from its demo call
 * site — 42 / 34 for paper and plastic, **44 / 30 for circuit**. That
 * divergence is deliberate (a scope tube is not a paper cut-out), so the number
 * lives in each style file rather than in one shared pair of constants: the old
 * shared pair would have drawn circuit's moon **16.5% too big**. See
 * `[celestial discs vs demo]`, which re-reads all six values out of the three
 * demos.
 */
export function celestialDiscRadius(
  body: 'sun' | 'moon',
  shellRadius: number,
  demoRadius: number,
): number {
  const [x, y, z] = DEMO_SKY_MOUNT[body];
  return (demoRadius / Math.hypot(x, y, z)) * shellRadius;
}

/**
 * The route as a mark drawn on the road: a narrow, near-opaque marker stroke
 * over a wider, faint halo (highlighter pen / neon tape, per world style).
 * Widths are in world metres.
 */
export interface RouteLineStyle {
  coreColor: number;
  coreWidth: number;
  coreOpacity: number;
  glowColor: number;
  glowWidth: number;
  glowOpacity: number;
}

/** Point + unit tangent on the ridden route, at a distance along it — the demo's
 *  `pathAt(d)` return value, field for field. */
export interface RoutePathPoint {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
}

/** The ridden route as something a world can walk by MILEAGE, which is the only
 *  handle the demos' route-side code ever uses (`pathAt` / `offsetAt`). */
export interface RoutePath {
  /** Route length, scene metres. */
  readonly lengthM: number;
  /** Point + unit tangent `d` metres along, clamped to the two ends. */
  at(d: number): RoutePathPoint;
}

/**
 * Ground height at a scene (x, z), or null where no terrain is loaded. `preferY`
 * disambiguates a switchback's stacked corridor decks, exactly as the ribbons'
 * `GroundFn` does — a route body is off the centreline, so it has to ask about
 * a place the route itself never visits.
 */
export type RouteGroundFn = (x: number, z: number, preferY: number) => number | null;

/**
 * The route drawn as an OBJECT lying along the path, instead of a mark painted
 * on the road.
 *
 * One world needs this. `plan/circuit-town-demo.html` retired its own glowing
 * ribbon for a reason it states outright:
 *
 * > 舊版路線是一條貼在匯流排上的發光緞帶 —— 它會完美貼合曲線,因為它是布。
 * > 杜邦線不是布,**它有點硬**:兩個接頭之間就是一條直的,所以整條路線變成一串
 * > **弦線**,過彎時會小小切內角。那不是缺陷,是物理誠實,不要想辦法讓它貼合。
 *
 * The lifecycle is the route line's (one object for the whole route, re-seated
 * per streamed-in chunk, windowed to the near chunks), so the three calls below
 * are the three things `route-line-mesh` already does to its ribbons.
 */
export interface RouteBody {
  /** Added to the scene by the caller; the body owns everything under it. */
  readonly group: THREE.Group;
  /** Re-seat every piece overlapping [d0, d1] metres — a chunk streamed in, or
   *  the floating origin moved. */
  refresh(ground: RouteGroundFn, d0: number, d1: number): void;
  /** Draw only [d0, d1] metres; null = the whole route. */
  window(range: { d0: number; d1: number } | null): void;
  dispose(): void;
}

/**
 * One long specular streak on the case's crown, as a patch of the sphere:
 * `[phiStart, phiLength, thetaStart, thetaLength]` in radians — the same four
 * numbers `THREE.SphereGeometry` takes.
 *
 * NARROW in phi (a few degrees) and LONG in theta, and the theta range is the
 * part that is easy to get wrong: the rider's eye is ~6 m up, so the sky in
 * frame spans roughly 0–20° above the horizon, i.e. theta 1.2–1.57. Both demos
 * shipped a first version that stopped at theta ≈ 1.0 — genuinely "the top of
 * the dome" — and not one streak was visible from the game camera. A real
 * acrylic case reflects the ceiling in a band that runs from the crown all the
 * way down the side, so run theta down to ~1.5.
 */
export type AcrylicStreak = readonly [phi: number, phiLength: number, theta: number, thetaLength: number];

/**
 * The acrylic display case over the whole diorama (DEVPLAN「壓克力罩天空」).
 *
 * The world is a model on a desk, so it stands under a case: the architecture
 * model's presentation cover, the toy's display box. The GEOMETRY is shared —
 * one shell, one thickening rim, one lit bottom lip, the crown streaks and the
 * rain film, all built once in `acrylic-case.ts` — because "同一種零件只能有一
 * 份做法" and this repo has already paid twice for two copies of one part. A
 * style supplies only the numbers.
 *
 * Declaring it is what makes the case exist for a world; omit the field and
 * that world simply has no case (the third world will land without one).
 *
 * WHY THIS IS DATA AND NOT A BUILD HOOK: the case has to be checkable without
 * WebGL and without a canvas, and it has to survive the tier dropping parts of
 * it. Numbers can be asserted in `npm run check:3d`; a Group cannot be asked
 * whether its rim is thicker than its shell without re-deriving the whole thing.
 */
export interface AcrylicCaseStyle {
  /** Shell/rim tint, fair weather → night. Cast acrylic is never colourless. */
  tintDay: number;
  tintNight: number;
  /** Rain pulls the tint a step COLDER (water on the outside of the glass). */
  tintRain: number;
  /** The thickening band where the case meets the desk. */
  rimDay: number;
  rimNight: number;
  /** The cut edge sitting on the desk. Acrylic edges pipe light, so this is the
   *  brightest part of the case and reads as its thickness. */
  lipColor: number;
  /** Crown streaks, day → night. */
  streakDay: number;
  streakNight: number;
  /** Water traces running down the OUTSIDE in the rain. */
  rainFilmColor: number;
  /**
   * Base opacities. The one rule that is not a taste call: `rimOpacity` must be
   * GREATER than `shellOpacity`, or the case reads as tinted air rather than a
   * box with walls — that is the whole difference the spec is asking for.
   */
  shellOpacity: number;
  rimOpacity: number;
  lipOpacity: number;
  streakOpacity: number;
  /** Where the crown streaks are. One or two long ones; see `AcrylicStreak`. */
  streaks: readonly AcrylicStreak[];
}

/** Oriented bounding box of one MVT building footprint, in scene metres. */
export interface BuildingBox {
  /** Centre in scene coordinates. */
  cx: number;
  cz: number;
  /** Footprint extents along the box's own axes. */
  width: number;
  depth: number;
  /** Rotation of the box around +y (radians). */
  rotY: number;
  /** Wall height in metres, and the (quantised) base y the walls start from. */
  height: number;
  baseY: number;
  /** How far below `baseY` the body is buried so a box straddling two terrain
   *  treads never shows a floating slab edge. Bodies span `-skirt … height` in
   *  the local frame `buildBuildingBody` works in. */
  skirt: number;
  /** The wall colour the strategy already picked for this building. */
  color: number;
}

/**
 * One box a themed body decomposes into, in the box's LOCAL frame — the same
 * frame `buildBuildingBody` returns geometry in (centred in x/z, spanning
 * `−box.skirt … box.height` in y).
 *
 * A DESCRIPTION rather than geometry, because the building renderer batches
 * every box in a chunk into ONE InstancedMesh — 24 vertices shared by the lot,
 * with a matrix and a colour per instance — instead of copying 24 vertices per
 * box into a merged buffer. Measured on chunk 2 of the saved Taipei route (794
 * footprints, 14 620 boxes): merging costs 198 ms and 12.6 MB, instancing 3 ms
 * and 1.1 MB, and building the bodies was essentially the whole chunk build.
 *
 * What it does NOT buy, so nobody reads more into it later: the same triangles
 * are still rasterised (no fill-rate change), and an InstancedMesh is frustum-
 * culled as ONE object, exactly like the merged mesh it replaces.
 */
export interface BoxPart {
  /** Extents along the box's own axes, in metres. */
  w: number;
  h: number;
  d: number;
  /** Centre of the box, in the building box's local frame. */
  x: number;
  y: number;
  z: number;
  /** Flat colour of the whole box — one per instance, not per vertex. */
  color: number;
  /**
   * Tilt about the part's own centre, applied BEFORE the building's `rotY`,
   * as a three's `Euler` in its default XYZ order. Omit for the axis-aligned
   * case; omit `rotX`/`rotZ` alone for the yaw-only case, which is the one the
   * renderer has a fast path for.
   *
   * `rotX`/`rotZ` exist for ONE reason and it is worth stating so nobody trims
   * them back to a yaw: the toy world's clay house is hand-pressed lumps, and
   * `plan/plastic-town-demo.html` tilts every lump on all three axes
   * (`e.set((rng()-.5)*0.13, (rng()-.5)*0.5, (rng()-.5)*0.13)`). Yaw alone
   * snaps the cubes back into a level course and the house reads as a brick
   * stack — which is precisely the failure the demo's own comment warns about.
   */
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /**
   * Which unit template this part instances. Omit for the 1 m cube.
   *
   * The key names a template the STYLE builds, through `buildPartTemplate` —
   * see `PartShape`. `w`/`h`/`d` are the instance scale applied to it, so for a
   * template normalised to unit extents they keep meaning "full extent along
   * this axis" exactly as they do for a box.
   */
  shape?: PartShape;
}

/**
 * A key naming ONE unit template a body part can instance. `'box'` is built in
 * (the 1 m cube); every other key is the style's own and is built by
 * `buildPartTemplate`.
 *
 * **Why this is a string and not a fixed union.** It used to be `'box' | 'cone'`
 * with the frustum's taper and segment count living here as `PART_CONE_TAPER =
 * 0.7` / `PART_CONE_SEGMENTS = 8` — a renderer-owned shape every style had to
 * want. The toy world's cup tower is where that came from, and it is also what
 * it cost: the demo's cup is `CylinderGeometry(1.62, 1.12, 3.0, 14, 1, true)`
 * with a `TorusGeometry` rim on top, so being made to want the renderer's cone
 * silently changed the taper (0.691 → 0.700), cut the facets from 14 to 8, and
 * dropped the rim entirely. None of those three was a decision anybody took;
 * they were the price of the shape living on the wrong side of the interface.
 * A style that owns its templates can paste the demo's geometry in unchanged,
 * which is the whole point.
 *
 * **The invariant that replaces the closed union.** A key is a SINGLETON: the
 * renderer builds one template per distinct key per chunk and batches every
 * part carrying that key into one `InstancedMesh`. So the number of distinct
 * keys is the style's shape VOCABULARY and must not scale with the number of
 * buildings — a per-building key would give a per-building draw call and undo
 * the batching this exists for. `npm run check:3d` pins that.
 */
export type PartShape = string;

/**
 * Tag a geometry as a decoration INSTANCE TEMPLATE and make it safe to draw.
 *
 * A style that builds the same little part on every building (a domino pip, an
 * eraser sleeve) can cache one unit-sized geometry and hand the renderer an
 * `InstancedMesh` over it instead of a fresh, matrix-baked copy per building.
 * `mergeBuildingDecorations` recognises the tag and batches every such mesh in
 * the chunk into ONE InstancedMesh per (template, material) pair, rather than
 * exploding it back into per-instance clones.
 *
 * Two things this centralises, both of which are silent when wrong:
 *
 *  · THE BLACK-PART TRAP. `vertexColors` is a property of the MATERIAL, not of
 *    the geometry — three defines `USE_COLOR` from the material alone, so a
 *    template drawn with a vertex-coloured material and no `color` attribute
 *    makes the shader read the default generic attribute, which is (0, 0, 0).
 *    Every instance renders black, in WebGL only, where no headless probe
 *    rasterises it. White is the identity for the `vColor *= color` that
 *    follows, so a white attribute is added here when the material needs one.
 *  · OWNERSHIP. The template is a strategy-owned singleton that outlives every
 *    chunk; the tag is also what stops the chunk merger and the chunk disposer
 *    from freeing it. The strategy frees it in `dispose()`.
 */
export function markInstanceTemplate<T extends THREE.BufferGeometry>(
  geometry: T,
  material: THREE.Material,
): T {
  geometry.userData.instanceTemplate = true;
  const vertexColored = (material as THREE.Material & { vertexColors?: boolean }).vertexColors;
  if (vertexColored && !geometry.getAttribute('color')) {
    const n = geometry.attributes.position.count;
    geometry.setAttribute(
      'color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3),
    );
  }
  return geometry;
}

/*
 * `FacadeWindowTemplate` / `FacadeWindowStyle` USED TO BE HERE — the knobs for
 * a generic window grid (`colSpacing` / `rowSpacing` / `skipProb` /
 * `faceOffset` / `flipBackFace` + one template geometry stamped world-wide).
 *
 * They are gone because no demo has them, and `plan/plastic-town-demo.html`
 * deleted its own copy on purpose (「連函式一起刪掉…那個網格完全不知道自己蓋在
 * 什麼上面」). A style now declares its lights where it declares its shape:
 * either as a night-lit MATERIAL on a part the body already has
 * (`registerNightLitMaterial` — what the corrugated and circuit worlds do for
 * every one of their buildings), or as sized quads from `buildBuildingLights`
 * over faces the body already has (what the toy world's slab tower does).
 * See `building-lights.ts` for the full note.
 */

/**
 * What a sign is FOR. The point of the parameter is that the two must not be
 * the same object: DEVPLAN「一個元件只能有一個身分」. In the corrugated world a
 * checkpoint already flies a sticky note, so its shop sign is embossed label
 * tape; in the toy world the checkpoint is a road sign, so its shop sign is the
 * printed sticker that comes in the box. Hand the style the purpose and it
 * picks the carrier — the caller must not.
 */
export type SignPurpose = 'shop' | 'checkpoint';

/**
 * A built sign. Local frame: the plate is centred on the origin and its FACE
 * LOOKS DOWN +Z, so a caller only has to position and yaw it.
 *
 * Materials here are strategy-owned singletons tagged `userData.shared = true`
 * — `dispose()` frees the geometries only. That is deliberate: once shop signs
 * hang off buildings there will be a dozen per chunk, and the building renderer
 * has to be able to merge their geometries into one batch. One mesh per sign
 * would cost more draw calls than the buildings carrying them.
 */
export interface SignParts {
  group: THREE.Group;
  /** Actual plate size in metres (may be smaller than requested). */
  width: number;
  height: number;
  dispose(): void;
}

/** Internal terrain-style id. `cuphead` maps to `paper`. */
export type TerrainStyle = 'plastic' | 'paper' | 'circuit';

/**
 * Map the config world-style value to the Three.js terrain style.
 *
 * EXHAUSTIVE on purpose. This used to be `world === 'cuphead' ? 'paper' :
 * 'plastic'`, which is the single most load-bearing silent branch in the whole
 * migration guide (CUSTOM_WORLD_INSTRUCTIONS §11.2): a third world falling into
 * the else renders as toy blocks with no error anywhere. The `never` return in
 * the default makes the NEXT world a compile error here instead.
 */
export function terrainStyleFromWorldStyle(world: WorldStyle): TerrainStyle {
  switch (world) {
    case 'cuphead': return 'paper';
    case 'plastic': return 'plastic';
    case 'circuit': return 'circuit';
    default: return assertNever(world);
  }
}

/** Exhaustiveness helper — a style that reaches this failed to be handled. */
function assertNever(x: never): never {
  throw new Error(`unhandled world style: ${String(x)}`);
}

/**
 * Live-tunable parameters. Surfaced as sliders in the in-game debug panel so
 * the user can find the "good-looking but not laggy" sweet spot on Windows,
 * then hard-code the values. Split into geometry (needs a terrain rebuild) and
 * post/material (updates live).
 */
export interface StyleParams {
  // ── Quantised terrain engine (P1) ──
  /** Master toggle for height quantisation (stairs). */
  quantEnabled: boolean;
  /** Vertical step height in metres (blocks: small, paper: larger sheets). */
  layerHeight: number;
  /** Horizontal cell size in metres — world-aligned grid resolution. */
  gridSize: number;

  // ── Block height jitter (plastic, P2) ──
  /**
   * Max per-cell DOWNWARD sink in metres, applied after quantisation, so blocks
   * on the same layer sit at slightly different heights (toy-brick look).
   * Downward-only: overlays (roads, landuse, trees, buildings) are placed at
   * the quantised layer height, so a raised block would impale them. 0 = flat.
   */
  heightJitter: number;

  // ── Corrugated paper (paper, P3) ──
  /** Strength of the corrugation ripple on vertical sheet edges (0 = flat). */
  corrugationStrength: number;

  /**
   * Paper-style dent bump map on the crayoned surfaces (the "坑坑巴巴" of handled
   * cardboard). Purely a perf/quality toggle — a lower quality tier drops the
   * bumpMap sampling. Default true; plastic ignores it (no dents). Mechanical
   * only: does not change any visual tuning value.
   */
  bumpEnabled: boolean;

  /**
   * 上色 ↔ 素紙板（瓦楞紙世界，demo 的 `?paint=0`）。
   *
   * demo 用 30 個 `swappable(mat, plain, painted)` 登記兩態的
   * `{ map, color, vertexColors }`，`applyPaintMode()` 整組換 —— **材質本體是同一個**，
   * 所以兩態不可能在別的欄位上分岔。通則永遠是「關掉上色＝顏料離開，底下的顏色
   * 不動」；唯一的例外是等高線踏面，demo 明寫「素模式全部是生紙板」。
   *
   * `true` 是 demo 的開場態。另外兩個世界不讀它（欄位必填，跟 `bumpEnabled`
   * 同一個處境）。
   */
  paintEnabled: boolean;

  // ── Ink outline (paper, P3) ──
  inkEnabled: boolean;
  /** Inverted-hull thickness in metres. */
  inkThickness: number;
  /** Outline colour (hex). */
  inkColor: number;

  // ── Paper post-process (paper) ──
  paperPosterize: number;   // 0-1 blend of posterised colour
  paperDesaturate: number;  // 0-1 desaturation toward matte
  paperFiber: number;       // 0-1 fibre multiply strength
  paperStrength: number;    // 0-1 master fade of the whole pass

  // ── Heavy optional effects (rider INTENT; the tier can still veto) ──
  /**
   * Put the acrylic display case over the world (`acrylicCase.ts`).
   *
   * The rider's wish, not the outcome: the quality tier ANDs its own
   * `acrylicCase` level onto this and the fps governor can pull that level down
   * mid-ride. A switch that drops an N100 to 10 fps is a trap, not a feature —
   * see plan/migrate-demo-worlds.md §5.
   */
  acrylicCaseEnabled: boolean;
  /**
   * Run the demos' hand-rolled SCENE bloom (`scene-bloom-pass.ts`).
   *
   * NOT `QualityParams.bloomEnabled` — that one gates the CYCLING-GLASSES
   * selective bloom in `cycling-glasses-effect.ts`, which renders only
   * BLOOM_LAYER objects through UnrealBloomPass. This is the whole-scene
   * threshold bloom the demos hand-rolled, and DEVPLAN gives it to the toy
   * world only (weak, night-only); the corrugated world deliberately has none —
   * poster paint does not glow.
   *
   * Same precedence as `acrylicCaseEnabled`: intent, ANDed with the tier.
   */
  sceneBloomEnabled: boolean;
}

/**
 * Compile-time contract between the welcome screen's per-world options and this
 * renderer: every key a world declares in WORLD_OPTIONS is written straight onto
 * `StyleParams`, so every key must BE a StyleParams field. Declare an option
 * with nothing behind it and this line stops compiling — which is the whole
 * point, because a switch that silently writes to a field nobody reads is
 * indistinguishable, to the rider, from a broken game.
 *
 * If a future option genuinely needs a name StyleParams doesn't have, add an
 * explicit adapter in `applyWorldOptions` (useTerrainRenderer.ts) rather than
 * loosening this.
 */
type _AssertWorldOptionKeysAreStyleParams =
  WorldOptionKey extends keyof StyleParams ? true : never;
const _assertWorldOptionKeys: _AssertWorldOptionKeysAreStyleParams = true;
void _assertWorldOptionKeys;

/**
 * One step of a world's hypsometric band table — 踏面的色帶 + 它下面那道切口的
 * 等高線色。
 *
 * `side` 可以省略,而且省略是有意義的答案:瓦楞紙世界的切邊是**不上色的生紙板**
 * (「切邊是不上色的生紙板,踏面才刷顏料 —— 這個對比就是整個造型的識別點」),
 * 它的牆材質根本不吃頂點色,所以那裡沒有「深一階」這回事。
 */
export interface TerrainBand {
  readonly top: THREE.Color;
  readonly side?: THREE.Color;
}

/** 板子側牆的兩個參數(見 `TerrainStyleStrategy.sideWall`)。 */
export interface SideWallStyle {
  /**
   * 牆從那一格的踏面往下走幾公尺。demo 兩個世界都是 **9**
   * (`sideWallSeg(d0, d1, offset, -9, 0)`,板面在 y = 0)。
   */
  readonly drop: number;
  /**
   * 牆的材質 —— 積木是射出成型的深綠側面、電子是 FR4 的切邊,兩個是不同的東西。
   *
   * ⚠ 必須回傳 **strategy 擁有的 singleton** 並標 `userData.shared = true`:
   * 每個 chunk 各一份的話,一條路線上就是幾十份同樣的材質(而電子那份還帶著
   * 一張 128×64 的畫布),而且 chunk 回收器會把還在用的那份 dispose 掉。
   */
  createMaterial(): THREE.Material;
}

/**
 * 樹腳下留在板面上的那一小片痕跡 —— 瓦楞紙世界的**白膠痕**。
 *
 * demo(`plan/paper-town-demo.html` 的 `treeBucket`)一棵樹是**三個** mesh:兩張
 * 剪紙卡,加上一片 `unitDisc × 2.6s` 的軟影。它自己寫下了理由:
 *
 * > 白膠黏上去的那圈痕跡 —— 底板上一小片影子,樹才不會像浮在上面
 *
 * 為什麼這是**第二組 (geometry, material)** 而不是塞進卡片裡:這片痕跡**就是**它的
 * alpha falloff(31 圈,0.02 ramp 到 0.12),而卡片材質是 `alphaTest: 0.5` 的 ——
 * 同一份材質畫的話只剩中心三分之一半徑的一塊硬邊圓,那正好是它的反面(量在
 * `scripts/headless-check/paper-props-vs-demo.ts`)。圖集那招(兩張卡共用一張貼圖、
 * 靠 uv 分格)帶不動它:門檻是**材質**的屬性,不是 uv 的。
 *
 * ⚠ **它跟樹共用同一組 instance matrix**,所以幾何要回在**跟 `buildTreeGeometry`
 * 同一個局部座標系**裡(樹幹底在 y = 0,+y 朝上),demo 的 `rotation.x = -π/2` 與
 * `scale 2.6s` 一律烘進幾何 —— 這跟 `buildTreeGeometry` 已經在做的事(把卡片的
 * `10s` 與 `+5s` 烘進去)是同一條規矩。renderer 只是把樹那份矩陣再抄一份。
 *
 * 所有權跟 `buildTreeGeometry` / `createTreeMaterial` 完全一致:**每次呼叫都是新的
 * 實例**,由建出這批樹的 renderer dispose;材質裡的**貼圖**必須是 strategy 擁有的
 * singleton(材質 dispose 不會碰它的 map),在 `dispose()` 裡收。
 */
/**
 * One land-cover polygon, handed to `TerrainStyleStrategy.buildLanduseProps`.
 * All lengths are LOCAL scene metres — the same space the slab lives in.
 */
export interface LandusePropContext {
  /** `playground` | `wetland` | `farmland` | `sports` | `sand` | … */
  readonly kind: string;
  readonly centerX: number;
  readonly centerZ: number;
  /** Distance from the centroid to the furthest ring vertex. Can be hundreds of
   *  metres: a real MVT wetland is a whole conservation area, and scattering by
   *  `radius` alone puts sixteen reeds too far apart to read as one clump. */
  readonly radius: number;
  /** The slab's own height. Stand on this — see `buildLanduseProps`. */
  readonly slabY: number;
  /**
   * Deterministic stream seeded from the patch's own position, so the same patch
   * grows the same props on every rebuild and every ride of the route.
   *
   * It is a SEPARATE stream on purpose: drawing from the chunk's shared rng
   * would make "does this patch have props" shift everything built after it
   * (CUSTOM_WORLD_INSTRUCTIONS §5 — the bug the sign work left behind).
   */
  readonly rng: () => number;
}

export interface TreeGroundMark {
  /** Fresh per call — 由 `disposeTreeMesh` 釋放。 */
  geometry: THREE.BufferGeometry;
  /** Fresh per call — 同上。它的 `map` 則是 strategy 擁有的 singleton。 */
  material: THREE.Material;
}

/**
 * The rider's LIVE signals, handed to `updateRiderSignals` once per frame.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a RELAY. Every field is a value the server already computed and pushed
 * (sensor frames → `sensorStore`, the 20 Hz sim snapshot → `gameStateStore`),
 * copied down to the style with no arithmetic on the way — CLAUDE.md
 * 「前端（Vue）只負責 render」. Nothing here is a zone, an average, a
 * normalised power or a smoothed anything; if a world wants a derived quantity,
 * that quantity belongs on the server and in a new field, not in a computation
 * on this side.
 *
 * ## `null` is a value, and it is not zero
 *
 * A rig may have no cadence sensor, and a ride may not have started. Those are
 * NOT "0 rpm" and not "0 W": 0 rpm means the rider stopped turning the cranks —
 * which is a thing the world should show — and `null` means nobody knows, which
 * is a thing the world must NOT show as a stopped crank. Every optional signal
 * below is therefore `T | null` rather than a defaulted number, and the two
 * cases must reach the eye differently. (`bike-ornament.ts` is the worked
 * example: `null` falls back to the wheel-derived spin, `0` freezes the crank.)
 *
 * ## Estimated ≠ measured
 *
 * `powerW` is the server's EFFECTIVE watts: a real power meter's reading when
 * one is on the bike, otherwise a trainer-curve estimate derived from speed.
 * `powerSource` says which, and a world is expected to look at it: driving a
 * strong visual reaction from an estimate tells the rider their legs did
 * something that was in fact inferred from their wheel. The circuit world's
 * rule (`wattGain`) is to treat `'estimated'` exactly like `null` — the demo's
 * neutral value — and that is the recommended reading.
 */
export interface RiderSignals {
  /**
   * Crank cadence in rpm — `sensorStore.sc.cadence`, or a power meter's own
   * cadence channel when the bike has no speed/cadence sensor. `null` when
   * neither reports. Arrives at the sensor frame rate (~1–4 Hz per sensor), so
   * it is a STEP signal held between frames, not a per-frame value.
   */
  readonly cadenceRpm: number | null;
  /**
   * Server-effective watts (`gameStateStore.powerW`), 20 Hz step signal.
   * `null` until the first `game_state` frame of the ride.
   */
  readonly powerW: number | null;
  /**
   * Whether `powerW` was measured by a power meter or estimated from the
   * trainer curve. `null` until the first `game_state` frame — same instant
   * `powerW` becomes non-null.
   */
  readonly powerSource: 'meter' | 'estimated' | null;
}

/**
 * Visual-style strategy consumed by every Three.js terrain renderer.
 *
 * Material factories follow the existing lifecycle:
 *  - `createBuildingMaterial()` returns a shared singleton (owned + disposed by
 *    the strategy). Renderers must NOT dispose it.
 *  - all other `create*Material()` return a fresh instance per call; the
 *    renderer that created the mesh disposes it (unchanged from today).
 */
export interface TerrainStyleStrategy {
  readonly style: TerrainStyle;
  readonly params: StyleParams;

  // ── Colours (same-zone-same-colour logic lives per style) ──
  terrainVertexColor(elevation: number, worldX: number, worldZ: number): THREE.Color;
  /**
   * 地形的**單色分層設色**(製圖上的 hypsometric tinting)。`y` = 這一階的踏面
   * 比**腳下那條路**高幾公尺(路面 = 這個世界的底板,見 `quantized-terrain.ts`)。
   *
   * demo(`plan/plastic-town-demo.html`,`TERRAIN_BAND` 上面那段)的原文就是規格:
   *
   * > 原本每一階都用同一組綠,疊起來就**糊成一坨** —— 那是任何一張地圖都不會做
   * > 的事:用同一個色帶塗完整個高程範圍。分層設色的兩條慣例是:
   * >   ・**色帶按高度分階**(這裡走單色相的明度階,不是綠→黃→褐的色相階 ——
   * >     色相階會讓地形不再是一片綠,那是另一種世界了)
   * >   ・**踏面 = 色帶,側面 = 等高線**。層積模型的垂直面就是上面那片板的切口,
   * >     在讀圖上扮演的角色是等高線本身,所以側面一律比自己的踏面深一階。
   * >
   * > 方向是**山腳深、山頭淡**…底板就是第 0 階,顏色一格沒動。
   *
   * 省略 = 這個世界不做分層(電子:板色是分區的路標,再拿它編碼高度會撞色 ——
   * 它的高度改編在切邊的銅箔層數上,見 `terrainWallLevels`),顏色照舊由
   * `terrainVertexColor` 決定。
   *
   * ⚠ **回傳的 Color 會被讀進頂點色 buffer,不要交出會被下一次呼叫改寫的實例。**
   */
  bandAt?(y: number): TerrainBand;
  buildingColor(lon: number, lat: number): number;
  roadColor(roadClass: string): number;
  roadWidth(roadClass: string): number;
  /**
   * Length of the wedge that carries a road from width `wa` to width `wb`,
   * metres — the demo's `taperLen`, and it is a whole design rule in one line:
   *
   * ```js
   * function taperLen(wa, wb) { return Math.abs(wa - wb) / 2; }
   * ```
   *
   * `Δ / 2` is what makes the wedge **45°**: each side gives way Δ/2 laterally
   * while the road advances Δ/2, so the edge moves sideways exactly as fast as
   * it moves forward. That is how a PCB changes trace width (a hard step is an
   * impedance stair, and no router will draw one), and it is the same 45° the
   * board texture's own routing grammar uses.
   *
   * Omit and a class change is a hard step, which is what the other two worlds
   * do (a strip of tape and a highlighter stroke have no such rule, and their
   * ribbon geometry stays byte for byte what it was).
   */
  roadTaperLength?(wa: number, wb: number): number;
  /**
   * Half-span of `v` across a road ribbon whose ACTUAL width is `actualWidth`
   * while its texture was drawn for `nominalWidth` — 0.5 means "v runs 0…1".
   *
   * Only a world whose road texture has a border measured in WORLD METRES needs
   * this: circuit's solder mask is a process parameter fixed at one metre, so
   * the border's share of the texture is `1 / width` and the wedge (where the
   * actual width is not the nominal one) has to reverse it out or the green edge
   * necks down with the copper — demo `busSeg`'s `hv`.
   */
  roadUvHalfSpan?(actualWidth: number, nominalWidth: number): number;
  /**
   * The translucent wash laid over a district so a rider can see which one they
   * are in — one colour per ZONE, not per MVT class.
   *
   * Replaced `urbanColor(cls)`, and the difference is the point. Eleven landuse
   * classes arrive from the map; `URBAN_COLORS` had four keys, so retail shared
   * commercial's yellow and the other seven — every school, hospital, campus and
   * library — fell back to residential grey. `land-zone.ts` opens with that
   * complaint: recognised, fetched, projected into geometry, and then drawn
   * identically. Keying on `ZoneKind` is what closes it: five kinds, five
   * colours, the same five DEVPLAN's zone→building table is written against, so
   * the ground under a school and the building on it now agree.
   *
   * Null means "outside every known zone", which is NOT residential — but the
   * decal layer only ever carries urban polygons, so null is a defensive
   * fallback here rather than a case a rider sees.
   *
   * The five must be distinguishable FROM EACH OTHER at 0.6 opacity over this
   * world's ground, which is a stronger constraint than five nice colours: the
   * demos both pull five separated hues and leave green to the parks.
   */
  zoneDecalColor(zone: ZoneKind | null): number;
  readonly treeTrunkColor: number;
  readonly treeCanopyColors: readonly number[];
  /**
   * Roof colour for extruded buildings. When set, up-facing vertices get this
   * colour instead of the wall colour — paper uses raw kraft so buildings read
   * as cardboard boxes (printed sides, raw board top). Omit for single-colour.
   */
  readonly buildingTopColor?: number;

  // ── Material factories ──
  createTerrainMaterial(): THREE.Material;
  /**
   * Material for the quantised terrain's vertical faces (step risers, drop
   * walls, boundary skirts — geometry group 1). Paper returns a raw-kraft
   * corrugated-texture material so every cut edge shows the board core; when
   * omitted the walls use `createTerrainMaterial()` (plastic: banded
   * vertex-colour risers). Fresh instance per call; disposed with the chunk.
   */
  createTerrainWallMaterial?(): THREE.Material;
  /**
   * 切邊材質分幾階。省略(或 1)= 整條走廊的切口共用一份
   * `createTerrainWallMaterial()`,也就是今天的行為。
   *
   * 電子世界宣告 4:它的分層設色走的不是顏色而是**多層板的層數** —— demo 的
   * `edgeMatForLevel`,2 / 4 / 6 / 8 層銅箔,越高越多。板面的顏色已經被分區佔走
   * 了(阻焊色是分區的路標),再拿它編碼高度,低地的醫院區跟高地的住宅區會撞成
   * 同一色,所以換一個軸。
   */
  readonly terrainWallLevels?: number;
  /**
   * 第 `level` 階(0 = 路面那階)的切邊材質。只有宣告了 `terrainWallLevels` 的
   * 世界才會被呼叫,`level` 已經夾在 `[0, terrainWallLevels - 1]`。
   *
   * ⚠ 這裡回傳的是 **strategy 擁有的 singleton**(每階一張貼圖,每個 chunk 重畫
   * 一次就是白付四張 canvas 的建構成本 —— demo 自己也 cache,`fr4Cache`)。所以
   * 它必須標 `userData.shared = true`,chunk 回收器才會放過它。
   */
  createTerrainWallMaterialForLevel?(level: number): THREE.Material;
  /**
   * 踏面材質分幾階。省略(或 1)= 整條走廊的踏面共用一份 `createTerrainMaterial()`,
   * 也就是今天的行為(積木、電子)。
   *
   * 瓦楞紙宣告 **2**,而那不是「兩種顏色」,是兩種**東西**。demo 的原話:
   *
   * > 地台 = **切割墊本身**,不是一層瓦楞紙。[…] 評圖模型是「在墊子上疊出地形」,
   * > 所以墊子就是海拔 0,只有高過第一道等高線的地方才開始疊瓦楞紙。多疊一層平的
   * > 紙板,墊子就退化成背景紙,「在上面動刀」那個身分又沒了。
   *
   * demo 也是這樣寫的:`boardTopMat = toon({ map: rep(cuttingMatTex, 5, 5) })` 建在
   * **材質區**(比場景組裝早很多),而 `plateTopMats` 才是疊上去那幾片板。第 0 階
   * 沒有頂點色、沒有雙態(「墊子是桌上的工具,不會因為你開始上色就變成另一種
   * 墊子」)、也沒有蠟筆紋。
   *
   * 桶的分法跟 `terrainWallLevels` 完全一樣:`clamp(band, 0, terrainTopLevels - 1)`
   * —— 路面以下也夾回第 0 桶,因為它一樣是墊子。
   */
  readonly terrainTopLevels?: number;
  /**
   * 第 `level` 階(0 = 路面那階)的**踏面**材質,`null` = 這一階沒有自己的材質,
   * 走既有的 `createTerrainMaterial()`(頂點色 + 這個世界的表面處理)。只有宣告了
   * `terrainTopLevels` 的世界才會被呼叫,`level` 已經夾在 `[0, terrainTopLevels - 1]`。
   *
   * ⚠ 非 null 的回傳是 **strategy 擁有的 singleton**(墊子是一張貼圖,每個 chunk
   * 重畫一次就是白付一張 canvas 的建構成本),所以它必須標 `userData.shared = true`,
   * chunk 回收器才會放過它 —— 跟 `createTerrainWallMaterialForLevel` 同一條合約。
   */
  createTerrainTopMaterialForLevel?(level: number): THREE.Material | null;
  /**
   * 太陽陰影沿法線推開的距離,公尺。省略 = `SHADOW_NORMAL_BIAS`(1.5)。
   *
   * ⚠ **三個 demo 在這一格上不一致**,而那個不一致是有理由的:塑膠與瓦楞紙寫 1.5,
   * 電子寫 **1.2** —— 它的零件是毫米級的(SMD 本體、散熱鰭片、跳線帽),1.5 m 的
   * 法線偏移會把影子從自己腳下抬走。`shadow.bias` / `shadow.normalBias` 是**光源**
   * 的屬性不是材質的,而 gameview 唯一的逐世界通道就是這個介面,所以繞這一圈。
   *
   * 其餘每一格(`shadowMap.enabled`、`PCFSoftShadowMap`、2048²、±180 的框、
   * near 20、bias −0.0006)三個 demo 逐位元組相同,所以留在 `day-night-lighting.ts`。
   */
  readonly shadowNormalBias?: number;
  /** Shared singleton — do NOT dispose from renderers. */
  createBuildingMaterial(): THREE.Material;
  /**
   * 路面材質。`roadClass` 是這條路的 MVT 等級(`DRAWN_ROAD_CLASSES` 之一);
   * 省略 = 呼叫端沒有等級可給(跑道走 `aeroway-renderer`,demo 沒有跑道)。
   *
   * 為什麼要吃等級:電子世界的貼圖上有兩道**阻焊邊**,而阻焊邊是**製程參數**
   * ——demo 的原話「固定 1 公尺,不隨等級縮放」。貼圖的 v 是橫向 0…1,所以
   * 「世界裡固定 1 公尺」等於「邊界佔貼圖高度的比例 = 1 / 該級的路寬」,一種
   * 寬度一張貼圖(demo `busTexture(w)` / `busMatFor(cls)`)。只有一張貼圖的話
   * 阻焊邊會變成路寬的固定百分比,粗路的邊 1.5 m、細路 0.5 m —— 讀起來像窄路
   * 上的金被銼掉了。
   *
   * ⚠ **一種寬度一份材質,不是一級一份。** demo 的 `busMats` 是按寬度收的:
   * 六級只有四個寬度,按等級收會讓同一張畫布被包成三份 CanvasTexture,那是三次
   * GPU 上傳。世界自己 cache(`sharedTrim`),`road-renderer` 依**回傳的材質實例**
   * 分桶,所以「這個世界的路只有一種材質」自動就是一個 mesh、一個 draw call。
   */
  createRoadMaterial(color: number, roadClass?: string): THREE.Material;
  /**
   * 這一級的路要用**哪一份**材質 —— 回傳同一個 key 的等級共用一份。
   *
   * 省略 = 這個世界的路只有一種材質,六級共用一份(積木的軌道、瓦楞紙的膠帶都是
   * 整卷同寬,貼圖跟路寬無關)。省略時 `road-renderer` 只會問 `createRoadMaterial`
   * 一次,整個 chunk 的路照舊合成**一份** mesh —— 一格沒動。
   *
   * demo 的 `busMats` 就是這個東西,而它的 key 是**寬度不是等級**:
   *
   * > 材質按**寬度**收,不是按等級收 —— 六級只有四個寬度,按等級收會讓同一張畫布
   * > 被包成三份 CanvasTexture,那是三次 GPU 上傳。
   */
  roadMaterialKey?(roadClass: string): string;
  createWaterMaterial(): THREE.Material;
  createParkMaterial(): THREE.Material;
  createForestMaterial(): THREE.Material;
  createSandMaterial(): THREE.Material;
  /**
   * The zone decal's material — ONE for the whole world, tinted per polygon
   * through a vertex `color` attribute the landuse renderer bakes in.
   *
   * Why vertex colours and not five materials: a decal is a screen-covering
   * translucent layer, and that category is why gameview costs 7× the demo's
   * per-pixel (plan/migrate-demo-worlds.md §5 — 14 ground-covering objects
   * stacked). Five materials would mean five meshes per chunk where there was
   * one, so five transparent draw calls, five bounding spheres the census calls
   * screen-filling, and five state changes — for exactly the same triangles and
   * exactly the same covered pixels. One vertex-coloured mesh buys the whole
   * five-zone picture for zero extra layers.
   *
   * THE BLACK-PART TRAP applies (see `markInstanceTemplate`): `vertexColors` is
   * a property of the MATERIAL, so a geometry that reaches this material without
   * a `color` attribute renders black in WebGL and nowhere else. The landuse
   * renderer tints every polygon it puts in this mesh.
   *
   * Fresh instance per call; the caller disposes it (same as the other overlays).
   */
  createZoneDecalMaterial(): THREE.Material;
  createTreeMaterial(): THREE.Material;

  // Ground overlays for the landuse classes the map survey showed we fetch but
  // never drew (see plan/map-elements-expansion.md). Fresh instance per call,
  // same ownership as the factories above.
  /** Marsh / bog (`landcover: wetland`) — speckled teal paper / translucent jelly brick. */
  createWetlandMaterial(): THREE.Material;
  /** Fields (`landcover: farmland`) — ploughed-stripe kraft / picnic-check board. */
  createFarmlandMaterial(): THREE.Material;
  /** Pitches (`landuse: pitch|track|stadium`) — FLAT, and only lines. */
  createSportsFieldMaterial(): THREE.Material;
  /**
   * Playgrounds (`landuse: playground`) — the mat the structures stand on.
   *
   * Its own kind since 2026-07-28. It used to fall into `createSportsFieldMaterial`
   * because `isSportsLanduse` matched `playground` too, so every playground in
   * the world was painted as a sports pitch — 69 of them in one Taipei tile
   * window. The demos arbitrated the split as the two ends of ONE axis, how much
   * structure a ground cover has: a pitch is flat and only lines, a playground
   * is the only ground cover that stands up. See `buildLanduseProps`.
   */
  createPlaygroundMaterial(): THREE.Material;

  // ── Third-person diorama props (all procedural, zero assets) ──

  /**
   * The rider's bike ornament — cuphead: a bent-paperclip bike; plastic: a toy
   * brick bike. Animation lives in `bike-ornament.ts`; this only builds parts.
   */
  buildBikeOrnament(): BikeOrnamentParts;

  /**
   * A toy aircraft for aerodromes — cuphead: a tethered plane-shaped balloon
   * (origin at the ground anchor, balloon floating above on its string);
   * plastic: a brick plane parked on the ground (origin at ground). Free it
   * with `disposeGroup` from bike-ornament.ts.
   */
  buildPlaneOrnament(): THREE.Group;

  /**
   * Peak heights for one ring of the distant mountain silhouette, as a fraction
   * of that ring's height scale (`segments + 1` entries; the last closes back
   * onto the first — exactly, or to within double precision for a style built
   * out of `sin(2π·h)` with integer `h`).
   * cuphead → the ink demo's three summed harmonics; plastic → sine mix
   * quantised to brick steps; circuit → run-length-held heatsink fins.
   * Mirrors Phaser 2D's `generateMountainPoints` so both renderers agree.
   *
   * NOMINALLY 0..1 and never negative, but a style may overshoot 1 slightly and
   * must not be clamped for it: paper's harmonic sum has a ceiling of
   * `(96 + 46 × 1.63) / 170 = 1.006`, exactly as in the demo, where `prof()`
   * returns metres and `maxH` only ever scales the ink line. Clamping would flat-
   * top the tallest peak — a visible artefact bought for nothing.
   */
  generateMountainProfile(layer: MountainLayer, seed: number, segments: number): number[];

  /** Silhouette colour of a mountain ring (near ring reads darker). */
  mountainColor(layer: MountainLayer): number;

  /**
   * Ridge ink line + fog behaviour for one ring. Omit it and the ring is one
   * flat fogged wash with no crest band, which is what every ring was before
   * this hook existed — so a style that has not answered yet keeps its old look
   * rather than silently losing it.
   */
  mountainRingFinish?(layer: MountainLayer): MountainRingFinish;

  /**
   * Flat colour of the horizon disc the whole diorama sits on (desk / play-mat).
   *
   * Still here, and still meaningful, now that `createHorizonMaterial` exists:
   * this is the ONE number that describes that surface, for anything that cannot
   * take a material — and it is the fallback `mountain-ring` paints the disc with
   * when a style has not declared the hook (the third world will land without one
   * for a while). Keep it equal to the average of whatever the texture draws, or
   * the fallback stops being the same desk.
   */
  readonly horizonColor: number;

  /**
   * The surface the whole diorama stands on, as a MATERIAL rather than a colour
   * — cuphead: a green cutting mat; plastic: a moulded baseplate with one stud
   * per cell. In the demos that surface is never a flat fill; it is the tool the
   * model is being built ON, and the grid/studs are what say so.
   *
   * UV CONTRACT: `mountain-ring` rewrites the disc's UVs to SCENE METRES (the
   * same convention as the landuse overlays and the crayon shader), so a style
   * sets `map.repeat = 1 / tile-metres` and gets a tile exactly that size on the
   * ground. It also drives `map.offset` from the rider position every frame, so
   * the disc can translate with the rider while the pattern stays pinned to the
   * world — a desk that slid along with you would read as no desk at all.
   *
   * THREE HARD CONSTRAINTS, each of which has already cost this repo a day:
   *  · `side: THREE.FrontSide`. This is a 4 km plane 35 m under the rider; the
   *    DoubleSide version showed its underside — normal pointing away from the
   *    sun, so black — as a huge wedge across the frame any time the camera
   *    dipped below it. See `mountain-ring.ts` for the full story.
   *  · OPAQUE. It is the ground, not a sixth ground-covering translucent layer.
   *  · CHEAP PER PIXEL. It fills most of the lower screen on a machine whose
   *    frame time correlates with nothing but resident chunks (§5: fill-rate
   *    bound, zero correlation with triangle count). A tiled, mipmapped texture
   *    costs one more sampler read on a surface that was being drawn anyway;
   *    anything per-pixel clever does not belong here.
   *
   * Fresh instance per call — the ring owns and disposes it. The TEXTURE inside
   * it must be a strategy-owned singleton, freed in `dispose()`, because the ring
   * disposes materials but never their maps.
   *
   * Omit the hook and the disc falls back to a flat `horizonColor`.
   */
  createHorizonMaterial?(): THREE.Material;

  /**
   * The ground the rider rides on, MOULDED — one stud per cell, coloured by the
   * land use under it.
   *
   * This is the other half of the baseplate, and the half `createHorizonMaterial`
   * cannot be: the disc starts ~540 m out and runs to 4 km, so its studs are
   * painted into a texture and can never answer to anything local. Land use is
   * local. A district only exists inside the corridor, and the demo's whole point
   * about it is that it reaches the studs:
   *
   * > 分區貼花底下的凸點要**跟著分區的顏色**,不是留著底板綠。[…] 同一塊塑膠射
   * > 出來的東西不會兩個色,這條規則在分區上也一樣成立。
   *
   * So the two coexist and neither is redundant: real instanced studs on the
   * ground the rider can reach, a tiled texture on the mat beyond it.
   *
   * Omit the field and a world has no ground studs — a cutting mat has none, and
   * the third world can land without deciding.
   */
  readonly groundStuds?: GroundStudStyle;

  /**
   * 板子的側牆 —— demo 的 `sideWallSeg(d0, d1, ±boardW / 2, -9, 0)`。
   *
   * demo 的板子是一條 130 m 寬、y = 0 的帶子,兩側各掛一道**九公尺深**的牆,牆
   * 外面就是世界的地墊(積木 demo 的 `mat0`,一張半徑 1000、y = −9.6 的紫色玩具
   * 墊)。牆是這個世界**停在哪裡**的答案:沒有它,板子就是憑空切斷的一片。
   *
   * gameview 的「板子」是走廊本身(見 `ground-studs.ts` 開頭那段:demo 的
   * `boardW` 是它所鋪凸點的板寬,而 gameview 的 ±500 m 走廊是 demo 沒有的地),
   * 所以牆掛在**走廊的兩個側邊**上,一格一段,接在一起就是 `sideWallSeg` 那條
   * 連續的帶子。chunk 的**前後**兩端不算:那是 gameview 自己的接縫,demo 的板子
   * 是連續的,它對接縫沒有意見(見 `plan/demo-gaps.md` 第一級第 2 條)。
   *
   * 只帶 `drop` 與材質,因為 demo 只仲裁得了這兩件:牆的**位置**在 gameview 是
   * 走廊寬度(使用者可調),牆的**上緣**是那一格量化後的踏面(demo 的板子是平的,
   * 永遠 0)。
   *
   * 省略 = 這個世界沒有板子,側邊沿用走廊本來那道短裙邊。瓦楞紙世界就是這樣,
   * 而且是 demo 自己刪掉的,原話:
   *
   * > 地台 = **切割墊本身**,不是一層瓦楞紙。[…] 評圖模型是「在墊子上疊出地形」,
   * > 所以墊子就是海拔 0,只有高過第一道等高線的地方才開始疊瓦楞紙。
   * > 順帶:兩側的瓦楞切邊跟著消失(沒有紙板哪來的切口),每個 chunk 少 2 個
   * > draw call。
   */
  readonly sideWall?: SideWallStyle;

  /**
   * The acrylic display case this world stands under — numbers only; the
   * geometry is `acrylic-case.ts`. Omit and the world has no case.
   */
  readonly acrylicCase?: AcrylicCaseStyle;

  /**
   * The route mark laid over the road — highlighter pen / neon tape.
   *
   * NOT drawn for a world that declares `buildRouteBody`: that world's demo
   * replaced the ribbon with an object, and drawing both would put a painted
   * stripe under a physical wire. The field stays required because two of the
   * three worlds ARE the ribbon, and a style with neither would have no route.
   */
  readonly routeLine: RouteLineStyle;

  /**
   * The route as an object along the path (circuit: 一串接龍的杜邦線), replacing
   * the two ribbons above. Omit and the world gets the ribbons.
   */
  buildRouteBody?(path: RoutePath): RouteBody;

  /** Day/night end points — sky gradient, fog, and light colours/intensities. */
  readonly skyPalette: SkyPalette;

  /**
   * The sun or the moon as this world's own sky object — cuphead: one stroke of
   * ink, a flat wash disc with twelve radial dashes (a bite out of it for the
   * moon phase); plastic: a soft glowing bouncy ball, twelve nubs round a
   * squashed silhouette; circuit: a round oscilloscope screen, graticule and
   * all, with a second mesh under it carrying the sweep. Painted ONCE at build
   * time; sky-and-fog never asks for a redraw.
   *
   * `shellRadius` is the rider-centred sky shell the disc will hang on, in
   * scene metres. A style turns it into its own geometry radius with
   * `celestialDiscRadius(body, shellRadius, <its demo radius>)`, which is what
   * keeps the apparent size the demo's however far out this renderer hangs its
   * sky. Do NOT take `shellRadius` as the disc radius.
   *
   * Contract: fresh object per call, owned and disposed (geometry, materials,
   * texture maps) by sky-and-fog. Materials must be `transparent` — sky-and-fog
   * drives opacity for moon phase, the dawn crossfade, and cloud immersion —
   * `fog: false`, because the discs hang outside the world's air and a fogged
   * one dissolves into the horizon band exactly at dusk, when it is supposed to
   * carry the sky, and `depthWrite: false`, the demos' own flag: a transparent
   * quad that writes depth punches its full square out of everything drawn
   * after it, texels at alpha 0 included.
   *
   * A disc may hang animated sub-meshes off itself. Set `userData.beam` to the
   * texture whose `offset.x` should be scrolled and `userData.beamSpeed` to the
   * rate in repeats per second, and sky-and-fog advances it per frame — see
   * circuit's CRT sweep, which is the only reason this exists. Scrolling a
   * `map.offset` is one uniform write; it must never become a per-frame
   * `needsUpdate` (that is a texture upload, i.e. a GPU sync point per frame).
   *
   * Omit the hook (or return null) to keep the pre-style sky: the additive
   * gradient moon sprite and no sun disc — a third world can land without one.
   */
  buildCelestialDisc?(body: 'sun' | 'moon', shellRadius: number): THREE.Object3D | null;

  /**
   * ONE cloud in this world's own material — cuphead: a row of cotton balls
   * (batched to a single InstancedMesh, like the demo's batchGroup); plastic:
   * two stacked bricks with studs on the upper one.
   *
   * The design decision, written down: the demos' clouds are volumetric props
   * in the sky, but gameview's cloud layer is a DECK the rider can climb into
   * — `setCloudLayer` pins it to the weather's condensation altitude and
   * `cloudImmersion` turns the world to murk inside it. That behaviour is not
   * the style's to reimplement, so this hook replaces only the LOOK of one
   * cloud; sky-and-fog keeps ownership of altitude, drift/wind/wrap, the
   * quality-tier budget, and the immersion fade. The demo's placement numbers
   * (y 100–135, ±260 m wrap) therefore deliberately do NOT transfer — the
   * deck's numbers already carry that role.
   *
   * Contract:
   *  · Build at the origin, tens of metres across; sky-and-fog scatters,
   *    drifts and bobs it. Fresh object per call.
   *  · Geometry/materials shared across calls MUST be strategy-owned
   *    singletons marked `userData.shared = true` (both), freed in
   *    `dispose()`. sky-and-fog disposes everything unmarked, and always
   *    disposes InstancedMesh instance buffers, on every deck rebuild.
   *  · Materials must be DEDICATED to clouds: riding into the deck fades them
   *    out (opacity + a transparent/depthWrite flip), and a material shared
   *    with a building would fade the building with it. Hand them over opaque
   *    — outside the deck the clouds then cost no blending at all, unlike the
   *    old translucent billboards.
   *  · `Math.random()` is fine (the demos' own choice — clouds are sky
   *    dressing, not route content); never draw from a seeded route stream.
   *    Draw through the `rand` parameter (it defaults to `Math.random`):
   *    check:3d executes the demo's own cloud source and this hook from ONE
   *    seeded stream, and three.js itself burns four `Math.random` draws on
   *    every object uuid — a hook that read the global directly could never
   *    stay aligned with the demo.
   *
   * Omit the hook (or return null) to keep the pre-style billboard clouds
   * exactly — a third world can land without one.
   */
  buildCloud?(index: number, rand?: () => number): THREE.Object3D | null;

  /**
   * A roadside lamp — cuphead: a highlighter with a transparent cap; plastic:
   * a blown bubble of plastic on a squeeze tube.
   *
   * `index` is the lamp's slot in the pool, so a world can vary its ink colour
   * down the street. It must be DETERMINISTIC in the index — the pool slides
   * along the route and a lamp that changed colour as you approached would read
   * as a glitch.
   */
  buildStreetLamp(index?: number): StreetLampParts;

  /** One collectible coin — cuphead: gold push-pin; plastic: stud-topped disc. */
  buildCoinMesh(): THREE.Mesh;

  /**
   * A checkpoint marker — cuphead: pin + sticky-note flag; plastic: brick flag.
   *
   * `label` is what the flag should SAY (≤ 4 characters, A–Z / 0–9 — see
   * `sign-spec.ts`). Empty string means "no text", which is what a style with
   * no room for it should also do rather than cramming letters on.
   */
  buildCheckpoint(color: THREE.ColorRepresentation, index: number, label?: string): THREE.Group;

  /**
   * A sign carrying text, in this world's own carrier for that purpose.
   * Returns null when the style has no carrier, or when nothing legible fits.
   *
   * The LAYOUT is not the style's business — `signStrokes()` in `sign-spec.ts`
   * owns proportions, kerning and stroke width so all six demos and the real
   * game stay identical. A style decides material, relief, and mounting only.
   *
   * Never fall back to a system font here. See `sign-spec.ts` for why.
   */
  buildSign?(
    purpose: SignPurpose,
    text: string,
    maxWidth: number,
    opts?: { zone?: ZoneKind; symbol?: 'triangle' | null; seed?: number },
  ): SignParts | null;

  /**
   * Where THIS body wants its sign, when the body has somewhere it belongs.
   *
   * Answer `null` (or omit the hook) and `mountShopSign` does what it always
   * did: a seeded draw in the DEVPLAN band, 0.55–0.70 of the building height,
   * standing off the box's own face. That is the right answer for a body with a
   * plain wall.
   *
   * It is the wrong answer for a body with a LEDGE the sign belongs on. The
   * corrugated world's school is three archive boxes stacked, and its demo
   * writes the label across the middle box's lid rim — a specific height
   * (`2h/3 − lidH/2`) that a random draw inside the band lands on by luck once
   * in a while and misses the rest of the time. So the style names it.
   *
   *  · `centerY` — metres above the box's base, NOT a fraction. A style that
   *    answers here still has to land inside 0.55–0.70 h; `npm run check:3d`
   *    asserts that, because a sign the body hides is worse than a sign in the
   *    wrong place.
   *  · `faceOut` — extra standoff beyond the face half-extent, for a body whose
   *    lid/rim/eaves overhang the box the renderer measures. Without it the
   *    plate is mounted relative to the WALL and buried in the overhang.
   *
   * Deliberately NOT given the building's own seed: the 20 % of a school
   * district that rolls a different body would then need it too, and the anchor
   * is inside the renderer's own band either way, so the miss is invisible.
   * See `paperBuildingKind`.
   */
  signAnchor?(box: BuildingBox, zone: ZoneKind): { centerY: number; faceOut: number } | null;

  /**
   * The finish-line airship hovering over the route's last point — cuphead: a
   * 1930s zeppelin; plastic: a toy UFO. Placement/bob/banner-feed live in
   * `finish-airship.ts`; this only builds the parts + owns its theme animation.
   * Every material MUST set `fog: false` — see `FinishAirshipParts`.
   */
  buildFinishAirship(): FinishAirshipParts;

  /**
   * A tunnel mouth, set into the hillside where a `brunnel=tunnel` road enters
   * or leaves it. Those road segments are not drawn (a tunnel is inside the
   * hill, not on it — see road-renderer), so without a portal the road simply
   * stops dead at the slope.
   *
   * Local frame: standing on the ground at the origin, the OPENING FACES +Z.
   * The road renderer drapes it and turns it to face out of the hillside.
   *
   * The opening itself must be UNLIT and dark — it stands for a hole, and a lit
   * surface pretending to be a hole goes pale exactly when the sun hits the
   * slope it is cut into.
   */
  buildTunnelPortal?(width: number): THREE.Object3D | null;

  /**
   * The building's BODY, as a matchbox — one simple themed block standing in
   * for the footprint (plastic → toy building brick, cuphead → rubber eraser).
   *
   * Returned in the box's LOCAL frame: centred on (0, ?, 0) in x/z, +x along
   * `box.width`, +z along `box.depth`, and spanning y from `-box.skirt` up to
   * `box.height`. The building renderer bakes `rotY` and the scene position in,
   * paints the vertex colours, and merges it with every other body in the chunk
   * — so this must be plain geometry with no material and no transform.
   *
   * Omit the hook to keep the literal extruded MVT footprint (the pre-matchbox
   * look). Degenerate footprints with no usable oriented box fall back to the
   * extrusion regardless.
   */
  buildBuildingBody?(
    box: BuildingBox,
    seed: number,
    zone: ZoneKind | null,
  ): THREE.BufferGeometry | null;

  /**
   * The SAME body as `buildBuildingBody`, handed over as the boxes it is made
   * of so the renderer can instance it instead of merging it (see `BoxPart`).
   *
   * Return null when this particular footprint's body is not all boxes — the
   * toy world's cup tower has a cone in every cup — and the renderer falls back
   * to `buildBuildingBody` for that ONE building. Omit the hook entirely and
   * every body goes through the merge path exactly as before, which is what the
   * corrugated world does.
   *
   * Two contracts, both of which have silent failure modes:
   *  · It must AGREE with `buildBuildingBody` for the same (box, seed, zone).
   *    Derive both from one layout function; two functions that each "build the
   *    same tower" drift the first time one of them is tuned.
   *  · It must be DETERMINISTIC in the seed, on its own RNG stream, for the
   *    reason spelled out on `buildBuildingLights`: asking for one view of a
   *    building must never re-roll another.
   */
  buildBuildingBoxes?(
    box: BuildingBox,
    seed: number,
    zone: ZoneKind | null,
  ): BoxPart[] | null;

  /**
   * The unit template behind one `BoxPart.shape` key this style uses. Required
   * as soon as a part carries a `shape` other than `'box'`.
   *
   * **Frame.** Return the geometry a part of extents `(1, 1, 1)` should be:
   * centred on the origin and spanning −0.5 … +0.5 on each axis, so `w`/`h`/`d`
   * scale it directly. A feature may overhang that box where the real object
   * does — the toy cup's rim is wider than its wall — and the overhang scales
   * with the instance like everything else.
   *
   * **Ownership.** The renderer CLONES what comes back (a chunk owns and frees
   * its own instance geometry), so returning a cached singleton is safe and is
   * what a style should do. No material: the whole chunk's bodies share one
   * vertex-coloured toon material, and the part's colour rides per instance.
   * A `uv` attribute is dropped — that material has no map.
   *
   * Called once per distinct key per chunk. See `PartShape` for why the key is
   * open, and for the invariant that the key set is a fixed vocabulary.
   */
  buildPartTemplate?(shape: PartShape): THREE.BufferGeometry | null;

  /**
   * Roof trim for one building box (the walls themselves stay the merged
   * body geometry). Returns an object3D placed in scene coordinates, or null.
   * Materials used here MUST be strategy-owned singletons tagged
   * `material.userData.shared = true` so the chunk disposer leaves them alone.
   *
   * **Windows DO belong here** when they are parts of the building — which in
   * two of the three demos is all of them. The circuit world's DIP pin-root
   * windows are boxes inside `dipIC()`; the corrugated world's plate glass, tape
   * hub, lit bead colour and lit lid compartments are parts of their bodies.
   * They light up by having their material registered with
   * `registerNightLitMaterial`, not by anything being placed on them.
   *
   * Only a light with no part to sit on — a film over a slab end — goes through
   * `buildBuildingLights` instead.
   */
  buildBuildingDecoration(
    box: BuildingBox,
    seed: number,
    zone: ZoneKind | null,
  ): THREE.Object3D | null;

  /**
   * Light QUADS this building declares, in the SAME local frame
   * `buildBuildingBody` works in (the box's own coordinates; the renderer bakes
   * `rotY` and the scene position, then batches the whole chunk into one
   * InstancedMesh over a unit plane).
   *
   * §3.9's rule: **the thing that decides the SHAPE must decide the LIGHTS.**
   * The generic grid this replaced took a bounding box, split it into columns
   * and rows, and stamped one fixed rectangle onto every theme in the world —
   * thirteen forms, one window pattern, and a capacitor with windows. Both
   * halves of it are now deleted; see `building-lights.ts`.
   *
   * **Each quad carries its own `w`/`h`,** because a light is sized to the thing
   * it lights. `plan/plastic-town-demo.html`'s `emitSlabFaceLights` is the
   * reference: `qw = slabT * 0.68`, `qh = SLAB_H * 0.6`, pushed as
   * `[x, y, z, ry, w, h]` and scaled per instance.
   *
   * **Omitting the hook is a NORMAL answer, not a gap** — the circuit world
   * omits it entirely, because every light it has is a material on a part its
   * body already carries (see `buildBuildingDecoration` above), which costs no
   * geometry and no draw call. Returning `[]` for a particular building says the
   * same thing one building at a time, and most of the toy world's does.
   *
   * A quad is for a light with no part of its own to sit on, and the two worlds
   * that have any are quite different about it:
   *  · the toy world's slab tower — the demo itself emits quads here, a film
   *    over the square slab ends the stack already exposes;
   *  · the toy world's clay house and BOTH of the corrugated world's lit parts
   *    (the amber bead colour, every other lid compartment) — the demo lights
   *    those through a MATERIAL, and the port cannot: a chunk's bodies are one
   *    InstancedMesh per shape over ONE vertex-coloured material, so a single
   *    part with its own emissive would be a second material and therefore a
   *    second batch. The quad is sized to that part instead.
   *
   * A style that declares quads must also supply `createBuildingLightMaterial`.
   */
  buildBuildingLights?(
    box: BuildingBox,
    seed: number,
    zone: ZoneKind | null,
  ): WindowPlacement[];

  /**
   * The material behind one `WindowPlacement.lit` key — required if and only if
   * `buildBuildingLights` can return a non-empty array.
   *
   * A strategy-owned singleton tagged `userData.shared` (the chunk owns and
   * frees the unit-plane geometry, never this). It should register itself with
   * `registerNightLitMaterial(mat, glow, { hideByDay: true })`: the demo's film
   * is an unlit quad whose colour is `WIN_LIT × k`, so it has to be switched off
   * by day rather than faded — 「白天整批 visible = false —— 全透明也是要付一次
   * draw call 跟一次 blend」.
   *
   * The key is open for the same reason `PartShape` is: the corrugated world
   * lights two different things (an abacus bead at `#b07d1c`, a pill-box
   * compartment at `#c9a45c`) and the demo gives them different glows, so
   * flattening them to one material would be inventing an agreement the demo
   * does not have. Called once per distinct key per chunk; the key set is a
   * fixed vocabulary and must not scale with the buildings.
   */
  createBuildingLightMaterial?(lit?: string): THREE.Material;

  /**
   * When false the tree renderer skips per-instance canopy tinting — paper's
   * cut-card trees carry their colours in the cutout texture and would be
   * washed green by an instanceColor multiply.
   */
  readonly tintTreeInstances: boolean;

  /**
   * When false the tree renderer skips the ink outline. An inverted hull of an
   * alpha-cut card is a SOLID black quad (the hull material has no alpha map),
   * which would stamp black rectangles behind every cut-out tree.
   */
  readonly outlineTrees: boolean;

  /**
   * 這個世界的樹要不要投影 / 收影。**省略 = 兩個都開**,也就是這個 hook 出現以前
   * 的行為,所以沒宣告的世界一格沒動。
   *
   * 為什麼需要一個逐世界的通道:`tree-renderer` 一個 chunk 只做**一個**
   * InstancedMesh,而 `castShadow` / `receiveShadow` 是**逐 draw** 的。三個 demo
   * 的答案並不一致 —— 積木的樹幹與螺旋都走 `boxBatcher`(兩個都開)、電子的
   * `discCapTree` 是 disc ∨ leg(兩個都開),而瓦楞紙的 `treeBucket.flush` 只在
   * 卡片那批開 `castShadow`(`if (depthMat)`),**receive 一件都沒有**。
   *
   * 在這個 hook 之前,唯一「不會對兩個世界都錯」的值是 `CR`,所以瓦楞紙一直帶著
   * 一條記錄在案的偏離(`scripts/headless-check/shadow-flags-vs-demo.ts`)。剪紙樹
   * 是一張 alphaTest 的卡:讓它收影等於在一張立著的薄片上算陰影,而 demo 那片
   * 板子上本來就只有卡片投下去的影子。
   */
  readonly treeShadow?: { readonly cast: boolean; readonly receive: boolean };

  // ── Geometry hooks (P1-P3) ──
  /**
   * Quantise an ABSOLUTE elevation (metres, DEM/GPX — NOT origin-relative) to
   * the strategy's discrete layer grid. Absolute so the layer phase is fixed in
   * world space and stays seamless as the floating origin shifts. Identity when
   * `params.quantEnabled` is false. Callers subtract the origin afterwards.
   */
  quantizeElevation(absoluteElevation: number): number;

  /**
   * Build a geometry for one tree instance (blocks → stacked cuboids; paper →
   * cut card). When omitted the tree renderer uses its default cone+cylinder.
   */
  buildTreeGeometry?(): THREE.BufferGeometry;

  /**
   * **The things a ground cover stands up.** One call per land-cover polygon;
   * return `null` for the kinds that stay flat.
   *
   * This is the one genuinely NEW hook in the landuse port, and it exists because
   * `landuse-renderer` could only ever lay flat polygons (its own header said
   * *"flat polygon meshes"*). The demos need more than that for exactly two of
   * the nine kinds, and the reason is CUSTOM_WORLD_INSTRUCTIONS §3.4: the rider's
   * eye is 6.3 m above the ground looking at a grazing angle, so a flat patch
   * gets almost no projected area. Each kind has to carry ONE signal that
   * survives that angle, and for two of them the signal is silhouette:
   *
   *   `playground` — slide / climbing frame / see-saw. The ONLY ground cover
   *                  allowed to stand tall; that is what distinguishes it from
   *                  the pitch it used to be drawn as.
   *   `wetland`    — reeds, in CLUMPS. Its axis against `farmland` is
   *                  irregular-vs-regular, so they must not be evenly spaced.
   *
   * `sports` returns `null` in EVERY world, and that one is not negotiable: flat
   * and only lines is the definition of the half it kept in the split, and the
   * moment a pitch stands something up the distinction this hook exists for is
   * gone. It is also the expensive one — Taipei's tile window holds 512 pitches.
   *
   * **The rest is each world's own answer, not a fixed list.** paper and plastic
   * stop at those two; circuit plants LED seedlings in its perfboard farmland and
   * half-buried solder beads in its sand, because in that world the ridge and the
   * grain ARE components. That is legal: farmland and sand are ~13 and ~2 per tile
   * window, nothing like the pitch. **"This kind stands nothing up" is a designed
   * answer, not an unfinished one** (§3.9's "this building has no light", same
   * shape) — and so is the opposite. The demo decides, per world.
   *
   * ## Ownership — read this before you build anything here
   *
   * The returned object is parented to the layer's slab mesh and freed by
   * `disposeLanduseMeshes`, which walks it and disposes every geometry and
   * material it finds **unless they are tagged `userData.shared = true`**
   * (CUSTOM_WORLD_INSTRUCTIONS §6). So:
   *
   * - Strategy-owned singletons (unit geometry, the world's shared materials)
   *   **must** carry `userData.shared = true`, or the first chunk to be recycled
   *   disposes a texture that every other chunk is still drawing.
   * - Anything genuinely per-patch may be left untagged; it will be freed —
   *   including `InstancedMesh`, whose `instanceMatrix` the recycler releases
   *   separately (`geometry.dispose()` does not touch it, §6's easy miss).
   *
   * ## Draw calls — and the advice that used to be here and was WRONG
   *
   * This paragraph used to say "prefer shared geometry + shared material, that is
   * what keeps this off the draw-call budget". **It is not.** three does no
   * automatic batching: N meshes sharing one geometry are still N draw calls.
   * Sharing saves memory and GL programs, which is worth doing, but the thing
   * that keeps props cheap is **merging or instancing**. Measured on the real
   * Taipei route when the circuit world ported its demo's props literally: 262
   * draw calls unmerged, 193 after merging by (material, castShadow,
   * receiveShadow). Follow the old advice and you land at 262.
   *
   * A chunk holds at most ~10 of these patches on the routes measured so far, so
   * there is room — but the hook is called once per polygon and hands you no
   * chunk identity, so any batching has to happen INSIDE one patch. If a denser
   * window ever needs cross-patch pooling, this signature is what has to change.
   *
   * ## Coordinates
   *
   * Everything is in LOCAL scene metres, the same space the slab is in, and
   * `slabY` is where the slab actually ended up — floor-quantised to the lowest
   * terrain tread it touches. Stand props on `slabY`, **not** on a fresh DEM
   * sample: the slab is flat and the ground under it is not, so re-deriving the
   * height puts the feet a layer above or below the mat they belong to.
   */
  buildLanduseProps?(ctx: LandusePropContext): THREE.Object3D | null;

  /**
   * 樹腳下的痕跡(瓦楞紙的白膠痕)。回傳 null 或省略 = 這個世界的樹沒有這種東西
   * ——「沒有」是完全合法的答案:塑膠的樹是插在底板上的,電子的是焊上去的。
   *
   * 合約與消費方式見 `TreeGroundMark`。renderer 把它做成一個**跟樹共用同一組
   * instance matrix 的姊妹 InstancedMesh**(跟 `createOutline` 同一個模式),
   * 一個 chunk 一個 draw call。
   */
  treeGroundMark?(): TreeGroundMark | null;

  /**
   * Build a black ink outline for a source mesh via the inverted-hull method
   * (paper P3). Returns a mesh to add to the scene, or null.
   */
  createOutline?(source: THREE.Mesh): THREE.Mesh | null;

  // ── Post-processing ──
  /**
   * Create the style's screen-space post pass (paper → paper-craft pass;
   * plastic → null). Owned by the caller once returned.
   */
  createPostPass(width: number, height: number): ShaderPass | null;

  /** Push current `params` into a live post pass created by `createPostPass`. */
  applyPostParams(pass: ShaderPass): void;

  // ── Live signals ──
  /**
   * The rider's live signals, once per rendered frame, with the frame time in
   * seconds. Same shape as `StreetLampParts.setNight` / `SkyAndFog.setPalette`:
   * the renderer owns the loop and pushes; the style only reacts.
   *
   * **Omitting the hook is a normal answer.** The toy and corrugated worlds have
   * nothing that answers to the rider's legs, and a world that does not declare
   * this is never called — no per-frame cost, and its geometry and census are
   * byte for byte what they were. The circuit world declares it because its demo
   * puts the rider INSIDE the world's own logic: 「**踏頻決定脈衝沿走線行進的速
   * 度,功率決定亮度**」, so a board with no rider on it is not that world.
   *
   * Two rules, both of which have a documented failure behind them:
   *  · **Relay, do not compute** (`RiderSignals`). This is the one channel that
   *    runs every frame, which makes it the most tempting place in the renderer
   *    to put a rolling average. Business logic lives on the server.
   *  · **Do not use it to touch anything the day/night driver owns.** A style's
   *    night-lit materials get their emissive COLOUR from the one global write
   *    (`setNightLitFactor`); a style that also wrote that colour from here
   *    would be two hands on one channel, and the loser would be whichever ran
   *    second that frame. Multiply a FREE channel instead — circuit puts the
   *    demo's `wattGain` on `emissiveIntensity` and on the spark's `opacity`,
   *    neither of which the night driver writes.
   */
  updateRiderSignals?(signals: RiderSignals, dt: number): void;

  /** Dispose strategy-owned singletons (building material, etc.). */
  dispose(): void;
}

/**
 * Factory — dynamic import so each style is code-split (mirrors
 * `createStyleStrategy` for Phaser).
 */
export async function createTerrainStyleStrategy(
  style: TerrainStyle,
): Promise<TerrainStyleStrategy> {
  if (style === 'paper') {
    const { createPaperTerrainStyle } = await import('./paper-terrain-style');
    return createPaperTerrainStyle();
  }
  if (style === 'circuit') {
    const { createCircuitTerrainStyle } = await import('./circuit-terrain-style');
    return createCircuitTerrainStyle();
  }
  const { createPlasticTerrainStyle } = await import('./plastic-terrain-style');
  return createPlasticTerrainStyle();
}

/**
 * Deterministic RNG (mulberry32) — same generator the demos and the Phaser
 * mountains use, so a given seed reproduces the same skyline every time.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Snap an absolute elevation to the discrete layer grid. Shared by both styles.
 * Identity when quantisation is off or the layer height is degenerate.
 */
export function quantizeToLayer(absoluteElevation: number, params: StyleParams): number {
  if (!params.quantEnabled || params.layerHeight <= 0.01) return absoluteElevation;
  return Math.round(absoluteElevation / params.layerHeight) * params.layerHeight;
}

/** Default parameters per style. Tuned conservatively; user refines via panel. */
export function defaultStyleParams(style: TerrainStyle): StyleParams {
  if (style === 'circuit') {
    return {
      quantEnabled: true,
      // One stacked board per step (FR4 edge on every riser) — and this one WAS
      // already the demo's: `TERRAIN_STEP_H = 6`, the number `edgeMatForLevel`
      // counts copper layers with. The other two worlds' steps were not, and are
      // now; `[terrain band vs demo]` pins all three against the demo sources.
      layerHeight: 6,
      gridSize: 28,        // boards are large flat pieces — coarser than blocks
      heightJitter: 0,     // boards lie flat; a sunk board is a soldering defect
      corrugationStrength: 0,
      bumpEnabled: true,   // unused by circuit (no dents), kept for type parity
      paintEnabled: true,  // unused by circuit, kept for type parity
      inkEnabled: false,
      inkThickness: 0,
      inkColor: 0x000000,
      paperPosterize: 0,
      paperDesaturate: 0,
      paperFiber: 0,
      paperStrength: 0,
      acrylicCaseEnabled: true,
      // DEVPLAN: 電子 = 三個世界唯一要「強」bloom 的 — 這個世界的識別性就是發光
      // (走線、輝光管、LED),而 emissive 本身不會外溢,外溢那一圈才是眼睛讀成
      // 「在發光」的東西。demo 的 buildPost 是它自己刻的;gameview 走共用的
      // scene-bloom-pass,由這個旗子 ∧ 畫質分級決定開關。
      sceneBloomEnabled: true,
    };
  }
  if (style === 'paper') {
    return {
      quantEnabled: true,
      // ONE CARDBOARD SHEET, and the demo says how thick one is: `PLATE_H = 3.2`.
      //
      // This was `12` with the comment「taller cardboard sheets」and nothing else
      // — a 3.75× re-derivation with no reason recorded and no assertion on it
      // (§0.0 第 1 條: it looked right and it was different every time). It costs
      // twice over, because `layerHeight` is BOTH the quantiser step and the wall
      // texture's vertical repeat (`quantized-terrain.ts`: `v = ele / layerH`,
      // one plate per repeat — the demo's `rep(plateEdgeTex, 0.05, 1 / PLATE_H)`):
      //
      //  · the terraces were 3.75× too tall, and
      //  · one plate's flutes were stretched over 12 m instead of 3.2, so the
      //    corrugation on every cut edge ran at 1 : 3.3 instead of the demo's
      //    ~1 : 1 — which is why the risers did not read as cardboard at all.
      //
      // `[terrain band vs demo]` now asserts this against `PLATE_H` sliced out of
      // the demo, so the two cannot drift apart again — and because the wall UV is
      // a function of `layerHeight`, changing the step re-fits the texture for
      // free. Never re-introduce a separate metre count for the wall repeat.
      layerHeight: 3.2,
      gridSize: 32,        // coarse (perf-safe default; user tunes finer)
      heightJitter: 0,     // sheets stay perfectly flat
      corrugationStrength: 1.0,
      bumpEnabled: true,
      paintEnabled: true,  // demo 的開場態（`?paint=0` 才是素紙板）
      inkEnabled: true,
      inkThickness: 0.35,
      inkColor: 0x1a1208,  // near-black warm brown
      // ⚠ 0，不是先前的 0.6 / 0.5。**demo 完全沒有後製** —— 它只有
      // `renderer.render(scene, camera)`，零個 EffectComposer、零個 ShaderPass。
      // 去飽和在 demo 裡只發生一次，而且是烘在字面色票裡（`ERASER_COLORS`）。
      // 螢幕上再做一次就是同一件事做第二次，量出來讓地面色相被挪走到 −33°、
      // 飽和度再掉 39%——那就是「整個世界偏棕色」。
      paperPosterize: 0,
      paperDesaturate: 0,
      paperFiber: 0.35,
      paperStrength: 1.0,
      acrylicCaseEnabled: true,
      // DEVPLAN: 瓦楞紙不做 bloom — poster paint does not glow, and the moment
      // it does this stops being that world. Not a perf call; a look call.
      sceneBloomEnabled: false,
    };
  }
  return {
    quantEnabled: true,
    // The demo's `STEP_H = 4` — one brick course. Was `6`; same untracked
    // re-derivation as paper's, 1.5×. `bandAt` reads the same number, so the six
    // colour bands covered 36 m of relief instead of the demo's 24.
    layerHeight: 4,
    gridSize: 24,          // block size (perf-safe default; user tunes finer)
    heightJitter: 1.5,     // subtle per-block sink → same-layer blocks vary
    corrugationStrength: 0,
    bumpEnabled: true,     // unused by plastic (no dents), kept for type parity
    paintEnabled: true,    // unused by plastic, kept for type parity
    inkEnabled: false,
    inkThickness: 0,
    inkColor: 0x000000,
    paperPosterize: 0,
    paperDesaturate: 0,
    paperFiber: 0,
    paperStrength: 0,
    acrylicCaseEnabled: true,
    // DEVPLAN: 積木 = 很弱、只在夜間 — threshold high enough that only the lamps
    // and the coins spill. `SceneBloomPass` disables itself in daylight, so by
    // day this costs one branch and nothing on the GPU.
    sceneBloomEnabled: true,
  };
}
