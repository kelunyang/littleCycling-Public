/**
 * The acrylic display case over the whole diorama — DEVPLAN「壓克力罩天空」.
 *
 * The world is a model standing on a desk (that is what `mountainRing/disc` is),
 * so it stands under a case: the architecture model's presentation cover, the
 * toy's display box. Both demos ship it; `?dome=0` turns it off there.
 *
 * ── What makes it read as a CASE and not as tinted air ──────────────────────
 *
 * A single translucent sphere is a colour wash. Three things turn it into an
 * object, and the spec asks for all three:
 *
 *  1. **A shell** — BackSide, very low opacity, slightly tinted, thickening
 *     toward the base (you look through more acrylic level-on than overhead).
 *  2. **A thicker rim where it meets the desk.** This is the one clue that says
 *     the wall HAS a thickness. It is not a thin skirt: the mountain rings are
 *     1.7 km and 2.6 km out and up to 560 m tall, so from a 6 m eye they eat
 *     everything below ~18°. A short band would be behind them at every camera
 *     angle — measured, not guessed, in both demos. So the band is tall and its
 *     alpha ramps down: what shows above the ridgeline is its MIDDLE, which
 *     reads as "a wall of acrylic sinking behind the hills, thicker as it goes".
 *  3. **Long specular streaks on the crown.** See `AcrylicStreak` for why they
 *     have to run all the way down toward the horizon.
 *
 * Plus the weather: rain tints the case a step colder and beads it, with a
 * scrolling water-trace film on the OUTSIDE. The world's own rain is untouched
 * — both layers visible at once is the point, otherwise it is just bigger rain.
 *
 * ── Rules that bite ─────────────────────────────────────────────────────────
 *
 *  · `fog: false`, without exception. Fog is the air INSIDE the world; the case
 *    is outside it. Weather fog tops out around 3 km and the case is at 3.2 km,
 *    so a fogged case is a case painted entirely in fog colour.
 *  · `depthWrite: false` on every part — a translucent shell that writes depth
 *    occludes the things inside it, including its own highlights.
 *  · Explicit `renderOrder`, outermost first. Every part is centred on the
 *    rider, so three's transparent sort compares identical distances and picks
 *    an order by coin toss.
 *  · Night makes the case MORE transparent, never less. Solidifying it at night
 *    smothers the lamps it is supposed to be sitting over.
 *  · Alpha gradients ride the geometry's `color` attribute (itemSize 4, white
 *    RGB + varying A), not a texture. One less sampler on a fill-rate-bound
 *    machine, and — the reason that matters here — an alpha ramp baked in a
 *    canvas cannot be asserted in `npm run check:3d`, because the headless
 *    canvas stub draws nothing. A buffer of numbers can.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * `PERF_AUDIT.md` once named this the top fill-rate risk on the strength of its
 * bounding sphere. Measured, it was 0.2 ms: a big sphere that the terrain and
 * the mountain rings occlude fills almost nothing, and the fragments they hide
 * die on early-Z before they ever blend. 大包圍球 ≠ 填得多. It is still behind
 * the quality tier AND a rider switch, because none of that has been measured
 * on the N100 with gameview's fourteen ground-covering layers underneath it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AcrylicCaseLevel } from '@/game/quality/graphics-quality';
import type { AcrylicCaseStyle, TerrainStyleStrategy } from './terrain-style-strategy';

/**
 * Case radius in metres. Must sit OUTSIDE the far mountain ring (2600 m) and
 * inside the horizon disc it stands on (4000 m) so its foot lands on the desk,
 * and inside the sky dome (5000 m) — the sky stays, the case is a layer under
 * it, per DEVPLAN.
 */
export const ACRYLIC_CASE_RADIUS = 3200;

/**
 * How far below the rider the case's foot sits — the desk surface.
 *
 * MUST equal `DISC_DROP` in `mountain-ring.ts`, which is not exported; the
 * headless check pins the two together by building a ring and reading the disc's
 * y back, so a change on either side fails loudly instead of leaving the case
 * hovering over, or buried in, its own desk.
 */
export const ACRYLIC_CASE_DESK_DROP = 35;

/**
 * Height of the thickening rim band, in metres.
 *
 * Chosen from the occluders, not from taste. At r = 3200 the far ring's tallest
 * silhouette (~690 m at 2600 m, seen from a ~6 m eye) crosses the case at
 * y ≈ 3200·tan(14.9°) ≈ 850 m. A band that stopped there would be invisible; a
 * band whose alpha had already faded out by there would be invisible too. 1400 m
 * puts the ridgeline at ~61% of the way UP the ramp, so the part on show is the
 * band's middle, at roughly half its alpha, still climbing toward the desk.
 *
 * ⚠ The margin used to be far larger. The far ring was 430 m (9.4°, crossing at
 * ~520 m) until it was rescaled to the paper demo's own angular size — see
 * NEAR_/FAR_MAX_HEIGHT in `mountain-ring.ts`, which is also where §3.6 explains
 * why the far ring had to grow. `[acrylic case]` derives the crossing from the
 * BUILT ring, so it tracks this on its own, but the headroom is now ~1.7× rather
 * than ~2.7×: raise the rings again and that check is the one that will go red.
 */
export const ACRYLIC_RIM_HEIGHT = 1400;

/** The lit cut edge sitting on the desk. Short and bright — it is an edge. */
const LIP_HEIGHT = 26;

/** Radial segments. The case is a smooth curve at 3.2 km; 40 is already past
 *  the point where another one is a pixel. */
const RADIAL_SEGMENTS = 40;

/** Rain-trace film height and how fast the traces run down (repeats/second). */
const RAIN_FILM_HEIGHT = 1500;
const RAIN_SCROLL_SPEED = 0.05;

/**
 * How much of the case is built.
 *
 *  · `off`   — nothing at all. The low tier, and the rider's switch when off.
 *  · `shell` — 罩壁 only: the shell, the rim band and the crown streaks (3 draw
 *              calls), so even the cut-down case still reads as a case rather
 *              than a wash.
 *  · `full`  — plus the lit lip and the rain film (5 draw calls, 4 in dry
 *              weather).
 *
 * Re-exported from `graphics-quality.ts` rather than declared again: the tier
 * table and this module have to mean the same three words, and two structurally
 * identical unions would type-check happily while drifting apart.
 */
export type { AcrylicCaseLevel };

/** Scratch colour for the day/night/rain lerps — no per-frame allocation. */
const _scratch = new THREE.Color();

/** Draw order, outermost first — see the header. All well below the terrain. */
const ORDER_FILM = -96;
const ORDER_SHELL = -95;
const ORDER_RIM = -94;
const ORDER_LIP = -93;
const ORDER_STREAK = -92;

/**
 * Give a geometry a per-vertex alpha ramp driven by height.
 *
 * White RGB throughout, so `material.color` stays the single place the tint
 * lives (day/night/rain all move it) and no colour-space conversion is implied.
 *
 * THE BLACK-PART TRAP (see `markInstanceTemplate`): `vertexColors` is a property
 * of the MATERIAL, so a geometry that reaches a vertex-coloured material without
 * a `color` attribute renders black in WebGL and nowhere else. Every geometry
 * built here goes through this function.
 *
 * @param alphaAt maps a vertex's y (in the geometry's own frame) to 0..1.
 */
function applyAlphaRamp(
  geometry: THREE.BufferGeometry,
  alphaAt: (y: number) => number,
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 4] = 1;
    colors[i * 4 + 1] = 1;
    colors[i * 4 + 2] = 1;
    colors[i * 4 + 3] = Math.max(0, Math.min(1, alphaAt(pos.getY(i))));
  }
  // itemSize 4 is what turns on three's USE_COLOR_ALPHA; at 3 the alpha column
  // is silently ignored and the whole ramp disappears.
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  return geometry;
}

/** Every case material is the same kind of thing: unlit, unfogged, blended. */
function caseMaterial(color: number, opacity: number, vertexColors: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    vertexColors,
    transparent: true,
    // Seen from inside.
    side: THREE.BackSide,
    // A translucent shell that writes depth hides its own contents.
    depthWrite: false,
    // The case is outside the world's air. Fog would paint it fog-coloured.
    fog: false,
  });
}

/**
 * Water traces running down the outside of the case.
 *
 * Transparent background — no fill. A filled base would smear the whole case
 * into one block, and the headless texture probe would read the fill colour as
 * "this texture is that colour". Everything is drawn with fillRect so the
 * texture survives a stubbed 2D context without producing nonsense.
 *
 * Seamless in both axes: it repeats around the case, and any trace that ran off
 * an edge without being drawn again on the far side would leave a visible
 * vertical join all the way round.
 */
function createRainFilmTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  // Own RNG stream, own seed. Nothing here may touch a shared chunk stream —
  // one extra draw from it re-rolls every building on the route.
  let s = 0x9e37 >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < 34; i++) {
    const x = rnd() * W;
    const y0 = rnd() * H;
    const len = 14 + rnd() * 62;
    const w = 0.9 + rnd() * 2.0;
    const trail = `rgba(255,255,255,${(0.16 + rnd() * 0.3).toFixed(3)})`;
    const head = `rgba(255,255,255,${(0.4 + rnd() * 0.35).toFixed(3)})`;
    // Nine-patch: draw each trace at every wrap offset so both seams close.
    for (const dy of [-H, 0, H]) {
      for (const dx of [-W, 0, W]) {
        const px = x + dx;
        const py = y0 + dy;
        if (px + w < 0 || px > W || py > H || py + len + 3 < 0) continue;
        g.fillStyle = trail;
        g.fillRect(px, py, w, len);
        g.fillStyle = head;
        g.fillRect(px - w * 0.4, py + len, w * 1.8, 2.4);
      }
    }
  }
  // Beads that never ran.
  for (let i = 0; i < 120; i++) {
    const r = 0.7 + rnd() * 1.7;
    g.fillStyle = `rgba(255,255,255,${(0.12 + rnd() * 0.34).toFixed(3)})`;
    g.fillRect(rnd() * W, rnd() * H, r, r);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The case. Built once per style, follows the rider, tinted by day/night and
 * weather, trimmed by the quality tier.
 *
 * Ownership: it owns every geometry, material and texture it makes and frees
 * them in `dispose()`. It reads NOTHING per frame that it does not get handed.
 */
export class AcrylicCase {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();

  private shellMat: THREE.MeshBasicMaterial | null = null;
  private rimMat: THREE.MeshBasicMaterial | null = null;
  private lipMat: THREE.MeshBasicMaterial | null = null;
  private streakMat: THREE.MeshBasicMaterial | null = null;
  private filmMat: THREE.MeshBasicMaterial | null = null;
  private filmTex: THREE.CanvasTexture | null = null;
  private film: THREE.Mesh | null = null;
  /** Parts that only exist at `full` — hidden, not rebuilt, when the tier drops. */
  private fullOnly: THREE.Object3D[] = [];

  private style: AcrylicCaseStyle | null = null;
  /** The rider's wish (`StyleParams.acrylicCaseEnabled`). */
  private wanted = false;
  /** The tier's ceiling. `off` beats any wish — perf floor wins. */
  private level: AcrylicCaseLevel = 'shell';
  private night = 0;
  private raining = false;

  private readonly tint = new THREE.Color();

  constructor(scene: THREE.Scene, strategy: TerrainStyleStrategy, level: AcrylicCaseLevel) {
    this.scene = scene;
    this.group.name = 'acrylicCase';
    this.level = level;
    this.scene.add(this.group);
    this.setStrategy(strategy);
  }

  /**
   * Rebuild for a (possibly new) style. Reads the rider's switch off the
   * strategy's params, which `applyWorldOptions` has already written.
   */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.disposeParts();
    this.style = strategy.acrylicCase ?? null;
    this.wanted = strategy.params.acrylicCaseEnabled;
    if (this.style && this.wanted) this.build(this.style);
    this.applyLevel();
    this.applyTint();
  }

  /**
   * The quality tier's ceiling (and the fps governor's lever). The rider's
   * switch expresses intent; THIS decides how much of it survives.
   */
  setLevel(level: AcrylicCaseLevel): void {
    if (this.level === level) return;
    this.level = level;
    this.applyLevel();
  }

  /** 0 = full day, 1 = full night. */
  setNight(nightFactor: number): void {
    const n = Math.max(0, Math.min(1, nightFactor));
    if (Math.abs(n - this.night) < 1e-3) return;
    this.night = n;
    this.applyTint();
  }

  /** Rain beads the outside and pulls the whole case a step colder. */
  setRaining(raining: boolean): void {
    if (this.raining === raining) return;
    this.raining = raining;
    this.applyLevel();
    this.applyTint();
  }

  /**
   * Follow the rider (translation only — the case is a fixed thing the world
   * moves under) and run the water down the outside.
   */
  update(riderPosition: THREE.Vector3, dt: number): void {
    this.group.position.set(
      riderPosition.x,
      riderPosition.y - ACRYLIC_CASE_DESK_DROP,
      riderPosition.z,
    );
    // Positive offset scrolls the texture up, so the water runs DOWN.
    if (this.filmTex && this.film?.visible) {
      this.filmTex.offset.y = (this.filmTex.offset.y + dt * RAIN_SCROLL_SPEED) % 1;
    }
  }

  /** True when anything is actually on screen — the checks read this. */
  isActive(): boolean {
    return this.group.visible && this.group.children.length > 0;
  }

  /** What the case is currently allowed to show (tier ∧ rider). */
  getEffectiveLevel(): AcrylicCaseLevel {
    if (!this.wanted || !this.style) return 'off';
    return this.level;
  }

  dispose(): void {
    this.disposeParts();
    this.group.removeFromParent();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private build(style: AcrylicCaseStyle): void {
    const R = ACRYLIC_CASE_RADIUS;

    // ── Shell: the case itself. Alpha rises toward the desk. ──
    // 24×12 on a 3.2 km hemisphere: each quad is still ~13° of a curve nothing
    // ever gets close to, and the whole thing is one flat colour.
    this.shellMat = caseMaterial(style.tintDay, style.shellOpacity, true);
    const shellGeo = applyAlphaRamp(
      new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      (y) => 1 - 0.65 * (y / R),
    );
    const shell = new THREE.Mesh(shellGeo, this.shellMat);
    shell.name = 'acrylicCase/shell';
    shell.renderOrder = ORDER_SHELL;
    shell.frustumCulled = false;
    this.group.add(shell);

    // ── Crown streaks: the reflections that say "this is a hard surface". ──
    // Merged into ONE geometry, so two or three streaks are still one draw
    // call. Slightly inside the shell so it is never the shell that wins.
    if (style.streaks.length > 0) {
      const parts = style.streaks.map(
        ([phi, phiLen, theta, thetaLen]) =>
          new THREE.SphereGeometry(R * 0.99, 3, 16, phi, phiLen, theta, thetaLen),
      );
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (merged) {
        this.streakMat = caseMaterial(style.streakDay, style.streakOpacity, false);
        const streaks = new THREE.Mesh(merged, this.streakMat);
        streaks.name = 'acrylicCase/streaks';
        streaks.renderOrder = ORDER_STREAK;
        streaks.frustumCulled = false;
        this.group.add(streaks);
      }
    }

    // ── Rim: the wall thickening into the desk. See ACRYLIC_RIM_HEIGHT. ──
    // Just inside the shell, so the two never disagree about who is in front.
    this.rimMat = caseMaterial(style.rimDay, style.rimOpacity, true);
    const rimGeo = applyAlphaRamp(
      new THREE.CylinderGeometry(R * 0.998, R * 0.998, ACRYLIC_RIM_HEIGHT, RADIAL_SEGMENTS, 1, true),
      // Cylinder is centred on its own origin: y runs ±H/2, 0 at the desk after
      // the mesh is lifted. Ramp 0 at the top → 1 at the foot, biased so the
      // thickening is concentrated near the desk rather than linear.
      (y) => Math.pow(1 - (y + ACRYLIC_RIM_HEIGHT / 2) / ACRYLIC_RIM_HEIGHT, 1.5),
    );
    const rim = new THREE.Mesh(rimGeo, this.rimMat);
    rim.name = 'acrylicCase/rim';
    rim.position.y = ACRYLIC_RIM_HEIGHT / 2;
    rim.renderOrder = ORDER_RIM;
    rim.frustumCulled = false;
    this.group.add(rim);

    // ── Lip: the cut edge on the desk. Brightest part — acrylic edges pipe
    //    light, and this is the only place the case's thickness is face-on. ──
    this.lipMat = caseMaterial(style.lipColor, style.lipOpacity, false);
    const lip = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 1.004, R * 1.004, LIP_HEIGHT, RADIAL_SEGMENTS, 1, true),
      this.lipMat,
    );
    lip.name = 'acrylicCase/lip';
    lip.position.y = LIP_HEIGHT / 2;
    lip.renderOrder = ORDER_LIP;
    lip.frustumCulled = false;
    this.group.add(lip);
    this.fullOnly.push(lip);

    // ── Rain film: water on the OUTSIDE, so a larger radius and drawn first. ──
    //
    // Its top edge needs the same alpha fade the rim has, and for a harder
    // reason than looks: a band of uniform alpha ending at a fixed height draws
    // a HORIZONTAL LINE right round the sky at that height. Caught in the
    // headless probe's part map, where the film's top edge showed as a clean
    // 100 m stripe above the rim — in the real renderer that is not a seam, it
    // reads as a broken texture.
    this.filmTex = createRainFilmTexture();
    this.filmMat = caseMaterial(style.rainFilmColor, 0.45, true);
    this.filmMat.map = this.filmTex;
    this.film = new THREE.Mesh(
      applyAlphaRamp(
        new THREE.CylinderGeometry(R * 1.01, R * 1.01, RAIN_FILM_HEIGHT, RADIAL_SEGMENTS, 1, true),
        (y) => Math.pow(1 - (y + RAIN_FILM_HEIGHT / 2) / RAIN_FILM_HEIGHT, 1.2),
      ),
      this.filmMat,
    );
    this.film.name = 'acrylicCase/rainFilm';
    this.film.position.y = RAIN_FILM_HEIGHT / 2;
    this.film.renderOrder = ORDER_FILM;
    this.film.frustumCulled = false;
    this.film.visible = false;
    this.group.add(this.film);
    this.fullOnly.push(this.film);
  }

  /** Tier ∧ rider → what is visible. Never rebuilds; only flips `visible`. */
  private applyLevel(): void {
    const level = this.getEffectiveLevel();
    this.group.visible = level !== 'off';
    for (const part of this.fullOnly) part.visible = level === 'full';
    // The film is `full`-only AND rain-only; the line above already turned it
    // on for `full`, so this is the second gate rather than a contradiction.
    if (this.film) this.film.visible = level === 'full' && this.raining;
  }

  /**
   * Day → night → rain colouring.
   *
   * Night goes COLDER and MORE TRANSPARENT. The instinct is the other way
   * ("night = solid glass"), and it is wrong twice: the case would smother the
   * lamps under it, and a translucent shell that gains opacity in the dark reads
   * as fog, not acrylic.
   */
  private applyTint(): void {
    const style = this.style;
    if (!style) return;
    const k = this.night;
    const rainMix = this.raining ? 0.5 : 0;
    const rainOpacity = this.raining ? 1.35 : 1;

    if (this.shellMat) {
      this.tint.setHex(style.tintDay).lerp(_scratch.setHex(style.tintNight), k);
      this.shellMat.color.copy(this.tint).lerp(_scratch.setHex(style.tintRain), rainMix);
      this.shellMat.opacity = style.shellOpacity * (1 - 0.25 * k) * rainOpacity;
    }
    if (this.rimMat) {
      this.tint.setHex(style.rimDay).lerp(_scratch.setHex(style.rimNight), k);
      this.rimMat.color.copy(this.tint).lerp(_scratch.setHex(style.tintRain), rainMix);
      this.rimMat.opacity = style.rimOpacity * (1 - 0.2 * k) * rainOpacity;
    }
    if (this.streakMat) {
      this.streakMat.color.setHex(style.streakDay).lerp(_scratch.setHex(style.streakNight), k);
      // The reflection needs something to reflect. Indoors at night there is
      // less of it, so the streaks fade harder than the shell does.
      this.streakMat.opacity = style.streakOpacity * (1 - 0.45 * k);
    }
    if (this.lipMat) {
      this.lipMat.opacity = style.lipOpacity * (1 - 0.2 * k);
    }
  }

  private disposeParts(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
    }
    for (const mat of [this.shellMat, this.rimMat, this.lipMat, this.streakMat, this.filmMat]) {
      mat?.dispose();
    }
    // Disposing a material never touches its map.
    this.filmTex?.dispose();
    this.shellMat = null;
    this.rimMat = null;
    this.lipMat = null;
    this.streakMat = null;
    this.filmMat = null;
    this.filmTex = null;
    this.film = null;
    this.fullOnly = [];
  }
}
