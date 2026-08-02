/**
 * Distant mountains — the one piece of far scenery the 3D world was missing
 * (Phaser 2D has had its two-layer parallax mountains all along).
 *
 * A VERTICAL CURTAIN, and that is the demos' considered answer, not a leftover.
 * `plan/paper-town-demo.html` built the horizon out of `contourRing()` — a real
 * laminated contour model, ~20k faces of stacked board — and then threw it away
 * with the reason written down:
 *
 * > 這裡本來是 contourRing():等高線疊層的瓦楞紙山。錯的不是做法,是**位置**。
 * > 等高線疊層是**模型本體**的語言 […] 但遠山不是模型的一部分 —— 它是**背板上
 * > 刷的一道墨**。[…] 把疊層搬到天邊,遠看只會像一圈被美工刀切開的紙箱立在那裡。
 *
 * `contourRing` is still in the demo file and is dead code there. That matters
 * enough to be a check: `[mountain ring vs demo]` asserts it has ZERO CALL SITES
 * and that its per-plate band jitter appears nowhere else — deleting it outright
 * would pass too. The assertion is deliberately shaped that way round, because
 * "the paper demo's horizon is banded" has now been re-derived from that dead
 * function twice, and pinning its EXISTENCE would preserve the very design the
 * demo rejected. The live horizons
 * are `inkRidge()` (paper) and `blockMountainRing()` (plastic), both curtains,
 * and `heatsinkRing()` (circuit), which is NOT a curtain — it is a ring of
 * instanced fin boxes over a base cylinder, and the demo says why:
 *
 * > 散熱片本來就是一片一片、片與片之間有縫的,所以遠一圈的山會自然從近一圈的縫
 * > 裡透出來 —— paper 版為了讓兩圈都看得到,花了很大力氣去調張角(近矮遠高),
 * > 這裡是造型免費附送的。
 *
 * So this file builds BOTH: the curtain (`buildStrip`) for a style that says
 * nothing, and the demo's fins (`buildFinRing`) for a style that declares
 * `mountainRingFins`. Circuit declares it; paper and plastic do not and are not
 * touched by a line of it. The gaps are not a substitute for §3.6 — circuit's
 * rings keep exactly the angular sizes every other world gets, and the
 * see-through is on top of that. Both halves are measured in the check: the
 * fraction of azimuths where the far ring is visible BELOW the near ring's local
 * crest (through a gap) is 0 for a curtain and must be large for the fins.
 *
 * NO PART OF ANY RING IS BANDED BY HEIGHT. `TERRAIN_BAND` / `bandAt()` is the
 * CORRIDOR's language in all three demos, never the horizon's: the colour axis
 * out here is WHICH RING (near dense, far pale — aerial perspective), which is
 * why `mountainColor(layer)` takes a layer and not a height. The check drives
 * that as a rule, not a value — it counts `bandAt` calls during `build()` and
 * expects zero.
 *
 * The curtain is ported — with the two things the curtain has that
 * gameview did not:
 *
 *  - the RIDGE INK LINE (`INK_FAR_LINE` / `INK_NEAR_LINE`), a darker band down
 *    from the crest, now a second sub-mesh per ring driven by
 *    `strategy.mountainRingFinish()`;
 *  - the demos' ANGULAR SIZES, which is the only thing that makes two rings
 *    worth drawing (see NEAR_/FAR_MAX_HEIGHT).
 *
 * Two rings around the rider plus a horizon disc:
 *  - The rings TRANSLATE with the rider but never rotate, so the near ring
 *    slides past the far one exactly like 2D parallax.
 *  - The disc is the surface the whole diorama sits on (cuphead → a green
 *    cutting mat, plastic → a moulded baseplate — see `createHorizonMaterial`).
 *    It fills the void beyond the terrain corridor, which the sky dome would
 *    otherwise paint (three's `Sky` is a BackSide box covering the lower
 *    hemisphere too — that's what the old 10 km ground plane was for). It is an
 *    ANNULUS starting just past the corridor, so it can never slice through the
 *    terrain the rider is actually riding on, however deep the valley.
 *
 * Profiles come from the strategy (`generateMountainProfile`), so cuphead gets
 * the ink demo's harmonics and plastic gets quantised brick steps.
 */

import * as THREE from 'three';
import type {
  MountainLayer,
  MountainRingFinish,
  TerrainStyleStrategy,
} from './terrain-style-strategy';

/**
 * Ring radii in metres. The far one is exported because `day-night-lighting`
 * has to hold the fog's far end past it — see `MOUNTAIN_RING_FOG_DEPTH` there.
 */
const NEAR_RADIUS = 1700;
export const MOUNTAIN_FAR_RADIUS = 2600;
const FAR_RADIUS = MOUNTAIN_FAR_RADIUS;

/**
 * Peak height at profile 1.0 — THE DEMOS' RINGS, SCALED UNIFORMLY.
 *
 * `plan/paper-town-demo.html` calls `inkRidge` with near `radius 400 / maxH 68`
 * and far `radius 640 / maxH 170`. Scaling each ring by its own radius ratio
 * reproduces the demo's ANGULAR sizes exactly — the height scale subtends 9.7°
 * near and 14.9° far, and any given seed's crest lands a little under that —
 * which is what the demo actually tuned, in metres it wrote down the working for:
 *
 * > 高度是量出來的,不是抓的:騎士眼睛在地面上 6.3 m,近圈半徑 400,所以稜線
 * > 每高 10 m 就在視野裡多佔 1.4 度。第一版近圈 base 62 + amp 28(峰值約 108)
 * > = 抬頭 15 度,整條天際線被它封死 —— 那是「一道牆」不是「一抹墨」。
 *
 * The values these replace were 560 @ 1700 and 430 @ 2600 = 18.2° near / 9.4°
 * far, i.e. a near ring TALLER than the 15° "wall" the demo rejected, and a far
 * ring with a SMALLER angular size than the near one — so the far ring only ever
 * showed through the near one's valleys, and the parallax it exists to provide
 * had almost nothing to act on. §3.6 of CUSTOM_WORLD_INSTRUCTIONS is the rule
 * that was being broken:
 *
 * > `maxH / radius` 這個比值,遠圈一定要大於近圈,否則遠山整圈躲在近山後面。
 *
 * ⚠ The PLASTIC demo breaks that rule too (near 150/420 = 0.357, far
 * 110/600 = 0.183) and the circuit demo does not (0.242 / 0.371). Two of three
 * demos plus the written law win: gameview uses one ring geometry for every
 * world, and it obeys §3.6. This is the one number in this file that is not a
 * demo transcription for plastic.
 */
const NEAR_MAX_HEIGHT = 68 * (NEAR_RADIUS / 400);
const FAR_MAX_HEIGHT = 170 * (FAR_RADIUS / 640);

/**
 * How high each ring reaches in the rider's FIELD OF VIEW, in degrees above the
 * horizon, at `profile` 1.0 — the same 9.7° / 14.9° the header comment above
 * derives, computed rather than transcribed.
 *
 * Exported because the ring is what DECIDES how much sky is left on screen: the
 * band a rider can actually see runs from the ridge line up to the frame's top
 * edge (`chaseFrameTopElevationDeg` in fps-camera.ts). A world whose sky
 * gradient only reaches its top colour ABOVE that band has, from the saddle, no
 * sky colour at all — which is exactly what the circuit world shipped with, and
 * what `[sky covers the visible band]` in diorama.ts now asserts against.
 *
 * Any given seed's crest lands a little under this; the valleys go well under.
 */
export const FAR_RING_CREST_DEG = (Math.atan(FAR_MAX_HEIGHT / FAR_RADIUS) * 180) / Math.PI;
export const NEAR_RING_CREST_DEG = (Math.atan(NEAR_MAX_HEIGHT / NEAR_RADIUS) * 180) / Math.PI;

/**
 * Segments around each ring. The demo uses 132 (far) / 148 (near); 160 for both
 * is denser, and the profiles are continuous functions of angle, so this changes
 * tessellation and nothing about the shape.
 */
const SEGMENTS = 160;

/**
 * What a style that has not declared `mountainRingFinish` gets: exactly the
 * behaviour every ring had before the hook existed. A missing hook must not
 * silently take the ink line away from a world that never had one, nor hand it
 * one it never asked for.
 */
const DEFAULT_RING_FINISH: MountainRingFinish = {
  ridgeLineColor: null,
  ridgeLineThickness: 0,
  fog: true,
};

/**
 * One ring built as the circuit demo's HEATSINK FINS instead of a curtain —
 * `heatsinkRing`'s option bag, minus the four things gameview already owns.
 *
 * The names are the demo's (`o.fins` / `o.depth` / `o.thick` / `o.baseH` /
 * `o.sink`) because that is the cheapest evidence that this was copied rather
 * than re-derived. What is NOT here, and why:
 *
 *  · `o.radius` / `o.maxH` — gameview's, not the demo's. The demo picks how big
 *    its world is; gameview streams a real route, and the two ring radii and
 *    height scales are already fixed above by §3.6 (see NEAR_/FAR_MAX_HEIGHT).
 *    They are handed to the hook so a style can scale the rest of the demo's
 *    numbers off them.
 *  · `o.seed` — the ring seeds the profile itself, once per layer.
 *  · the fin colour — that is `mountainColor(layer)`, so the near/far aerial
 *    perspective every world obeys keeps working here too.
 *
 * ⚠ WHAT IS A PROPORTION AND WHAT IS A SHAPE. Seen from the ring's centre — and
 * the rings are centred on the rider, always — a fin is exactly edge-on, so its
 * silhouette is its INNER end face: `thick / radius` is the comb's duty cycle
 * and `depth` contributes nothing to it. That is why a style is expected to
 * scale `thick` with the ring's radius (angular width preserved) and `baseH` /
 * `sink` with its height scale (plinth-to-peak proportion preserved), and why
 * `depth` is the one number it can give up when something else needs the room.
 */
export interface MountainRingFins {
  /** `o.fins` — instances in the batch, and the resolution of the profile. */
  fins: number;
  /** `o.depth` — the blade's RADIAL length, metres. */
  depth: number;
  /** `o.thick` — the blade's TANGENTIAL thickness, metres. */
  thick: number;
  /** `o.baseH` — height added to every fin, and the plinth's height. */
  baseH: number;
  /** `o.sink` — how far the whole assembly is pushed down. */
  sink: number;
  /** `finBaseMat`'s colour — the plinth under the fins (oxidised copper). */
  baseColor: number;
  /**
   * The world's own material for the fins and the plinth (`finMat` /
   * `finBaseMat`). Omit → the unlit `MeshBasicMaterial` every other mesh in this
   * file uses.
   *
   * It comes from the STYLE, not from here, because a lit material needs that
   * world's `gradientMap` and §3.8 says the shelf is the world's — a ring
   * builder that mints a toon material would be minting it out of nowhere.
   *
   * ⚠ Lighting the fins is a decision with a measured cost: every face of a fin
   * except its small top cap is VERTICAL, so under a high sun `N·L` collapses
   * and the ring darkens toward the horizon. That is exactly what `buildStrip`'s
   * note calls 「山裡冒出黑線」. The demo does it anyway (its `finMat` is
   * `toon()`), its sun is pinned at 47.4°, and ours is not.
   */
  material?(color: number, opts: { side: THREE.Side; fog: boolean }): THREE.Material;
}

/**
 * The optional half of the strategy interface this file adds.
 *
 * Structural, and declared HERE rather than on `TerrainStyleStrategy`, for the
 * same reason `PartShape` is an open string: the fins are one world's shape, and
 * a ring builder that has to know about them by name is a ring builder every
 * future world has to answer. A style that does not declare the hook gets the
 * curtain, byte for byte, with no branch taken anywhere near it.
 */
export interface FinnedMountainRingStyle {
  /**
   * The fins for one ring, or `null`/omitted for the curtain.
   *
   * @param radius     That ring's radius in scene metres (the fins' INNER face).
   * @param maxHeight  That ring's height scale — what `profile` 1.0 means.
   */
  mountainRingFins?(
    layer: MountainLayer,
    radius: number,
    maxHeight: number,
  ): MountainRingFins | null;
}

/**
 * NO SHADOW FLAGS ON ANYTHING IN THIS FILE, and that is a recorded divergence
 * rather than an omission.
 *
 * The circuit demo opens two the port does not: `heatsinkRing` sets
 * `inst.castShadow = true` on the fin batch, and its ESD-bag ground disc sets
 * `esdMat.receiveShadow = true` (the paper demo's blueprint desk does too;
 * plastic's toy mat does neither — the demos disagree three ways here).
 *
 * They are ported as OFF because out here they cannot do anything. The sun's
 * shadow camera is orthographic, ±`SHADOW_HALF_EXTENT` (180 m) across and
 * ±(`SHADOW_FAR` − `SHADOW_NEAR`)/2 (460 m) deep, so the furthest a point can be
 * from the rider and still land inside it is the box's circumradius, 526 m —
 * independent of sun elevation, because the box rotates with the light and its
 * circumradius does not. The rings are at 1700 and 2600 m: 3.2× and 4.9× past
 * it, so `castShadow` would render the whole horizon into the depth pass every
 * frame — unconditionally, since these meshes are `frustumCulled = false` — for
 * zero texels. And `day-night-lighting.ts` already names dragging the ring into
 * the depth pass as a thing to avoid when it explains why the box is not scaled.
 *
 * ⚠ RE-CONFIRMED AFTER THE FIN PORT, because the bill changed and the reason
 * did not. The curtain sent 322 vertices per ring; circuit's fin ring is an
 * `InstancedMesh` of 168 (near) / 140 (far) boxes over one 24-vertex unit cube,
 * so `castShadow` there would be 308 instanced draws of 12 triangles apiece plus
 * two 64-segment cylinders — MORE work than the curtain, for the same zero
 * texels. The distance argument is unchanged: the nearest fin vertex is still at
 * the ring's own radius. `[mountain ring vs demo]` measures both the reach and
 * the instance count so neither half can rot.
 *
 * The disc's inner rim is `corridorHalfWidth + DISC_INNER_MARGIN`, which at the
 * shipped `viewRange` of 500 m is 540 m — also past 526. It is NOT past it at
 * the settings slider's minimum of 100 m, where the corridor stops before the
 * shadow box does; that is the boundary of this divergence and the check asserts
 * both halves of it, so the note cannot quietly rot. Turning `receiveShadow` on
 * to cover that case would put the PCF path on a 4 km disc — the single largest
 * fill in the frame, on the machine whose sparse routes are fill-rate bound.
 */

/**
 * How far the rings' skirts drop below the rider, so no gap ever shows.
 *
 * THE THREE DEMOS EACH WROTE A NUMBER HERE AND NONE OF THE THREE IS PORTABLE.
 * They are, executed rather than transcribed (`[mountain ring vs demo]` runs the
 * demos' own builders and reads the minimum y back out):
 *
 *   paper     `inkRidge`          `yBase = -40`      rings at R 400 / 640
 *   plastic   `blockMountainRing` `pos.push(x,-14,z)` rings at R 420 / 600
 *   circuit   `heatsinkRing`      plinth bottom `-1.5·sink`  → −21 (R 380) / −27 (R 620)
 *
 * Scaled to these radii by the ratio this file already uses for every other demo
 * length, that is 57–170 m. It was measured before being rejected, with the
 * demos themselves as the instrument: all three demos were run on real DEM
 * (`?loc=alpedhuez`, 1449 m of relief; `?loc=amalfi`, a 0→1126 m sea cliff) and
 * every below-horizon direction was ray-cast for a hole. **Zero holes, 18
 * configurations.** So the demos' skirts do work — until you take one thing away:
 *
 * > Remove each demo's ground disc — the blueprint desk / toy mat / ESD bag, a
 * > FULL `CircleGeometry(1000)` pinned 0.3–9.6 m under the rider — and all three
 * > demos leak sky at depressions of 3.3°–38°. Plugging that with the curtain
 * > alone would need 306–338 m at the demos' own radii, i.e. 8–24× what they wrote.
 *
 * In other words the demos' skirts are never load-bearing: their ground disc
 * plugs the horizon before the curtain is reached, and `yBase = -40` only has to
 * clear a desk 0.3 m down. GAMEVIEW HAS NO SUCH DISC. Its horizon disc is an
 * ANNULUS starting at `corridorHalfWidth + DISC_INNER_MARGIN` (540 m at the
 * shipped view range) precisely so it can never slice the corridor — so every ray
 * steeper than `atan((DISC_DROP + eye) / 540)` ≈ 4.4° dives through the hole and
 * the curtain is the only thing left. On a hillside that falls away faster than
 * that (any real mountain road), a demo-depth skirt is a band of sky under the
 * range roughly 9° tall.
 *
 * So this stays one number for all three worlds, deeper than all six of theirs,
 * and that is a RECORDED DIVERGENCE rather than a value nobody ported. What the
 * check pins is the demos' half of it: the drop, as a fraction of the ring's own
 * radius, must be at least the deepest of the six — read out of the demos by
 * running them, so a demo that changes its mind moves the floor.
 */
const SKIRT_DROP = 400;

/**
 * The horizon disc sits this far below the rider's ground — the step down from
 * the diorama's baseboard to the desk it stands on (the demos use ~10 m below a
 * 65 m half-board; the game's corridor is far wider, so the step is bigger).
 */
const DISC_DROP = 35;

/** Clearance between the terrain corridor's edge and the disc's inner rim. */
const DISC_INNER_MARGIN = 40;

/** Disc outer radius: past the far ring, inside the sky dome (scaled 4500). */
const DISC_OUTER_RADIUS = 4000;

/** Fallback corridor half-width when the caller doesn't pass one (config default). */
const DEFAULT_CORRIDOR_HALF_WIDTH = 500;

/**
 * Live diagnostic: hide the distant mountain silhouette ring.
 *
 * The ring is anchored to the RIDER (near ring ~1700 m radius, far ~2600 m,
 * extending ~400 m below ground). The constructor comment reasons only about
 * the corridor's 500 m LATERAL half-width — but the route is 45 km long and
 * chunks stream in kilometres ahead and behind, so the ring is routinely drawn
 * straight through real terrain. Where a hillside is tall enough to reach it,
 * slivers of silhouette surface through the slope; because the ring translates
 * with the rider, the pattern shifts every metre you move.
 */
const ringMeshes = new Set<THREE.Object3D>();
let ringVisible = true;

function trackRingMesh(mesh: THREE.Object3D): void {
  ringMeshes.add(mesh);
  mesh.visible = ringVisible;
}

export function setMountainRingVisible(visible: boolean): void {
  ringVisible = visible;
  for (const m of ringMeshes) m.visible = visible;
}

export function getMountainRingVisible(): boolean {
  return ringVisible;
}

/**
 * Rewrite a flat (x, z) geometry's UVs to SCENE METRES.
 *
 * `RingGeometry` maps its UVs to 0..1 across the bounding square, which for this
 * disc means one texture stretched over 8 km — useless for a tiled surface, and
 * worse, the tile size would then depend on `DISC_OUTER_RADIUS` instead of on
 * what the style asked for. In metres, a style sets `repeat = 1 / tile-metres`
 * and gets a tile that size on the ground, which is the same contract the
 * landuse overlays (ShapeGeometry, already metric) and paper's crayon shader
 * already work to. One convention, not two.
 *
 * Exact, not approximate: UV is a linear function of position here and position
 * interpolates linearly across a triangle, so the 64 long radial quads sample
 * the texture with no distortion at all.
 */
function setMetreUVs(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i);
    uv[i * 2 + 1] = pos.getZ(i);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class MountainRing {
  private readonly scene: THREE.Scene;
  private readonly seed: number;
  private readonly discInnerRadius: number;

  /**
   * Every ring sub-mesh, both layers. A ring is 1 or 2 meshes (curtain wash plus
   * the ridge ink line if the style draws one; or the fin batch plus its
   * plinth), so they are held flat rather than as `near` / `far` fields —
   * `update()` moves all of them the same way and `disposeMeshes()` frees all of
   * them the same way, and a list cannot grow a case that forgets one.
   */
  private rings: THREE.Mesh[] = [];
  private disc: THREE.Mesh | null = null;

  /**
   * @param seed  Skyline seed — randomise once per session (same as the 2D
   *              `mountainSeed`) so every ride gets its own horizon.
   * @param corridorHalfWidth  The terrain corridor's half-width; the disc starts
   *              beyond it so it never overlaps real terrain.
   */
  constructor(
    scene: THREE.Scene,
    strategy: TerrainStyleStrategy,
    seed: number,
    corridorHalfWidth = DEFAULT_CORRIDOR_HALF_WIDTH,
  ) {
    this.scene = scene;
    this.seed = seed;
    this.discInnerRadius = Math.min(
      corridorHalfWidth + DISC_INNER_MARGIN,
      DISC_OUTER_RADIUS - 100,
    );
    this.build(strategy);
  }

  /** Rebuild both rings + disc for a new style (world-style switch). */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.disposeMeshes();
    this.build(strategy);
  }

  private build(strategy: TerrainStyleStrategy): void {
    // Far first, near second — draw order only, but it keeps the two rings in
    // the same order the demo adds them (`mountGroup.add(far…, near…)`).
    this.rings = [
      ...this.buildRing(strategy, 'far', FAR_RADIUS, FAR_MAX_HEIGHT, this.seed),
      ...this.buildRing(strategy, 'near', NEAR_RADIUS, NEAR_MAX_HEIGHT, this.seed ^ 0x5f3759df),
    ];
    for (const mesh of this.rings) {
      this.scene.add(mesh);
      trackRingMesh(mesh);
    }

    // Annulus, not a full circle: the hole is where the terrain corridor lives,
    // so the disc can never be drawn on top of the ground the rider is on.
    const discGeo = new THREE.RingGeometry(this.discInnerRadius, DISC_OUTER_RADIUS, 64, 1);
    discGeo.rotateX(-Math.PI / 2);
    setMetreUVs(discGeo);
    // The desk is a real surface, not a fill: `createHorizonMaterial` hands back
    // a cutting mat or a studded baseplate, and only a style that has not
    // declared one falls back to the flat `horizonColor` this used to be.
    //
    // Toon (not Basic) either way, so the desk darkens with the day-night cycle.
    //
    // FRONT-SIDE ONLY, and that matters — the style has to honour it too (the
    // interface says so). This is a 4 km ground plane pinned 35 m under the
    // rider; DoubleSide meant that any time the camera dipped below it — a
    // hillside chunk, a dropped corridor, the finale lift starting low — you got
    // its UNDERSIDE, whose normal points away from the sun, so it shaded to
    // black. Edge-on, a plane's silhouette converges on the horizon, which draws
    // it as a huge black wedge tapering to a point across the whole frame.
    // Single-sided, it simply is not there from below, which is the truth: you
    // are never meant to be under the ground.
    const discMat = strategy.createHorizonMaterial?.() ?? new THREE.MeshToonMaterial({
      color: strategy.horizonColor,
      side: THREE.FrontSide,
    });
    this.disc = new THREE.Mesh(discGeo, discMat);
    this.disc.name = 'mountainRing/disc';
    this.disc.frustumCulled = false;
    this.scene.add(this.disc);
    trackRingMesh(this.disc);
  }

  /**
   * One ring = the wash, plus the ridge ink line if the style draws one — or the
   * demo's heatsink fins, for a style that declares them.
   *
   * The curtain is `inkRidge()` from plan/paper-town-demo.html, which builds the
   * same two strips off one crest:
   *
   *   lp   crest              → crest − lineH     the ink line
   *   wp   crest − lineH      → yBase             the wash
   *
   * with `lineH = o.maxH * 0.035`. A style with no ink line gets one strip from
   * the crest straight down, which is `blockMountainRing()`.
   */
  private buildRing(
    strategy: TerrainStyleStrategy,
    layer: MountainLayer,
    radius: number,
    maxHeight: number,
    seed: number,
  ): THREE.Mesh[] {
    const finish = strategy.mountainRingFinish?.(layer) ?? DEFAULT_RING_FINISH;

    // THE FIN BRANCH IS FIRST AND IT RETURNS, so the curtain below is reached by
    // exactly the styles that were reaching it before. The profile is asked for
    // at the FIN COUNT, not at `SEGMENTS`: for a curtain the segment count is
    // tessellation of a continuous curve, but for the fins the run-length groups
    // in the profile ARE the heatsink plates, so a resolution that is not the
    // fin count would smear each plate's flat top across a fraction of a fin.
    const fins = (strategy as Partial<FinnedMountainRingStyle>)
      .mountainRingFins?.(layer, radius, maxHeight);
    if (fins) {
      return this.buildFinRing(
        radius, maxHeight,
        strategy.generateMountainProfile(layer, seed, fins.fins),
        fins, strategy.mountainColor(layer), finish.fog, layer,
      );
    }

    const profile = strategy.generateMountainProfile(layer, seed, SEGMENTS);
    const crest = (i: number): number => (profile[i] ?? 0) * maxHeight;

    // A zero-thickness band would be a degenerate strip — 160 quads of exactly
    // no area, invisible in every rasteriser and still drawn on the GPU. So the
    // line exists only when the style asked for BOTH a colour and a thickness.
    const lineH = maxHeight * finish.ridgeLineThickness;
    const hasLine = finish.ridgeLineColor !== null && lineH > 0;

    const meshes: THREE.Mesh[] = [];
    if (hasLine) {
      meshes.push(this.buildStrip(
        radius, crest, (i) => crest(i) - lineH,
        finish.ridgeLineColor as number, finish.fog, `${layer}/ridgeLine`,
      ));
    }
    meshes.push(this.buildStrip(
      radius,
      hasLine ? (i) => crest(i) - lineH : crest,
      () => -SKIRT_DROP,
      strategy.mountainColor(layer), finish.fog, layer,
    ));
    return meshes;
  }

  /**
   * One ring of heatsink fins — `heatsinkRing()` from plan/circuit-town-demo.html,
   * copied, with the demo's own names kept (`o`, `u`, `a`, `h`, `m`, `q`, `pos`,
   * `scl`, `up`, `inst`, `baseGeo`, `base`):
   *
   * > 每片鰭片一個 instance,一圈一個 draw call。鰭高沿著環走一圈用「三角峰取
   * > 最大值」生成 —— 取 max 不是相加,相加會把山谷墊高變成一條饅頭。
   *
   * The two loops the demo has that are NOT here are the ones gameview already
   * owns: `mulberry32(o.seed)` + the peaks + the run-length grouping all live in
   * `generateMountainProfile`, where they were ported first and where both
   * renderers (3D here, Phaser 2D) read them from. `profile` arrives holding
   * exactly the demo's `heights` array.
   *
   * THREE THINGS DIVERGE, all three because the demo's world ends where gameview's
   * keeps going:
   *
   *  1. THE PLINTH REACHES THE SKIRT. The demo's base cylinder spans
   *     `−1.5·sink … baseH − sink/2`, which is enough because its board is flat
   *     at y = 0. Gameview's corridor can be hundreds of metres below the rider
   *     the ring is centred on, so the plinth drops to `−SKIRT_DROP` like every
   *     curtain in this file does, for the same reason: no gap may ever show
   *     under the horizon. The TOP is the demo's, untouched.
   *  2. THE Y OFFSET IS BAKED INTO THE GEOMETRY. The demo writes
   *     `base.position.y = …`; here `update()` overwrites `position` with the
   *     rider's every frame, so an offset kept there would be wiped on frame one.
   *     Same numbers, different carrier.
   *  3. ~~UNLIT~~ — **no longer**. The demo's `finMat`/`finBaseMat` are `toon()`
   *     and 2026-07-28 the decision was to follow the demo, so the material now
   *     comes from the style through `MountainRingFins.material`. A style that
   *     omits it still gets the unlit `MeshBasicMaterial` that every other mesh
   *     in this file uses (see `buildStrip` for that measurement), so paper and
   *     plastic are untouched.
   *
   *     ⚠ The cost is real and was measured before the switch: every face of a
   *     fin except its small top cap is VERTICAL, so under a high sun `N·L`
   *     collapses and the ring darkens toward the horizon — 「山裡冒出黑線」.
   *     The demo used to get away with it because its sun was pinned at 47.4°.
   *     It is not any more — the demos now carry a day-phase slider (`?sky`),
   *     and gameview no longer clamps: `MIN_LIGHT_ELEV = 15°` is **gone**, the
   *     key light runs at its real elevation and is faded out below the world's
   *     own `skyKeyFullDeg` instead (`day-night-lighting.ts`). So the fins now
   *     see everything from a Taipei noon past 80° down through 0° — and below
   *     0° the key light is off entirely, which is the one angle at which this
   *     collapse cannot happen.
   *
   * Everything else is the demo's: the box, the `-a` yaw, `(depth, h, thick)`,
   * the `radius + depth/2` centreline, `h/2 − sink`, the 64-segment open-ended
   * cylinder at `radius + depth`, and `castShadow` staying off (see the note at
   * the top of the file, which was re-measured for the instanced case).
   */
  private buildFinRing(
    radius: number,
    maxHeight: number,
    profile: number[],
    o: MountainRingFins,
    color: number,
    fog: boolean,
    layer: MountainLayer,
  ): THREE.Mesh[] {
    // The demo shares ONE module-level `unitBox` across both rings; here each
    // ring owns its own, because `disposeMeshes()` frees every geometry it holds
    // and a shared one would be freed twice (and the second ring left drawing a
    // disposed buffer after a world-style switch).
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const finMat = o.material
      ? o.material(color, { side: THREE.FrontSide, fog })
      : new THREE.MeshBasicMaterial({ color, side: THREE.FrontSide, fog });
    const inst = new THREE.InstancedMesh(unitBox, finMat, o.fins);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < o.fins; i++) {
      const u = i / o.fins;
      const a = u * Math.PI * 2;
      const h = profile[i] * maxHeight + o.baseH;
      pos.set(
        Math.cos(a) * (radius + o.depth / 2),
        h / 2 - o.sink,
        Math.sin(a) * (radius + o.depth / 2),
      );
      q.setFromAxisAngle(up, -a);
      scl.set(o.depth, h, o.thick);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);
    }
    inst.name = `mountainRing/${layer}`;
    inst.frustumCulled = false;

    // 底板:鰭片下面那塊實心的,不然山腳會看穿到天空
    const baseTop = o.baseH - o.sink / 2;      // the demo's cylinder top, exactly
    const baseGeo = new THREE.CylinderGeometry(
      radius + o.depth, radius + o.depth, baseTop + SKIRT_DROP, 64, 1, true);
    baseGeo.translate(0, (baseTop - SKIRT_DROP) / 2, 0);
    const base = new THREE.Mesh(baseGeo, o.material
      ? o.material(o.baseColor, { side: THREE.DoubleSide, fog })
      : new THREE.MeshBasicMaterial({ color: o.baseColor, side: THREE.DoubleSide, fog }));
    // `${layer}Base`, not `${layer}/base`: `layerKeyOf` (debug-layers.ts) groups
    // on the LAST slash, so a second slash would file the plinth under its own
    // row instead of under `mountainRing`.
    base.name = `mountainRing/${layer}Base`;
    base.frustumCulled = false;
    return [inst, base];
  }

  /**
   * One vertical strip of a ring: a quad per segment between two height curves.
   *
   * WINDING IS THE WHOLE THING HERE. The rider is INSIDE the ring, so every face
   * has to point at the centre:
   *
   * > **騎手在環的裡面**,看到的是朝內那一面。[…] 反過來做整圈會被背面剔除掉。
   *
   * `(k, k+2, k+1)` / `(k+1, k+2, k+3)` over `[bottom_i, top_i, bottom_i+1,
   * top_i+1]` is `blockMountainRing`'s index order verbatim, and it is also
   * `inkRidge`'s `(A,B,C)(A,C,D)` soup rotated — same three corners, same cyclic
   * order, so the same orientation. Cross-product on the first triangle comes out
   * as `−H·c·(cos a, 0, sin a)`: straight at the axis. Getting this backwards is
   * invisible in the CPU probe (it does not cull) and deletes the entire horizon
   * in WebGL, which is why `[mountain ring vs demo]` asserts it on the index
   * buffer rather than trusting a render.
   */
  private buildStrip(
    radius: number,
    topAt: (i: number) => number,
    bottomAt: (i: number) => number,
    color: number,
    fog: boolean,
    name: string,
  ): THREE.Mesh {
    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      positions.push(x, bottomAt(i), z);
      positions.push(x, topAt(i), z);
      if (i < SEGMENTS) {
        const k = i * 2;
        indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // UNLIT, deliberately. This ring is a vertical curtain 1.7-2.6 km out: a
    // lit material gives it a normal that is horizontal, so with the sun
    // anywhere near overhead (Taipei noon is ~80 deg) N·L collapses and the
    // whole silhouette renders near-black. Its peaks stick up past the real
    // hills, and those black slivers against the sky were reported for a solid
    // day as "black lines coming out of the mountain".
    //
    // A horizon silhouette should not be shaded at all — real distant ranges
    // read LIGHTER with distance, not darker. Basic gives exactly that and
    // cannot go black no matter what the sun and weather are doing. (The paper
    // demo's `inkMat` is MeshBasicMaterial too; the plastic and circuit demos
    // light theirs, and that is the one place gameview overrules them — their
    // sun never gets near a Taipei zenith.)
    //
    // FOG IS THE STYLE'S CALL, not a constant. It used to be hard `true`, which
    // put the far ring 82% of the way into the haze — a silhouette that had
    // already dissolved into the sky before anything else about it mattered.
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      fog,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // NAME IT. These were once the only unnamed meshes in the scene, so every
    // click/identify reported them as "<unnamed Mesh>" and every bisect skipped
    // them — which is precisely how they stayed hidden through five rounds of
    // hunting the wrong suspect.
    mesh.name = `mountainRing/${name}`;
    // The ring is always centred on the rider — culling it by its (stale)
    // bounding sphere would pop the whole horizon out.
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Follow the rider. Translation only — no rotation — so the two rings drift
   * against each other and read as parallax.
   *
   * @param riderPosition  Rider ground position in scene metres.
   */
  update(riderPosition: THREE.Vector3): void {
    const { x, y, z } = riderPosition;
    for (const mesh of this.rings) mesh.position.set(x, y, z);
    this.disc?.position.set(x, y - DISC_DROP, z);

    // PIN THE DESK TO THE WORLD. The disc translates with the rider (it has to —
    // it is the void filler, and it has to stay under you), and its UVs come
    // from LOCAL position, so without this the grid/studs would ride along and
    // the surface would look perfectly still no matter how fast you went. A desk
    // that moves with you is not a desk. Cancelling the translation in `offset`
    // costs one Vector2 write per frame and nothing on the GPU.
    //
    // `offset` is in repeat units, and `repeat` is 1/tile-metres, so the rider's
    // metres convert with a plain multiply — no need to know the tile size here.
    const map = (this.disc?.material as THREE.Material & { map?: THREE.Texture })?.map;
    if (map) map.offset.set(x * map.repeat.x, z * map.repeat.y);
  }

  private disposeMeshes(): void {
    for (const mesh of [...this.rings, this.disc]) {
      if (!mesh) continue;
      ringMeshes.delete(mesh);
      this.scene.remove(mesh);
      // An InstancedMesh owns a second GPU buffer (`instanceMatrix`) that
      // `geometry.dispose()` does not reach — three frees it from the mesh's own
      // `dispose()`. A fin ring is rebuilt on every world-style switch, so
      // skipping this leaks one matrix buffer per switch.
      const instanced = mesh as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) instanced.dispose();
      mesh.geometry.dispose();
      const material = mesh.material as THREE.Material;
      // The ring owns its materials (the styles hand back fresh ones), but honour
      // the repo-wide `shared` tag anyway: a future style that returns a singleton
      // desk would otherwise have it freed underneath it by a style switch, and
      // the symptom — a black horizon after the second switch — points nowhere
      // near here. Disposing a material never touches its `map`, so a style's
      // cached texture survives this and is freed by `strategy.dispose()`.
      if (!material.userData.shared) material.dispose();
    }
    this.rings = [];
    this.disc = null;
  }

  dispose(): void {
    this.disposeMeshes();
  }
}
