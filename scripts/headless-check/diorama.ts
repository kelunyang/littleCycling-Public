/**
 * Headless check for the third-person diorama world — `npm run check:3d`.
 *
 * Runs the real strategy + prop code under Node with a stubbed 2D canvas (the
 * procedural CanvasTextures only ever WRITE to the context, never read it back
 * except via getImageData, which the stub serves). No WebGL is involved: this
 * exercises geometry, materials, the scene graph, and the camera/yaw maths —
 * the parts neither `vue-tsc` nor a bundle can catch, and the ones the demos'
 * documented pitfalls live in (extrusion direction, ring winding, parallax
 * anchoring, sky-vs-horizon draw order).
 *
 * Runs in WSL, where the Windows-installed esbuild/rollup binaries can't.
 */

import * as THREE from 'three';
// The 2D night checks read the demos' own source: the demo IS the reference for
// what night looks like, so an assertion against a copied constant would just
// re-encode whatever we happened to type.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ── Canvas stub (must exist before any style module runs) ──
// 整個 harness 共用**一份**會錄筆觸的 canvas stub。理由寫在那個模組裡:模組層的
// 貼圖快取是按寬度收的,所以第一個畫某個寬度的檢查決定了所有人拿到的畫布 ——
// 這裡如果裝一份不會錄的,後面任何想看筆觸的檢查都拿不到。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const { checkThemeMusicVsDemo } = await import('./music-vs-demo.ts');
const { createPaperTerrainStyle } = await import('@/game/terrain/paper-terrain-style');
const { createPlasticTerrainStyle } = await import('@/game/terrain/plastic-terrain-style');
const { createCircuitTerrainStyle } = await import('@/game/terrain/circuit-terrain-style');
const { MountainRing, MOUNTAIN_FAR_RADIUS, FAR_RING_CREST_DEG, NEAR_RING_CREST_DEG } =
  await import('@/game/terrain/mountain-ring');
const { CHUNK_LENGTH, CHUNKS_AHEAD } = await import('@/game/terrain/terrain-chunk-manager');
type CelestialState = import('@/game/terrain/sun-moon-calc').CelestialState;
const { BikeOrnament, disposeGroup } = await import('@/game/terrain/bike-ornament');
const { StreetLampManager } = await import('@/game/terrain/street-lamp');
const { updateFpsCamera, chaseFrameTopElevationDeg } = await import('@/game/terrain/fps-camera');
const { createRouteLine, projectRouteLineOntoTerrain, disposeRouteLine, BLOOM_LAYER } =
  await import('@/game/terrain/route-line-mesh');
const {
  computeDayNightLighting, TONE_MAPPING_EXPOSURE, nightFactorFromElevation,
  SHADOW_MAP_SIZE, SHADOW_HALF_EXTENT, SHADOW_NEAR, SHADOW_FAR, SHADOW_BIAS,
  SHADOW_NORMAL_BIAS, SHADOW_VERTICAL_REACH, SHADOW_LIGHT_DISTANCE, shadowDepthOf,
  skyKeyFullDeg, skyKeyGainAt, nightKeyFloorGain,
} = await import('@/game/terrain/day-night-lighting');
const { SkyAndFog, MOON_DISTANCE } =
  await import('@/game/terrain/sky-and-fog');
const { GradientSky } = await import('@/game/terrain/gradient-sky');
const {
  DEFAULT_FOV, CAMERA_NEAR, CAMERA_FAR, configureSunShadow, applySunShadowLevel, anchorSunShadow,
  SHADOW_MAP_SIZE_BY_LEVEL, GameRenderer,
} = await import('@/game/terrain/game-renderer');
type ShadowLevel = import('@/game/quality/graphics-quality').ShadowLevel;
const { buildTerrainChunk, buildMedialAxisMask, sampleRouteForMask } =
  await import('@/game/terrain/terrain-chunk');
const { buildQuantizedCorridorGeometry } = await import('@/game/terrain/quantized-terrain');
const {
  climbOntoTread: climbOntoTreadFn, noseProbePoint: noseProbePointFn,
} = await import('@/game/terrain/climb-onto-tread');
const { buildRoadMeshes, disposeRoadMesh } = await import('@/game/terrain/road-renderer');
const { buildTreeMeshes, disposeTreeMesh } = await import('@/game/terrain/tree-renderer');
const { OrbitCamera } = await import('@/game/terrain/orbit-camera');
const { CameraGroundClamp, requiredLift, CAMERA_GROUND_MARGIN, CLAMP_MAX_TILT } =
  await import('@/game/terrain/camera-collision');
const { CameraLift, liftWeight, PEEK_RISE, PEEK_HOLD, PEEK_FALL, PEEK_DURATION, FINALE_RISE } =
  await import('@/game/terrain/camera-lift');
const { buildWaterwayMeshes, disposeWaterwayMesh, WATERWAY_HEIGHT_OFFSET } =
  await import('@/game/terrain/waterway-renderer');
const { buildLanduseMeshes, disposeLanduseMeshes } =
  await import('@/game/terrain/landuse-renderer');
const { buildGroundRibbon } = await import('@/game/terrain/ribbon-geometry');
const { ROAD_HEIGHT_OFFSET } = await import('@/game/terrain/road-renderer');
const { ROUTE_HEIGHT_OFFSET } = await import('@/game/terrain/route-line-mesh');
const { buildAerowayMeshes, disposeAerowayMeshes } = await import('@/game/terrain/aeroway-renderer');
const { isEmptyMesh } = await import('@/game/terrain/empty-mesh');
// The 2D classifier. Engine-free (it runs in a Web Worker), so it imports like
// any other pure module — that is the whole point of `water-classes.ts`.
const { classifyFeature } = await import('@/game/terrain/mvt-projection');
const { ZONE_MODIFIERS } = await import('@/game/terrain/cycling-glasses-effect');
// The 2D night grade. Engine-free on purpose (see its header), so it imports
// like any other pure module even though it belongs to the Phaser renderer.
const {
  NIGHT_VEIL, DUSK_START, DUSK_END, LIGHTS_MAX_ALPHA,
  duskRamp, nightLightAlpha, nightVeilAmount, nightVeilRgb, veiledChannel,
} = await import('@/game/phaser/night-grade');
const { ZONE_MODIFIERS_2D } = await import('@/game/phaser/night-grade');
// The 2D styles. Safe to import here: they take Phaser as a TYPE only, so
// nothing pulls the engine in at runtime.
const { createStyleStrategy } = await import('@/game/phaser/phaser-style-strategy');
const { Sink: Sink2D, makeGraphics: makeGraphics2D } = await import('./phaser-stub.mjs');
const { collectFacadeWindowPlacements, buildBuildingMeshes, disposeBuildingMesh } =
  await import('@/game/terrain/building-renderer');
const { applyOverlayDepth, OVERLAY_RANK } = await import('@/game/terrain/overlay-depth');
const { defaultStyleParams, createTerrainStyleStrategy } =
  await import('@/game/terrain/terrain-style-strategy');
const {
  AcrylicCase,
  ACRYLIC_CASE_RADIUS,
  ACRYLIC_CASE_DESK_DROP,
  ACRYLIC_RIM_HEIGHT,
} = await import('@/game/terrain/acrylic-case');
const { SceneBloomPass, isSceneBloomPass } = await import('@/game/terrain/scene-bloom-pass');
const { QUALITY_PRESETS, createQualityGovernor } = await import('@/game/quality/graphics-quality');
// The probes' own scene counter — the cloud checks quote deck costs in the
// same units render-probe and demo-probe report, so the numbers are comparable.
const { census } = await import('./scene-census.mjs');
const { buildGroundStuds, studLevelFor, applyStudLod, studInstances: portStudInstances } =
  await import('@/game/terrain/ground-studs');
// Straight at the SOURCE, not at `@littlecycling/shared`: the package's bare
// specifier resolves to `dist/`, which in a WSL checkout is whatever the last
// `tsc -b` left behind. A check that passes against a stale build of the very
// table it is checking is worse than no check.
const {
  WORLD_OPTIONS,
  resolveWorldOptions,
  sparseWorldOptions,
  withWorldOption,
  worldOptionDefaults,
  worldOptionsFor,
} = await import('../../packages/shared/src/world-options.ts');
// 同理 —— 相機的**出廠 pitch/height** 決定騎士看得到多少天空,而那是 config 的
// 預設值,不是 fps-camera 裡的 DEFAULT_PITCH_DEG(兩者差 18 度,見 fps-camera.ts
// 的 CHASE_NEUTRAL_PITCH 註解)。
const { DEFAULT_CONFIG } = await import('../../packages/shared/src/config.ts');
import type { BoxPart, PartShape, TerrainStyleStrategy } from '@/game/terrain/terrain-style-strategy';
import { mountShopSign } from '@/game/terrain/building-renderer';
import { mulberry32, DEMO_SKY_DOME_RADIUS } from '@/game/terrain/terrain-style-strategy';
// The production factory and the production WorldStyle→TerrainStyle mapping, so
// `checkEveryWorldHasNightLightsAndSigns` reaches a new world exactly the way
// the game does — a second mapping here would be the one thing that keeps
// passing after the real one starts picking a different strategy.
import {
  createTerrainStyleStrategy,
  terrainStyleFromWorldStyle,
} from '@/game/terrain/terrain-style-strategy';
import type { WorldStyle } from '../../packages/shared/src/world-options.ts';
import { setNightLitFactor } from '@/game/terrain/building-lights';
import { ZONE_KINDS, createShuffleBag, pointInRing, zoneFromLanduseClass } from '@/game/terrain/land-zone';
import {
  SIGN_ALPHABET,
  SIGN_GLYPHS,
  SIGN_MAX_CHARS,
  SIGN_RATIO,
  SIGN_TRAINING_WORDS,
  sanitizeSignText,
  segmentSignLabel,
  signContent,
  signStrokes,
} from '@/game/terrain/sign-spec';
import type { SignVocabulary, ZoneKind } from '@/game/terrain/sign-spec';
import type { WindowPlacement } from '@/game/terrain/building-lights';
import type { WeatherType } from '@/game/terrain/sky-and-fog';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function meshCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

function size(root: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(root);
  return box.getSize(new THREE.Vector3());
}

function checkStyle(name: string, strategy: TerrainStyleStrategy): void {
  console.log(`\n[${name}]`);

  // ── Bike ornament ──
  const bike = strategy.buildBikeOrnament();
  const bikeSize = size(bike.root);
  check(
    'bike: built with wheels + crank',
    bike.wheels.length === 2 && bike.crank !== null && meshCount(bike.root) > 8,
    `${meshCount(bike.root)} meshes, ${bike.wheels.length} wheels`,
  );
  check(
    'bike: forward is +x, sane proportions',
    bikeSize.x > bikeSize.z && bikeSize.y > 4 && bikeSize.x > 5,
    `${bikeSize.x.toFixed(1)}×${bikeSize.y.toFixed(1)}×${bikeSize.z.toFixed(1)} m (pre-scale)`,
  );
  check('bike: wheels sit on the ground', bike.wheels.every((w) => w.position.y > 0));

  // ── Mountain profiles ──
  const SEGMENTS = 160;
  for (const layer of ['near', 'far'] as const) {
    const profile = strategy.generateMountainProfile(layer, 4177, SEGMENTS);
    const inRange = profile.every((h) => h >= 0 && h <= 1);
    const distinct = new Set(profile.map((h) => h.toFixed(3))).size;
    check(
      `mountains(${layer}): ${SEGMENTS + 1} samples, 0..1, varied`,
      profile.length === SEGMENTS + 1 && inRange && distinct > 3,
      `${distinct} distinct heights`,
    );
    const repeat = strategy.generateMountainProfile(layer, 4177, SEGMENTS);
    check(
      `mountains(${layer}): deterministic for a seed`,
      repeat.every((h, i) => h === profile[i]),
    );
  }

  // ── Props ──
  const lamp = strategy.buildStreetLamp();
  const lampHasLight = lamp.group.children.some((c) => (c as THREE.PointLight).isPointLight);
  lamp.setNight(1);
  const litLight = lamp.group.children.find(
    (c) => (c as THREE.PointLight).isPointLight,
  ) as THREE.PointLight | undefined;
  check('lamp: has a point light that turns on at night', lampHasLight && (litLight?.intensity ?? 0) > 0);
  lamp.setNight(0);
  check('lamp: light goes out by day', (litLight?.intensity ?? 1) === 0);

  // ── §3.10: a lamp is a small bright thing inside a shell you can see into ──
  // Every world got this wrong the same way first: light the WHOLE shade and
  // push its opacity up at night. The result is a uniformly glowing solid — a
  // colour blob with no visible light source. These three checks are the law.
  const lampMats = new Set<THREE.Material>();
  lamp.group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.Material) lampMats.add(m);
  });
  const shades = [...lampMats].filter((m) => m.transparent && m.opacity > 0.05);
  check('lamp: has a translucent shade at all', shades.length > 0, `${shades.length} translucent`);
  // Night must not make the shade MORE opaque. This is the counter-intuitive
  // one — instinct says "lit = more solid", but a solid shade hides its own bulb.
  lamp.setNight(0);
  const dayOpacity = shades.map((m) => m.opacity);
  lamp.setNight(1);
  const nightOpacity = shades.map((m) => m.opacity);
  check(
    'lamp: the shade does not go more opaque at night',
    nightOpacity.every((o, i) => o <= dayOpacity[i] + 1e-6),
    nightOpacity.map((o, i) => `${dayOpacity[i].toFixed(2)}→${o.toFixed(2)}`).join(' '),
  );
  // A translucent shade that writes depth occludes its own innards, which
  // undoes the whole thing without changing a single colour.
  check(
    'lamp: the shade does not write depth (it would occlude its own bulb)',
    shades.every((m) => m.depthWrite === false),
  );
  // …and something small inside must actually get brighter. Without this the
  // first two checks pass on a lamp that simply never lights up.
  const brightness = (m: THREE.Material): number => {
    const c = (m as THREE.MeshBasicMaterial).color;
    const e = (m as THREE.MeshPhongMaterial).emissive;
    return (c ? c.r + c.g + c.b : 0) + (e ? (e.r + e.g + e.b) * 3 : 0);
  };
  lamp.setNight(0);
  const dayB = [...lampMats].map(brightness);
  lamp.setNight(1);
  const nightB = [...lampMats].map(brightness);
  const litParts = nightB.filter((v, i) => v > dayB[i] + 0.2).length;
  check('lamp: something inside gets brighter at night', litParts > 0, `${litParts} parts light up`);
  lamp.setNight(0);

  const coin = strategy.buildCoinMesh();
  check('coin: mesh with a style detail attached', coin.isMesh && coin.children.length >= 1);

  const flag = strategy.buildCheckpoint('#ff3b8d', 1);
  check('checkpoint: pole + flag built', meshCount(flag) >= 3, `${meshCount(flag)} meshes`);

  // ── Signs that carry text ─────────────────────────────────────────────────
  // A labelled checkpoint must actually gain geometry. This is the check that
  // would have caught "the label silently did nothing", which is exactly how a
  // sign fails: no error, no warning, just a blank plate nobody notices.
  const labelled = strategy.buildCheckpoint('#ff3b8d', 1, 'MID');
  check(
    'checkpoint: a label adds meshes to the flag',
    meshCount(labelled) > meshCount(flag),
    `${meshCount(flag)} → ${meshCount(labelled)} meshes`,
  );

  // ── Seam glows: a building can light along an edge, not just at windows ──
  // The corrugated world's eraser glows along the plastic film over its paper
  // sleeve; the circuit world's capacitor glows round its crimp groove. Neither
  // is a window. This guards the plumbing: a style registers the material once,
  // one global write per frame drives it, and a style swap must let go of it.
  let residentialSeamGlow = false;
  {
    const deco = strategy.buildBuildingDecoration(
      { cx: 0, cz: 0, width: 14, depth: 10, rotY: 0, height: 9, baseY: 0, skirt: 1.5, color: 0xcccccc },
      3, 'residential',
    );
    const seam: THREE.Material[] = [];
    deco?.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m instanceof THREE.Material && (m as THREE.MeshPhongMaterial).emissive) seam.push(m);
    });
    if (seam.length) {
      setNightLitFactor(0);
      const dark = seam.map((m) => (m as THREE.MeshPhongMaterial).emissive.getHex());
      setNightLitFactor(1);
      const lit = seam.map((m) => (m as THREE.MeshPhongMaterial).emissive.getHex());
      residentialSeamGlow = lit.some((h, i) => h !== dark[i]);
      check('seam glow: something on the building lights up at night',
        residentialSeamGlow,
        `${lit.filter((h, i) => h !== dark[i]).length}/${seam.length} materials`);
      setNightLitFactor(0);
    }
  }

  // ── Building lights belong to the building ──
  // The rule this guards (DEVPLAN): whatever decided the SHAPE must decide the
  // LIGHTS. The generic facade grid takes a bounding box and stamps the same
  // rectangle onto every theme in the world — thirteen forms, one window
  // pattern, and every bit of vocabulary the shapes carry is flattened.
  if (strategy.buildBuildingLights) {
    const lbox = {
      cx: 0, cz: 0, width: 16, depth: 12, rotY: 0,
      height: 24, baseY: 0, skirt: 1.5, color: 0xcccccc,
    };
    const res = strategy.buildBuildingLights(lbox, 5, 'residential');
    // "Lit SOMEHOW", not "has window placements". The corrugated world's
    // residential building is an eraser: DEVPLAN lists it among the buildings
    // whose honest answer is the empty array, and its night light is the seam
    // glow round its plastic film (asserted immediately above). Demanding
    // placements here encoded the toy world's answer as if it were the rule,
    // and would have been satisfied by faking window quads onto an eraser —
    // exactly the "windows on a shape that has no business having them" this
    // whole mechanism exists to prevent.
    check('lights: a residential block is lit somehow',
      res.length > 0 || residentialSeamGlow,
      res.length > 0 ? `${res.length} windows` : 'seam glow');
    // Empty is a REAL answer, not a missing implementation — that distinction
    // is the whole reason the hook returns an array instead of being omitted.
    const ind = strategy.buildBuildingLights(lbox, 5, 'industrial');
    check('lights: a zone may legitimately have none', ind.length === 0, `${ind.length}`);
    // Deterministic: a building that re-lit itself on every chunk reload would
    // flicker as the rider passes back and forth over a chunk seam.
    check('lights: stable for a given seed',
      JSON.stringify(strategy.buildBuildingLights(lbox, 5, 'residential')) === JSON.stringify(res));
    // …and they must sit ON the walls. A window floating inside the body is
    // invisible; one floating outside reads as a hovering sprite.
    // Two bounds, both deliberately loose, because the tower legitimately
    // breaks the box in two directions: slabs are EJECTED sideways as an
    // overhang, and whatever was pulled out gets RESTACKED on the roof — so a
    // window can sit above `height` too. Bounding at the box would fail on
    // exactly the buildings that look best.
    // The bound has to allow for a slab EJECTED from the stack: the toy tower
    // pulls middle slabs out by up to 3.2 m as an overhang, and a window on the
    // end of a pulled slab legitimately sits that far past the box. Bounding at
    // the plain half-diagonal fails on exactly the buildings that look best.
    const MAX_OVERHANG = 3.2;
    const halfSpan = Math.hypot(lbox.width, lbox.depth) / 2 + MAX_OVERHANG + 0.5;
    check('lights: every window is on the box, not floating',
      res.every((w) => Math.hypot(w.x, w.z) <= halfSpan && w.y > 0 && w.y < lbox.height * 2),
      `reach ${Math.max(...res.map((w) => Math.hypot(w.x, w.z))).toFixed(1)} ≤ ${halfSpan.toFixed(1)}, `
        + `top ${Math.max(...res.map((w) => w.y)).toFixed(1)} ≤ ${(lbox.height * 2).toFixed(1)}`);
    // Deciding WHICH windows are lit must not perturb the shape — they read
    // different RNG streams from the same seed.
    const geoA = strategy.buildBuildingBody?.(lbox, 5, 'residential');
    strategy.buildBuildingLights(lbox, 5, 'commercial');
    const geoB = strategy.buildBuildingBody?.(lbox, 5, 'residential');
    check('lights: asking for them does not re-roll the shape',
      geoA?.attributes.position.count === geoB?.attributes.position.count,
      `${geoA?.attributes.position.count} = ${geoB?.attributes.position.count}`);
    geoA?.dispose();
    geoB?.dispose();
  }

  const shop = strategy.buildSign?.('shop', 'DELI', 8, { zone: 'commercial', seed: 3 });
  check('sign: a shop sign is built', !!shop, shop ? `${shop.width.toFixed(1)} m wide` : 'none');
  if (shop) {
    check(
      'sign: keeps the shared 3:1 proportion',
      Math.abs(shop.width / shop.height - SIGN_RATIO) < 1e-6,
      `${(shop.width / shop.height).toFixed(3)}:1`,
    );
    // Thin cards vanish: the chase eye is 6.3 m up, so a plate seen edge-on has
    // almost no area. Every carrier has to have real thickness.
    const bb = new THREE.Box3().setFromObject(shop.group);
    const size = bb.getSize(new THREE.Vector3());
    check('sign: has real thickness (thin cards disappear edge-on)', size.z >= 0.3,
      `${size.z.toFixed(2)} m`);
    check('sign: fits the width it was given', shop.width <= 8 + 1e-6,
      `${shop.width.toFixed(2)} ≤ 8`);
    // Shop signs share their materials — a chunk holds dozens, and one material
    // each is how a street of shops costs more than the buildings under it.
    const mats = new Set<THREE.Material>();
    shop.group.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m instanceof THREE.Material) mats.add(m);
    });
    check('sign: shop materials are strategy-owned singletons',
      [...mats].every((m) => m.userData.shared === true), `${mats.size} materials`);
    shop.dispose();
  }
  // …but a CHECKPOINT's are its own, because CheckpointFlagManager fades a
  // passed flag by writing opacity onto every material it can reach.
  const cpSign = strategy.buildSign?.('checkpoint', 'GO', 5);
  if (cpSign) {
    const mats = new Set<THREE.Material>();
    cpSign.group.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m instanceof THREE.Material) mats.add(m);
    });
    check('sign: checkpoint materials are NOT shared (fading one must not fade all)',
      [...mats].every((m) => m.userData.shared !== true), `${mats.size} materials`);
    cpSign.dispose();
  }
  check('sign: unwritable text yields no sign, not a blank plate',
    strategy.buildSign?.('shop', '你好', 8, { zone: 'commercial' }) === null);
  const hospital = strategy.buildSign?.('shop', '', 8, { zone: 'hospital', symbol: 'triangle' });
  check('sign: the hospital mark builds without any text', !!hospital);
  hospital?.dispose();

  const tree = strategy.buildTreeGeometry?.();
  check(
    'tree: geometry has positions',
    !!tree && tree.attributes.position.count > 0,
    `${tree?.attributes.position.count ?? 0} verts`,
  );

  // ── Building body (matchbox) + decoration ──
  const box = {
    cx: 120, cz: -80, width: 18, depth: 12, rotY: 0.4,
    height: 9, baseY: 3, skirt: 3, color: 0xff3b8d,
  };

  // The body comes back in the box's LOCAL frame: centred in x/z, spanning
  // −skirt…height in y. Getting that frame wrong buries a whole city or floats
  // it, so pin the contract here rather than in the renderer.
  const body = strategy.buildBuildingBody?.(box, 3);
  check('building body: matchbox geometry built', !!body && body.attributes.position.count > 0,
    `${body?.attributes.position.count ?? 0} verts`);
  if (body) {
    body.computeBoundingBox();
    const bb = body.boundingBox!;
    // The base is exact — a body that does not start at −skirt either floats or
    // buries the building. The TOP is allowed to fall a little short: the eraser
    // rakes its worn end down, and the brick stack loses half a seam off the top
    // slab. Overshooting the top is still a bug (it would punch through the roof
    // trim), hence the one-sided tolerance.
    check(
      'building body: sits on the LOCAL frame, base at −skirt (not pre-placed)',
      Math.abs(bb.min.y + box.skirt) < 0.05
        && bb.max.y > box.height - 2 && bb.max.y <= box.height * 1.4 + 0.05,
      `y ${bb.min.y.toFixed(2)} … ${bb.max.y.toFixed(2)} (want ${-box.skirt} … ~${box.height})`,
    );
    // Roughly centred on the footprint. Not exactly, and not strictly inside it:
    // the brick stack ejects a slab sideways on purpose, so allow an overhang
    // while still catching a body built at the wrong scale or off-origin.
    check(
      'building body: centred on the footprint, overhang bounded',
      Math.abs(bb.min.x + bb.max.x) < box.width * 0.5
        && Math.abs(bb.min.z + bb.max.z) < box.depth * 0.5
        && bb.max.x - bb.min.x <= box.width * 1.6
        && bb.max.z - bb.min.z <= box.depth * 1.6,
      `${(bb.max.x - bb.min.x).toFixed(2)} × ${(bb.max.z - bb.min.z).toFixed(2)} (box ${box.width} × ${box.depth})`,
    );
    body.dispose();
  }

  // Trim is optional: a style whose BODY already carries the whole design (the
  // brick stack's slabs and slots) legitimately has nothing to bolt on.
  const trim = strategy.buildBuildingDecoration(box, 3);
  if (!body) {
    check('building trim: built', !!trim && meshCount(trim!) >= 1,
      `${trim ? meshCount(trim) : 0} meshes`);
  }
  if (trim) {
    const b = new THREE.Box3().setFromObject(trim);
    // Trim either CAPS the block (plastic's studs) or WRAPS it (cuphead's
    // eraser sleeve). Both must touch the body: floating above the roof or
    // sinking under the base is the demo pitfall this guards.
    check(
      'building trim: sits on the block, not floating off it',
      b.min.y >= box.baseY - 0.5 && b.max.y <= box.baseY + box.height + 8,
      `trim y=${b.min.y.toFixed(1)}…${b.max.y.toFixed(1)}, block y=${box.baseY}…${(box.baseY + box.height).toFixed(1)}`,
    );
    check('building trim: placed at the footprint', Math.abs(trim.position.x - box.cx) < 0.01);
  }

  // ── Ground-overlay depth ordering ──
  // Every decal laid on the terrain must carry a DISTINCT polygonOffset, or it
  // z-fights the ground (and its neighbours) as soon as the depth buffer runs
  // out of precision — which on this camera starts a few hundred metres out.
  // Metric height offsets alone cannot fix that; see overlay-depth.ts.
  {
    const ranks = Object.entries(OVERLAY_RANK).sort((a, b) => a[1] - b[1]);
    const distinct = new Set(ranks.map(([, r]) => r)).size === ranks.length;
    check('overlay depth: every ground decal has its own rank', distinct,
      ranks.map(([k, r]) => `${k}=${r}`).join(' '));

    const probe = new THREE.MeshBasicMaterial();
    applyOverlayDepth(probe, 'road');
    check(
      'overlay depth: applying a rank sets a NEGATIVE offset (pulled toward the camera)',
      probe.polygonOffset === true && probe.polygonOffsetFactor < 0 && probe.polygonOffsetUnits < 0,
      `factor=${probe.polygonOffsetFactor} units=${probe.polygonOffsetUnits}`,
    );

    // The two orderings must agree: a layer that sits higher in metres must
    // also win the depth tiebreak, or which one shows depends on distance.
    const a = new THREE.MeshBasicMaterial();
    const b = new THREE.MeshBasicMaterial();
    applyOverlayDepth(a, 'urban');   // lowest metric offset (0.02 m)
    applyOverlayDepth(b, 'routeCore'); // highest (0.45 m)
    check(
      'overlay depth: rank order matches the metric-offset order',
      b.polygonOffsetUnits < a.polygonOffsetUnits,
      `urban=${a.polygonOffsetUnits} routeCore=${b.polygonOffsetUnits}`,
    );
    probe.dispose(); a.dispose(); b.dispose();
  }

  // ── Facade windows (data-driven: the building renderer grids + batches) ──
  // A style with no facadeWindows group legitimately has no windows — skip.
  const wins: WindowPlacement[] = [];
  if (strategy.facadeWindows) {
    collectFacadeWindowPlacements(box, 3, strategy.facadeWindows, wins);
    check('windows: collected as instance placements', wins.length > 0, `${wins.length} windows`);

    const tpl = strategy.facadeWindows.createTemplate();
    check(
      'windows: template is a geometry + a SHARED material (the chunk frees the geometry, never the material)',
      tpl.geometry.attributes.position.count > 0 && tpl.material.userData.shared === true,
    );
    tpl.geometry.dispose();
  }

  if (wins.length > 0) {
    // Placements are in SCENE space, so the box's rotation has to be baked in by
    // hand — get the sign wrong and every window in a rotated building ends up
    // buried in the walls. Un-rotate them and they must land back on the faces.
    const c = Math.cos(box.rotY);
    const s = Math.sin(box.rotY);
    const onFaces = wins.every((w) => {
      const ox = w.x - box.cx;
      const oz = w.z - box.cz;
      const lx = ox * c - oz * s;
      const lz = ox * s + oz * c;
      return (
        Math.abs(Math.abs(lz) - box.depth / 2) < 0.5 &&   // proud of a long face
        Math.abs(lx) <= box.width / 2 &&                  // within the wall
        w.y > box.baseY && w.y < box.baseY + box.height   // between floor and roof
      );
    });
    check('windows: un-rotate back onto the box faces (rotY is baked into the placement)', onFaces);
  }

  // ── Road material carries the dash texture ──
  const roadMat = strategy.createRoadMaterial(0x3a3a3a) as THREE.MeshPhongMaterial;
  check('road: material has a texture map (dashes/tape)', !!roadMat.map);

  // ── Ground overlays for the newly-adopted landuse classes ──
  const wetland = strategy.createWetlandMaterial() as THREE.MeshBasicMaterial;
  const farmland = strategy.createFarmlandMaterial() as THREE.MeshBasicMaterial;
  const sports = strategy.createSportsFieldMaterial() as THREE.MeshBasicMaterial;
  check(
    'wetland: paper gets marsh texture / plastic gets a translucent jelly brick',
    strategy.style === 'paper' ? !!wetland.map : (wetland.transparent && wetland.opacity < 1),
  );
  for (const [name, mat] of [['farmland', farmland], ['sports field', sports]] as const) {
    check(
      `${name}: textured and tileable (ShapeGeometry UVs are metres)`,
      !!mat.map && mat.map.wrapS === THREE.RepeatWrapping && mat.map.repeat.x < 1,
      mat.map ? `1 tile = ${(1 / mat.map.repeat.x).toFixed(0)} m` : 'NO MAP',
    );
  }
  // Each overlay must keep its OWN tile — paper's crayonize() replaces mat.map
  // with a shared shading mask, and it once ate all three of these silently.
  check(
    'overlays keep distinct textures (crayonize must not overwrite them)',
    farmland.map !== sports.map && (strategy.style !== 'paper' || wetland.map !== farmland.map),
  );
  for (const m of [wetland, farmland, sports]) {
    check(
      `${(m === wetland ? 'wetland' : m === farmland ? 'farmland' : 'sports')}: polygon-offset lifted off the terrain (no z-fighting)`,
      m.polygonOffset === true,
    );
    m.dispose();
  }

  // ── Zone decal: the translucent district wash ──
  //
  // The map has always said what a district is FOR; the ground has never shown
  // it. Eleven landuse classes arrive, `URBAN_COLORS` had four keys, and the
  // seven that were not in it — every school, hospital, campus and library —
  // came out residential grey (land-zone.ts opens with this complaint).
  const zoneColors = ZONE_KINDS.map((z) => strategy.zoneDecalColor(z));
  check(
    'zone decal: five districts get five distinct colours',
    new Set(zoneColors).size === ZONE_KINDS.length,
    zoneColors.map((c) => `#${c.toString(16).padStart(6, '0')}`).join(' '),
  );
  const decalMat = strategy.createZoneDecalMaterial() as THREE.MeshToonMaterial;
  check(
    'zone decal: ONE material carries all five zones (vertexColors), so the layer count cannot grow',
    decalMat.vertexColors === true,
  );
  check(
    'zone decal: translucent wash, polygon-offset onto the ground (the demos: a 0.02 m lift alone z-fights into noise at distance)',
    decalMat.transparent === true && decalMat.opacity < 1 && decalMat.polygonOffset === true,
    `opacity ${decalMat.opacity}`,
  );
  decalMat.dispose();

  // ── The desk the whole diorama stands on ──
  //
  // This used to be `horizonColor` and nothing else: a flat fill 4 km across.
  // In the demos it is the TOOL the model is built on — a green cutting mat, a
  // studded baseplate — and the pattern is the entire reason it reads as one.
  const horizonMat = strategy.createHorizonMaterial?.() as THREE.MeshToonMaterial | undefined;
  check('horizon surface: described as a material, not just a colour', !!horizonMat);
  check(
    'horizon surface: tiled texture sized in ground metres (mountain-ring hands it metric UVs)',
    !!horizonMat?.map && horizonMat.map.wrapS === THREE.RepeatWrapping && horizonMat.map.repeat.x < 1,
    horizonMat?.map ? `1 tile = ${(1 / horizonMat.map.repeat.x).toFixed(0)} m` : 'NO MAP',
  );
  check(
    'horizon surface: FRONT side only — a double-sided 4 km plane shades to a black wedge seen from below',
    horizonMat?.side === THREE.FrontSide,
  );
  check(
    'horizon surface: OPAQUE — it is the ground, not one more screen-covering translucent layer',
    horizonMat?.transparent !== true,
  );
  horizonMat?.dispose();

  // ── Plane ornament (aerodromes) ──
  const plane = strategy.buildPlaneOrnament();
  const planeBox = new THREE.Box3().setFromObject(plane);
  const planeSize = planeBox.getSize(new THREE.Vector3());
  check(
    'plane: built from parts, toy-sized',
    meshCount(plane) >= 8 && Math.max(planeSize.x, planeSize.z) > 4 && Math.max(planeSize.x, planeSize.z) < 12,
    `${meshCount(plane)} meshes, ${planeSize.x.toFixed(1)}×${planeSize.y.toFixed(1)}×${planeSize.z.toFixed(1)} m`,
  );
  if (strategy.style === 'paper') {
    check(
      'plane balloon: floats overhead with its tether reaching the ground',
      planeBox.max.y > 10 && planeBox.min.y < 0.5,
      `balloon top ${planeBox.max.y.toFixed(1)} m, anchor ${planeBox.min.y.toFixed(2)} m`,
    );
  } else {
    check(
      'brick plane: parked on the ground, not floating',
      planeBox.min.y < 0.5 && planeBox.max.y < 6,
      `sits ${planeBox.min.y.toFixed(2)}–${planeBox.max.y.toFixed(1)} m`,
    );
  }
  disposeGroup(plane);

  // ── Mountain ring in a scene ──
  const CORRIDOR = 500;
  const scene = new THREE.Scene();
  const ring = new MountainRing(scene, strategy, 12345, CORRIDOR);
  // Two rings + the disc, and one EXTRA strip per ring that draws an ink line —
  // derived from the strategy rather than hard-coded, because "3" was already a
  // check that would have had to be edited to accept a ridge line rather than
  // catching one that went missing.
  const inkStrips = (['near', 'far'] as const)
    .filter((l) => {
      const f = strategy.mountainRingFinish?.(l);
      return !!f && f.ridgeLineColor !== null && f.ridgeLineThickness > 0;
    }).length;
  check(
    `mountain ring: ${3 + inkStrips} objects added (near, far, disc${inkStrips ? `, ${inkStrips} ink line(s)` : ''})`,
    scene.children.length === 3 + inkStrips,
    `${scene.children.length} children`,
  );

  const disc = scene.children.find(
    (c) => (c as THREE.Mesh).geometry?.type === 'RingGeometry',
  ) as THREE.Mesh | undefined;
  const discMat = disc?.material as THREE.Material | undefined;
  check(
    'horizon disc: writes depth, so the sky dome cannot paint over it',
    !!discMat && discMat.depthTest !== false && discMat.depthWrite !== false,
  );
  // The disc must be an annulus that clears the terrain corridor, or it would
  // slice through the ground the rider is on when descending into a valley.
  const discBox = new THREE.Box3().setFromObject(disc!);
  const inner = (disc!.geometry as THREE.RingGeometry).parameters.innerRadius;
  check(
    'horizon disc: annulus starts beyond the terrain corridor',
    inner > CORRIDOR && discBox.max.x > 2000,
    `inner=${inner}m vs corridor=${CORRIDOR}m`,
  );
  // RingGeometry's own UVs run 0..1 over the bounding square, i.e. one texture
  // stretched over 8 km, and the tile size would then depend on the disc's
  // radius instead of on what the style asked for. Metres is the convention
  // every other flat surface here already uses.
  const discUV = disc!.geometry.getAttribute('uv');
  const discPos = disc!.geometry.getAttribute('position');
  check(
    'horizon disc: UVs are SCENE METRES, so a style\'s 1/tile repeat means tile metres',
    !!discUV && [0, 1, discPos.count - 1].every(
      (i) => discUV.getX(i) === discPos.getX(i) && discUV.getY(i) === discPos.getZ(i),
    ),
  );

  const rings = scene.children.filter((c) => c !== disc) as THREE.Mesh[];
  const rider = new THREE.Vector3(500, 42, -900);
  ring.update(rider);
  check(
    'mountain ring: follows the rider, no rotation (parallax)',
    rings.every(
      (m) => m.position.x === rider.x && m.position.z === rider.z && m.rotation.y === 0,
    ),
  );
  check(
    'horizon disc: sits below the rider (the step down to the desk)',
    disc!.position.y < rider.y && disc!.position.y > rider.y - 100,
    `disc y=${disc!.position.y.toFixed(0)}, rider y=${rider.y}`,
  );
  // The disc HAS to follow the rider (it is the void filler), and its UVs are
  // local, so without cancelling that translation in `map.offset` the grid/studs
  // would ride along and the desk would look perfectly still at any speed.
  const discMap = (disc!.material as THREE.MeshToonMaterial).map;
  check(
    'horizon disc: the mat pattern is pinned to the WORLD, not dragged along under the rider',
    !!discMap
      && Math.abs(discMap.offset.x - rider.x * discMap.repeat.x) < 1e-6
      && Math.abs(discMap.offset.y - rider.z * discMap.repeat.y) < 1e-6,
    discMap ? `offset ${discMap.offset.x.toFixed(3)}, ${discMap.offset.y.toFixed(3)}` : 'NO MAP',
  );
  const radii = rings.map((m) => new THREE.Box3().setFromObject(m).max.x - rider.x);
  check(
    'mountain rings: two layers at different radii (parallax depth)',
    new Set(radii.map((r) => Math.round(r))).size === 2,
    `radii ≈ ${radii.map((r) => Math.round(r)).join(' / ')} m`,
  );
  ring.dispose();
  check('mountain ring: disposes cleanly', scene.children.length === 0);

  // `horizonColor` is still the ONE number that describes this surface, and it
  // is what a style with no `createHorizonMaterial` gets painted with — the
  // third world will land without the hook for a while. Prove the fallback is
  // wired, not merely declared.
  const bareScene = new THREE.Scene();
  const bareRing = new MountainRing(
    bareScene, { ...strategy, createHorizonMaterial: undefined }, 12345, CORRIDOR,
  );
  const bareDisc = bareScene.children.find(
    (c) => (c as THREE.Mesh).geometry?.type === 'RingGeometry',
  ) as THREE.Mesh;
  check(
    'horizon disc: falls back to a flat horizonColor when a style declares no desk material',
    (bareDisc.material as THREE.MeshToonMaterial).color.getHex() === strategy.horizonColor,
    `#${strategy.horizonColor.toString(16).padStart(6, '0')}`,
  );
  bareRing.dispose();

  bike.dispose();
  lamp.dispose();
  strategy.dispose();
}

// ── Instanced building bodies ───────────────────────────────────────────────
//
// A style whose bodies decompose hands the renderer `BoxPart`s instead of
// geometry, and the whole chunk goes out as one InstancedMesh PER SHAPE over a
// unit template. Nothing about that shows up in a screenshot until it is wrong,
// and the two ways it goes wrong are both silent:
//
//  · the parts disagree with `buildBuildingBody`, so a building's shape depends
//    on which hook the renderer happened to call, and
//  · an instance geometry has no `color` attribute, in which case three's
//    `USE_COLOR` (defined from the MATERIAL, not the geometry) leaves the shader
//    reading a zeroed generic attribute and every building renders BLACK — in
//    WebGL only, which no headless probe rasterises. Every shape needs its own
//    white attribute; a second one added without it is invisible here and black
//    on screen, which is why the check below loops over the batches.
//
// So both are pinned here instead.

/** Vertex count and a "does this local point lie on the unit shape" test, per
 *  `BoxPart` shape — the reference the merged body is measured against. */
interface UnitShapeRef {
  verts: number;
  /** How far the merged body's k-th local vertex of this part misses the unit
   *  shape (0 = exactly on it). */
  miss: (v: THREE.Vector3, k: number) => number;
}
/**
 * Keyed by (style, shape): `PartShape` is now an OPEN string owned by the style
 * (see its doc), so two styles may legitimately use the same key for different
 * templates and a global cache on the key alone would hand one style the
 * other's reference.
 */
const UNIT_SHAPE_REFS = new Map<string, UnitShapeRef>();
function unitShapeRef(shape: PartShape, strategy: TerrainStyleStrategy): UnitShapeRef {
  const key = `${(strategy as { styleName?: string }).styleName ?? ''}:${shape}`;
  const cached = UNIT_SHAPE_REFS.get(key);
  if (cached) return cached;
  const built = buildUnitShapeRef(shape, strategy);
  UNIT_SHAPE_REFS.set(key, built);
  return built;
}
function buildUnitShapeRef(shape: PartShape, strategy: TerrainStyleStrategy): UnitShapeRef {
  if (shape !== 'box') {
    // A style shape is checked against the style's OWN template, vertex for
    // vertex and in order — not against a surface predicate written out here.
    // That is the whole gain from moving the template to the style: there is a
    // single authority for what the shape is, and a hand-written `miss()` per
    // shape would be a second one, free to drift (the cone's taper drifting
    // from the cup's is exactly how this went wrong before).
    const template = strategy.buildPartTemplate?.(shape);
    if (!template) throw new Error(`style has no buildPartTemplate for '${shape}'`);
    const pos = template.getAttribute('position') as THREE.BufferAttribute;
    const ref = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count * 3; i++) ref[i] = (pos.array as ArrayLike<number>)[i];
    return {
      verts: pos.count,
      miss: (v, k) => Math.max(
        Math.abs(v.x - ref[k * 3]),
        Math.abs(v.y - ref[k * 3 + 1]),
        Math.abs(v.z - ref[k * 3 + 2]),
      ),
    };
  }
  return {
    // The cube is the ONE shape the renderer still owns, and the merged path
    // writes its own 24 vertices in its own order, so it stays a surface test.
    verts: 24,
    miss: (v) => Math.max(
      Math.abs(Math.abs(v.x) - 0.5),
      Math.abs(Math.abs(v.y) - 0.5),
      Math.abs(Math.abs(v.z) - 0.5),
    ),
  };
}

/** The shapes a decomposition uses, in the order they first appear — which is
 *  the order the renderer creates its batches in. */
function shapesInOrder(parts: readonly BoxPart[]): PartShape[] {
  const seen: PartShape[] = [];
  for (const p of parts) {
    const shape = p.shape ?? 'box';
    if (!seen.includes(shape)) seen.push(shape);
  }
  return seen;
}

async function checkInstancedBodies(name: string, strategy: TerrainStyleStrategy): Promise<void> {
  console.log(`\n[instanced bodies — ${name}]`);

  const box = {
    cx: 120, cz: -80, width: 18, depth: 12, rotY: 0.4,
    height: 9, baseY: 3, skirt: 3, color: 0xff3b8d,
  };

  // A style with no decomposition is a legal, complete answer: everything goes
  // through the merge path exactly as it did before the hook existed. The
  // corrugated world is that style, and this is the check that keeps its bodies
  // from quietly disappearing the day someone assumes the hook is universal.
  if (!strategy.buildBuildingBoxes) {
    check('bodies: no box decomposition — the whole style stays on the merge path',
      strategy.buildBuildingBody !== undefined);
  } else {
    // Deterministic in the seed, on its own stream: the shape a footprint gets
    // must not depend on how many times, or in what order, it was asked for.
    const a = strategy.buildBuildingBoxes(box, 7, 'residential');
    strategy.buildBuildingBoxes(box, 99, 'commercial');   // perturb any shared RNG
    strategy.buildBuildingLights?.(box, 7, 'residential');
    const b = strategy.buildBuildingBoxes(box, 7, 'residential');
    check('bodies: the decomposition is deterministic in the seed',
      JSON.stringify(a) === JSON.stringify(b),
      `${a?.length ?? 0} boxes`);

    // …and it must be the SAME body the merge path builds. Every part is a unit
    // shape under its own transform, so un-transforming a merged vertex by that
    // transform must land it back ON the unit shape — ±0.5 of a cube, or, for a
    // style shape, exactly the k-th vertex of the style's own template.
    //
    // Today the toy world derives both hooks from one layout function, so this
    // cannot catch them disagreeing — it catches the OTHER half: that the merge
    // path really does emit one part per `BoxPart`, IN ORDER, at the right size
    // and in the colour asked for, across all five body types and both shapes.
    // Order matters as much as size: the renderer fills its per-shape batches in
    // part order, so a body that emitted its cones before its plates would put
    // every cup on the wrong shelf. The hook-vs-hook and transform-vs-transform
    // halves are pinned end to end further down, against the matrices the
    // renderer actually built.
    let worstCorner = 0;
    let worstColor = 0;
    let bodies = 0;
    let merged = 0;
    const shapesSeen = new Set<PartShape>();
    const m = new THREE.Matrix4();
    const inv = new THREE.Matrix4();
    const partEuler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const col = new THREE.Color();
    const v = new THREE.Vector3();
    for (const zone of [null, 'residential', 'commercial', 'industrial', 'school', 'hospital'] as const) {
      for (let seed = 0; seed < 12; seed++) {
        const parts = strategy.buildBuildingBoxes(box, seed, zone);
        if (!parts) { merged++; continue; }
        const geo = strategy.buildBuildingBody?.(box, seed, zone);
        let want = 0;
        for (const p of parts) want += unitShapeRef(p.shape ?? 'box', strategy).verts;
        if (!geo || geo.attributes.position.count !== want) {
          check('bodies: parts and geometry agree on the vertex count', false,
            `${geo?.attributes.position.count ?? 0} verts vs ${want} for ${parts.length} parts`);
          geo?.dispose();
          return;
        }
        const pos = geo.attributes.position;
        const vcol = geo.attributes.color;
        let vi = 0;
        for (const p of parts) {
          const shape = p.shape ?? 'box';
          const ref = unitShapeRef(shape, strategy);
          shapesSeen.add(shape);
          // The part's FULL rotation, not just its yaw: a tilted part
          // (`rotX`/`rotZ` — the toy world's clay lumps) un-transformed by a
          // yaw-only matrix misses its own template by the tilt, which reads
          // exactly like the two paths disagreeing.
          if (p.rotX || p.rotZ) {
            m.makeRotationFromEuler(partEuler.set(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0));
          } else {
            m.makeRotationY(p.rotY ?? 0);
          }
          m.scale(scale.set(p.w, p.h, p.d));
          m.setPosition(p.x, p.y, p.z);
          inv.copy(m).invert();
          col.setHex(p.color);
          for (let k = 0; k < ref.verts; k++, vi++) {
            v.fromBufferAttribute(pos as THREE.BufferAttribute, vi).applyMatrix4(inv);
            worstCorner = Math.max(worstCorner, ref.miss(v, k));
            worstColor = Math.max(worstColor,
              Math.abs(vcol.getX(vi) - col.r),
              Math.abs(vcol.getY(vi) - col.g),
              Math.abs(vcol.getZ(vi) - col.b));
          }
        }
        geo.dispose();
        bodies++;
      }
    }
    // Float32 rounding only: the merge path writes doubles into a Float32Array,
    // the instance path composes a matrix. 1e-4 of a unit shape is ~2 mm on a
    // 20 m building — a real disagreement is orders of magnitude larger.
    check('bodies: every merged vertex lies on its part\'s unit shape (the two paths agree)',
      bodies > 0 && worstCorner < 1e-4 && worstColor < 1e-5,
      `${bodies} bodies (${merged} not decomposed → merged), shapes ${[...shapesSeen].join('+')}, `
        + `surface Δ=${worstCorner.toExponential(1)}, colour Δ=${worstColor.toExponential(1)}`);
  }

  // ── The renderer's end of it ──
  // Two synthetic footprints on flat ground, far from any route.
  const originLat = 25.06, originLon = 121.57;
  const cosO = Math.cos((originLat * Math.PI) / 180);
  const rect = (x: number, z: number, w: number, d: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      out.push([
        originLon + (x + (su * w) / 2) / (111320 * cosO),
        originLat - (z + (sv * d) / 2) / 111320,
      ]);
    }
    out.push(out[0]);
    return out;
  };
  // Zoned residential on purpose: the clay house is the only body whose parts
  // carry a yaw of their own, and an unzoned block is always the stacking tower
  // (every part axis-aligned) — which makes `box.rotY ± part.rotY` unfalsifiable.
  // Five footprints so the 80/20 zone roll lands on more than one body type.
  //
  // …plus four INDUSTRIAL ones, which is where the toy world's cup tower lives —
  // the one body with a second shape in it. Without them the whole per-shape
  // batching path below is unexercised, and four rather than one because the
  // zone plan is an 80/20 bias, not a mapping.
  const footprints = [
    { coordinates: rect(0, 0, 16, 12), height: 9 },
    { coordinates: rect(40, 0, 14, 14), height: 22 },
    { coordinates: rect(80, 0, 12, 18), height: 6 },
    { coordinates: rect(0, 40, 22, 11), height: 31 },
    { coordinates: rect(40, 40, 15, 15), height: 14 },
    { coordinates: rect(0, 120, 18, 14), height: 20 },
    { coordinates: rect(40, 120, 16, 16), height: 27 },
    { coordinates: rect(80, 120, 14, 20), height: 12 },
    { coordinates: rect(120, 120, 20, 13), height: 34 },
  ];
  const zoneAt = (_lon: number, lat: number) =>
    (lat < originLat - 80 / 111320 ? 'industrial' : 'residential') as const;
  const sampler = {
    getElevationSync: () => 0,
    async getElevation() { return 0; },
    async prefetchBounds() {},
  } as never;

  // Count the boxes by RECORDING what the renderer was actually handed, rather
  // than re-deriving the oriented box here. Re-deriving is how a probe starts
  // agreeing with itself instead of with the game (see render-probe's
  // makeGroundFn warning) — and the question being asked is precisely "did the
  // renderer put every box it was given into the batch, and no others".
  let handedOver = 0;
  let notDecomposed = 0;
  /** Each decomposed building: the box it was given, its seed, and the parts it
   *  should own, in the order the batches were filled. */
  const asked: { box: typeof box; seed: number; zone: ReturnType<typeof zoneAt>; parts: BoxPart[] }[] = [];
  /** Instances the batches should hold, per shape. */
  const wantByShape = new Map<PartShape, number>();
  const recording: TerrainStyleStrategy = strategy.buildBuildingBoxes
    ? Object.assign(Object.create(Object.getPrototypeOf(strategy) as object), strategy, {
      buildBuildingBoxes: (b: typeof box, seed: number, zone: ReturnType<typeof zoneAt>) => {
        const parts = strategy.buildBuildingBoxes!(b, seed, zone);
        if (parts) {
          handedOver += parts.length;
          for (const p of parts) {
            const shape = p.shape ?? 'box';
            wantByShape.set(shape, (wantByShape.get(shape) ?? 0) + 1);
          }
          asked.push({ box: { ...b }, seed, zone, parts });
        } else {
          notDecomposed++;
        }
        return parts;
      },
    })
    : strategy;

  const result = await buildBuildingMeshes(
    footprints, sampler, originLat, originLon, 0, recording, () => 0, undefined, zoneAt,
  );

  // Window lights are instanced too, off a 24-vertex box template of their own,
  // so "unit cube" does not tell them apart. The BODIES are the batch carrying
  // the shared building material.
  const wallMaterial = strategy.createBuildingMaterial();
  const instanced: THREE.InstancedMesh[] = [];
  result.mesh.traverse((o) => {
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh && inst.material === wallMaterial) instanced.push(inst);
  });

  if (strategy.buildBuildingBoxes) {
    // One batch per SHAPE, and no more — a shape that quietly stopped being
    // shared (a per-building template, say) would show up here as a batch count
    // that tracks the buildings instead of the vocabulary.
    check('bodies: one instanced draw call per shape, and no more',
      instanced.length === wantByShape.size && wantByShape.size > 0,
      `${instanced.length} batches for ${[...wantByShape.keys()].join('+') || 'no'} parts`);

    // Which batch is which: match the unit template each one draws by its
    // vertex count, rather than assuming the renderer's ordering here. If two
    // shapes ever had the same count this stops being able to tell them apart,
    // so that is asserted rather than assumed.
    const shapeByVerts = new Map<number, PartShape>();
    for (const shape of [...wantByShape.keys()]) {
      shapeByVerts.set(unitShapeRef(shape, strategy).verts, shape);
    }
    check('bodies: the unit templates are one vertex count each (so a batch can be identified)',
      shapeByVerts.size === wantByShape.size,
      [...wantByShape.keys()].map((sh) => `${sh}=${unitShapeRef(sh, strategy).verts}`).join(' '));
    const batchByShape = new Map<PartShape, THREE.InstancedMesh>();
    for (const mesh of instanced) {
      const shape = shapeByVerts.get(mesh.geometry.attributes.position.count);
      if (shape !== undefined) batchByShape.set(shape, mesh);
    }

    if (batchByShape.size === wantByShape.size) {
      let countsOk = true;
      let whiteOk = true;
      let instanceColorOk = true;
      let spanOk = true;
      for (const [shape, want] of wantByShape) {
        const batch = batchByShape.get(shape)!;
        countsOk &&= batch.count === want && batch.instanceMatrix.count === want;
        // THE BLACK-BUILDING TRAP, once per batch. `vertexColors: true` is set
        // on the shared material, so three defines USE_COLOR whether or not the
        // geometry has a `color` attribute — and without one the shader
        // multiplies by the default generic attribute, which is (0, 0, 0). A
        // NEW shape added without a white attribute of its own is invisible to
        // every probe and black in WebGL, which is why this loops.
        const vc = batch.geometry.getAttribute('color');
        const white = !!vc && Array.from({ length: vc.count * 3 }, (_, i) =>
          (vc.array as ArrayLike<number>)[i]).every((x) => x === 1);
        whiteOk &&= white
          && (batch.material as THREE.Material & { vertexColors?: boolean }).vertexColors === true;
        instanceColorOk &&= batch.instanceColor !== null && batch.instanceColor.count === want;
        // Parts land in SCENE space: a batch has to cover the footprints, not
        // sit at the origin as a unit shape (which is what a forgotten instance
        // matrix looks like, and it still renders).
        batch.computeBoundingSphere();
        spanOk &&= (batch.boundingSphere?.radius ?? 0) > 10;
      }
      check('bodies: each batch holds exactly the parts of its shape the style handed over',
        handedOver > 0 && countsOk,
        [...wantByShape].map(([sh, n]) => `${sh} ${batchByShape.get(sh)!.count}/${n}`).join(', '));
      check('bodies: EVERY instance geometry carries WHITE vertex colours (or the shader reads black)',
        whiteOk, `${wantByShape.size} batches`);
      check('bodies: colour rides per instance, not per vertex', instanceColorOk);
      check('bodies: every batch spans the chunk, not the unit shape', spanOk,
        [...batchByShape].map(([sh, m2]) =>
          `${sh} r=${(m2.boundingSphere?.radius ?? 0).toFixed(0)}m`).join(' '));

      // ── End to end: the instanced chunk is the merged chunk ──
      // Take the matrices the RENDERER built (not a second copy of the maths
      // here) and check each one reproduces the merged body's own vertices,
      // after the merge path's `rotateY(box.rotY); translate(cx, baseY, cz)`.
      // This is what catches a sign flipped in `pushBodyBoxes` — the local
      // check above composes its own matrix and would sail straight past it.
      // It also catches the parts landing in the WRONG BATCH: each shape has its
      // own cursor, walked in part order, so a cone that ended up in the box
      // batch (or one place out of step within its own) fails here.
      // baseY is 0 by construction: flat synthetic ground at elevation 0.
      const im = new THREE.Matrix4();
      const iinv = new THREE.Matrix4();
      const iv = new THREE.Vector3();
      const ic = new THREE.Color();
      const mc = new THREE.Color();
      const cursor = new Map<PartShape, number>();
      let corner = 0;
      let tint = 0;
      let instance = 0;
      for (const a of asked) {
        const geo = strategy.buildBuildingBody!(a.box, a.seed, a.zone)!;
        geo.rotateY(a.box.rotY);
        geo.translate(a.box.cx, 0, a.box.cz);
        const pos = geo.attributes.position;
        const vcol = geo.attributes.color;
        let vi = 0;
        for (const p of a.parts) {
          const shape = p.shape ?? 'box';
          const ref = unitShapeRef(shape, strategy);
          const batch = batchByShape.get(shape)!;
          const idx = cursor.get(shape) ?? 0;
          cursor.set(shape, idx + 1);
          instance++;
          batch.getMatrixAt(idx, im);
          iinv.copy(im).invert();
          ic.fromBufferAttribute(batch.instanceColor!, idx);
          mc.fromBufferAttribute(vcol as THREE.BufferAttribute, vi);
          tint = Math.max(tint, Math.abs(ic.r - mc.r), Math.abs(ic.g - mc.g), Math.abs(ic.b - mc.b));
          for (let k = 0; k < ref.verts; k++, vi++) {
            iv.fromBufferAttribute(pos as THREE.BufferAttribute, vi).applyMatrix4(iinv);
            corner = Math.max(corner, ref.miss(iv, k));
          }
        }
        geo.dispose();
      }
      check('bodies: the built instance matrices reproduce the merged body, in scene space',
        instance === handedOver && corner < 1e-3 && tint < 1e-5,
        `${instance} instances, surface Δ=${corner.toExponential(1)}, colour Δ=${tint.toExponential(1)}`);
    }
    // With nothing left to merge an InstancedMesh IS the chunk root — hanging it
    // under an empty Mesh would put a geometry-less draw call in the scene with
    // a bounding sphere that means nothing. With more than one shape the FIRST
    // batch is the root and the rest are its children, which is why this reads
    // `instanced[0]` and not "the only one".
    check('bodies: with nothing left to merge, the first batch is the chunk root itself',
      notDecomposed > 0
        ? (result.mesh as THREE.InstancedMesh).isInstancedMesh !== true
        : result.mesh === (instanced[0] as THREE.Mesh | undefined),
      `${notDecomposed} bodies took the merge path`);
  } else {
    check('bodies: a style with no decomposition builds no instanced bodies',
      instanced.length === 0 && result.mesh.geometry.attributes.position.count > 0,
      `${result.mesh.geometry.attributes.position.count} merged verts`);
  }

  // The disposer has to reach the InstancedMesh's OWN dispose(): three frees the
  // instanceMatrix and instanceColor GPU buffers from that event and from
  // nowhere else, so a chunk that reloads on every pass would leak them.
  let disposed = 0;
  result.mesh.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      o.addEventListener('dispose', () => { disposed++; });
    }
  });
  const instancedTotal = (() => {
    let n = 0;
    result.mesh.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) n++; });
    return n;
  })();
  disposeBuildingMesh(result);
  check('bodies: the chunk disposer frees every instance buffer (matrix + colour)',
    disposed === instancedTotal, `${disposed}/${instancedTotal} instanced meshes disposed`);

  // ── An unknown shape key has to fail LOUDLY ──
  // `PartShape` is an open string owned by the style, which buys the toy
  // world's cup its own geometry and costs exactly one new way to be wrong: a
  // typo'd or unimplemented key. If the renderer quietly substituted a cube for
  // it, a chunk of cubes would be on screen with no error anywhere — the whole
  // failure mode the closed union used to make impossible. So the substitution
  // must not exist, and this is what says so.
  if (strategy.buildBuildingBoxes) {
    const bogus: TerrainStyleStrategy = Object.assign(
      Object.create(Object.getPrototypeOf(strategy) as object), strategy, {
        buildBuildingBoxes: (b: typeof box, seed: number, zone: ReturnType<typeof zoneAt>) => {
          const parts = strategy.buildBuildingBoxes!(b, seed, zone);
          return parts ? [{ ...parts[0], shape: 'no-such-template' }] : null;
        },
      },
    );
    let refused = false;
    try {
      const bad = await buildBuildingMeshes(
        footprints, sampler, originLat, originLon, 0, bogus, () => 0, undefined, zoneAt,
      );
      disposeBuildingMesh(bad);
    } catch { refused = true; }
    check('bodies: a shape key the style has no template for is REFUSED, not quietly drawn as a cube',
      refused);
  }

  strategy.dispose();
}

// ── Instanced building decorations ──────────────────────────────────────────
//
// The other half of `mergeBuildingDecorations`. A trim part that is the same
// unit shape on every building (a domino pip, an eraser sleeve) is handed over
// as an `InstancedMesh` over a strategy-owned template, and the chunk collects
// the MATRICES instead of copying the vertices once per building. Three ways
// that goes wrong, none of which shows up in a render:
//
//  · the style stops caching the template and builds a fresh geometry per
//    building, so nothing batches and the tag is a lie;
//  · the chunk merger frees the template — which works perfectly for exactly one
//    chunk, and then the style's cache is empty for the rest of the ride;
//  · the merger stops recognising the tag and explodes every instance back into
//    a clone, which looks identical and costs what this change was made to save.

/** Synthetic flat ground at elevation 0 — the sampler `buildBuildingMeshes` wants. */
const FLAT_SAMPLER = {
  getElevationSync: () => 0,
  async getElevation() { return 0; },
  async prefetchBounds() {},
} as never;

/** A rectangular footprint in lon/lat, centred on (x, z) scene metres. */
function synthFootprint(
  originLat: number, originLon: number, x: number, z: number, w: number, d: number,
): [number, number][] {
  const cosO = Math.cos((originLat * Math.PI) / 180);
  const out: [number, number][] = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    out.push([
      originLon + (x + (su * w) / 2) / (111320 * cosO),
      originLat - (z + (sv * d) / 2) / 111320,
    ]);
  }
  out.push(out[0]);
  return out;
}

/**
 * `facesOutward` — whether every flat batched part in this zone's trim has a
 * FRONT that must point away from the building. True for the toy world's domino
 * wall (pips, grooves and the marker's triangles are all stuck on a facade);
 * false for the corrugated eraser, whose sleeve chevrons are solid prisms
 * standing on both wide faces, where "outward" is not a thing they have.
 */
/**
 * Does this geometry map onto itself under a half turn about +y?
 *
 * The test for "this part has no outward direction". Vertices are rounded to a
 * tenth of a millimetre and looked up in a set — exact float equality would
 * fail on the trig that generated them.
 */
function isHalfTurnSymmetric(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const key = (x: number, y: number, z: number): string =>
    `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    seen.add(key(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  for (let i = 0; i < pos.count; i++) {
    if (!seen.has(key(-pos.getX(i), pos.getY(i), -pos.getZ(i)))) return false;
  }
  return true;
}

async function checkDecorationBatching(
  name: string, strategy: TerrainStyleStrategy, zone: ZoneKind, facesOutward: boolean,
): Promise<void> {
  console.log(`\n[instanced decorations — ${name}]`);
  const originLat = 25.06;
  const originLon = 121.57;

  // ── The style's end: a cached template, not a fresh geometry per building ──
  const box = {
    cx: 0, cz: 0, width: 18, depth: 13, rotY: 0.3,
    height: 16, baseY: 0, skirt: 3, color: 0xcccccc,
  };
  const templatesOf = (obj: THREE.Object3D | null): THREE.BufferGeometry[] => {
    const out: THREE.BufferGeometry[] = [];
    obj?.traverse((o) => {
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh && inst.geometry.userData.instanceTemplate === true) {
        out.push(inst.geometry);
      }
    });
    return out;
  };
  // A zone is a BIAS, not a mapping (80/20), so the seed has to be looked for
  // rather than assumed: one in five hospitals is not a domino wall.
  let seed = 0;
  let first: THREE.BufferGeometry[] = [];
  while (seed < 16 && first.length === 0) {
    first = templatesOf(strategy.buildBuildingDecoration(box, seed, zone));
    if (first.length === 0) seed++;
  }
  const again = templatesOf(strategy.buildBuildingDecoration(box, seed, zone));
  check('trim batching: the style hands over instances of a TAGGED template',
    first.length > 0, `${first.length} batched parts (seed ${seed})`);
  check('trim batching: the template is CACHED, not rebuilt per building',
    first.length > 0 && first.length === again.length
      && first.every((g, i) => g === again[i]),
    `${new Set([...first, ...again]).size} distinct geometries across two buildings`);

  // A flat part stuck on a facade has a FRONT, and `setTrimInstance` composes
  // T · Ry · S — a sign error in that yaw turns every pip to face INTO the plate
  // it is stuck on. It is then invisible, in exactly the same way it would be
  // invisible if it had never been built, so nothing downstream notices. Read
  // the instance's own +Z out of the matrix and require it to point away from
  // the building's axis; parts sitting ON that axis (the marker board) have no
  // outward direction and are skipped.
  if (facesOutward) {
    const deco = strategy.buildBuildingDecoration(box, seed, zone);
    const m = new THREE.Matrix4();
    const front = new THREE.Vector3();
    const at = new THREE.Vector3();
    let facing = 0;
    let inward = 0;
    let symmetric = 0;
    deco?.traverse((o) => {
      const inst = o as THREE.InstancedMesh;
      if (!inst.isInstancedMesh || inst.geometry.userData.instanceTemplate !== true) return;
      // A template that maps onto itself under a HALF TURN about +y has no
      // outward direction, and demanding one of it is a coin flip. The toy
      // world's cup wall is the case that forced this: it is a body of
      // revolution, so its instance +z is whatever the layout happened to
      // leave there. (Its pips and grooves became solid cylinders and bars in
      // the demo port and are symmetric for the same reason — the check stays
      // for the next style that lays a genuinely FLAT decal on a facade, which
      // is the failure it was written for.)
      if (isHalfTurnSymmetric(inst.geometry)) { symmetric++; return; }
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        at.set(m.elements[12], 0, m.elements[14]);
        if (at.length() < 0.1) continue;   // on the axis: no outward direction
        front.set(m.elements[8], 0, m.elements[10]).normalize();
        facing++;
        if (front.dot(at.normalize()) <= 0) inward++;
      }
    });
    check('trim batching: every flat part on a facade faces AWAY from the building',
      inward === 0,
      facing > 0
        ? `${facing - inward}/${facing} facing out (${symmetric} symmetric templates skipped)`
        : `no asymmetric facade parts in this style (${symmetric} symmetric templates)`);
  }

  // A template that the chunk frees is a cache that is empty from the second
  // chunk onward — invisible in one screenshot, and every building after that
  // draws nothing. Watch for the event three fires; there is no other signal.
  let templateFreed = 0;
  for (const g of first) g.addEventListener('dispose', () => { templateFreed++; });

  // ── The renderer's end: a chunk of them ──
  const footprints = [];
  for (let i = 0; i < 16; i++) {
    footprints.push({
      coordinates: synthFootprint(originLat, originLon,
        (i % 4) * 45, Math.floor(i / 4) * 45, 16 + (i % 3) * 4, 12 + (i % 2) * 5),
      height: 12 + (i % 5) * 5,
    });
  }
  const result = await buildBuildingMeshes(
    footprints, FLAT_SAMPLER, originLat, originLon, 0, strategy, () => 0, undefined, () => zone,
  );

  // The batches: instanced children that are not the BODY (shared wall material)
  // and not the facade windows (their own shared material).
  const wallMaterial = strategy.createBuildingMaterial();
  const windowTemplate = strategy.facadeWindows?.createTemplate();
  const windowMaterial = windowTemplate?.material;
  windowTemplate?.geometry.dispose();
  const trimBatches: THREE.InstancedMesh[] = [];
  for (const child of result.mesh.children) {
    const inst = child as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) continue;
    if (inst.material === wallMaterial || inst.material === windowMaterial) continue;
    trimBatches.push(inst);
  }

  let instances = 0;
  let batchedVerts = 0;
  for (const b of trimBatches) {
    instances += b.count;
    batchedVerts += b.geometry.attributes.position.count;
  }
  check('trim batching: the chunk carries one batch per (template × material)',
    trimBatches.length > 0 && instances > trimBatches.length * 4,
    `${trimBatches.length} batches carrying ${instances} instances`);
  // The whole point, stated as the number it saves: exploding these back into
  // per-instance clones is what `count × verts` would cost.
  check('trim batching: vertices are paid ONCE per template, not once per instance',
    batchedVerts * 8 < instances * (batchedVerts / Math.max(1, trimBatches.length)),
    `${batchedVerts} verts for ${instances} instances`);
  check('trim batching: the chunk draws a CLONE — the strategy keeps its template',
    trimBatches.every((b) => !first.includes(b.geometry))
      && trimBatches.every((b) => b.geometry.userData.instanceTemplate !== true),
    `${trimBatches.length} batches`);

  disposeBuildingMesh(result);
  check('trim batching: neither the chunk merge nor the chunk disposer frees the template',
    templateFreed === 0, `${templateFreed}/${first.length} templates freed`);

  strategy.dispose();
}

// ── The cup tower's drink fits inside its cup ───────────────────────────────
//
// The toy world's industrial body is a stack of cups: a SOLID frustum (a body
// part, instanced as `shape: 'cup'`) inside a TRANSLUCENT wall (trim, merged).
// They used to be built from one stored radius and so could not disagree. Now
// the solid's taper is fixed by the style's `'cup'` TEMPLATE — an instance
// matrix can scale it but it cannot re-taper it — and the wall builds its own
// cylinder from the demo's two radii. Nothing in the type system says they have
// to match, and if they stop matching the opaque drink pokes out through the
// see-through cup: a real thing to look at, and a completely silent one to
// build.
//
// The taper is read OFF THE TEMPLATE here rather than restated, so this measures
// what the shader will draw. Restating it is how the 0.700-vs-0.691 drift that
// prompted the demo re-port got in.
async function checkCupTowerFit(): Promise<void> {
  console.log('\n[cup tower — the drink fits in the cup]');
  const strategy = createPlasticTerrainStyle();
  const box = {
    cx: 0, cz: 0, width: 17, depth: 13, rotY: 0,
    height: 24, baseY: 0, skirt: 3, color: 0xcccccc,
  };

  // The zone plan is an 80/20 bias, so the seed has to be looked for.
  let seed = 0;
  let cones: BoxPart[] = [];
  while (seed < 16 && cones.length === 0) {
    cones = (strategy.buildBuildingBoxes?.(box, seed, 'industrial') ?? [])
      .filter((p) => p.shape === 'cup');
    if (cones.length === 0) seed++;
  }
  const deco = strategy.buildBuildingDecoration(box, seed, 'industrial');

  // The template's own taper: the radius at the bottom of the unit cup over the
  // radius at its top, both measured on the geometry the renderer instances.
  const cupTemplate = strategy.buildPartTemplate!('cup')!;
  const tPos = cupTemplate.getAttribute('position') as THREE.BufferAttribute;
  let rTopUnit = 0;
  let rBotUnit = 0;
  const tv = new THREE.Vector3();
  for (let i = 0; i < tPos.count; i++) {
    tv.fromBufferAttribute(tPos, i);
    const r = Math.hypot(tv.x, tv.z);
    if (tv.y > 0.49) rTopUnit = Math.max(rTopUnit, r);
    if (tv.y < -0.49) rBotUnit = Math.max(rBotUnit, r);
  }
  const taper = rBotUnit / rTopUnit;
  // Facets counted off the top rim rather than asserted as a vertex total: a
  // vertex total is three's cap-triangulation detail, the facet count is the
  // demo's `14`.
  const rimAngles = new Set<number>();
  for (let i = 0; i < tPos.count; i++) {
    tv.fromBufferAttribute(tPos, i);
    if (tv.y > 0.49 && Math.hypot(tv.x, tv.z) > 0.4) {
      rimAngles.add(Math.round(Math.atan2(tv.z, tv.x) * 1e6));
    }
  }
  check('cup tower: the template is the demo\'s cup — 1.12/1.62 taper, 14 facets',
    Math.abs(taper - 1.12 / 1.62) < 1e-6 && rimAngles.size === 14,
    `taper ${taper.toFixed(4)} (demo 0.6914), ${rimAngles.size} facets, ${tPos.count} verts`);

  // Trim comes back in the building's LOCAL frame (the group carries the scene
  // placement, its meshes carry nothing), which is the frame the parts are in.
  const v = new THREE.Vector3();
  let worst = -Infinity;
  let samples = 0;
  // The walls are INSTANCED now (one unit cup per storey colour, which is what
  // the demo does), so a vertex has to be pushed through its instance matrix
  // before it means anything. Reading the template's own coordinates instead
  // would compare a unit cup at the origin against a tower of real ones and
  // pass by accident.
  const im = new THREE.Matrix4();
  deco?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const inst = mesh as THREE.InstancedMesh;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const copies = inst.isInstancedMesh ? inst.count : 1;
    for (let n = 0; n < copies; n++) {
      if (inst.isInstancedMesh) inst.getMatrixAt(n, im); else im.identity();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(im);
        checkVertex();
      }
    }
  });

  function checkVertex(): void {
    {
      // Each wall vertex belongs to the cup whose axis it is nearest: cups are a
      // whole pitch apart and a wall never reaches half of one.
      let cup: BoxPart | null = null;
      let radius = Infinity;
      for (const c of cones) {
        const d = Math.hypot(v.x - c.x, v.z - c.z);
        if (d < radius) { radius = d; cup = c; }
      }
      if (!cup) return;
      const u = (v.y - (cup.y - cup.h / 2)) / cup.h;
      if (u < -0.01 || u > 1.01) return;
      // The solid's radius at this height, from the unit template the renderer
      // instances — the same number the shader will draw.
      const solid = (cup.w / 2)
        * (taper + (1 - taper) * Math.min(1, Math.max(0, u)));
      worst = Math.max(worst, solid - radius);
      samples++;
    }
  }
  // Instance TEMPLATES are strategy-owned singletons that outlive the chunk;
  // freeing one here empties the cache for every later building.
  deco?.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g && g.userData.instanceTemplate !== true) g.dispose();
  });

  check('cup tower: the translucent wall is never pierced by the solid inside it',
    cones.length > 0 && samples > 0 && worst < 1e-3,
    `${cones.length} cups, ${samples} wall vertices, worst overhang ${worst.toFixed(3)} m`);
  strategy.dispose();
}

// ── The toy world's five zone bodies, against the demo that specifies them ──
//
// Same discipline as `checkCelestialDiscs` and `checkPlasticClouds`, applied to
// the thing those two exist to protect: the demo is the REFERENCE, executed,
// not a transcription of it re-read by eye. `plan/plastic-town-demo.html`'s own
// `stackHouse` / `clayHouse` / `cupTower` / `alphabetBlocks` / `dominoWall` are
// sliced out of the HTML with every helper they call and run for real; the
// strategy's `buildBuildingBoxes` runs beside them and has to agree.
//
// WHY THIS CHECK EXISTS. The five bodies were originally REIMPLEMENTED here —
// somebody read the demo, understood the shape, and wrote gameview's own
// version. The result drifted in ways nothing recorded and nothing could catch:
// the cup's taper became 0.700 against the demo's 1.12/1.62 = 0.6914, its
// fourteen facets became eight, its rim disappeared, its 3.5 m grid became a
// capped 3×2, the clay lumps lost two of their three tilt axes and their
// bevel, and the stacking tower lost the small per-layer yaw that is the whole
// difference between "hand-stacked" and "machined". Every one of those is
// invisible in a screenshot and none of them was a decision.
//
// TWO TIERS, because the demo only answers half the question.
//
//  · EXACT, for the three bodies the demo PARAMETERISES — `stackHouse(w, d,
//    layers)`, `clayHouse(w, d, bodyFloors)`, `cupTower(w, d, levels)`. Called
//    at the extents the demo's own prop occupies, the port must reproduce it
//    part for part: position, size, rotation, colour, and the order they come
//    out in.
//  · RATIO, for the two the demo does NOT — `alphabetBlocks(ci)` and
//    `dominoWall(ci)` take no size at all, so there is no box at which they
//    could be compared part for part. What is pinned instead is every
//    PROPORTION between their constants, which is the part a re-derivation
//    silently rounds off.
//
// ⚠ three burns 4 `Math.random` draws per object uuid, so a shared global RNG
// stream can never line up between the demo and the port. The demo slice gets
// its own `Math` shim and the strategy draws through its own `mulberry32`, keyed
// exactly as the demo keys it — which is itself part of what is checked.

/** One part of a body, in whichever form its side of the fence produced it. */
interface RefPart {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  rx: number; ry: number; rz: number;
  color: string;
  /**
   * Which unit template the part instances, when the style has more than one.
   *
   * Needed because a demo batches by (GEOMETRY, material) and not by material
   * alone: the corrugated world's tab dispenser draws its lid rim (a cube) and
   * its angled lip (a tooth) in the same carton colour, so a colour-only bucket
   * interleaves two different shapes and the diff compares a rim against a
   * wedge. Empty for a
   * body whose parts are all cubes, which leaves the toy world's buckets exactly
   * as they were.
   */
  shape?: string;
  /**
   * The rotation as a quaternion — the ONLY form the two sides can be compared
   * in. `Matrix4.decompose` hands back an XYZ Euler, and a part the demo turns
   * by `rotation.y = π` comes back out of it as (π, 0, π): the same rotation,
   * every component different. Comparing rx/ry/rz would fail on a correct part
   * and (worse) could pass on a wrong one that happens to alias.
   */
  q?: THREE.Quaternion;
}

/** Every InstancedMesh under a demo builder's group, flattened to `RefPart`s in
 *  the order the demo pushed them. Sizes come out of the instance scale because
 *  the demo instances a UNIT cube (`boxBatcher`) or a unit-ish template. */
function demoParts(
  grp: THREE.Object3D,
  templateSpan: (g: THREE.BufferGeometry) => THREE.Vector3,
  shapeOf?: (g: THREE.BufferGeometry) => string,
): RefPart[] {
  const out: RefPart[] = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  grp.traverse((o) => {
    const inst = o as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) return;
    const span = templateSpan(inst.geometry);
    const shape = shapeOf?.(inst.geometry);
    const color = (inst.material as THREE.Material).userData.recColor as string;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m);
      m.decompose(p, q, s);
      e.setFromQuaternion(q);
      out.push({
        x: p.x, y: p.y, z: p.z,
        w: s.x * span.x, h: s.y * span.y, d: s.z * span.z,
        rx: e.x, ry: e.y, rz: e.z,
        color,
        shape,
        q: q.clone(),
      });
    }
  });
  return out;
}

/** …and the same for a plain (non-instanced) mesh, which is how the demo's cup
 *  shelf and the letter blocks' plinth come out.
 *
 *  `world` reads `matrixWorld` instead of the local transform. The toy world's
 *  props hang straight off the building root so the two are the same there; the
 *  corrugated world's dispenser lip is a group inside the building carrying its
 *  own yaw and pitch, and the composition of those is precisely what the port
 *  has to have got right. */
function demoMeshParts(
  grp: THREE.Object3D,
  templateSpan: (g: THREE.BufferGeometry) => THREE.Vector3,
  shapeOf?: (g: THREE.BufferGeometry) => string,
  world = false,
): RefPart[] {
  const out: RefPart[] = [];
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  if (world) grp.updateMatrixWorld(true);
  grp.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const span = templateSpan(mesh.geometry);
    if (world) {
      mesh.matrixWorld.decompose(p, q, s);
      e.setFromQuaternion(q);
    } else {
      p.copy(mesh.position);
      s.copy(mesh.scale);
      e.copy(mesh.rotation);
      q.setFromEuler(e);
    }
    out.push({
      x: p.x, y: p.y, z: p.z,
      w: s.x * span.x, h: s.y * span.y, d: s.z * span.z,
      rx: e.x, ry: e.y, rz: e.z,
      color: (mesh.material as THREE.Material).userData.recColor as string,
      shape: shapeOf?.(mesh.geometry),
      q: q.clone(),
    });
  });
  return out;
}

/** The strategy's parts in the same shape, so the two can be diffed directly. */
function portParts(parts: readonly BoxPart[], withShape = false): RefPart[] {
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  return parts.map((p) => ({
    x: p.x, y: p.y, z: p.z,
    w: p.w, h: p.h, d: p.d,
    rx: p.rotX ?? 0, ry: p.rotY ?? 0, rz: p.rotZ ?? 0,
    color: `#${p.color.toString(16).padStart(6, '0')}`,
    shape: withShape ? (p.shape ?? 'box') : undefined,
    q: q.setFromEuler(e.set(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0)).clone(),
  }));
}

/** Worst per-field disagreement between two part lists, described. */
function partsDiff(
  demo: RefPart[], port: RefPart[], opts: { pinnedBelowY?: number } = {},
): { worst: number; where: string } {
  if (demo.length !== port.length) {
    return { worst: Infinity, where: `part COUNT: demo ${demo.length} vs ours ${port.length}` };
  }
  // GROUPED BY COLOUR, not compared position for position. The demo's
  // `boxBatcher` buckets its pushes by MATERIAL and flushes one InstancedMesh
  // per bucket, so what comes out of it is the push order within each colour
  // and nothing at all about the order between colours. Comparing raw index to
  // raw index would fail on a body that is correct and pass on one that is not.
  // …and by TEMPLATE too where the style has more than one, for the same reason:
  // a demo's batch key is (geometry, material), so two shapes sharing a colour
  // come out interleaved and a colour-only bucket would compare a carton lid rim
  // against the dispenser lip that shares its colour.
  const bucket = (list: RefPart[]): Map<string, RefPart[]> => {
    const m = new Map<string, RefPart[]>();
    for (const p of list) {
      const key = `${p.color.toLowerCase()}|${p.shape ?? ''}`;
      let arr = m.get(key);
      if (!arr) { arr = []; m.set(key, arr); }
      arr.push(p);
    }
    return m;
  };
  const dB = bucket(demo);
  const pB = bucket(port);
  if (dB.size !== pB.size) {
    return {
      worst: Infinity,
      where: `COLOUR count: demo ${[...dB.keys()].join(',')} vs ours ${[...pB.keys()].join(',')}`,
    };
  }
  let worst = 0;
  let where = '';
  const fields: (keyof RefPart)[] = ['x', 'y', 'z', 'w', 'h', 'd', 'rx', 'ry', 'rz'];
  for (const [color, dList] of dB) {
    const pList = pB.get(color);
    if (!pList || pList.length !== dList.length) {
      return {
        worst: Infinity,
        where: `colour ${color}: demo ${dList.length} parts vs ours ${pList?.length ?? 0}`,
      };
    }
    for (let i = 0; i < dList.length; i++) {
      for (const f of fields) {
        // The GROUND COURSE is pinned by the port so the body's base lands
        // exactly on −skirt, which the demo (standing on flat ground, with no
        // skirt at all) never had to do. Its y is a port decision; everything
        // else about it is still the demo's.
        if (f === 'y' && opts.pinnedBelowY !== undefined && dList[i].y < opts.pinnedBelowY) continue;
        // Euler components are informational once both sides carry a quaternion
        // — see `RefPart.q`. They stay the metric only for a body whose parts
        // are pure yaws, where the two forms agree component for component.
        if ((f === 'rx' || f === 'ry' || f === 'rz') && dList[i].q && pList[i].q) continue;
        const d = Math.abs((dList[i][f] as number) - (pList[i][f] as number));
        if (d > worst) {
          worst = d;
          where = `${color}[${i}].${f}: demo ${(dList[i][f] as number).toFixed(4)} `
            + `vs ours ${(pList[i][f] as number).toFixed(4)}`;
        }
      }
      const dq = dList[i].q;
      const pq = pList[i].q;
      if (dq && pq) {
        // Angle between the two rotations, in radians, sign-insensitive (q and
        // −q are the same rotation). Reported in the same units as the metre
        // fields on purpose: at the sizes here a milliradian and a millimetre
        // are the same size of mistake, and one number is one tolerance.
        const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.dot(pq))));
        if (ang > worst) {
          worst = ang;
          where = `${color}[${i}].rot: ${ang.toFixed(4)} rad apart `
            + `(demo ${dList[i].rx.toFixed(3)},${dList[i].ry.toFixed(3)},${dList[i].rz.toFixed(3)} `
            + `vs ours ${pList[i].rx.toFixed(3)},${pList[i].ry.toFixed(3)},${pList[i].rz.toFixed(3)})`;
        }
      }
    }
  }
  return { worst, where };
}

/**
 * How far apart "the same part" is allowed to be, in metres.
 *
 * 10 µm. Not a fudge: the demo builds its parts through `Matrix4.compose` and
 * they are read back through `decompose`, which round-trips through float32
 * instance buffers, while the port hands over doubles — so identical arithmetic
 * lands ~1e-6 m apart on a 20 m building. The drifts this check exists to catch
 * are five to seven orders of magnitude larger (the cup's taper was out by 1.2 %,
 * its facet count by 43 %, its grid by a factor of four).
 */
const EXACT_TOL = 1e-5;

/** A ratio the demo fixes, the port's own value for it, and the name to print. */
function checkRatio(label: string, demo: number, ours: number, tol = 1e-6): void {
  check(label, Math.abs(demo - ours) <= tol * Math.max(1, Math.abs(demo)),
    `demo ${demo.toFixed(5)} vs ours ${ours.toFixed(5)}`);
}

async function checkPlasticBodiesVsDemo(): Promise<void> {
  console.log('\n[zone bodies vs demo — plastic (toy blocks)]');
  const strategy = createPlasticTerrainStyle();
  const src = readFileSync('plan/plastic-town-demo.html', 'utf8');

  // ── Slice the demo ────────────────────────────────────────────────────────
  const at = (needle: string, from = 0): number => {
    const i = src.indexOf(needle, from);
    if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const constsAt = at('const LAYER_H = 2.3;');
  const constsEnd = at('const SLAB_H = LAYER_H - SLAB_GAP;') + 'const SLAB_H = LAYER_H - SLAB_GAP;'.length;
  const clayConstAt = at('const CLAY_CUBE = 3.2;');
  const clayGeoEnd = at('const CLAY_WIN_HEX = ') + at('\n', at('const CLAY_WIN_HEX = '))
    - at('const CLAY_WIN_HEX = ');
  const cupGeoAt = at('const cupGeo = (() => {');
  const cupGeoEnd = at('const cupPlateGeo = new THREE.CylinderGeometry(1, 1, 0.22, 20);')
    + 'const cupPlateGeo = new THREE.CylinderGeometry(1, 1, 0.22, 20);'.length;
  const paletteAt = at('const C = {');
  const paletteEnd = at('\n  };', paletteAt) + '\n  };'.length;
  const candyAt = at('const CANDY = [C.pink');
  const candyEnd = at('\n', candyAt);

  check('demo still declares the five zone bodies and their constants',
    constsAt > 0 && clayConstAt > constsAt && cupGeoAt > clayConstAt);

  const demoSrc = [
    sliceDemoFn(src, 'mulberry32'),
    sliceDemoFn(src, 'brightenHex'),
    'const unitBox = new THREE.BoxGeometry(1, 1, 1);',
    sliceDemoFn(src, 'scaledBox'),
    sliceDemoFn(src, 'boxBatcher'),
    sliceDemoFn(src, 'mergeGeos'),
    src.slice(paletteAt, paletteEnd),        // C — the $plastic swatches
    src.slice(candyAt, candyEnd),            // CANDY — the six-colour cycle
    // LAYER_H / SLAB_GAP / MAX_PULL, candyMat, coreMat, SLAB_H — the demo
    // declares them as one run, so they are taken as one run.
    src.slice(constsAt, constsEnd),
    sliceDemoFn(src, 'emitSlabFaceLights'),
    sliceDemoFn(src, 'stackHouse'),
    src.slice(clayConstAt, clayGeoEnd),      // CLAY_CUBE / triSignGeo / clayCubeGeo / clayMat
    sliceDemoFn(src, 'clayHouse'),
    src.slice(cupGeoAt, cupGeoEnd),          // cupGeo / cupPlateGeo
    'const whitePlateMat = glossShared("#f4f6ff", { shininess: 130 });',
    sliceDemoFn(src, 'cupBodyMat'),
    sliceDemoFn(src, 'cupTower'),
    'return { stackHouse, clayHouse, cupTower, cupGeo, clayCubeGeo, cupPlateGeo, unitBox };',
  ].join('\n');

  // Material stubs that RECORD their colour and keep the demo's material
  // IDENTITY (same hex → same object), because identity is what decides how
  // the demo buckets its instances and therefore what order parts come out in.
  const stubMats = new Map<string, THREE.Material>();
  const recMat = (color: string): THREE.Material => {
    let m = stubMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial();
      m.userData.recColor = color;
      stubMats.set(color, m);
    }
    return m;
  };
  const toonShared = (color: string): THREE.Material => recMat(color);
  const glossShared = (color: string): THREE.Material => recMat(color);
  const glowAtNight = (mat: THREE.Material): THREE.Material => mat;
  const cupMatsShim = new Map<string, THREE.Material>();

  // Math shim, not the global — three burns 4 draws per uuid (see the header).
  const demoMath = Object.create(Math) as Math;
  const demo = new Function(
    'THREE', 'toonShared', 'glossShared', 'glowAtNight', 'cupMats', 'Math', demoSrc,
  )(THREE, toonShared, glossShared, glowAtNight, cupMatsShim, demoMath) as {
    stackHouse: (w: number, d: number, layers: number, ci: number) => { grp: THREE.Group };
    clayHouse: (w: number, d: number, bodyFloors: number, ci: number) => { grp: THREE.Group };
    cupTower: (w: number, d: number, levels: number, ci: number) => { grp: THREE.Group };
    cupGeo: THREE.BufferGeometry;
    clayCubeGeo: THREE.BufferGeometry;
    cupPlateGeo: THREE.BufferGeometry;
    unitBox: THREE.BufferGeometry;
  };

  const spanOf = (g: THREE.BufferGeometry): THREE.Vector3 => {
    g.computeBoundingBox();
    const b = g.boundingBox!;
    return new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
  };

  // ── Which of the five did the 80/20 zone roll land on? ───────────────────
  //
  // By STRUCTURE, not by part count: the tower and the clay house are the two
  // with no trim at all, the cup is the one with cup parts, and the letter
  // blocks merge their letters where the domino instances its pips. Guessing
  // "no special shape ⇒ tower" is what made the first version of this check
  // compare a school against a tower on one seed in five.
  const kindOf = (probe: BuildingBox, seed: number, zone: ZoneKind): string => {
    const parts = strategy.buildBuildingBoxes?.(probe, seed, zone) ?? [];
    const shapes = new Set(parts.map((p) => p.shape ?? 'box'));
    if (shapes.has('cup')) return 'cup';
    if (shapes.has('clayCube')) return 'clay';
    const deco = strategy.buildBuildingDecoration(probe, seed, zone);
    if (!deco) return 'stack';
    let instanced = false;
    deco.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) instanced = true; });
    deco.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && g.userData.instanceTemplate !== true) g.dispose();
    });
    return instanced ? 'domino' : 'alphabet';
  };
  const seedFor = (kind: string, zone: ZoneKind, probe: BuildingBox): number => {
    for (let seed = 0; seed < 256; seed++) if (kindOf(probe, seed, zone) === kind) return seed;
    return -1;
  };

  // ══ EXACT: the stacking tower ══
  // `makeBuilding` calls `stackHouse(10, 10, 8, ci)`; eight layers of LAYER_H
  // is 18.4 m, which is the box the port has to be given to be asked the same
  // question. No skirt: the demo has none, and the skirt is the port's own.
  {
    const box: BuildingBox = {
      cx: 0, cz: 0, width: 10, depth: 10, rotY: 0,
      height: 8 * 2.3, baseY: 0, skirt: 0, color: 0,
    };
    // ⚠ ONE deviation survives in this body and it moves the rng stream, so it
    // is not something a tolerance can absorb: the demo lets the GROUND FLOOR
    // eject a slab (`canPull = i < layers - 1`) and the port does not
    // (`i > 0`). A ground-floor slab juts up to `MAX_PULL` = 3.2 m sideways
    // with its underside ON THE ROAD, which is the one overhang the route
    // clearance the building renderer works to keep cannot survive; every
    // violation the clearance sweep found sat on a ground-floor slab. Ejecting
    // costs an extra `rng()` draw, so a seed where the demo happens to eject
    // downstairs diverges from there on and can never be compared.
    //
    // So: the towers are compared on every seed, and the ones that agree must
    // agree EXACTLY (a 23-part body matching to 1e-9 is not luck), while the
    // ones that disagree have to be exactly the seeds where the demo ejected
    // downstairs. The rate is reported because it is itself a reading on the
    // deviation: three slabs on the ground floor, each ejecting at p = 0.14,
    // so ~0.86³ = 64 % of seeds should be comparable at all.
    const seed = seedFor('stack', 'commercial', box);
    check('stacking tower: a commercial seed rolls the tower', seed >= 0);
    if (seed >= 0) {
      let exact = 0;
      let tried = 0;
      let worstBad = '';
      for (let s = seed; s < seed + 64; s += 1) {
        if (kindOf(box, s, 'commercial') !== 'stack') continue;   // 80/20 roll
        const parts = strategy.buildBuildingBoxes!(box, s, 'commercial')!;
        tried++;
        const grp = demo.stackHouse(10, 10, 8, s).grp;
        const dParts = [...demoMeshParts(grp, spanOf), ...demoParts(grp, spanOf)];
        const { worst, where } = partsDiff(dParts, portParts(parts));
        if (worst < EXACT_TOL) exact++;
        else if (!worstBad) worstBad = `seed ${s} → ${where}`;
      }
      check('stacking tower: every slab is the demo\'s — position, size, yaw, colour',
        tried > 0 && exact > 0 && exact >= tried * 0.4,
        `${exact}/${tried} seeds reproduce the demo exactly `
          + `(predicted ${(0.86 ** 3 * 100).toFixed(0)} % — the ground floor is three slabs, `
          + `each ejecting at p = 0.14)`
          + (worstBad ? `; first divergence ${worstBad}` : ''));
      // …and the deviation itself, stated as the rule it is.
      let lowEject = 0;
      const layerH = box.height / 8;
      for (let s = seed; s < seed + 64; s++) {
        if (kindOf(box, s, 'commercial') !== 'stack') continue;
        const parts = strategy.buildBuildingBoxes?.(box, s, 'commercial') ?? [];
        for (const p of parts) {
          if (p.y - p.h / 2 > layerH - 1e-6) continue;        // not the ground floor
          if (p.w < box.width - 3 && p.d < box.depth - 3) continue;   // the core
          // An ejected slab OVERHANGS: its far edge reaches outside the
          // footprint. Its CENTRE does not — a 10 m slab pulled 3.2 m still has
          // its centre inside a 10 m box, which is how the first version of
          // this assertion passed while the slab hung 3.2 m over the road.
          // 0.3 m of slack absorbs the layer's own small yaw.
          const over = Math.max(
            Math.abs(p.x) + p.w / 2 - box.width / 2,
            Math.abs(p.z) + p.d / 2 - box.depth / 2);
          if (over > 0.3) lowEject++;
        }
      }
      check('stacking tower: no slab is ever ejected over the road from the GROUND floor '
        + '(the demo allows it; route clearance does not)', lowEject === 0,
        `${lowEject} ground-floor overhangs in 64 seeds`);
    }
  }

  // ══ EXACT: the clay pixel house ══
  // `clayHouse(15, 10, 3, ci)`: nx = round(15/3.2) = 5, so roofLayers = 2 and
  // the house is 5 courses of SP = 3.008 → 15.04 m. Width is the demo's OWN
  // extent `nx * SP` rather than the 15 it was called with, because the port
  // fills the box it is given and the demo's house does not quite fill 15.
  {
    const SP = 3.2 * 0.94;
    const box: BuildingBox = {
      cx: 0, cz: 0, width: 5 * SP, depth: 3 * SP, rotY: 0,
      height: 5 * SP, baseY: 0, skirt: 0, color: 0,
    };
    const seed = seedFor('clay', 'residential', box);
    check('clay house: a residential seed rolls the house', seed >= 0);
    if (seed >= 0) {
      const dParts = demoParts(demo.clayHouse(box.width, box.depth, 3, seed).grp, spanOf);
      const oParts = portParts(strategy.buildBuildingBoxes!(box, seed, 'residential')!);
      const { worst, where } = partsDiff(dParts, oParts, { pinnedBelowY: SP });
      check('clay house: every lump is the demo\'s — including all THREE tilt axes',
        worst < EXACT_TOL,
        worst < EXACT_TOL ? `${oParts.length} lumps, max Δ ${worst.toExponential(1)}` : where);
      // The bevel is the fourth clay rule and it lives in the template, not in
      // the layout, so a part-for-part diff cannot see it.
      const tmpl = strategy.buildPartTemplate!('clayCube')!;
      const dSpan = spanOf(demo.clayCubeGeo);
      const oSpan = spanOf(tmpl);
      check('clay house: the lump is the demo\'s ROUNDED cube, not a box',
        tmpl.getAttribute('position').count === demo.clayCubeGeo.getAttribute('position').count
          && Math.abs(dSpan.x - oSpan.x) < 1e-6 && Math.abs(dSpan.y - oSpan.y) < 1e-6,
        `${tmpl.getAttribute('position').count} verts (demo ${demo.clayCubeGeo.getAttribute('position').count}), `
          + `span ${oSpan.x.toFixed(3)}×${oSpan.y.toFixed(3)}×${oSpan.z.toFixed(3)}`);
    }
  }

  // ══ EXACT: the cup tower ══
  // `cupTower(13, 9, 3, ci)` stands 3 × 3.0 + 2 × 0.22 = 9.44 m tall. The port
  // holds the plates and the cups in one list, so the demo's are read in the
  // same order: shelves first (they are plain meshes), cups after.
  {
    const H = 3 * 3.0 + 2 * 0.22;
    const box: BuildingBox = {
      cx: 0, cz: 0, width: 13, depth: 9, rotY: 0,
      height: H, baseY: 0, skirt: 0, color: 0,
    };
    const seed = seedFor('cup', 'industrial', box);
    check('cup tower: an industrial seed rolls the tower', seed >= 0);
    if (seed >= 0) {
      const grp = demo.cupTower(13, 9, 3, seed).grp;
      // The demo's shelf is a plain Mesh over `cupPlateGeo` (a unit-RADIUS
      // cylinder, so its span is 2), its cups an InstancedMesh over `cupGeo`
      // (whose span includes the rim). The port's parts are extents, so both
      // sides are converted through their own template's span.
      // The demo instances its CUPS and plain-meshes its SHELVES, which is
      // exactly the split the port's part list has, so no filtering by size is
      // needed — and none should be attempted, since the demo's cup geometry
      // spans 3.14 m (the rim stands proud) where the port's solid spans 3.00.
      //
      // The demo's instance matrix is a pure translation to the cup's BASE; the
      // port's part carries a CENTRE. So the comparable quantity is the base,
      // and the two have to agree cup for cup, in order, with no cap on the
      // grid — which is the deviation this whole check was written for (the
      // grid used to be clamped to 3 × 2 and the pitch read off the footprint).
      const dCups = demoParts(grp, spanOf);
      const oCups = strategy.buildBuildingBoxes!(box, seed, 'industrial')!
        .filter((p) => p.shape === 'cup');
      let worstPos = 0;
      const ok = dCups.length === oCups.length && dCups.length > 0;
      for (let i = 0; ok && i < dCups.length; i++) {
        worstPos = Math.max(worstPos,
          Math.abs(dCups[i].x - oCups[i].x),
          Math.abs(dCups[i].y - (oCups[i].y - oCups[i].h / 2)),
          Math.abs(dCups[i].z - oCups[i].z));
      }
      check('cup tower: the demo\'s 3.5 m grid, cup for cup (uncapped rows and columns)',
        ok && worstPos < EXACT_TOL,
        ok ? `${oCups.length} cups, max base Δ ${worstPos.toExponential(1)}`
          : `cup COUNT: demo ${dCups.length} vs ours ${oCups.length}`);
      // …and the shelves between them: the demo's ROUND plate, sized to the
      // storey ABOVE it (this file had a rectangular box sized to the storey's
      // own cell grid).
      const dPlates = demoMeshParts(grp, spanOf);
      const oPlates = strategy.buildBuildingBoxes!(box, seed, 'industrial')!
        .filter((p) => p.shape === 'plate');
      let worstPlate = 0;
      const plateOk = dPlates.length === oPlates.length && dPlates.length > 0;
      for (let i = 0; plateOk && i < dPlates.length; i++) {
        worstPlate = Math.max(worstPlate,
          Math.abs(dPlates[i].w - oPlates[i].w),
          Math.abs(dPlates[i].d - oPlates[i].d),
          Math.abs(dPlates[i].h - oPlates[i].h),
          Math.abs(dPlates[i].y - oPlates[i].y));
      }
      check('cup tower: the shelf between storeys is the demo\'s round plate',
        plateOk && worstPlate < EXACT_TOL,
        plateOk ? `${oPlates.length} shelves, max Δ ${worstPlate.toExponential(1)}`
          : `shelf COUNT: demo ${dPlates.length} vs ours ${oPlates.length}`);
      // The wall is trim, and it is the demo's `cupGeo` — open shell + rim.
      const wall = strategy.buildBuildingDecoration(box, seed, 'industrial');
      let wallTemplate: THREE.BufferGeometry | null = null;
      wall?.traverse((o) => {
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh && !wallTemplate) wallTemplate = inst.geometry;
      });
      const wt = wallTemplate as THREE.BufferGeometry | null;
      check('cup tower: the translucent wall is the demo\'s cupGeo — open shell PLUS rim',
        !!wt && wt.getAttribute('position').count === demo.cupGeo.getAttribute('position').count,
        `${wt ? wt.getAttribute('position').count : 0} verts (demo cupGeo ${demo.cupGeo.getAttribute('position').count})`);
    }
  }

  // ══ RATIO: the letter blocks and the domino wall ══
  //
  // These two take NO size in the demo (`alphabetBlocks(ci)`, `dominoWall(ci)`),
  // so there is no box at which a part-for-part diff is even defined. What IS
  // defined, and what a re-derivation rounds off, is every ratio between their
  // constants — so those are read straight out of the demo's source text and
  // compared against the port's.
  // `const DOM_W = 2.6, DOM_D = 1.1, DOM_H = 6.2;` — one statement, three
  // names, so the `const` cannot be part of the pattern.
  const num = (name: string): number => {
    const m = src.match(new RegExp(`\\b${name} = ([0-9.]+)`));
    if (!m) throw new Error(`demo no longer declares ${name}`);
    return Number(m[1]);
  };
  const ABC_S_D = num('ABC_S');
  const ABC_PLINTH_D = num('ABC_PLINTH');
  const DOM_W_D = num('DOM_W');
  const DOM_D_D = num('DOM_D');
  const DOM_H_D = num('DOM_H');
  const DOM_GAP_D = num('DOM_GAP');
  check('demo still declares the letter-block and domino constants',
    ABC_S_D === 5.2 && ABC_PLINTH_D === 0.9 && DOM_W_D === 2.6
      && DOM_D_D === 1.1 && DOM_H_D === 6.2 && DOM_GAP_D === 0.7,
    `ABC ${ABC_PLINTH_D}/${ABC_S_D}, DOM ${DOM_W_D}/${DOM_D_D}/${DOM_H_D}/${DOM_GAP_D}`);

  // The port's own numbers, read back off a layout rather than off constants —
  // constants can agree while the code that uses them does not.
  {
    // A footprint scaled so the demo's prop fits it exactly once: `n` blocks of
    // `ABC_S + 0.5`, `ABC_S + 1.6` across, `ABC_PLINTH + ABC_S` tall.
    const n = 4;
    const box: BuildingBox = {
      cx: 0, cz: 0, width: ABC_S_D + 1.6, depth: n * (ABC_S_D + 0.5), rotY: 0,
      height: ABC_PLINTH_D + ABC_S_D, baseY: 0, skirt: 0, color: 0,
    };
    const seed = (() => {
      for (let s = 0; s < 256; s++) {
        if (kindOf(box, s, 'school') !== 'alphabet') continue;
        if ((strategy.buildBuildingBoxes?.(box, s, 'school') ?? []).length === n + 1) return s;
      }
      return -1;
    })();
    check('letter blocks: a school seed rolls a row of the demo\'s length', seed >= 0,
      `${n} blocks + plinth`);
    if (seed >= 0) {
      const parts = strategy.buildBuildingBoxes!(box, seed, 'school')!;
      const plinth = parts[0];
      const blocks = parts.slice(1);
      checkRatio('letter blocks: plinth : block edge is the demo\'s 0.9 : 5.2',
        ABC_PLINTH_D / ABC_S_D, plinth.h / blocks[0].h, 1e-3);
      checkRatio('letter blocks: pitch : block edge is the demo\'s (5.2 + 0.5) : 5.2',
        (ABC_S_D + 0.5) / ABC_S_D,
        Math.abs(blocks[1].z - blocks[0].z) / blocks[0].d, 1e-3);
      checkRatio('letter blocks: block is CUBIC, as the demo\'s 5.2³ is',
        1, blocks[0].w / blocks[0].h, 1e-2);
      // …and the same sweep, for the same reason: at one footprint the +0.5 m
      // gap between blocks rounds away into the block count.
      let worstBand = 0;
      let bandAt = '';
      for (let long = 8; long <= 60; long += 0.25) {
        const b: BuildingBox = { ...box, depth: long };
        const ps = strategy.buildBuildingBoxes?.(b, seed, 'school') ?? [];
        if (ps.length < 3) continue;
        const nBlocks = ps.length - 1;
        const got = long / nBlocks;
        const want = (ABC_S_D + 0.5) * (b.height / (ABC_PLINTH_D + ABC_S_D));
        const band = want / (2 * nBlocks) + 1e-6;
        const miss = Math.abs(got - want) - band;
        if (miss > worstBand) { worstBand = miss; bandAt = `long ${long} m: pitch ${got.toFixed(3)} vs ${want.toFixed(3)} ± ${band.toFixed(3)}`; }
      }
      check('letter blocks: the block count comes off the demo\'s (5.2 + 0.5) pitch at every footprint',
        worstBand <= 0, worstBand <= 0 ? 'inside the rounding band, 8-60 m' : bandAt);
    }
  }
  {
    // A footprint the demo's domino prop fits exactly: 3 rows of (D + GAP)
    // across, 6 plates of DOM_PITCH along, plinth + DOM_H tall.
    const pitchD = DOM_W_D + 0.55;
    const box: BuildingBox = {
      cx: 0, cz: 0, width: 6 * pitchD, depth: 3 * (DOM_D_D + DOM_GAP_D), rotY: 0,
      height: 0.7 + DOM_H_D, baseY: 0, skirt: 0, color: 0,
    };
    let seed = -1;
    for (let s = 0; s < 256 && seed < 0; s++) {
      if (kindOf(box, s, 'hospital') === 'domino') seed = s;
    }
    check('domino wall: a hospital seed rolls the wall', seed >= 0);
    if (seed >= 0) {
      const parts = strategy.buildBuildingBoxes!(box, seed, 'hospital')!;
      const plates = parts.slice(1);
      // The wall runs along the longer axis, so a plate's width is `w` and its
      // thickness `d`. The tallest plate is the one normalised to the box.
      const tallest = plates.reduce((a, b) => (b.h > a.h ? b : a));
      checkRatio('domino wall: plate is the demo\'s 6.2 : 2.6 tall-to-wide',
        DOM_H_D / DOM_W_D, tallest.h / tallest.w, 2e-2);
      // 1e-6, not a percent: the footprint was chosen so the demo's prop fits
      // it a whole number of times, which makes every one of these ratios exact
      // on both sides. A percent of slack is exactly enough room for the class
      // of drift this file exists to catch — 0.83 for 2.6/3.15 = 0.8254 is 0.6 %
      // off, and 0.62 for 1.1/1.8 = 0.6111 is 1.5 %.
      checkRatio('domino wall: plate : pitch is the demo\'s 2.6 : 3.15 (a seam shows)',
        DOM_W_D / pitchD, tallest.w / (box.width / 6));
      checkRatio('domino wall: plate : row spacing is the demo\'s 1.1 : 1.8',
        DOM_D_D / (DOM_D_D + DOM_GAP_D), tallest.d / (box.depth / 3));
      checkRatio('domino wall: plinth : plate is the demo\'s 0.7 : 6.2',
        0.7 / (0.7 + DOM_H_D), parts[0].h / box.height);
      // ── M14's class: the PITCH the plate count is derived from ──
      // A ratio measured at one exact-fit footprint cannot see the nominal
      // pitch move by a few percent, because the plate count rounds it away.
      // Swept across footprints it can: whatever count comes out, the pitch it
      // implies has to stay inside the band `round()` guarantees around the
      // demo's own `DOM_PITCH · k`.
      let worstBand = 0;
      let bandAt = '';
      for (let long = 8; long <= 60; long += 0.25) {
        const b: BuildingBox = { ...box, width: long, depth: 3 * (DOM_D_D + DOM_GAP_D) };
        const ps = strategy.buildBuildingBoxes?.(b, seed, 'hospital') ?? [];
        if (ps.length < 4) continue;
        const plate = ps.slice(1).reduce((a, c) => (c.h > a.h ? c : a));
        const wallH = b.height - ps[0].h;
        const want = pitchD * (wallH / DOM_H_D);
        const got = plate.w / (DOM_W_D / pitchD);        // the pitch it implies
        const n = Math.round(long / got);
        const band = want / (2 * n) + 1e-6;
        const miss = Math.abs(got - want) - band;
        if (miss > worstBand) { worstBand = miss; bandAt = `long ${long} m: pitch ${got.toFixed(3)} vs ${want.toFixed(3)} ± ${band.toFixed(3)}`; }
      }
      check('domino wall: the plate count comes off the demo\'s pitch at every footprint',
        worstBand <= 0, worstBand <= 0 ? 'inside the rounding band, 8-60 m' : bandAt);
      // The pips are what the plate face SAYS, and the demo puts them PROUD of
      // it (`fx = bx + outward * (DOM_D / 2 + 0.06)`, a cylinder sticking out
      // 0.2 m). A pip sunk into the plate is invisible with no error anywhere —
      // it used to be a flat disc, where the same mistake was caught by its
      // facing instead, and 3D parts have no facing to catch.
      const deco = strategy.buildBuildingDecoration(box, seed, 'hospital');
      const halfRow = (box.depth / 3) * (DOM_D_D / (DOM_D_D + DOM_GAP_D)) / 2;
      let pips = 0;
      let sunk = 0;
      const pm = new THREE.Matrix4();
      deco?.traverse((o) => {
        const inst = o as THREE.InstancedMesh;
        if (!inst.isInstancedMesh) return;
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, pm);
          // Outer rows sit at ±(rowPitch), so a face part belongs to whichever
          // row it is nearest and must be further out than that row's surface.
          const z = pm.elements[14];
          const row = Math.round(z / (box.depth / 3)) * (box.depth / 3);
          if (Math.abs(row) < 1e-6) continue;          // middle row / rooftop mark
          pips++;
          if (Math.abs(z) < Math.abs(row) + halfRow - 1e-6) sunk++;
        }
      });
      deco?.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g && g.userData.instanceTemplate !== true) g.dispose();
      });
      check('domino wall: every pip and groove stands PROUD of the plate face, never sunk into it',
        pips > 0 && sunk === 0, `${pips - sunk}/${pips} proud`);
    }
  }

  strategy.dispose();
}

// ── The corrugated world's zone bodies, against the demo that specifies them ──
//
// Same recipe as `checkPlasticBodiesVsDemo`, and for the same reason: the demo
// is the REFERENCE, executed, not a transcription of it re-read by eye.
// `plan/paper-town-demo.html`'s own `flagDispenser` / `tapeDispenser` /
// `abacusSchool` / `pillBox` are sliced out of the HTML with every helper they
// call and run for real; `buildBuildingBoxes` and `buildBuildingDecoration` run
// beside them and have to agree part for part.
//
// WHAT THIS CAUGHT the first time it ran, all of it invisible in a screenshot
// and none of it a decision anybody took: the school's frame section, backing
// panel depth, bead row count, bead radius and beads-per-row had all become
// formulas off the box where the demo had flat constants; its bead was a
// 6-vertex octahedron where the demo's was a 20-face icosahedron (at bead size,
// a diamond rather than a ball); the tape roll had 12 facets instead of 18 and
// its hub was twice the demo's diameter; the serration was capped at 7 teeth
// where the demo asks for `round(w / 1.35)`; the commercial body's awning (since
// retired, see the sweep below) was capped at 5 folds reaching 2.4 m where the
// demo folded `round(w / 1.9)` and reached `2.9 k`; the
// shopfront was sized off a 9 m "storey" instead of the building height; the
// pill box's lid and printed band were capped and its roof mark stood half its
// own width off centre; and the tape dispenser's housing filled the box where
// the demo steps it back to `h * 0.26`.
//
// (The school was an ABACUS then. It is three stacked archive boxes now — the
// developer's call, 「算盤有點沒辦法表現出學校」 — so those first two entries are
// history rather than live findings. They are kept because they are the clearest
// statement of what this check is for: every one of them was a re-derivation
// that looked right.)
//
// TWO TIERS, decided by whether the demo's builder takes a size — here all four
// are `f(w, d, h, rng)`, so all four get the EXACT tier. They are swept over a
// grid of footprints (the demo's own dims AND sizes the real route produces),
// because one footprint is not a check: a pitch like `round(w / 1.9)` comes out
// right at a single width by luck, which is exactly how a re-derived pitch
// survives. The fifth body, the eraser, is not here — it returns null from
// `buildBuildingBoxes` (its rubber block cannot be one unit template, see
// `paperBodyParts`) and its geometry is already the demo's `eraserBodyGeo`.
//
// ⚠ Bucketed by (COLOUR, TEMPLATE), not by index: the demo's `batchGroup()`
// flushes one InstancedMesh per (geometry, material) pair, so index-to-index
// comparison fails on a body that is correct. And rotations are compared as
// QUATERNIONS — see `RefPart.q`.

interface PaperDemoBodies {
  flagDispenser: (w: number, d: number, h: number, rng: () => number) => THREE.Group;
  tapeDispenser: (w: number, d: number, h: number, rng: () => number) => THREE.Group;
  fileBoxSchool: (w: number, d: number, h: number, rng: () => number) => THREE.Group;
  pillBox: (w: number, d: number, h: number, rng: () => number) => THREE.Group;
  geos: Record<string, THREE.BufferGeometry>;
  /** Every `mountSign(...)` the demo's builders made, in order — the demo's own
   *  decision about WHERE its sign hangs, recorded by the stub that stands in
   *  for the sign carrier. The school is the one body that overrides the default
   *  height, so this is where "on the lid rim" is checkable. */
  signCalls: {
    zone: string; text: string | null;
    w: number; d: number; h: number;
    y: number | undefined; out: number | undefined;
  }[];
  /** Every `nightLit(mat, '#hex')` the demo's material block ran, as (the
   *  material's own plain colour, the glow). That is route A — "the light IS one
   *  of the body's own materials" — and it is the only place the demo says WHICH
   *  of the four bezel colours is the one that glows. */
  nightLitCalls: { color: string; glow: string }[];
}

/**
 * Run the demo's four zone builders for real.
 *
 * The materials are stubs that INTERN by the demo's own plain-mode hex, which
 * does two jobs at once: it keeps the demo's material IDENTITY (same colour →
 * same object, which is what decides how `batchGroup` buckets and therefore what
 * order parts come out in), and it leaves the demo's own source text as the
 * authority on the palette instead of this file.
 */
function loadPaperDemoBodies(src: string): PaperDemoBodies {
  const at = (needle: string): number => {
    const i = src.indexOf(needle);
    if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  /** From the start of `from` to the end of the line that starts `toEndOfLine`. */
  const run = (from: string, toEndOfLine = from): string =>
    src.slice(at(from), src.indexOf('\n', at(toEndOfLine)));
  /** A `const x = shared(…, () => { … });` declaration, whose arrow body ends on
   *  the demo's own `  });`. */
  const sharedConst = (from: string): string => {
    const a = at(from);
    return src.slice(a, src.indexOf('\n  });', a) + '\n  });'.length);
  };

  const demoSrc = [
    run('const SHARED_GEO = new Set();', 'const geoCache = new Map();'),
    sliceDemoFn(src, 'shared'),
    // unitBox / unitCyl / unitCone / unitSphere / unitPlane / unitDisc: the demo
    // declares them as one run, so they are taken as one run.
    run("const unitBox = shared('box'", "const unitDisc = shared('disc'"),
    sliceDemoFn(src, 'box'),
    sliceDemoFn(src, 'batchGroup'),
    // The sleeve's kraft and its ink — the shopfront's door is drawn in the ink.
    run('const sleeveMat = toon(', 'const sleeveInkMat = toon('),
    // unitTooth. (`unitBead` retired with the abacus — the school is three
    // stacked file boxes now and every part of it is a cube.)
    sharedConst("const unitTooth = shared('tooth'"),
    sharedConst("const unitTri = shared('tri'"),
    // Every zone material, `cartonMat` down to `pillCellLitMat`.
    run('const cartonMat = swappable',
      "swappable(toon({}), PILL_CELL_PLAIN, PILL_CELL_PAINT), '#c9a45c');"),
    run('const SHOP_NAMES = '),
    // The school's stack count, lid section and lid overhang.
    run('const TIERS = ', 'const LID_OUT = '),
    sliceDemoFn(src, 'tabLip'),
    sliceDemoFn(src, 'flagDispenser'),
    sliceDemoFn(src, 'tapeDispenser'),
    sliceDemoFn(src, 'fileBoxSchool'),
    sliceDemoFn(src, 'redCross'),
    sliceDemoFn(src, 'pillBox'),
    'return { flagDispenser, tapeDispenser, fileBoxSchool, pillBox, geos: {'
    + ' tooth: unitTooth, tri: unitTri,'
    + ' roll: unitCyl(18), hub: unitCyl(12) } };',
  ].join('\n');

  const stubMats = new Map<string, THREE.Material>();
  const intern = (color: string): THREE.Material => {
    const key = color.toLowerCase();
    let m = stubMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial();
      m.userData.recColor = key;
      stubMats.set(key, m);
    }
    return m;
  };
  const toon = (opts: { color?: string } = {}) => intern(opts.color ?? '#ffffff');
  const swappable = (mat: THREE.Material, plain: { color?: string }) =>
    intern(plain?.color ?? (mat.userData.recColor as string) ?? '#ffffff');
  const nightLitCalls: PaperDemoBodies['nightLitCalls'] = [];
  const nightLit = (mat: THREE.Material, glow: string) => {
    nightLitCalls.push({ color: String(mat.userData.recColor), glow });
    return mat;
  };
  // Everything the demo's material declarations reach for that is a TEXTURE or a
  // paint-mode colour. All of it belongs to the second, PAINTED state, which has
  // no counterpart in `packages/` (`swappable` appears 0 times there — see
  // plan/migrate-demo-worlds.md §4); the arguments still have to evaluate, so
  // they are stubbed rather than sliced.
  const rep = () => null;
  const gouacheTexture = () => null;
  const washColor = (hex: string) => hex;
  const paintProxy = new Proxy({}, { get: () => '#000000' });
  // `Math` shim, not the global: three burns 4 `Math.random` draws per object
  // uuid, so a shared stream could never line up. These builders draw through
  // the `rng` they are handed — which is the PORT's own stream, so that keying
  // is itself part of what is checked.
  const demoMath = Object.create(Math) as Math;

  // The sign carrier is stubbed (its glyphs are `sign-spec.ts`'s job and are
  // checked there), but WHERE the demo asks for the sign is a decision of the
  // body, so the stub RECORDS the call instead of swallowing it. The school
  // passes an explicit height and standoff — its label goes on the middle
  // archive box's lid rim — and nothing else in this file would see that.
  const signCalls: PaperDemoBodies['signCalls'] = [];
  const mountSign = (
    _grp: unknown, zone: string, text: string | null,
    w: number, d: number, h: number, y?: number, out?: number,
  ) => {
    signCalls.push({ zone, text, w, d, h, y, out });
    return null;
  };

  const built = new Function(
    'THREE', 'Math', 'toon', 'swappable', 'nightLit', 'rep', 'gouacheTexture',
    'washColor', 'PAINT', 'kraftNeutral', 'stickyNeutral', 'corrTex', 'washBody',
    'washProp', 'gradientMap', 'mountSign',
    demoSrc,
  )(
    THREE, demoMath, toon, swappable, nightLit, rep, gouacheTexture,
    washColor, paintProxy, null, null, null, null, null, null, mountSign,
  ) as PaperDemoBodies;
  // Attached OUTSIDE the demo's own source: `signCalls` is this file's
  // recorder, not something the demo knows about.
  built.signCalls = signCalls;
  built.nightLitCalls = nightLitCalls;
  return built;
}

async function checkPaperBodiesVsDemo(): Promise<void> {
  console.log('\n[zone bodies vs demo — cuphead (corrugated paper)]');
  const strategy = createPaperTerrainStyle();
  const src = readFileSync('plan/paper-town-demo.html', 'utf8');
  const demo = loadPaperDemoBodies(src);

  check('demo still declares the four decomposable zone bodies',
    typeof demo.flagDispenser === 'function' && typeof demo.tapeDispenser === 'function'
    && typeof demo.fileBoxSchool === 'function' && typeof demo.pillBox === 'function');

  // ── The templates, against the demo's own shared geometry ────────────────
  //
  // A part-for-part diff compares SCALES, so on its own it is blind to what is
  // being scaled — and the tooth, the bead, the triangle and the roll were all
  // wrong before this port. Vertex for vertex, in order, against the geometry
  // the demo instances.
  for (const [shape, ref] of Object.entries(demo.geos)) {
    const tmpl = strategy.buildPartTemplate?.(shape);
    const a = tmpl?.getAttribute('position') as THREE.BufferAttribute | undefined;
    const b = ref.getAttribute('position') as THREE.BufferAttribute;
    let worst = Infinity;
    if (a && a.count === b.count) {
      worst = 0;
      for (let i = 0; i < a.count * 3; i++) {
        worst = Math.max(worst, Math.abs(
          (a.array as ArrayLike<number>)[i] - (b.array as ArrayLike<number>)[i]));
      }
    }
    check(`template '${shape}' is the demo's geometry, vertex for vertex`,
      worst < 1e-6,
      `${a?.count ?? 0} verts vs demo ${b.count}`
      + (worst < Infinity ? `, max Δ ${worst.toExponential(1)}` : ''));
  }

  // ── Naming a geometry on either side of the fence ────────────────────────
  const demoShapeName = (g: THREE.BufferGeometry): string => {
    for (const [name, ref] of Object.entries(demo.geos)) if (ref === g) return name;
    return 'box';
  };
  const portTemplates = new Map<THREE.BufferGeometry, string>();
  for (const shape of Object.keys(demo.geos)) {
    const t = strategy.buildPartTemplate?.(shape);
    if (t) portTemplates.set(t, shape);
  }
  const portShapeName = (g: THREE.BufferGeometry): string => portTemplates.get(g) ?? 'box';

  // Scales, NOT extents. The demo's `unitTri` spans 0.97 in y and its `unitTooth`
  // hangs from y = 0 down to −1, so "bounding extent × instance scale" is not
  // what either side means by a part's size. `BoxPart.w/h/d` IS the instance
  // scale, and the templates themselves are pinned above.
  const spanOne = (): THREE.Vector3 => new THREE.Vector3(1, 1, 1);
  const demoAll = (grp: THREE.Group): RefPart[] => [
    ...demoMeshParts(grp, spanOne, demoShapeName, true),
    ...demoParts(grp, spanOne, demoShapeName),
  ];

  /**
   * The port's whole building: the instanced body PLUS the trim.
   *
   * The trim has to be in here or the comparison would be against half a
   * building — the demo's `tapeDispenser` builds its steel bands, serration and
   * glowing hubs in the same group as its base, and it is the hub that was
   * twice the size it should be. The split is the port's (a part needing its own
   * material cannot ride the body's one vertex-coloured material); which side of
   * it a part is on is not something the demo has an opinion about.
   */
  const portAll = (box: BuildingBox, seed: number, zone: ZoneKind): RefPart[] => {
    // `?? []` and not `!`: the eraser answers NULL here (its body is on the
    // merge path) and everything it wears is trim, so an empty box list is the
    // right answer rather than a missing one.
    const out = portParts(strategy.buildBuildingBoxes?.(box, seed, zone) ?? [], true);
    const deco = strategy.buildBuildingDecoration(box, seed, zone);
    if (!deco) return out;
    deco.updateMatrixWorld(true);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const e = new THREE.Euler();
    deco.traverse((o) => {
      const inst = o as THREE.InstancedMesh;
      if (!inst.isInstancedMesh) return;
      const color = `#${(inst.material as THREE.MeshBasicMaterial).color.getHexString()}`;
      const shape = portShapeName(inst.geometry);
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        m.premultiply(inst.matrixWorld);
        m.decompose(p, q, s);
        e.setFromQuaternion(q);
        out.push({
          x: p.x, y: p.y, z: p.z,
          w: s.x, h: s.y, d: s.z,
          rx: e.x, ry: e.y, rz: e.z,
          color, shape, q: q.clone(),
        });
      }
    });
    // Instance TEMPLATES are strategy-owned singletons that outlive the chunk;
    // freeing one here would empty the cache for every later building.
    deco.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && g.userData.instanceTemplate !== true) g.dispose();
    });
    return out;
  };

  // ── Which of the five did the 80/20 zone roll land on? ────────────────────
  //
  // By the SHAPE VOCABULARY of the parts, not by counting them: the roll belongs
  // to the tape dispenser, the triangle to the pill box, and the tooth to the tab
  // dispenser (its angled front lip). Null is the eraser, and the file-box school
  // is what is left — since it retired the abacus's bead it is made of cubes
  // ALONE, which is exactly why the last line is a positive test (`only cubes`)
  // rather than a fallthrough that would also swallow a body that lost its
  // shapes by accident.
  const kindOf = (probe: BuildingBox, seed: number, zone: ZoneKind): string => {
    const parts = strategy.buildBuildingBoxes?.(probe, seed, zone);
    if (!parts) return 'eraser';
    const shapes = new Set(parts.map((p) => p.shape ?? 'box'));
    if (shapes.has('roll')) return 'tape';
    if (shapes.has('tri')) return 'pill';
    if (shapes.has('tooth')) return 'shop';
    if (shapes.size === 1 && shapes.has('box')) return 'fileBox';
    return '?';
  };
  const seedFor = (box: BuildingBox, zone: ZoneKind, kind: string): number => {
    for (let s = 0; s < 256; s++) if (kindOf(box, s, zone) === kind) return s;
    return -1;
  };
  const boxAt = (w: number, d: number, h: number): BuildingBox => ({
    cx: 0, cz: 0, width: w, depth: d, rotY: 0, height: h, baseY: 0, skirt: 0, color: 0,
  });

  /** Sweep one builder over a grid of footprints, exact at every one. */
  const sweep = (
    label: string,
    kind: string,
    zone: ZoneKind,
    build: (w: number, d: number, h: number, rng: () => number) => THREE.Group,
    boxes: readonly (readonly [number, number, number])[],
    opts: {
      stream?: (seed: number) => () => number;
      /** Dropped from OUR side only — for a part the port adds. */
      dropPort?: (p: RefPart) => boolean;
      /** Dropped from BOTH sides — for a part whose deviation is asserted
       *  elsewhere, so the rest of the body can still be compared exactly. */
      drop?: (p: RefPart) => boolean;
    } = {},
  ): void => {
    let worstAll = 0;
    let firstBad = '';
    let compared = 0;
    for (const [w, d, h] of boxes) {
      const box = boxAt(w, d, h);
      const seed = seedFor(box, zone, kind);
      if (seed < 0) {
        firstBad = `no seed in 256 rolls ${kind} at ${w}x${d}x${h}`;
        worstAll = Infinity;
        break;
      }
      let ours = portAll(box, seed, zone);
      if (opts.dropPort) ours = ours.filter((p) => !opts.dropPort!(p));
      if (opts.drop) ours = ours.filter((p) => !opts.drop!(p));
      const grp = build(w, d, h, opts.stream ? opts.stream(seed) : () => 0.5);
      let theirs = demoAll(grp);
      if (opts.drop) theirs = theirs.filter((p) => !opts.drop!(p));
      const { worst, where } = partsDiff(theirs, ours);
      compared++;
      if (worst > worstAll) { worstAll = worst; firstBad = `${w}x${d}x${h}: ${where}`; }
    }
    check(label, compared === boxes.length && worstAll < EXACT_TOL,
      worstAll < EXACT_TOL
        ? `${compared} footprints, max Δ ${worstAll.toExponential(1)}`
        : firstBad);
  };

  // The demo's `buildingDims` ranges, plus footprints the real route actually
  // produces — MEASURED with `BOXSTATS=1` on the saved Taipei route: commercial
  // w 7.3–70 / d 3.1–55 / h 5–48, industrial w 2.5–66 / d 1.5–46 / h 0–70,
  // school w 8.2–82 / d 4.7–76 / h 5–19.
  // The port's own per-building stream, drawn once per pulled tab and once per
  // lid tab, in the demo's order. Re-key it and every tab's length and tilt
  // moves; this catches that.
  const shopStream = (seed: number) => mulberry32((seed * 3266489917 + 0x51c3) >>> 0);

  // ONE sweep, short buildings and tall ones together. The commercial body used
  // to need two — the awning's `k` ceiling was a port deviation, so tall shops
  // were compared with the awning dropped from both sides — and the tab
  // dispenser that replaced it deviates nowhere, so the tall footprints are
  // compared exactly like the short ones. The route's commercial boxes have a
  // MEASURED median height of 41 m; checking only the demo's own 6.5–9 m range
  // would be checking almost none of them.
  sweep('tab dispenser: carton, lid, window band, angled lip, pulled tabs and the '
    + 'lid\'s row are the demo\'s (short and tall, exactly)',
    'shop', 'commercial', demo.flagDispenser,
    [
      [12, 8, 6.5], [14.5, 9, 7.75], [17, 10, 9],       // the demo's own range
      [7.3, 3.1, 5], [4, 4, 4], [9.5, 5, 8], [30, 14, 9], [70.4, 55.2, 6.5],
      [30, 14, 20], [57.9, 25.4, 41], [70.4, 55.2, 48], [23, 7, 12], [39, 19, 31],
    ],
    { stream: shopStream });

  // ⚠ INDUSTRIAL is swept only where w ≥ h. That is the one PROPORTION this port
  // changes and it is stated rather than blended in: the demo's roll radius is
  // `h * 0.30`, the port's is `min(w, h) * 0.30`. Measured medians on the saved
  // Taipei route are w 17.0 m against h 33.0 m where the demo's own industrial
  // box is w ≈ h, so a height-only radius asks for a 19.8 m roll on a 17 m
  // building. Where w ≥ h the two formulas ARE the same formula and the
  // comparison is exact; the deviation itself is asserted below.
  sweep('tape dispenser: base, stepped housing, rolls, steel and hubs are the demo\'s',
    'tape', 'industrial', demo.tapeDispenser,
    [
      [11, 9, 11], [12.5, 10.2, 12.5], [14, 11.5, 14],  // the demo's own range
      [20, 8, 12], [45, 20, 30], [65.9, 45.6, 40], [8, 4, 6], [33, 17, 33],
      [2.5, 1.5, 1], [17, 8, 17],
    ]);

  // The school's ONE rng draw is `c0 = floor(rng() * 4)`, the colour the bottom
  // box's bezels wear (the other two follow it round the palette). Re-key that
  // stream and every ring on every school changes colour AND the night light
  // moves to a different floor, so the stream is swept rather than pinned with a
  // constant: `() => 0.5` would only ever exercise `c0 = 2`.
  const schoolStream = (seed: number) => mulberry32((seed * 2654435761 + 0x71c3) >>> 0);

  sweep('file box school: three stacked boxes, their lids, and every handle '
    + 'recess and bezel bar are the demo\'s',
    'fileBox', 'school', demo.fileBoxSchool,
    [
      [15, 6, 9], [17, 6.8, 10], [19, 7.6, 11],         // the demo's own range
      [8.2, 4.7, 5], [39.3, 20.3, 12], [82, 76, 19], [6, 3, 4], [26, 9, 15],
      [12, 12, 12], [23, 5, 7],
      // ⚠ 32 and 76 are here for the HANDLE PITCH and nothing else. Every other
      // width above rounds the same whether the pitch is 22 m or 21, so a
      // mutation of `round(w / 22)` survived the whole grid — measured, not
      // guessed. `round(32 / 22) = 1` against `round(32 / 21) = 2`, and
      // `round(76 / 22) = 3` against `round(76 / 21) = 4`, so the two straddle
      // the step in both directions.
      [32, 12, 10], [76, 30, 16],
    ],
    { stream: schoolStream });

  // ⚠ The port adds ONE part the demo does not have — a fifth mark on the +z
  // face, because a gameview hospital usually carries no sign to put the symbol
  // on (see `pillBoxParts`). It is the only `tri` at positive z, which is how it
  // is dropped here without counting indices; that it EXISTS is asserted below,
  // so dropping it cannot quietly become deleting it.
  sweep('pill box: lid compartments, printed band and the demo\'s four marks',
    'pill', 'hospital', demo.pillBox,
    [
      [8, 7, 12], [9, 7.8, 14], [10, 8.6, 16],          // the demo's own range
      [4, 3, 5], [22, 11, 28], [48, 30, 60], [2.5, 1.5, 2], [15, 9, 40],
      [30, 30, 30], [6, 12, 9],
    ],
    { dropPort: (p) => p.shape === 'tri' && p.z > 0 });

  // ══ The fifth body: the eraser ══
  //
  // It is the one that does NOT decompose (its rubber block is a bevelled
  // extrusion with a per-vertex wear rake — see `paperBodyParts`), so it is
  // compared in two halves instead: the block against the demo's
  // `eraserBodyGeo` VERTEX FOR VERTEX, and everything wrapped round it against
  // the demo's `eraserHouse` part for part.
  //
  // Its three "variants" are three SIZES of one model — the demo's residential
  // row of `buildingDims` is `[[9,9,9],[10,10,20],[13,9,7]]` — so all three are
  // swept here and there is no fourth thing to port.
  {
    const at = (needle: string): number => {
      const i = src.indexOf(needle);
      if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
      return i;
    };
    const run = (from: string, toEndOfLine = from): string =>
      src.slice(at(from), src.indexOf('\n', at(toEndOfLine)));
    /** A `const x = shared(…, () => { … });` declaration — same helper as
     *  `loadPaperDemoBodies`, needed here since `unitBead` retired and
     *  `unitTooth` no longer has a following one-liner to end a `run` on. */
    const sharedConst = (from: string): string => {
      const a2 = at(from);
      return src.slice(a2, src.indexOf('\n  });', a2) + '\n  });'.length);
    };
    const stubMats = new Map<string, THREE.Material>();
    const intern = (color: string): THREE.Material => {
      const key = color.toLowerCase();
      let m = stubMats.get(key);
      if (!m) {
        m = new THREE.MeshBasicMaterial();
        m.userData.recColor = key;
        stubMats.set(key, m);
      }
      return m;
    };
    const eraserSrc = [
      run('const SHARED_GEO = new Set();', 'const geoCache = new Map();'),
      sliceDemoFn(src, 'shared'),
      run("const unitBox = shared('box'", "const unitDisc = shared('disc'"),
      sliceDemoFn(src, 'rectShape'),
      sliceDemoFn(src, 'box'),
      sliceDemoFn(src, 'batchGroup'),
      sharedConst("const unitTooth = shared('tooth'"),
      // ERASER_COLORS + eraserBodyMats + sleeveMat + sleeveInkMat, then the red
      // film and the crayon frame, then the two sleeve constants.
      run('const ERASER_COLORS = ', 'const sleeveInkMat = toon('),
      run('const eraserBandMat = nightLit(', '  }), \'#ff5a44\');'),
      run('const crayonWinMat = new THREE.MeshToonMaterial({',
        '    transparent: true, alphaTest: 0.3, side: THREE.DoubleSide,'),
      '  });',
      run('const SLEEVE_FRAC = ', 'const SLEEVE_T = '),
      sliceDemoFn(src, 'eraserBodyGeo'),
      sliceDemoFn(src, 'eraserBody'),
      sliceDemoFn(src, 'eraserHouse'),
      'return { eraserHouse, eraserBodyGeo, ERASER_COLORS, tooth: unitTooth };',
    ].join('\n');

    const toon = (opts: { color?: string } = {}) => intern(opts.color ?? '#ffffff');
    const swappable = (mat: THREE.Material, plain: { color?: string }) =>
      intern(plain?.color ?? (mat.userData.recColor as string) ?? '#ffffff');
    // A material the demo never routes through `swappable` still has to be
    // recognisable by colour: `nightLit` is where the red film arrives, and it
    // arrives as a real MeshPhongMaterial.
    const nightLit = (mat: THREE.Material) => (mat.userData.recColor
      ? mat
      : intern(`#${(mat as THREE.MeshPhongMaterial).color.getHexString()}`));
    const demoEraser = new Function(
      'THREE', 'Math', 'toon', 'swappable', 'nightLit', 'rep', 'gouacheTexture',
      'washColor', 'kraftNeutral', 'washBody', 'gradientMap', 'crayonWindowTexture',
      eraserSrc,
    )(
      THREE, Object.create(Math) as Math, toon, swappable, nightLit,
      () => null, () => null, (h: string) => h, null, null, null, () => null,
    ) as {
      eraserHouse: (w: number, d: number, h: number, ci: number) => THREE.Group;
      eraserBodyGeo: (w: number, d: number, h: number) => THREE.BufferGeometry;
      ERASER_COLORS: string[];
      tooth: THREE.BufferGeometry;
    };
    // Its own namer: this is a SECOND `new Function` instance, so its
    // `unitTooth` is a different object from the one the zone bodies compare
    // against and the shared `demoShapeName` would call the sleeve's chevrons
    // boxes. (That mismatch is what this check reported first time out.)
    const eraserShape = (g: THREE.BufferGeometry): string =>
      (g === demoEraser.tooth ? 'tooth' : 'box');
    const eraserDemoAll = (grp: THREE.Group): RefPart[] => [
      ...demoMeshParts(grp, spanOne, eraserShape, true),
      ...demoParts(grp, spanOne, eraserShape),
    ];

    // The demo's own residential dims table, all three rows.
    const VARIANTS: [number, number, number][] = [[9, 9, 9], [10, 10, 20], [13, 9, 7]];
    let worstVert = 0;
    let vertWhere = '';
    let worstPart = 0;
    let partWhere = '';
    let swept = 0;
    for (const [w, d, h] of VARIANTS) {
      const box = boxAt(w, d, h);
      const seed = seedFor(box, 'residential', 'eraser');
      if (seed < 0) { vertWhere = `no seed rolls the eraser at ${w}x${d}x${h}`; worstVert = Infinity; break; }
      swept++;

      // ── The rubber block ──
      const ours = strategy.buildBuildingBody!(box, seed, 'residential')!;
      const theirs = demoEraser.eraserBodyGeo(w, d, h);
      const a = ours.getAttribute('position') as THREE.BufferAttribute;
      const b = theirs.getAttribute('position') as THREE.BufferAttribute;
      if (a.count !== b.count) {
        worstVert = Infinity;
        vertWhere = `${w}x${d}x${h}: ${a.count} verts vs demo ${b.count}`;
      } else {
        for (let i = 0; i < a.count * 3; i++) {
          const dv = Math.abs((a.array as ArrayLike<number>)[i] - (b.array as ArrayLike<number>)[i]);
          if (dv > worstVert) { worstVert = dv; vertWhere = `${w}x${d}x${h}: vertex ${i / 3 | 0}`; }
        }
      }
      ours.dispose();

      // ── The paper sleeve round it ──
      // The demo's group carries the rubber block too; it is dropped by COLOUR
      // (the six `ERASER_COLORS`), which is also a statement that the port's
      // sleeve must not be painted in any of them.
      const grp = demoEraser.eraserHouse(w, d, h, seed);
      const skins = new Set(demoEraser.ERASER_COLORS.map((c) => c.toLowerCase()));
      // Anything the demo built without going through `swappable`/`nightLit`
      // still has a colour — take it off the material rather than leave the
      // bucket key undefined.
      grp.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && !m.userData.recColor && m.color) {
          m.userData.recColor = `#${m.color.getHexString()}`;
        }
      });
      const dParts = eraserDemoAll(grp).filter((p) => !skins.has(p.color));
      const oParts = portAll(box, seed, 'residential')
        .filter((p) => !skins.has(p.color));
      const { worst, where } = partsDiff(dParts, oParts);
      if (worst > worstPart) { worstPart = worst; partWhere = `${w}x${d}x${h}: ${where}`; }
    }
    check('eraser: the rubber block is the demo\'s eraserBodyGeo, vertex for vertex '
      + '(bevel, extrusion inset and the worn top rake)',
      swept === VARIANTS.length && worstVert < 1e-5,
      worstVert < 1e-5 ? `${swept} variants, max Δ ${worstVert.toExponential(1)}` : vertWhere);
    check('eraser: sleeve, chevrons, printed rule, red film and the printed frames '
      + 'are the demo\'s',
      swept === VARIANTS.length && worstPart < EXACT_TOL,
      worstPart < EXACT_TOL ? `${swept} variants, max Δ ${worstPart.toExponential(1)}` : partWhere);
  }

  // ── The surviving deviations, each pinned as the rule it is ──────────────
  {
    // 1. The extra hospital mark. Dropped from the diff above, so it needs its
    //    own assertion or "the port matches the demo" would also be true of a
    //    port that had quietly lost it.
    let seen = 0;
    let mismatched = 0;
    for (const [w, d, h] of [[9, 7.8, 14], [22, 11, 28], [4, 3, 5]] as const) {
      const box = boxAt(w, d, h);
      const seed = seedFor(box, 'hospital', 'pill');
      if (seed < 0) continue;
      const parts = strategy.buildBuildingBoxes!(box, seed, 'hospital')!;
      const front = parts.filter((p) => p.shape === 'tri' && (p.z ?? 0) > 0);
      const back = parts.filter((p) => p.shape === 'tri' && (p.z ?? 0) < 0);
      seen += front.length;
      // Same size and height as the demo's −z mark, mirrored across the box.
      if (front.length !== 1 || back.length !== 1
        || Math.abs(front[0].w - back[0].w) > 1e-9
        || Math.abs(front[0].y - back[0].y) > 1e-9
        || Math.abs(front[0].z + back[0].z) > 1e-9) mismatched++;
    }
    check('pill box: the port\'s extra mark faces +z and mirrors the demo\'s −z one '
      + '(only one hospital per district is signed here, so a bare street face says nothing)',
      seen === 3 && mismatched === 0, `${seen} front marks, ${mismatched} mismatched`);
  }

  {
    // 2. The roll radius. `min(w, h) * 0.30` rather than the demo's `h * 0.30`,
    //    and the rule it buys: a roll must not be wider than the machine under
    //    it. The demo's own `x = -w * 0.20` with radius `0.30 w` puts the outer
    //    edge exactly ON the −x face, so "never past it" is the tightest true
    //    statement and it binds at w ≤ h — which is 3 industrial footprints in 4
    //    on this route.
    let worstOver = -Infinity;
    let tested = 0;
    for (const [w, d, h] of [[17, 8, 33], [2.5, 1.5, 70], [10, 10, 40], [65.9, 45.6, 12]] as const) {
      const box = boxAt(w, d, h);
      const seed = seedFor(box, 'industrial', 'tape');
      if (seed < 0) continue;
      for (const p of strategy.buildBuildingBoxes!(box, seed, 'industrial')!) {
        if (p.shape !== 'roll') continue;
        tested++;
        worstOver = Math.max(worstOver, Math.abs(p.x) + p.w / 2 - Math.max(1, w) / 2);
      }
    }
    check('tape dispenser: a roll never overhangs the machine it sits on '
      + '(the demo sizes it off the height alone; this route\'s boxes are twice as tall as they are wide)',
      tested >= 8 && worstOver <= 1e-9,
      `${tested} rolls, worst overhang ${worstOver.toFixed(4)} m`);
  }

  {
    // 3. The lip's reach. `trimBoxOffRoute` keeps every box FACE at least
    //    ROUTE_CLEARANCE_M = 4 m from the ridden line, so what has to hold is
    //    that the outermost point of anything hung on the facade still clears
    //    it. On this body that is a pulled tab: `0.2 + len` past the face at
    //    `len = (1.1 + rng) * k`, plus the lip's own `1.6 k * cos`.
    //
    //    Split by HEIGHT, because "how far does it stick out" is the wrong
    //    question on its own: the lip on a 20 m block hangs 6.8 m up, where
    //    nothing can ride into it however far it reaches, while the one on a
    //    6.5 m building hangs at 2.2 m and is the only one that can be hit. The
    //    chase camera's eye is 6.3 m up (`fps-camera.ts` CHASE_UP) and the rider
    //    is under it, so RIDER_H = 3 m is the band that has to stay clear.
    //
    //    Asserted with the NUMBERS rather than by keeping a cap: a cap stops
    //    being right the moment somebody changes `k`, and a measurement does not.
    //    This is what the retired awning needed its own `k` ceiling for — it
    //    reached 3.15 m at `k = 1` and 3.54 m at the demo's own 1.15, which is
    //    0.46 m from the rider at chest height. The lip reaches less than half
    //    that, which is the point of it being a lip and not a canopy.
    const CLEARANCE_M = 4;
    const RIDER_H = 3;
    let worstReach = 0;
    let worstLow = 0;
    let where = '';
    let lowWhere = '';
    for (const [w, d, h] of [[12, 8, 6.5], [14.5, 9, 7.75], [17, 10, 9], [23, 7, 12],
      [30, 14, 20], [70.4, 55.2, 48]] as const) {
      const box = boxAt(w, d, h);
      const seed = seedFor(box, 'commercial', 'shop');
      if (seed < 0) continue;
      for (const p of strategy.buildBuildingBoxes!(box, seed, 'commercial')!) {
        // Half-extents of a box turned about its own x, plus its centre.
        const c = Math.abs(Math.cos(p.rotX ?? 0));
        const s2 = Math.abs(Math.sin(p.rotX ?? 0));
        const reach = Math.abs(p.z) + (p.d / 2) * c + (p.h / 2) * s2 - d / 2;
        const bottom = p.y - (p.h / 2) * c - (p.d / 2) * s2;
        if (reach > worstReach) { worstReach = reach; where = `${w}x${d}x${h}`; }
        if (bottom < RIDER_H && reach > worstLow) { worstLow = reach; lowWhere = `${w}x${d}x${h}`; }
      }
    }
    check('tab dispenser: nothing on the facade crosses the line the rider is on, at any height',
      worstReach > 1 && worstReach < CLEARANCE_M,
      `worst reach past the facade ${worstReach.toFixed(2)} m on ${where}, `
      + `leaving ${(CLEARANCE_M - worstReach).toFixed(2)} m of the ${CLEARANCE_M} m the renderer keeps`);
    // Half a road bike's handlebars is ~0.21 m and the rider's shoulders about
    // the same, so 0.6 m is "the lip passes outside the rider" with a bit in
    // hand. The awning this replaced read 0.89 m at `k = 1` and 0.46 m at the
    // demo's own 1.15 — a hit at chest height, and the whole reason that body
    // needed a ceiling the demo did not have.
    check('tab dispenser: and at RIDER height the lip and its tabs pass outside the rider '
      + '— the number the retired awning had to have its k ceiling cut for',
      worstLow > 0 && CLEARANCE_M - worstLow > 0.6,
      `worst reach below ${RIDER_H} m is ${worstLow.toFixed(2)} m on ${lowWhere}, `
      + `leaving ${(CLEARANCE_M - worstLow).toFixed(2)} m`);
  }

  {
    // ══ Where the commercial district's light actually lands ══
    //
    // The panes on the window band used to carry it, and a row of lit panes is
    // an office block at dusk however the source names them. The developer moved
    // it onto the tabs. Both halves of that are asserted, and BY EXECUTION:
    //
    //   · the demo night-lights the four TAB colours and no longer the pane;
    //   · every quad the port declares sits on the FACE of a tab that is
    //     actually there — the right face, the right size, the right way round.
    //
    // The second half is the one worth having. A light quad carries a full
    // rotation now (`WindowPlacement.rotX/rotZ`, added for this body), and a
    // rotation composed the wrong way round still produces quads in roughly the
    // right place — a screenshot cannot tell, and the failure at night is a
    // glowing rectangle hanging edge-on beside the tab. So each quad is pushed
    // back into its host tab's LOCAL frame and has to come out flat on one face.
    const probe: BuildingBox = { ...boxAt(23, 12, 22), skirt: 0 };
    const seed = seedFor(probe, 'commercial', 'shop');
    const parts = strategy.buildBuildingBoxes?.(probe, seed, 'commercial') ?? [];
    const quads = strategy.buildBuildingLights?.(probe, seed, 'commercial') ?? [];
    /** The lift the style floats a quad off the face it lights. */
    const LIFT = 0.03;
    const TOL = 1e-6;
    const qPos = new THREE.Vector3();
    const qNrm = new THREE.Vector3();
    const pPos = new THREE.Vector3();
    const pQuat = new THREE.Quaternion();
    const inv = new THREE.Quaternion();
    const local = new THREE.Vector3();
    const hosts: string[] = [];
    let orphan = 0;
    let badFace = '';
    for (const q of quads) {
      qPos.set(q.x, q.y, q.z);
      qNrm.set(0, 0, 1).applyQuaternion(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(q.rotX ?? 0, q.rotY, q.rotZ ?? 0)));
      let host: typeof parts[number] | null = null;
      for (const pt of parts) {
        if (pt.shape) continue;                       // the lip is a tooth, not a tab
        pPos.set(pt.x, pt.y, pt.z);
        pQuat.setFromEuler(new THREE.Euler(pt.rotX ?? 0, pt.rotY ?? 0, pt.rotZ ?? 0));
        inv.copy(pQuat).invert();
        local.copy(qPos).sub(pPos).applyQuaternion(inv);
        // The quad's normal in the HOST's frame — this is what a mis-composed
        // rotation gets wrong while the position still looks plausible.
        const n = qNrm.clone().applyQuaternion(inv);
        // Face +y (a pulled tab lies flat; its top is what the camera sees)…
        const onTop = Math.abs(local.y - (pt.h / 2 + LIFT)) < 1e-4
          && Math.abs(local.x) <= pt.w / 2 + TOL && Math.abs(local.z) <= pt.d / 2 + TOL
          && n.y > 1 - 1e-6
          && Math.abs(q.w - pt.w) < 1e-9 && Math.abs(q.h - pt.d) < 1e-9;
        // …or face ±z (a standing tab is a panel facing the street).
        const onFace = Math.abs(Math.abs(local.z) - (pt.d / 2 + LIFT)) < 1e-4
          && Math.abs(local.x) <= pt.w / 2 + TOL && Math.abs(local.y) <= pt.h / 2 + TOL
          && Math.abs(n.z) > 1 - 1e-6 && Math.sign(n.z) === Math.sign(local.z)
          && Math.abs(q.w - pt.w) < 1e-9 && Math.abs(q.h - pt.h) < 1e-9;
        if (onTop || onFace) { host = pt; break; }
      }
      if (host) hosts.push(`#${host.color.toString(16).padStart(6, '0')}`);
      else {
        orphan++;
        badFace ||= `quad ${q.w.toFixed(2)}x${q.h.toFixed(2)} at `
          + `(${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}) sits on nothing`;
      }
    }
    const hostSet = [...new Set(hosts)].sort();
    // Both rows, both faces: `n` tabs each. `n` is the style's, read back off the
    // quads rather than recomputed here.
    check('tab dispenser: every light quad sits FLAT ON A FACE of a tab that is '
      + 'actually there — the right face, the right size and facing outward',
      quads.length >= 12 && orphan === 0 && quads.length % 4 === 0
      && hostSet.length === 4,
      orphan ? badFace
        : `${quads.length} quads over ${hostSet.length} tab colours (${hostSet.join(',')}), `
          + `0 orphans`);

    // …and the two sides agree about WHAT lights up. The demo says it with
    // `nightLit(tabMats[i], …)`; the port says it by landing quads on those
    // colours. Compared as MEANING, like the school's bezel above.
    const demoTabLit = demo.nightLitCalls
      .filter((c) => hostSet.includes(c.color.toLowerCase()));
    const glows = [...new Set(demoTabLit.map((c) => c.glow.toLowerCase()))];
    check('demo: all four tab colours are night-lit, and with ONE shared warm '
      + 'glow (four saturated glows would be a fairground)',
      demoTabLit.length === 4 && glows.length === 1,
      `${demoTabLit.length} lit tab colours, glow(s) ${glows.join(',')}`);

    // The half that is easy to forget: the panes must have STOPPED glowing. This
    // is the whole reason the light moved, and without this line the change is
    // "the tabs also glow now" — which still reads as an office block.
    const paneLit = demo.nightLitCalls.filter((c) => c.color.toLowerCase() === '#4d6b7a');
    check('demo: the window panes are NOT night-lit any more — a row of lit panes '
      + 'is an office block, which is the silhouette this district must avoid',
      paneLit.length === 0,
      paneLit.length
        ? `still lit: ${paneLit.map((c) => `${c.color}→${c.glow}`).join(' ')}`
        : `pane #4d6b7a dark at night; lit in this world: ${
          demo.nightLitCalls.map((c) => c.color).join(',')}`);
  }

  {
    // 4. The floors. The demo's formulas have no lower bound, because its own
    //    dims table never produced a small building; the route hands over
    //    `height = 0.0`. Nothing may come out non-finite, zero-scaled or
    //    mirrored: a zero column in an instance matrix is a NaN normal (three
    //    divides by the squared column length), which is a black building in
    //    WebGL and nowhere else, and a negative one draws the part inside out.
    let parts = 0;
    let bad = '';
    const spans: string[] = [];
    for (const zone of ['commercial', 'industrial', 'school', 'hospital'] as const) {
      for (const [w, d, h] of [[0, 0, 0], [0.001, 0.001, 0], [2, 1, 0], [1, 1, 1], [95.8, 67, 0]] as const) {
        const box: BuildingBox = { ...boxAt(w, d, h), skirt: 0.4 };
        for (let seed = 0; seed < 24 && !bad; seed++) {
          for (const p of strategy.buildBuildingBoxes?.(box, seed, zone) ?? []) {
            parts++;
            for (const [k, v] of Object.entries(p)) {
              if (typeof v === 'number' && !Number.isFinite(v)) {
                bad = `${zone} ${w}x${d}x${h} seed ${seed}: ${k} = ${v}`;
              }
            }
            if (!bad && (p.w <= 0 || p.h <= 0 || p.d <= 0)) {
              bad = `${zone} ${w}x${d}x${h} seed ${seed}: extent ${p.w}x${p.h}x${p.d}`;
            }
            if (bad) break;
          }
        }
      }
    }
    check('a zero-height, zero-width footprint still builds finite, positively-scaled parts '
      + '(MVT render_height really is 0.0 on this route)',
      parts > 500 && !bad, bad || `${parts} parts across four zones`);

    // …and it still builds a BUILDING. Flooring the EXTENTS alone would leave a
    // zero-height footprint as a puddle of 0.1 mm parts: nothing NaN, nothing
    // mirrored, and nothing visible either. `MIN_BODY_H` is the separate floor
    // that stops that, and without this line it could be deleted with every
    // other assertion still green (measured: the shortest zero-height body goes
    // from standing 2.13 m to standing 1.30 m, all of it lid and sticky notes
    // with no carton under them).
    //
    // Stated as what a floor MEANS rather than as its value: every height below
    // it must build the SAME body. That stays true if the floor is retuned and
    // false the moment it is removed.
    let floored = 0;
    let notFloored = '';
    for (const zone of ['commercial', 'industrial', 'school', 'hospital'] as const) {
      const ref = boxAt(12, 8, 0);
      const kind = kindOf(ref, 0, zone);
      const at = (h: number) => JSON.stringify(
        strategy.buildBuildingBoxes?.({ ...boxAt(12, 8, h), skirt: 0.4 }, 0, zone) ?? []);
      const a = at(0);
      for (const h of [0.25, 0.5]) {
        if (at(h) === a) floored++;
        else notFloored ||= `${zone} (${kind}) differs between height 0 and ${h}`;
      }
      let top = -Infinity;
      for (const p of strategy.buildBuildingBoxes?.({ ...boxAt(12, 8, 0), skirt: 0.4 }, 0, zone) ?? []) {
        top = Math.max(top, p.y + p.h / 2);
      }
      spans.push(`${zone} ${top.toFixed(2)} m`);
    }
    check('…and it still builds a BUILDING, not a puddle of floored slivers '
      + '(every height under MIN_BODY_H builds the same body)',
      floored === 8 && !notFloored, notFloored || `zero-height bodies stand ${spans.join(', ')}`);
  }

  // ══ The school's identity, now that the abacus is gone ══
  //
  // The demo's zone table used to read 學校 = 木框 + 彩珠(唯一一排排圓形的).
  // Nothing inherited「一排排圓形」when the school became three stacked archive
  // boxes (this world's remaining round things are the tape roll and the pin
  // head, and neither comes in rows), so the demo moved the claim onto two
  // features. BOTH are asserted here instead of being left in a comment, and
  // both are read out of the demo BY RUNNING IT rather than off its source text.
  {
    const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-4;
    /**
     * How many times this body repeats its own MASS: parts whose plan is exactly
     * the footprint, `w × d`.
     *
     * ⚠ The obvious predicate — "identical parts that overhang the footprint",
     * i.e. lid courses — does NOT separate them, and this check failed the first
     * time it ran for exactly that reason: the tape dispenser wears TWO identical
     * steel bands (`box(w + 0.5, 0.5, d + 0.5)` at `hb * 0.34` and `hb * 0.72`).
     * "More than one rim" is therefore not the school's. What IS the school's is
     * that the BODY itself is repeated: three boxes of the full footprint, one on
     * top of another. Every other body in this world has exactly one.
     */
    const masses = (g: THREE.Group, w: number, d: number): number =>
      demoAll(g).filter((p) => near(p.w, w) && near(p.d, d)).length;
    /** …and the lid courses that go with them: `w + 0.7` × `d + 0.7`, the
     *  overhang the abacus's old `cap` already used. */
    const lids = (g: THREE.Group, w: number, d: number): number =>
      demoAll(g).filter((p) => near(p.w, w + 0.7) && near(p.d, d + 0.7)).length;
    const school = [15, 6, 9] as const;
    const stacks = ([[15, 6, 9], [19, 7.6, 11], [39.3, 20.3, 12]] as const)
      .map(([w, d, h]) => {
        const g = demo.fileBoxSchool(w, d, h, () => 0.3);
        return `${masses(g, w, d)}+${lids(g, w, d)}`;
      });
    const others = [
      ['tab dispenser', masses(demo.flagDispenser(14.5, 9, 7.75, () => 0.5), 14.5, 9)],
      ['tape dispenser', masses(demo.tapeDispenser(12.5, 10.2, 12.5, () => 0.5), 12.5, 10.2)],
      ['pill box', masses(demo.pillBox(9, 7.8, 14, () => 0.5), 9, 7.8)],
    ] as const;
    check('demo: the school STACKS — its MASS repeats three times, each under its '
      + 'own lid course, and no other body repeats its mass at all '
      + '(that is what replaced 「一排排圓形」)',
      stacks.every((k) => k === '3+3') && others.every(([, n]) => n === 1),
      `school ${stacks.join('/')} (mass+lids), ${others.map(([k, n]) => `${k} ${n}`).join(', ')}`);

    // ── Half two: the bezel palette belongs to the school alone ──
    //
    // Derived, not transcribed: run the school over all four `c0` draws, and the
    // colours that CHANGE between runs are the bezels (the ones that do not are
    // the box, the lid and the recess). So the four are discovered by execution
    // and a repaint in the demo moves this check with it.
    const runs = [0.1, 0.35, 0.6, 0.85].map(
      (r) => new Set(demoAll(demo.fileBoxSchool(...school, () => r)).map((p) => p.color)));
    const union = new Set<string>();
    for (const r of runs) for (const c of r) union.add(c);
    const constant = [...union].filter((c) => runs.every((r) => r.has(c)));
    const rings = [...union].filter((c) => !runs.every((r) => r.has(c)));
    check('demo: the four bezel colours really are the varying part of the '
      + 'school\'s palette (3 fixed + 4 that follow the per-building draw)',
      constant.length === 3 && rings.length === 4,
      `fixed ${constant.join(',')} | bezels ${rings.join(',')}`);

    const elsewhere = new Set<string>();
    for (const p of demoAll(demo.flagDispenser(14.5, 9, 7.75, () => 0.5))) elsewhere.add(p.color);
    for (const p of demoAll(demo.tapeDispenser(12.5, 10.2, 12.5, () => 0.5))) elsewhere.add(p.color);
    for (const p of demoAll(demo.pillBox(9, 7.8, 14, () => 0.5))) elsewhere.add(p.color);
    const shared = [...union].filter((c) => elsewhere.has(c));
    check('demo: the school\'s whole palette is its own — not one of its seven '
      + 'colours appears on another body',
      union.size === 7 && shared.length === 0,
      shared.length ? `also used elsewhere: ${shared.join(',')}` : `${union.size} colours, 0 shared`);

    // …and the PORT keeps it that way. The sweep above already forces the
    // school's own parts to be the demo's; this is the other direction — a bezel
    // colour leaking onto a shop or a pill box, which no per-body diff would see
    // because it would be diffing the wrong body against the right demo.
    const ringHex = new Set(rings.map((c) => c.toLowerCase()));
    let leaked = '';
    let sawRing = 0;
    for (const zone of ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const) {
      for (let seed = 0; seed < 48 && !leaked; seed++) {
        for (const [w, d, h] of [[15, 6, 9], [39.3, 20.3, 12], [8.2, 4.7, 5]] as const) {
          const probe: BuildingBox = { ...boxAt(w, d, h), skirt: 0.4 };
          const kind = kindOf(probe, seed, zone);
          for (const p of strategy.buildBuildingBoxes?.(probe, seed, zone) ?? []) {
            const hex = `#${p.color.toString(16).padStart(6, '0')}`;
            if (!ringHex.has(hex)) continue;
            if (kind === 'fileBox') sawRing++;
            else leaked = `${hex} on a ${kind} in ${zone}`;
          }
        }
      }
    }
    check('…and no other body in the PORT wears one — the bezel colours are how '
      + 'a school is recognised, so they have to stay exclusive',
      sawRing > 0 && !leaked, leaked || `${sawRing} bezel parts, all on file boxes`);

    // …and the port's FOUR are the demo's four.
    //
    // ⚠ This is not covered by the part-for-part sweep, which was measured: a
    // school wears only THREE of the four (`(c0 + t) % 4` for three tiers), and
    // the sweep takes the first seed that rolls a school at each footprint — on
    // this grid that is one `c0`, so repainting `RING_COLORS[0]` in the port
    // survived every footprint. Asked over enough seeds that all four draws
    // happen, and split the same way the demo side is split: a colour on EVERY
    // school is one of the three fixed ones, a colour on only some of them is a
    // bezel.
    const seenIn = new Map<string, number>();
    let schools = 0;
    for (let seed = 0; seed < 200; seed++) {
      const probe: BuildingBox = { ...boxAt(19, 7.6, 11), skirt: 0 };
      if (kindOf(probe, seed, 'school') !== 'fileBox') continue;
      schools++;
      const here = new Set<string>();
      for (const pt of strategy.buildBuildingBoxes!(probe, seed, 'school')!) {
        here.add(`#${pt.color.toString(16).padStart(6, '0')}`);
      }
      for (const c of here) seenIn.set(c, (seenIn.get(c) ?? 0) + 1);
    }
    const portRings = [...seenIn].filter(([, n]) => n < schools).map(([c]) => c).sort();
    const portFixed = [...seenIn].filter(([, n]) => n === schools).map(([c]) => c);
    check('…and the port\'s four bezel colours ARE the demo\'s four '
      + '(a school wears three of them, so this needs every c0 draw to happen)',
      schools > 20 && portFixed.length === 3
      && portRings.join(',') === [...rings].map((c) => c.toLowerCase()).sort().join(','),
      `${schools} schools: fixed ${portFixed.join(',')} | bezels ${portRings.join(',')} `
      + `vs demo ${[...rings].sort().join(',')}`);

    // ── The night light: WHICH bezel colour glows, and with what ──
    //
    // Route A in the demo (`nightLit(ringMats[1], '#b07d1c')` — the light IS one
    // of the body's own materials); route B here, because a chunk's bodies are
    // one vertex-coloured InstancedMesh per shape and a per-part emissive would
    // be a second batch. So the two sides cannot be compared as materials, and
    // this compares what they MEAN instead, both by execution:
    //   demo — the recorded `nightLit` call whose material is a bezel colour;
    //   port — the colour of the body parts the declared light quads land on,
    //          plus the emissive that `setNightLitFactor(1)` actually writes.
    // Neither side is read off a constant, so a repaint on either side that the
    // other does not follow fails here.
    const demoLit = demo.nightLitCalls.filter((c) => ringHex.has(c.color));
    check('demo: exactly ONE of the four bezel colours is night-lit '
      + '(a whole colour, not a scatter — that is what lights one whole floor)',
      demoLit.length === 1, demo.nightLitCalls.map((c) => `${c.color}→${c.glow}`).join(' '));

    if (demoLit.length === 1) {
      const probe: BuildingBox = { ...boxAt(19, 7.6, 11), skirt: 0 };
      const seed = seedFor(probe, 'school', 'fileBox');
      const parts = strategy.buildBuildingBoxes?.(probe, seed, 'school') ?? [];
      const quads = strategy.buildBuildingLights?.(probe, seed, 'school') ?? [];
      const eq = (x: number, y: number) => Math.abs(x - y) < 1e-9;
      const hit = new Set<string>();
      let orphan = 0;
      for (const q of quads) {
        const part = parts.find((pp) => eq(pp.x, q.x) && eq(pp.y, q.y)
          && eq(pp.w, q.w) && eq(pp.h, q.h));
        if (part) hit.add(`#${part.color.toString(16).padStart(6, '0')}`);
        else orphan++;
      }
      check('the port lights the SAME bezel colour the demo does, and every quad '
        + 'sits on a bar that is actually there',
        quads.length > 0 && orphan === 0 && hit.size === 1
        && [...hit][0].toLowerCase() === demoLit[0].color.toLowerCase(),
        `${quads.length} quads, ${orphan} with no bar, lit ${[...hit].join(',')} `
        + `vs demo ${demoLit[0].color}`);

      // …and the glow itself, off the material the renderer would actually use.
      const mat = strategy.createBuildingLightMaterial?.('handleRing') as
        (THREE.Material & { emissive: THREE.Color }) | undefined;
      setNightLitFactor(1);
      const emissive = mat ? `#${mat.emissive.getHexString()}` : '(none)';
      setNightLitFactor(0);
      check('…and the glow it writes at night is the demo\'s own hex',
        emissive.toLowerCase() === demoLit[0].glow.toLowerCase(),
        `${emissive} vs demo ${demoLit[0].glow}`);
    }
  }

  // ══ The stack fills the height it was given ══
  //
  // `tierH = h / 3` with `lidH = min(0.8, tierH / 2)` is the demo's own way of
  // keeping `bodyH = tierH - lidH` positive on a `height = 0` footprint WITHOUT
  // making the building taller than it was asked to be — a flat 0.8 lid would
  // stand a 1 m box 3 m tall, and a `Math.max` floor on `bodyH` would do the
  // same. Stated as the property rather than the formula: the top of the top lid
  // is exactly the height, and every part is positive, at every footprint.
  {
    let bad = '';
    let checked = 0;
    for (const [w, d, h] of [
      [15, 6, 9], [19, 7.6, 11], [82, 76, 19], [8.2, 4.7, 5],
      [6, 3, 4], [2.3, 2, 6], [1, 1, 1], [12, 8, 0], [95.8, 67, 0],
    ] as const) {
      const probe: BuildingBox = { ...boxAt(w, d, h), skirt: 0 };
      const seed = seedFor(probe, 'school', 'fileBox');
      if (seed < 0) { bad ||= `no file-box seed at ${w}x${d}x${h}`; continue; }
      let top = -Infinity;
      for (const p of strategy.buildBuildingBoxes!(probe, seed, 'school')!) {
        top = Math.max(top, p.y + p.h / 2);
        if (!(p.w > 0 && p.h > 0 && p.d > 0)) bad ||= `${w}x${d}x${h}: extent ${p.w}x${p.h}x${p.d}`;
      }
      const want = Math.max(1, h);   // MIN_BODY_H
      if (Math.abs(top - want) > 1e-9) bad ||= `${w}x${d}x${h}: stands ${top.toFixed(4)} not ${want}`;
      checked++;
    }
    check('the three boxes fill exactly the height they were given, and stay '
      + 'positive doing it (height = 0 included)',
      checked === 9 && !bad, bad || `${checked} footprints`);
  }

  // ══ The sign goes on the lid rim ══
  //
  // The developer's ask was 「學校的招牌文字還可以寫在蓋子的側邊」, and this is
  // where "written on the lid rim" stops being a comment. The demo's own
  // `mountSign(...)` call is RECORDED (see `loadPaperDemoBodies`) and compared
  // against `strategy.signAnchor`, and then the whole renderer path is run to
  // prove the anchor is actually reaching the plate.
  {
    const [w, d, h] = [17, 6.8, 10] as const;
    demo.signCalls.length = 0;
    demo.fileBoxSchool(w, d, h, () => 0.3);
    const call = demo.signCalls.find((c) => c.zone === 'school');
    const anchor = strategy.signAnchor?.(boxAt(w, d, h), 'school') ?? null;
    check('the school\'s sign anchor is the demo\'s own — the MIDDLE box\'s lid '
      + 'rim, and the lid\'s overhang added to the standoff',
      !!call && !!anchor && call.y !== undefined && call.out !== undefined
      && Math.abs(anchor.centerY - call.y) < 1e-9
      && Math.abs(anchor.faceOut - call.out) < 1e-9,
      call && anchor
        ? `demo y ${call.y?.toFixed(4)} out ${call.out} vs ours `
          + `${anchor.centerY.toFixed(4)} / ${anchor.faceOut}`
        : `demo call ${JSON.stringify(call)} vs anchor ${JSON.stringify(anchor)}`);

    // The text is NOT this change's business — the developer has said schools
    // and hospitals do not draw from the word list. Stated here because the
    // sign MOVED, and "moved" is exactly when a rewrite quietly becomes a
    // relabel.
    check('…and it still says ABC (the sign moved; what it says did not)',
      call?.text === 'ABC', String(call?.text));

    // The band. `2h/3 − lidH/2` has to stay inside DEVPLAN's 0.55–0.70, or "on
    // the lid rim" and "where the spec says" would be a trade-off instead of the
    // same place. Swept, because the two ends of `lidH = min(0.8, h / 6)` are
    // different formulas: below h = 4.8 the fraction is a flat 0.5833, above it
    // climbs toward 0.6667.
    let outOfBand = '';
    const fracs: number[] = [];
    for (const hh of [0.5, 1, 3, 4.8, 5, 9, 11, 19, 30, 70]) {
      const a = strategy.signAnchor?.(boxAt(17, 6.8, hh), 'school');
      const eff = Math.max(1, hh);
      const f = a ? a.centerY / eff : NaN;
      fracs.push(f);
      if (!(f >= 0.55 && f <= 0.70)) outOfBand ||= `h=${hh} → ${f.toFixed(4)}`;
    }
    check('…at a height that is inside 0.55–0.70 h at every building height '
      + '(so the lid rim and the spec are the same place)',
      !outOfBand, outOfBand || `${fracs[0].toFixed(4)} … ${fracs[fracs.length - 1].toFixed(4)}`);

    check('the other four bodies have no ledge and take the renderer\'s own draw',
      (['residential', 'commercial', 'industrial', 'hospital'] as const)
        .every((z) => strategy.signAnchor?.(boxAt(17, 6.8, 10), z) == null));

    // SENT, not just declared. `mountShopSign` is the only thing that reads the
    // anchor, and without this the hook could be unwired with every assertion
    // above still green. Read off the plate's own transform rather than a
    // bounding box: a tilted plate with asymmetric glyphs has a bbox centre that
    // is near the anchor but not on it.
    const routeDist = (_x: number, z: number) => Math.abs(60 - z);
    const signY = (zone: ZoneKind, seed: number): number => {
      const g = mountShopSign(
        strategy, { ...boxAt(18, 14, 22), rotY: 0.7 }, 0, seed, zone, routeDist, 1.0);
      if (!g) return NaN;
      g.updateMatrixWorld(true);
      return g.children[0].getWorldPosition(new THREE.Vector3()).y;
    };
    const schoolYs = [1, 2, 3, 5, 8, 13, 21, 34].map((sd) => signY('school', sd));
    const shopYs = [1, 2, 3, 5, 8, 13, 21, 34].map((sd) => signY('commercial', sd));
    const want = strategy.signAnchor?.(boxAt(18, 14, 22), 'school')?.centerY ?? NaN;
    check('…and `mountShopSign` really uses it: a school\'s plate lands on the '
      + 'rim for every seed, while a shop\'s still rides the seeded draw',
      schoolYs.every((y) => Math.abs(y - want) < 1e-9)
      && new Set(shopYs.map((y) => y.toFixed(6))).size > 1,
      `school ${schoolYs[0].toFixed(3)} (want ${want.toFixed(3)}), `
      + `shop spread ${Math.min(...shopYs).toFixed(3)}–${Math.max(...shopYs).toFixed(3)}`);

    // …and the OTHER half of the anchor. `faceOut` is the only thing that makes
    // the plate clear the LID rather than the wall the renderer measures from,
    // and dropping it from `mountShopSign` left every assertion above green
    // (measured). A SQUARE footprint, so `best.half` is the same whichever face
    // the route picks and the number below has one meaning.
    const sq = { ...boxAt(18, 18, 22), rotY: 0.7 };
    const face = strategy.signAnchor?.(sq, 'school')?.faceOut ?? NaN;
    const g = mountShopSign(strategy, sq, 0, 5, 'school', routeDist, 1.0);
    let stand = NaN;
    if (g) {
      g.updateMatrixWorld(true);
      const plate = g.children[0]?.children[0];
      if (plate) {
        const wp = plate.getWorldPosition(new THREE.Vector3());
        stand = Math.hypot(wp.x - sq.cx, wp.z - sq.cz);
      }
    }
    // 0.45 m is the renderer's own gap between a plate and the surface it hangs
    // on; the claim is that the school gets it from the LID, not from the wall
    // 0.35 m behind it.
    check('…and the plate stands off the LID, not the wall behind it '
      + '(the 0.35 m overhang is part of the anchor)',
      stand >= 18 / 2 + face + 0.45 - 1e-9,
      `plate ${stand.toFixed(3)} m out, wall at 9.000, lid at ${(9 + face).toFixed(3)}`);
  }

  {
    // 5. The shape VOCABULARY is fixed. One template per key per chunk is one
    //    InstancedMesh per key, so a key that varied with the building would be a
    //    draw call per building and would undo the batching this port is for.
    const keys = new Set<string>();
    for (const zone of [null, 'residential', 'commercial', 'industrial', 'school', 'hospital'] as const) {
      for (let seed = 0; seed < 64; seed++) {
        for (const [w, d, h] of [[9, 9, 9], [17, 6.8, 10], [58, 25, 41], [2.5, 1.5, 1]] as const) {
          const box: BuildingBox = { ...boxAt(w, d, h), skirt: 0.4 };
          for (const p of strategy.buildBuildingBoxes?.(box, seed, zone) ?? []) {
            keys.add(p.shape ?? 'box');
          }
        }
      }
    }
    // FOUR, not five: 'bead' left with the abacus. The school is three archive
    // boxes and its handle bezels are four square bars, so every part of it is a
    // cube — see `paperPartTemplate`.
    check('the shape vocabulary is fixed and small — it must not grow with the buildings',
      keys.size === 4 && ['box', 'tooth', 'tri', 'roll'].every((k) => keys.has(k)),
      [...keys].sort().join(','));
  }

  strategy.dispose();
}

// ── The corrugated world's surfaces, against the demo that specifies them ────
//
// Three rows of `plan/migrate-demo-worlds.md` §1 that are not building bodies:
// the masking-tape road, the pond and the park board. All three are a HANDFUL
// OF NUMBERS plus, for the road, a canvas — so the road is diffed the way the
// clouds and the sun are (execute the demo's own painter against a recording
// context and compare the command streams) and the other two are read straight
// out of the demo's source text.
function checkPaperPropsVsDemo(): void {
  console.log('\n[surfaces vs demo — cuphead (corrugated paper)]');
  const src = readFileSync('plan/paper-town-demo.html', 'utf8');
  const strategy = createPaperTerrainStyle();

  // ── The masking-tape road ────────────────────────────────────────────────
  //
  // The port paints the demo's `tapeTexture()` and then adds ONE thing the demo
  // does not have here: the correction-fluid dash, which in the demo is real
  // instanced geometry down the centreline (`PlaneGeometry(0.55, 3.4)` every
  // 7 m) and here has nowhere to live but the tape. So the demo's stream must be
  // a PREFIX of ours, and what follows it must be only the dash.
  const demoCanvases: RecCanvas[] = [];
  const demoDoc = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`demo created <${tag}>`);
      const c = recCanvas();
      demoCanvases.push(c);
      return c;
    },
  };
  new Function('THREE', 'document', 'mulberry32',
    `${sliceDemoFn(src, 'tapeTexture')}\nreturn tapeTexture();`,
  )(THREE, demoDoc, mulberry32);

  const doc = (globalThis as { document: { createElement: (tag: string) => unknown } }).document;
  const ourCanvases: RecCanvas[] = [];
  const prevCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    if (tag !== 'canvas') throw new Error(`strategy created <${tag}>`);
    const c = recCanvas();
    ourCanvases.push(c);
    return c;
  };
  try {
    strategy.createRoadMaterial().dispose();
  } finally {
    doc.createElement = prevCreate;
  }

  const dSteps = demoCanvases[0]?.steps ?? [];
  const oSteps = ourCanvases[0]?.steps ?? [];
  const prefix = diffAt(dSteps, oSteps.slice(0, dSteps.length));
  check('road: the tape is the demo\'s tapeTexture(), stroke for stroke '
    + '(fibres, splice, and both torn edges)',
    dSteps.length > 800 && !prefix,
    prefix || `${dSteps.length} draw commands reproduced`);
  // Everything after the demo's stream must be the dash and nothing else — a
  // white stroke and the moveTo/lineTo that make it. If a future edit slips a
  // second drawing in here, this says so instead of silently accepting it.
  const extra = oSteps.slice(dSteps.length);
  const dashColours = extra
    .filter((s) => s[0] === 'set:strokeStyle' || s[0] === 'set:fillStyle')
    .map((s) => String(s[1]).toLowerCase());
  const dashHex = src.match(/const dashMat = new THREE\.MeshBasicMaterial\(\{ color: '(#[0-9a-f]{6})'/i);
  check('road: the only thing painted over the demo\'s tape is the dash, in the '
    + 'demo\'s own correction-fluid colour',
    extra.length > 0 && !!dashHex
    && dashColours.length > 0
    && dashColours.every((c) => c === dashHex![1].toLowerCase()),
    `${extra.length} extra commands, colours ${[...new Set(dashColours)].join(',') || 'none'} `
    + `(demo dashMat ${dashHex?.[1] ?? '??'})`);

  // ── The pond film and the park board ─────────────────────────────────────
  //
  // Read out of the demo's own declarations rather than restated here, so the
  // demo stays the authority on its palette.
  const decl = (from: string, to: string): string => {
    const a = src.indexOf(from);
    if (a < 0) throw new Error(`demo no longer declares ${from}`);
    const b = src.indexOf(to, a);
    return src.slice(a, b + to.length);
  };
  const numOf = (text: string, key: string): number => {
    const m = text.match(new RegExp(`${key}:\\s*([0-9.]+)`));
    if (!m) throw new Error(`demo's ${key} is gone`);
    return Number(m[1]);
  };
  const hexOf = (text: string, key: string): string => {
    const m = text.match(new RegExp(`${key}:\\s*'(#[0-9a-fA-F]{6})'`));
    if (!m) throw new Error(`demo's ${key} is gone`);
    return m[1].toLowerCase();
  };

  const film = decl('const pondFilmMat = new THREE.MeshPhongMaterial({', '});');
  const water = strategy.createWaterMaterial() as THREE.MeshPhongMaterial;
  check('pond: the cellophane film is the demo\'s — colour, opacity and glint',
    `#${water.color.getHexString()}` === hexOf(film, 'color')
    && Math.abs(water.opacity - numOf(film, 'opacity')) < 1e-9
    && Math.abs((water.shininess ?? 0) - numOf(film, 'shininess')) < 1e-9
    && water.transparent === true,
    `#${water.color.getHexString()} / opacity ${water.opacity} / shininess ${water.shininess} `
    + `(demo ${hexOf(film, 'color')} / ${numOf(film, 'opacity')} / ${numOf(film, 'shininess')})`);
  water.dispose();

  const park = decl('const parkMat = swappable(toon({}),', '});');
  const grass = strategy.createParkMaterial() as THREE.MeshToonMaterial;
  check('park: the grass is the demo\'s cut art paper, not a green wash',
    `#${grass.color.getHexString()}` === hexOf(park, 'color'),
    `#${grass.color.getHexString()} (demo ${hexOf(park, 'color')})`);
  grass.dispose();

  strategy.dispose();
}

// ── uv survives the decoration merge ────────────────────────────────────────
//
// It used not to: `mergeGeometries` allocated position/normal/colour and nothing
// else, so a TEXTURED card in a decoration came out sampling one texel of its
// map. That is why the printed frames on the corrugated eraser's paper sleeve
// could not be ported (plan/migrate-demo-worlds.md §3.1). Nothing in either
// world ships a textured decoration yet, so this stands one up: if it stops
// working, the next person to try gets a solid-colour card and no error.
async function checkDecorationUV(): Promise<void> {
  console.log('\n[decoration uv]');
  const strategy = createPlasticTerrainStyle();
  const originLat = 25.06;
  const originLon = 121.57;

  // A textured card and an untextured plate, both hung on every building.
  const texture = new THREE.Texture();
  const cardMaterial = new THREE.MeshBasicMaterial({ map: texture });
  cardMaterial.userData.shared = true;
  const plateMaterial = new THREE.MeshBasicMaterial({ color: 0x808080 });
  plateMaterial.userData.shared = true;

  const decorated: TerrainStyleStrategy = Object.assign(
    Object.create(Object.getPrototypeOf(strategy) as object), strategy, {
      buildBuildingDecoration: (b: { cx: number; cz: number; baseY: number; height: number }) => {
        const root = new THREE.Group();
        root.position.set(b.cx, b.baseY, b.cz);
        const card = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), cardMaterial);
        card.position.y = b.height * 0.6;
        root.add(card);
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), plateMaterial);
        plate.position.y = b.height * 0.3;
        root.add(plate);
        return root;
      },
    },
  );

  const footprints = [0, 1, 2, 3].map((i) => ({
    coordinates: synthFootprint(originLat, originLon, i * 40, 0, 16, 12),
    height: 14,
  }));
  const result = await buildBuildingMeshes(
    footprints, FLAT_SAMPLER, originLat, originLon, 0, decorated, () => 0, undefined,
    () => 'commercial' as const,
  );

  const find = (mat: THREE.Material): THREE.BufferGeometry | null => {
    for (const child of result.mesh.children) {
      if ((child as THREE.Mesh).material === mat) return (child as THREE.Mesh).geometry;
    }
    return null;
  };
  const card = find(cardMaterial);
  const plate = find(plateMaterial);

  const uv = card?.getAttribute('uv');
  // Present, one per vertex, and actually SPANNING the card — the failure this
  // replaces was not a missing attribute but a card sampling a single texel, so
  // "there is a uv buffer" is not enough to ask for.
  let uMin = Infinity;
  let uMax = -Infinity;
  if (uv) {
    for (let i = 0; i < uv.count; i++) {
      uMin = Math.min(uMin, uv.getX(i));
      uMax = Math.max(uMax, uv.getX(i));
    }
  }
  check('decoration uv: a textured card keeps its uv through the chunk merge',
    !!uv && !!card && uv.count === card.attributes.position.count
      && uMin < 0.01 && uMax > 0.99,
    uv ? `${uv.count} uvs spanning ${uMin.toFixed(2)}…${uMax.toFixed(2)}` : 'no uv attribute');
  // …and only where it is read. uv is 8 bytes a vertex, and almost every
  // decoration in both worlds is flat colour.
  check('decoration uv: an untextured part still pays nothing for one',
    !!plate && plate.getAttribute('uv') === undefined,
    plate ? `${plate.attributes.position.count} verts` : 'no plate mesh');

  disposeBuildingMesh(result);
  cardMaterial.dispose();
  plateMaterial.dispose();
  texture.dispose();
  strategy.dispose();
}

// ── Camera + bike heading agree ──
function checkHeading(): void {
  console.log('\n[camera + heading]');
  const scene = new THREE.Scene();
  const strategy = createPlasticTerrainStyle();
  const bike = new BikeOrnament(scene, strategy);
  const rider = new THREE.Vector3(0, 10, 0);

  // Bearing 90° = due east = +x.
  bike.update(rider, 90, 8, 0.016);
  const root = scene.children[0];
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(root.quaternion);
  check(
    'bike faces the heading (bearing 90° → +x / east)',
    Math.abs(forward.x - 1) < 1e-6 && Math.abs(forward.z) < 1e-6,
    `forward=(${forward.x.toFixed(2)}, ${forward.z.toFixed(2)})`,
  );

  // Bearing 0° = north = −z.
  bike.update(rider, 0, 8, 0.016);
  const north = new THREE.Vector3(1, 0, 0).applyQuaternion(root.quaternion);
  check(
    'bike faces the heading (bearing 0° → −z / north)',
    Math.abs(north.z + 1) < 1e-6 && Math.abs(north.x) < 1e-6,
    `forward=(${north.x.toFixed(2)}, ${north.z.toFixed(2)})`,
  );

  // The chase rig, at the config defaults, must reproduce the demos' framing
  // (17 / 9.5 / 8 / 4 scaled by our 0.66 bike).
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 16 / 9, 0.5, 8000);
  check(
    "camera uses the demos' 55° lens, not the old first-person wide angle",
    DEFAULT_FOV === 55,
    `fov ${DEFAULT_FOV}°`,
  );

  const DEFAULTS = { mode: 'third' as const, heightAboveM: 15, pitchDeg: 30 };
  updateFpsCamera(camera, rider, 0, DEFAULTS, 0);
  const back = camera.position.z - rider.z; // heading north → camera to the south
  check(
    "chase camera trails the bike at the demos' distance",
    Math.abs(back - 11.2) < 0.1,
    `${back.toFixed(1)} m behind (demo 17 × 0.66)`,
  );
  check(
    "chase camera rides at the demos' height",
    Math.abs(camera.position.y - rider.y - 6.3) < 0.1,
    `${(camera.position.y - rider.y).toFixed(1)} m up (demo 9.5 × 0.66)`,
  );
  const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  check('chase camera looks forward (north) and slightly down', gaze.z < -0.8 && gaze.y < 0);

  // The lag is the feel: position eases in at dt × 3.2, the gaze snaps.
  camera.position.set(0, 100, 100); // yank it away, then run one 1/60 s frame
  const before = camera.position.clone();
  updateFpsCamera(camera, rider, 0, DEFAULTS, 1 / 60);
  const targetPos = new THREE.Vector3(rider.x, rider.y + 6.3, rider.z + 11.2);
  const moved = before.distanceTo(camera.position) / before.distanceTo(targetPos);
  check(
    'chase camera LAGS into place (it swings wide through corners)',
    Math.abs(moved - (3.2 / 60)) < 0.005,
    `caught up ${(moved * 100).toFixed(1)}% in one frame (demo: dt × 3.2 ≈ 5.3%)`,
  );
  const lagGaze = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  check(
    'the gaze does NOT lag — it is re-aimed at the bike every frame',
    lagGaze.y < 0 && lagGaze.z < 0,
    'still looking down at the bike while the position catches up',
  );

  // The height slider is now a plain zoom on the rig.
  updateFpsCamera(camera, rider, 0, { ...DEFAULTS, heightAboveM: 30 }, 0);
  const zoomedBack = camera.position.z - rider.z;
  check(
    'the camera-height slider zooms the rig out (it no longer means eye height)',
    zoomedBack > back * 1.8,
    `${zoomedBack.toFixed(1)} m at slider 30 vs ${back.toFixed(1)} m at 15`,
  );

  // First person keeps working.
  updateFpsCamera(camera, rider, 0, { mode: 'first', heightAboveM: 15, pitchDeg: 30 }, 0);
  check(
    'first-person mode still puts the camera on the rider',
    Math.abs(camera.position.x - rider.x) < 1e-6 && Math.abs(camera.position.z - rider.z) < 1e-6,
  );

  bike.dispose();
  strategy.dispose();
}

// ── Free-look orbit camera (the demos' 自由 view) ──
function checkOrbitCamera(): void {
  console.log('\n[free-look camera]');

  // A canvas stub that records the listeners the camera attaches/detaches.
  const listeners = new Set<string>();
  const canvas = {
    addEventListener: (type: string) => listeners.add(type),
    removeEventListener: (type: string) => listeners.delete(type),
    setPointerCapture: () => {},
  } as unknown as HTMLCanvasElement;

  const orbit = new OrbitCamera(canvas);
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 16 / 9, 0.5, 8000);
  const rider = new THREE.Vector3(120, 40, -60);

  check('idle until you switch to it — no listeners attached', listeners.size === 0);
  orbit.attach();
  check(
    'free look listens for drag + wheel',
    ['pointerdown', 'pointermove', 'pointerup', 'wheel'].every((t) => listeners.has(t)),
    [...listeners].join(', '),
  );

  orbit.update(camera, rider);
  const r = camera.position.distanceTo(rider);
  check(
    'the camera orbits the bike at a fixed radius',
    r > 100 && r < 160,
    `${r.toFixed(0)} m out`,
  );

  // Whatever the angle, it must keep the bike in the middle of the frame.
  const aimsAtRider = (): boolean => {
    const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const toRider = rider.clone().sub(camera.position).normalize();
    return gaze.dot(toRider) > 0.99;
  };
  check('it looks AT the bike (that is the whole point of the free view)', aimsAtRider());

  // Drag: rotate around, still aimed at the bike.
  const before = camera.position.clone();
  (orbit as any).onPointerDown({ clientX: 0, clientY: 0, pointerId: 1 });
  (orbit as any).onPointerMove({ clientX: 300, clientY: 40 });
  orbit.update(camera, rider);
  check(
    'dragging swings the camera around the bike, still framed on it',
    camera.position.distanceTo(before) > 10 && aimsAtRider(),
    `moved ${camera.position.distanceTo(before).toFixed(0)} m around the arc`,
  );

  // Wheel: zoom, clamped at both ends.
  (orbit as any).onWheel({ deltaY: -100000, preventDefault: () => {} });
  orbit.update(camera, rider);
  const near = camera.position.distanceTo(rider);
  (orbit as any).onWheel({ deltaY: 100000, preventDefault: () => {} });
  orbit.update(camera, rider);
  const far = camera.position.distanceTo(rider);
  check(
    'the wheel zooms, and cannot be spun inside the bike or out to the moon',
    near >= 32 && near < 40 && far > 290 && far <= 301,
    `clamped to ${near.toFixed(0)}–${far.toFixed(0)} m`,
  );

  // Never below the ground plane, however hard you drag downward.
  (orbit as any).onPointerMove({ clientX: 300, clientY: 100000 });
  orbit.update(camera, rider);
  check(
    'you cannot drag the camera under the world',
    camera.position.y > rider.y,
    `camera y=${camera.position.y.toFixed(0)} vs rider y=${rider.y}`,
  );

  orbit.dispose();
  check('leaving free look releases the input', listeners.size === 0);
}

// ── The camera keeps the bike in sight ──
async function checkCameraCollision(): Promise<void> {
  console.log('\n[camera sightline vs terrain]');
  const DT = 1 / 60;
  const LOOK = 2.6; // CHASE_LOOK_HEIGHT

  // A sightline probe set: ground heights from the bike (t→0) to the camera (t=1).
  const line = (...heights: (number | null)[]) =>
    heights.map((groundY, i) => ({ t: (i + 1) / heights.length, groundY }));

  // Flat ground: rider at 0, camera 6.3 m up. Nothing in the way.
  check(
    'flat ground: the camera is left exactly where the chase rig put it',
    requiredLift(0, 6.3, LOOK, line(0, 0, 0, 0, 0)) === 0,
  );

  // ── THE DESCENT CASE (what the first version of this got wrong) ──
  // Riding downhill: the rider is at 0, and the crest we just came over stands
  // between camera and bike at +5 m. The camera (6.3 m up) is ABOVE that crest,
  // so a "is the camera underground?" test sees nothing wrong — and the bike
  // disappears behind the hill anyway, because the SIGHTLINE goes through it.
  const crestBehind = line(0, 2, 5, 4, 2);
  const cameraAboveCrest = 6.3 > 5;
  const liftForDescent = requiredLift(0, 6.3, LOOK, crestBehind);
  check(
    'DESCENT: a crest that stands in the sightline lifts the camera…',
    liftForDescent > 3,
    `needs +${liftForDescent.toFixed(1)} m to see over it`,
  );
  check(
    '…even though the camera is already above that crest (the old test missed this)',
    cameraAboveCrest,
    'camera 6.3 m vs crest 5.0 m — "camera underground?" would have said fine',
  );
  // And with the lift applied, the sightline really does clear it.
  const clears = crestBehind.every(
    (s) =>
      s.groundY === null ||
      LOOK + s.t * (6.3 + liftForDescent - LOOK) >= s.groundY + CAMERA_GROUND_MARGIN - 1e-6,
  );
  check('and the lifted sightline clears every probe by the margin', clears);

  // The old case still works: camera buried in a hillside on a climb.
  check(
    'CLIMB: a camera inside the hill still gets pulled out',
    requiredLift(0, 6.3, LOOK, line(0, 0, 0, 0, 20)) > 10,
    `+${requiredLift(0, 6.3, LOOK, line(0, 0, 0, 0, 20)).toFixed(1)} m`,
  );

  // Un-streamed terrain must not invent an obstruction.
  check(
    'no terrain loaded: no lift invented',
    requiredLift(0, 6.3, LOOK, line(null, null, null, null, null)) === 0,
  );

  // ── Smoothing ──
  const clamp = new CameraGroundClamp();
  const blocked = () => clamp.update(0, 6.3, LOOK, crestBehind, DT);
  const clear = () => clamp.update(0, 6.3, LOOK, line(0, 0, 0, 0, 0), DT);

  let lift = 0;
  let frames = 0;
  while (frames < 60 && lift < liftForDescent - 0.1) {
    lift = blocked();
    frames++;
  }
  check(
    'it rises fast (the bike is hidden — fix it now)',
    frames < 30,
    `reached ${lift.toFixed(1)} m of ${liftForDescent.toFixed(1)} m in ${(frames * DT).toFixed(2)} s`,
  );
  // 這條原本是 `clamp.tilt > 0.9` —— 它斷言的正是 2026-07-29 判定要拿掉的行為:
  // 遮蔽只要抬 4 m,視線就整個轉去盯著車,也就是每翻過一個丘就切一次俯視。
  // 使用者的話:「鏡頭會盡量以稍微仰視或是俯視跟車,天空視角只給結束一個 phase
  // 或是整個行程結束用,不然鏡頭太突兀。」
  //
  // 跟瓦楞紙樹的 receiveShadow 那次同一個形狀:一條記錄了缺陷的斷言,缺陷修掉之後
  // 它必須變成**新事實的正面陳述**,而且一樣嚴 —— 不是刪掉。
  check('遮蔽時視線只微微下壓,不會切成俯視', clamp.tilt > 0 && clamp.tilt <= CLAMP_MAX_TILT,
    `tilt ${clamp.tilt.toFixed(2)} ≤ ${CLAMP_MAX_TILT}`);
  // 而且它真的隨著抬升長出來(不是被夾成常數 0,那樣上面那條也會過)。
  {
    const c2 = new CameraGroundClamp();
    c2.update(0, 6.3, LOOK, crestBehind, DT);          // 一幀:抬得還很少
    const early = c2.tilt;
    for (let i = 0; i < 60; i++) c2.update(0, 6.3, LOOK, crestBehind, DT);
    check('…而且那個下壓是隨抬升長出來的,不是夾成一個常數',
      early > 0 && early < c2.tilt && c2.tilt === CLAMP_MAX_TILT,
      `${early.toFixed(3)} → ${c2.tilt.toFixed(3)}`);
  }
  // 天空視角仍然是滿的 —— 那一支是 camera-lift(peek / finale),沒有被這次的夾值碰到。
  check('電影感那一支(camera-lift)仍然可以把視線整個帶上去',
    liftWeight('finale', FINALE_RISE) === 1,
    `finale 頂點 weight = ${liftWeight('finale', FINALE_RISE)}`);

  // Falling back must be far slower than rising: the ground under a moving camera
  // flickers between the terrain's steps, and matching it frame-for-frame bobs.
  const peak = lift;
  for (let i = 0; i < frames; i++) lift = clear();
  check(
    'it settles back far slower than it rose (a snap would bob over every step)',
    lift > peak * 0.35 && lift < peak,
    `${((lift / peak) * 100).toFixed(0)}% still there after the ${(frames * DT).toFixed(2)} s it took to rise`,
  );

  for (let i = 0; i < 300; i++) lift = clear();
  check('and eventually returns to zero', lift === 0 && !clamp.active);

  // ── 抬升的上限 ──
  //
  // 使用者實騎回報:「到山頂變成俯視角的時候,鏡頭會被整片灰色的雲遮住,但雲是不
  // 透明的,所以看起來就是一大塊灰色色塊。」低畫質只調雲的顆數,材質仍是不透明的
  // MeshToonMaterial —— 不是畫質檔的事。根因在上面那條式子:它除以 t,而最近的取樣
  // 點 t = 1/5(低檔 1/3),所以「車後兩公尺的一道牆」會被乘五倍才變成抬升。山頂的
  // 髮夾彎正好餵得出那種牆:地面查詢回的是**最上面那層**(`pickCell(wantHighest)`),
  // 也就是上一個之字形的路面。
  const HAIRPIN = line(30, 8, 2, 0, 0); // t=0.2(車後 2 m)踩到上一圈的路面 +30 m
  const uncapped = requiredLift(0, 6.3, LOOK, HAIRPIN);
  check('髮夾彎:沒有上限的話抬升會跑到三位數(這就是被雲糊住的路徑)',
    uncapped > 100, `+${uncapped.toFixed(0)} m`);

  const CEIL = 40;
  check('有天花板時就夾在天花板上,一公分都不多',
    requiredLift(0, 6.3, LOOK, HAIRPIN, CEIL) === CEIL - 6.3,
    `${requiredLift(0, 6.3, LOOK, HAIRPIN, CEIL).toFixed(2)} m → 相機 y=${
      (6.3 + requiredLift(0, 6.3, LOOK, HAIRPIN, CEIL)).toFixed(2)}(天花板 ${CEIL})`);
  // 反向:天花板夠高的時候**一格都不准動**。沒有這條,一個無條件的 MAX_LIFT 也會
  // 讓上面那條過 —— 這個 session 已經抓到六次「兩種實作在出貨數字下等價」。
  check('…而天花板夠高時,答案跟沒有天花板時逐位元相同',
    requiredLift(0, 6.3, LOOK, HAIRPIN, 1000) === uncapped
      && requiredLift(0, 6.3, LOOK, HAIRPIN, null) === uncapped,
    `+${uncapped.toFixed(1)} m 兩邊一致`);
  // 已經在天花板上面(騎進雲裡的高山路線):不抬,但也**絕不**往下推 ——
  // 往下推就是把相機塞進山裡,那正是這支模組存在的理由。
  check('相機已經高過天花板時:抬 0,而不是負的(往下推=塞進山裡)',
    requiredLift(0, 500, LOOK, HAIRPIN, CEIL) === 0);

  // 平滑之後也要守得住,而且天花板**掉下來**時要當幀就守住 —— 落下速率是 2/s,
  // 只夾 needed 不夾 lift 的話相機會在雲裡多待一秒以上。
  {
    const c3 = new CameraGroundClamp();
    let l3 = 0;
    for (let i = 0; i < 300; i++) l3 = c3.update(0, 6.3, LOOK, HAIRPIN, DT, CEIL);
    check('平滑過的抬升也停在天花板下', 6.3 + l3 <= CEIL + 1e-9 && l3 > 0,
      `相機 y=${(6.3 + l3).toFixed(2)} ≤ ${CEIL}`);
    const dropped = c3.update(0, 6.3, LOOK, HAIRPIN, DT, 20);
    check('天花板掉下來時,當幀就跟著掉(不是照 2/s 慢慢降)',
      6.3 + dropped <= 20 + 1e-9,
      `一幀後相機 y=${(6.3 + dropped).toFixed(2)} ≤ 20`);
  }

  // ── 天花板從哪裡來:雲底,而且是三個世界各自的雲底 ──
  //
  // ⚠ 這裡一格畫面都不看。§10 第 7 條:probe 的著色是 material.color × 頂點色 ×
  // lambert,而且打光方向寫死 —— 雲在圖上證明不了任何事。所以只讀幾何與材質。
  {
    const fake = fakeGameRenderer();
    // 私有成員是故意伸手進去的,跟另外兩支 sky 檢查同一個取捨。
    const sky = new SkyAndFog(fake as never) as any;
    sky.init();
    check('沒有雲層的時候沒有天花板(要 null,不是 Infinity)',
      sky.cameraCeilingSceneY(0) === null);

    sky.setCloudsEnabled(true);
    const base = sky.cloudBaseSceneY() as number;
    const ceiling = sky.cameraCeilingSceneY(0) as number;
    check('雲層打開之後天花板在雲底**下面**', ceiling !== null && ceiling < base,
      `雲底 ${base} → 天花板 ${ceiling}`);
    const clearance = base - ceiling;

    // 雲往下垂多少,是各世界的 buildCloud 決定的。把三份 deck 真的建出來量。
    let worst = 0;
    let worstStyle = '';
    const built: TerrainStyleStrategy[] = [];
    for (const style of ['paper', 'plastic', 'circuit'] as const) {
      const strategy = await createTerrainStyleStrategy(style);
      built.push(strategy);
      sky.setCloudBuilder(strategy.buildCloud!.bind(strategy));
      const deck = sky.cloudGroup as THREE.Group;
      deck.updateMatrixWorld(true);
      let hang = 0; // 一朵雲的幾何比它自己的槽位低多少
      for (const child of deck.children) {
        // Box3.setFromObject 會走 InstancedMesh 的 boundingBox(逐個 instance
        // 矩陣算過),所以瓦楞紙那串棉花球的縮放與偏移都算得進去。
        const box = new THREE.Box3().setFromObject(child);
        const below = child.position.y - box.min.y;
        if (below > hang) hang = below;
      }
      check(`${style}: 雲的幾何真的往槽位下方垂(量得到,不是 0)`, hang > 0.5,
        `-${hang.toFixed(1)} m`);
      // 而且它是不透明的 —— 這才是「貼著雲底 = 一大塊灰」的原因,
      // 也是為什麼淡出那條路救不了(見下面那條 immersion)。
      const mats = sky.styleCloudMats as THREE.Material[];
      check(`${style}: 交出來的雲是不透明的(所以貼上去就是一片灰)`,
        mats.length > 0 && mats.every((m) => m.transparent === false && m.opacity === 1),
        `${mats.length} 個材質`);
      if (hang > worst) { worst = hang; worstStyle = style; }
    }
    // demo 的浮動:animateClouds 的 sin(...)·1.2,絕對式,所以最多再低 1.2 m。
    check('天花板的間隙蓋得住最會垂的那個世界(再加上 ±1.2 m 的浮動)',
      clearance >= worst + 1.2,
      `間隙 ${clearance} m vs ${worstStyle} 垂 ${worst.toFixed(1)} + bob 1.2`);

    // 為什麼不能改成「靠既有的 applyStyleCloudFade 把雲淡掉」:那條吃的是
    // cloudImmersion,而 fade = 1 − smoothstep(0.25, 0.75, k) —— 在雲底**下方**
    // k 還沒到 0.25,fade 仍然是 1。也就是說貼著雲底看的時候,淡出根本沒開始,
    // 雲是全不透明的。所以唯一的解是**不要讓相機上去**。
    sky.lastCameraY = ceiling;
    sky.applyCloudImmersion();
    sky.animateClouds(DT, new THREE.Vector3(0, ceiling, 0));
    {
      const mats = sky.styleCloudMats as THREE.Material[];
      check('貼著天花板時雲還是全不透明 —— 既有的入雲淡出根本還沒開始',
        (sky.cloudImmersion as number) < 0.25
          && mats.length > 0 && mats.every((m) => m.opacity === 1 && m.transparent === false),
        `immersion ${(sky.cloudImmersion as number).toFixed(3)} → fade 1`);
    }
    for (const s of built) s.dispose();

    // 天花板釘的是**高度**不是場景 Y:浮動原點一 rebase 就得跟著走,
    // 不然山頂那段(原點被 rebase 過)算出來的天花板會整個漂掉。
    let originEle = 100;
    sky.setOriginElevationSource(() => originEle);
    sky.setCloudLayer(1500);
    check('天花板 = 凝結高度 − 浮動原點 − 間隙',
      sky.cameraCeilingSceneY(0) === 1500 - 100 - clearance,
      `${sky.cameraCeilingSceneY(0)}`);
    originEle = 600;
    check('…而且 rebase 之後重新算,不是快取',
      sky.cameraCeilingSceneY(0) === 1500 - 600 - clearance,
      `${sky.cameraCeilingSceneY(0)}`);

    // 天花板是「雲底」,不是一條無條件的高度上限:已經爬出雲層頂的路線
    // (低凝結高度的高山日,那是一整趟不是一瞬間)上面沒有東西可以撞,
    // 再夾下去等於把遮蔽處理整段關掉。
    const deckTop = (sky.cloudBaseSceneY() as number) + 200; // CLOUD_LAYER_THICKNESS
    check('還在雲底下方 → 有天花板',
      sky.cameraCeilingSceneY(deckTop - 201) !== null);
    check('人已經在雲層裡 → 還是有天花板(不准再往上鑽)',
      sky.cameraCeilingSceneY(deckTop - 1) !== null);
    check('已經爬出雲層頂 → 天花板消失(上面沒東西可以撞)',
      sky.cameraCeilingSceneY(deckTop + 1) === null);

    sky.setCloudsEnabled(false);
    check('關掉雲層就沒有天花板了(抬升重新無上限,天空視角照樣給 camera-lift)',
      sky.cameraCeilingSceneY(0) === null);
  }
}

// ── Cinematic lift at interval ends / the finish ──
function checkCameraLift(): void {
  console.log('\n[cinematic lift]');

  check('peek: starts on the ground', liftWeight('peek', 0) === 0);
  check(
    'peek: rises, holds, and comes back down within its 5 seconds',
    liftWeight('peek', PEEK_RISE) === 1 &&
      liftWeight('peek', PEEK_RISE + PEEK_HOLD / 2) === 1 &&
      liftWeight('peek', PEEK_DURATION) === 0,
    `rise ${PEEK_RISE}s → hold ${PEEK_HOLD}s → fall ${PEEK_FALL}s`,
  );
  const rising = [0.2, 0.4, 0.6, 0.8, 1.0].map((t) => liftWeight('peek', t * PEEK_RISE));
  check(
    'peek: the rise is monotonic (it eases up, it does not stutter)',
    rising.every((w, i) => i === 0 || w >= rising[i - 1]),
    rising.map((w) => w.toFixed(2)).join(' → '),
  );

  check(
    'finale: rises and STAYS up (the summary opens on a view of the world)',
    liftWeight('finale', 0) === 0 &&
      liftWeight('finale', FINALE_RISE) === 1 &&
      liftWeight('finale', 60) === 1,
  );

  // The state machine.
  const lift = new CameraLift();
  check('idle by default', lift.update(1 / 60) === 0 && !lift.active);

  lift.trigger('peek');
  lift.update(0.6);
  const midPeek = lift.update(0.0);
  check('a peek in progress is not restarted by another peek', (() => {
    lift.trigger('peek');
    return lift.update(0) === midPeek;
  })());

  // The finish outranks an interval boundary.
  lift.trigger('finale');
  check('a finale takes over a peek in progress', lift.kind === 'finale' && lift.update(0) === 0);
  lift.update(FINALE_RISE);
  check('and holds at the top', lift.update(10) === 1 && lift.active);

  lift.cancel();
  check('free look cancels it (the rider always owns the camera)', !lift.active && lift.update(1) === 0);

  // A peek expires on its own.
  lift.trigger('peek');
  lift.update(PEEK_DURATION + 0.1);
  check('a peek retires itself when it is done', !lift.active);
}

/**
 * No quality tier may leave the night with no lamp light at all.
 *
 * Everything else about gameview's 3D night already matches the demos exactly —
 * the light sums (3.25 day → 1.38 night), the fog colour, and each lamp's own
 * `PointLight(colour, 0, 26, 1.8)` driven to `intensity = k * 14`. The demos
 * light EVERY lamp. `low` lit none, and that single number was the whole
 * difference between "the demo's night" and a frame the rider reported as
 * 超級黑 (cuphead reads black; plastic reads as a flat purple wash, because its
 * night sky and fog are purple).
 *
 * The rule this encodes: a tier may reduce HOW MANY lamps cast light — nobody
 * can tell 8 from 3 — but not to none. Zero is not the same world drawn more
 * cheaply, it is a different world. Same shape as the zone-brightness floor
 * below.
 */
function checkNightIsLit(): void {
  console.log('\n[night is lit at every tier]');

  const tiers = Object.entries(QUALITY_PRESETS);
  check(
    'every quality tier lights at least one lamp at night',
    tiers.every(([, p]) => p.maxLiveLampLights > 0),
    tiers.map(([t, p]) => `${t}=${p.maxLiveLampLights}`).join(' '),
  );
  // Cheaper tiers may light fewer, and should — the point is a floor, not
  // parity. If this inverts, someone has mixed the tiers up.
  check(
    'and cheaper tiers light no more than dearer ones',
    QUALITY_PRESETS.low.maxLiveLampLights <= QUALITY_PRESETS.medium.maxLiveLampLights
      && QUALITY_PRESETS.medium.maxLiveLampLights <= QUALITY_PRESETS.high.maxLiveLampLights,
  );
  // The per-lamp light itself is the demo's, and is what makes the count the
  // only variable. Read from the demo rather than compared to a typed constant.
  const demo = readFileSync('plan/plastic-town-demo.html', 'utf8');
  const ctor = demo.match(/new THREE\.PointLight\([^,]+,\s*0,\s*(\d+),\s*([\d.]+)\)/);
  const peak = demo.match(/\.light\.intensity = k \* (\d+)/);
  const ours = readFileSync('packages/web/src/game/terrain/plastic-terrain-style.ts', 'utf8');
  check(
    "each lamp's own light is still the demo's",
    ctor !== null && peak !== null
      && new RegExp(`new THREE\\.PointLight\\([^,]+, 0, ${ctor[1]}, ${ctor[2]}\\)`).test(ours)
      && new RegExp(`light\\.intensity = k \\* ${peak[1]}`).test(ours),
    ctor && peak ? `demo distance ${ctor[1]} decay ${ctor[2]} peak ${peak[1]}` : 'demo lamp light not found',
  );
}

// ── Zones tint, they do not dim ──
function checkZones(): void {
  console.log('\n[environment zones]');
  const zones = Object.entries(ZONE_MODIFIERS);

  check(
    'no zone darkens the frame (the tunnel ×0.45 blackout is gone)',
    zones.every(([, m]) => m.brightnessMul === 1.0),
    zones.map(([z, m]) => `${z}=${m.brightnessMul}`).join(' '),
  );
  check(
    'no zone crushes contrast either',
    zones.every(([, m]) => m.contrastAdd === 0),
  );
  check(
    'zones may still tint (forest keeps a faint green cast)',
    ZONE_MODIFIERS.forest.tintMul[0] < 1 && ZONE_MODIFIERS.forest.tintMul[1] === 1,
    `forest tint = [${ZONE_MODIFIERS.forest.tintMul.join(', ')}]`,
  );
}

// ── The 2D night grade ──
//
// 3D gets night for free: change three light intensities and every material
// reacts. Phaser has no light term, so the ONLY thing that reaches every drawn
// pixel is the glasses pipeline — which is why night lives there and the maths
// lives in an engine-free module these checks can reach.
//
// The first version of these checks asserted 2D's night depth against 3D's
// light-sum ratio, and passed while the frame was nearly twice as dark as the
// demo. THE DEMO IS THE REFERENCE. So these read the demo HTML.
function checkNightGrade(): void {
  console.log('\n[2D night grade]');

  // Parse the demos' own veils out of their source. If someone retunes a demo,
  // gameview must follow it or this goes red — that is the entire contract.
  const demoVeil = (file: string): { color: number; alpha: number } | null => {
    const src = readFileSync(file, 'utf8');
    // `nightGfx` is the veil layer in both demos, but they reach it differently:
    // handdrawn fills `this.nightGfx` directly, plastic aliases it first
    // (`const g = this.nightGfx`) inside drawNight(). Match either, and NEVER
    // just "the first fillStyle near the word nightGfx" — that picked up an
    // unrelated call and reported a veil neither demo has.
    const direct = src.match(
      /this\.nightGfx\s*\.fillStyle\(\s*(0x[0-9a-fA-F]+)\s*,\s*([0-9.]+)\s*\)/,
    );
    if (direct) return { color: parseInt(direct[1], 16), alpha: parseFloat(direct[2]) };

    // Aliased form. Search FROM the assignment, not the whole file: plastic's
    // alias is `g`, and `g.fillStyle(...)` appears dozens of times earlier for
    // completely unrelated art. Searching globally reported 0xffffff@0.28.
    const at = src.search(/(?:const|let)\s+\w+\s*=\s*this\.nightGfx\b/);
    if (at < 0) return null;
    const alias = src.slice(at).match(/(?:const|let)\s+(\w+)\s*=\s*this\.nightGfx\b/)![1];
    const m = src.slice(at).match(
      new RegExp(`\\b${alias}\\s*\\.fillStyle\\(\\s*(0x[0-9a-fA-F]+)\\s*,\\s*([0-9.]+)\\s*\\)`),
    );
    return m ? { color: parseInt(m[1], 16), alpha: parseFloat(m[2]) } : null;
  };

  for (const [style, file] of [
    ['cuphead', 'plan/phaser-handdrawn-demo.html'],
    ['plastic', 'plan/phaser-plastic-demo.html'],
  ] as const) {
    const demo = demoVeil(file);
    const ours = NIGHT_VEIL[style];
    check(
      `${style}'s night veil is the demo's — ${file.split('/').pop()}`,
      demo !== null && demo.color === ours.color && Math.abs(demo.alpha - ours.alpha) < 1e-6,
      demo ? `demo 0x${demo.color.toString(16)}@${demo.alpha} vs ours 0x${ours.color.toString(16)}@${ours.alpha}` : 'demo veil not found',
    );
  }

  check(
    'noon is a no-op (nothing is veiled by day)',
    nightVeilAmount(0, 'cuphead') === 0 && nightVeilAmount(0, 'plastic') === 0,
  );

  check(
    'deep night reaches the demo\'s full veil, no more',
    nightVeilAmount(1, 'cuphead') === NIGHT_VEIL.cuphead.alpha
      && nightVeilAmount(1, 'plastic') === NIGHT_VEIL.plastic.alpha,
  );

  // THE BUG THIS REPLACED. A multiply has no floor; a veil does. Black under
  // the veil must come out as the veil colour, not as black — that difference
  // is what "超級黑" was.
  const veilB = nightVeilRgb('cuphead')[2];
  check(
    'the veil LIFTS black instead of crushing it (it is a mix, not a multiply)',
    veiledChannel(0, veilB, nightVeilAmount(1, 'cuphead')) > 0.02,
    `black → ${veiledChannel(0, veilB, nightVeilAmount(1, 'cuphead')).toFixed(3)} blue`,
  );

  // And the magnitude, stated as the multiply it is equivalent to, because that
  // is the number that was wrong: 0.42 where the demo says 0.68.
  const effective = (s: 'cuphead' | 'plastic') => 1 - nightVeilAmount(1, s);
  check(
    'paper\'s night is the demo\'s ×0.68, not the old ×0.42',
    Math.abs(effective('cuphead') - 0.68) < 1e-9,
    `×${effective('cuphead').toFixed(2)}`,
  );
  check(
    'plastic\'s night is the demo\'s ×0.56',
    Math.abs(effective('plastic') - 0.56) < 1e-9,
    `×${effective('plastic').toFixed(2)}`,
  );
  check(
    'paper is the LIGHTER of the two nights (its demo veil is thinner)',
    effective('cuphead') > effective('plastic'),
  );

  // One dusk curve, or the windows light up while the street is still bright.
  // Compare the two CONSUMERS to each other — comparing one of them to
  // `duskRamp` proves nothing about the other, which is how a linear veil ramp
  // survived the first version of this check.
  const samples = [0, 0.2, 0.25, 0.3, 0.45, 0.6, 0.8, 1];
  check(
    'the veil and the window lights share one dusk curve',
    samples.every((f) =>
      Math.abs(
        nightVeilAmount(f, 'cuphead') / NIGHT_VEIL.cuphead.alpha
        - nightLightAlpha(f) / LIGHTS_MAX_ALPHA,
      ) < 1e-9),
    samples.map((f) => `${f}:${(nightVeilAmount(f, 'cuphead') / NIGHT_VEIL.cuphead.alpha).toFixed(2)}`).join(' '),
  );
  check(
    'nothing happens before dusk starts',
    duskRamp(DUSK_START) === 0 && nightLightAlpha(0.2) === 0
      && nightVeilAmount(0.2, 'cuphead') === 0 && nightVeilAmount(0.2, 'plastic') === 0,
  );
  check(
    'dusk is complete by DUSK_END',
    duskRamp(DUSK_END) === 1 && Math.abs(nightLightAlpha(1) - LIGHTS_MAX_ALPHA) < 1e-9,
  );

  // Monotonic: no time of day may be brighter than the one before it.
  let monotonic = true;
  for (let i = 1; i <= 20; i++) {
    if (nightVeilAmount(i / 20, 'cuphead') < nightVeilAmount((i - 1) / 20, 'cuphead')) monotonic = false;
  }
  check('the frame only ever gets darker as night falls', monotonic);

  // Zone brightness is now night's neighbour, not its multiplier. The tunnel
  // ×0.45 that 3D dropped is still here, and that is survivable ONLY because
  // night no longer compounds with it.
  check(
    'night does not compound with the zone dim any more',
    ZONE_MODIFIERS_2D.tunnel.brightnessMul * (1 - nightVeilAmount(1, 'cuphead')) > 0.28,
    `tunnel at night ≈ ×${(ZONE_MODIFIERS_2D.tunnel.brightnessMul * (1 - nightVeilAmount(1, 'cuphead'))).toFixed(2)}`,
  );

  // Why option C alone was not enough: it runs on the COMPOSITED frame, so it
  // veils the additive lights layer too and leaves the lit:unlit ratio roughly
  // where it was. The demos put their glow ABOVE the veil (depth 885 vs 880).
  // Option D is now built — the checks below assert the wiring that does it.
  const world = 0.5, light = 0.1;
  const a = nightVeilAmount(1, 'cuphead');
  const lit = veiledChannel(world + light, veilB, a);
  const unlit = veiledChannel(world, veilB, a);
  check(
    'a post-pass veil does not improve glow contrast (option C is half the job)',
    (lit - unlit) < light,
    `glow ${light} → ${(lit - unlit).toFixed(3)} after the veil`,
  );

  // Option D: the additive lights render on a second, pipeline-free camera
  // AFTER the veiled main camera, so a glow lands on the veiled frame at full
  // strength. Same numbers as above, other compositing order.
  {
    const litAbove = veiledChannel(world, veilB, a) + light; // veil first, add after
    check(
      'lights composited above the veil keep their full glow (option D, the other half)',
      Math.abs((litAbove - unlit) - light) < 1e-12,
      `glow ${light} → ${(litAbove - unlit).toFixed(3)} above the veil`,
    );
  }

  // The wiring that makes that arithmetic true in the running scene. Read from
  // source, the same way the veil constants are read from the demos: a camera
  // graph cannot be exercised headlessly, but it can be held to its shape.
  {
    const scene = readFileSync('packages/web/src/game/phaser/phaser2d-scene.ts', 'utf8');
    const builder = readFileSync('packages/web/src/game/phaser/terrain-builder.ts', 'utf8');
    check(
      'terrain-builder routes the chunk lights layer past the veil',
      /this\.scene\.adoptNightLights\(lightsGfx\)/.test(builder),
    );
    check(
      'adoptNightLights: main camera drops the layer, lights camera picks it up',
      /adoptNightLights[\s\S]{0,600}cameras\.main\.ignore\(gfx\)[\s\S]{0,200}cameraFilter &= ~this\.lightsCamera\.id/.test(scene),
    );
    // Default-OUT membership. The failure mode of a hand-kept ignore list is an
    // object drawn TWICE (once veiled, once not); inverting it means an
    // omission merely leaves something veiled, which is invisible.
    check(
      'every new scene object defaults OUT of the lights camera (ADDED_TO_SCENE hook)',
      /ADDED_TO_SCENE[\s\S]{0,200}cameraFilter \|= lightsCam\.id/.test(scene),
    );
    check(
      'the main camera is the only camera that carries post pipelines',
      (() => {
        const calls = scene.match(/[\w.]+\.setPostPipeline\(/g) ?? [];
        return calls.length === 1 && calls[0].startsWith('this.cameras.main.');
      })(),
      (scene.match(/[\w.]+\.setPostPipeline\(/g) ?? []).join(' '),
    );
    check(
      'welcome mode opts out (no lights camera, lights stay on the main camera)',
      /if \(!this\.lightsCamera\) return;/.test(scene)
        && /mode === 'game'[\s\S]{0,300}this\.cameras\.add\(\)/.test(scene),
    );
    // The two cameras are one view in two compositing slots, not two views.
    check(
      'the lights camera shadows the main camera\'s scroll and zoom',
      /lightsCamera\.setScroll\(cam\.scrollX, cam\.scrollY\)[\s\S]{0,120}lightsCamera\.setZoom\(cam\.zoom\)/.test(scene),
    );
  }
}
}

// ── Sign layout: shared by every world, so it is checked once ──
function checkSignSpec(): void {
  console.log('\n[sign spec]');

  // The whole alphabet, or a word quietly loses a letter and nobody finds out.
  const missing = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']
    .filter((c) => sanitizeSignText(c) !== c);
  check('every A–Z / 0–9 has a glyph', missing.length === 0, missing.join('') || 'none');

  check('unwritable characters are dropped, not drawn', sanitizeSignText('你CA好FE!') === 'CAFE');
  check('text is capped at 4 characters', sanitizeSignText('LONGWORD').length === 4);

  // The confusable pairs. Two glyphs that share a stroke list are the same
  // glyph, and at sign size that is a bug the eye cannot recover from.
  for (const [a, b2] of [['0', 'O'], ['1', 'I'], ['2', 'Z'], ['5', 'S'], ['8', 'B']]) {
    check(
      `${a} and ${b2} are different shapes`,
      JSON.stringify(SIGN_GLYPHS[a]) !== JSON.stringify(SIGN_GLYPHS[b2]),
    );
  }

  // Spec floors: 字高 ≥ 招牌高 × 0.55, 筆畫寬 ≥ 字高 / 8 (DEVPLAN「招牌」).
  const strokes = signStrokes(9, 3, 'CAFE');
  const ys = strokes.flatMap((s) => [s.y0, s.y1]);
  const capH = Math.max(...ys) - Math.min(...ys);
  check('cap height clears the spec floor', capH >= 3 * 0.55, `${capH.toFixed(2)} ≥ ${(3 * 0.55).toFixed(2)}`);
  check('stroke width clears the spec floor', strokes[0].width >= capH / 8,
    `${strokes[0].width.toFixed(3)} ≥ ${(capH / 8).toFixed(3)}`);

  // …and the text must stay INSIDE the plate. A four-letter word that overflows
  // is the failure mode a system font would give us, and the reason we do not
  // use one.
  const xs = strokes.flatMap((s) => [s.x0, s.x1]);
  const halfW = Math.max(Math.abs(Math.min(...xs)), Math.abs(Math.max(...xs))) + strokes[0].width / 2;
  check('text fits inside the plate', halfW <= 9 / 2, `${(halfW * 2).toFixed(2)} ≤ 9`);

  // The longest word still fits — this is what shrinks, not the plate.
  const long = signStrokes(9, 3, 'WWWW');
  const lxs = long.flatMap((s) => [s.x0, s.x1]);
  const longHalf = Math.max(Math.abs(Math.min(...lxs)), Math.abs(Math.max(...lxs))) + long[0].width / 2;
  check('the widest 4-letter word still fits', longHalf <= 9 / 2, `${(longHalf * 2).toFixed(2)} ≤ 9`);

  check('checkpoint labels: multi-word names become initials',
    segmentSignLabel('Warm Up', 1) === 'WU', segmentSignLabel('Warm Up', 1));
  check('checkpoint labels: a trailing number is kept whole',
    segmentSignLabel('Interval 1', 2) === 'I1', segmentSignLabel('Interval 1', 2));
  check('checkpoint labels: one long word is cut to three',
    segmentSignLabel('Recovery', 3) === 'REC', segmentSignLabel('Recovery', 3));
  check('checkpoint labels: an unwritable name falls back to the number',
    segmentSignLabel('恢復', 4) === '4', segmentSignLabel('恢復', 4));

  // Zones that should NOT get a sign must return null, not an empty plate.
  check('residential and industrial carry no sign',
    signContent('residential', 1, 'plastic', 'shop') === null
      && signContent('industrial', 1, 'plastic', 'shop') === null);
  check('school signs are fixed, shop signs are drawn from the word list',
    signContent('school', 1, 'plastic', 'shop')?.text === 'ABC'
      && (signContent('commercial', 1, 'plastic', 'shop')?.text?.length ?? 0) >= 2);
  check('the hospital mark is a triangle, never a red cross',
    signContent('hospital', 1, 'plastic', 'shop')?.symbol === 'triangle');

  // Deterministic: the same building must not rename itself between chunk loads.
  check('shop names are stable for a given seed',
    signContent('commercial', 77, 'plastic', 'shop')?.text === signContent('commercial', 77, 'plastic', 'shop')?.text
      && signContent('commercial', 77, 'plastic', 'shop')?.text !== undefined);

  // ── Each world signs from its OWN shelf (§3.8 applied to words) ──
  //
  // One shared list is how a printed-circuit district ended up signposting
  // 「BAKE」. The demos answer this per world and in two different REGISTERS —
  // plastic is a toy TOWN so its signs are shopfronts; circuit is a board, which
  // has no shops, so its e-paper modules label components. Both are right.
  {
    const WORLDS = ['plastic', 'cuphead', 'circuit'] as const;
    const drawn = (w: typeof WORLDS[number]) =>
      new Set(Array.from({ length: 400 }, (_, s) => signContent('commercial', s + 1, w, 'shop')!.text));
    const sets = WORLDS.map(drawn);
    check('every world draws shop words from its own list',
      sets.every((a, i) => sets.every((b, j) => i === j || [...a].every((w) => !b.has(w)))),
      WORLDS.map((w, i) => `${w}:${sets[i].size}`).join(' '));
    // The demo's own words must survive verbatim. Read OUT of the demo, not
    // transcribed here — a transcription only re-confirms whatever was typed.
    for (const [world, file, re] of [
      ['plastic', 'plan/plastic-town-demo.html', /SHOP_WORDS\s*=\s*\[([^\]]*)\]/],
      ['circuit', 'plan/circuit-town-demo.html', /SIGN_WORDS\s*=\s*\[([^\]]*)\]/],
    ] as const) {
      const m = readFileSync(file, 'utf8').match(re);
      const demoWords = m ? [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]) : [];
      const ours = drawn(world);
      check(`${world}: every word its demo declares is still drawable`,
        demoWords.length > 0 && demoWords.every((w) => ours.has(w)),
        `demo ${demoWords.length} → missing ${demoWords.filter((w) => !ours.has(w)).join(' ') || 'none'}`);
    }
    // Additions are allowed, but only inside the constraints every carrier can
    // print: at most SIGN_MAX_CHARS glyphs, all of them in SIGN_ALPHABET.
    check('every word in every world fits the carrier',
      sets.every((a) => [...a].every((w) =>
        w.length <= SIGN_MAX_CHARS && [...w].every((c) => SIGN_ALPHABET.includes(c)))),
      `max ${SIGN_MAX_CHARS} glyphs from ${SIGN_ALPHABET.length}-glyph alphabet`);
  }
}

// ── 訓練模式:店面招牌改喊激勵詞 ──
//
// 五件事,而且**最後兩件才是重點**:
//   1. 宣告的那一本,就是 `signContent()` 真的發得出來的那一本(兩個方向都比)。
//      這條先來 —— 下面兩條掃的是**發出來的**集合,少了它,一個宣告了卻永遠抽不到
//      的詞會安靜地不被檢查。
//   2. 每個詞都畫得出來:餵進真正的字模查表(`SIGN_GLYPHS`),不是比對一張抄來的
//      字元清單;而且要求 `signStrokes` 吐出的筆劃數剛好等於字模段數總和,所以
//      「被 sanitize 悄悄砍掉一個字」跟「少一個字模」兩種都會失敗。
//   3. 三本互不重疊,而且不撞**任何一個世界**的店名(§3.8 的詞彙版:一個詞出現在
//      兩張貨架上,它就不再說明你在哪個世界)。
//   4. **送得到**:同一個 seed 下,`mountShopSign` 蓋出來的幾何真的換成了訓練詞。
//   5. **一路送得到**:`buildBuildingMeshes` 那一段線也是通的。
//
// 這個 repo 最常見的缺陷是「記錄了 ≠ 送得到」——斷言查了宣告,卻沒查真的被建出來
// 的東西。所以 4 跟 5 對的是頂點,不是字串。
async function checkTrainingSigns(): Promise<void> {
  console.log('\n[training signs]');
  const WORLDS = ['plastic', 'cuphead', 'circuit'] as const;
  // 400 個 seed 蓋得到每一本詞彙:最慢的一本(24 個詞)76 個 seed 就全部出現過。
  const SEEDS = 400;

  /** 一個世界某一本詞彙,**從 signContent 的回傳值**抽出來的全部詞。 */
  const drawn = (w: typeof WORLDS[number], v: SignVocabulary): Set<string> =>
    new Set(Array.from({ length: SEEDS }, (_, s) => signContent('commercial', s + 1, w, v)!.text));
  const train = new Map(WORLDS.map((w) => [w, drawn(w, 'training')] as const));
  const shop = new Map(WORLDS.map((w) => [w, drawn(w, 'shop')] as const));

  // 1. 宣告 ↔ 發得出來,兩個方向。
  for (const w of WORLDS) {
    const declared = [...SIGN_TRAINING_WORDS[w]] as string[];
    const delivered = train.get(w)!;
    const missing = declared.filter((x) => !delivered.has(x));
    const extra = [...delivered].filter((x) => !declared.includes(x));
    check(`${w}: signContent('training') 發出來的就是宣告的那一本,不多不少`,
      declared.length > 0 && missing.length === 0 && extra.length === 0,
      `宣告 ${declared.length} / 發出 ${delivered.size}`
        + (missing.length ? ` / 沒發出: ${missing.join(' ')}` : '')
        + (extra.length ? ` / 多發: ${extra.join(' ')}` : ''));
  }

  // 2. 每個詞都畫得出來,而且在字數上限以內。
  {
    const unwritable: string[] = [];
    const tooLong: string[] = [];
    let words = 0;
    let longest = 0;
    for (const w of WORLDS) {
      for (const word of train.get(w)!) {
        words++;
        longest = Math.max(longest, word.length);
        if (word.length > SIGN_MAX_CHARS) tooLong.push(`${w}:${word}`);
        const segs = [...word].map((ch) => SIGN_GLYPHS[ch]?.length ?? 0);
        if (segs.some((n) => n === 0)) {
          unwritable.push(`${w}:${word}(沒有字模)`);
          continue;
        }
        const want = segs.reduce((a, n) => a + n, 0);
        const got = signStrokes(9, 3, word).length;
        if (got !== want) unwritable.push(`${w}:${word}(畫出 ${got} 筆,字模有 ${want} 筆)`);
      }
    }
    check('每個激勵詞的每個字都在 SIGN_GLYPHS 裡,而且真的整個被畫出來',
      unwritable.length === 0, unwritable.join(' ') || `${words} 個詞`);
    check(`每個激勵詞都在 SIGN_MAX_CHARS(=${SIGN_MAX_CHARS})以內`,
      tooLong.length === 0, tooLong.join(' ') || `最長 ${longest} 字`);
  }

  // 3. 互不重疊。
  {
    const pairs: string[] = [];
    for (let i = 0; i < WORLDS.length; i++) {
      for (let j = i + 1; j < WORLDS.length; j++) {
        const a = train.get(WORLDS[i])!;
        const b = train.get(WORLDS[j])!;
        const both = [...a].filter((x) => b.has(x));
        if (both.length) pairs.push(`${WORLDS[i]}∩${WORLDS[j]}: ${both.join(' ')}`);
      }
    }
    check('三個世界的激勵詞互不重疊', pairs.length === 0,
      pairs.join(' | ') || WORLDS.map((w) => `${w}:${train.get(w)!.size}`).join(' '));
    // 「自己的店名」不夠 —— 撞到任何一個世界的店名都算撞(`MEMO` 為此搬過家)。
    const allShop = new Set([...shop.values()].flatMap((s) => [...s]));
    const clash = WORLDS.flatMap((w) =>
      [...train.get(w)!].filter((x) => allShop.has(x)).map((x) => `${w}:${x}`));
    check('激勵詞不撞任何一個世界的店名', clash.length === 0,
      clash.join(' ') || `${[...train.values()].reduce((n, x) => n + x.size, 0)} 個激勵詞 vs ${allShop.size} 個店名`);
  }

  // 4. 送得到(signContent 這一層):逐 seed 換了字,而且只換店面。
  {
    const same: string[] = [];
    for (const w of WORLDS) {
      for (let s = 1; s <= SEEDS; s++) {
        const t = signContent('commercial', s, w, 'training')!.text;
        const p = signContent('commercial', s, w, 'shop')!.text;
        if (t === p) same.push(`${w}@${s}:${t}`);
      }
    }
    check('訓練模式下每一個 seed 的店面招牌都換了字', same.length === 0,
      same.slice(0, 5).join(' ') || `${WORLDS.length}×${SEEDS} 個 seed 全換`);
    // 反向:學校的 ABC 與醫院的三角形不歸詞彙管。訓練模式改的是店面,不是整條街。
    check('學校與醫院不受詞彙影響(訓練模式只改店面)',
      WORLDS.every((w) => signContent('school', 5, w, 'training')!.text === 'ABC'
        && signContent('school', 5, w, 'shop')!.text === 'ABC'
        && signContent('hospital', 5, w, 'training')!.symbol === 'triangle'
        && signContent('hospital', 5, w, 'shop')!.symbol === 'triangle'));
  }

  // 5a. 送得到(mountShopSign 這一層)。
  //
  // 精確到驗得出「換成的是**哪一個**字」:一筆 stroke 是一顆 BoxGeometry = 24 個
  // 頂點(`sign-builder.buildStrokeGeometry`),所以同一個 seed 下兩本詞彙蓋出來的
  // 頂點數差,必須剛好等於 24 ×(兩個字的字模段數差)。招牌板、圓角、傾角在同一個
  // seed 下完全相同,差的只有字。
  //
  // `moved` 是恆真句的保險:萬一取樣到的 seed 剛好每一個都字數相同,期望差全是 0,
  // 這條斷言就算 vocabulary 整個被忽略也會過。所以要求至少 8 個 seed 的期望差不是 0。
  {
    const routeDist = (_x: number, z: number) => Math.abs(60 - z);
    const box = {
      cx: 0, cz: 0, width: 18, depth: 14, rotY: 0.7,
      height: 22, baseY: 0, skirt: 1.5, color: 0xcccccc,
    };
    const vertsOf = (o: THREE.Object3D | null): number => {
      let n = 0;
      o?.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) n += (m.geometry.getAttribute('position') as THREE.BufferAttribute).count;
      });
      return n;
    };
    const segsOf = (t: string): number =>
      [...t].reduce((a, ch) => a + (SIGN_GLYPHS[ch]?.length ?? 0), 0);
    const strategies: [typeof WORLDS[number], TerrainStyleStrategy][] = [
      ['plastic', createPlasticTerrainStyle()],
      ['cuphead', createPaperTerrainStyle()],
      ['circuit', createCircuitTerrainStyle()],
    ];
    for (const [world, strat] of strategies) {
      const bad: string[] = [];
      let moved = 0;
      for (let s = 1; s <= 24; s++) {
        const t = signContent('commercial', s, world, 'training')!.text;
        const p = signContent('commercial', s, world, 'shop')!.text;
        const want = 24 * (segsOf(t) - segsOf(p));
        if (want !== 0) moved++;
        const got = vertsOf(mountShopSign(strat, box, 0, s, 'commercial', routeDist, 0.8, 'training'))
          - vertsOf(mountShopSign(strat, box, 0, s, 'commercial', routeDist, 0.8, 'shop'));
        if (got !== want) bad.push(`seed ${s}: ${p}→${t} 差 ${got},應為 ${want}`);
      }
      check(`${world}: mountShopSign 蓋出來的字就是訓練詞(逐 seed 對頂點數)`,
        bad.length === 0 && moved >= 8,
        bad.slice(0, 3).join(' | ') || `24 個 seed,其中 ${moved} 個字數不同`);
      // 反向對照:不傳 vocabulary(自由騎)必須跟明寫 'shop' 一模一樣 —— 激勵詞
      // 不可以變成預設。
      check(`${world}: 自由騎(不傳 vocabulary)= 明寫 'shop'`,
        vertsOf(mountShopSign(strat, box, 0, 7, 'commercial', routeDist, 0.8))
          === vertsOf(mountShopSign(strat, box, 0, 7, 'commercial', routeDist, 0.8, 'shop')));
    }
  }

  // 5b. 送得到(buildBuildingMeshes 這一層)—— 一整個 chunk 建完之後還在。
  {
    const originLat = 25;
    const originLon = 121;
    const strat = createPlasticTerrainStyle();
    const footprints = Array.from({ length: 12 }, (_, i) => ({
      coordinates: synthFootprint(originLat, originLon, -60 + i * 22, 40, 18, 14),
      height: 20 + (i % 3) * 4,
    }));
    const scratch = new THREE.Vector3();
    const hashOf = (root: THREE.Object3D): string => {
      root.updateMatrixWorld(true);
      const h = createHash('sha256');
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;
        h.update(`|${pos.count}|`);
        for (let i = 0; i < pos.count; i++) {
          scratch.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          h.update(`${scratch.x.toFixed(3)},${scratch.y.toFixed(3)},${scratch.z.toFixed(3)};`);
        }
      });
      return h.digest('hex');
    };
    const run = async (vocabulary?: SignVocabulary) => {
      const r = await buildBuildingMeshes(
        footprints, FLAT_SAMPLER, originLat, originLon, 0, strat,
        () => 0, (_x, z) => Math.abs(z), () => 'commercial', vocabulary,
      );
      const out = { hash: hashOf(r.mesh), signs: r.signsByZone?.[0]?.[1] ?? 0 };
      disposeBuildingMesh(r);
      return out;
    };
    const asShop = await run('shop');
    const asTraining = await run('training');
    const asDefault = await run();
    check('chunk 真的蓋了店面招牌(不然下面兩條是空的)', asShop.signs >= 6,
      `${asShop.signs} 塊 commercial 招牌`);
    check('buildBuildingMeshes 把 vocabulary 送到招牌上了(整塊 chunk 的幾何不同)',
      asShop.hash !== asTraining.hash, `${asShop.hash.slice(0, 12)} vs ${asTraining.hash.slice(0, 12)}`);
    check('不傳 vocabulary 的 chunk 逐位元組等於 shop(自由騎沒被改到)',
      asDefault.hash === asShop.hash, `${asDefault.hash.slice(0, 12)}`);
  }

  // 5c. 剩下三段線在原始碼裡 —— headless 跑不到(要 MVT、要 canvas、要 Vue),
  //     但少任何一段,訓練詞就停在半路,而上面每一條斷言都還是綠的。
  //     每一條都綁著它那一端的**表達式**,不是「檔案裡出現過這個字」。
  {
    const hops: [string, string, RegExp][] = [
      ['chunk manager → buildBuildingMeshes',
        'packages/web/src/game/terrain/terrain-chunk-manager.ts',
        /this\.zoneAt\(lon, lat\),\s*this\.signVocabulary,/],
      ['useTerrainRenderer → chunk manager',
        'packages/web/src/composables/useTerrainRenderer.ts',
        /signVocabulary:\s*options\.signVocabulary/],
      ['GameView → useTerrainRenderer(判定 = 這趟有 prescribed segments)',
        'packages/web/src/views/GameView.vue',
        /signVocabulary:\s*gameStore\.workoutSegments\.length\s*>\s*0\s*\?\s*'training'\s*:\s*'shop'/],
    ];
    const broken = hops
      .filter(([, file, re]) => !re.test(readFileSync(file, 'utf8')))
      .map(([name]) => name);
    check('招牌詞彙從 GameView 一路接到 chunk 的建置', broken.length === 0,
      broken.join(' | ') || `${hops.length} 段線都在`);
  }
}

// ── 訓練模式:2D(Phaser)那一路 ──
//
// 3D 那半的斷言對的是**頂點**;2D 沒有頂點,只有 Graphics 的繪圖指令,所以這裡對的是
// **畫出來的筆劃**:把 `phaser-stub` 錄下來的指令還原成線段,再從線段**倒推出那是哪
// 一個字**,然後拿那個字去斷言。倒推出來的字才是斷言的對象 —— 這個 repo 最常見的缺陷
// 是「記錄了 ≠ 送得到」,而詞表、參數、旗標三樣都只屬於「記錄了」。
//
// ── 倒推怎麼做(2D 與 3D 用同一套判準,所以兩邊的答案可以直接比) ──
//
//  1. 一筆筆劃 = `sign-carrier.signStroke`(circuit 是它自己的 `strokeQuad`)畫出來的
//     「兩個三角形的軸身 + 兩個方形端帽」。四筆一組,而且端帽必須剛好是邊長 t、
//     中心落在軸身兩端的正方形 —— 這個形狀夠 specific,招牌以外的東西混不進來。
//     3D 那邊一筆是一顆 `BoxGeometry`(24 頂點),用二階矩取長軸還原出同一條線段。
//  2. 字模是逐字排的,相鄰兩個字的 x 區間之間有 0.26 × capW 的淨空(advance = 1.26 ×
//     capW),所以把筆劃依候選詞的字模段數切開之後,每一段的 x 區間必須**隔開真的一段
//     距離** —— 不是只有「不重疊」。零間隙相接是切在某個字模自己內部的共用座標上,
//     精確算術擋得掉、浮點擋不掉(`RUN` vs `RAIL`,見 `fitsWord`)。
//  3. 只有「分離」不夠 —— 'MART'(4-3-6-2)被當成 'GO'(7-8)切也會分離,因為那個切點
//     剛好落在字與字的邊界上。所以再要求每一段的寬度 ≤ 一個字模格,而字模格的大小是從
//     **筆劃粗細**推回來的(`signStrokes`:width = 0.17 capH、capW = 0.72 capH,所以
//     capW = 4.24 × width),那是一個獨立的量測,不是從詞表抄來的。
//  4. 最後要求候選詞裡**剛好一個**符合,不是「至少一個」。含糊就算失敗。
//
// 候選詞是三個世界的店名 ∪ 激勵詞全集,所以「2D 還在講店名」不會被當成解不出來,
// 而是會解出一個**錯的字**。
async function checkTrainingSigns2D(): Promise<void> {
  console.log('\n[training signs — 2D]');
  const WORLDS = ['plastic', 'cuphead', 'circuit'] as const;
  type World = typeof WORLDS[number];
  type Style2D = Awaited<ReturnType<typeof createStyleStrategy>>;
  const SEEDS = 24;
  // `terrain-builder.renderBuilding` 自己算出來的兩個真實尺寸:
  // heightPx = 高度(m) × PX_PER_METER × 0.8,widthPx = clamp(heightPx × 0.6, 15, 40)。
  // 25 m 與 60 m 的臨街建築 —— 兩個尺寸的招牌板寬不同,`signStrokes` 的排版也就不同。
  const BOXES: [number, number][] = [[36, 60], [40, 144]];

  type Cmd = { t: string; col: number; a: number; pts?: number[][] };
  /** 一筆還原出來的筆劃:軸線兩端 + 粗細。`gk` 是當時的填色,用來分批(見下)。 */
  type Stroke = { ax: number; ay: number; bx: number; by: number; t: number; gk: string };

  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-6;
  const isSquare = (c: Cmd | undefined, cx: number, cy: number, t: number): boolean => {
    if (!c || c.t !== 'poly' || c.pts?.length !== 4) return false;
    const xs = c.pts.map((p) => p[0]);
    const ys = c.pts.map((p) => p[1]);
    return near(Math.min(...xs), cx - t / 2) && near(Math.max(...xs), cx + t / 2)
      && near(Math.min(...ys), cy - t / 2) && near(Math.max(...ys), cy + t / 2);
  };

  /** 指令串流 → 筆劃。四筆一組,而且端帽要真的對得上,才算一筆。 */
  const strokesOf = (cmds: Cmd[]): Stroke[] => {
    const out: Stroke[] = [];
    for (let i = 0; i + 3 < cmds.length; i++) {
      const A = cmds[i];
      const B = cmds[i + 1];
      if (A.t !== 'poly' || A.pts?.length !== 3 || B.t !== 'poly' || B.pts?.length !== 3) continue;
      const [P0, P1, P2] = A.pts;
      // 軸身第一個三角形是 (a+p, b+p, b−p),所以 b 與 p 直接讀得回來。
      const bx = (P1[0] + P2[0]) / 2;
      const by = (P1[1] + P2[1]) / 2;
      const px = (P1[0] - P2[0]) / 2;
      const py = (P1[1] - P2[1]) / 2;
      const ax = P0[0] - px;
      const ay = P0[1] - py;
      const t = 2 * Math.hypot(px, py);
      if (!(t > 1e-9)) continue;
      const [Q0, Q1, Q2] = B.pts;
      if (!near(Q0[0], P0[0]) || !near(Q0[1], P0[1])) continue;
      if (!near(Q1[0], bx - px) || !near(Q1[1], by - py)) continue;
      if (!near(Q2[0], ax - px) || !near(Q2[1], ay - py)) continue;
      if (!isSquare(cmds[i + 2], ax, ay, t) || !isSquare(cmds[i + 3], bx, by, t)) continue;
      out.push({ ax, ay, bx, by, t, gk: `${A.col}|${A.a}` });
      i += 3;
    }
    return out;
  };

  /** 這一串筆劃,切得成 `word` 的字模嗎?(§2 隔開 + §3 一格寬) */
  const fitsWord = (st: readonly Stroke[], word: string): boolean => {
    const counts = [...word].map((c) => SIGN_GLYPHS[c]?.length ?? 0);
    if (counts.some((n) => n === 0)) return false;
    if (counts.reduce((a, b) => a + b, 0) !== st.length) return false;
    // capW = (0.72 / 0.17) × 筆劃粗細。`signStrokes` 縮排時只會讓 capW 變小,所以這是
    // 上界;× 1.25 是留給塑膠貼紙 3–6° 歪斜把字模格的 x 投影撐開的餘裕(實測 1.14×)。
    const capWMax = (0.72 / 0.17) * st[0].t * 1.25;
    // ── 「不重疊」不夠,要「隔得開」 ──
    //
    // 原本只要求 `lo > prevHi`,而 0 是一個合法的間隙 —— 一個切點**剛好落在某個字模
    // 自己內部的共用 x 座標上**時,兩段就是零間隙相接,精確算術下 `>` 剛好擋掉,浮點
    // 誤差下擋不掉。`RUN`(6-5-3)與 `RAIL`(6-3-3-2)是實例:14 筆切成 6/3/3/2 時,
    // 第 2 段的右界與第 3 段的左界都是 `U` 的 x = 0.66 那一點。2D 讀的是繪圖指令,
    // 座標原封不動,tie 被 `>` 擋下;3D 從 24 個頂點的二階矩反推軸線,同一個 tie 變成
    // 9.1e-8 × 筆寬的正數,`RAIL` 就混進來了 —— 於是同一個 seed「2D 讀出 RUN、3D 讀
    // 不出來(兩個都符合)」。抓到它的是跨渲染器那條斷言,而那條斷言只說得出「?」。
    //
    // 門檻是**推導出來的,不是調出來的**:`signStrokes` 的 advance = 1.26 × capW,所以
    // 相鄰兩個字模格之間的淨空是 0.26 capW = 0.26 × (0.72/0.17) × 筆寬 = 1.10 × 筆寬。
    // 取一半當地板。實測(三個世界 × 24 seed × 兩本詞彙 × 兩個尺寸,2D+3D):
    //   對的字最小間隙 1.127 × 筆寬(plastic 歪斜那一組) —— 地板下方 2.05 倍餘裕
    //   混進來的錯字間隙 9.08e-8 × 筆寬               —— 地板上方 6.1e6 倍
    // 兩者之間差七個數量級,所以這個地板挑在哪裡都一樣;它只擋 tie,不擋任何真的間隙。
    const gapMin = 0.26 * (0.72 / 0.17) * st[0].t * 0.5;
    let i = 0;
    let prevHi = -Infinity;
    for (const n of counts) {
      const g = st.slice(i, i + n);
      i += n;
      const lo = Math.min(...g.flatMap((s) => [s.ax, s.bx]));
      const hi = Math.max(...g.flatMap((s) => [s.ax, s.bx]));
      if (!(lo - prevHi > gapMin) || hi - lo > capWMax) return false;
      prevHi = hi;
    }
    return true;
  };

  /** 剛好一個候選詞符合才算解出來。 */
  const wordOf = (st: readonly Stroke[], cands: readonly string[]): string | null => {
    if (!st.length) return null;
    const hit = cands.filter((w) => fitsWord(st, w));
    return hit.length === 1 ? hit[0] : null;
  };

  /**
   * 「墨長比」= 全部筆劃的長度總和 ÷ 筆劃粗細。
   *
   * 這個比值只跟**字**與**排版比例**有關,跟招牌多大、轉了幾度、在哪一個引擎裡畫的
   * 都無關(`signStrokes` 的每一個數字都正比於 capH,而粗細也是)。所以 2D 與 3D 拿
   * 同一個字排出來的版,墨長比必須**完全相同** —— 它比「同一個字」更嚴:字對了但排版
   * 縮過(`signStrokes` 的 shrink-to-fit)兩邊就對不上。
   */
  const inkRatio = (st: readonly Stroke[]): number =>
    st.reduce((a, s) => a + Math.hypot(s.bx - s.ax, s.by - s.ay), 0) / st[0].t;

  /** 一次倒推的結果:字 + 墨長比 + 每一批填色各撿到幾筆。 */
  type Read = { word: string; ink: number; groups: number[] } | null;

  /** 2D:整串指令 → 招牌上的那個字。同一批填色的筆劃算一組(瓦楞紙的壓凹是同一組字
   *  畫兩次,深淺兩色),解得出來的組必須全部指向同一個字。 */
  const word2D = (cmds: Cmd[], cands: readonly string[]): Read => {
    const byPaint = new Map<string, Stroke[]>();
    for (const s of strokesOf(cmds)) {
      const arr = byPaint.get(s.gk);
      if (arr) arr.push(s);
      else byPaint.set(s.gk, [s]);
    }
    const hits = [...byPaint.values()]
      .map((v) => [wordOf(v, cands), v] as const)
      .filter((h): h is [string, Stroke[]] => h[0] !== null);
    const words = new Set(hits.map(([w]) => w));
    if (words.size !== 1) return null;
    return {
      word: hits[0][0],
      ink: inkRatio(hits[0][1]),
      groups: [...byPaint.values()].map((v) => v.length),
    };
  };

  /** 3D:一顆 24 頂點的盒子 → 它的軸線。二階矩的長軸就是筆劃方向,長短軸的半徑差
   *  就是 (len + width)/2 − width/2 = len/2 —— `buildStrokeGeometry` 把每一筆加長了
   *  一個筆寬做方形端帽,這裡正好把它扣回去。 */
  const boxSeg = (pos: THREE.BufferAttribute, at: number): Stroke | null => {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 24; i++) { cx += pos.getX(at + i); cy += pos.getY(at + i); }
    cx /= 24;
    cy /= 24;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < 24; i++) {
      const dx = pos.getX(at + i) - cx;
      const dy = pos.getY(at + i) - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    sxx /= 24; sxy /= 24; syy /= 24;
    const tr = sxx + syy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (!(l1 > 0)) return null;
    let ux = Math.abs(sxy) > 1e-12 ? l1 - syy : (sxx >= syy ? 1 : 0);
    let uy = Math.abs(sxy) > 1e-12 ? sxy : (sxx >= syy ? 0 : 1);
    const n = Math.hypot(ux, uy) || 1;
    ux /= n; uy /= n;
    const half = Math.sqrt(l1) - Math.sqrt(Math.max(0, l2));
    return {
      ax: cx - ux * half, ay: cy - uy * half, bx: cx + ux * half, by: cy + uy * half,
      t: 2 * Math.sqrt(Math.max(0, l2)), gk: '3d',
    };
  };

  const word3D = (root: THREE.Object3D | null, cands: readonly string[]): Read => {
    if (!root) return null;
    const hits: [string, Stroke[]][] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // 幾何是**招牌板自己的座標系**(x 向右、y 向上),所以直接讀 position,不套任何
      // 世界矩陣 —— 傾角、朝向、建築物的旋轉都不必還原。
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || pos.count % 24 !== 0 || pos.count < 48) return;
      const segs: Stroke[] = [];
      for (let k = 0; k * 24 < pos.count; k++) {
        const s = boxSeg(pos, k * 24);
        if (!s) return;
        segs.push(s);
      }
      const w = wordOf(segs, cands);
      if (w) hits.push([w, segs]);
    });
    const words = new Set(hits.map(([w]) => w));
    if (words.size !== 1) return null;
    return { word: hits[0][0], ink: inkRatio(hits[0][1]), groups: [hits[0][1].length] };
  };

  /** 指令的可比字串(丟掉 Graphics 本體與流水號,其餘逐欄位)。 */
  const streamKey = (cmds: Cmd[]): string => cmds.map((c) => Object.keys(c)
    .filter((k) => k !== 'g' && k !== 'seq')
    .sort()
    .map((k) => `${k}=${JSON.stringify((c as unknown as Record<string, unknown>)[k])}`)
    .join(','))
    .join('|');

  const styles = new Map<World, Style2D>();
  for (const w of WORLDS) styles.set(w, await createStyleStrategy(w));
  const style3D: Record<World, TerrainStyleStrategy> = {
    plastic: createPlasticTerrainStyle(),
    cuphead: createPaperTerrainStyle(),
    circuit: createCircuitTerrainStyle(),
  };
  // 候選詞:這個世界的店名 ∪ 激勵詞,從 `signContent` 的**回傳值**收集(不是抄詞表 ——
  // 宣告了卻永遠抽不到的詞不該進候選)。
  const CANDS = new Map<World, string[]>(WORLDS.map((w) => [w, [...new Set(
    Array.from({ length: 400 }, (_, s) => [
      signContent('commercial', s + 1, w, 'shop')!.text,
      signContent('commercial', s + 1, w, 'training')!.text,
    ]).flat(),
  )]]));

  // 倒推是否**唯一**,取決於同一個世界裡沒有兩個詞的字模段數輪廓相同 —— 這是可驗證的
  // 事實,所以驗它,不要假設它。三本詞彙裡加進一個撞號的詞,會在這裡先失敗(而不是讓
  // 下面每一條安靜地退化成「解不出來」)。
  //
  // ⚠ 跨世界是會撞的:OAT/BIT、TILE/LIVE、POST/PORT、WAX/MAX 的輪廓一模一樣(字模段數
  // 分不出 O 與 B、T 與 V、S 與 R、W 與 M)。所以候選詞刻意逐世界收 —— 而「這個世界拿了
  // 別人的詞」在下面會解不出來,一樣是失敗,只是理由印成「解不出來」。
  for (const world of WORLDS) {
    const profs = CANDS.get(world)!.map((w) => [...w].map((c) => SIGN_GLYPHS[c]?.length ?? 0).join('-'));
    const dup = profs.filter((p, i) => profs.indexOf(p) !== i);
    check(`${world}: 字模段數輪廓逐詞互不相同(倒推才唯一)`, dup.length === 0,
      dup.join(' ') || `${profs.length} 個詞 / ${new Set(profs).size} 種輪廓`);
  }

  // 而輪廓互不相同只是**必要條件**,不是充分條件 —— 輪廓不同的兩個詞照樣可能互相符合,
  // 因為切點可以落在某個字模自己內部(`RUN` 6-5-3 vs `RAIL` 6-3-3-2 就是這樣混進來的)。
  // 所以直接驗那個前提本身:拿 `signStrokes` 排出每個候選詞的**基準版**,丟回同一個
  // `fitsWord`,要求剛好只有它自己符合。詞池從 22–30 個長到 32–40 個之後,兩個詞恰好
  // 互相符合的機會是平方成長的,而輪廓那條看不見這一類。
  for (const world of WORLDS) {
    const cands = CANDS.get(world)!;
    const ideal = (word: string): Stroke[] => signStrokes(9, 3, word)
      .map((s) => ({ ax: s.x0, ay: s.y0, bx: s.x1, by: s.y1, t: s.width, gk: 'ideal' }));
    const bad = cands
      .map((w) => [w, cands.filter((c) => fitsWord(ideal(w), c))] as const)
      .filter(([w, hits]) => hits.length !== 1 || hits[0] !== w)
      .map(([w, hits]) => `${w}→[${hits.join(' ')}]`);
    check(`${world}: 每個候選詞的基準版只解得出它自己(輪廓不同也可能互相符合)`,
      bad.length === 0, bad.slice(0, 3).join(' ') || `${cands.length} 個詞各自唯一`);
  }

  const record = (
    world: World, bw: number, bh: number, seed: number, zone: ZoneKind,
    vocabulary?: SignVocabulary,
  ): Cmd[] => {
    const sink = new Sink2D();
    const gfx = makeGraphics2D(sink) as never;
    const style = styles.get(world)!;
    // vocabulary 省略 = 自由騎的那條路徑,刻意走「少傳一個參數」而不是明寫 'shop'。
    if (vocabulary === undefined) {
      style.renderBuilding(gfx, 200 - bw / 2, 400 - bh, bw, bh, 0, seed, zone, []);
    } else {
      style.renderBuilding(gfx, 200 - bw / 2, 400 - bh, bw, bh, 0, seed, zone, [], vocabulary);
    }
    return (sink as unknown as { cmds: Cmd[] }).cmds;
  };

  // 1. 解碼器本身是活的:自由騎(明寫 'shop')畫出來的字,逐 seed 就是店名。
  //    這條先來 —— 解碼器解不出東西的話,下面每一條都會變成空的。
  for (const world of WORLDS) {
    const bad: string[] = [];
    let n = 0;
    for (const [bw, bh] of BOXES) {
      for (let s = 1; s <= SEEDS; s++) {
        n++;
        const got = word2D(record(world, bw, bh, s, 'commercial', 'shop'), CANDS.get(world)!);
        const want = signContent('commercial', s, world, 'shop')!.text;
        if (got?.word !== want) bad.push(`${bw}x${bh}@${s}: 想要 ${want},畫出 ${got?.word ?? '(解不出來)'}`);
      }
    }
    check(`${world}: 自由騎的 2D 招牌畫出來的就是店名(逐 seed 從指令串流倒推)`,
      bad.length === 0, bad.slice(0, 3).join(' | ') || `${n} 個 seed×尺寸全中`);
  }

  // 1b. 倒推器只撿到**招牌的字**,沒有把別的東西當成筆劃。
  //
  //     這條在守方形端帽那個判準:塑膠貼紙的白邊、底色、印刷面都是 `quad()` 畫的,而一
  //     個 quad 的兩個三角形跟一筆筆劃的軸身**形狀完全一樣**(a+p, b+p, b−p / a+p, b−p,
  //     a−p),分得出來的只有那兩個方形端帽。所以:每一批填色撿到的筆劃數,都必須剛好
  //     等於那個字的字模段數(瓦楞紙的壓凹是同一個字畫兩次,兩批各自剛好一份)。
  for (const world of WORLDS) {
    const bad: string[] = [];
    for (const [bw, bh] of BOXES) {
      for (let s = 1; s <= SEEDS; s++) {
        const got = word2D(record(world, bw, bh, s, 'commercial', 'training'), CANDS.get(world)!);
        if (!got) { bad.push(`${bw}x${bh}@${s}: 解不出來`); continue; }
        const segs = [...got.word].reduce((a, c) => a + (SIGN_GLYPHS[c]?.length ?? 0), 0);
        if (got.groups.some((n) => n !== segs)) {
          bad.push(`${bw}x${bh}@${s}: ${got.word} 有 ${segs} 筆,撿到 ${got.groups.join('+')}`);
        }
      }
    }
    check(`${world}: 倒推器撿到的每一批都剛好是那個字的筆劃(沒有撈到招牌以外的東西)`,
      bad.length === 0, bad.slice(0, 3).join(' | ') || `${BOXES.length * SEEDS} 個 seed×尺寸`);
  }

  // 2. 訓練模式:畫出來的字換成了激勵詞,而且是**這個世界自己那本**的。
  for (const world of WORLDS) {
    const shelf = new Set<string>(SIGN_TRAINING_WORDS[world]);
    const bad: string[] = [];
    let n = 0;
    for (const [bw, bh] of BOXES) {
      for (let s = 1; s <= SEEDS; s++) {
        n++;
        const got = word2D(record(world, bw, bh, s, 'commercial', 'training'), CANDS.get(world)!);
        const want = signContent('commercial', s, world, 'training')!.text;
        if (got?.word !== want || !shelf.has(got.word)) {
          bad.push(`${bw}x${bh}@${s}: 想要 ${want},畫出 ${got?.word ?? '(解不出來)'}`);
        }
      }
    }
    check(`${world}: 訓練模式的 2D 招牌畫出來的是這個世界自己的激勵詞`,
      bad.length === 0, bad.slice(0, 3).join(' | ') || `${n} 個 seed×尺寸全中,詞庫 ${shelf.size} 個`);
  }

  // 3. 恆真句的保險:兩本詞彙畫出來的指令串流必須**每一個 seed 都不同**。少了這條,
  //    上面兩條在「vocabulary 整個被忽略、兩邊都畫店名」的世界裡…會失敗;但在
  //    「fixture 剛好讓兩本詞彙選到同一個字」的世界裡就會一起變成恆真。
  for (const world of WORLDS) {
    let same = 0;
    let n = 0;
    for (const [bw, bh] of BOXES) {
      for (let s = 1; s <= SEEDS; s++) {
        n++;
        if (streamKey(record(world, bw, bh, s, 'commercial', 'shop'))
          === streamKey(record(world, bw, bh, s, 'commercial', 'training'))) same++;
      }
    }
    check(`${world}: 訓練與自由騎的 2D 招牌逐 seed 畫出不同的東西`, same === 0,
      same === 0 ? `${n} 個 seed×尺寸全都不同` : `${same}/${n} 個一模一樣`);
  }

  // 4. 不傳 vocabulary(自由騎的呼叫形狀)必須逐位元組等於明寫 'shop' —— 激勵詞不可以
  //    變成預設,Welcome 背景與 headless probe 走的就是這條。
  for (const world of WORLDS) {
    const bad: string[] = [];
    for (const [bw, bh] of BOXES) {
      for (let s = 1; s <= SEEDS; s++) {
        if (streamKey(record(world, bw, bh, s, 'commercial'))
          !== streamKey(record(world, bw, bh, s, 'commercial', 'shop'))) bad.push(`${bw}x${bh}@${s}`);
      }
    }
    check(`${world}: 不傳 vocabulary = 明寫 'shop'`, bad.length === 0,
      bad.slice(0, 3).join(' ') || `${BOXES.length * SEEDS} 個 seed×尺寸逐指令相同`);
  }

  // 5. 兩條渲染路徑不可以各講各的:同一個世界、同一個 seed,2D 畫出來的字必須等於 3D
  //    蓋出來的字。兩邊都是**從畫出來的東西倒推**的 —— 2D 讀指令串流、3D 讀頂點盒子,
  //    中間沒有共用的答案來源,所以「2D 還接在 'shop' 上」會被抓成兩個不同的字。
  {
    const routeDist = (_x: number, z: number): number => Math.abs(60 - z);
    const box = {
      cx: 0, cz: 0, width: 18, depth: 14, rotY: 0.7,
      height: 22, baseY: 0, skirt: 1.5, color: 0xcccccc,
    };
    for (const vocabulary of ['shop', 'training'] as const) {
      const bad: string[] = [];
      let pairs = 0;
      for (const world of WORLDS) {
        for (let s = 1; s <= SEEDS; s++) {
          const a = word2D(record(world, BOXES[1][0], BOXES[1][1], s, 'commercial', vocabulary), CANDS.get(world)!);
          const b = word3D(
            mountShopSign(style3D[world], box, 0, s, 'commercial', routeDist, 0.8, vocabulary),
            CANDS.get(world)!,
          );
          pairs++;
          if (a === null || b === null || a.word !== b.word) {
            bad.push(`${world}@${s}: 2D ${a?.word ?? '?'} vs 3D ${b?.word ?? '?'}`);
          } else if (Math.abs(a.ink - b.ink) > 1e-6 * Math.max(1, b.ink)) {
            // 同一個字、不同的版:兩邊的 shrink-to-fit 或字高比例走岔了。
            bad.push(`${world}@${s}: ${a.word} 墨長比 2D ${a.ink.toFixed(4)} vs 3D ${b.ink.toFixed(4)}`);
          }
        }
      }
      check(`vocabulary='${vocabulary}':同一個 seed 下 2D 與 3D 畫出同一個字、同一版`,
        bad.length === 0, bad.slice(0, 3).join(' | ') || `${pairs} 組字與墨長比全中`);
    }
  }

  // 6. 反向:學校與醫院不歸詞彙管。這裡不比字,比**整串指令** —— 使用者剛明確指示這
  //    兩個不換字,所以要釘的是「什麼都沒動」,不是「字還是 ABC」。
  for (const world of WORLDS) {
    const bad: string[] = [];
    for (const zone of ['school', 'hospital'] as const) {
      for (const [bw, bh] of BOXES) {
        for (let s = 1; s <= SEEDS; s++) {
          if (streamKey(record(world, bw, bh, s, zone, 'shop'))
            !== streamKey(record(world, bw, bh, s, zone, 'training'))) bad.push(`${zone}@${bw}x${bh}#${s}`);
        }
      }
    }
    check(`${world}: 學校與醫院的 2D 招牌在訓練模式下逐指令不變`, bad.length === 0,
      bad.slice(0, 3).join(' ') || `2 種分區 × ${BOXES.length * SEEDS} 個 seed×尺寸`);
  }

  // 7. 剩下三段線在原始碼裡 —— headless 跑不到(Phaser 在 Node 起不來、要 MVT、要 Vue)。
  //    每一條都綁著它那一端的**表達式**,不是「檔案裡出現過這個字」。
  {
    const src = (f: string): string => readFileSync(f, 'utf8');
    const hops: [string, boolean][] = [
      ['chunk manager(2D) → strategy.renderBuilding',
        /renderBuilding\([\s\S]{0,200}?zone,\s*posts,\s*this\.signVocabulary\)/
          .test(src('packages/web/src/game/phaser/terrain-builder.ts'))],
      // 2D chunk manager 的預設值只有原始碼驗得到:Phaser 在 Node 起不來,所以「自由騎
      // 的 chunk 沒被改到」這件事在 2D 這一端沒有可執行的版本(3D 那邊有,見 5b)。
      ['chunk manager(2D) 的預設是 shop,不是 training',
        /signVocabulary: SignVocabulary = 'shop',/
          .test(src('packages/web/src/game/phaser/terrain-builder.ts'))],
      ['usePhaserRenderer → chunk manager(2D)',
        /new ChunkMgr\([\s\S]{0,200}?opts\.signVocabulary \?\? 'shop'\)/
          .test(src('packages/web/src/composables/usePhaserRenderer.ts'))],
      // 兩條渲染路徑用的是同一個判定式,所以這裡數的是**出現兩次** —— 只補一邊會被抓到。
      ['GameView 的兩條渲染路徑都做了同一個判定',
        [...src('packages/web/src/views/GameView.vue').matchAll(
          /signVocabulary:\s*gameStore\.workoutSegments\.length\s*>\s*0\s*\?\s*'training'\s*:\s*'shop'/g,
        )].length === 2],
    ];
    const broken = hops.filter(([, ok]) => !ok).map(([name]) => name);
    check('招牌詞彙從 GameView 一路接到 2D chunk 的建置', broken.length === 0,
      broken.join(' | ') || `${hops.length} 段線都在`);
  }
}

// ── Land-use zoning: the pipe that was never connected ──
function checkZoning(): void {
  console.log('\n[land-use zoning]');

  // Eleven MVT classes, five zones. Seven of the eleven used to fall back to
  // residential grey — recognised, fetched, projected, then drawn identically.
  check('retail folds into commercial', zoneFromLanduseClass('retail') === 'commercial');
  check('every education class folds into school',
    ['school', 'university', 'college', 'kindergarten', 'library', 'education']
      .every((c) => zoneFromLanduseClass(c) === 'school'));
  check('hospital and industrial keep their own kind',
    zoneFromLanduseClass('hospital') === 'hospital'
      && zoneFromLanduseClass('industrial') === 'industrial');
  // Null, NOT residential. "Outside every zone" and "in a residential zone" are
  // different facts; collapsing them turns every rural route into a suburb.
  check('unknown / absent class is null, not residential',
    zoneFromLanduseClass('forest') === null && zoneFromLanduseClass(undefined) === null);

  // Winding number, not even-odd: OSM landuse polygons routinely trace back
  // along their own edge around a courtyard, and even-odd gets those inside-out.
  const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  check('point-in-ring: inside', pointInRing(1, 1, square));
  check('point-in-ring: outside', !pointInRing(3, 1, square));

  // Shuffle bag, not independent draws. Independent draws skew badly at route
  // scale — whole kilometres come out one single zone, which reads as a bug
  // even though every draw was fair.
  const rng = mulberry32(7);
  const bag = createShuffleBag(['a', 'b', 'c'], rng);
  const first3 = [bag(), bag(), bag()].sort().join('');
  check('shuffle bag draws every entry before repeating', first3 === 'abc', first3);
  const weighted = createShuffleBag(['x', 'y'], mulberry32(11), [4, 1]);
  const draws = Array.from({ length: 50 }, () => weighted());
  const xs = draws.filter((d) => d === 'x').length;
  check('weights bias the bag without hard-mapping it', xs > 30 && xs < 45, `${xs}/50 were x`);
}

// ── Shop signs land on the side of the building the rider is on ──
function checkSignPlacement(name: string, strategy: TerrainStyleStrategy): void {
  console.log(`\n[sign placement — ${name}]`);
  const box = {
    cx: 0, cz: 0, width: 18, depth: 14, rotY: 0.7,
    height: 22, baseY: 0, skirt: 1.5, color: 0xcccccc,
  };
  // Pretend the road runs along z = +60. Every sign must face it.
  const routeDist = (_x: number, z: number) => Math.abs(60 - z);

  for (const zone of ['commercial', 'school', 'hospital'] as const) {
    const g = mountShopSign(strategy, box, 0, 5, zone, routeDist, 0.8);
    if (!g) { check(`${zone}: sign built`, false); continue; }
    g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g);
    const c = bb.getCenter(new THREE.Vector3());
    check(`${zone}: sign faces the route, not the back wall`, c.z > 0, `z = ${c.z.toFixed(1)}`);
    // 0.55–0.70 of the building height (DEVPLAN). Too low and the building
    // itself hides it as the rider comes alongside.
    check(`${zone}: hung at 0.55–0.70 of the building height`,
      c.y >= 22 * 0.5 && c.y <= 22 * 0.75, `y = ${c.y.toFixed(1)}`);
    // Tilting about the plate centre swings its lower edge into the wall; the
    // standoff has to grow to compensate, so the whole plate stays outside.
    const half = Math.hypot(box.width, box.depth) / 2;
    check(`${zone}: the whole plate is outside the wall`,
      Math.hypot(c.x, c.z) > box.depth / 2, `${Math.hypot(c.x, c.z).toFixed(1)} > ${(box.depth / 2).toFixed(1)} (obb half ≤ ${half.toFixed(1)})`);
  }

  check('residential and industrial hang nothing',
    mountShopSign(strategy, box, 0, 5, 'residential', routeDist, 0.8) === null
      && mountShopSign(strategy, box, 0, 5, 'industrial', routeDist, 0.8) === null);

  // A hut too narrow for a legible plate gets nothing rather than a smudge.
  const hut = { ...box, width: 2.2, depth: 2.2, height: 3 };
  check('a building too small for a legible sign gets none',
    mountShopSign(strategy, hut, 0, 5, 'commercial', routeDist, 0.8) === null);
}

// ── Street lamps slide along a route ──
function checkLamps(): void {
  console.log('\n[street lamps]');
  const scene = new THREE.Scene();
  const strategy = createPaperTerrainStyle();

  // A 1 km straight route heading north.
  const points = Array.from({ length: 51 }, (_, i) => ({
    lat: 25 + (i * 20) / 111320,
    lon: 121,
    ele: 10,
    time: i * 1000,
  }));
  const cum = points.map((_, i) => i * 20);

  const lamps = new StreetLampManager(scene, strategy, points as never, cum, 25, 121);
  lamps.update(0, 1);
  const visible = scene.children.filter((c) => c.visible);
  check('lamps: a pool is placed around the rider', visible.length > 3,
    `${visible.length}/${scene.children.length} visible`);
  check(
    'lamps: alternate sides of the road',
    new Set(visible.map((c) => Math.sign(c.position.x))).size === 2,
  );
  const before = visible.map((c) => c.position.z);
  lamps.update(500, 1);
  const after = scene.children.filter((c) => c.visible).map((c) => c.position.z);
  check(
    'lamps: recycle forward as the rider advances (constant pool size)',
    scene.children.length === visible.length + (scene.children.length - visible.length) &&
      Math.min(...after) < Math.min(...before),
    `pool stays ${scene.children.length}`,
  );
  // ── Tunnel: a dense row of lamps, lit at noon (we draw no bore) ──
  const spacingOf = (inTunnel: boolean): number => {
    lamps.update(1000, 0, undefined, inTunnel);
    const xs = lamps['lamps']
      .filter((l: any) => l.parts.group.visible)
      .map((l: any) => l.distanceM)
      .sort((a: number, b: number) => a - b);
    return xs.length > 1 ? xs[1] - xs[0] : 0;
  };
  const openSpacing = spacingOf(false);
  const tunnelSpacing = spacingOf(true);
  check(
    'tunnel: lamps pack in tight (that IS the tunnel — no bore is modelled)',
    tunnelSpacing > 0 && tunnelSpacing < openSpacing / 2,
    `${tunnelSpacing} m apart vs ${openSpacing} m on the open road`,
  );

  // Broad daylight (nightFactor 0) — outside they are off, inside they are on.
  lamps.update(1000, 0, undefined, true);
  const litInTunnel = lamps['lamps'].filter(
    (l: any) => l.parts.group.visible &&
      l.parts.group.children.some((c: any) => c.isPointLight && c.visible),
  ).length;
  lamps.update(1000, 0, undefined, false);
  const litOutside = lamps['lamps'].filter(
    (l: any) => l.parts.group.visible &&
      l.parts.group.children.some((c: any) => c.isPointLight && c.visible),
  ).length;
  check(
    'tunnel: lamps burn in broad daylight; on the open road at noon they do not',
    litInTunnel > 0 && litOutside === 0,
    `${litInTunnel} lit inside vs ${litOutside} outside (both at noon)`,
  );
  check(
    'tunnel: live point lights are capped (20 lamps, but not 20 lights)',
    litInTunnel <= 8,
    `${litInTunnel} point lights for the whole row`,
  );

  lamps.dispose();
  check('lamps: dispose clears the scene', scene.children.length === 0);
  strategy.dispose();
}

// ── Route line: a mark drawn on the road, not a floating guide ──
function checkRouteLine(name: string, strategy: TerrainStyleStrategy): void {
  console.log(`\n[route line — ${name}]`);

  // A straight 500 m route heading north.
  const points = Array.from({ length: 26 }, (_, i) => ({
    lat: 25 + (i * 20) / 111320,
    lon: 121,
    ele: 0,
    distance: i * 20,
  })) as any;

  const group = createRouteLine(points, 25, 121, 0, { width: 800, height: 600 }, {
    style: strategy.routeLine,
  });

  const names = group.children.map((c) => c.name).sort();
  check(
    'two flat ribbons: the marker stroke and its halo',
    names.length === 2 && names[0] === 'route/core' && names[1] === 'route/glow',
    names.join(' + ') || '(none)',
  );

  // The route is resampled: GPX points are ~70 m apart (2 km at worst), and one
  // vertex per point makes a plank that sinks through the terrain and the road.
  const verts = (group.userData._routePositions as number[]).length / 3;
  const srcIdx = group.userData._routeSrcIdx as number[];
  check(
    'route is resampled to a few metres per vertex (not one per GPX point)',
    verts > points.length * 3 && verts === srcIdx.length,
    `${verts} vertices from ${points.length} GPX points (~${(500 / (verts - 1)).toFixed(1)} m apart)`,
  );
  check(
    'each vertex remembers its source GPX point, ascending',
    srcIdx[0] === 0 &&
      srcIdx[srcIdx.length - 1] === points.length - 1 &&
      srcIdx.every((v, i) => i === 0 || v >= srcIdx[i - 1]),
  );

  check(
    'no chevron runway lights (the demos have none)',
    !group.getObjectByName('arrowLights'),
  );

  let onBloom = 0;
  group.traverse((o) => {
    if (o.layers.isEnabled(BLOOM_LAYER) && o !== group) onBloom++;
  });
  check('nothing on the bloom layer — the mark is matte', onBloom === 0);

  const core = group.getObjectByName('route/core') as THREE.Mesh;
  const glow = group.getObjectByName('route/glow') as THREE.Mesh;
  const coreBox = new THREE.Box3().setFromObject(core);
  const glowBox = new THREE.Box3().setFromObject(glow);

  check(
    'the halo is wider than the stroke it sits under',
    glowBox.getSize(new THREE.Vector3()).x > coreBox.getSize(new THREE.Vector3()).x,
    `glow ${glowBox.getSize(new THREE.Vector3()).x.toFixed(1)} m vs core ` +
      `${coreBox.getSize(new THREE.Vector3()).x.toFixed(1)} m`,
  );

  check(
    'the stroke renders over its own halo',
    core.renderOrder > glow.renderOrder,
  );

  for (const m of [core, glow]) {
    const mat = m.material as THREE.MeshBasicMaterial;
    check(
      `${m.name}: transparent, no depth write (props stay visible over it)`,
      mat.transparent && !mat.depthWrite && mat.opacity < 1,
      `opacity ${mat.opacity}`,
    );
  }

  // A chunk load projects only its own slice. `range` is in ORIGINAL point
  // indices, the vertices are resampled — if that translation is missing, the
  // wrong stretch of line gets stuck to the ground.
  const partial = projectRouteLineOntoTerrain(group, () => 100, undefined, {
    startIdx: 0,
    endIdx: 4,
  });
  const lifted = (group.userData._routePositions as number[]).filter(
    (_, i) => i % 3 === 1 && _ > 50,
  ).length;
  check(
    'a chunk load projects only its own slice (original-point range → vertex range)',
    partial > 5 && partial < verts && lifted === partial,
    `${partial} of ${verts} vertices (GPX points 0–4 of ${points.length})`,
  );

  // Project onto flat ground at y = 100 and confirm the mark lands ON the road
  // (road = terrain + 0.3), not metres above it like the old guide line.
  const projected = projectRouteLineOntoTerrain(group, () => 100);
  check('projects the whole route when no range is given', projected === verts, `${projected} vertices`);

  const y = new THREE.Box3().setFromObject(core).min.y - 100;
  check(
    'the mark lies on the road surface, not floating above the world',
    y > 0.3 && y < 1.5,
    `${y.toFixed(2)} m above ground (road is at 0.30 m)`,
  );

  const glowY = new THREE.Box3().setFromObject(glow).min.y - 100;
  check('the halo tucks just under the stroke', glowY < y, `${glowY.toFixed(2)} m vs ${y.toFixed(2)} m`);

  disposeRouteLine(group);
  check('route line disposes cleanly', group.children.length === 0);
  strategy.dispose();
}

/**
 * The 3D palette IS the demo's palette — read from the demo, not copied.
 *
 * Same discipline as the 2D night veil, and for the same reason: "跟 demo 一樣的
 * 光影" is the requirement, so an assertion against a constant somebody typed
 * here only re-confirms the typing. The 2D side proved this matters — a night
 * depth derived from the wrong reference passed its own check while the frame
 * was 1.6× too dark.
 *
 * The demos declare `DAY` / `NIGHT` objects of THREE.Color literals; parse them.
 */
function checkSkyPaletteMatchesDemo(name: string, strategy: TerrainStyleStrategy, demoFile: string): void {
  console.log(`\n[sky palette vs demo — ${name}]`);

  const src = readFileSync(demoFile, 'utf8');
  const grab = (which: 'DAY' | 'NIGHT'): Record<string, string> | null => {
    const at = src.search(new RegExp(`const\\s+${which}\\s*=\\s*\\{`));
    if (at < 0) return null;
    const body = src.slice(at, src.indexOf('};', at));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(\w+)\s*:\s*new THREE\.Color\('(#[0-9a-fA-F]{6})'\)/g)) {
      out[m[1]] = m[2].toLowerCase();
    }
    for (const m of body.matchAll(/(\w+)\s*:\s*([0-9.]+)\s*[,}]/g)) out[m[1]] = m[2];
    return out;
  };

  const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
  for (const [which, ours] of [['DAY', strategy.skyPalette.day], ['NIGHT', strategy.skyPalette.night]] as const) {
    const demo = grab(which);
    check(`${demoFile.split('/').pop()} declares ${which}`, demo !== null && Object.keys(demo).length > 5,
      demo ? `${Object.keys(demo).length} fields` : 'not found');
    if (!demo) continue;

    // Colour and intensity names differ between demo and gameview; map them.
    const pairs: [string, string | number][] = [
      ['top', hex(ours.skyTop)], ['bottom', hex(ours.skyBottom)], ['fog', hex(ours.fog)],
      ['sun', hex(ours.sunColor)], ['hemiSky', hex(ours.hemiSky)], ['hemiGround', hex(ours.hemiGround)],
      ['sunI', ours.sunIntensity], ['hemiI', ours.hemiIntensity], ['amb', ours.ambientIntensity],
    ];
    // Compare numerically where both sides are numbers: the demo writes `2.0`
    // and gameview stores `2`, which are the same intensity and different
    // strings. Colours stay string-compared (they are hex, not quantities).
    const same = (a: string, b: string | number): boolean => {
      const na = Number(a), nb = Number(b);
      return Number.isFinite(na) && Number.isFinite(nb) && !a.startsWith('#')
        ? na === nb
        : a === String(b);
    };
    const bad = pairs.filter(([k, v]) => demo[k] === undefined || !same(demo[k], v));
    check(
      `${which}: every colour and intensity is the demo's`,
      bad.length === 0,
      bad.length ? bad.map(([k, v]) => `${k} demo=${demo[k]} ours=${v}`).join(' | ') : `${pairs.length} fields match`,
    );
  }
}

/**
 * Sun/moon discs: the demo's painter, EXECUTED, versus the port's.
 *
 * Not compared against copied constants (§0.0 第 5 點) — the demo's own painter
 * (`paperDisc` / `plasticDisc` / `skyDisc`, function plus its two call sites,
 * sliced straight out of the demo HTML) is run here against a recording canvas,
 * the strategy's `buildCelestialDisc` runs against the same recorder, and the
 * two command streams are diffed op by op. So the day a demo repaints its sun,
 * this fails — which is the whole point: 「demo 會改,而移植不會自己跟上」.
 *
 * ⚠ 2026-07-29:這一段曾經是一張**帳**(`PORT_DEBT`,指紋 + 「兩邊確實不同」),
 *   因為 demo 重畫了日月而移植還沒跟上。移植補上了,帳也就刪掉了 —— 註銷一筆
 *   PORT_DEBT 的正確方式就是刪掉它,不是把它的數字更新成新的現況。
 *
 * 三個世界的**張角刻意不一樣**:paper / plastic 的 demo 都是 `(42, 34)`,
 * circuit 的是 `(44, 30)`。所以角度是逐個世界從它自己的 demo 讀出來的,不是
 * 一組共用常數 —— 共用常數正是把 circuit 的月亮畫大 16.5% 的那條路。
 */
// A canvas whose 2D context records every call and property write — shared by
// the celestial-disc and cloud checks, which both diff a port's paint stream
// against the demo's own executed source.
type RecCanvas = { width: number; height: number; getContext: () => unknown; steps: unknown[][] };
const recCanvas = (): RecCanvas => {
  const steps: unknown[][] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) =>
      typeof prop === 'string'
        ? (...args: unknown[]) => { steps.push([prop, ...args]); }
        : undefined,
    set: (_t, prop, v) => { steps.push([`set:${String(prop)}`, v]); return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx, steps };
};

/** First index where two recorded command streams disagree, described. */
const diffAt = (a: unknown[][], b: unknown[][]): string => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const sa = JSON.stringify(a[i]) ?? 'END';
    const sb = JSON.stringify(b[i]) ?? 'END';
    if (sa !== sb) return `step ${i}: demo ${sa} vs ours ${sb}`;
  }
  return '';
};

/** Slice `function name(…) {…}` (2-space indent) out of a demo's source. */
function sliceDemoFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  const end = src.indexOf('\n  }', at);
  if (at < 0 || end < 0) throw new Error(`cannot slice ${name} out of the demo`);
  return src.slice(at, end + 4);
}

function checkCelestialDiscs(
  name: string,
  strategy: TerrainStyleStrategy,
  demoFile: string,
  fnName: string,
): void {
  console.log(`\n[celestial discs vs demo — ${name}]`);

  check('strategy declares buildCelestialDisc', !!strategy.buildCelestialDisc);
  if (!strategy.buildCelestialDisc) return;

  // ── Demo side: slice the painter + its call sites out of the demo, run them ──
  const src = readFileSync(demoFile, 'utf8');
  const fnAt = src.indexOf(`function ${fnName}(`);
  const fnEnd = src.indexOf('\n  }', fnAt);
  const callAt = src.indexOf(`const sunDisc = ${fnName}(`);
  const callEnd = src.indexOf('skyAnchor.add(moonDisc);', callAt);
  check(`${demoFile.split('/').pop()} declares ${fnName} + sun/moon call sites`,
    fnAt >= 0 && fnEnd > fnAt && callAt > fnAt && callEnd > callAt);
  if (fnAt < 0 || fnEnd < 0 || callAt < 0 || callEnd < 0) return;
  const demoSrc = `${src.slice(fnAt, fnEnd + 4)}\n${src.slice(callAt, callEnd + 'skyAnchor.add(moonDisc);'.length)}`;

  const demoCanvases: RecCanvas[] = [];
  const demoDoc = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`demo created <${tag}>`);
      const c = recCanvas();
      demoCanvases.push(c);
      return c;
    },
  };
  // circuit's painter reaches for the demo's own `cv()` and palette `E` instead
  // of `document` directly. Both are handed in rather than stubbed out: `cv`
  // still lands on the same recorder, and `E` is read out of the demo's own
  // `const E = {…}` block so the colours under test are the demo's, not ours.
  const demoE = Object.fromEntries(
    [...(/const E = \{([\s\S]*?)\n  \};/.exec(demoScript(demoFile))?.[1] ?? '')
      .matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/g)].map((m) => [m[1], m[2]]),
  );
  const demoCv = (w: number, h?: number): unknown => {
    const c = demoDoc.createElement('canvas') as { width: number; height: number };
    c.width = w; c.height = h ?? w;
    return c;
  };
  const demo = new Function(
    'THREE', 'document', 'skyAnchor', 'cv', 'E',
    `${demoSrc}\nreturn { sunDisc, moonDisc };`,
  )(THREE, demoDoc, new THREE.Group(), demoCv, demoE) as
    { sunDisc: THREE.Mesh; moonDisc: THREE.Mesh };

  // ── Strategy side: same recorder, via the global document stub ──
  const doc = (globalThis as { document: { createElement: (tag: string) => unknown } }).document;
  const ourCanvases: RecCanvas[] = [];
  const prevCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    if (tag !== 'canvas') throw new Error(`strategy created <${tag}>`);
    const c = recCanvas();
    ourCanvases.push(c);
    return c;
  };
  let ours: { sun: THREE.Object3D | null; moon: THREE.Object3D | null };
  try {
    // The port is handed the SHELL, not a radius — it works its own disc size
    // out of its own demo call site. That is the thing under test below.
    ours = {
      sun: strategy.buildCelestialDisc('sun', MOON_DISTANCE),
      moon: strategy.buildCelestialDisc('moon', MOON_DISTANCE),
    };
  } finally {
    doc.createElement = prevCreate;
  }

  const firstMesh = (o: THREE.Object3D): THREE.Mesh | null => {
    let found: THREE.Mesh | null = null;
    o.traverse((c) => { if (!found && (c as THREE.Mesh).isMesh) found = c as THREE.Mesh; });
    return found;
  };

  const bodies = [
    ['sun', demo.sunDisc, ours.sun, demoCanvases, ourCanvases, 0],
    ['moon', demo.moonDisc, ours.moon, demoCanvases, ourCanvases, 1],
  ] as const;
  for (const [body, dMesh, oObj, dCanvases, oCanvases, i] of bodies) {
    check(`${body}: built`, !!oObj);
    if (!oObj) continue;
    // One painter may make more than one canvas per body (circuit paints the
    // screen and the waveform), so pair them by stride instead of by index —
    // an off-by-one here would silently diff the sun against the moon.
    const per = dCanvases.length / 2;
    check(`${body}: 移植端畫了跟 demo 一樣多張 canvas`,
      oCanvases.length === dCanvases.length,
      `demo ${dCanvases.length} 張 / 移植 ${oCanvases.length} 張`);
    if (oCanvases.length !== dCanvases.length) continue;

    for (let k = 0; k < per; k++) {
      const dCanvas = dCanvases[i * per + k], oCanvas = oCanvases[i * per + k];
      const tag = per > 1 ? `${body}#${k}` : body;
      // ── 逐筆:demo 的筆觸串流 vs 移植的,一步一步比 ──
      const mismatch = diffAt(dCanvas.steps, oCanvas.steps);
      check(`${tag}: 每一筆都跟 demo 一樣(${dCanvas.steps.length} ops)`,
        mismatch === '', mismatch || `${oCanvas.steps.length} ops 全同`);
      check(`${tag}: canvas is the demo's ${dCanvas.width}×${dCanvas.height}`,
        oCanvas.width === dCanvas.width && oCanvas.height === dCanvas.height,
        `${oCanvas.width}×${oCanvas.height}`);
    }

    const oMesh = firstMesh(oObj);
    check(`${body}: is a mesh`, !!oMesh);
    if (!oMesh) continue;
    const dMat = dMesh.material as THREE.MeshBasicMaterial;
    const oMat = oMesh.material as THREE.MeshBasicMaterial;
    check(`${body}: material contract matches the demo (transparent, fog, depthWrite, textured)`,
      oMat.transparent === dMat.transparent && oMat.fog === dMat.fog
      && oMat.depthWrite === dMat.depthWrite && !!oMat.map === !!dMat.map,
      `transparent ${oMat.transparent}/${dMat.transparent}, fog ${oMat.fog}/${dMat.fog},`
      + ` depthWrite ${oMat.depthWrite}/${dMat.depthWrite}`);
    // 而 demo 那一邊真的是 false —— 不然上面那條在兩邊都 true 時也會通過。
    check(`${body}: demo 的圓盤本來就 depthWrite:false(它是天,不是場景裡的東西)`,
      dMat.depthWrite === false && dMat.fog === false);

    const dGeo = (dMesh.geometry as THREE.CircleGeometry).parameters;
    const oGeo = (oMesh.geometry as THREE.CircleGeometry).parameters;
    check(`${body}: circle with the demo's segment count`,
      oGeo.segments === dGeo.segments, `${oGeo.segments} segments`);

    // ── 張角 ──
    //
    // 參考距離是掛點的**長度**,不是到 `lookAt(0, 40, 0)` 的距離:lookAt 只是把
    // 圓盤轉過來面對騎士,而 demo 自己印在畫面上的讀數走的是
    // `skyAngleDeg(geoR, sunDisc.position.length())`。舊的移植用了 look target 的
    // 613 m,所以太陽一直大了 3.2%。
    const demoTan = dGeo.radius / dMesh.position.length();
    const ourTan = oGeo.radius / MOON_DISTANCE;
    const deg = (t: number): number => (2 * Math.atan(t) * 180) / Math.PI;
    check(`${body}: 張角就是 demo 的 ${deg(demoTan).toFixed(4)}°(不是「差不多」)`,
      Math.abs(ourTan - demoTan) / demoTan < 1e-9,
      `demo ${deg(demoTan).toFixed(6)}° vs 移植 ${deg(ourTan).toFixed(6)}°`
      + `(掛點 ${dMesh.position.length().toFixed(2)} m,r ${dGeo.radius} → ${oGeo.radius.toFixed(3)} m）`);

    // ── 子網格(電子的掃描線)── demo 掛幾片,移植就要掛幾片,名字也一樣。
    const kids = (o: THREE.Object3D): string[] => o.children.map((c) => c.name || '(anon)');
    check(`${body}: 掛在圓盤下面的東西跟 demo 一樣(${kids(dMesh).join(', ') || '沒有'})`,
      oObj.children.length === dMesh.children.length
      && kids(oObj).join() === kids(dMesh).join(),
      `demo [${kids(dMesh).join(', ')}] / 移植 [${kids(oObj).join(', ')}]`);
    for (let k = 0; k < Math.min(oObj.children.length, dMesh.children.length); k++) {
      const dk = dMesh.children[k] as THREE.Mesh, ok = oObj.children[k] as THREE.Mesh;
      const dkGeo = (dk.geometry as THREE.CircleGeometry).parameters;
      const okGeo = (ok.geometry as THREE.CircleGeometry).parameters;
      check(`${body}/${dk.name}: 半徑比例跟 demo 一樣`,
        Math.abs(okGeo.radius / oGeo.radius - dkGeo.radius / dGeo.radius) < 1e-9,
        `demo ${(dkGeo.radius / dGeo.radius).toFixed(4)} / 移植 ${(okGeo.radius / oGeo.radius).toFixed(4)}`);
      // 前後距離要跟著圓盤一起放大,不然在 3000 m 的天球上那 0.4 m 會被深度誤差
      // 吃掉,兩片變成同一個平面而 z-fighting。
      check(`${body}/${dk.name}: 離屏面的距離也跟著圓盤等比放大`,
        Math.abs(ok.position.z / oGeo.radius - dk.position.z / dGeo.radius) < 1e-9,
        `demo z ${dk.position.z} @ r ${dGeo.radius} / 移植 z ${ok.position.z.toFixed(3)} @ r ${oGeo.radius.toFixed(3)}`);
      const dkMat = dk.material as THREE.MeshBasicMaterial;
      const okMat = ok.material as THREE.MeshBasicMaterial;
      check(`${body}/${dk.name}: 貼圖的 wrap 跟 demo 一樣(靠滑 offset 掃,不是靠重畫)`,
        !!okMat.map && !!dkMat.map
        && okMat.map.wrapS === dkMat.map.wrapS && okMat.map.wrapT === dkMat.map.wrapT,
        `demo ${dkMat.map?.wrapS}/${dkMat.map?.wrapT} vs 移植 ${okMat.map?.wrapS}/${okMat.map?.wrapT}`);
      check(`${body}/${dk.name}: demo 那一邊真的是橫向 repeat(不然上一條是恆真句)`,
        dkMat.map?.wrapS === THREE.RepeatWrapping
        && dkMat.map?.wrapT === THREE.ClampToEdgeWrapping);
      // 子網格的材質合約也要比 —— 上面只比了圓盤本體,而突變測出來:掃描線那一片
      // 的 depthWrite 拿掉了整套檢查一聲都不吭。它壓在屏面前方 1.9 m,寫深度就會
      // 把整個方形(含 alpha 0 的角落)從後面的東西身上挖掉。
      check(`${body}/${dk.name}: 材質合約跟 demo 一樣(transparent / fog / depthWrite)`,
        okMat.transparent === dkMat.transparent && okMat.fog === dkMat.fog
        && okMat.depthWrite === dkMat.depthWrite,
        `transparent ${okMat.transparent}/${dkMat.transparent}, fog ${okMat.fog}/${dkMat.fog},`
        + ` depthWrite ${okMat.depthWrite}/${dkMat.depthWrite}`);
      check(`${body}/${dk.name}: demo 那一邊真的是 depthWrite:false + fog:false`,
        dkMat.depthWrite === false && dkMat.fog === false);
      // 而移植端要把它交給 sky-and-fog 推 —— 沒有這兩個 userData,掃描線是死的。
      check(`${body}/${dk.name}: 移植端把那張貼圖登記給 sky-and-fog 推(userData.beam + beamSpeed)`,
        (oObj.userData.beam as THREE.Texture | undefined) === okMat.map
        && typeof oObj.userData.beamSpeed === 'number' && oObj.userData.beamSpeed > 0,
        `beamSpeed ${String(oObj.userData.beamSpeed)}`);
      // 速度也是 demo 的:`dt * 0.35` / `dt * 0.22`,從 demo 的每幀迴圈讀。
      const rate = new RegExp(`${body}Disc\\.userData\\.beam\\.offset\\.x\\s*=\\s*\\(${body}Disc\\.userData\\.beam\\.offset\\.x\\s*\\+\\s*dt \\* ([\\d.]+)\\) % 1`)
        .exec(src)?.[1];
      check(`${body}/${dk.name}: 掃描速度就是 demo 每幀迴圈裡那個數(${rate ?? '?'})`,
        !!rate && oObj.userData.beamSpeed === Number(rate),
        `demo ${rate} / 移植 ${String(oObj.userData.beamSpeed)}`);
    }
  }

  // ── 天球:那條**保證**移植過來了嗎 ──
  //
  // demo 的 950 m 是它自己尺度的數字(遠山 640 / 810)。gameview 的遠山在 2600 m、
  // circuit 的鰭片伸到 2700 m,照抄 950 會把太陽塞進山裡 —— 正好是 demo 立這顆天球
  // 要修的那個 bug。所以搬的是**次序**不是值。
  check(`天球:${MOON_DISTANCE} m 在遠山之外(遠山環 ${MOUNTAIN_FAR_RADIUS} m)`,
    MOON_DISTANCE > MOUNTAIN_FAR_RADIUS,
    `${MOON_DISTANCE} > ${MOUNTAIN_FAR_RADIUS}`);
  {
    const camFar = CHUNK_LENGTH * (CHUNKS_AHEAD + 1);
    check(`天球:也在相機遠裁面之內(${camFar} m)`, MOON_DISTANCE < camFar);
    // 鰭片(circuit)是唯一伸到環外面的東西 —— 深度**從這個世界自己的策略問出來**,
    // 不是抄 demo 的 620 + 190:那個數字在 gameview 是按比例放大再夾住的。
    const fins = strategy.mountainRingFins?.('far', MOUNTAIN_FAR_RADIUS, 1);
    const reach = MOUNTAIN_FAR_RADIUS + (fins?.depth ?? 0);
    check(`天球:連這個世界的遠山最外緣(${reach.toFixed(0)} m)都在天球裡面`,
      MOON_DISTANCE > reach, `${MOON_DISTANCE} > ${reach.toFixed(1)}`
      + (fins ? `(環 ${MOUNTAIN_FAR_RADIUS} + 鰭 ${fins.depth.toFixed(1)}）` : '(沒有鰭片)'));
    // 而 demo 的次序也是這樣 —— 兩邊都寫下來,才知道搬的是同一條規則。
    const dsrc = demoScript(demoFile);
    const shell = Number(/const SKY_SHELL_R = (\d+);/.exec(dsrc)![1]);
    const shellMin = Number(/const SKY_SHELL_MIN = (\d+);/.exec(dsrc)![1]);
    check(`天球:demo 自己也是「天球 > 遠山」(${shell} m,下界 ${shellMin} m)`,
      shell >= shellMin, `SKY_SHELL_R ${shell} ≥ SKY_SHELL_MIN ${shellMin}`);
  }

  strategy.dispose();
}

// ══════════════════════════════════════════════════════════════════════════
// [celestial design vs demos] —— 日月圓盤的**出處**
// ══════════════════════════════════════════════════════════════════════════
//
// 上面那一區問的是「移植端畫得跟 demo 一樣嗎」。這一區問的是**另一個問題**,
// 而且它只看 demo:
//
//   「這三顆日月的每一個顏色、每一個造型決定,是從哪裡來的?」
//
// 為什麼要有這一區:圓盤是**貼圖**畫出來的,而 demo-probe 把貼圖換成面積加權
// 主色、`fill()` 根本不計入(§10 第 6 條)—— 所以「看起來對不對」在 3D probe
// 上是問不出來的。而顏色抄錯的成本這個 session 已經付過一次:招牌三角形把 2D
// 的 `cross: 0xc4483a` 抄進 3D(§3.11),c9f81d5 才改回來。
//
// 所以這裡把每一個值**推導一次**,而不是把它抄一份:
//   瓦楞紙 —— 從遠山那組墨(INK_* / PLAIN_*)重跑推導,並且**反向**確認它不等於
//             2D 的 sun/moon;素紙板態則是執行 demo 自己的 swappable()。
//   積木  —— 每一個顏色都必須是這個世界色票 C 裡的成員(白高光是唯一例外,
//             而且它出現幾次也被數)。
//   電子  —— P3 / P11 是 EIA 的真實磷光型號,check 拿 demo 註解裡寫的 CIE 1931
//             色度座標**重算一次** sRGB,再跟色票比。
//
// 加上兩件跟造型無關但同樣是這一輪定案的事:**天球**(可調距離、張角,以及
// 「天體永遠在遠山後面」)與**示波器的掃描線**(只推 map.offset,不逐幀上傳)。

/** `#rrggbb` → `[r, g, b]`。 */
const celHex3 = (h: string): number[] =>
  [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const celToHex = (c: number[]): string =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** 2D 的 KRAFT_RAMP 用的同一式 luma。 */
const celLuma = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** 對自己的 luma 灰軸鏡射過去的那一端。 */
const celMirror = (c: number[]): number[] => {
  const g = Math.round(celLuma(c));
  return c.map((v) => 2 * g - v);
};
/** `const NAME = '#rrggbb'` / `name: '#rrggbb'` —— demo 裡宣告顏色的兩種寫法。 */
function celDemoHex(src: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*[:=]\\s*'(#[0-9a-f]{6})'`).exec(src);
  if (!m) throw new Error(`cannot read colour ${name} out of the demo`);
  return m[1];
}
/** `foo(a, 'x', 'y')` 的引數字串陣列(只取字串字面量)。 */
function celCallArgs(src: string, head: string): string[] {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot find call ${head}`);
  const end = src.indexOf(');', at);
  return [...src.slice(at, end).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}
/**
 * CIE 1931 xy → sRGB(D65),**保留色相**:負值截到 0 再正規化到最亮的通道。
 * 這是 demo 註解裡寫的那條規則,check 在這裡自己算一次 —— 兩邊都動才對得上。
 */
function celXyToSrgb(x: number, y: number): string {
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ].map((v) => Math.max(0, v));
  const mx = Math.max(...lin);
  const enc = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return celToHex(lin.map((v) => enc(v / mx) * 255));
}
/** 一個會錄下所有 2D 呼叫的假 document(只給 <canvas>)。 */
function celRecDoc(): { doc: { createElement: (t: string) => unknown }; canvases: RecCanvas[] } {
  const canvases: RecCanvas[] = [];
  return {
    canvases,
    doc: {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`demo created <${tag}>`);
        const c = recCanvas();
        canvases.push(c);
        return c;
      },
    },
  };
}
/** 圓盤那一整段(painter + 兩個呼叫點),從 demo 切出來。 */
function celDiscRegion(src: string, fnName: string): string {
  const a = src.indexOf(`function ${fnName}(`);
  const tail = 'skyAnchor.add(moonDisc);';
  const b = src.indexOf(tail, a);
  if (a < 0 || b < 0) throw new Error(`cannot slice the ${fnName} region`);
  return src.slice(a, b + tail.length);
}
/** 錄下來的命令串流裡所有設過的 fillStyle / strokeStyle。 */
const celColoursOf = (c: RecCanvas): string[] =>
  c.steps.filter((s) => s[0] === 'set:fillStyle' || s[0] === 'set:strokeStyle')
    .map((s) => String(s[1]));

function checkCelestialDesign(): void {
  console.log('\n[celestial design vs demos]');
  const SRC = {
    paper: demoScript(SHADOW_DEMOS.paper),
    plastic: demoScript(SHADOW_DEMOS.plastic),
    circuit: demoScript(SHADOW_DEMOS.circuit),
  };

  // ── 1. 瓦楞紙:顏色是從自己的墨色貨架推出來的,不是從 2D 抄的 ────────────
  {
    const shelf = Object.fromEntries((['INK_FAR_WASH', 'INK_NEAR_WASH', 'INK_FAR_LINE',
      'INK_NEAR_LINE'] as const).map((k) => [k, celHex3(celDemoHex(SRC.paper, k))]));
    // 同一把尺拉到最開:平塗比最淡的再淡一階、墨線比最濃的再濃一階。
    const wash = shelf.INK_FAR_WASH.map((v, i) => v + (v - shelf.INK_NEAR_WASH[i]));
    const line = shelf.INK_NEAR_LINE.map((v, i) => v - (shelf.INK_FAR_LINE[i] - v));
    const coolWash = celMirror(wash);
    const nightTop = /const NIGHT = \{\s*top: new THREE\.Color\('(#[0-9a-f]{6})'\)/
      .exec(SRC.paper)?.[1] ?? '';

    const sun = celCallArgs(SRC.paper, 'const sunDisc = paperDisc(');
    const moon = celCallArgs(SRC.paper, 'const moonDisc = paperDisc(');
    check('瓦楞紙/太陽:暖墨 = 貨架的兩端各再推一階(平塗 + 墨線)',
      sun[0] === celToHex(wash) && sun[1] === celToHex(line),
      `demo (${sun[0]}, ${sun[1]}) / 從貨架推出來 (${celToHex(wash)}, ${celToHex(line)})`);
    check('瓦楞紙/月亮:冷墨 = 同一個平塗對自己的 luma 灰軸鏡射,而短線用它自己',
      moon[0] === celToHex(coolWash) && moon[1] === celToHex(coolWash),
      `demo (${moon[0]}, ${moon[1]}) / 鏡射出來 ${celToHex(coolWash)}`);
    check('瓦楞紙/月相:咬痕吃的是這個世界自己的夜空色(NIGHT.top)',
      !!nightTop && moon[2] === nightTop, `demo ${moon[2]} / NIGHT.top ${nightTop}`);
    check('瓦楞紙/太陽沒有咬痕、月亮才有(月相是月亮獨有的)',
      sun[2] === '' && moon[2] !== '', `sun '${sun[2]}' / moon '${moon[2]}'`);

    // 反向:四個值一個都不可以等於 2D 的 sun / moon(§3.11 那條踩過的坑)。
    const flat = readFileSync('plan/phaser-handdrawn-demo.html', 'utf8');
    const twoD = (['sun', 'moon'] as const).map((k) => {
      const m = new RegExp(`\\b${k}:\\s*0x([0-9a-f]{6})`).exec(flat);
      if (!m) throw new Error(`cannot read 2D ${k}`);
      return `#${m[1]}`;
    });
    const stolen = [...sun, ...moon].filter((c) => twoD.includes(c));
    check('瓦楞紙:一個顏色都沒有從 2D 抄過來(2D 是造型的規格,不是顏色的)',
      twoD.length === 2 && stolen.length === 0,
      `2D 是 ${twoD.join(' / ')};3D 用的是 ${[...new Set([...sun, ...moon])].filter(Boolean).join(' / ')}`);

    // ── 素紙板態:日月**不變**,所以圓盤的材質不可以登記進 swappable() ──
    // 執行 demo 自己的 swappable() 與整段圓盤程式碼,數登記了幾個。
    const rec = celRecDoc();
    const swaps = new Function('THREE', 'document', 'skyAnchor', [
      'const paintSwaps = [];',
      sliceDemoFn(SRC.paper, 'swappable'),
      celDiscRegion(SRC.paper, 'paperDisc'),
      'return paintSwaps.length;',
    ].join('\n'))(THREE, rec.doc, new THREE.Group()) as number;
    check('瓦楞紙/素紙板態:日月一個雙態材質都沒有(它們在紙的背後)',
      swaps === 0, `paintSwaps 登記了 ${swaps} 個`);
    // 而那條規矩是 2D 先寫下來的 —— KEEP_UNPAINTED 把 ink / sun / moon 一起留在外面。
    const keep = /const KEEP_UNPAINTED = new Set\(\[([\s\S]*?)\]\)/.exec(flat)?.[1] ?? '';
    check('…而且 2D 的 KEEP_UNPAINTED 也把 ink / sun / moon 留在牛皮紙化之外',
      ['ink', 'sun', 'moon'].every((k) => keep.includes(`'${k}'`)),
      keep.replace(/\s+/g, ' ').trim());
  }

  // ── 2. 積木:光球 —— 顏色出自色票 C,而剪影必須跟泡泡燈路燈分得開 ────────
  //
  // 這一段有兩半,第二半才是重點。積木的路燈 bubbleLamp **也是一顆會亮的球**,
  // 所以「日月是一顆球」這個造型的全部風險都在 §3.2:兩個東西摸起來是不是同一種。
  // 分開它們的是**剪影**,而剪影在 demo-probe 上是看不到的 —— 凸粒住在**貼圖的
  // alpha** 裡,而 §10 第 7 條說得很清楚:probe 拿整片 material.opacity 當 alpha,
  // 讀不到 per-texel。所以這裡改成量**錄下來的那條路徑**本身。
  {
    const palette = new Map<string, string>();
    const block = /const C = \{([\s\S]*?)\n  \};/.exec(SRC.plastic)?.[1] ?? '';
    for (const m of block.matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/g)) palette.set(m[2], m[1]);
    check('積木:讀得到這個世界的色票 C', palette.size >= 8, `${palette.size} 個色`);

    const rec = celRecDoc();
    new Function('THREE', 'document', 'skyAnchor',
      celDiscRegion(SRC.plastic, 'plasticDisc'))(THREE, rec.doc, new THREE.Group());
    check('積木:日月各畫在一張 canvas 上', rec.canvases.length === 2,
      `${rec.canvases.length} 張`);
    const GLOSS = '#ffffff';
    /** 第一條路徑(球身輪廓)的點。closePath 之前的 moveTo / lineTo。 */
    const rimOf = (c: RecCanvas): number[][] => {
      const out: number[][] = [];
      for (const s of c.steps) {
        if (s[0] === 'closePath') break;
        if (s[0] === 'moveTo' || s[0] === 'lineTo') out.push([Number(s[1]), Number(s[2])]);
      }
      return out;
    };
    for (const [i, body] of (['太陽', '月亮'] as const).entries()) {
      const used = celColoursOf(rec.canvases[i]);
      const alien = used.filter((c) => c !== GLOSS && !palette.has(c));
      check(`積木/${body}:每一個顏色都在色票 C 裡`, alien.length === 0,
        alien.length ? `色票外的: ${[...new Set(alien)].join(', ')}`
          : [...new Set(used)].map((c) => `${palette.get(c) ?? '白高光'}`).join(' + '));
      // 白只有一次,而且那是軟膠的鏡面高光 —— 白色是很好用的作弊,所以數它。
      check(`積木/${body}:純白只出現一次(軟膠的鏡面高光)`,
        used.filter((c) => c === GLOSS).length === 1,
        `${used.filter((c) => c === GLOSS).length} 次`);

      // ── 剪影:它必須**不是**一顆正圓的球 ──
      const rim = rimOf(rec.canvases[i]);
      const rad = rim.slice(0, -1).map(([x, y]) => Math.hypot(x - 64, y - 64));
      const n = rad.length;
      let peaks = 0;
      for (let k = 0; k < n; k++) {
        if (rad[k] > rad[(k + n - 1) % n] && rad[k] >= rad[(k + 1) % n]) peaks++;
      }
      const lo = Math.min(...rad), hi = Math.max(...rad);
      const xs = rim.map((p) => p[0]), ys = rim.map((p) => p[1]);
      const wide = Math.max(...xs) - Math.min(...xs), tall = Math.max(...ys) - Math.min(...ys);
      check(`積木/${body}:球身是一條折線,不是 arc —— 用 arc/ellipse 的話壓扁會被 probe 吃掉`,
        rim.length > 100, `${rim.length} 個點`);
      check(`積木/${body}:輪廓有 12 顆凸粒(邊緣語彙),而且凸得夠深看得出來`,
        peaks === 12 && (hi - lo) / hi > 0.08,
        `${peaks} 顆,起伏 ${(((hi - lo) / hi) * 100).toFixed(1)}%`);
      check(`積木/${body}:是**軟**的 —— 橫寬縱扁,不是正圓`,
        wide / tall > 1.05, `${wide.toFixed(1)} × ${tall.toFixed(1)} = ${(wide / tall).toFixed(3)}`);
    }
    // §3.3 的正面陳述:路燈的泡泡是正圓的 SphereGeometry、架在桿子上,日月是
    // 一條有凸粒的折線、掛在天上。**兩個都寫下來**,下一個人才不會把其中一個
    // 「修」成另一個。
    check('積木:路燈的泡泡仍然是正圓的 SphereGeometry(而日月不是)——兩個剪影分得開',
      /const bubbleGeo = \(\(\) => \{\s*\n\s*const s = new THREE\.SphereGeometry\(/.test(SRC.plastic)
      && /const neck = new THREE\.CylinderGeometry\(/.test(SRC.plastic));
    // 兩態是同一顆球:命令串流長度一樣,只有球身與內光那兩個顏色不同。
    const [sun, moon] = rec.canvases.map((c) => c.steps.map((s) => JSON.stringify(s)));
    const diffs = sun.filter((s, i) => s !== moon[i]);
    check('積木:太陽與月亮是同一顆光球 —— 兩條命令串流只差在球身與內光的顏色',
      sun.length === moon.length && diffs.length > 0
      && diffs.every((s) => /set:fillStyle/.test(s)),
      `${sun.length} ops,差 ${diffs.length} 步`);
  }

  // ── 3. 電子:P3 / P11 是真的磷光型號,不是調出來的兩個顏色 ───────────────
  {
    const coord = (name: string): [number, number] => {
      const m = new RegExp(`${name}\\b[^\\n]*CIE 1931 x ([\\d.]+), y ([\\d.]+)`).exec(SRC.circuit);
      if (!m) throw new Error(`cannot read the ${name} chromaticity out of the demo`);
      return [Number(m[1]), Number(m[2])];
    };
    const want = { p3: celXyToSrgb(...coord('P3')), p11: celXyToSrgb(...coord('P11')) };
    for (const k of ['p3', 'p11'] as const) {
      check(`電子/${k.toUpperCase()}:色票的值 = 註解裡那組 CIE 座標換算出來的 sRGB`,
        celDemoHex(SRC.circuit, k) === want[k],
        `色票 ${celDemoHex(SRC.circuit, k)} / 換算 ${want[k]}`);
    }
    // §3.3:不可以跟這個世界既有的輝光撞號。走線是 #23f0ff,往白稀釋的 P11 會撞上去。
    const trace = celHex3(celDemoHex(SRC.circuit, 'trace'));
    const p11 = celHex3(want.p11);
    const dist = Math.hypot(...trace.map((v, i) => v - p11[i]));
    check('電子/P11 跟走線輝光 E.trace 分得開(所以磷光走保色相、不往白稀釋)',
      dist > 100, `RGB 距離 ${dist.toFixed(0)}(#${trace.map((v) => v.toString(16).padStart(2, '0')).join('')} vs ${want.p11}）`);
  }

  // ── 4. 電子:掃描線只推 map.offset,而且沒有第二個寫入者 ────────────────
  {
    const rec = celRecDoc();
    const cv = (w: number, h?: number): unknown => {
      const c = rec.doc.createElement('canvas') as { width: number; height: number };
      c.width = w; c.height = h ?? w;
      return c;
    };
    const E = Object.fromEntries([...SRC.circuit.matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/g)]
      .map((m) => [m[1], m[2]]));
    const out = new Function('THREE', 'document', 'skyAnchor', 'cv', 'E',
      `${celDiscRegion(SRC.circuit, 'skyDisc')}\nreturn { sunDisc, moonDisc };`)(
      THREE, rec.doc, new THREE.Group(), cv, E) as { sunDisc: THREE.Mesh; moonDisc: THREE.Mesh };
    const beams = [out.sunDisc, out.moonDisc].map((d) => d.userData.beam as THREE.Texture);
    check('電子:兩顆各自帶一張波形貼圖,而且**不是同一張**',
      !!beams[0] && !!beams[1] && beams[0] !== beams[1]);
    check('電子:波形貼圖橫向 repeat(靠滑 offset 掃,不是靠重畫)',
      beams.every((t) => t.wrapS === THREE.RepeatWrapping
        && t.wrapT === THREE.ClampToEdgeWrapping));
    check('電子:屏面底下掛的是那片會滑的波形(crtBeam)',
      [out.sunDisc, out.moonDisc].every((d) => d.children.length === 1
        && d.children[0].name === 'crtBeam'));
    // 每幀動的只有 offset。整份 demo 裡對這兩張貼圖的寫入點只有那兩行 ——
    // 遠山那次(27b34aa)就是共用 singleton 被兩邊搶著寫。
    const writes = [...SRC.circuit.matchAll(/userData\.beam\.offset\.x\s*=/g)].length;
    const uploads = [...SRC.circuit.matchAll(/userData\.beam\.needsUpdate/g)].length;
    check('電子:每幀只推 offset.x —— 兩顆各一行,而且沒有任何一次逐幀上傳',
      writes === 2 && uploads === 0, `offset 寫入 ${writes} 處 / needsUpdate ${uploads} 處`);
    // 「它會動」demo-probe 證明不了 —— 那是個靜態的 CPU 光柵器,而且它把貼圖整張
    // 換成面積加權主色(§10 第 6 條)。**能**證明的是那兩行真的推得動 offset,所以
    // 把它們從 demo 的每幀迴圈切出來跑 60 幀:值要一直變,而且永遠留在 [0, 1)
    // ——不取模的話 float 會一路長大,幾小時後精度就開始掉格。
    const stepSrc = SRC.circuit.slice(
      SRC.circuit.indexOf('    sunDisc.userData.beam.offset.x ='),
      SRC.circuit.indexOf('    rainAnchor.position.set('));
    const stepFn = new Function('sunDisc', 'moonDisc', 'dt', stepSrc) as
      (s: THREE.Mesh, m: THREE.Mesh, dt: number) => void;
    const seenOff: number[] = [];
    for (let i = 0; i < 60; i++) {
      stepFn(out.sunDisc, out.moonDisc, 1 / 60);
      seenOff.push(beams[0].offset.x);
    }
    check('電子:那兩行真的推得動 offset —— 60 幀全部不重複,而且一直留在 [0, 1)',
      new Set(seenOff).size === 60 && seenOff.every((v) => v >= 0 && v < 1)
      && beams[1].offset.x !== beams[0].offset.x,
      `1 秒走了 ${seenOff[59].toFixed(3)} 圈(月亮 ${beams[1].offset.x.toFixed(3)}）`);
    // 接縫:整數波數 + 步進整除畫布寬(§7.1)。
    const m = /const W = (\d+), CYC = (\d+), SEG = (\d+);/.exec(SRC.circuit);
    check('電子:波形無縫 —— 整數波數,而且步進整除畫布寬',
      !!m && Number.isInteger(Number(m[2])) && Number(m[1]) % Number(m[3]) === 0,
      m ? `W ${m[1]} / 波數 ${m[2]} / 分 ${m[3]} 段` : '(讀不到)');
  }

  // ── 5. 天球:可調,而且**整個範圍**都在遠山後面 ─────────────────────────
  {
    /** gameview 的相機遠裁面 —— 真的 import 進來,不是在這裡重推一次式子。 */
    const GAME_CAM_FAR = CAMERA_FAR;
    check('gameview:相機遠裁面就是 chunk 走廊的長度',
      GAME_CAM_FAR === CHUNK_LENGTH * (CHUNKS_AHEAD + 1),
      `${GAME_CAM_FAR} m = ${CHUNK_LENGTH} × ${CHUNKS_AHEAD + 1}`);
    /**
     * demo 的相機:**把那一行執行起來**,不是解析它。
     *
     * `new THREE.PerspectiveCamera(55, 2, 2, 8000)` 是位置引數,第二個 2 是
     * aspect、第三個才是 near —— 用 regex 數逗號很容易數錯一格。而且那一行上面
     * 就有一段解釋「near 原本是 0.5」的註解,散文裡的 0.5 對 regex 來說跟程式碼
     * 長得一模一樣(上一輪的 `fog: false` 就是這樣變成恆真句的)。跑它、讀
     * `camera.fov / near / far`,兩種錯法一次都沒有。
     */
    const demoCamera = (s: string): THREE.PerspectiveCamera => {
      const line = /^\s*const camera = new THREE\.PerspectiveCamera\(.*\);$/m.exec(s)![0];
      return new Function('THREE', `${line}\nreturn camera;`)(THREE) as THREE.PerspectiveCamera;
    };
    const FAR_OUTER: Record<string, (s: string) => number> = {
      // 瓦楞紙:垂直簾幕,半徑就是它畫得到的最遠處。
      paper: (s) => Number(/const mountFar = inkRidge\(\{\s*\n\s*radius: (\d+)/.exec(s)![1]),
      // 積木:一樣是簾幕,半徑是第一個引數。
      plastic: (s) => Number(/const mountFar = blockMountainRing\((\d+)/.exec(s)![1]),
      // 電子:鰭片從 radius 往外長 depth,所以最遠處是兩個相加。
      circuit: (s) => {
        const m = /const mountFar = heatsinkRing\(\{\s*\n\s*radius: (\d+), depth: (\d+)/.exec(s)!;
        return Number(m[1]) + Number(m[2]);
      },
    };
    for (const world of ['paper', 'plastic', 'circuit'] as const) {
      const s = SRC[world];
      const num = (n: string): number => Number(new RegExp(`const ${n} = (\\d+);`).exec(s)![1]);
      const min = num('SKY_SHELL_MIN'), def = num('SKY_SHELL_R'), max = num('SKY_SHELL_MAX');
      const far = FAR_OUTER[world](s);
      const cam = demoCamera(s);
      const camFar = cam.far;
      check(`${world}:天球的**下界**在遠山之外 —— 所以整個滑桿範圍內天體都在山後面`,
        min > far, `下界 ${min} m > 遠山畫到 ${far} m`);
      check(`${world}:預設落在範圍內,上界在相機遠裁面之內`,
        min <= def && def <= max && max < camFar,
        `${min} ≤ ${def} ≤ ${max} < camera.far ${camFar}`);
      // 星星跟日月同一顆球 —— 那就是預設半徑的出處,不是挑的。所以星星那段必須
      // **讀** SKY_SHELL_R,而且不可以留著自己那份寫死的數字。
      const starsAt = s.indexOf('const stars = (() => {');
      const stars = s.slice(starsAt, s.indexOf('\n  })();', starsAt));
      check(`${world}:預設半徑就是星星那顆球(日月跟星星同一層天)`,
        starsAt > 0 && stars.includes('SKY_SHELL_R') && !new RegExp(`\\b${def}\\b`).test(stars),
        `星星讀 SKY_SHELL_R = ${def};段內寫死的 ${def}: ${new RegExp(`\\b${def}\\b`).test(stars) ? '還在' : '沒有'}`);

      // ── 環境一致:demo 的天球 === gameview 的天球 ────────────────────────
      //
      // 「環境」裡只有兩個量是以**絕對公尺**移植的:天球半徑與相機遠裁面。
      // 遠山環搬的是**張角**(`maxH / radius`,見 mountain-ring.ts 的
      // NEAR_/FAR_MAX_HEIGHT),霧是從遠山環推出來的(day-night-lighting 的
      // `MOUNTAIN_RING_FOG_DEPTH`)—— 那兩樣兩邊的公尺數本來就不同,而且是對的。
      // 剩下這兩個一旦不同,移植就得換算,而換算過的數字下一個人看不出它為什麼
      // 是那個數字(CUSTOM_WORLD_INSTRUCTIONS §0.0 第 1 條)。
      //
      // 兩邊都不是抄來的:demo 這一側是上面的 num() 從**原始碼解析**、相機是把
      // 那一行**執行**出來的,gameview 這一側是真的 import 進來的常數。改任何
      // 一邊都會紅。
      check(`${world}:天球預設半徑 === gameview 的 MOON_DISTANCE`,
        def === MOON_DISTANCE, `demo SKY_SHELL_R ${def} m vs gameview ${MOON_DISTANCE} m`);
      // 相機三個數字全部要一樣。fov 與 far 早就一致了,near 是最後一格:demo
      // 原本 0.5,而 24-bit 深度緩衝的解析度跟 near 成反比 —— 0.5 在 1 km 只分得
      // 出約 12 cm、2 km 約 48 cm,比地面貼片整疊(landuse 0.02–0.10 m、道路
      // 0.30 m、路線 0.45 m)還粗。這一格是 gameview 先發現的,demo 跟過來,
      // 所以這條斷言的方向跟 §0.0「照抄 demo」是反的,而它就該是反的。
      check(`${world}:demo 的相機 === gameview 的相機(fov / near / far)`,
        cam.fov === DEFAULT_FOV && cam.near === CAMERA_NEAR && cam.far === GAME_CAM_FAR,
        `demo ${cam.fov}° / ${cam.near} / ${cam.far} m`
        + ` vs gameview ${DEFAULT_FOV}° / ${CAMERA_NEAR} / ${GAME_CAM_FAR} m`);
    }

    // ── 星星那顆球:兩邊都**建出來量**,不是讀常數 ───────────────────────
    //
    // 上面那條「預設半徑就是星星那顆球」只證明 demo 的星星段**讀** SKY_SHELL_R;
    // 這一段把兩邊真的跑起來,量每一顆星的 |pos|:
    //   demo     —— 把 `const stars = (() => {…})();` 整段切出來執行。
    //   gameview —— 真的 new 一個 SkyAndFog、init(),量 starGeometry。
    // gameview 的 STAR_RADIUS 沒有 export,而且**不該**為了檢查而 export:量建
    // 出來的幾何,連「常數對了但 createStars 用了別的數」都涵蓋得到。
    //
    // 這條抓過的東西:STAR_RADIUS 曾經是 2500,在遠山環(2600)與電子鰭片
    // (2700)**裡面** —— 低仰角的星星會畫在山前面。
    {
      const sky = new SkyAndFog(fakeGameRenderer() as never) as unknown as {
        init: () => void;
        starGeometry: THREE.BufferGeometry | null;
        starParticles: THREE.Points | null;
        spawnMeteor: (cameraPosition: THREE.Vector3) => void;
        updateMeteor: (dt: number, cameraPosition: THREE.Vector3) => void;
        meteorMesh: THREE.Mesh | null;
        meteorActive: boolean;
        currentStarAlpha: number;
        dispose: () => void;
      };
      sky.init();
      const gameStarFog = (sky.starParticles?.material as THREE.PointsMaterial | undefined)?.fog;
      const radiiOf = (geo: THREE.BufferGeometry | null | undefined): number[] => {
        const a = geo?.getAttribute('position');
        const out: number[] = [];
        for (let i = 0; a && i < a.count; i++) out.push(Math.hypot(a.getX(i), a.getY(i), a.getZ(i)));
        return out;
      };
      const spread = (r: number[]): number => Math.max(...r) - Math.min(...r);
      const gameR = radiiOf(sky.starGeometry);
      sky.dispose();
      // Float32 的量化,不是「差不多就好」—— 兩邊存的都是 Float32Array,3000 m
      // 上一個 ulp 約 2.4e-4 m,所以 0.01 m 已經是「同一個數字」的最寬解釋。
      const EPS = 0.01;
      check(`gameview:星星真的全在一顆球上(${gameR.length} 顆)`,
        gameR.length > 0 && spread(gameR) < EPS,
        `半徑落差 ${spread(gameR).toExponential(2)} m`);
      check(`gameview:那顆球就是天球 ${MOON_DISTANCE} m`
        + `(遠山環 ${MOUNTAIN_FAR_RADIUS} m 之外)`,
        gameR.length > 0 && Math.abs(gameR[0] - MOON_DISTANCE) < EPS,
        `星星 ${gameR[0]?.toFixed(3)} m vs 天球 ${MOON_DISTANCE} m`);
      check('gameview:星星材質 fog: false —— 星星是天,不是世界裡的空氣',
        gameStarFog === false, `fog = ${String(gameStarFog)}`);
      // 流星是**畫在星空上的一道**,所以它從同一顆球出發。相機放在原點,所以
      // 生成出來的 |pos| 就是它的球半徑。舊值是 2200 m —— 在遠山環(2600)與
      // 電子鰭片(2700)裡面,低空的那一段會畫在山前面。
      sky.spawnMeteor(new THREE.Vector3());
      const meteorR = sky.meteorMesh ? sky.meteorMesh.position.length() : NaN;
      check(`gameview:流星也從天球上出發(${MOON_DISTANCE} m)`,
        Math.abs(meteorR - MOON_DISTANCE) < EPS, `${meteorR.toFixed(3)} m`);

      // ── 流星:**整段飛行**都在天球上,不只是生成的那一幀 ─────────────────
      //
      // 三個 demo 都沒有流星(`grep -i meteor plan/*-demo.html` 一條都沒有),
      // 所以這一格 demo 仲裁不了 —— 它是 gameview 自己的天氣特效 F5。能照抄的
      // 只有 demo 立下的**規矩**:天上的東西住在天球上(demo 的星星讀
      // `SKY_SHELL_R`、日月掛在同一顆球)。上一輪把 METEOR_RADIUS 拉到天球,
      // 只修到第 0 幀:流星在生命週期內直線走 0.5 R,而舊的方向是隨機的「大致
      // 向下」—— 其中**指向騎士的那個分量在畫面上是零位移**(它就是視線方向),
      // 唯一的作用是把流星帶回遠山環裡面。20 萬次抽樣實測:最近會到離相機
      // 1500 m、水平 1 m(正好從騎士頭頂上過去),9.81% 的流星會在遠山
      // (2600 m、山脊張角 14.9°)**前面**畫過去。
      //
      // 修法是把那個分量投影掉,所以速度變成跟球面相切 —— 畫面上一模一樣,深度
      // 上再也進不了山裡。下面跑的是**真的 updateMeteor**,不是在這裡重算一次
      // 軌跡,所以改了 updateMeteor 的推進方式一樣會紅。
      {
        const camAt = new THREE.Vector3();
        let closest = Infinity;
        let lowestElevDeg = Infinity;
        let minTravel = Infinity;
        let maxTravel = -Infinity;
        // 深夜,否則 updateMeteor 第一幀就把流星收掉(它讀 currentStarAlpha)。
        sky.currentStarAlpha = 1;
        const spawnAt = new THREE.Vector3();
        for (let trial = 0; trial < 3000; trial++) {
          sky.spawnMeteor(camAt);
          const mesh = sky.meteorMesh!;
          spawnAt.copy(mesh.position);
          closest = Math.min(closest, spawnAt.length());
          for (let f = 0; f < 400 && sky.meteorActive; f++) {
            sky.updateMeteor(1 / 120, camAt);
            const p = mesh.position;
            closest = Math.min(closest, p.length());
            lowestElevDeg = Math.min(
              lowestElevDeg,
              (Math.atan2(p.y, Math.hypot(p.x, p.z)) * 180) / Math.PI,
            );
          }
          const travel = mesh.position.distanceTo(spawnAt);
          minTravel = Math.min(minTravel, travel);
          maxTravel = Math.max(maxTravel, travel);
        }
        check(`gameview:流星**整段**都在天球外(遠山環 ${MOUNTAIN_FAR_RADIUS} m)`,
          closest >= MOON_DISTANCE - EPS,
          `3000 次飛行最近 ${closest.toFixed(1)} m(天球 ${MOON_DISTANCE} m）`);
        // 把速度歸零也能讓上面那條過 —— 所以順便釘住「它真的有飛」:一條命走
        // 0.5 R 的弧,那是 `meteorVel` 那行寫的。
        const want = MOON_DISTANCE * 0.5;
        check('gameview:而且它真的有飛過去 —— 一條命剛好走 0.5 R',
          Math.abs(minTravel - want) < 30 && Math.abs(maxTravel - want) < 30,
          `位移 ${minTravel.toFixed(1)}–${maxTravel.toFixed(1)} m vs 0.5 R = ${want} m`);
        check('gameview:流星不會掉到地平線以下(仰角始終為正)',
          lowestElevDeg > 0, `最低仰角 ${lowestElevDeg.toFixed(2)}°`);
      }

      for (const world of ['paper', 'plastic', 'circuit'] as const) {
        const s = SRC[world];
        const a = s.indexOf('  const stars = (() => {');
        const tail = '\n  })();';
        const b = s.indexOf(tail, a);
        check(`${world}:切得出星星那一段`, a >= 0 && b > a);
        if (a < 0 || b < 0) continue;
        // 電子的星星走 demo 自己的 `cv()`,另外兩個走 document.createElement ——
        // 兩個都餵進去,落在同一個錄影 canvas 上(§6.2:不要自己裝 document)。
        const cv = (w: number, h?: number): RecCanvas => {
          const c = recCanvas();
          c.width = w;
          c.height = h ?? w;
          return c;
        };
        const doc = {
          createElement: (tag: string) => {
            if (tag !== 'canvas') throw new Error(`${world} stars created <${tag}>`);
            return recCanvas();
          },
        };
        const shell = Number(/const SKY_SHELL_R = (\d+);/.exec(s)![1]);
        const pts = new Function(
          'THREE', 'document', 'cv', 'skyAnchor', 'SKY_SHELL_R',
          `${s.slice(a, b + tail.length)}\nreturn stars;`,
        )(THREE, doc, cv, new THREE.Group(), shell) as THREE.Points;
        const demoR = radiiOf(pts.geometry);
        check(`${world}:demo 的星星全在一顆球上(${demoR.length} 顆)`,
          demoR.length > 0 && spread(demoR) < EPS,
          `半徑落差 ${spread(demoR).toExponential(2)} m`);
        check(`${world}:demo 執行出來的星星半徑 === 它自己宣告的 SKY_SHELL_R`,
          demoR.length > 0 && Math.abs(demoR[0] - shell) < EPS,
          `星星 ${demoR[0]?.toFixed(3)} m vs SKY_SHELL_R ${shell} m`);
        check(`${world}:demo 的星星球 === gameview 的星星球(同一顆天球)`,
          demoR.length > 0 && gameR.length > 0 && Math.abs(demoR[0] - gameR[0]) < EPS,
          `demo ${demoR[0]?.toFixed(3)} m vs gameview ${gameR[0]?.toFixed(3)} m`);
        // 而 demo 的星星材質也不能吃霧 —— 天球搬到 gameview 的尺度之後,demo 的
        // 霧遠端(780–1060 m)會把整片星空塗成霧色。
        //
        // ⚠ 這條問的是**跑出來的材質**,不是在原始碼裡搜 `fog: false`。第一版是
        // 搜字串的,而星星那段的**註解裡**就寫著 `fog: false` —— 突變測試把材質
        // 上那一行拿掉,檢查照樣全過:註解自己讓斷言變成恆真句。
        const demoStarMat = pts.material as THREE.PointsMaterial;
        check(`${world}:demo 的星星材質 fog: false(星星是天,不是空氣)`,
          demoStarMat.fog === false, `fog = ${String(demoStarMat.fog)}`);
      }
    }

    // 執行 SKY 區塊的擺位程式碼:距離與張角是**正交**的。
    const sec = (() => {
      const src = readFileSync(SHADOW_DEMOS.paper, 'utf8');
      const a = src.indexOf('  const SKY_SUN_R = sunDisc.position.length();');
      const tail = '    disc.lookAt(skyAnchor.position.x, skyAnchor.position.y + 40, skyAnchor.position.z);\n  }';
      const b = src.indexOf(tail, a);
      if (a < 0 || b < 0) throw new Error('cannot slice skyPlaceDisc');
      return src.slice(a, b + tail.length);
    })();
    const mkDisc = (r: number, p: [number, number, number]): THREE.Object3D => {
      const o = new THREE.Object3D();
      o.position.set(...p);
      (o as unknown as { geometry: unknown }).geometry = { parameters: { radius: r } };
      return o;
    };
    // 圓盤的替身,幾何半徑與掛點都從 demo 的呼叫點讀 —— 一個都不打進這個檔案。
    const discArgs = (id: string): { r: number; p: [number, number, number] } => {
      const m = new RegExp(`const ${id}Disc = \\w+\\((\\d+),[\\s\\S]*?${id}Disc\\.position\\.set\\((-?\\d+), (-?\\d+), (-?\\d+)\\)`)
        .exec(SRC.paper);
      if (!m) throw new Error(`cannot read the ${id} disc mount out of the demo`);
      return { r: Number(m[1]), p: [Number(m[2]), Number(m[3]), Number(m[4])] };
    };
    const sunArg = discArgs('sun'), moonArg = discArgs('moon');
    const shellOf = (n: string): number =>
      Number(new RegExp(`const ${n} = (\\d+);`).exec(SRC.paper)![1]);
    const SHELL_MIN = shellOf('SKY_SHELL_MIN'), SHELL_R = shellOf('SKY_SHELL_R');
    const SHELL_MAX = shellOf('SKY_SHELL_MAX');
    const sunDisc = mkDisc(sunArg.r, sunArg.p);
    const moonDisc = mkDisc(moonArg.r, moonArg.p);
    const place = new Function('sunDisc', 'moonDisc', 'skyQsGet', 'skyAnchor',
      'SKY_SHELL_MIN', 'SKY_SHELL_R', 'SKY_SHELL_MAX', 'SKY_D2R',
      `${sec}\nreturn { skyPlaceDisc, skyAngleDeg, SKY_SUN_R, SKY_MOON_R,`
      + ' setShell: (v) => { skyShell = skyClampDist(v); },'
      + ' setSize: (v) => { skySize = skyClampSize(v); },'
      + ' shell: () => skyShell, size: () => skySize };')(
      sunDisc, moonDisc, () => null, new THREE.Object3D(),
      SHELL_MIN, SHELL_R, SHELL_MAX, Math.PI / 180) as {
        skyPlaceDisc: (d: THREE.Object3D, v: { x: number; y: number; z: number }, r: number) => void;
        skyAngleDeg: (r: number, ref: number) => number;
        SKY_SUN_R: number; SKY_MOON_R: number;
        setShell: (v: number) => void; setSize: (v: number) => void;
        shell: () => number; size: () => number;
      };
    const noon = { x: 150, y: 190, z: 90 };
    const angleOf = (d: THREE.Object3D, r: number): number =>
      (2 * Math.atan((r * d.scale.x) / d.position.length()) * 180) / Math.PI;
    check(`天球:沒給 ?skydist / ?skysize 時就是預設(${SHELL_R} m、張角倍率 1)`,
      place.shell() === SHELL_R && place.size() === 1, `${place.shell()} m × ${place.size()}`);
    const seen: number[] = [];
    for (const dist of [SHELL_MIN, SHELL_R, (SHELL_R + SHELL_MAX) / 2, SHELL_MAX]) {
      place.setShell(dist);
      place.skyPlaceDisc(sunDisc, noon, place.SKY_SUN_R);
      seen.push(Number(angleOf(sunDisc, sunArg.r).toFixed(9)));
      check(`天球:半徑 ${dist} m 時圓盤真的掛在 ${dist} m`,
        Math.abs(sunDisc.position.length() - dist) < 1e-9,
        `|pos| = ${sunDisc.position.length().toFixed(3)}`);
    }
    check('天球:拉距離**不會**改變張角(兩個旋鈕正交 —— 這是滑桿好不好用的關鍵)',
      new Set(seen).size === 1, `四個距離量到 ${[...new Set(seen)].join(', ')}°`);
    // 而那個張角就是 demo 改版前的預設,一個位元組都沒動 —— 掛點與半徑都是從
    // demo 的呼叫點讀出來的,所以「有人偷偷把太陽變大」這裡就會失敗。
    const HIST_SUN = (2 * Math.atan(sunArg.r / Math.hypot(...sunArg.p)) * 180) / Math.PI;
    check('天球:預設張角就是 demo 原本那顆太陽的角度(改版沒有動到預設外觀)',
      Math.abs(seen[0] - HIST_SUN) < 1e-9, `${seen[0].toFixed(4)}° vs 原本 ${HIST_SUN.toFixed(4)}°`);
    place.setSize(2);
    place.skyPlaceDisc(sunDisc, noon, place.SKY_SUN_R);
    check('天球:張角倍率 2 就真的是兩倍大(半徑 ×2,而不是 atan 之後 ×2)',
      Math.abs(angleOf(sunDisc, sunArg.r)
        - (2 * Math.atan(2 * Math.tan(((HIST_SUN / 2) * Math.PI) / 180)) * 180) / Math.PI) < 1e-9,
      `${angleOf(sunDisc, sunArg.r).toFixed(4)}°`);
    place.setSize(1);
    // 夾:滑桿以外的值(網址可以亂打)照樣不准掉到遠山裡面去。
    const wild = [-1e9, 0, 300, SHELL_MIN - 1, SHELL_MAX * 3];
    const clamped = wild.map((v) => { place.setShell(v); return place.shell(); });
    check('天球:網址亂給也夾得住 —— 沒有任何一個值掉進遠山裡面',
      clamped.every((v) => v >= SHELL_MIN && v <= SHELL_MAX)
      && clamped[0] === SHELL_MIN && clamped[4] === SHELL_MAX,
      `${wild.join(', ')} → ${clamped.join(', ')}`);
    place.setShell(SHELL_R);
  }

  // ── 6. 圓盤不參與打光,也不寫深度 ───────────────────────────────────────
  {
    for (const [world, fn] of [['paper', 'paperDisc'], ['plastic', 'plasticDisc'],
      ['circuit', 'skyDisc']] as const) {
      const region = celDiscRegion(SRC[world], fn);
      const mats = [...region.matchAll(/new THREE\.(\w+)Material\(\{([^}]*)\}\)/g)];
      check(`${world}:圓盤只用 MeshBasicMaterial —— 造型歸造型,打光歸 skyPalette`,
        mats.length > 0 && mats.every((m) => m[1] === 'MeshBasic'),
        mats.map((m) => m[1]).join(', '));
      check(`${world}:圓盤 depthWrite:false 且 fog:false(它是天,不是場景裡的東西)`,
        mats.every((m) => /depthWrite:\s*false/.test(m[2]) && /fog:\s*false/.test(m[2])));
    }
  }
}

/**
 * The discs in the sky: SkyAndFog itself, on a stand-in renderer. The rules
 * under test are the SPRITE's rules, kept: the show/hide gate, the phase law,
 * and cloud immersion dimming from a stored base so it never compounds. Plus
 * the sun's, from the demo: opacity `1 − k` with k the palette's night blend.
 */
function checkCelestialSkyBehaviour(): void {
  console.log('\n[sun/moon in the sky — behaviour]');

  const strategy = createPaperTerrainStyle();
  const fake = fakeGameRenderer();
  // Private members are reached on purpose: the alternative is a public
  // test-only surface on SkyAndFog, which is worse than a cast in a script.
  const sky = new SkyAndFog(fake as never) as any;
  sky.init();
  sky.setCelestialDiscBuilder(strategy.buildCelestialDisc!.bind(strategy));

  const cam = new THREE.Vector3(12, 40, -7);
  const state = (over: Record<string, number | boolean>) => ({
    sunElevation: 45, sunAzimuth: 180, moonElevation: -30, moonAzimuth: 0,
    moonPhase: 0.5, isDaytime: true, dayFactor: 1, ...over,
  });
  const night = (over: Record<string, number | boolean> = {}) =>
    state({ sunElevation: -30, moonElevation: 40, isDaytime: false, dayFactor: 0, ...over });
  const moonOp = (): number => (sky.moonDiscMats[0] as THREE.Material).opacity;
  const sunOp = (): number => (sky.sunDiscMats[0] as THREE.Material).opacity;
  const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

  // Day.
  sky.applyLighting(state({}), cam);
  check('day: sun disc up at full opacity (demo: 1−k, k=0 by day)',
    sky.sunDisc.visible && near(sunOp(), 1));
  check('day: no moon — disc hidden, sprite stays retired',
    !sky.moonDisc.visible && !sky.moonSprite.visible);

  const expected = cam.clone().add(new THREE.Vector3().setFromSphericalCoords(
    MOON_DISTANCE, (Math.PI / 180) * (90 - 45), (Math.PI / 180) * 180));
  check('sun disc hangs at the sprite distance on the sun azimuth/elevation',
    sky.sunDisc.position.distanceTo(expected) < 1e-3);
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(sky.sunDisc.quaternion);
  const toCam = cam.clone().sub(sky.sunDisc.position).normalize();
  check('disc fronts the camera (CircleGeometry culls its back face)',
    facing.dot(toCam) > 0.999, facing.dot(toCam).toFixed(4));

  // Night, full moon (phase 0.5 = full ⇒ fullness 1).
  sky.applyLighting(night(), cam);
  check('night: moon disc visible, sun disc gone', sky.moonDisc.visible && !sky.sunDisc.visible);
  check('night: full-moon opacity keeps the sprite law (0.3 + 0.7·fullness)', near(moonOp(), 1));

  // Phase: half moon ⇒ fullness 0.5.
  sky.applyLighting(night({ moonPhase: 0.25 }), cam);
  check('half moon: opacity 0.65 and relative scale 0.9 (phase law kept)',
    near(moonOp(), 0.65) && near(sky.moonDisc.scale.x, 0.9));

  // The sprite's show/hide gate, verbatim.
  sky.applyLighting(state({ sunElevation: 6, moonElevation: 40 }), cam);
  check('moon defers to daylight (sun above 5° hides it)', !sky.moonDisc.visible);
  sky.applyLighting(night({ moonElevation: -6 }), cam);
  check('moon below −5° stays down', !sky.moonDisc.visible);

  // Dawn: both up, sun mid-crossfade at the palette's own blend.
  sky.applyLighting(state({ sunElevation: 2, moonElevation: 20, dayFactor: 0.4 }), cam);
  const kDawn = nightFactorFromElevation(2);
  check("dawn: both discs up, sun at the palette's own 1−k",
    sky.sunDisc.visible && sky.moonDisc.visible
      && near(sunOp(), 1 - kDawn) && sunOp() > 0.05 && sunOp() < 0.95,
    `sun opacity ${sunOp().toFixed(3)}`);

  // Cloud immersion: at the deck base k = 0.5 by contract, and re-applying
  // must not compound (opacity recomputed from the stored base each time).
  sky.cloudsEnabled = true;
  sky.cloudGroup = new THREE.Group();
  sky.lastCameraY = sky.cloudBaseSceneY();
  sky.applyLighting(night(), cam);
  check('camera at the deck base: immersion 0.5', near(sky.cloudImmersion, 0.5));
  check('immersion halves the moon disc from its base opacity', near(moonOp(), 0.5));
  sky.applyCloudImmersion();
  sky.applyCloudImmersion();
  check('re-applying immersion does not compound (moonBaseOpacity contract)', near(moonOp(), 0.5));
  sky.applyLighting(state({}), cam);
  check('the sun dims inside the deck too', near(sunOp(), 0.5));
  sky.cloudsEnabled = false;
  sky.cloudGroup = null;

  // Day/night off hides the discs, like it always hid the sprite.
  sky.applyLighting(state({}), cam);
  sky.setDayNightEnabled(false);
  check('day/night off hides the discs (like the sprite)',
    !sky.sunDisc.visible && !sky.moonDisc.visible);
  sky.setDayNightEnabled(true);

  // No builder ⇒ exactly the pre-style sky.
  sky.setCelestialDiscBuilder(null);
  check('no style: discs torn down', sky.sunDisc === null && sky.moonDisc === null);
  sky.applyLighting(night(), cam);
  check('no style: the additive sprite moon returns, phase law intact',
    sky.moonSprite.visible
      && near((sky.moonSprite.material as THREE.SpriteMaterial).opacity, 1));

  // Dispose sweeps the discs out of the scene.
  sky.setCelestialDiscBuilder(strategy.buildCelestialDisc!.bind(strategy));
  const scene = fake.scene;
  check('rebuild: discs live in the scene',
    scene.children.includes(sky.sunDisc) && scene.children.includes(sky.moonDisc));
  const sun = sky.sunDisc;
  sky.dispose();
  check('dispose sweeps the discs', sky.sunDisc === null && !scene.children.includes(sun));

  strategy.dispose();

  // ── 掃描線:在 gameview 這一側真的會動嗎 ────────────────────────────────
  //
  // `[celestial discs vs demo — circuit]` 證明的是「移植端登記了那張貼圖與速度」。
  // 這裡問的是**下一段線**:sky-and-fog 每幀有沒有真的去推它。兩件事分開,因為
  // 這條的失效模式是「策略宣告得好好的,而沒有人讀」—— gameview 的路燈變色
  // (2427d86)就是這一類。
  //
  // ⚠ 它證明不了的:掃描線在螢幕上「看起來在動」。靜態光柵器答不了(§10 第 8 條),
  //   能答的是 offset 這個數字每幀都不一樣、日月不同步、而且永遠留在 [0, 1)。
  {
    const cs = createCircuitTerrainStyle();
    const f2 = fakeGameRenderer();
    const s2 = new SkyAndFog(f2 as never) as any;
    s2.init();
    s2.setCelestialDiscBuilder(cs.buildCelestialDisc!.bind(cs));
    s2.applyLighting(state({}), cam);          // 正午:太陽在天上
    // 欄位直接關,不走 setDayNightEnabled(false) —— 那支會把兩片圓盤一起藏起來。
    // 這裡要的只是「update() 不要在迴圈中途按 4 Hz 拿真實時鐘把天相重算掉」,
    // 不然這條檢查會跟跑它的時間有關(第一版就是這樣:夜裡的太陽照樣在動)。
    s2.dayNightEnabled = false;
    const beam = s2.sunDisc.userData.beam as THREE.Texture;
    const moonBeam = s2.moonDisc.userData.beam as THREE.Texture;
    check('掃描線:圓盤帶著那張波形貼圖進了 sky-and-fog',
      !!beam && !!moonBeam && beam !== moonBeam);
    const uploads = { sun: 0, moon: 0 };
    for (const [k, t] of [['sun', beam], ['moon', moonBeam]] as const) {
      let n = 0;
      Object.defineProperty(t, 'needsUpdate', { set: () => { n++; }, get: () => false });
      Object.defineProperty(uploads, k, { get: () => n });
    }
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) {
      s2.update(1 / 60, cam);
      seen.push(beam.offset.x);
    }
    check('掃描線:sky-and-fog 每幀真的推得動 offset —— 60 幀 60 個不重複的值',
      new Set(seen).size === 60, `${new Set(seen).size} 個相異值`);
    // ⚠ 這一條的第一版跑 60 幀就收工,而 60 幀只走到 0.35 —— **從來沒有越過 1**,
    //   所以把 `% 1` 刪掉它照樣全綠(突變測出來的:2121 ✓ / 0 ✗)。門檻的兩邊都要
    //   跑到(DEMO_POC_GUIDE §6.3),所以這裡跑到確定繞過好幾圈,而且**要求它真的
    //   繞過** —— 不然「全部 < 1」在一條永遠只走到 0.35 的序列上是恆真句。
    const long: number[] = [];
    for (let i = 0; i < 600; i++) { s2.update(1 / 60, cam); long.push(beam.offset.x); }
    const wraps = long.filter((v, i) => i > 0 && v < long[i - 1]).length;
    check('掃描線:繞過好幾圈之後仍然留在 [0, 1)(不取模的話 float 幾小時後開始掉格)',
      long.every((v) => v >= 0 && v < 1) && wraps >= 3,
      `10 秒走了 ${wraps} 圈,最大值 ${Math.max(...long).toFixed(4)}`
      + `(不取模的話會長到 ${(0.35 * 10 + seen[59]).toFixed(2)}）`);
    check('掃描線:一次逐幀上傳都沒有(needsUpdate 一次都沒被寫)',
      uploads.sun === 0 && uploads.moon === 0,
      `日 ${uploads.sun} 次 / 月 ${uploads.moon} 次`);
    // 藏起來的圓盤不推 —— 正午的月亮是隱形的,推它等於白算,而且下一次它露臉時
    // 掃描線會從一個沒人看過的相位開始。
    check('掃描線:藏起來的那一顆一格都沒推(正午的月亮是隱形的)',
      moonBeam.offset.x === 0 && beam.offset.x > 0,
      `月 ${moonBeam.offset.x.toFixed(4)}(沒動) / 日 ${beam.offset.x.toFixed(4)}(動了)`);

    // 換夜:這回月亮在天上、太陽下去了 —— 兩顆的速度分開量,而且**不同步**
    // (同速的話兩顆就是同一台機器的兩個畫面)。
    s2.applyLighting(night(), cam);
    const sunParked = beam.offset.x;
    for (let i = 0; i < 60; i++) s2.update(1 / 60, cam);
    check('掃描線:日月一秒各走 demo 那個圈數(0.35 / 0.22),而且不同步',
      Math.abs(seen[59] - 0.35) < 0.01 && Math.abs(moonBeam.offset.x - 0.22) < 0.01
      && moonBeam.offset.x !== seen[59],
      `日 ${seen[59].toFixed(4)} / 月 ${moonBeam.offset.x.toFixed(4)}`);
    check('掃描線:換成夜之後換太陽停著(規則是對稱的,不是只寫給月亮的)',
      beam.offset.x === sunParked, `日 ${beam.offset.x.toFixed(4)}`);
    s2.dispose();
    cs.dispose();
  }
}

// ── Clouds vs demo ──
//
// Same discipline as checkCelestialDiscs: the demo is the reference, not a
// transcription of it. The demo's own cloud code — the cotton-ball / brick
// IIFE plus every helper it calls (gouacheCanvas, gouacheTexture, rep,
// batchGroup / plasticBox, studInstances, addStudsRect, makeStudGeo) — is
// sliced straight out of the HTML and EXECUTED on a seeded Math.random
// stream; the strategy's buildCloud runs on the same stream and must agree
// ball for ball, matrix for matrix, paint stroke for paint stroke.
//
// The demo spends 6 extra draws per cloud on placement/speed/phase. Those
// belong to the DECK in gameview (sky-and-fog scatters, drifts and bobs the
// clouds — that behaviour is deliberately NOT the style's), so the check
// burns them between buildCloud calls to stay aligned with the demo stream.
const CLOUD_STREAM_SEED = 0x5eed;

/** Max |element| difference between two Matrix4s. */
function mat4Diff(a: THREE.Matrix4, b: THREE.Matrix4): number {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a.elements[i] - b.elements[i]));
  return d;
}

/**
 * Worst per-element difference between two geometries, position + normal +
 * index. Index is compared EXACTLY, and that is the point of comparing it at
 * all: a reversed winding leaves every vertex where it was and turns the part
 * inside out — three culls FrontSide, so the browser draws a hole and no
 * headless rasteriser ever sees it (see MEMORY: probe renders hide degenerate
 * triangles). `Infinity` = the buffers are not even the same shape.
 */
function bufferDiff(a: THREE.BufferGeometry, b: THREE.BufferGeometry): string {
  const attrs = ['position', 'normal'];
  for (const name of attrs) {
    const pa = a.getAttribute(name) as THREE.BufferAttribute | undefined;
    const pb = b.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!pa || !pb) return `${name}: ${pa ? 'ours only' : 'demo only'}`;
    if (pa.count !== pb.count) return `${name}: ${pa.count} vs ${pb.count} vertices`;
    let worst = 0;
    for (let i = 0; i < pa.count * pa.itemSize; i++) {
      worst = Math.max(worst, Math.abs(pa.array[i] - pb.array[i]));
    }
    if (worst > 1e-6) return `${name}: max diff ${worst.toExponential(2)}`;
  }
  const ia = a.getIndex(), ib = b.getIndex();
  if (!ia || !ib) return `index: ${ia ? 'ours only' : 'demo only'}`;
  if (ia.count !== ib.count) return `index: ${ia.count} vs ${ib.count}`;
  for (let i = 0; i < ia.count; i++) {
    if (ia.getX(i) !== ib.getX(i)) return `index[${i}]: ${ia.getX(i)} vs ${ib.getX(i)} (winding)`;
  }
  return 'identical';
}

function buffersMatch(a: THREE.BufferGeometry, b: THREE.BufferGeometry): boolean {
  return bufferDiff(a, b) === 'identical';
}

type DemoCloud = { grp: THREE.Group; speed: number; phase: number };

function checkPaperClouds(): void {
  console.log('\n[clouds vs demo — cuphead (paper)]');
  const strategy = createPaperTerrainStyle();
  check('strategy declares buildCloud', !!strategy.buildCloud);
  if (!strategy.buildCloud) return;

  const src = readFileSync('plan/paper-town-demo.html', 'utf8');

  // ── Demo side: helpers + the cotton-ball IIFE, executed for real ──
  const cloudAt = src.indexOf('棉花球雲');
  const cloudsDeclAt = src.indexOf('const clouds = [];', cloudAt);
  const iifeEnd = src.indexOf('})();', cloudsDeclAt);
  check('demo declares the cotton-ball cloud IIFE', cloudAt >= 0 && cloudsDeclAt > cloudAt && iifeEnd > cloudsDeclAt);
  if (cloudAt < 0 || cloudsDeclAt < 0 || iifeEnd < 0) return;
  const gsAt = src.indexOf('const GS = 256;');
  const tintAt = src.indexOf('function tint(', gsAt);
  const tintEnd = src.indexOf('\n  }', tintAt);
  const cacheAt = src.indexOf('const gouacheCache = new Map();');
  check('demo declares GS/BOARD/tint + the gouache cache', gsAt >= 0 && tintEnd > tintAt && tintAt > gsAt && cacheAt >= 0);
  const demoSrc = [
    sliceDemoFn(src, 'mulberry32'),
    src.slice(gsAt, tintEnd + 4), // GS, BOARD, rgbOf, tint
    sliceDemoFn(src, 'gouacheCanvas'),
    'const gouacheCache = new Map();',
    sliceDemoFn(src, 'gouacheTexture'),
    sliceDemoFn(src, 'rep'),
    sliceDemoFn(src, 'batchGroup'),
    src.slice(cloudsDeclAt, iifeEnd + 5),
    'return clouds;',
  ].join('\n');

  // Stubs for the two helpers whose real versions live outside the slice: the
  // toon material factory (records its opts) and the shared unit sphere.
  const toon = (opts: Record<string, unknown>): THREE.MeshBasicMaterial => {
    const m = new THREE.MeshBasicMaterial();
    m.userData.demoOpts = opts;
    return m;
  };
  const spheres = new Map<string, THREE.SphereGeometry>();
  const unitSphere = (w: number, h: number): THREE.SphereGeometry => {
    const key = `${w}x${h}`;
    let g = spheres.get(key);
    if (!g) { g = new THREE.SphereGeometry(0.5, w, h); spheres.set(key, g); }
    return g;
  };
  const demoCanvases: RecCanvas[] = [];
  const demoDoc = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`demo created <${tag}>`);
      const c = recCanvas();
      demoCanvases.push(c);
      return c;
    },
  };

  // The demo slice gets a Math SHIM whose .random is the seeded stream —
  // never the global: three.js burns four Math.random draws on every object
  // uuid, and the two sides create different object counts, so a global
  // replacement can never stay aligned. (Found the hard way: the first cut
  // of this check seeded the global and drifted 6.5 m by cloud two.)
  const demoMath = Object.create(Math) as Math;
  (demoMath as { random: () => number }).random = mulberry32(CLOUD_STREAM_SEED);
  const demoClouds = new Function('THREE', 'document', 'scene', 'toon', 'unitSphere', 'Math', demoSrc)(
    THREE, demoDoc, new THREE.Group(), toon, unitSphere, demoMath,
  ) as DemoCloud[];

  check('demo: five clouds, each batched to ONE InstancedMesh (its own comment says so)',
    demoClouds.length === 5
      && demoClouds.every((c) => c.grp.children.length === 1
        && (c.grp.children[0] as THREE.InstancedMesh).isInstancedMesh));

  // ── Our side: the SAME seeded stream through the hook's rand parameter,
  // burning the deck's 6 draws per cloud ──
  const doc = (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document;
  const ourCanvases: RecCanvas[] = [];
  const prevCreate = doc.createElement;
  const ours: THREE.Object3D[] = [];
  try {
    doc.createElement = (tag: string) => {
      if (tag !== 'canvas') throw new Error(`strategy created <${tag}>`);
      const c = recCanvas();
      ourCanvases.push(c);
      return c;
    };
    const rng = mulberry32(CLOUD_STREAM_SEED);
    for (let i = 0; i < demoClouds.length; i++) {
      ours.push(strategy.buildCloud(i, rng)!);
      for (let b = 0; b < 6; b++) rng(); // placement/speed/phase → the deck's
    }
  } finally {
    doc.createElement = prevCreate;
  }

  // Every ball of every cloud, against the demo's own instance matrices.
  let worstBall = 0;
  let countsMatch = true;
  const da = new THREE.Matrix4();
  const db = new THREE.Matrix4();
  for (let i = 0; i < demoClouds.length; i++) {
    const dIm = demoClouds[i].grp.children[0] as THREE.InstancedMesh;
    const oIm = ours[i] as THREE.InstancedMesh;
    if (!oIm.isInstancedMesh || oIm.count !== dIm.count) { countsMatch = false; continue; }
    for (let j = 0; j < dIm.count; j++) {
      dIm.getMatrixAt(j, da);
      oIm.getMatrixAt(j, db);
      worstBall = Math.max(worstBall, mat4Diff(da, db));
    }
  }
  check('every cloud is an InstancedMesh with the demo\'s ball count', countsMatch);
  check('every ball sits and squashes exactly where the demo put it', worstBall < 1e-5,
    `max matrix element diff ${worstBall.toExponential(2)}`);

  const dGeo = (demoClouds[0].grp.children[0] as THREE.InstancedMesh).geometry as THREE.SphereGeometry;
  const oGeo = (ours[0] as THREE.InstancedMesh).geometry as THREE.SphereGeometry;
  check('ball geometry is the demo\'s unitSphere(14, 10) at radius 0.5',
    oGeo.parameters.radius === dGeo.parameters.radius
      && oGeo.parameters.widthSegments === dGeo.parameters.widthSegments
      && oGeo.parameters.heightSegments === dGeo.parameters.heightSegments,
    `${oGeo.parameters.widthSegments}×${oGeo.parameters.heightSegments} r=${oGeo.parameters.radius}`);

  // The batching law, one step past the demo: the whole DECK shares one
  // geometry, one material, one painted canvas — a cloud is one draw call.
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  for (const o of ours) {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      geos.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
    });
  }
  check('whole deck: ONE shared geometry, ONE shared material, ONE canvas painted',
    geos.size === 1 && mats.size === 1 && ourCanvases.length === 1,
    `geo ${geos.size} mat ${mats.size} canvases ${ourCanvases.length}`);
  check('shared resources carry userData.shared (deck rebuilds must not free them)',
    [...geos].every((g) => g.userData.shared === true)
      && [...mats].every((m) => m.userData.shared === true));

  // The cotton texture: the demo's exact gouache, stroke for stroke. This is
  // what catches a "corrected" port — the whole point of executing the demo.
  const mismatch = diffAt(demoCanvases[0].steps, ourCanvases[0].steps);
  check('cotton gouache paints the demo\'s exact command stream', mismatch === '',
    mismatch === '' ? `${ourCanvases[0].steps.length} ops` : mismatch);
  check(`cotton canvas is the demo's ${demoCanvases[0].width}×${demoCanvases[0].height}`,
    ourCanvases[0].width === demoCanvases[0].width && ourCanvases[0].height === demoCanvases[0].height,
    `${ourCanvases[0].width}×${ourCanvases[0].height}`);

  const demoMat = demoClouds[0].grp.children[0] as THREE.InstancedMesh;
  const demoTex = ((demoMat.material as THREE.MeshBasicMaterial).userData.demoOpts as { map: THREE.Texture }).map;
  const ourMat = (ours[0] as THREE.InstancedMesh).material as THREE.MeshToonMaterial;
  const ourTex = ourMat.map!;
  check('texture contract matches the demo (repeat 1.6×1.6, repeat-wrapped, sRGB)',
    ourTex.repeat.x === demoTex.repeat.x && ourTex.repeat.y === demoTex.repeat.y
      && ourTex.wrapS === demoTex.wrapS && ourTex.wrapT === demoTex.wrapT
      && ourTex.colorSpace === demoTex.colorSpace,
    `repeat ${ourTex.repeat.x}×${ourTex.repeat.y}`);
  // gradientMap is the WORLD's own 3-tone ramp, not the demo's 4-tone — the
  // gameview paper world made that call once for every material; clouds join it.
  check('toon material with the world\'s gradient ramp', !!ourMat.gradientMap && !!(ourMat as THREE.MeshToonMaterial).isMaterial);

  // InstancedMesh's default bounding sphere is the 0.5 m unit ball — without a
  // recompute the whole cloud is frustum-culled the moment it leaves the
  // screen centre (and no probe would ever show it: probes don't cull).
  const bs = (ours[0] as THREE.InstancedMesh).boundingSphere;
  check('instance-aware bounding sphere computed (culling would eat the cloud)',
    !!bs && bs.radius > 5, bs ? `r=${bs.radius.toFixed(1)} m` : 'null');

  strategy.dispose();
}

function checkPlasticClouds(): void {
  console.log('\n[clouds vs demo — plastic (toy blocks)]');
  const strategy = createPlasticTerrainStyle();
  check('strategy declares buildCloud', !!strategy.buildCloud);
  if (!strategy.buildCloud) return;

  const src = readFileSync('plan/plastic-town-demo.html', 'utf8');

  const cloudAt = src.indexOf('積木雲');
  const cloudsDeclAt = src.indexOf('const clouds = [];', cloudAt);
  const iifeEnd = src.indexOf('})();', cloudsDeclAt);
  check('demo declares the brick cloud IIFE', cloudAt >= 0 && cloudsDeclAt > cloudAt && iifeEnd > cloudsDeclAt);
  if (cloudAt < 0 || cloudsDeclAt < 0 || iifeEnd < 0) return;
  const lodAt = src.indexOf('const STUD_LOD =');
  const lodEndMark = 'const studGeo = studGeos[0];';
  const lodEnd = src.indexOf(lodEndMark, lodAt);
  check('demo declares the stud LOD table', lodAt >= 0 && lodEnd > lodAt);
  const demoSrc = [
    sliceDemoFn(src, 'makeStudGeo'),
    src.slice(lodAt, lodEnd + lodEndMark.length), // STUD_LOD, studGeos, studGeo
    sliceDemoFn(src, 'studInstances'),
    sliceDemoFn(src, 'plasticBox'),
    sliceDemoFn(src, 'addStudsRect'),
    src.slice(cloudsDeclAt, iifeEnd + 5),
    'return clouds;',
  ].join('\n');

  // The one helper stubbed (its real body only wraps a material cache): a
  // memoized colour-recording material, so b1 and the studs keep the same
  // IDENTITY they get from the demo's toonShared.
  const stubMats = new Map<string, THREE.MeshBasicMaterial>();
  const toonShared = (color: string): THREE.MeshBasicMaterial => {
    let m = stubMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial();
      m.userData.recColor = color;
      stubMats.set(color, m);
    }
    return m;
  };

  // Math shim, not the global — see checkPaperClouds for why (three's uuids).
  const demoMath = Object.create(Math) as Math;
  (demoMath as { random: () => number }).random = mulberry32(CLOUD_STREAM_SEED);
  const demoClouds = new Function('THREE', 'scene', 'toonShared', 'Math', demoSrc)(
    THREE, new THREE.Group(), toonShared, demoMath,
  ) as DemoCloud[];

  check('demo: five clouds of big brick + pale brick + studs',
    demoClouds.length === 5
      && demoClouds.every((c) => c.grp.children.length === 2
        && (c.grp.children[1].children[0] as THREE.InstancedMesh)?.isInstancedMesh));

  const ours: THREE.Object3D[] = [];
  const rng = mulberry32(CLOUD_STREAM_SEED);
  for (let i = 0; i < demoClouds.length; i++) {
    ours.push(strategy.buildCloud(i, rng)!);
    for (let b = 0; b < 6; b++) rng(); // placement/speed/phase → the deck's
  }

  // The demo places its clouds after building them; ours are placed by the
  // deck. Zero both roots and compare in the cloud's own frame.
  const dims = (mesh: THREE.Mesh): [number, number, number] => {
    const p = (mesh.geometry as THREE.BoxGeometry).parameters;
    return [p.width * mesh.scale.x, p.height * mesh.scale.y, p.depth * mesh.scale.z];
  };
  let worstDim = 0;
  let worstPos = 0;
  let worstStud = 0;
  let structure = true;
  let identity = true;
  let colors = true;
  const da = new THREE.Matrix4();
  const db = new THREE.Matrix4();
  for (let i = 0; i < demoClouds.length; i++) {
    const dGrp = demoClouds[i].grp;
    dGrp.position.set(0, 0, 0);
    dGrp.updateMatrixWorld(true);
    const oGrp = ours[i];
    oGrp.updateMatrixWorld(true);

    const [dB1, dB2] = dGrp.children as [THREE.Mesh, THREE.Mesh];
    const dStuds = dB2.children[0] as THREE.InstancedMesh;
    const [oB1, oB2, oStuds] = oGrp.children as [THREE.Mesh, THREE.Mesh, THREE.InstancedMesh];
    if (!oB1?.isMesh || !oB2?.isMesh || !oStuds?.isInstancedMesh || oStuds.count !== dStuds.count) {
      structure = false;
      continue;
    }
    for (let k = 0; k < 3; k++) {
      worstDim = Math.max(worstDim, Math.abs(dims(dB1)[k] - dims(oB1)[k]), Math.abs(dims(dB2)[k] - dims(oB2)[k]));
    }
    worstPos = Math.max(worstPos, dB2.position.distanceTo(oB2.position));
    // Studs live under b2 in the demo but BESIDE it here (b2 is a scaled unit
    // box — children would inherit the squash), so compare in world space.
    for (let j = 0; j < dStuds.count; j++) {
      dStuds.getMatrixAt(j, da);
      da.premultiply(dStuds.matrixWorld);
      oStuds.getMatrixAt(j, db);
      db.premultiply(oStuds.matrixWorld);
      worstStud = Math.max(worstStud, mat4Diff(da, db));
    }
    // The demo's toonShared gives b1 and the studs the same white material
    // OBJECT; ours must keep that identity (it is what lets them batch).
    identity = identity
      && dB1.material === dStuds.material
      && oB1.material === oStuds.material
      && oB1.material !== oB2.material;
    colors = colors
      && (dB1.material as THREE.MeshBasicMaterial).userData.recColor === '#ffffff'
      && (dB2.material as THREE.MeshBasicMaterial).userData.recColor === '#f4f6ff'
      && (oB1.material as THREE.MeshToonMaterial).color.getHexString() === 'ffffff'
      && (oB2.material as THREE.MeshToonMaterial).color.getHexString() === 'f4f6ff';
  }
  check('every cloud: big brick + pale brick + the demo\'s stud count', structure);
  check('brick dimensions are the demo\'s', worstDim < 1e-9, `max diff ${worstDim.toExponential(2)}`);
  check('pale brick sits where the demo put it', worstPos < 1e-9, `max diff ${worstPos.toExponential(2)}`);
  check('every stud caps the pale brick exactly like the demo (world space)',
    worstStud < 1e-5, `max matrix element diff ${worstStud.toExponential(2)}`);
  check('white material identity: b1 and studs share ONE material, like toonShared gives the demo', identity);
  check('colours: #ffffff brick + #f4f6ff brick, both sides', colors);

  // Stud unit geometry. This used to compare a CONTRACT ("8 radial segments,
  // y ∈ [0,1]") because gameview's unit stud was a THREE.CylinderGeometry and
  // the demo's was its own cap-less buffer. It is the demo's buffer now — the
  // demo says so in as many words («這是要搬進 gameview 的那一招,不是 demo 的
  // 權宜»), and one part may only have one implementation — so the check is a
  // demo-diff: the demo's own `makeStudGeo(8)`, buffer for buffer.
  {
    const dStudGeo = (demoClouds[0].grp.children[1].children[0] as THREE.InstancedMesh).geometry;
    const oStudGeo = (ours[0].children[2] as THREE.InstancedMesh).geometry;
    check('unit stud IS the demo\'s makeStudGeo(8) — vertices, normals, winding',
      buffersMatch(dStudGeo, oStudGeo), bufferDiff(dStudGeo, oStudGeo));
    // …and the thing the cap-less layout is FOR: 3n−2 triangles where three's
    // n-sided cylinder pays 4n. No bottom cap (it sits on a brick), fan-
    // triangulated top (n−2) instead of an umbrella round the centre (n).
    check('…and it is the cheap one: 3n−2 = 22 triangles at n = 8, not a cylinder\'s 4n = 32',
      oStudGeo.index!.count / 3 === 22, `${oStudGeo.index!.count / 3} triangles`);
  }

  // Deck accounting: 3 draws per cloud (two bricks + one stud batch), but only
  // TWO geometries and TWO materials across the entire deck — the unit box and
  // unit stud carry size in the instance/mesh scale, which the demo could not
  // do because its studs hung under real-size geometry.
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  let draws = 0;
  for (const o of ours) {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      draws++;
      geos.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
    });
  }
  check('whole deck: 3 draws per cloud, TWO shared geometries, TWO shared materials',
    draws === ours.length * 3 && geos.size === 2 && mats.size === 2,
    `draws ${draws} geo ${geos.size} mat ${mats.size}`);
  check('shared resources carry userData.shared (deck rebuilds must not free them)',
    [...geos].every((g) => g.userData.shared === true)
      && [...mats].every((m) => m.userData.shared === true));

  strategy.dispose();
}

/**
 * The clouds in the deck: SkyAndFog on a stand-in renderer. The rules under
 * test are the DECK's: the billboard path must be untouched when no style
 * hook exists, a style hook must slot into the same altitude/drift/immersion
 * behaviour, and the fade must flip the style materials translucent only
 * while the rider is actually crossing the deck edge.
 */
function checkCloudDeckBehaviour(): void {
  console.log('\n[clouds in the deck — behaviour]');

  const strategy = createPaperTerrainStyle();
  const fake = fakeGameRenderer();
  // Private members are reached on purpose — same trade as the celestial check.
  const sky = new SkyAndFog(fake as never) as any;
  sky.init();

  // ── No style hook: today's billboard deck, exactly ──
  sky.setCloudsEnabled(true);
  const billboards = sky.cloudGroup as THREE.Group;
  const billboardsOk = billboards.children.length === 18
    && billboards.children.every((c) => {
      const m = c as THREE.Mesh;
      const mat = m.material as THREE.MeshBasicMaterial;
      return m.isMesh && m.geometry.type === 'PlaneGeometry'
        && Math.abs(m.rotation.x + Math.PI / 2) < 1e-9
        && mat.transparent && mat.depthWrite === false && mat.map === sky.cloudTexture
        && (m.userData.baseOpacity as number) >= 0.4 && (m.userData.baseOpacity as number) <= 0.7
        && !m.userData.styleCloud;
    });
  check('no style hook: 18 horizontal translucent billboards, per-mesh baseOpacity — unchanged', billboardsOk);
  const bc = census(billboards, '');
  check('billboard deck census: 18 transparent draws, 18 geometries, 18 materials',
    bc.calls === 18 && bc.transparent === 18 && bc.geometries === 18 && bc.materials === 18,
    `calls ${bc.calls} transparent ${bc.transparent} geo ${bc.geometries} mat ${bc.materials}`);

  // ── Adopt the paper style: rebuild in place ──
  sky.setCloudBuilder(strategy.buildCloud!.bind(strategy));
  const deck = sky.cloudGroup as THREE.Group;
  check('style adopted: deck rebuilt, every slot a style cloud inside the layer',
    deck !== billboards && deck.children.length === 18
      && deck.children.every((c) => c.userData.styleCloud === true
        && (c as THREE.InstancedMesh).isInstancedMesh
        && c.position.y >= 0 && c.position.y <= 200));
  const sc = census(deck, '');
  check('style deck census: 18 instanced draws, ONE geometry, ONE material, ZERO transparent',
    sc.calls === 18 && sc.instMeshes === 18 && sc.geometries === 1 && sc.materials === 1 && sc.transparent === 0,
    `calls ${sc.calls} geo ${sc.geometries} mat ${sc.materials} transparent ${sc.transparent}`);
  check('deck collected the style materials for the fade', sky.styleCloudMats.length === 1);
  const mat = sky.styleCloudMats[0] as THREE.Material;
  check('handed over opaque — outside the deck the clouds cost no blending',
    mat.transparent === false && mat.depthWrite === true && mat.opacity === 1);

  // ── Immersion fade: only while crossing the deck edge ──
  const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
  const camAt = (y: number): void => {
    sky.lastCameraY = y;
    sky.applyCloudImmersion();
    sky.animateClouds(0.016, new THREE.Vector3(0, y, 0));
  };
  const base = sky.cloudBaseSceneY() as number;
  camAt(base); // immersion 0.5 by contract → fade 1 − smoothstep(0.25,0.75,0.5) = 0.5
  check('mid-crossing: deck faded to 0.5, flipped translucent, depthWrite off',
    near(mat.opacity, 0.5) && mat.transparent === true && mat.depthWrite === false,
    `opacity ${mat.opacity.toFixed(3)}`);
  camAt(base);
  check('re-applying the fade does not compound', near(mat.opacity, 0.5));
  camAt(base + 100); // deck centre: immersion 1 → fade 0
  check('fully immersed: clouds invisible (the fog is the interior, not the shapes)',
    deck.children.every((c) => c.visible === false) && near(mat.opacity, 0));
  camAt(base - 500);
  check('back outside: opacity 1, opaque and depth-writing again',
    mat.opacity === 1 && mat.transparent === false && mat.depthWrite === true);

  // ── The demo's bob + the deck's drift, style clouds only ──
  const cloud = deck.children[0];
  const yBefore = cloud.position.y;
  const xs = deck.children.map((c) => c.position.x);
  camAt(base - 500);
  check('style clouds bob about their base (demo: ±1.2 m) and drift in x',
    Math.abs(cloud.position.y - (cloud.userData.baseY as number)) <= 1.2 + 1e-6
      && deck.children.some((c, i) => Math.abs(c.position.x - xs[i]) > 1e-9),
    `y ${yBefore.toFixed(2)} → ${cloud.position.y.toFixed(2)}, base ${(cloud.userData.baseY as number).toFixed(2)}`);

  // ── Budget rebuild goes through the same hook ──
  sky.setCloudBudget(8);
  check('quality budget rebuild: 8 style clouds', (sky.cloudGroup as THREE.Group).children.length === 8);

  // Rebuild mid-immersion must hand the shared materials back opaque.
  camAt(base);
  sky.setCloudBudget(12);
  check('rebuild mid-immersion resets the shared materials to opaque',
    mat.opacity === 1 && mat.transparent === false && mat.depthWrite === true);

  // ── Teardown never disposes the strategy's singletons ──
  let disposedMats = 0;
  mat.addEventListener('dispose', () => disposedMats++);
  const geo = ((sky.cloudGroup as THREE.Group).children[0] as THREE.InstancedMesh).geometry;
  let disposedGeos = 0;
  geo.addEventListener('dispose', () => disposedGeos++);
  sky.setCloudsEnabled(false);
  check('deck teardown leaves the strategy-owned singletons alone',
    disposedMats === 0 && disposedGeos === 0 && sky.cloudGroup === null);

  // ── Removing the builder gives today's clouds back, exactly ──
  sky.setCloudsEnabled(true);
  sky.setCloudBuilder(null);
  const fallback = sky.cloudGroup as THREE.Group;
  check('builder removed: the billboard deck returns (at the tier budget, 12 by now)',
    fallback.children.length === 12
      && fallback.children.every((c) => !c.userData.styleCloud
        && (c as THREE.Mesh).geometry.type === 'PlaneGeometry'));

  sky.dispose();
  strategy.dispose();
}

// ── Lighting: the world never goes darker than the demos' night ──
function checkLighting(name: string, strategy: TerrainStyleStrategy): void {
  console.log(`\n[lighting — ${name}]`);

  const WEATHERS: WeatherType[] = ['sunny', 'cloudy', 'rainy', 'snowy'];
  const palette = strategy.skyPalette;
  const night = palette.night;

  // Every hour of the day × every weather.
  const combos: { elev: number; weather: WeatherType; l: any }[] = [];
  for (let elev = -30; elev <= 60; elev += 2) {
    for (const weather of WEATHERS) {
      const celestial = {
        sunElevation: elev,
        sunAzimuth: 180,
        moonElevation: -elev,
        moonAzimuth: 0,
        moonPhase: 0.5,
        isDaytime: elev > 0,
        dayFactor: elev > 0 ? 1 : 0,
      };
      combos.push({ elev, weather, l: computeDayNightLighting(celestial as any, weather, palette) });
    }
  }

  check(
    'exposure is constant — mood comes from the palette, not the shutter',
    combos.every((c) => c.l.toneMappingExposure === TONE_MAPPING_EXPOSURE),
    `${TONE_MAPPING_EXPOSURE} across ${combos.length} combos`,
  );

  const dimmest = combos.reduce((a, b) => (a.l.ambientIntensity <= b.l.ambientIntensity ? a : b));
  check(
    "nothing is dimmer than the demo's night — ambient floor holds",
    combos.every((c) => c.l.ambientIntensity >= night.ambientIntensity - 1e-6),
    `dimmest = ${dimmest.l.ambientIntensity.toFixed(3)} (${dimmest.weather} @ ${dimmest.elev}°), ` +
      `floor = ${night.ambientIntensity}`,
  );

  check(
    'the key light never goes out (storms flatten it, they do not kill it)',
    combos.every((c) => c.l.directionalIntensity >= night.sunIntensity * 0.35 - 1e-6),
    `min = ${Math.min(...combos.map((c) => c.l.directionalIntensity)).toFixed(3)}`,
  );

  // A cloudy noon must be BRIGHTER than a clear night — the old pipeline failed
  // this: overcast multipliers plus a crushed exposure made a grey day dark.
  const cloudyNoon = combos.find((c) => c.elev === 40 && c.weather === 'cloudy')!;
  const clearNight = combos.find((c) => c.elev === -20 && c.weather === 'sunny')!;
  const lit = (l: any) => l.ambientIntensity + l.directionalIntensity + l.hemisphereIntensity;
  check(
    'an overcast noon is brighter than a clear night',
    lit(cloudyNoon.l) > lit(clearNight.l) * 1.5,
    `cloudy noon ${lit(cloudyNoon.l).toFixed(2)} vs clear night ${lit(clearNight.l).toFixed(2)}`,
  );

  // Overcast = flat + grey + hazy, NOT dark: the fill light goes UP.
  const sunnyNoon = combos.find((c) => c.elev === 40 && c.weather === 'sunny')!;
  check(
    'overcast lifts the fill light (clouds scatter light, they do not eat it)',
    cloudyNoon.l.ambientIntensity > sunnyNoon.l.ambientIntensity,
    `cloudy ${cloudyNoon.l.ambientIntensity.toFixed(2)} vs sunny ${sunnyNoon.l.ambientIntensity.toFixed(2)}`,
  );
  check(
    'overcast pulls the fog in and greys it',
    cloudyNoon.l.fogFar < sunnyNoon.l.fogFar,
    `fog far ${cloudyNoon.l.fogFar.toFixed(0)} m vs ${sunnyNoon.l.fogFar.toFixed(0)} m`,
  );

  // Night must still READ as night — the floor must not flatten the day/night arc.
  check(
    'day is still clearly brighter than night (the arc survives the floor)',
    lit(sunnyNoon.l) > lit(clearNight.l) * 1.8,
    `noon ${lit(sunnyNoon.l).toFixed(2)} vs night ${lit(clearNight.l).toFixed(2)}`,
  );

  // The sky dome carries the hour: night sky must be dark even though the LIGHTS
  // have a floor (that is what keeps the world visible without a black void).
  const skyLum = (hex: number) => ((hex >> 16 & 0xff) + (hex >> 8 & 0xff) + (hex & 0xff)) / 3;
  check(
    'the night sky is dark even though the lights are floored',
    skyLum(clearNight.l.skyTopColor) < skyLum(sunnyNoon.l.skyTopColor) * 0.5,
    `night top ${skyLum(clearNight.l.skyTopColor).toFixed(0)} vs day ${skyLum(sunnyNoon.l.skyTopColor).toFixed(0)}`,
  );

  check(
    'background tracks the horizon band — it can never flash black',
    combos.every((c) => c.l.backgroundColor === c.l.skyBottomColor),
  );

  strategy.dispose();
}

/**
 * The demo's sky dome, EXECUTED — its ShaderMaterial plus the `skyAnchor.add(…)`
 * line that hangs it, sliced out and run against real three.
 *
 * Executed rather than regex'd for one specific reason: what is being read is a
 * number inside a GLSL string, and the HTML around it is full of prose that
 * contains the same digits. Running the block and reading
 * `material.fragmentShader` off the object that was actually built guarantees
 * the string is the one that would be compiled — the `fog: false` trap in
 * reverse (an assertion that matched its own explanatory comment and was
 * therefore always true). GLSL comments are stripped before matching too, so
 * even a comment INSIDE the shader source cannot stand in for the code.
 */
function demoSkyDome(src: string): { height: number; steps: number; radius: number } {
  const head = '  const skyMat = new THREE.ShaderMaterial({';
  const tail = ', skyMat));';
  const a = src.indexOf(head);
  const b = src.indexOf(tail, a);
  if (a < 0 || b < 0) throw new Error('cannot slice the demo sky dome');
  const DAY = { top: new THREE.Color(0xffffff), bottom: new THREE.Color(0x000000) };
  const anchor = new THREE.Group();
  new Function('THREE', 'skyAnchor', 'DAY', src.slice(a, b + tail.length))(THREE, anchor, DAY);
  const mesh = anchor.children[0] as THREE.Mesh;
  const mat = mesh.material as THREE.ShaderMaterial;
  const glsl = mat.fragmentShader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const h = /vP\.y\s*\/\s*([\d.]+)/.exec(glsl);
  const st = /floor\(\s*h\s*\*\s*([\d.]+)\s*\)\s*\/\s*([\d.]+)/.exec(glsl);
  if (!h || !st) throw new Error('cannot read the demo gradient out of the shader');
  return {
    height: Number(h[1]),
    // 分子分母必須是同一個數,否則 posterise 出來根本不是等距的階。
    steps: Number(st[1]) === Number(st[2]) ? Number(st[1]) : NaN,
    radius: (mesh.geometry as THREE.SphereGeometry).parameters.radius,
  };
}

function checkGradientSky(): void {
  console.log('\n[gradient sky dome]');
  const WORLDS = [
    ['plastic', createPlasticTerrainStyle()],
    ['paper', createPaperTerrainStyle()],
    ['circuit', createCircuitTerrainStyle()],
  ] as const;
  const scene = new THREE.Scene();
  const sky = new GradientSky(scene, WORLDS[0][1].skyPalette.gradient);

  check('dome is added to the scene', scene.children.includes(sky.mesh));

  const mat = sky.mesh.material as THREE.ShaderMaterial;
  check('renders inside-out (BackSide) so we see it from within', mat.side === THREE.BackSide);
  check('writes no depth — the world always paints over it', !mat.depthWrite);
  check('drawn first (renderOrder < 0)', sky.mesh.renderOrder < 0);
  check('never frustum-culled', !sky.mesh.frustumCulled);

  const geo = sky.mesh.geometry as THREE.SphereGeometry;
  const radius = geo.parameters.radius;
  check(
    'dome clears the far mountains + horizon disc but stays inside the far plane',
    radius > 4000 && radius < 8000,
    `radius ${radius} m (mountains 2600, disc 4000, camera far 8000)`,
  );

  sky.update(new THREE.Vector3(100, 20, -50));
  check(
    'dome follows the rider (never gets left behind)',
    sky.mesh.position.x === 100 && sky.mesh.position.z === -50,
  );

  sky.setColors(new THREE.Color(0x112233), new THREE.Color(0x445566));
  check(
    'colours are settable (day↔night blend drives them)',
    mat.uniforms.topColor.value.getHex() === 0x112233,
  );

  sky.dispose();
  check('dome disposes cleanly', scene.children.length === 0);

  // ── 漸層的**形狀**是逐世界的,因為三個 demo 互相不同 ─────────────────────
  //
  // gameview 原本寫死 `SKY_RADIUS * (260 / 1100)` 與 5 階給三個世界共用,而那是
  // **塑膠一個世界的數字**:瓦楞紙與電子的 demo 都寫 500,所以它們的地平線色帶
  // 被畫低了 500 / 260 = 1.923 倍;電子的 demo 還是 6 階不是 5 階。沒有任何斷言
  // 看得到 —— 那個註解甚至寫著「The demo used 260 on an 1100 m dome」,只對三分
  // 之一的世界成立。
  //
  // 這裡兩邊都不是抄的:demo 那側把 skyMat 那一段**執行**起來、從貨物件讀
  // fragmentShader;gameview 那側真的 new 一個 GradientSky、讀它的 uniform。
  for (const [world, strategy] of WORLDS) {
    const demo = demoSkyDome(demoScript(SHADOW_DEMOS[world]));
    const gradient = strategy.skyPalette.gradient;
    check(`${world}:demo 的穹頂就是 DEMO_SKY_DOME_RADIUS`,
      demo.radius === DEMO_SKY_DOME_RADIUS,
      `demo SphereGeometry(${demo.radius}) vs ${DEMO_SKY_DOME_RADIUS}`);
    check(`${world}:漸層高度就是 demo shader 裡的那個分母`,
      gradient.demoHeight === demo.height,
      `demo vP.y / ${demo.height} vs skyPalette.gradient.demoHeight ${gradient.demoHeight}`);
    check(`${world}:階數就是 demo shader 裡的那個 floor()`,
      gradient.steps === demo.steps,
      `demo floor(h * ${demo.steps}) vs skyPalette.gradient.steps ${gradient.steps}`);

    const s = new THREE.Scene();
    const dome = new GradientSky(s, gradient);
    const m = dome.mesh.material as THREE.ShaderMaterial;
    const R = (dome.mesh.geometry as THREE.SphereGeometry).parameters.radius;
    const ourRatio = (m.uniforms.gradientHeight.value as number) / R;
    const demoRatio = demo.height / demo.radius;
    check(`${world}:建出來的 dome 保住 demo 的 h / R 比例`,
      Math.abs(ourRatio - demoRatio) < 1e-12,
      `ours ${(m.uniforms.gradientHeight.value as number).toFixed(3)} / ${R}`
      + ` = ${ourRatio.toFixed(6)} vs demo ${demo.height} / ${demo.radius} = ${demoRatio.toFixed(6)}`);
    check(`${world}:階數也真的進到 uniform`,
      m.uniforms.steps.value === demo.steps,
      `uniform ${String(m.uniforms.steps.value)} vs demo ${demo.steps}`);
    dome.dispose();
    strategy.dispose();
  }

  // 而且三個世界**不是**同一組數字 —— 這條就是那個被寫死的共用常數的墓碑。
  const shapes = WORLDS.map(([world]) => {
    const d = demoSkyDome(demoScript(SHADOW_DEMOS[world]));
    return `${d.height}/${d.steps}`;
  });
  check('三個 demo 的漸層形狀本來就不一樣 —— 所以它不可以是一組共用常數',
    new Set(shapes).size === 3,
    WORLDS.map(([w], i) => `${w} ${shapes[i]}`).join(' | '));
}

// ── 天色到底鋪不鋪得滿騎士看得到的那一段天空 ────────────────────────────────
//
// 上面那組斷言只證明 gameview 抄對了 demo 的數字。它們**證明不了那個數字好不好**
// —— 電路世界的 `demoHeight: 500` 兩邊完全一致、全綠,而實機騎起來整片天空是灰的。
// 這裡問的是另一個問題:騎士的畫面裡,天空那一段到底是不是這個世界的天色。
//
// 三個量,全部從**程式碼**讀回來,一個都不抄:
//
//   畫面頂邊仰角  chaseFrameTopElevationDeg(config 的出廠 pitch/height, DEFAULT_FOV)
//                 —— 注意是 DEFAULT_CONFIG.map.cameraPitch(12),不是 fps-camera 的
//                 DEFAULT_PITCH_DEG(30);這兩個差 18 度,而抄錯的那個會讓算出來的
//                 可見天空少 4.8 度。
//   遠山稜線仰角  FAR_RING_CREST_DEG —— 山擋掉的部分不算「看得到的天空」。
//   天頂色到位處  asin(demoHeight / 1100) —— 從 demo 的 shader 解出來的分母。
//
// 為什麼可以用 demo 的 1100 算角度:`skyGradientHeight` 保住 demoHeight / 半徑 這個
// 比值,所以到位的**仰角**跟這個 renderer 用多大的穹頂無關。
function checkSkyCoversVisibleBand(): void {
  console.log('\n[sky covers the visible band]');

  const WORLDS = ['plastic', 'paper', 'circuit'] as const;
  const STYLE = {
    plastic: createPlasticTerrainStyle,
    paper: createPaperTerrainStyle,
    circuit: createCircuitTerrainStyle,
  } as const;

  // 已知還蓋不滿的世界。**不是把斷言關掉,是把缺口釘住**:下面對這些世界斷言它
  // 「仍然」蓋不滿,所以哪天有人補好了,這條會紅,逼他把名字從這張表刪掉。
  const KNOWN_GAP: Partial<Record<typeof WORLDS[number], string>> = {
    paper: '瓦楞紙的 demoHeight 也是 500(天頂色要 27.0°),跟電路原本的病一樣。'
      + '使用者裁示這次只動電路,所以這裡記錄而不是斷言掉。',
  };

  /** 天頂色在哪個仰角到位(度)。 */
  const topColourElevationDeg = (demoHeight: number): number =>
    (Math.asin(Math.min(1, demoHeight / DEMO_SKY_DOME_RADIUS)) * 180) / Math.PI;

  /** demo 的 shader:`h = clamp(vP.y / height)` 再 `floor(h * steps) / steps`。 */
  const bandAt = (elevDeg: number, demoHeight: number, steps: number): number => {
    const h = Math.min(1, (Math.sin((elevDeg * Math.PI) / 180) * DEMO_SKY_DOME_RADIUS) / demoHeight);
    return Math.floor(h * steps) / steps;
  };

  /** HSV 的 S(0-1)。電路原本的地平線色 `#dfe8e2` 是 0.039 —— 那是一團灰,不是
   *  一個顏色;三個世界現在的地平線色都在 0.09 以上。這個量就是那條界線。 */
  const saturationOf = (hex: number): number => {
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  const HORIZON_MIN_SAT = 0.08;

  const frameTop = chaseFrameTopElevationDeg(
    DEFAULT_CONFIG.map.cameraPitch, DEFAULT_CONFIG.map.cameraHeight, DEFAULT_FOV,
  );

  // 先證明這三個量真的是活的,不是我在這裡寫死的常數。
  check('畫面頂邊仰角是從跟騎相機算出來的,而且出廠設定看得到天空',
    frameTop > 15 && frameTop < 25,
    `pitch ${DEFAULT_CONFIG.map.cameraPitch} / height ${DEFAULT_CONFIG.map.cameraHeight}`
    + ` / fov ${DEFAULT_FOV} → 畫面頂邊 ${frameTop.toFixed(2)}°`);
  check('遠山稜線比近山高 —— 山擋掉的那一段是遠山說了算',
    FAR_RING_CREST_DEG > NEAR_RING_CREST_DEG,
    `遠 ${FAR_RING_CREST_DEG.toFixed(2)}° vs 近 ${NEAR_RING_CREST_DEG.toFixed(2)}°`);
  check('稜線沒有把整個畫面封死 —— 還留得下一段天空',
    FAR_RING_CREST_DEG < frameTop,
    `稜線 ${FAR_RING_CREST_DEG.toFixed(2)}° < 畫面頂 ${frameTop.toFixed(2)}°`);

  for (const world of WORLDS) {
    const strategy = STYLE[world]();
    const demo = demoSkyDome(demoScript(SHADOW_DEMOS[world]));
    const { skyTop, skyBottom } = strategy.skyPalette.day;
    const arrival = topColourElevationDeg(demo.height);
    const gap = KNOWN_GAP[world];

    // ── A:天頂色必須在稜線之前(含 1° 餘裕)到位 ──
    // 沒到位 = 山擋住的部分是天色,露出來的那段反而是混色,騎士看到的就是一片灰。
    const coversA = arrival <= FAR_RING_CREST_DEG + 1;
    const detailA = `天頂色 ${arrival.toFixed(2)}° 到位 vs 稜線 ${FAR_RING_CREST_DEG.toFixed(2)}°`
      + ` (demo vP.y / ${demo.height})`;
    if (gap) {
      check(`${world}:【已知缺口】天頂色仍然在稜線之上才到位`, !coversA,
        `${detailA} — ${gap} 若這條紅了,表示它被修好了,請把 ${world} 從 KNOWN_GAP 刪掉`);
    } else {
      check(`${world}:天頂色在遠山稜線之前就到位`, coversA, detailA);
    }

    // ── B:畫面最上面那一格必須就是純天頂色 ──
    const topBand = bandAt(frameTop, demo.height, demo.steps);
    const detailB = `畫面頂邊 ${frameTop.toFixed(2)}° 的階 = ${topBand.toFixed(3)}`
      + ` (1.000 才是純 #${skyTop.toString(16).padStart(6, '0')})`;
    if (gap) {
      check(`${world}:【已知缺口】畫面最上面那一格仍然不是純天頂色`, topBand < 1, detailB);
    } else {
      check(`${world}:畫面最上面那一格就是純天頂色`, topBand === 1, detailB);
    }

    // ── C:漸層的**下緣**也得是個顏色 ──
    // A 只管稜線以上。稜線是有起伏的,山谷會露到更低的仰角,那一段永遠取樣在漸層
    // 下半部 —— 所以下緣是近乎白的灰的話,山谷那一段就還是灰的。這條就是「天色鋪滿
    // 整段」與「只有稜線以上是天色」的分界,也是電路這次改了兩個數字而不是一個的原因。
    const sat = saturationOf(skyBottom);
    check(`${world}:漸層下緣是個顏色,不是一團灰(山谷那一段靠它)`,
      sat >= HORIZON_MIN_SAT,
      `skyBottom #${skyBottom.toString(16).padStart(6, '0')} 飽和 ${(sat * 100).toFixed(1)}%`
      + ` ≥ ${(HORIZON_MIN_SAT * 100).toFixed(0)}%`);

    strategy.dispose();
  }
}

// ── The acrylic display case (DEVPLAN「壓克力罩天空」) ──
//
// The whole world is a model on a desk, so it stands under a case. What is
// checked here is the difference between a CASE and a wash of tint over the
// sky: a shell that thickens toward the desk, a rim band that is denser still,
// and streaks long enough for a rider's eye to catch. Every one of those has
// already been shipped wrong once in the demos.
function partOf(root: THREE.Object3D, name: string): THREE.Mesh | null {
  return (root.getObjectByName(`acrylicCase/${name}`) as THREE.Mesh | null) ?? null;
}

/** Alpha column of a geometry's 4-component vertex colours, at min/max y. */
function alphaRamp(mesh: THREE.Mesh): { atBase: number; atTop: number; itemSize: number } {
  const pos = mesh.geometry.getAttribute('position');
  const col = mesh.geometry.getAttribute('color');
  let lo = Infinity;
  let hi = -Infinity;
  let aLo = 0;
  let aHi = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const a = col && col.itemSize === 4 ? col.getW(i) : NaN;
    if (y < lo) { lo = y; aLo = a; }
    if (y > hi) { hi = y; aHi = a; }
  }
  return { atBase: aLo, atTop: aHi, itemSize: col?.itemSize ?? 0 };
}

function checkAcrylicCase(name: string, strategy: TerrainStyleStrategy): void {
  console.log(`\n[acrylic case — ${name}]`);

  const style = strategy.acrylicCase;
  check('the world declares a case at all', !!style);
  if (!style) return;

  // THE ONE RULE THAT IS NOT TASTE. Without a rim denser than the shell there
  // is no thickness cue anywhere in frame, and the case reads as tinted air —
  // which is exactly what the spec says it must not be.
  check(
    'the rim band is denser than the shell (a case has walls; tint does not)',
    style.rimOpacity > style.shellOpacity,
    `rim ${style.rimOpacity} vs shell ${style.shellOpacity}`,
  );
  check(
    'the shell is faint and the lip is the brightest part (a cut acrylic edge pipes light)',
    style.shellOpacity > 0 && style.shellOpacity < 0.3 && style.lipOpacity > style.rimOpacity,
    `shell ${style.shellOpacity}, rim ${style.rimOpacity}, lip ${style.lipOpacity}`,
  );
  // The spec's "one or two" is the count ON SCREEN; the case carries a few more
  // so that one or two are in frame from ANY heading (see the spread check
  // below). A striped ball is a different mistake in the same direction.
  check('a handful of long crown streaks — not zero, not a striped ball',
    style.streaks.length >= 2 && style.streaks.length <= 5,
    `${style.streaks.length} streaks`);
  // EVERY streak, not just the longest: a rider's eye is ~6 m up, so the sky in
  // frame is the first ~20° above the horizon (theta 1.2–1.57). A streak that
  // stops at the crown is decoration nobody ever sees — both demos shipped that
  // and had to run theta down to ~1.5. The merged-geometry check further down
  // only sees the lowest point, so it cannot catch one short streak among three.
  const streakEnds = style.streaks.map(([, , theta, len]) => theta + len);
  check(
    'every streak runs down toward the horizon, not just across the crown',
    streakEnds.every((end) => end >= 1.3),
    streakEnds.map((e) => e.toFixed(2)).join(', ') + ' (need ≥ 1.30 rad)',
  );
  check('streaks are NARROW — a wide one is a strip of tape, not a reflection',
    style.streaks.every(([, width]) => width > 0 && width < 0.2),
    style.streaks.map(([, w]) => w.toFixed(3)).join(', '));
  // The case does NOT rotate with the rider — a reflection that swung round as
  // you turned would read as a glitch — so a streak is only in frame when the
  // rider happens to be facing it. Cluster them all at one azimuth and most of
  // a ride never sees one. Spread means: the widest gap between neighbours,
  // going round, is under 3 rad, so the ~1.8 rad horizontal field of view is
  // never far from one.
  const azimuths = style.streaks.map(([phi]) => ((Math.PI - phi) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2))
    .sort((a, b) => a - b);
  const gaps = azimuths.map((a, i) =>
    i === azimuths.length - 1 ? azimuths[0] + Math.PI * 2 - a : azimuths[i + 1] - a);
  check(
    'streaks are spread round the case (it never turns, so a cluster is invisible half the ride)',
    Math.max(...gaps) < 2.6,
    `azimuths ${azimuths.map((a) => a.toFixed(2)).join(', ')} — widest gap ${Math.max(...gaps).toFixed(2)} rad`,
  );

  const scene = new THREE.Scene();
  const kase = new AcrylicCase(scene, strategy, 'full');
  const shell = partOf(scene, 'shell');
  const rim = partOf(scene, 'rim');
  const lip = partOf(scene, 'lip');
  const streaks = partOf(scene, 'streaks');
  const film = partOf(scene, 'rainFilm');
  check('builds shell + rim + lip + streaks + rain film',
    !!shell && !!rim && !!lip && !!streaks && !!film);
  if (!shell || !rim || !lip || !streaks || !film) { kase.dispose(); return; }

  // Every part obeys the same four rules. `fog:false` is the one that silently
  // erases the whole thing: weather fog ends around 3 km and the case is at
  // 3.2 km, so a fogged case is a case painted entirely in fog colour.
  const parts = [shell, rim, lip, streaks, film];
  const mats = parts.map((p) => p.material as THREE.MeshBasicMaterial);
  check('every part is blended, unfogged, inside-out, and writes no depth',
    mats.every((m) => m.transparent && !m.fog && m.side === THREE.BackSide && !m.depthWrite));
  check('every part is drawn before the world and never frustum-culled',
    parts.every((p) => p.renderOrder < 0 && !p.frustumCulled));
  // All five are centred on the rider, so three's transparent sort compares
  // identical distances and picks an order by coin toss. Explicit, outermost
  // first: the water is on the OUTSIDE of the case.
  check('draw order is explicit and runs outermost → innermost',
    film.renderOrder < shell.renderOrder
    && shell.renderOrder < rim.renderOrder
    && rim.renderOrder < lip.renderOrder
    && lip.renderOrder < streaks.renderOrder,
    `film ${film.renderOrder} shell ${shell.renderOrder} rim ${rim.renderOrder} `
    + `lip ${lip.renderOrder} streak ${streaks.renderOrder}`);

  // ── Where it sits ──
  // Measured against the real ring and the real disc rather than against a
  // number copied out of mountain-ring.ts, so moving either one fails here.
  const ringScene = new THREE.Scene();
  const ring = new MountainRing(ringScene, strategy, 4177, 500);
  ring.update(new THREE.Vector3(0, 0, 0));
  const farRing = ringScene.getObjectByName('mountainRing/far') as THREE.Mesh;
  const disc = ringScene.getObjectByName('mountainRing/disc') as THREE.Mesh;
  farRing.geometry.computeBoundingBox();
  disc.geometry.computeBoundingBox();
  const farRadius = Math.abs(farRing.geometry.boundingBox!.max.x);
  const discRadius = Math.abs(disc.geometry.boundingBox!.max.x);
  const skyScene = new THREE.Scene();
  const skyDome = new GradientSky(skyScene, strategy.skyPalette.gradient);
  const skyRadius = (skyDome.mesh.geometry as THREE.SphereGeometry).parameters.radius;
  check(
    'radius is outside the far mountains, on the desk, and under the sky',
    ACRYLIC_CASE_RADIUS > farRadius && ACRYLIC_CASE_RADIUS < discRadius && ACRYLIC_CASE_RADIUS < skyRadius,
    `case ${ACRYLIC_CASE_RADIUS} m (far ring ${farRadius}, desk ${discRadius}, sky ${skyRadius})`,
  );
  // The case has to stand ON the desk. The disc drop is private to
  // mountain-ring.ts, so read it back off the built disc instead of trusting
  // two copies of the same number to stay equal.
  check(
    'the case foot sits exactly on the desk surface',
    Math.abs(-disc.position.y - ACRYLIC_CASE_DESK_DROP) < 1e-6,
    `desk at y=${disc.position.y}, case foot at −${ACRYLIC_CASE_DESK_DROP}`,
  );
  // A short skirt is invisible in this world: the far ring's tallest silhouette
  // crosses the case at ~850 m seen from a 6 m eye. Both demos shipped that
  // mistake first. The crossing is derived from the BUILT ring rather than
  // written down, which is why rescaling the rings to the demo's angular sizes
  // (~520 m → ~850 m) moved this on its own instead of quietly invalidating it.
  const farRingTop = farRing.geometry.boundingBox!.max.y;
  const crossing = ACRYLIC_CASE_RADIUS * (farRingTop / farRadius);
  check(
    'the rim band reaches well above the mountains that hide its foot',
    ACRYLIC_RIM_HEIGHT > crossing * 1.5,
    `rim ${ACRYLIC_RIM_HEIGHT} m vs ridgeline crossing ≈${crossing.toFixed(0)} m`,
  );
  ring.dispose();
  skyDome.dispose();

  // ── The thickness cue is in the geometry, not in a texture ──
  // Vertex alpha (itemSize 4 → three's USE_COLOR_ALPHA). At itemSize 3 the
  // alpha column is silently ignored and the entire ramp disappears — in WebGL
  // only, where no probe rasterises it.
  const shellRamp = alphaRamp(shell);
  const rimRamp = alphaRamp(rim);
  check('shell + rim carry per-vertex ALPHA (itemSize 4, or three ignores it)',
    shellRamp.itemSize === 4 && rimRamp.itemSize === 4,
    `shell ${shellRamp.itemSize}, rim ${rimRamp.itemSize}`);
  check(
    'you look through more acrylic level-on than overhead (alpha rises toward the desk)',
    shellRamp.atBase > shellRamp.atTop && rimRamp.atBase > rimRamp.atTop,
    `shell ${shellRamp.atTop.toFixed(2)}→${shellRamp.atBase.toFixed(2)}, `
    + `rim ${rimRamp.atTop.toFixed(2)}→${rimRamp.atBase.toFixed(2)}`,
  );
  // A band of uniform alpha that stops at a fixed height draws a HORIZONTAL LINE
  // right round the sky. The rim and the rain film are both such bands; both
  // have to reach zero at the top. The film's version of this was caught in the
  // headless part map as a clean 100 m stripe above the rim.
  const filmRamp = alphaRamp(film);
  check('the rim and the rain film both fade to nothing at their top edge',
    rimRamp.atTop < 0.02 && filmRamp.atTop < 0.02,
    `rim ${rimRamp.atTop.toFixed(4)}, film ${filmRamp.atTop.toFixed(4)}`);

  // ── Streaks ──
  streaks.geometry.computeBoundingBox();
  const sb = streaks.geometry.boundingBox!;
  check('all streaks are ONE merged geometry (one draw call, however many there are)',
    streaks.geometry.getAttribute('position').count > 0
    && (streaks.material as THREE.Material) !== (shell.material as THREE.Material));
  // The rider's eye is ~6 m up, so the sky in frame is the first ~20° above the
  // horizon. A streak that stops at the crown is a streak nobody ever sees —
  // both demos shipped exactly that and had to run theta down to ~1.5.
  check(
    'streaks run down the side, not just across the crown',
    sb.min.y < ACRYLIC_CASE_RADIUS * 0.35,
    `lowest streak point y=${sb.min.y.toFixed(0)} m of a ${ACRYLIC_CASE_RADIUS} m case`,
  );
  check('streaks sit inside the shell, so the shell can never win in front of them',
    Math.max(Math.abs(sb.max.x), Math.abs(sb.min.x)) <= ACRYLIC_CASE_RADIUS);

  // ── Day → night → rain ──
  kase.setNight(0);
  const dayShell = mats[0].opacity;
  const dayShellColor = mats[0].color.getHex();
  const dayStreak = mats[3].opacity;
  kase.setNight(1);
  // The instinct is "night = solid glass". It is wrong twice: the case would
  // smother the lamps it is standing over, and a shell that gains opacity in
  // the dark reads as fog rather than acrylic.
  check('night makes the case MORE transparent, never less',
    mats[0].opacity <= dayShell + 1e-6 && mats[3].opacity <= dayStreak + 1e-6,
    `shell ${dayShell.toFixed(3)}→${mats[0].opacity.toFixed(3)}, `
    + `streak ${dayStreak.toFixed(3)}→${mats[3].opacity.toFixed(3)}`);
  check('night re-tints it (a white case at night is a glowing ring on the horizon)',
    mats[0].color.getHex() !== dayShellColor);

  kase.setNight(0);
  const dryColor = mats[0].color.getHex();
  check('rain film is hidden in fair weather', !film.visible);
  kase.setRaining(true);
  check('rain beads the OUTSIDE of the case', film.visible);
  check('rain pulls the whole case a step colder', mats[0].color.getHex() !== dryColor);
  kase.setRaining(false);

  // ── Tier ceiling ──
  kase.setLevel('shell');
  check('medium keeps 罩壁 (shell + rim + streaks) and drops the lip',
    scene.getObjectByName('acrylicCase')!.visible && shell.visible && rim.visible
    && streaks.visible && !lip.visible);
  kase.setLevel('off');
  check('low turns the whole case off', !scene.getObjectByName('acrylicCase')!.visible);
  check('… and reports it, whatever the rider asked for', kase.getEffectiveLevel() === 'off');
  kase.setLevel('full');
  check('the case comes back when the governor raises the tier again',
    scene.getObjectByName('acrylicCase')!.visible && lip.visible);

  // ── Follows the rider ──
  kase.update(new THREE.Vector3(120, 40, -70), 0.016);
  const group = scene.getObjectByName('acrylicCase')!;
  check('the case rides with the rider, standing on the desk',
    group.position.x === 120 && group.position.z === -70
    && Math.abs(group.position.y - (40 - ACRYLIC_CASE_DESK_DROP)) < 1e-6,
    `y=${group.position.y}`);
  const filmTex = (film.material as THREE.MeshBasicMaterial).map!;
  const before = filmTex.offset.y;
  kase.update(new THREE.Vector3(120, 40, -70), 0.5);
  check('water only runs while it is raining', filmTex.offset.y === before);
  kase.setRaining(true);
  kase.update(new THREE.Vector3(120, 40, -70), 0.5);
  check('… and runs DOWN the case when it is', filmTex.offset.y > before);

  kase.dispose();
  check('the case disposes cleanly', scene.children.length === 0);
}

/**
 * The rider's switch is INTENT; the tier is a ceiling. Proven three ways: the
 * floor tier refuses both effects outright, the fps governor can walk a machine
 * down to that floor, and turning the switch off wins even at the top tier.
 */
function checkHeavyEffectGating(): void {
  console.log('\n[heavy effects — tier vs rider]');

  check('low refuses both, whatever the rider asked for',
    QUALITY_PRESETS.low.acrylicCase === 'off' && QUALITY_PRESETS.low.sceneBloom === 'off');
  check('medium takes 罩壁 + the cheap bloom chain',
    QUALITY_PRESETS.medium.acrylicCase === 'shell' && QUALITY_PRESETS.medium.sceneBloom === 'cheap');
  check('high takes the lot',
    QUALITY_PRESETS.high.acrylicCase === 'full' && QUALITY_PRESETS.high.sceneBloom === 'full');
  // Two different bloods. `bloomEnabled` is the CYCLING-GLASSES selective bloom
  // (BLOOM_LAYER + UnrealBloomPass); `sceneBloom` is the demos' whole-scene one.
  // Conflating them is the single most likely way this gets broken later.
  check('the glasses bloom flag and the scene bloom level are separate knobs',
    typeof QUALITY_PRESETS.medium.bloomEnabled === 'boolean'
    && typeof QUALITY_PRESETS.medium.sceneBloom === 'string');

  // The governor is the thing that has to be able to rescue a machine that
  // guessed too high. Two consecutive five-sample windows under 45 fps = one
  // tier down; do it twice and a 'high' machine is at the floor with both
  // effects off — without the rider touching anything.
  const seen: string[] = [];
  const gov = createQualityGovernor({
    initialTier: 'high',
    onTierChange: (tier) => seen.push(tier),
  });
  for (let i = 0; i < 40; i++) gov.pushFpsSample(12);
  check('the governor walks a struggling machine down to the floor',
    gov.getTier() === 'low' && seen.includes('medium') && seen.includes('low'),
    seen.join(' → ') || 'no change');
  check('… and the floor is where both effects are off',
    QUALITY_PRESETS[gov.getTier()].acrylicCase === 'off'
    && QUALITY_PRESETS[gov.getTier()].sceneBloom === 'off');
  gov.dispose();

  // Rider veto at the TOP tier: the case is simply never built.
  const off = createPlasticTerrainStyle();
  off.params.acrylicCaseEnabled = false;
  const scene = new THREE.Scene();
  const kase = new AcrylicCase(scene, off, 'full');
  check('the rider can refuse the case even on a machine that could afford it',
    kase.getEffectiveLevel() === 'off' && !kase.isActive());
  kase.dispose();
  check('a refused case builds nothing at all', scene.children.length === 0);
  off.dispose();
}

/**
 * The demos' SCENE bloom (`scene-bloom-pass.ts`) — not the glasses one.
 *
 * The port's whole risk is in one place: the demos hand-roll exposure → ACES →
 * sRGB in their composite because their three build has no `OutputPass`.
 * gameview HAS one, and this pass sits BEFORE it. Encoding here as well would
 * apply the curve twice, which looks enough like "the bloom is wrong" to send
 * somebody tuning the wrong number for a day.
 */
function checkSceneBloom(): void {
  console.log('\n[scene bloom]');

  const pass = new SceneBloomPass(1280, 720, { level: 'cheap' });
  check('it identifies as the scene bloom, not as a style pass', isSceneBloomPass(pass));
  check('starts switched off (frame one must not composite a black quad)', !pass.enabled);

  const frag = (pass.material as THREE.ShaderMaterial).fragmentShader;
  check(
    'the composite is additive and LINEAR — OutputPass still owns tone mapping + sRGB',
    frag.includes('uStrength') && !/ACES|0\.41666|12\.92/.test(frag),
  );
  const brightFrag = ((pass as unknown as { brightMat: THREE.ShaderMaterial }).brightMat).fragmentShader;
  // The bright pass thresholds LUMINANCE. Pure red scores 0.21, so "make the
  // tail light redder" can never make anything bloom — a documented demo trap.
  check('the bright pass thresholds luminance, not a channel',
    brightFrag.includes('0.2126') && brightFrag.includes('0.7152') && brightFrag.includes('0.0722'));

  pass.setStrength(0.5);
  check('strength turns it on', pass.enabled && pass.getEffectiveLevel() === 'cheap');
  pass.setStrength(0);
  check('daylight (strength 0) turns it back off — the composer then skips it whole',
    !pass.enabled && pass.getEffectiveLevel() === 'off');

  pass.setStrength(0.5);
  pass.setLevel('off');
  check('the tier can refuse it even at full strength',
    !pass.enabled && pass.getEffectiveLevel() === 'off');
  pass.setLevel('full');
  check('and hand it back when the tier rises', pass.enabled && pass.getEffectiveLevel() === 'full');
  pass.dispose();

  // Wiring: the toy world puts the bloom in its style-pass slot (it has no look
  // pass of its own); the corrugated world's slot is the paper pass, and
  // DEVPLAN gives that world no bloom at all — poster paint does not glow.
  const plastic = createPlasticTerrainStyle();
  const plasticPass = plastic.createPostPass(800, 600);
  check('the toy world installs the scene bloom', isSceneBloomPass(plasticPass));
  plasticPass?.dispose();
  plastic.params.sceneBloomEnabled = false;
  const refused = plastic.createPostPass(800, 600);
  check('the rider can refuse it, and then nothing is built', refused === null);
  plastic.dispose();

  const paper = createPaperTerrainStyle();
  check('the corrugated world declares no bloom', paper.params.sceneBloomEnabled === false);
  const paperPass = paper.createPostPass(800, 600);
  check('… and its style slot is the paper pass, not a bloom',
    paperPass !== null && !isSceneBloomPass(paperPass));
  paperPass?.dispose();
  paper.dispose();
}

/**
 * The rider's per-world switches, all the way through config and back.
 *
 * `world-options.ts` says the declared default MUST equal the strategy's own
 * default, because "value === default" is what decides a value is not persisted.
 * Get that wrong and the switch works until the rider restarts.
 */
function checkWorldOptionRoundTrip(): void {
  console.log('\n[world options — round trip]');

  for (const [world, style] of [['plastic', 'plastic'], ['cuphead', 'paper']] as const) {
    const defaults = defaultStyleParams(style) as unknown as Record<string, unknown>;
    const declared = worldOptionDefaults(world);
    // The THREE.JS options only. A `modes: ['phaser']` row (cuphead's 上色) is
    // honoured by `PhaserWorldOptions` in game/phaser/phaser-style-strategy.ts,
    // not by `StyleParams` — the same split `WorldOptionKey` makes at compile
    // time. Requiring a StyleParams field for a 2D-only switch would mean adding
    // a field nothing reads, which is the shape of lie this check exists to
    // catch, pointing the other way.
    const keys = worldOptionsFor(world, 'threejs').map((o) => o.key);
    check(`${world}: every declared option names a real StyleParams field`,
      keys.every((k) => k in defaults), keys.join(', '));
    check(`${world}: declared defaults equal the strategy's own`,
      keys.every((k) => declared[k] === defaults[k]),
      keys.filter((k) => declared[k] !== defaults[k]).join(', ') || 'all match');
  }

  check('the case is offered in both worlds',
    WORLD_OPTIONS.plastic.some((o) => o.key === 'acrylicCaseEnabled')
    && WORLD_OPTIONS.cuphead.some((o) => o.key === 'acrylicCaseEnabled'));
  check('the bloom is offered only where DEVPLAN puts it (toy world)',
    WORLD_OPTIONS.plastic.some((o) => o.key === 'sceneBloomEnabled')
    && !WORLD_OPTIONS.cuphead.some((o) => o.key === 'sceneBloomEnabled'));

  // Off → stored sparsely → read back → applied to a fresh strategy, which is
  // exactly the path `applyWorldOptions` walks at init and on a style switch.
  const stored = withWorldOption(undefined, 'plastic', 'acrylicCaseEnabled', false);
  check('turning the case off is persisted', stored.plastic?.acrylicCaseEnabled === false);
  check('… and nothing else is (defaults must stay tunable later)',
    Object.keys(stored.plastic ?? {}).length === 1);
  const resolved = resolveWorldOptions('plastic', stored);
  check('… and reads back off', resolved.acrylicCaseEnabled === false);
  check('… while the other world is untouched (options are per-world)',
    resolveWorldOptions('cuphead', stored).acrylicCaseEnabled === true);

  const strategy = createPlasticTerrainStyle();
  const params = strategy.params as unknown as Record<string, unknown>;
  for (const key of Object.keys(resolved)) params[key] = resolved[key];
  check('… and reaches the strategy the case reads its intent from',
    strategy.params.acrylicCaseEnabled === false);
  const scene = new THREE.Scene();
  const kase = new AcrylicCase(scene, strategy, 'full');
  check('… so the case is not built', !kase.isActive());
  kase.dispose();
  strategy.dispose();

  // Back to the default and the entry disappears entirely: putting every switch
  // where it started must leave config.json exactly as it was.
  const restored = withWorldOption(stored, 'plastic', 'acrylicCaseEnabled', true);
  check('putting it back leaves no trace in config', restored.plastic === undefined);
  check('sparse() agrees the defaults are not worth storing',
    Object.keys(sparseWorldOptions('plastic', worldOptionDefaults('plastic'))).length === 0);
}

// ── Ribbons lie ON the terrain, not inside it ──
//
// The bug this guards: the terrain is a staircase whose tread is the QUANTISED
// AVERAGE of a cell's corners, while roads used to quantise their own POINT
// sample — off by a whole step at a layer boundary, so the road sank into the
// tread. Build a real two-step terrain and check the ribbons ride it.
async function checkGroundRibbons(): Promise<void> {
  console.log('\n[ribbons hug the ground]');
  const strategy = createPlasticTerrainStyle();

  // A staircase: y=0 west of x=100, y=6 east of it (one plastic layer up).
  const step = (x0: number, x1: number, y: number): THREE.Mesh => {
    const g = new THREE.PlaneGeometry(x1 - x0, 400);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, y, 0);
    return new THREE.Mesh(g);
  };
  const terrain = new THREE.Group();
  terrain.add(step(-400, 100, 0));
  terrain.add(step(100, 400, 6));
  terrain.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  raycaster.near = 0;
  raycaster.far = 10000;
  const groundAt = (x: number, z: number): number | null => {
    raycaster.set(new THREE.Vector3(x, 5000, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(terrain, true);
    return hits.length > 0 ? hits[0].point.y : null;
  };

  // A line heading due east across the step. 111320 m per degree of longitude at
  // the equator-ish origin we use here, so 0.0018° ≈ 200 m.
  const eastward: [number, number][] = [[121, 25], [121.0018, 25]];
  const proj = { originLat: 25, originLon: 121, cosOrigin: Math.cos((25 * Math.PI) / 180) };

  const road = buildGroundRibbon(eastward, proj, groundAt, {
    halfWidth: 4,
    heightOffset: ROAD_HEIGHT_OFFSET,
    emitUv: true,
  })!;

  const pos = road.getAttribute('position');
  let onGround = 0;
  let below = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const g = groundAt(x, z);
    if (g === null) continue;
    if (Math.abs(y - (g + ROAD_HEIGHT_OFFSET)) < 1e-3) onGround++;
    if (y < g) below++;
  }
  check(
    'every road vertex sits exactly on the terrain + its offset',
    onGround === pos.count && below === 0,
    `${onGround}/${pos.count} on the surface, ${below} buried`,
  );

  // The step is 6 m — one sample per 8 m means the tread change is picked up
  // within a sample, instead of a 200 m chord slicing through it.
  const ys = new Set<number>();
  for (let i = 0; i < pos.count; i++) ys.add(Number(pos.getY(i).toFixed(2)));
  check(
    'the ribbon climbs the step instead of cutting through it',
    ys.has(ROAD_HEIGHT_OFFSET) && ys.has(6 + ROAD_HEIGHT_OFFSET) && ys.size === 2,
    `heights on the ribbon: ${[...ys].sort((a, b) => a - b).join(' / ')} m`,
  );

  // Resampling: vertices every ~8 m, not one per raw MVT point (which would be 2).
  check(
    'the centreline is resampled (not one vertex per sparse MVT point)',
    pos.count / 2 > 20,
    `${pos.count / 2} samples across ~200 m (raw line had 2 points)`,
  );

  // THE black-line bug. The stitch test is `prevKeptSample === i - 1`, and with
  // -1 as the "nothing yet" sentinel that is true at i === 0, so every ribbon
  // welded its first sample to vertices -2 and -1. setIndex() stores a plain
  // number array as Uint16 unless something reaches 65535, so those became
  // 65534 / 65535 — far past a buffer of a few thousand — and WebGL drew two
  // triangles from undefined memory. One stray pair per road, waterway and
  // runway in the world: the lines that "flew out of the mountain".
  const ridx = road.index!;
  let maxIndex = -1;
  for (let i = 0; i < ridx.count; i++) maxIndex = Math.max(maxIndex, ridx.getX(i));
  check(
    'no index reaches past the ribbon\'s own vertex buffer',
    maxIndex < pos.count,
    `highest index ${maxIndex}, buffer holds ${pos.count}`,
  );

  // A ribbon splits wherever the ground refuses a sample, and what survives can
  // be a two-quad remnant — not a road, just a dark rectangle lying in a field.
  // A whole road only ~12 m long is the same thing with none of the setup:
  // ground everywhere, nothing refused, and still under the minimum run.
  const stub: [number, number][] = [[121, 25], [121.00012, 25]]; // ~12 m
  const slit = buildGroundRibbon(stub, proj, () => 0, {
    halfWidth: 4,
    heightOffset: ROAD_HEIGHT_OFFSET,
  });
  check(
    'a fragment too short to read as a road is dropped, not left as litter',
    slit === null,
    slit === null ? 'null' : `${slit.getAttribute('position').count / 2} samples survived`,
  );
  slit?.dispose();

  // Water rides the same ground, so its gap under the road is exact everywhere.
  const water = buildGroundRibbon(eastward, proj, groundAt, {
    halfWidth: 3,
    heightOffset: WATERWAY_HEIGHT_OFFSET,
  })!;
  const wpos = water.getAttribute('position');
  let gapOk = 0;
  for (let i = 0; i < pos.count; i++) {
    const gap = pos.getY(i) - wpos.getY(i);
    if (Math.abs(gap - (ROAD_HEIGHT_OFFSET - WATERWAY_HEIGHT_OFFSET)) < 1e-3) gapOk++;
  }
  check(
    'water runs under the road by an exact, constant gap (it goes under bridges)',
    gapOk === pos.count,
    `${(ROAD_HEIGHT_OFFSET - WATERWAY_HEIGHT_OFFSET).toFixed(2)} m at all ${pos.count} vertices`,
  );

  // And the route line's mark ends up above the tarmac, not hovering over it.
  check(
    'the route mark lies just above the road surface',
    ROUTE_HEIGHT_OFFSET > ROAD_HEIGHT_OFFSET && ROUTE_HEIGHT_OFFSET - ROAD_HEIGHT_OFFSET < 0.3,
    `route ${ROUTE_HEIGHT_OFFSET} m vs road ${ROAD_HEIGHT_OFFSET} m`,
  );

  // No terrain (a chunk that has not streamed in) → NOTHING. The old signature
  // took a DEM-formula fallback and invented a height; that used a different
  // quantiser from the terrain's own cell average and laid whole-step cliffs
  // right at the corridor edge, so it was removed. This assertion used to check
  // for the fallback — it never ran, because the suite aborted upstream.
  const orphan = buildGroundRibbon(eastward, proj, () => null, {
    halfWidth: 4,
    heightOffset: ROAD_HEIGHT_OFFSET,
  });
  check(
    'where the terrain has not loaded, no ribbon is invented',
    orphan === null,
    orphan === null ? 'null' : `${orphan.getAttribute('position').count} vertices`,
  );

  road.dispose();
  water.dispose();
  orphan?.dispose();
  strategy.dispose();
}

// ── 走廊不可以疊在自己身上(地形取樣)──
//
// 地形走廊是一條**偏移緞帶**:每一個橫斷面都是路線位置沿自己的法向推 ±500 m。
// 偏移緞帶只在「路線的曲率半徑」以內是一對一的;超過那個距離,相鄰的橫斷面就
// 交叉,格子翻面,同一塊地被畫很多次而且高度各不相同。台北山頂那個 chunk 實測
// (`scripts/headless-check/clip-probe.ts`,真的 DEM + MVT):騎士腳下平均有 9.2
// 格,其中 43.1% 翻面,彼此差 35.6 m,格子的 xz 對角平均 218 m —— 名目 gridSize
// 是 32 m。騎士騎的是那疊面的**上緣**,所以不管階高調成多少都會穿模。
//
// 這一區釘住修法的三件事:斷面照**距離**擺、中軸遮罩把折疊切掉、而且切完之後
// 地面不會消失。
async function checkCorridorFold(): Promise<void> {
  console.log('\n[corridor does not lie on itself]');
  // 這一區自己要用的兩樣東西(第 3、7 段):走廊中線落在哪一(兩)欄,以及中軸
  // 測試的容差。就地取,不動檔頭那份共用的 import 清單。
  const { corridorCentreColumns } = await import('@/game/terrain/quantized-terrain');
  const { MEDIAL_SLACK, sampleChunkHeight } = await import('@/game/terrain/terrain-chunk');
  const originLat = 25.05;
  const originLon = 121.55;
  const cosO = Math.cos((originLat * Math.PI) / 180);
  const toLon = (x: number): number => originLon + x / (111320 * cosO);
  const toLat = (z: number): number => originLat - z / 111320;

  // ── 1. 斷面照距離擺,不是照點索引 ──
  //
  // 這條路線是直的,但點距一長一短(4 m / 20 m)—— 那正是「照時間錄下來」的
  // GPX 的樣子:爬坡 12 km/h 是 3.3 m 一點,下坡 45 km/h 是 12.5 m 一點。
  // 照索引均分的話,斷面的疏密會跟著當初騎多快跑。
  {
    const pts: { lat: number; lon: number; ele: number }[] = [];
    const cum: number[] = [];
    let d = 0;
    // 前半 100 點每 4 m(爬坡 12 km/h),後半每 20 m(下坡 72 km/h)。
    // ⚠ 不可以寫成「一長一短交替」:那樣的週期剛好是 24 m = gridSize,照索引
    //   擺出來的斷面**也**會是等距的,檢查就永遠通過(第一版就是這樣)。
    for (let i = 0; i < 200; i++) {
      pts.push({ lat: originLat, lon: toLon(d), ele: 0 });
      cum.push(d);
      d += i < 100 ? 4 : 20;
    }
    const strategy = createPlasticTerrainStyle();
    const chunk = await buildTerrainChunk(
      {
        points: pts, cumulativeDistances: cum,
        startIdx: 0, endIdx: pts.length - 1, chunkIndex: 0,
      },
      FLAT_SAMPLER, originLat, originLon, 0, strategy,
    );
    const g = chunk.heightGrid;
    let minSp = Infinity, maxSp = 0;
    for (let s = 1; s < g.along; s++) {
      const sp = Math.hypot(g.centerX[s] - g.centerX[s - 1], g.centerZ[s] - g.centerZ[s - 1]);
      if (sp < minSp) minSp = sp;
      if (sp > maxSp) maxSp = sp;
    }
    // 照索引擺的話這個比值是 5.0(20 / 4 的點距比);照距離擺是 1.0。
    check('斷面沿路線等距,不隨當初騎多快而疏密',
      maxSp / minSp < 1.02,
      `最疏 ${maxSp.toFixed(2)} m / 最密 ${minSp.toFixed(2)} m = ${(maxSp / minSp).toFixed(3)}×`);
    check('…而且那個間距就是 style 自己的 gridSize',
      Math.abs(maxSp - strategy.params.gridSize) < strategy.params.gridSize * 0.05,
      `${maxSp.toFixed(2)} m vs gridSize ${strategy.params.gridSize}`);
    chunk.mesh.geometry.dispose();
    strategy.dispose();
  }

  // ── 2. 直線路線:遮罩一格都不切 ──
  //
  // 這條是修法的安全性陳述:平的/直的場景**逐位元不變**,遮罩只在走廊真的折起來
  // 的地方咬人。沒有它,這個修法會悄悄改掉每一個場景。
  const straightGrid = (n: number, cross: number, half: number) => {
    const gx: number[] = [], gz: number[] = [];
    for (let s = 0; s < n; s++) {
      for (let c = 0; c < cross; c++) {
        gx.push(s * 30);
        gz.push(((c / (cross - 1)) * 2 - 1) * half);
      }
    }
    return { gx, gz };
  };
  {
    const N = 20, CROSS = 33, HALF = 500;
    const { gx, gz } = straightGrid(N, CROSS, HALF);
    const pts = Array.from({ length: N }, (_, s) => ({ lat: toLat(0), lon: toLon(s * 30), ele: 0 }));
    const cum = pts.map((_, s) => s * 30);
    const mask = buildMedialAxisMask(
      gx, gz, N, CROSS, HALF,
      sampleRouteForMask(pts, cum, 0, (N - 1) * 30, 8, originLat, originLon, cosO),
    );
    const kept = mask.reduce((a: number, b) => a + b, 0);
    check('直線走廊:遮罩一格都不切',
      kept === mask.length, `${kept} / ${mask.length} 格留下`);
  }

  // ── 3. 髮夾彎:折疊被切掉,而騎士自己那條車道一定留著 ──
  //
  // 半徑 60 m 的 180° 迴轉 —— 走廊半寬 500 m 是它的 8.3 倍,所以中軸以外的部分
  // 全是重複的地。切之前每一個路線點腳下疊了好幾格;切完之後路面底下只剩**自己
  // 那一格**(欄數是偶數,路在正中央那一格裡,不再壓在兩格的共用邊上 —— 見第 7 段)。
  {
    const CROSS = 32, HALF = 500, R = 60;
    // 直線進場 → 半圓 → 直線出場,每 30 m 一個斷面。
    const centre: { x: number; z: number }[] = [];
    for (let i = 10; i > 0; i--) centre.push({ x: -R, z: i * 30 });
    const steps = Math.max(2, Math.round((Math.PI * R) / 30));
    for (let i = 0; i <= steps; i++) {
      const a = Math.PI - (i / steps) * Math.PI;
      centre.push({ x: R * Math.cos(a), z: -R * Math.sin(a) });
    }
    for (let i = 1; i <= 10; i++) centre.push({ x: R, z: i * 30 });
    const N = centre.length;
    // 每個斷面的法向 = 相鄰兩點的切線轉 90°。
    const gx: number[] = [], gz: number[] = [];
    for (let s = 0; s < N; s++) {
      const p0 = centre[Math.max(0, s - 1)], p1 = centre[Math.min(N - 1, s + 1)];
      let tx = p1.x - p0.x, tz = p1.z - p0.z;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      for (let c = 0; c < CROSS; c++) {
        const off = ((c / (CROSS - 1)) * 2 - 1) * HALF;
        gx.push(centre[s].x + (-tz) * off);
        gz.push(centre[s].z + tx * off);
      }
    }
    const pts = centre.map((p) => ({ lat: toLat(p.z), lon: toLon(p.x), ele: 0 }));
    const cum: number[] = [0];
    for (let i = 1; i < N; i++) {
      cum.push(cum[i - 1] + Math.hypot(centre[i].x - centre[i - 1].x, centre[i].z - centre[i - 1].z));
    }
    const mask = buildMedialAxisMask(
      gx, gz, N, CROSS, HALF,
      sampleRouteForMask(pts, cum, 0, cum[N - 1], 8, originLat, originLon, cosO),
    );
    const cellsA = N - 1, cellsC = CROSS - 1;
    const cut = mask.length - mask.reduce((a: number, b) => a + b, 0);
    check('髮夾彎:遮罩真的切掉東西(不是永遠回 all-1 的空檢查)',
      cut > mask.length * 0.3,
      `${cut} / ${mask.length} 格被切 (${((100 * cut) / mask.length).toFixed(0)}%)`);

    // 「騎士的車道永遠切不掉」—— 欄數改成偶數之後**重新表述過**的那條保證。
    //
    // 舊的說法是「中心欄的 offset 是 0,沒有東西可以比自己更近」。偶數欄之後
    // 沒有任何一欄壓在路上:中線夾在 `corridorCentreColumns` 那兩欄之間,它們的
    // |offset| 是**半格**(這裡 500/31 = 16.1 m),所以那句話不再成立,保證改成
    // 直接宣告(`buildMedialAxisMask` 裡那個 `c === laneL || c === laneR`)。
    //
    // ⚠ 恆真句在這條上面已經發生過一次(第一版寫在 R = 60 上:圓弧的法向偏移在
    //   t < R 時是等距的,所以那些頂點本來就切不掉)。判準是**半徑要小於半格**:
    //   R = 10 m < 16.1 m,車道欄的頂點會落到曲率中心的另一側,對面那條腿因此
    //   比自己那一段還近。下面第一條斷言量的就是「這個 fixture 真的咬得到」——
    //   它是 0 的話,第二條就什麼都沒證明。真實山路的髮夾彎是 10–20 m 半徑。
    {
      const TR = 10, STEP = 5, TCROSS = 32, THALF = 500;
      const cen: { x: number; z: number }[] = [];
      for (let i = 8; i > 0; i--) cen.push({ x: -TR, z: i * STEP });
      const ts = Math.max(2, Math.round((Math.PI * TR) / STEP));
      for (let i = 0; i <= ts; i++) {
        const ang = Math.PI - (i / ts) * Math.PI;
        cen.push({ x: TR * Math.cos(ang), z: -TR * Math.sin(ang) });
      }
      for (let i = 1; i <= 8; i++) cen.push({ x: TR, z: i * STEP });
      const TN = cen.length;
      const tgx: number[] = [], tgz: number[] = [];
      for (let s2 = 0; s2 < TN; s2++) {
        const p0 = cen[Math.max(0, s2 - 1)], p1 = cen[Math.min(TN - 1, s2 + 1)];
        let tx = p1.x - p0.x, tz = p1.z - p0.z;
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        for (let c = 0; c < TCROSS; c++) {
          const off = ((c / (TCROSS - 1)) * 2 - 1) * THALF;
          tgx.push(cen[s2].x + (-tz) * off);
          tgz.push(cen[s2].z + tx * off);
        }
      }
      const tpts = cen.map((p) => ({ lat: toLat(p.z), lon: toLon(p.x), ele: 0 }));
      const tcum: number[] = [0];
      for (let i = 1; i < TN; i++) {
        tcum.push(tcum[i - 1] + Math.hypot(cen[i].x - cen[i - 1].x, cen[i].z - cen[i - 1].z));
      }
      const troute = sampleRouteForMask(
        tpts, tcum, 0, tcum[TN - 1], 2, originLat, originLon, cosO,
      );
      const tmask = buildMedialAxisMask(tgx, tgz, TN, TCROSS, THALF, troute);
      const [tLaneL, tLaneR] = corridorCentreColumns(TCROSS);
      // 這個 fixture 咬不咬得到:純中軸測試(**沒有**宣告)會不會判車道欄出局。
      let atRisk = 0;
      for (let s2 = 0; s2 < TN; s2++) {
        for (const c of [tLaneL, tLaneR]) {
          const off = Math.abs(((c / (TCROSS - 1)) * 2 - 1) * THALF);
          const lim2 = (off * (1 - MEDIAL_SLACK)) ** 2;
          const i = s2 * TCROSS + c;
          for (let k = 0; k < troute.d.length; k++) {
            const dx = troute.x[k] - tgx[i], dz = troute.z[k] - tgz[i];
            if (dx * dx + dz * dz < lim2) { atRisk++; break; }
          }
        }
      }
      check('10 m 半徑的髮夾彎(比半格還窄):純中軸測試真的會判車道欄出局',
        atRisk > 0, `${atRisk} / ${2 * TN} 個車道欄頂點`);
      const tCellsC = TCROSS - 1;
      let laneKept = 0, laneTotal = 0;
      for (let a = 0; a < TN - 1; a++) {
        // 路自己那一格(tLaneL)以及左右各一格 —— 兩條長邊都被宣告成自己的,
        // 所以角落閉包讓這三格全部活著。
        for (const c of [tLaneL - 1, tLaneL, tLaneR]) {
          if (c < 0 || c >= tCellsC) continue;
          laneTotal++; laneKept += tmask[a * tCellsC + c];
        }
      }
      check('…而宣告過的車道(自己那一格 + 左右各一格)一格都不會被切',
        laneKept === laneTotal, `${laneKept} / ${laneTotal}`);
    }

    // 「同一個世界座標只有一個地面」:沿路線量疊了幾層。
    const covers = (x: number, z: number, only: Uint8Array | null): number => {
      let n = 0;
      for (let a = 0; a < cellsA; a++) {
        for (let c = 0; c < cellsC; c++) {
          if (only && only[a * cellsC + c] !== 1) continue;
          const qi = [a * CROSS + c, a * CROSS + c + 1,
            (a + 1) * CROSS + c + 1, (a + 1) * CROSS + c];
          let inside = false;
          for (let p = 0, q = 3; p < 4; q = p++) {
            const xp = gx[qi[p]], zp = gz[qi[p]];
            const xq = gx[qi[q]], zq = gz[qi[q]];
            if ((zp > z) !== (zq > z) && x < ((xq - xp) * (z - zp)) / (zq - zp) + xp) inside = !inside;
          }
          if (inside) n++;
        }
      }
      return n;
    };
    let beforeMax = 0, afterMax = 0;
    for (const p of centre) {
      beforeMax = Math.max(beforeMax, covers(p.x, p.z, null));
      afterMax = Math.max(afterMax, covers(p.x, p.z, mask));
    }
    check('切之前:路面底下疊了好幾格地面',
      beforeMax >= 3, `最多 ${beforeMax} 格`);
    check('切之後:路面底下只剩自己那一格',
      afterMax === 1, `最多 ${afterMax} 格(切前 ${beforeMax})`);

    // 而且不可以把地弄不見:每一格(含被切掉的)的格心都還要有人蓋。
    //
    // 安全網會把「沒有人蓋的地」還回去,但**有上限**(`RESURRECT_SPAN_CELLS`):
    // 只有一片好幾百公尺的板子蓋得到的地,那片板子本來就不是那塊地的形狀,把它
    // 放回來只會順便蓋住馬路(實測 4.6% → 7.6% 的穿模)。所以合約是分兩段的:
    // **路面附近一個破洞都不准有**,而外圈允許極少量。
    let uncovered = 0;
    let uncoveredNearRoad = 0;
    let nearestHole = Infinity;
    for (let a = 0; a < cellsA; a++) {
      for (let c = 0; c < cellsC; c++) {
        const qi = [a * CROSS + c, a * CROSS + c + 1,
          (a + 1) * CROSS + c + 1, (a + 1) * CROSS + c];
        let mx = 0, mz = 0;
        for (const i of qi) { mx += gx[i] / 4; mz += gz[i] / 4; }
        if (covers(mx, mz, mask) > 0) continue;
        uncovered++;
        const off = Math.abs((c + 0.5 - cellsC / 2) * ((2 * HALF) / cellsC));
        if (off < nearestHole) nearestHole = off;
        if (off <= 100) uncoveredNearRoad++;
      }
    }
    check('遮罩不會在路面附近弄出破洞(破洞比穿模更糟)',
      uncoveredNearRoad === 0,
      `${uncoveredNearRoad} 格;最近的破洞在離路中線 ${
        Number.isFinite(nearestHole) ? nearestHole.toFixed(0) : '—'} m`);
    check('…外圈剩下的破洞也只是零頭(安全網的上限換來的)',
      uncovered <= mask.length * 0.02,
      `${uncovered} / ${mask.length} 格 (${((100 * uncovered) / mask.length).toFixed(2)}%)`);
  }

  // ── 4. 被切掉的格子:沒有踏面、掛得出裙邊、而且地面查詢叫不出來 ──
  //
  // 遮罩只改幾何是不夠的:高度網格如果還回得出那一格,騎士就會站在一片沒有畫出來
  // 的地上(而 clip-probe 的「網格給的高度不在任何一片畫出來的面上」正是在量這個)。
  {
    const N = 8, CROSS = 9;
    const gxs: number[] = [], gzs: number[] = [], gele: number[] = [], gcol: number[] = [];
    for (let s = 0; s < N; s++) {
      for (let c = 0; c < CROSS; c++) {
        gxs.push(s * 30);
        gzs.push((c - (CROSS - 1) / 2) * 30);
        gele.push(c === 4 ? 40 : 0);   // 中間一欄高一階,保證有豎面
        gcol.push(1, 1, 1);
      }
    }
    const strategy = createPlasticTerrainStyle();
    const full = buildQuantizedCorridorGeometry(
      { gx: gxs, gz: gzs, gele, gcol, along: N, cross: CROSS }, strategy, 0,
    );
    const cellsC = CROSS - 1;
    const holed = new Uint8Array((N - 1) * cellsC).fill(1);
    const victim = 3 * cellsC + 3;
    holed[victim] = 0;
    const masked = buildQuantizedCorridorGeometry(
      { gx: gxs, gz: gzs, gele, gcol, along: N, cross: CROSS, cellMask: holed },
      strategy, 0,
    );
    const topsOf = (d: typeof full): number => d.topIndexCounts.reduce((a, b) => a + b, 0);
    check('切掉一格 → 剛好少一格的踏面(兩個三角形)',
      topsOf(full) - topsOf(masked) === 6,
      `${topsOf(full)} → ${topsOf(masked)} 個索引`);
    // 缺口的四邊都要有豎面,否則從側面看得到板子的背面。
    //
    // ⚠ 不能用「牆的索引數變多」來驗:被切掉的那一格自己也少畫了兩面牆,加加減減
    //   剛好抵銷(實測 678 → 678)。要問的是**那四條邊上到底有沒有牆**。
    const wallTopEdges = (d: typeof full): Set<string> => {
      const out = new Set<string>();
      const key = (x0: number, z0: number, x1: number, z1: number): string => {
        const a = `${x0.toFixed(2)},${z0.toFixed(2)}`;
        const b = `${x1.toFixed(2)},${z1.toFixed(2)}`;
        return a < b ? `${a}|${b}` : `${b}|${a}`;
      };
      // 頂點順序:踏面群組在前(每個索引一個頂點),之後每四個頂點是一面牆,
      // 前兩個是上緣(見 `addWall` 的 TL, TR, BR, BL)。
      for (let v = d.topIndexCount; v + 3 < d.positions.length / 3; v += 4) {
        out.add(key(
          d.positions[v * 3], d.positions[v * 3 + 2],
          d.positions[(v + 1) * 3], d.positions[(v + 1) * 3 + 2],
        ));
      }
      return out;
    };
    const edges = wallTopEdges(masked);
    const va = Math.floor(victim / cellsC), vc = victim % cellsC;
    const vi = (da: number, dc: number): number => (va + da) * CROSS + (vc + dc);
    const edgeKey = (i: number, j: number): string => {
      const a = `${gxs[i].toFixed(2)},${gzs[i].toFixed(2)}`;
      const b = `${gxs[j].toFixed(2)},${gzs[j].toFixed(2)}`;
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    };
    const sides: [string, string][] = [
      ['右', edgeKey(vi(0, 1), vi(1, 1))],
      ['左', edgeKey(vi(0, 0), vi(1, 0))],
      ['前', edgeKey(vi(1, 0), vi(1, 1))],
      ['後', edgeKey(vi(0, 0), vi(0, 1))],
    ];
    const missing = sides.filter(([, k]) => !edges.has(k)).map(([n]) => n);
    check('…而缺口的四邊都長出豎面,不會看到板子的背面',
      missing.length === 0, missing.length ? `少了 ${missing.join('/')} 邊` : '四邊都有');
    check('被切掉的那一格高度是 NaN',
      Number.isNaN(masked.cellY[victim]) && !Number.isNaN(full.cellY[victim]),
      `full ${full.cellY[victim].toFixed(1)} → masked ${masked.cellY[victim]}`);
    strategy.dispose();
  }

  // ── 5. 高度網格叫不出被切掉的格子 ──
  {
    const strategy = createPlasticTerrainStyle();
    const R = 60;
    const centre: { x: number; z: number }[] = [];
    for (let i = 6; i > 0; i--) centre.push({ x: -R, z: i * 30 });
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const a = Math.PI - (i / steps) * Math.PI;
      centre.push({ x: R * Math.cos(a), z: -R * Math.sin(a) });
    }
    for (let i = 1; i <= 6; i++) centre.push({ x: R, z: i * 30 });
    const pts = centre.map((p) => ({ lat: toLat(p.z), lon: toLon(p.x), ele: 0 }));
    const cum: number[] = [0];
    for (let i = 1; i < centre.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(centre[i].x - centre[i - 1].x, centre[i].z - centre[i - 1].z));
    }
    const chunk = await buildTerrainChunk(
      {
        points: pts, cumulativeDistances: cum,
        startIdx: 0, endIdx: pts.length - 1, chunkIndex: 0,
      },
      FLAT_SAMPLER, originLat, originLon, 0, strategy,
    );
    const grid = chunk.heightGrid;
    let nan = 0;
    for (let i = 0; i < grid.heights.length; i++) if (Number.isNaN(grid.heights[i])) nan++;
    check('髮夾彎 chunk:高度網格裡真的有被切掉的格子',
      nan > 0, `${nan} / ${grid.heights.length} 格是 NaN`);
    const indexed = new Set<number>(Array.from(grid.cellIndex!.items));
    let leaked = 0;
    for (const id of indexed) if (Number.isNaN(grid.heights[id])) leaked++;
    check('…而空間索引一格都沒收進去(地面查詢叫不出它)',
      leaked === 0, `索引裡有 ${indexed.size} 格,其中 NaN ${leaked} 格`);
    chunk.mesh.geometry.dispose();
    strategy.dispose();
  }

  // ── 6. 撞到裙邊就爬上踏面(使用者提的緩解,根因修完之後重量過還留著)──
  {
    const L = 4; // plastic 的階高
    check('往上一階:爬上去',
      climbOntoTreadFn(10, 14, L) === 14, `${climbOntoTreadFn(10, 14, L)}`);
    check('往上超過 1.5 階(那是上一個之字彎的路面,不是台階):不爬',
      climbOntoTreadFn(10, 10 + L * 1.5 + 0.01, L) === 10);
    check('剛好 1.5 階:還是爬(邊界在哪要釘死)',
      climbOntoTreadFn(10, 10 + L * 1.5, L) === 10 + L * 1.5);
    check('下坡:車頭在低的踏面上,車輪留在原階',
      climbOntoTreadFn(10, 6, L) === 10);
    // 車軸的高度是**相對原點**的,起點以下就是負的 —— 所以「查不到地面」絕對
    // 不可以退回 0,那會在山谷裡把騎士往上彈。
    check('地面查不到:留在原地,不是退回高度 0',
      climbOntoTreadFn(-5, null, L) === -5, `${climbOntoTreadFn(-5, null, L)}`);
    // ⚠ 這裡本來還有一條「階高不合法(滑桿歸零)就原樣回去」。**拿掉了,不是忘了**:
    //   `layerHeight = 0` 時那個三元式自己就會回 axleY(`x <= 0` 對正的落差恆假),
    //   `NaN` 也一樣(跟 NaN 比恆假)。所以那條斷言不管怎麼改 `!(layerHeight > 0)`
    //   都不會失敗 —— 一條沒有人看過它失敗的檢查不是檢查。守衛留著(型別上要它,
    //   而且它把意圖寫清楚),但不再假裝有東西在守。
    const n = noseProbePointFn(0, 0, 90);
    check('車頭那一點在前方 1.6 m,而且方位是羅盤角(90° = +x)',
      Math.abs(n.x - 1.6) < 1e-9 && Math.abs(n.z) < 1e-9,
      `(${n.x.toFixed(3)}, ${n.z.toFixed(3)})`);
    const n0 = noseProbePointFn(0, 0, 0);
    check('…0° = 北 = −z',
      Math.abs(n0.x) < 1e-9 && Math.abs(n0.z + 1.6) < 1e-9,
      `(${n0.x.toFixed(3)}, ${n0.z.toFixed(3)})`);
  }

  // ── 7. 路走在**一格的正中央**,不是壓在兩格的共用邊上 ──
  //
  // 欄數以前被強制成**奇數**(原註解:「keep a center column for the GPX blend」),
  // 於是一條格線正好壓在路上:騎士的左半邊與右半邊各站在一格上,而那兩格的踏面
  // 各是「路 ± 半格橫坡」的平均。那個 blend 早就拿掉了,理由跟著沒了。
  //
  // 改成偶數欄(= 奇數格)之後,正中央那一格的軸線就是路,踏面是四個角的平均,
  // 橫坡在格內**相消**而不是被切成一道落差。實測(`clip-probe.ts`,真的 DEM +
  // MVT,下坡 45 km/h;右欄那台車**只有寬度**,車軸左右各 0.5 m,所以沿路的台階
  // 不算在內):
  //
  //                    路左右各 3 m 的落差      1 m 寬的車插進地表
  //     台北山頂         2.52 → 1.43 m          1.23 % → 0.24 %
  //     Alpe d'Huez      7.18 → 0.51 m         50.90 % → 0.04 %
  //     Amalfi SS163    21.97 → 0.10 m         26.15 % → 0.07 %
  //
  // (以上是 paper;另外兩個世界同量級,見那一輪的報告。)
  {
    // 7a. 中線落在哪:偶數欄夾在兩欄**之間**,奇數欄壓在**一欄**上。
    const pair = (n: number) => corridorCentreColumns(n).join(',');
    check('走廊中線:偶數欄夾在兩欄之間,奇數欄壓在一欄上',
      pair(32) === '15,16' && pair(44) === '21,22' && pair(6) === '2,3'
      && pair(33) === '16,16' && pair(5) === '2,2',
      `32→[${pair(32)}] 44→[${pair(44)}] 6→[${pair(6)}] 33→[${pair(33)}] 5→[${pair(5)}]`);

    // 7b. 出貨的三個世界:欄數偶數、格數奇數,而且路兩側 3 m 的地面**同高**。
    //
    // 橫坡 40%(海崖等級,Amalfi 實測的車道落差是 22 m / 一格)。路線往東,每
    // 37 m 一個點 —— 刻意跟三個世界的 gridSize(24 / 28 / 32)都不成倍數,
    // 免得取樣週期跟格線對齊而讓斷言變成恆真句。
    const K = 0.4;
    const slopeSampler = {
      getElevationSync: (lat: number) => K * (-(lat - originLat) * 111320),
      async getElevation(lat: number) { return this.getElevationSync(lat); },
      async prefetchBounds() {},
    } as never;
    const straightRoute = (n: number, step: number) => ({
      pts: Array.from({ length: n }, (_, s) => ({ lat: toLat(0), lon: toLon(s * step), ele: 0 })),
      cum: Array.from({ length: n }, (_, s) => s * step),
    });
    for (const style of ['plastic', 'paper', 'circuit'] as const) {
      const strategy = await createTerrainStyleStrategy(style);
      const { pts, cum } = straightRoute(40, 37);
      const chunk = await buildTerrainChunk(
        { points: pts, cumulativeDistances: cum, startIdx: 0, endIdx: 39, chunkIndex: 0 },
        slopeSampler, originLat, originLon, 0, strategy,
      );
      const g = chunk.heightGrid;
      const cellsC = g.cross - 1;
      const [laneL, laneR] = corridorCentreColumns(g.cross);
      const cellW = (2 * g.halfWidth) / cellsC;
      check(`${style}: 橫向格數是奇數,所以有一格在正中央`,
        g.cross % 2 === 0 && cellsC % 2 === 1,
        `${g.cross} 欄 / ${cellsC} 格,格寬 ${cellW.toFixed(2)} m(gridSize ${strategy.params.gridSize})`);
      // 兩條長邊各離路半格,而且**沒有任何一欄壓在路上**(舊形狀正好相反)。
      const zl = g.gz![laneL], zr = g.gz![laneR];
      check(`${style}: 中線那一格的兩條長邊各離路半格,沒有格線壓在路上`,
        Math.abs(zl + cellW / 2) < 0.01 && Math.abs(zr - cellW / 2) < 0.01,
        `z = ${zl.toFixed(2)} / ${zr.toFixed(2)},半格 ${(cellW / 2).toFixed(2)} m`);
      // 斷面中心線 = 那兩欄的中點 = 路本身。
      let maxCentreOff = 0;
      for (let a = 0; a < g.along; a++) maxCentreOff = Math.max(maxCentreOff, Math.abs(g.centerZ[a]));
      check(`${style}: 斷面中心線取那兩欄的中點,而中點就是路`,
        maxCentreOff < 0.01, `最遠 ${maxCentreOff.toFixed(4)} m`);
      // 這一輪的驗收條件本身:路左右各 3 m 的地面同高。
      //
      // ⚠ 取樣點要落在斷面**之間**,不能落在斷面線上:`heightJitter`(積木 1.5 m)
      //   讓前後兩列的踏面不同高,而斷面線正好是它們的共用邊,`pickCell` 在邊上
      //   挑到哪一列是浮點數說了算 —— 第一版取 `centerX[a]`,量到的 1.017 m 是那
      //   個(沿路的)抖動,不是橫向落差。
      let maxLaneStep = 0;
      for (let a = 1; a < g.along - 2; a++) {
        const x = (g.centerX[a] + g.centerX[a + 1]) / 2;
        const hl = sampleChunkHeight(g, x, -3, 0);
        const hr = sampleChunkHeight(g, x, 3, 0);
        if (hl !== null && hr !== null) maxLaneStep = Math.max(maxLaneStep, Math.abs(hl - hr));
      }
      check(`${style}: 路左右各 3 m 的地面同高(橫坡 ${(K * 100).toFixed(0)}%)`,
        maxLaneStep < 1e-6, `最大落差 ${maxLaneStep.toFixed(3)} m`);
      // 量化的基準面是「腳下那條路」,而路就在那一格裡 → 它的階數恆為 0;
      // 而隔壁那兩格**不是** 0(否則上一條在平地上也會過)。
      let roadBandBad = 0;
      const neighbourBands = new Set<number>();
      for (let a = 0; a < g.along - 1; a++) {
        if (g.cellBand![a * cellsC + laneL] !== 0) roadBandBad++;
        neighbourBands.add(g.cellBand![a * cellsC + laneL - 1]);
        neighbourBands.add(g.cellBand![a * cellsC + laneR]);
      }
      check(`${style}: 騎士腳下那一格的階數恆為 0(基準面就是它自己)`,
        roadBandBad === 0, `${roadBandBad} / ${g.along - 1} 個斷面不合`);
      check(`${style}: …而左右鄰居**不是** 0(不然上一條在平地上也會過)`,
        [...neighbourBands].every((b) => b !== 0),
        `鄰居階數 {${[...neighbourBands].sort((a, b) => a - b).join(', ')}}`);
      // 基準面不可以是 `originEle`:floating origin 會隨騎乘 rebase,用它當基準的
      // 話已建好的 chunk 跟新建的 chunk 會分屬不同色階(`plan/DEMO_POC_GUIDE.md`
      // §3.1 記著這件事:分層的基準面「不能用 originEle,改用該橫斷面上的道路」)。
      const rebased = await buildTerrainChunk(
        { points: pts, cumulativeDistances: cum, startIdx: 0, endIdx: 39, chunkIndex: 0 },
        slopeSampler, originLat, originLon, 250, strategy,
      );
      let drifted = 0;
      for (let i = 0; i < g.cellBand!.length; i++) {
        if (g.cellBand![i] !== rebased.heightGrid.cellBand![i]) drifted++;
      }
      check(`${style}: originEle 移動 250 m,階數一格都不動(基準面不是原點)`,
        drifted === 0, `${drifted} / ${g.cellBand!.length} 格改階`);
      chunk.mesh.geometry.dispose();
      rebased.mesh.geometry.dispose();
      strategy.dispose();
    }

    // 7c. 對照組:同樣的橫坡餵一份**奇數欄**的走廊,路兩側那兩格差好幾階。
    //
    // 沒有這一條,7b 的「同高」可能只是因為橫坡不夠陡 —— 這裡先證明它夠陡。
    {
      const strategy = createPlasticTerrainStyle();
      const CROSS = 33, CELLW = 24, ALONG = 5;
      const gx: number[] = [], gz: number[] = [], gele: number[] = [], gcol: number[] = [];
      for (let a = 0; a < ALONG; a++) {
        for (let c = 0; c < CROSS; c++) {
          const off = (c - (CROSS - 1) / 2) * CELLW;
          gx.push(a * CELLW); gz.push(off); gele.push(off * K); gcol.push(1, 1, 1);
        }
      }
      const data = buildQuantizedCorridorGeometry(
        { gx, gz, gele, gcol, along: ALONG, cross: CROSS }, strategy, 0,
      );
      const [oL, oR] = corridorCentreColumns(CROSS);
      check('奇數欄的走廊:中線壓在一欄上(舊形狀)',
        oL === oR && oL === 16, `[${oL}, ${oR}]`);
      // 中心欄是格 oL-1 與 oL 的共用邊 —— 那兩格的階數差就是那道落差。
      let worst = 0;
      for (let a = 0; a < ALONG - 1; a++) {
        worst = Math.max(worst,
          Math.abs(data.cellBand[a * data.cellsC + oL - 1] - data.cellBand[a * data.cellsC + oL]));
      }
      check('…路兩側那兩格差了整整幾階(所以 7b 的橫坡確實夠陡)',
        worst >= 1,
        `差 ${worst} 階(格寬 ${CELLW} m × 橫坡 ${(K * 100).toFixed(0)}% = ${(CELLW * K).toFixed(1)} m,階高 ${strategy.params.layerHeight} m)`);
      strategy.dispose();
    }

    // 7d. 兩端的 clamp 也要保住奇偶 —— 夾在偶數上就等於把舊形狀偷偷放回來。
    {
      const strategy = createPlasticTerrainStyle();
      const saved = strategy.params.gridSize;
      const { pts, cum } = straightRoute(8, 29);
      const got: string[] = [];
      let bad = 0;
      for (const gs of [4, 400]) {
        (strategy.params as { gridSize: number }).gridSize = gs;
        const chunk = await buildTerrainChunk(
          { points: pts, cumulativeDistances: cum, startIdx: 0, endIdx: 7, chunkIndex: 0 },
          FLAT_SAMPLER, originLat, originLon, 0, strategy,
        );
        const cross = chunk.heightGrid.cross;
        got.push(`gridSize ${gs} → ${cross} 欄 / ${cross - 1} 格`);
        if (cross % 2 !== 0) bad++;
        chunk.mesh.geometry.dispose();
      }
      (strategy.params as { gridSize: number }).gridSize = saved;
      check('gridSize 撞到上下限時,欄數還是偶數', bad === 0, got.join(';'));
      strategy.dispose();
    }
  }
}

// ── Waterways: rivers on the ground, culverts left underground ──
async function checkWaterways(): Promise<void> {
  console.log('\n[waterways]');
  const strategy = createPlasticTerrainStyle();

  // A flat-earth elevation sampler so the ribbon maths is the only variable.
  const sampler = { getElevation: async () => 0, getElevationSync: () => 0 } as any;

  const line = (coords: number[][], props: Record<string, unknown>) => ({
    layer: 'waterway',
    geometry: { type: 'LineString', coordinates: coords },
    properties: props,
  }) as any;

  const path = [[121, 25], [121.001, 25.001], [121.002, 25.0015]];

  // The renderers default `ground` to `() => null`, which draws NOTHING. These
  // blocks were written before that parameter existed and sat unrun behind an
  // aborting suite, so they quietly asserted against empty meshes.
  const flat = () => 0;

  const surface = await buildWaterwayMeshes(
    [
      line(path, { class: 'river' }),
      line(path, { class: 'stream' }),
    ],
    sampler, 25, 121, 0, strategy, flat,
  );
  check(
    'rivers and streams become ribbons on the ground',
    surface.waterwayCount === 2 && surface.mesh.geometry.getAttribute('position').count > 0,
    `${surface.waterwayCount} waterways, ${surface.mesh.geometry.getAttribute('position').count} verts`,
  );

  // A river is wider than a ditch. Run the line due EAST so the ribbon's width
  // is the z extent alone — measuring the diagonal path would just report its
  // length back at us.
  const eastward = [[121, 25], [121.002, 25]];
  const widthOf = async (cls: string) => {
    const r = await buildWaterwayMeshes(
      [line(eastward, { class: cls })], sampler, 25, 121, 0, strategy, flat,
    );
    const width = new THREE.Box3().setFromObject(r.mesh).getSize(new THREE.Vector3()).z;
    disposeWaterwayMesh(r);
    return width;
  };
  const riverW = await widthOf('river');
  const ditchW = await widthOf('ditch');
  check(
    'width scales with the waterway class (river 6 m, ditch 1.5 m)',
    Math.abs(riverW - 6) < 0.01 && Math.abs(ditchW - 1.5) < 0.01,
    `river ${riverW.toFixed(1)} m wide, ditch ${ditchW.toFixed(1)} m`,
  );

  // Culverts/tunnels carry water UNDER a road — drawing them lays a blue ribbon
  // across the tarmac. 145 such reaches on our routes, so this is not academic.
  const underground = await buildWaterwayMeshes(
    [
      line(path, { class: 'stream', brunnel: 'tunnel' }),
      line(path, { class: 'stream', brunnel: 'culvert' }),
    ],
    sampler, 25, 121, 0, strategy, flat,
  );
  check(
    'culverted / tunnelled reaches are skipped (no blue ribbon across the road)',
    underground.waterwayCount === 0,
    `${underground.waterwayCount} drawn`,
  );

  // Water must pass UNDER the road ribbon (roads sit at +0.3).
  const y = new THREE.Box3().setFromObject(surface.mesh).max.y;
  check(
    'water sits below the road surface (it goes under bridges, not over them)',
    y > 0 && y < 0.3,
    `${y.toFixed(2)} m vs road at 0.30 m`,
  );

  disposeWaterwayMesh(surface);
  disposeWaterwayMesh(underground);
  strategy.dispose();
}

// ── Aerodromes: paving + one toy aircraft ──
async function checkAeroways(name: string, strategy: TerrainStyleStrategy): Promise<void> {
  console.log(`\n[aeroways — ${name}]`);

  const GROUND = 40;
  const sampler = { getElevation: async () => GROUND, getElevationSync: () => GROUND } as any;
  const eastward = [[121, 25], [121.004, 25]];

  const feat = (geometry: any, props: Record<string, unknown>) => ({
    layer: 'aeroway', geometry, properties: props,
  }) as any;

  // See the note in checkWaterways: without a ground function the ribbon
  // builders draw nothing at all.
  const flat = () => strategy.quantizeElevation(GROUND);

  const widthOf = async (cls: string) => {
    const r = await buildAerowayMeshes(
      [feat({ type: 'LineString', coordinates: eastward }, { class: cls })],
      sampler, 25, 121, 0, strategy, flat,
    );
    const w = new THREE.Box3().setFromObject(r.mesh).getSize(new THREE.Vector3()).z;
    disposeAerowayMeshes(r);
    return w;
  };
  const runway = await widthOf('runway');
  const taxiway = await widthOf('taxiway');
  check(
    'runways are the widest thing on the map; taxiways are half that',
    Math.abs(runway - 30) < 0.01 && Math.abs(taxiway - 15) < 0.01,
    `runway ${runway.toFixed(0)} m, taxiway ${taxiway.toFixed(0)} m`,
  );

  // An aerodrome polygon → apron slab + exactly one parked aircraft.
  const field = feat(
    {
      type: 'Polygon',
      coordinates: [[[121, 25], [121.004, 25], [121.004, 25.003], [121, 25.003], [121, 25]]],
    },
    { class: 'aerodrome' },
  );
  const drome = await buildAerowayMeshes([field], sampler, 25, 121, 0, strategy, flat);
  check(
    'an aerodrome gets its apron paved and ONE aircraft parked on it',
    drome.planes.length === 1 && drome.mesh.geometry.getAttribute('position').count > 0,
    `${drome.planes.length} plane, ${drome.mesh.geometry.getAttribute('position').count} apron verts`,
  );

  const planeBox = new THREE.Box3().setFromObject(drome.planes[0]);
  // The terrain is QUANTISED into steps — the plane must stand on the step, the
  // way the roads and overlays do, not on the raw DEM height (which is inside it).
  const step = strategy.quantizeElevation(GROUND);
  check(
    'the aircraft stands on the quantised terrain step, like the roads do',
    Math.abs(drome.planes[0].position.y - step) < 0.01,
    `parked at y=${drome.planes[0].position.y.toFixed(1)} (step ${step.toFixed(1)}, raw DEM ${GROUND})`,
  );
  if (strategy.style === 'paper') {
    check(
      'paper: it is a plane-shaped BALLOON, floating above its tether',
      planeBox.max.y - drome.planes[0].position.y > 10,
      `balloon reaches ${(planeBox.max.y - drome.planes[0].position.y).toFixed(1)} m up`,
    );
  }

  // A taxiway alone must not conjure an aircraft out of nowhere.
  const taxiOnly = await buildAerowayMeshes(
    [feat({ type: 'LineString', coordinates: eastward }, { class: 'taxiway' })],
    sampler, 25, 121, 0, strategy, flat,
  );
  check('no aerodrome, no aircraft', taxiOnly.planes.length === 0);

  disposeAerowayMeshes(drome);
  disposeAerowayMeshes(taxiOnly);
  strategy.dispose();
}

/**
 * The zone decal, end to end: five district polygons in, ONE tinted mesh out.
 *
 * The material-level checks in `checkStyle` prove the style's intent. This one
 * proves the renderer honours it, because the two failures that matter are both
 * invisible from the material alone:
 *
 *  · SPLITTING. Five zones must not become five meshes. A decal is a
 *    screen-covering translucent layer, which is the category that made gameview
 *    7× more expensive per pixel than the demo (plan/migrate-demo-worlds.md §5,
 *    14 ground-covering objects stacked). Five meshes would be five transparent
 *    draw calls and five "screen-filling" bounding spheres for exactly the same
 *    covered pixels.
 *  · THE BLACK-PART TRAP. `vertexColors` lives on the MATERIAL, so a geometry
 *    that reaches it with no `color` attribute renders black — in WebGL only,
 *    where no headless probe rasterises it.
 */
/**
 * Baseplate studs vs the demo — plastic.
 *
 * Same discipline as `[zone bodies vs demo]`: the demo's own `makeStudGeo`,
 * `studInstances`, `zoneStudColor`, `studLevelFor`, `applyStudLod` and the
 * 「底板凸點」 IIFE are SLICED OUT OF THE HTML and EXECUTED, and the port is
 * diffed against what they produce. Nothing here is compared against a constant
 * typed into this file — a transcription only re-confirms whatever was typed.
 *
 * The one thing that cannot be diffed straight is WHERE the zones are: the demo
 * slices its route into 220–420 m districts by distance, gameview reads MVT
 * polygons. So the lattice is diffed against the demo with no zones at all
 * (which is the demo's own `zone ? … : C.baseGreen` branch), the COLOURS are
 * diffed against `zoneStudColor` directly, and the bucketing is then driven
 * through gameview's own zone lookup.
 */
function checkPlasticGroundStuds(): void {
  console.log('\n[baseplate studs vs demo — plastic (toy blocks)]');
  const strategy = createPlasticTerrainStyle();
  const style = strategy.groundStuds;
  check('strategy declares groundStuds', !!style);
  if (!style) return;

  const src = readFileSync('plan/plastic-town-demo.html', 'utf8');
  const at = (needle: string, from = 0): number => {
    const i = src.indexOf(needle, from);
    if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const line = (needle: string): string => {
    const a = at(needle);
    return src.slice(a, src.indexOf('\n', a));
  };

  // ── Slice the demo ────────────────────────────────────────────────────────
  const paletteAt = at('const C = {');
  const paletteEnd = at('\n  };', paletteAt) + '\n  };'.length;
  const zoneColorAt = at('const ZONE_COLOR = {');
  const zoneColorEnd = at('\n  };', zoneColorAt) + '\n  };'.length;
  const cacheAt = at('const zoneStudCache = new Map();');
  const zscEnd = at('\n  }', cacheAt) + '\n  }'.length;
  const lodAt = at('const STUD_LOD =');
  const lodEndMark = 'const studGeo = studGeos[0];';
  const lodEnd = at(lodEndMark, lodAt) + lodEndMark.length;
  // studLevelFor is a ONE-LINER in the demo, so sliceDemoFn's `\n  }` terminator
  // would swallow applyStudLod with it.
  const slAt = at('function studLevelFor(rel)');
  const slEnd = src.indexOf('\n', slAt);
  // 底板凸點 IIFE — from its own comment to the `})();` that closes it.
  const iifeAt = at('// 底板凸點(');
  const iifeEnd = at('})();', iifeAt) + '})();'.length;
  check('demo still declares makeStudGeo / STUD_LOD / zoneStudColor / the 底板凸點 IIFE',
    lodAt > 0 && cacheAt > 0 && iifeAt > lodAt && iifeEnd > iifeAt);

  const demoSrc = [
    sliceDemoFn(src, 'makeStudGeo'),
    src.slice(lodAt, lodEnd),                 // STUD_LOD / studGeos / studGeo
    sliceDemoFn(src, 'studInstances'),
    src.slice(paletteAt, paletteEnd),         // C — the $plastic swatches
    src.slice(zoneColorAt, zoneColorEnd),     // ZONE_COLOR — the five districts
    src.slice(cacheAt, zscEnd),               // zoneStudCache + zoneStudColor
    src.slice(slAt, slEnd),                   // studLevelFor
    sliceDemoFn(src, 'applyStudLod'),
    line('const boardW = 130;'),
    line('const ZONE_DECAL_W = 38;'),
    line('const ZONE_DECAL_OFF = 29;'),
    // The lattice itself, wrapped so the check can call it per chunk span.
    // The lattice itself. `boardW` becomes a PARAMETER defaulting to the demo's
    // own const, so both sides can be driven to a board width where the cross
    // loop's `lat <= boardW/2 - 4` bound lands exactly on a stud — with the
    // demo's 130 it never does, and `<` would pass for `<=`.
    'const DEMO_BOARD_W = boardW;',
    'function studChunk(d0, d1, place, zoneAt, parks, occupied, group, boardW = DEMO_BOARD_W) {',
    src.slice(iifeAt, iifeEnd),
    '}',
    'return { makeStudGeo, STUD_LOD, studGeos, studInstances, zoneStudColor,'
      + ' studLevelFor, applyStudLod, studChunk, boardW, C, ZONE_COLOR };',
  ].join('\n');

  const toonShared = (color: string): THREE.Material => {
    const m = new THREE.MeshBasicMaterial();
    m.userData.recColor = color;
    return m;
  };
  // Math shim, not the global — three burns 4 draws per uuid (see checkPaperClouds).
  const demoMath = Object.create(Math) as Math;
  const demo = new Function('THREE', 'toonShared', 'Math', demoSrc)(
    THREE, toonShared, demoMath,
  ) as {
    makeStudGeo: (n: number) => THREE.BufferGeometry;
    STUD_LOD: number[];
    studGeos: THREE.BufferGeometry[];
    studInstances: (
      pts: number[][], r: number, h: number, m: string | THREE.Material,
    ) => THREE.InstancedMesh | null;
    zoneStudColor: (zone: string) => string;
    studLevelFor: (rel: number) => number;
    applyStudLod: (c: { lod: number; studLods: THREE.Mesh[] }, rel: number) => void;
    studChunk: (
      d0: number, d1: number,
      place: (d: number, lat: number) => { x: number; z: number },
      zoneAt: (d: number) => string | null,
      parks: { x: number; z: number; r: number }[],
      occupied: number[][],
      group: THREE.Group,
      boardW?: number,
    ) => void;
    boardW: number;
    C: Record<string, string>;
    ZONE_COLOR: Record<string, string>;
  };

  // ══ 1. The unit studs ══
  const ourGeos = style.lodGeometries();
  check('three LOD levels, like the demo\'s STUD_LOD',
    ourGeos.length === demo.STUD_LOD.length,
    `${ourGeos.length} vs demo ${demo.STUD_LOD.length} (${demo.STUD_LOD.join('/')})`);
  let worstGeo = 'identical';
  for (let i = 0; i < Math.min(ourGeos.length, demo.studGeos.length); i++) {
    const d = bufferDiff(demo.studGeos[i], ourGeos[i]);
    if (d !== 'identical') worstGeo = `level ${i}: ${d}`;
  }
  check('every LOD geometry IS the demo\'s makeStudGeo — vertices, normals, winding',
    worstGeo === 'identical', worstGeo);
  // …and the LOD is a geometry SWAP, so all three must be the same unit stud.
  check('all three levels are the same unit stud (radius 1, y ∈ [0,1]) — the whole '
    + 'point of the swap is that no instance matrix changes',
    ourGeos.every((g) => {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      return Math.abs(b.min.y) < 1e-9 && Math.abs(b.max.y - 1) < 1e-9
        && Math.abs(b.max.x - 1) < 1e-9 && Math.abs(b.min.x + 1) < 1e-9;
    }));
  check('shared and strategy-owned (a chunk dispose must not free them)',
    ourGeos.every((g) => g.userData.shared === true));

  // ══ 2. The colours ══
  const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
  const ZONES = ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const;
  let colorsOk = true;
  let colorsWhy = '';
  for (const z of ZONES) {
    const d = demo.zoneStudColor(z);
    const o = hex(style.colorFor(z));
    if (d !== o) { colorsOk = false; colorsWhy = `${z}: demo ${d} vs ours ${o}`; break; }
  }
  check('every zone\'s stud colour IS the demo\'s zoneStudColor', colorsOk,
    colorsWhy || ZONES.map((z) => `${z} ${demo.zoneStudColor(z)}`).join(' '));
  // …and it is the BLEND, not the raw district colour: 0.6 zone + 0.4 board.
  // The demo's own reason: 直接用原值的話凸點會比它腳下的板面濃一階,反而更跳。
  check('…the BLEND (0.6 zone + 0.4 board), never the raw district colour',
    ZONES.every((z) => hex(style.colorFor(z)) !== demo.ZONE_COLOR[z]),
    ZONES.map((z) => `${z} raw ${demo.ZONE_COLOR[z]} → ${hex(style.colorFor(z))}`).join('  '));
  // Prove the 0.4 by rebuilding it from the demo's OWN two endpoints.
  {
    let worst = 0;
    for (const z of ZONES) {
      const want = new THREE.Color(demo.ZONE_COLOR[z])
        .lerp(new THREE.Color(demo.C.baseGreen), 0.4);
      const got = new THREE.Color(style.colorFor(z));
      worst = Math.max(worst, Math.abs(want.r - got.r), Math.abs(want.g - got.g),
        Math.abs(want.b - got.b));
    }
    check('the mix really is 0.4 toward the board green, rebuilt from the demo\'s endpoints',
      worst < 1 / 255, `max channel diff ${(worst * 255).toFixed(2)}/255`);
  }
  check('five distinct stud colours — the districts do not collapse',
    new Set(ZONES.map((z) => style.colorFor(z))).size === 5);
  check('outside every zone the stud stays board green (demo: `zone ? … : C.baseGreen`)',
    hex(style.colorFor(null)) === demo.C.baseGreen,
    `${hex(style.colorFor(null))} vs demo ${demo.C.baseGreen}`);
  // The park colour is the demo's literal in the IIFE (公園的凸點 = 公園色).
  const parkQuoteAt = src.indexOf('\'', at('studInstances(parkPts, 1.5, 0.7,'));
  const demoParkHex = src.slice(parkQuoteAt + 1, src.indexOf('\'', parkQuoteAt + 1));
  check('park studs take the demo\'s park green', hex(style.colorFor('park')) === demoParkHex,
    `${hex(style.colorFor('park'))} vs demo ${demoParkHex}`);
  check('park green is none of the six others (a park is not a district)',
    !ZONES.some((z) => style.colorFor(z) === style.colorFor('park'))
      && style.colorFor('park') !== style.colorFor(null));
  check('the same colour gives the same material object — that is what buckets the studs',
    style.materialFor(style.colorFor('school')) === style.materialFor(style.colorFor('school'))
      && style.materialFor(style.colorFor('school')) !== style.materialFor(style.colorFor('hospital')));

  // ══ 3. The distance LOD ══
  {
    let lodOk = true;
    const rels = [-4, -2, -1, 0, 1, 2, 3, 9];
    const got: string[] = [];
    for (const rel of rels) {
      const d = demo.studLevelFor(rel), o = studLevelFor(rel);
      got.push(`${rel}→${o}`);
      if (d !== o) lodOk = false;
    }
    check('studLevelFor matches the demo on both sides of both thresholds', lodOk, got.join(' '));
    check('…and the chunk under the rider (and behind) is the FINEST level',
      studLevelFor(0) === 0 && studLevelFor(-1) === 0 && studLevelFor(1) !== 0);
  }
  {
    // applyStudLod: the swap, the no-op, and that the instance matrices survive.
    const im = new THREE.InstancedMesh(ourGeos[0], style.materialFor(0x123456), 2);
    const before = new THREE.Matrix4();
    im.setMatrixAt(0, before.makeTranslation(3, 4, 5));
    const res = { meshes: [im], studCount: 2, lodGeos: ourGeos, lod: -1 };
    applyStudLod(res, 2);
    const after = new THREE.Matrix4();
    im.getMatrixAt(0, after);
    check('applyStudLod repoints the geometry and leaves every instance matrix alone',
      im.geometry === ourGeos[2] && res.lod === 2 && mat4Diff(before, after) === 0);
    im.geometry = ourGeos[0];              // sabotage: a no-op call must NOT fix this
    applyStudLod(res, 2);
    check('…and re-applying the same level is a no-op (demo: `if (c.lod === lv) return`)',
      im.geometry === ourGeos[0]);
    applyStudLod(res, 0);
    check('…riding into the chunk pulls it back to level 0', im.geometry === ourGeos[0]
      && res.lod === 0);
  }

  // ══ 4. The lattice, diffed against the demo's own loop ══
  //
  // A dead-straight, dead-flat corridor running along −z with `right` = +x, so
  // the demo's `place(d, lat)` and gameview's (section, cross) parameterisation
  // describe the same points and any disagreement is the loop, not the maths.
  const ORIGIN_ELE = 100;
  const makeGrid = (seg: number, sections: number, halfWidth = 500, rise = 0) => ({
    quantized: false,
    along: sections,
    cross: 3,
    halfWidth,
    minX: -600, maxX: 600, minZ: -seg * sections - 600, maxZ: 600,
    centerX: new Float32Array(sections),
    centerZ: Float32Array.from({ length: sections }, (_, s) => -s * seg),
    rightX: Float32Array.from({ length: sections }, () => 1),
    rightZ: new Float32Array(sections),
    heights: Float32Array.from({ length: sections * 3 },
      (_, i) => ORIGIN_ELE + rise * Math.floor(i / 3)),
    _lastSection: 0,
  });
  const SEG = 25, SECTIONS = 9;             // 200 m of chunk, a whole number of STEPs
  const D1 = SEG * (SECTIONS - 1);
  const grid = makeGrid(SEG, SECTIONS);
  const input = {
    grid: grid as never, originLat: 25, originLon: 121, originEle: ORIGIN_ELE,
    zoneAt: () => null,
  };
  const place = (d: number, lat: number) => ({ x: lat, z: -d });

  /**
   * One demo-vs-port lattice diff. Run more than once on purpose:
   *
   *  · `SEG` a whole number of STEPs vs NOT. gameview's sections are `gridSize`
   *    (24 m) apart and STEP is 5, so `d` has to accumulate across the whole
   *    chunk the way the demo's single loop does. A port that restarted the
   *    lattice at each section passes the tidy case and puts a short row at
   *    every one of a 2 km chunk's 83 seams.
   *  · a board width whose edge lands EXACTLY on a stud vs the demo's 130, whose
   *    never does — without the first, `lat < lat1` passes for `lat <= lat1`.
   */
  const latticeDiff = (label: string, seg: number, sections: number, boardW?: number): void => {
    const g = makeGrid(seg, sections);
    const st = boardW === undefined
      ? strategy
      : { ...strategy, groundStuds: { ...style, halfWidth: boardW / 2 } };
    const demoGroup = new THREE.Group();
    demo.studChunk(0, seg * (sections - 1), place, () => null, [], [], demoGroup, boardW);
    const dStuds = demoGroup.children as THREE.InstancedMesh[];
    const port = buildGroundStuds(st, { ...input, grid: g as never });
    check(`${label}: one board-green bucket on both sides`,
      dStuds.length === 1 && !!port && port.meshes.length === 1 && dStuds[0].count > 0,
      `demo ${dStuds.length} bucket(s)/${dStuds[0]?.count ?? 0} studs, `
        + `port ${port?.meshes.length ?? 0}/${port?.studCount ?? 0}`);
    if (!port || dStuds.length !== 1) return;
    check(`${label}: exactly the demo's stud COUNT`,
      port.studCount === dStuds[0].count, `${port.studCount} vs demo ${dStuds[0].count}`);
    const da = new THREE.Matrix4(), db = new THREE.Matrix4();
    let worst = 0;
    for (let i = 0; i < Math.min(dStuds[0].count, port.meshes[0].count); i++) {
      dStuds[0].getMatrixAt(i, da);
      port.meshes[0].getMatrixAt(i, db);
      worst = Math.max(worst, mat4Diff(da, db));
    }
    check(`${label}: every stud is the demo's — position, radius 1.5, height 0.7, same order`,
      worst < 1e-4, `max matrix element diff ${worst.toExponential(2)}`);
  };
  latticeDiff('lattice, sections a whole number of steps', SEG, SECTIONS);
  latticeDiff('lattice, sections NOT a whole number of steps (gameview\'s 24 m)', 24, 10);
  // 22.5 puts the chunk's far end EXACTLY on a stud row (2.5 + 5k = 202.5), the
  // only configuration in which `d < end` and `d <= end` differ at all.
  latticeDiff('lattice, a chunk that ends exactly on a stud row', 22.5, 10);
  latticeDiff('lattice, a board whose edge lands exactly on a stud', SEG, SECTIONS, 128);

  const ours = buildGroundStuds(strategy, input);
  check('port: the board is one bucket when nothing is zoned', !!ours && ours.meshes.length === 1,
    `${ours?.meshes.length ?? 0} buckets, ${ours?.studCount ?? 0} studs`);
  if (ours) {
    // The road corridor and the board edge are the two branches the lattice has,
    // so read them back off the placed studs rather than trusting the loop.
    let minAbsLat = Infinity, maxAbsLat = -Infinity;
    const m = new THREE.Matrix4();
    for (let i = 0; i < ours.meshes[0].count; i++) {
      ours.meshes[0].getMatrixAt(i, m);
      const lat = Math.abs(m.elements[12]);
      minAbsLat = Math.min(minAbsLat, lat);
      maxAbsLat = Math.max(maxAbsLat, lat);
    }
    check('the road corridor is clear and the board stops at its inset edge — '
      + 'both read back off the studs, both the demo\'s numbers',
      minAbsLat >= style.corridorSkip && maxAbsLat <= demo.boardW / 2 - style.edgeInset + 1e-6
        && maxAbsLat > demo.boardW / 2 - style.edgeInset - style.pitch,
      `|lat| ∈ [${minAbsLat}, ${maxAbsLat}], demo board ${demo.boardW}`);
    check('a flat board puts every stud at y = 0, like the demo\'s',
      (() => {
        for (let i = 0; i < ours.meshes[0].count; i++) {
          ours.meshes[0].getMatrixAt(i, m);
          if (Math.abs(m.elements[13]) > 1e-6) return false;
        }
        return true;
      })());
    // …and the port's own studInstances is the demo's, on the same points.
    const pts: number[][] = [];
    for (let i = 0; i < ours.meshes[0].count; i++) {
      ours.meshes[0].getMatrixAt(i, m);
      pts.push([m.elements[12], m.elements[13], m.elements[14]]);
    }
    const dInst = demo.studInstances(pts, 1.5, 0.7, '#39e75f')!;
    const oInst = portStudInstances(pts, style.radius, style.height,
      style.materialFor(0), ourGeos[0])!;
    const da = new THREE.Matrix4(), db = new THREE.Matrix4();
    let instWorst = 0;
    for (let i = 0; i < pts.length; i++) {
      dInst.getMatrixAt(i, da);
      oInst.getMatrixAt(i, db);
      instWorst = Math.max(instWorst, mat4Diff(da, db));
    }
    check('studInstances writes the demo\'s matrices', instWorst < 1e-9,
      `max diff ${instWorst.toExponential(2)}`);
    check('…and tags the batch so the LOD sweep can find it (demo: userData.stud = 1)',
      oInst.userData.stud === 1 && ours.meshes.every((x) => x.userData.stud === 1));
    // A corridor NARROWER than the board: the lattice still asks for ±61, and
    // every point past the corridor edge has no ground to stand on. It must be
    // DROPPED, not planted at y = 0 in mid-air.
    const narrow = buildGroundStuds(strategy, {
      ...input, grid: makeGrid(SEG, SECTIONS, 30) as never,
    })!;
    let widest = 0;
    for (const mesh of narrow.meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        widest = Math.max(widest, Math.abs(m.elements[12]));
      }
    }
    check('a stud with no ground under it is dropped, not left floating at y = 0',
      widest <= 30 * 1.02 && narrow.studCount < ours.studCount && narrow.studCount > 0,
      `widest |lat| ${widest.toFixed(1)} m in a 30 m corridor, `
        + `${narrow.studCount} studs of ${ours.studCount}`);
  }

  // ══ 4b. …and on ground that is NOT flat ══
  //
  // The demo's board is a plane at y = 0, so a port that simply wrote 0 would
  // diff perfectly against it and then float every stud over the first hill.
  // gameview's ground is a DEM, so the stud has to come off the height grid.
  {
    const RISE = 10;   // metres gained per section
    const sloped = {
      ...grid,
      centerZ: Float32Array.from({ length: SECTIONS }, (_, s) => -s * SEG),
      rightX: Float32Array.from({ length: SECTIONS }, () => 1),
      heights: Float32Array.from({ length: SECTIONS * 3 },
        (_, i) => ORIGIN_ELE + RISE * Math.floor(i / 3)),
      _lastSection: 0,
    };
    const res = buildGroundStuds(strategy, { ...input, grid: sloped as never })!;
    const m = new THREE.Matrix4();
    let worst = 0;
    let lowest = Infinity, highest = -Infinity;
    for (const mesh of res.meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const y = m.elements[13], z = m.elements[14];
        worst = Math.max(worst, Math.abs(y - (RISE * (-z / SEG))));
        lowest = Math.min(lowest, y);
        highest = Math.max(highest, y);
      }
    }
    check('on sloping ground every stud takes the terrain\'s height, not 0',
      worst < 1e-3 && highest - lowest > RISE,
      `max error ${worst.toExponential(2)} m over a ${(highest - lowest).toFixed(0)} m climb`);
  }

  // ══ 4c. The edges of the contract ══
  {
    check('a style with no baseplate gets no studs (paper: a cutting mat has none)',
      !createPaperTerrainStyle().groundStuds
        && buildGroundStuds(createPaperTerrainStyle(), input) === null);
    // Ground entirely covered → no buckets → null, not an empty mesh nobody frees.
    const wall = new THREE.BufferGeometry();
    wall.setAttribute('position', new THREE.Float32BufferAttribute(
      [-500, 0, 500, 500, 0, 500, 500, 0, -900, -500, 0, 500, 500, 0, -900, -500, 0, -900], 3));
    check('a chunk with nowhere to put a stud returns null, not an empty batch',
      buildGroundStuds(strategy, { ...input, blockers: [new THREE.Mesh(wall)] }) === null);
    check('a degenerate corridor (one section) returns null',
      buildGroundStuds(strategy, {
        ...input,
        grid: { ...grid, along: 1, heights: new Float32Array(3) } as never,
      }) === null);
    // The demo's per-point [x,y,z,r,h] form — used for tree-top studs of mixed
    // size, and the reason `studInstances` takes points rather than a grid.
    const mixed = portStudInstances(
      [[1, 2, 3], [4, 5, 6, 0.25, 9]], 1.5, 0.7, style.materialFor(0), ourGeos[0])!;
    const dMixed = demo.studInstances([[1, 2, 3], [4, 5, 6, 0.25, 9]], 1.5, 0.7, '#fff')!;
    const a4 = new THREE.Matrix4(), b4 = new THREE.Matrix4();
    let mixWorst = 0;
    for (let i = 0; i < 2; i++) {
      dMixed.getMatrixAt(i, a4); mixed.getMatrixAt(i, b4);
      mixWorst = Math.max(mixWorst, mat4Diff(a4, b4));
    }
    check('points may carry their own size ([x,y,z,r,h]) — the demo\'s second form',
      mixWorst < 1e-9, `max diff ${mixWorst.toExponential(2)}`);
    // A style that declared fewer levels than the LOD asks for must clamp, not
    // hand the renderer `undefined`.
    const one = new THREE.InstancedMesh(ourGeos[0], style.materialFor(0), 1);
    applyStudLod({ meshes: [one], studCount: 1, lodGeos: [ourGeos[0]], lod: -1 }, 5);
    check('a short LOD table clamps instead of assigning an undefined geometry',
      one.geometry === ourGeos[0]);
  }

  // ══ 5. Zones and parks through gameview's own lookups ══
  //
  // The demo decides a district from route distance; gameview reads polygons.
  // So this half drives the port's real inputs and checks the BUCKETING — that
  // the colour of a stud follows the ground it is standing on.
  {
    // Half the board is a school, the other half is nothing at all.
    const zoned = buildGroundStuds(strategy, {
      ...input,
      zoneAt: (lon: number) => (lon > 121 ? 'school' : null),
    })!;
    const byColor = new Map<number, THREE.InstancedMesh>();
    for (const mesh of zoned.meshes) {
      byColor.set((mesh.material as THREE.MeshToonMaterial).color.getHex(), mesh);
    }
    check('a district splits the board into exactly two buckets, and they are the two colours',
      zoned.meshes.length === 2
        && byColor.has(style.colorFor('school')) && byColor.has(style.colorFor(null)),
      `${zoned.meshes.length} buckets: ${[...byColor.keys()].map(hex).join(' ')}`);
    // …and every stud is in the right one.
    let misplaced = 0;
    const m = new THREE.Matrix4();
    for (const [color, mesh] of byColor) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const inZone = m.elements[12] > 0;      // lon > 121 ⇔ x > 0
        if (inZone !== (color === style.colorFor('school'))) misplaced++;
      }
    }
    check('…every single stud took the colour of the ground it stands on', misplaced === 0,
      `${misplaced} studs in the wrong bucket`);
    check('the two halves add up to the unzoned board — a zone recolours studs, never removes them',
      zoned.studCount === ours!.studCount, `${zoned.studCount} vs ${ours!.studCount}`);
  }
  {
    // A park disc, and a pond of the same size, as REAL ground meshes — the
    // path the chunk manager uses. Park recolours; water blocks.
    const disc = (cx: number, cz: number, r: number): THREE.Mesh => {
      const pos: number[] = [], idx: number[] = [];
      pos.push(cx, 0, cz);
      const N = 48;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
        idx.push(0, 1 + i, 1 + ((i + 1) % N));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      return new THREE.Mesh(g);
    };
    const PARK = { x: 40, z: -100, r: 30 };
    const POND = { x: -40, z: -100, r: 30 };
    const res = buildGroundStuds(strategy, {
      ...input,
      parkMeshes: [disc(PARK.x, PARK.z, PARK.r)],
      blockers: [disc(POND.x, POND.z, POND.r)],
    })!;
    const m = new THREE.Matrix4();
    let parkIn = 0, parkOut = 0, pondIn = 0, total = 0;
    // One raster cell of slack at each boundary: the occupancy raster answers
    // per cell (one stud radius), so a stud straddling the rim may go either way.
    const SLACK = style.radius * 2;
    for (const mesh of res.meshes) {
      const isPark = (mesh.material as THREE.MeshToonMaterial).color.getHex()
        === style.colorFor('park');
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const x = m.elements[12], z = m.elements[14];
        total++;
        const dPark = Math.hypot(x - PARK.x, z - PARK.z);
        const dPond = Math.hypot(x - POND.x, z - POND.z);
        if (dPark < PARK.r - SLACK && isPark) parkIn++;
        if (dPark > PARK.r + SLACK && isPark) parkOut++;
        if (dPond < POND.r - SLACK) pondIn++;
      }
    }
    const wantPark = (() => {   // studs the lattice puts well inside the park
      let n = 0;
      for (const mesh of ours!.meshes) {
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          if (Math.hypot(m.elements[12] - PARK.x, m.elements[14] - PARK.z) < PARK.r - SLACK) n++;
        }
      }
      return n;
    })();
    check('every stud inside a park is park-green', parkIn === wantPark && wantPark > 0,
      `${parkIn} of ${wantPark}`);
    check('…and no stud outside one is', parkOut === 0, `${parkOut} strays`);
    check('a pond CLEARS its studs (demo: 道路走廊/物件/水面跳過)', pondIn === 0,
      `${pondIn} studs standing in water`);
    check('…and clears only its own footprint', total > 0 && total < ours!.studCount,
      `${total} studs left of ${ours!.studCount}`);
  }
  {
    // ONE long diagonal sliver — the shape whose bounding box is nothing like
    // itself. A river or a park polygon comes out of earcut looking exactly like
    // this, and a raster that stamps boxes takes the whole quadrant with it:
    // measured on the real Dazhi chunk, box-stamping cost 5 000 of chunk 2's
    // 8 800 studs to water and grass it was nowhere near.
    const AX = -60, AZ = -10, BX = 60, BZ = -190;    // ends of the band
    const dx = BX - AX, dz = BZ - AZ;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len * 8, nz = dx / len * 8;     // ±8 m of half-width
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      AX + nx, 0, AZ + nz, BX + nx, 0, BZ + nz, BX - nx, 0, BZ - nz,
      AX + nx, 0, AZ + nz, BX - nx, 0, BZ - nz, AX - nx, 0, AZ - nz,
    ], 3));
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const res = buildGroundStuds(strategy, { ...input, blockers: [new THREE.Mesh(g)] })!;
    const m = new THREE.Matrix4();
    let onBand = 0, inBoxOffBand = 0;
    for (const mesh of res.meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const x = m.elements[12], z = m.elements[14];
        const t = ((x - AX) * dx + (z - AZ) * dz) / (len * len);
        const px = AX + dx * t, pz = AZ + dz * t;
        const off = Math.hypot(x - px, z - pz);
        if (t > 0.05 && t < 0.95 && off < 4) onBand++;
        // Well inside the band's BOUNDING BOX and nowhere near the band itself.
        // A raster that stamped boxes would have taken every one of these.
        if (off > 20 && x > bb.min.x + 2 && x < bb.max.x - 2
          && z > bb.min.z + 2 && z < bb.max.z - 2) inBoxOffBand++;
      }
    }
    check('a diagonal band clears only what it covers, not its bounding box',
      onBand === 0 && inBoxOffBand > 0,
      `${onBand} studs on the band, ${inBoxOffBand} still standing inside its box`);
  }

  strategy.dispose();
}

async function checkZoneDecals(name: string, strategy: TerrainStyleStrategy): Promise<void> {
  console.log(`\n[zone decals — ${name}]`);

  const GROUND = 40;
  const sampler = { getElevation: async () => GROUND, getElevationSync: () => GROUND } as any;

  // Five 110 m squares in a row, one per zone, each a different landuse class.
  const square = (i: number) => {
    const lon = 121 + i * 0.002;
    return [[lon, 25], [lon + 0.001, 25], [lon + 0.001, 25.001], [lon, 25.001], [lon, 25]];
  };
  const CLASSES = ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const;
  const feats = CLASSES.map((cls, i) => ({
    layer: 'landuse',
    geometry: { type: 'Polygon', coordinates: [square(i)] },
    properties: { class: cls },
  })) as any;

  const res = await buildLanduseMeshes(feats, sampler, 25, 121, 0, strategy);
  const urban = res.layers.find((l) => l.kind === 'urban');
  // 幾層是**數出來的**,不是寫死的:`landuse-renderer` 的 specs 表一格產出一層
  // (即使這一次一個 feature 都沒有配到),所以「一格一層」才是這條斷言要講的
  // 話。上一版寫死 8,playground 這第九格一進來就壞了 —— 而那正是它該通過的
  // 情況:多了一格地被,不代表分區貼花多了一層。
  const LR_SRC = readFileSync('packages/web/src/game/terrain/landuse-renderer.ts', 'utf8');
  const specAt = LR_SRC.indexOf('  }[] = [');
  const specKinds = [...LR_SRC.slice(specAt, LR_SRC.indexOf('\n  ];', specAt))
    .matchAll(/^ {6}kind: '(\w+)',$/gm)].map((m) => m[1]);
  check(
    'zone decal: five districts arrive as ONE urban layer — no new ground-covering layer',
    specKinds.length > 0 && res.layers.length === specKinds.length
    && !!urban && urban.count === CLASSES.length,
    `${res.layers.length} layers vs ${specKinds.length} specs (${specKinds.join('/')}), `
    + `urban carries ${urban?.count ?? 0} polygons`,
  );

  const colorAttr = urban?.mesh.geometry?.getAttribute?.('color');
  check(
    'zone decal: every polygon is tinted (no colour attribute = every district renders BLACK in WebGL)',
    !!colorAttr && colorAttr.count === urban!.mesh.geometry.getAttribute('position').count,
    colorAttr ? `${colorAttr.count} tinted verts` : 'NO COLOR ATTRIBUTE',
  );

  // Distinct colours, and each one the colour the style asked for. Compared in
  // the working (linear) space the attribute is stored in — a getHex() round
  // trip can shift a channel by 1/255 and would make this flaky.
  const seen = new Map<string, [number, number, number]>();
  if (colorAttr) {
    for (let i = 0; i < colorAttr.count; i++) {
      const rgb: [number, number, number] = [colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i)];
      seen.set(rgb.map((v) => v.toFixed(4)).join(','), rgb);
    }
  }
  check(
    'zone decal: five DIFFERENT colours in the buffer (one dominant colour per chunk was the bug)',
    seen.size === CLASSES.length,
    `${seen.size} distinct tints`,
  );
  const expected = ZONE_KINDS.map((z) => new THREE.Color(strategy.zoneDecalColor(z)));
  const matched = [...seen.values()].every((rgb) => expected.some(
    (c) => Math.abs(c.r - rgb[0]) < 1e-3 && Math.abs(c.g - rgb[1]) < 1e-3 && Math.abs(c.b - rgb[2]) < 1e-3,
  ));
  check(
    'zone decal: each polygon carries the colour its own landuse class maps to',
    seen.size > 0 && matched,
  );

  disposeLanduseMeshes(res);
  strategy.dispose();
}

// ── Distant mountains vs the demos ──────────────────────────────────────────
//
// Same discipline as `[zone bodies vs demo]` and `[baseplate studs vs demo]`:
// `inkRidge()` and `blockMountainRing()` are SLICED OUT OF THE HTML with every
// helper they call, EXECUTED against a `Math` shim so the rng lines up, and the
// port is diffed triangle for triangle. Nothing here is compared against a
// number typed into this file.
//
// Read `mountain-ring.ts`'s header before changing any of this: the contour
// stack (`contourRing`) is the horizon the paper demo BUILT AND THEN DELETED,
// and it is still in the HTML as dead code. Diffing against it would reinstate
// the thing the demo wrote a paragraph to reject.

/** Triangles of a geometry, indexed or soup, as flat [x,y,z] triples. */
function trianglesOf(geo: THREE.BufferGeometry): number[][][] {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const v = (i: number): number[] => {
    const j = idx ? idx.getX(i) : i;
    return [pos.getX(j), pos.getY(j), pos.getZ(j)];
  };
  const out: number[][][] = [];
  for (let t = 0; t + 2 < n; t += 3) out.push([v(t), v(t + 1), v(t + 2)]);
  return out;
}

/**
 * Are two triangles the same, allowing only a CYCLIC rotation of their vertices?
 *
 * Rotation preserves orientation; a reversal does not. So this accepts the demo
 * writing `(A,B,C)` where the port's index buffer produces `(B,C,A)` — the same
 * face, wound the same way — and rejects `(C,B,A)`, which leaves every vertex
 * exactly where it was and turns the ring inside out. That distinction is the
 * entire reason this compares triangles rather than sorted vertex sets.
 */
function sameTriangle(a: number[][], b: number[][], eps: number): boolean {
  for (let r = 0; r < 3; r++) {
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(a[(r + k) % 3][c] - b[k][c]) > eps) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

/** First index where two triangle lists disagree, or ''. */
function diffTriangles(demo: number[][][], ours: number[][][], eps: number): string {
  if (demo.length !== ours.length) return `${ours.length} triangles vs demo ${demo.length}`;
  for (let t = 0; t < demo.length; t++) {
    if (!sameTriangle(demo[t], ours[t], eps)) {
      const f = (v: number[][]): string => v.map((p) => `(${p.map((n) => n.toFixed(2)).join(',')})`).join(' ');
      return `tri ${t}: demo ${f(demo[t])} vs ours ${f(ours[t])}`;
    }
  }
  return '';
}

/**
 * Fraction of a geometry's faces whose normal points at the ring's axis.
 *
 * > **騎手在環的裡面**,看到的是朝內那一面。[…] 反過來做整圈會被背面剔除掉。
 *
 * Computed from the WINDING (cross product of the triangle as the index buffer
 * orders it), not from the `normal` attribute — `computeVertexNormals` derives
 * that from the same winding, so reading it back would only ask the same
 * question twice. The centre is the ring's own axis, which is the local origin.
 */
function inwardFaceFraction(geo: THREE.BufferGeometry): number {
  const tris = trianglesOf(geo);
  let inward = 0;
  for (const [p0, p1, p2] of tris) {
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    // Inward radial at the face's centroid, xz only (the curtain is vertical).
    const cx = (p0[0] + p1[0] + p2[0]) / 3;
    const cz = (p0[2] + p1[2] + p2[2]) / 3;
    const len = Math.hypot(cx, cz);
    if (len < 1e-9) continue;
    if ((n[0] * -cx + n[2] * -cz) / len > 0) inward++;
  }
  return tris.length ? inward / tris.length : 0;
}

/** Every ring sub-mesh in a MountainRing's scene, by name. */
function ringMeshesByName(scene: THREE.Scene): Map<string, THREE.Mesh> {
  const out = new Map<string, THREE.Mesh>();
  for (const c of scene.children) {
    const m = c as THREE.Mesh;
    if (m.isMesh && m.name.startsWith('mountainRing/') && m.name !== 'mountainRing/disc') {
      out.set(m.name.slice('mountainRing/'.length), m);
    }
  }
  return out;
}

/**
 * Substitute a ring's SKIRT so the demo's geometry becomes comparable.
 *
 * The one deliberate deviation in the curtain: the demos drop their skirt 40 m
 * (paper) / 14 m (plastic) below the crest base, which is plenty over a flat
 * demo board. gameview's ring stands over real DEM with valleys hundreds of
 * metres deep, so `SKIRT_DROP` is 400. Everything above that line — which is
 * everything anyone can see — still has to match, so rather than skip those
 * vertices this rewrites the demo's skirt to ours and then demands equality.
 */
function substituteSkirt(
  geo: THREE.BufferGeometry, demoBase: number, ourBase: number, scale: number,
): THREE.BufferGeometry {
  const g = geo.clone();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, Math.abs(y - demoBase) < 1e-4 ? ourBase / scale : y);
  }
  pos.needsUpdate = true;
  g.scale(scale, scale, scale);
  // Positions moved, so the demo's own normals are stale. Recompute with the
  // demo's own function so both sides are normals-of-these-positions.
  g.computeVertexNormals();
  return g;
}

function checkPaperMountainsVsDemo(): void {
  console.log('\n[mountain ring vs demo — cuphead (ink ridge)]');
  const strategy = createPaperTerrainStyle();
  const src = readFileSync('plan/paper-town-demo.html', 'utf8');

  const at = (needle: string, from = 0): number => {
    const i = src.indexOf(needle, from);
    if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const line = (needle: string): string => {
    const a = at(needle);
    return src.slice(a, src.indexOf('\n', a));
  };

  // ── Slice: mulberry32 + inkRidge + the two call sites ──
  const farCallAt = at('const mountFar = inkRidge({');
  const nearCallEnd = at('});', at('const mountNear = inkRidge({')) + 3;
  check('demo still declares inkRidge + both call sites',
    src.indexOf('function inkRidge(') > 0 && nearCallEnd > farCallAt);

  const demoSrc = [
    sliceDemoFn(src, 'mulberry32'),
    sliceDemoFn(src, 'inkRidge'),
    line('const INK_FAR_WASH ='),
    line('const INK_NEAR_WASH ='),
    // Materials are irrelevant to the shape; the check reads colours from the
    // consts above, which are the demo's single source for them.
    'const washFarMat = {}, lineFarMat = {}, washNearMat = {}, lineNearMat = {};',
    // Capture the call sites' OPTIONS. base/amp/maxH/h1/h2/h3 are the shape and
    // must come from the demo; radius/segments/seed are the ring's placement,
    // which gameview owns, so the check re-drives inkRidge with its own.
    'const OPTS = [];',
    'const realInkRidge = inkRidge;',
    'inkRidge = function (o) { OPTS.push(o); return realInkRidge(o); };',
    src.slice(farCallAt, nearCallEnd),
    'return { inkRidge: realInkRidge, OPTS, INK_FAR_WASH, INK_FAR_LINE,'
      + ' INK_NEAR_WASH, INK_NEAR_LINE };',
  ].join('\n');

  // Math shim, not the global — three burns 4 draws per uuid (see checkPaperClouds).
  const demoMath = Object.create(Math) as Math;
  const demo = new Function('THREE', 'Math', demoSrc)(THREE, demoMath) as {
    inkRidge: (o: Record<string, unknown>) => { wash: THREE.Mesh; line: THREE.Mesh };
    OPTS: Record<string, number>[];
    INK_FAR_WASH: string; INK_FAR_LINE: string;
    INK_NEAR_WASH: string; INK_NEAR_LINE: string;
  };
  check('demo call sites captured (far, near)', demo.OPTS.length === 2,
    `${demo.OPTS.length} rings`);
  if (demo.OPTS.length !== 2) return;
  const demoOpts = { far: demo.OPTS[0], near: demo.OPTS[1] };

  // ── Ours ──
  const SEED = 12345;
  const scene = new THREE.Scene();
  const ring = new MountainRing(scene, strategy, SEED, 500);
  const meshes = ringMeshesByName(scene);
  check('both rings built wash + ridge line', meshes.size === 4,
    [...meshes.keys()].join(', '));

  // The ring's own constants, read off the built geometry rather than imported:
  // if the port's radius or height scale drifts, that has to show up here as a
  // mismatch, not be silently cancelled out by using the same constant on both
  // sides of the comparison.
  const radiusOf = (m: THREE.Mesh): number => {
    const p = m.geometry.getAttribute('position');
    return Math.hypot(p.getX(0), p.getZ(0));
  };
  const crestOf = (m: THREE.Mesh): number => {
    const p = m.geometry.getAttribute('position');
    let hi = -Infinity;
    for (let i = 0; i < p.count; i++) hi = Math.max(hi, p.getY(i));
    return hi;
  };

  for (const layer of ['far', 'near'] as const) {
    const o = demoOpts[layer];
    const wash = meshes.get(layer);
    const ink = meshes.get(`${layer}/ridgeLine`);
    check(`${layer}: wash + ridgeLine present`, !!wash && !!ink);
    if (!wash || !ink) continue;

    // Same ring, re-driven at OUR segment count and OUR per-layer seed. Radius
    // stays the demo's, so the comparison scale below is a pure uniform scale.
    const SEGMENTS = wash.geometry.getAttribute('position').count / 2 - 1;
    const built = demo.inkRidge({
      ...o,
      segments: SEGMENTS,
      seed: layer === 'far' ? SEED : SEED ^ 0x5f3759df,
    });

    const scale = radiusOf(wash) / (o.radius as number);
    check(`${layer}: our ring is the demo's, scaled uniformly — r ${radiusOf(wash).toFixed(0)} m `
      + `= demo ${o.radius} × ${scale.toFixed(4)}`, scale > 1);

    // 1. THE INK LINE. Every vertex of it derives from the crest, so this is the
    //    whole profile, the phase draw order, `lineH = maxH * 0.035` and the
    //    winding, compared with nothing substituted.
    const demoInk = built.line.geometry.clone();
    demoInk.scale(scale, scale, scale);
    const eps = radiusOf(wash) * 4e-6;   // float32 at kilometre magnitudes
    check(`${layer}: ridge ink line IS the demo's — every triangle, in order, same winding`,
      diffTriangles(trianglesOf(demoInk), trianglesOf(ink.geometry), eps) === '',
      diffTriangles(trianglesOf(demoInk), trianglesOf(ink.geometry), eps));

    // 2. THE WASH, with only the skirt substituted (see substituteSkirt).
    const demoWash = substituteSkirt(built.wash.geometry, -40, -400, scale);
    check(`${layer}: wash IS the demo's above the skirt — every triangle, same winding`,
      diffTriangles(trianglesOf(demoWash), trianglesOf(wash.geometry), eps) === '',
      diffTriangles(trianglesOf(demoWash), trianglesOf(wash.geometry), eps));

    // 3. RULE 1 — the rider is inside, so every face points at the axis.
    for (const [what, m] of [['wash', wash], ['ridge line', ink]] as const) {
      const f = inwardFaceFraction(m.geometry);
      check(`${layer}: every ${what} face points at the ring's axis (rider is INSIDE)`,
        f === 1, `${(f * 100).toFixed(1)}% inward`);
    }
    // …and the assertion is capable of failing. A ring wound the other way has
    // every vertex in exactly the same place; without this control the check
    // above could be reporting on nothing (see §10.5 — 永遠回報 clean 的檢查
    // 等於沒有檢查).
    const reversed = wash.geometry.clone();
    const ri = reversed.getIndex()!;
    for (let i = 0; i < ri.count; i += 3) {
      const a = ri.getX(i); ri.setX(i, ri.getX(i + 2)); ri.setX(i + 2, a);
    }
    check(`${layer}: …and a reversed index buffer is caught (0% inward)`,
      inwardFaceFraction(reversed) === 0,
      `${(inwardFaceFraction(reversed) * 100).toFixed(1)}% inward`);

    // 4. COLOURS — from the demo's own consts, both bands.
    const washHex = (wash.material as THREE.MeshBasicMaterial).color.getHexString();
    const inkHex = (ink.material as THREE.MeshBasicMaterial).color.getHexString();
    const dWash = (layer === 'far' ? demo.INK_FAR_WASH : demo.INK_NEAR_WASH).slice(1);
    const dInk = (layer === 'far' ? demo.INK_FAR_LINE : demo.INK_NEAR_LINE).slice(1);
    check(`${layer}: wash is the demo's ${dWash}`, washHex === dWash, washHex);
    check(`${layer}: ridge line is the demo's ${dInk}`, inkHex === dInk, inkHex);

    // 5. FOG OFF — 不吃霧. An ink wash already means "far"; hazing it a second
    //    time was leaving the far ring 82% sky colour, which is the whole reason
    //    the ridge line had nothing to be seen against.
    check(`${layer}: takes no fog (它已經是「遠」的表現手法本身)`,
      (wash.material as THREE.MeshBasicMaterial).fog === false
      && (ink.material as THREE.MeshBasicMaterial).fog === false);

    // 6. SEAM — integer harmonics or the profile does not close.
    //
    // The tolerance is 1e-9, not exact equality: `sin(0·h + φ)` and
    // `sin(2π·h + φ)` are the same number in maths and differ in the last bit or
    // two in doubles, which is orders of magnitude below float32's grip on a
    // 2.6 km ring. It is nowhere near loose enough to hide the failure it exists
    // for — one non-integer harmonic (5 → 5.5) opens the seam by
    // `2·amp·sin(φ)/maxH`, i.e. O(0.1), a hundred million times this bound.
    const prof = strategy.generateMountainProfile(layer, 4177, 160);
    check(`${layer}: profile closes (first === last) — integer harmonics`,
      Math.abs(prof[0] - prof[prof.length - 1]) < 1e-9,
      `${prof[0]} vs ${prof[prof.length - 1]}`);
    check(`${layer}: profile never goes negative and stays under the demo's ceiling`,
      Math.min(...prof) >= 0 && Math.max(...prof) <= 1.007,
      `${Math.min(...prof).toFixed(3)} … ${Math.max(...prof).toFixed(3)}`);
  }

  // 7. §3.6 — the far ring's angular size must EXCEED the near one's, or it is
  //    hidden behind it and its faces bought nothing. Read off the built rings.
  const nearAng = Math.atan(crestOf(meshes.get('near')!) / radiusOf(meshes.get('near')!));
  const farAng = Math.atan(crestOf(meshes.get('far')!) / radiusOf(meshes.get('far')!));
  check('§3.6: the FAR ring subtends more than the near one (or it hides behind it)',
    farAng > nearAng,
    `near ${(nearAng * 180 / Math.PI).toFixed(1)}° vs far ${(farAng * 180 / Math.PI).toFixed(1)}°`);
  // …and both are the demo's own angles — the reason the two rings were rescaled
  // at all. Computed by running the demo's ring at ITS radius with the SAME
  // per-layer seed ours used (the crest is a random draw, so a different seed
  // makes this comparison meaningless rather than strict).
  for (const layer of ['near', 'far'] as const) {
    const o = demoOpts[layer];
    const built = demo.inkRidge({
      ...o, segments: 160, seed: layer === 'far' ? SEED : SEED ^ 0x5f3759df,
    });
    const p = built.wash.geometry.getAttribute('position');
    let hi = -Infinity;
    for (let i = 0; i < p.count; i++) hi = Math.max(hi, p.getY(i));
    // Both sides measure the WASH's crest (one lineH below the true one), so the
    // ratio is the same quantity on both.
    const demoAng = Math.atan(hi / (o.radius as number));
    const ours = Math.atan(crestOf(meshes.get(layer)!) / radiusOf(meshes.get(layer)!));
    check(`${layer}: subtends the demo's angle (${(demoAng * 180 / Math.PI).toFixed(2)}°) within 0.01°`,
      Math.abs(ours - demoAng) < 0.01 * Math.PI / 180,
      `${(ours * 180 / Math.PI).toFixed(2)}°`);
  }

  ring.dispose();
  strategy.dispose();
}

function checkPlasticMountainsVsDemo(): void {
  console.log('\n[mountain ring vs demo — plastic (brick terraces)]');
  const strategy = createPlasticTerrainStyle();
  const src = readFileSync('plan/plastic-town-demo.html', 'utf8');
  const at = (needle: string): number => {
    const i = src.indexOf(needle);
    if (i < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
    return i;
  };
  const line = (needle: string): string => {
    const a = at(needle);
    return src.slice(a, src.indexOf('\n', a));
  };

  check('demo still declares blockMountainRing + both call sites',
    src.indexOf('function blockMountainRing(') > 0
    && src.indexOf('const mountFar = blockMountainRing(') > 0);

  const demoSrc = [
    sliceDemoFn(src, 'mulberry32'),
    sliceDemoFn(src, 'blockMountainRing'),
    // The call sites, captured for their colours and seeds. Radius/height are
    // the ring's placement and are overridden below with ours.
    'const CALLS = [];',
    'const realRing = blockMountainRing;',
    'blockMountainRing = function (...a) { CALLS.push(a); return realRing(...a); };',
    line('const mountFar = blockMountainRing('),
    line('const mountNear = blockMountainRing('),
    'return { blockMountainRing: realRing, CALLS };',
  ].join('\n');

  const demoMath = Object.create(Math) as Math;
  const toonShared = (color: string, opts: Record<string, unknown>): THREE.Material =>
    new THREE.MeshBasicMaterial({ color, side: opts?.side as THREE.Side });
  const demo = new Function('THREE', 'Math', 'toonShared', demoSrc)(
    THREE, demoMath, toonShared,
  ) as {
    blockMountainRing: (r: number, h: number, c: string, s: number) => THREE.Mesh;
    CALLS: [number, number, string, number][];
  };
  check('demo call sites captured (far, near)', demo.CALLS.length === 2);
  if (demo.CALLS.length !== 2) return;
  const demoCall = { far: demo.CALLS[0], near: demo.CALLS[1] };

  const SEED = 12345;
  const scene = new THREE.Scene();
  const ring = new MountainRing(scene, strategy, SEED, 500);
  const meshes = ringMeshesByName(scene);
  check('plastic draws NO ridge ink line — one strip per ring, like the demo',
    meshes.size === 2, [...meshes.keys()].join(', '));

  for (const layer of ['far', 'near'] as const) {
    const m = meshes.get(layer);
    check(`${layer}: ring present`, !!m);
    if (!m) continue;
    const pos = m.geometry.getAttribute('position');
    const radius = Math.hypot(pos.getX(0), pos.getZ(0));
    let crest = -Infinity;
    for (let i = 1; i < pos.count; i += 2) crest = Math.max(crest, pos.getY(i));

    // Drive the demo's own builder at OUR radius and OUR height scale with OUR
    // seed. `segs = 160` is hard-coded inside it and happens to be gameview's
    // SEGMENTS, so nothing has to be substituted except the skirt.
    const seed = layer === 'far' ? SEED : SEED ^ 0x5f3759df;
    // The height scale is not free to read off the ring (the profile's own peak
    // may be below 1.0), so derive it the way the port does: profile × maxHeight.
    const prof = strategy.generateMountainProfile(layer, seed, 160);
    const maxHeight = crest / Math.max(...prof);
    const built = demo.blockMountainRing(radius, maxHeight, demoCall[layer][2], seed);
    const demoGeo = substituteSkirt(built.geometry, -14, -400, 1);

    const d = bufferDiff(demoGeo, m.geometry);
    check(`${layer}: IS the demo's blockMountainRing — positions, normals, index (winding)`,
      d === 'identical', d);

    const f = inwardFaceFraction(m.geometry);
    check(`${layer}: every face points at the ring's axis (rider is INSIDE)`,
      f === 1, `${(f * 100).toFixed(1)}% inward`);

    const hex = (m.material as THREE.MeshBasicMaterial).color.getHexString();
    check(`${layer}: colour is the demo's ${demoCall[layer][2]}`,
      hex === demoCall[layer][2].slice(1), hex);
    // Plastic's rings ARE objects standing in the haze — the demo lights and
    // fogs them, and this world keeps the fog (see day-night-lighting).
    check(`${layer}: takes fog, like the demo's toonShared ring`,
      (m.material as THREE.MeshBasicMaterial).fog === true);

    // The quantisation is the shape: a stepped skyline needs the steps to be
    // flat runs, not a smooth curve that happens to be sampled. Counted against
    // the DEMO's own crest heights rather than a threshold typed in here — a
    // threshold would have to be picked, and picking it is the re-derivation.
    const round6 = (v: number): number => Math.round(v * 1e6);
    const demoPos = built.geometry.getAttribute('position');
    const demoLevels = new Set<number>();
    for (let i = 1; i < demoPos.count; i += 2) demoLevels.add(round6(demoPos.getY(i) / maxHeight));
    const levels = new Set(prof.map(round6));
    check(`${layer}: profile is QUANTISED to the demo's ${demoLevels.size} step heights, not continuous`,
      levels.size === demoLevels.size, `${levels.size} vs demo ${demoLevels.size} over ${prof.length} samples`);
  }

  ring.dispose();
  strategy.dispose();
}

/**
 * The ink-line branch, driven off BOTH of its conditions independently.
 *
 * `hasLine = ridgeLineColor !== null && lineH > 0` is exactly the shape the
 * checklist warns about: under the demos' own numbers the two conditions are
 * always equal (paper sets both, plastic sets neither), so every assertion
 * elsewhere in this file would pass just as happily if the `&&` were an `||`,
 * or if either half were deleted. These four cases are the only ones that pull
 * them apart.
 *
 * A zero-thickness band matters in its own right: it is 160 quads of no area —
 * invisible in every rasteriser, still submitted to the GPU, and impossible to
 * spot in a screenshot.
 */
function checkMountainRidgeLineBranch(): void {
  console.log('\n[mountain ridge line — the declaration branch]');
  const base = createPlasticTerrainStyle();
  const cases = [
    ['colour + thickness → a line', 0x884400, 0.035, 1],
    ['colour but ZERO thickness → no degenerate band', 0x884400, 0, 0],
    ['thickness but NO colour → no line', null, 0.035, 0],
    ['neither → no line', null, 0, 0],
  ] as const;
  for (const [label, ridgeLineColor, ridgeLineThickness, wantPerRing] of cases) {
    const scene = new THREE.Scene();
    const ring = new MountainRing(
      scene,
      { ...base, mountainRingFinish: () => ({ ridgeLineColor, ridgeLineThickness, fog: true }) },
      12345, 500,
    );
    const lines = [...ringMeshesByName(scene).keys()].filter((n) => n.endsWith('/ridgeLine'));
    check(`${label} — ${wantPerRing * 2} ink strip(s)`,
      lines.length === wantPerRing * 2, `${lines.length}: ${lines.join(', ') || 'none'}`);
    ring.dispose();
  }
  // A style that never declared the hook at all keeps exactly what every ring
  // had before it existed: one fogged wash, no band.
  const scene = new THREE.Scene();
  const ring = new MountainRing(
    scene, { ...base, mountainRingFinish: undefined }, 12345, 500,
  );
  const meshes = ringMeshesByName(scene);
  check('no hook declared → one fogged wash per ring, no band (unchanged behaviour)',
    meshes.size === 2
    && [...meshes.values()].every((m) => (m.material as THREE.MeshBasicMaterial).fog === true),
    [...meshes.keys()].join(', '));
  ring.dispose();
  base.dispose();
}

/**
 * The fog has to clear the far ring, or the geometry above is invisible and the
 * whole port bought nothing.
 *
 * > 霧的遠端要拉到遠山之外,不然兩圈…會整個被霧吃掉,只剩剪影 —— 那就白做了。
 *
 * The threshold is the tightest of the three demos' own fog/ring relationships,
 * read out of the demo files here rather than transcribed.
 */
function checkMountainFogClearance(): void {
  console.log('\n[mountain ring fog clearance vs demos]');

  const demoDepth = (file: string, ringRadius: number): number => {
    const src = readFileSync(file, 'utf8');
    const m = src.match(/scene\.fog = new THREE\.Fog\([^,]+,\s*([\d.]+),\s*([\d.]+)\)/);
    if (!m) throw new Error(`no scene.fog in ${file}`);
    return (ringRadius - Number(m[1])) / (Number(m[2]) - Number(m[1]));
  };
  // Ring radii from the demos' own call sites, not typed in.
  const plasticSrc = readFileSync('plan/plastic-town-demo.html', 'utf8');
  const plasticFar = Number(
    plasticSrc.match(/const mountFar = blockMountainRing\((\d+)/)![1],
  );
  const paperSrc = readFileSync('plan/paper-town-demo.html', 'utf8');
  const paperFar = Number(
    paperSrc.slice(paperSrc.indexOf('const mountFar = inkRidge({'))
      .match(/radius:\s*(\d+)/)![1],
  );
  const depths = [
    demoDepth('plan/plastic-town-demo.html', plasticFar),
    demoDepth('plan/paper-town-demo.html', paperFar),
  ];
  const deepest = Math.max(...depths);
  const shallowest = Math.min(...depths);
  check('demos put their far ring 45–65% into the haze',
    deepest > 0.4 && deepest < 0.7 && shallowest > 0.3,
    `${(shallowest * 100).toFixed(1)}% … ${(deepest * 100).toFixed(1)}%`);

  const palette = createPlasticTerrainStyle();
  for (const [when, elevation] of [['noon', 60], ['night', -20]] as const) {
    const l = computeDayNightLighting(
      { sunElevation: elevation } as CelestialState, 'sunny', palette.skyPalette,
    );
    const depth = (MOUNTAIN_FAR_RADIUS - l.fogNear) / (l.fogFar - l.fogNear);
    // BOTH ENDS, and the lower one is not decoration. A floor generous enough to
    // hit MAX_FOG_FAR satisfies every upper bound and every "terrain edge stays
    // buried" test while quietly stripping the haze off the entire world — the
    // ring would be visible for the same reason a scene with no fog is. The
    // demos never put their far ring in clear air either; the band is the claim.
    check(`clear ${when}: the far ring sits ${(depth * 100).toFixed(1)}% into the haze `
      + `— inside the demos' own ${(shallowest * 100).toFixed(0)}–${(deepest * 100).toFixed(0)}% band`,
      depth <= deepest + 1e-9 && depth >= shallowest - 1e-9,
      `fog ${l.fogNear.toFixed(0)}–${l.fogFar.toFixed(0)} m, ring ${MOUNTAIN_FAR_RADIUS} m`);
    check(`clear ${when}: fog far still buries the terrain's own edge (≤ ${CHUNK_LENGTH * CHUNKS_AHEAD} m)`,
      l.fogFar <= CHUNK_LENGTH * CHUNKS_AHEAD, `${l.fogFar.toFixed(0)} m`);
  }
  // Weather is still allowed to swallow the mountains whole — that is what
  // weather is for, and clamping it would be a bug, not a feature.
  const rain = computeDayNightLighting(
    { sunElevation: 60 } as CelestialState, 'rainy', palette.skyPalette,
  );
  check('rain still swallows the far ring (the floor is on the CLEAR base only)',
    rain.fogFar < MOUNTAIN_FAR_RADIUS, `fog far ${rain.fogFar.toFixed(0)} m`);
  palette.dispose();
}

// ══════════════════════════════════════════════════════════════════════════════
// Street lamps vs the demos — all three worlds
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Same discipline as `[zone bodies vs demo]` / `[baseplate studs vs demo]`: the
 * demo's OWN `bubbleLamp` / `hiliteLamp` / `ledLamp` are sliced out of the HTML
 * with every helper they call, EXECUTED, and diffed part for part. Nothing here
 * is compared against a constant typed into this file.
 *
 * ── Why WORLD-SPACE triangles and not `bufferDiff` ──────────────────────────
 *
 * The two sides legitimately store the same solid differently. The demos merge
 * with their hand-rolled `mergeGeos` (non-indexed, position+normal only), and
 * the electronics demo poses SHARED unit geometry with `Mesh.scale` while the
 * port bakes the dimensions into the constructor. A raw attribute diff would
 * report every part as different while proving nothing.
 *
 * So each part is expanded through its index INTO ITS OWN WORLD MATRIX and the
 * triangles are compared **in order**. That is strictly stronger than a
 * position diff plus an index diff: a reversed winding leaves every vertex in
 * place and no headless rasteriser shows it, but it reorders the expanded
 * triangle, so it lands here as a mismatch. Normals ride along through the
 * normal matrix, which catches an inside-out part whose positions survive.
 *
 * ── And the LAW, §3.10 ──────────────────────────────────────────────────────
 *
 * These three lamps exist to obey it, and all three worlds broke it once. The
 * assertions at the end state it directly rather than trusting the diff: a diff
 * proves「跟 demo 一樣」, and if the demo were ever wrong it would prove nothing.
 * The one that matters most is `UNLIT`: the night value is written into
 * `color`, and a material that gets multiplied by the scene's own lighting has
 * that value taken away again on the darkest frame of the ride — which is the
 * exact frame the lamp is for. That is how the electronics world's die shipped
 * as a `MeshPhongMaterial`: every colour ramp read correctly in the check, and
 * the only bright thing on the lamp was the SHELL.
 */
interface DemoLampSide {
  group: THREE.Group;
  setNight: (k: number) => void;
}

/** `const NAME = …;` through to the end of its line. */
function demoLine(src: string, needle: string): string {
  const a = src.indexOf(needle);
  if (a < 0) throw new Error(`demo no longer contains ${JSON.stringify(needle)}`);
  return src.slice(a, src.indexOf('\n', a));
}

/** `start …` through to the first `endMark` after it, inclusive. */
function demoBlock(src: string, start: string, endMark: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`demo no longer contains ${JSON.stringify(start)}`);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error(`no ${JSON.stringify(endMark)} after ${JSON.stringify(start)}`);
  return src.slice(a, b + endMark.length);
}

/** Every mesh under a root, in traversal order (the demos build lamps flat-ish). */
function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function lightsOf(root: THREE.Object3D): THREE.PointLight[] {
  const out: THREE.PointLight[] = [];
  root.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) out.push(o as THREE.PointLight);
  });
  return out;
}

/**
 * One mesh's triangles in WORLD space, index expanded, normals carried through
 * the normal matrix. Interleaved [px,py,pz,nx,ny,nz] per vertex, triangle order
 * preserved — see the header for why order is the point.
 */
function worldTriangles(mesh: THREE.Mesh): Float64Array {
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const out = new Float64Array(n * 6);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const j = idx ? idx.getX(i) : i;
    v.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(m);
    out[i * 6] = v.x; out[i * 6 + 1] = v.y; out[i * 6 + 2] = v.z;
    if (nor) {
      v.set(nor.getX(j), nor.getY(j), nor.getZ(j)).applyMatrix3(nm).normalize();
      out[i * 6 + 3] = v.x; out[i * 6 + 4] = v.y; out[i * 6 + 5] = v.z;
    }
  }
  return out;
}

function triangleDiff(a: THREE.Mesh, b: THREE.Mesh): string {
  const ta = worldTriangles(a);
  const tb = worldTriangles(b);
  if (ta.length !== tb.length) return `${ta.length / 18} vs ${tb.length / 18} triangles`;
  let worst = 0;
  let at = -1;
  for (let i = 0; i < ta.length; i++) {
    const d = Math.abs(ta[i] - tb[i]);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= 2e-4) return 'identical';
  const tri = Math.floor(at / 18);
  const what = at % 6 < 3 ? 'position' : 'normal';
  return `${what} off by ${worst.toExponential(2)} at triangle ${tri}/${ta.length / 18}`;
}

/** Everything about a material the eye can see, as one comparable string. */
function materialFingerprint(m: THREE.Material): string {
  const p = m as THREE.MeshPhongMaterial & THREE.MeshBasicMaterial;
  const bits = [
    m.type,
    `color=${p.color ? p.color.getHexString() : '-'}`,
    `opacity=${m.opacity.toFixed(4)}`,
    `transparent=${m.transparent}`,
    `depthWrite=${m.depthWrite}`,
    `side=${m.side}`,
    `visible=${m.visible}`,
    `blending=${m.blending}`,
    `fog=${(m as THREE.MeshBasicMaterial).fog}`,
    `depthTest=${m.depthTest}`,
    // A bulb is written straight into the framebuffer at up to 2.1; whether the
    // tone mapper gets to squash that back under 1 is the difference between a
    // white-hot core and a pale one, and it is one boolean nobody would notice.
    `toneMapped=${m.toneMapped}`,
  ];
  const ph = m as THREE.MeshPhongMaterial;
  if (ph.emissive) {
    bits.push(`emissive=${ph.emissive.getHexString()}`, `emissiveIntensity=${ph.emissiveIntensity}`);
  }
  if (ph.specular) bits.push(`specular=${ph.specular.getHexString()}`, `shininess=${ph.shininess}`);
  return bits.join(' ');
}

/**
 * Does this material carry its night brightness somewhere the scene's own
 * lighting cannot take away again?
 *
 * `color` on a lit material is multiplied by irradiance; on a `MeshBasicMaterial`
 * it goes to the framebuffer whole. `emissive` is ADDED after lighting on any
 * material, so a lit material may carry the ramp there instead. Anything else
 * gets dimmer exactly when the lamp is supposed to be brightest.
 */
function nightBrightnessSurvivesDarkness(m: THREE.Material, dayK: () => void, nightK: () => void): {
  ok: boolean; why: string;
} {
  const p = m as THREE.MeshPhongMaterial & THREE.MeshBasicMaterial;
  const sum = (c?: THREE.Color): number => (c ? c.r + c.g + c.b : 0);
  dayK();
  const dayColor = sum(p.color);
  const dayEmissive = sum(p.emissive) * (p.emissiveIntensity ?? 1);
  nightK();
  const nightColor = sum(p.color);
  const nightEmissive = sum(p.emissive) * (p.emissiveIntensity ?? 1);
  const dColor = nightColor - dayColor;
  const dEmissive = nightEmissive - dayEmissive;
  const unlit = (m as THREE.MeshBasicMaterial).isMeshBasicMaterial === true;
  if (dColor <= 1e-6 && dEmissive <= 1e-6) return { ok: false, why: 'never brightens at all' };
  if (unlit || dEmissive >= dColor) return { ok: true, why: unlit ? 'unlit (MeshBasic)' : 'via emissive' };
  return {
    ok: false,
    why: `${m.type} carries +${dColor.toFixed(2)} in COLOR (emissive only +${dEmissive.toFixed(2)}) `
      + '— a lit material has that multiplied away by the night it is lighting',
  };
}

function worldBox(o: THREE.Object3D): THREE.Box3 {
  o.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(o);
}

/** The demo side of one world's lamp: its own code, executed. */
function sliceDemoLamp(world: 'plastic' | 'paper' | 'circuit'): DemoLampSide {
  // Math shim, not the global — three burns 4 draws per uuid (see checkPaperClouds).
  const demoMath = Object.create(Math) as Math;

  if (world === 'plastic') {
    const src = readFileSync('plan/plastic-town-demo.html', 'utf8');
    // The night ramp is a loop INSIDE applyDayNight, not its own function, so
    // it is lifted out by its own comment and wrapped — the alternative is
    // slicing all of applyDayNight and stubbing a sky.
    const rampAt = src.indexOf('    // 泡泡燈:跟電子世界的 LED 同一套');
    const rampEnd = src.indexOf('\n    }', rampAt);
    if (rampAt < 0 || rampEnd < 0) throw new Error('demo no longer ramps the bubble lamps');
    const demoSrc = [
      sliceDemoFn(src, 'gloss'),
      sliceDemoFn(src, 'matKey'),
      'const glossCache = new Map();',
      sliceDemoFn(src, 'glossShared'),
      sliceDemoFn(src, 'mergeGeos'),
      demoBlock(src, 'const C = {', '\n  };'),
      demoBlock(src, 'const bubbleTubeGeo = (() => {', '})();'),
      demoBlock(src, 'const bubbleGeo = (() => {', '})();'),
      demoBlock(src, 'const bubbleBlobGeo = (() => {', '})();'),
      demoLine(src, 'const LAMP_COLS = ['),
      demoLine(src, 'const LAMP_COL3 = '),
      demoBlock(src, 'const bubbleMats = LAMP_COLS.map', '}));'),
      demoLine(src, 'const bubbleBlobMats = '),
      sliceDemoFn(src, 'bubbleLamp'),
      // The toy world splits its ramp in two: the shared materials move in that
      // loop, the per-lamp PointLight in `applyBulb`. Both, or the light checks
      // below would be measuring a lamp nobody switched on.
      sliceDemoFn(src, 'applyBulb'),
      'const built = bubbleLamp(0);',
      `function setNight(k) {\n${src.slice(rampAt, rampEnd + 6)}\n  applyBulb(built.bulb, k);\n}`,
      'return { lamp: built, setNight };',
    ].join('\n');
    const demo = new Function('THREE', 'Math', demoSrc)(THREE, demoMath) as {
      lamp: { grp: THREE.Group }; setNight: (k: number) => void;
    };
    return { group: demo.lamp.grp, setNight: demo.setNight };
  }

  if (world === 'paper') {
    const src = readFileSync('plan/paper-town-demo.html', 'utf8');
    const demoSrc = [
      'const SHARED_GEO = new Set();',
      'const geoCache = new Map();',
      sliceDemoFn(src, 'shared'),
      sliceDemoFn(src, 'mergeGeos'),
      demoLine(src, 'const unitSphere = (w, h) =>'),
      demoBlock(src, "const hlBarrelGeo = shared('hlBarrel', () => {", '\n  });'),
      demoBlock(src, "const hlCapGeo = shared('hlCap', () => {", '\n  });'),
      demoBlock(src, "const hlNibGeo = shared('hlNib', () => {", '\n  });'),
      demoLine(src, 'const HL_INKS = ['),
      demoLine(src, 'const HL_INK3 = '),
      demoBlock(src, 'const hlBarrelMats = HL_INKS.map', '}));'),
      demoBlock(src, 'const hlCapMats = HL_INKS.map', '}));'),
      demoLine(src, 'const hlNibMats = '),
      demoBlock(src, 'const hlGlowMats = HL_INKS.map', '}));'),
      sliceDemoFn(src, 'hiliteLamp'),
      sliceDemoFn(src, 'applyBulb'),
      'const built = hiliteLamp(0);',
      'return { lamp: built, setNight: (k) => applyBulb(built.bulb, k) };',
    ].join('\n');
    const demo = new Function('THREE', 'Math', demoSrc)(THREE, demoMath) as {
      lamp: { grp: THREE.Group }; setNight: (k: number) => void;
    };
    return { group: demo.lamp.grp, setNight: demo.setNight };
  }

  const src = readFileSync('plan/circuit-town-demo.html', 'utf8');
  const demoSrc = [
    sliceDemoFn(src, 'metal'),
    demoBlock(src, '  const E = {', '\n  };'),
    demoLine(src, 'const pinMat = '),
    demoLine(src, 'const unitBox = new THREE.BoxGeometry'),
    demoLine(src, 'const unitCyl = new THREE.CylinderGeometry'),
    demoLine(src, 'const unitCyl8 = '),
    demoLine(src, 'const unitHemi = '),
    sliceDemoFn(src, 'box'),
    sliceDemoFn(src, 'cyl'),
    sliceDemoFn(src, 'dome'),
    demoLine(src, 'const ledCupMat = '),
    demoLine(src, 'const LED_COLORS = ['),
    demoBlock(src, 'const ledLensMats = LED_COLORS.map', '}));'),
    demoLine(src, 'const ledDieMats = '),
    sliceDemoFn(src, 'ledBody'),
    sliceDemoFn(src, 'ledLamp'),
    sliceDemoFn(src, 'applyBulb'),
    'const built = ledLamp(0);',
    'return { lamp: built, setNight: (k) => applyBulb(built.bulb, k) };',
  ].join('\n');
  const demo = new Function('THREE', 'Math', demoSrc)(THREE, demoMath) as {
    lamp: { grp: THREE.Group }; setNight: (k: number) => void;
  };
  return { group: demo.lamp.grp, setNight: demo.setNight };
}

async function checkStreetLampsVsDemo(): Promise<void> {
  const WORLDS = [
    { world: 'plastic' as const, style: 'plastic' as const, label: 'plastic (blown-bubble tube)' },
    { world: 'paper' as const, style: 'paper' as const, label: 'cuphead (highlighter)' },
    { world: 'circuit' as const, style: 'circuit' as const, label: 'circuit (5 mm LED)' },
  ];

  for (const { world, style, label } of WORLDS) {
    console.log(`\n[street lamp vs demo — ${label}]`);

    const demo = sliceDemoLamp(world);
    const strategy = await createTerrainStyleStrategy(style);
    const ours = strategy.buildStreetLamp(0);

    // Both sides at the same point on the day/night ramp before anything is
    // measured — the demo materials are born at their authored constants and
    // only `applyBulb` puts them on the ramp, exactly like `setNight` here.
    demo.setNight(0);
    ours.setNight(0);

    const demoMeshes = meshesOf(demo.group);
    const ourMeshes = meshesOf(ours.group);
    check(`${world}: same number of parts as the demo`,
      demoMeshes.length === ourMeshes.length,
      `demo ${demoMeshes.length} vs ours ${ourMeshes.length}`);

    // ── 1. Geometry, part for part, in the demo's own order ──
    let worstGeo = 'identical';
    let worstAt = -1;
    for (let i = 0; i < Math.min(demoMeshes.length, ourMeshes.length); i++) {
      const d = triangleDiff(demoMeshes[i], ourMeshes[i]);
      if (d !== 'identical' && worstAt < 0) { worstGeo = d; worstAt = i; }
    }
    check(`${world}: every part IS the demo's — world-space triangles, in order, winding included`,
      worstGeo === 'identical', worstAt < 0 ? '' : `part ${worstAt}: ${worstGeo}`);

    // ── 2. Materials, part for part, at three points on the ramp ──
    for (const k of [0, 0.5, 1]) {
      demo.setNight(k);
      ours.setNight(k);
      let worstMat = '';
      for (let i = 0; i < Math.min(demoMeshes.length, ourMeshes.length); i++) {
        const dm = materialFingerprint(demoMeshes[i].material as THREE.Material);
        const om = materialFingerprint(ourMeshes[i].material as THREE.Material);
        if (dm !== om) { worstMat = `part ${i}:\n      demo ${dm}\n      ours ${om}`; break; }
      }
      check(`${world}: every material IS the demo's at night=${k}`, worstMat === '', worstMat);
    }

    // ── 3. Shadow flags. Inert while gameview has no shadow map, but they are
    //      DECISIONS the demo wrote down (「球冠不投影」), and a port that drops
    //      them has dropped the reasoning with them. ──
    demo.setNight(0);
    ours.setNight(0);
    let worstShadow = '';
    for (let i = 0; i < Math.min(demoMeshes.length, ourMeshes.length); i++) {
      const d = `${demoMeshes[i].castShadow}/${demoMeshes[i].receiveShadow}`;
      const o = `${ourMeshes[i].castShadow}/${ourMeshes[i].receiveShadow}`;
      if (d !== o) { worstShadow = `part ${i}: demo cast/recv ${d} vs ours ${o}`; break; }
    }
    check(`${world}: cast/receiveShadow are the demo's, part for part`, worstShadow === '', worstShadow);

    // ── 4. The point light (already held elsewhere; here it is diffed, not typed) ──
    const demoLights = lightsOf(demo.group);
    const ourLights = lightsOf(ours.group);
    check(`${world}: one point light, like the demo`,
      demoLights.length === 1 && ourLights.length === 1,
      `demo ${demoLights.length} vs ours ${ourLights.length}`);
    if (demoLights.length === 1 && ourLights.length === 1) {
      const dl = demoLights[0];
      const ol = ourLights[0];
      demo.group.updateWorldMatrix(true, true);
      ours.group.updateWorldMatrix(true, true);
      const dp = dl.getWorldPosition(new THREE.Vector3());
      const op = ol.getWorldPosition(new THREE.Vector3());
      check(`${world}: light colour / distance / decay / position are the demo's`,
        dl.color.getHexString() === ol.color.getHexString()
        && dl.distance === ol.distance && dl.decay === ol.decay
        && dp.distanceTo(op) < 1e-4,
        `demo #${dl.color.getHexString()} d=${dl.distance} decay=${dl.decay} `
        + `y=${dp.y.toFixed(3)} vs ours #${ol.color.getHexString()} d=${ol.distance} `
        + `decay=${ol.decay} y=${op.y.toFixed(3)}`);
      let rampOk = true;
      const ramp: string[] = [];
      for (const k of [0, 0.5, 1]) {
        demo.setNight(k);
        ours.setNight(k);
        ramp.push(`${k}:${dl.intensity}`);
        if (Math.abs(dl.intensity - ol.intensity) > 1e-9) rampOk = false;
      }
      check(`${world}: the light's intensity ramp is the demo's`, rampOk, ramp.join(' '));
    }

    // ══ §3.10 — the law these three lamps exist to obey ══
    // Stated directly, not inherited from the diff above: a diff can only prove
    // 「跟 demo 一樣」, and every one of these was once wrong in the demo too.
    // A SHELL is translucent IN DAYLIGHT — a lampshade is a thing you can see
    // at noon. That is also what separates it from the halo the paper world
    // fades in at night (opacity 0 → 0.5): a halo that grows more opaque after
    // dark is doing its job, and folding it in here would make the shell rule
    // fire on the one part it must not apply to.
    const isShell = (m: THREE.Mesh): boolean => {
      const mat = m.material as THREE.Material;
      return mat.transparent && mat.opacity > 0.05;
    };
    ours.setNight(0);
    demo.setNight(0);
    const shells = ourMeshes.filter(isShell);
    const demoShells = demoMeshes.filter(isShell);
    check(`${world} §3.10: has a translucent shell`, shells.length > 0, `${shells.length} parts`);

    const dayOpacity = shells.map((m) => (m.material as THREE.Material).opacity);
    ours.setNight(1);
    const nightOpacity = shells.map((m) => (m.material as THREE.Material).opacity);

    check(`${world} §3.10: the shell does NOT go more opaque at night `
      + '(「殼夜裡要更透不是更實」)',
      nightOpacity.every((o, i) => o <= dayOpacity[i] + 1e-9),
      nightOpacity.map((o, i) => `${dayOpacity[i].toFixed(3)}→${o.toFixed(3)}`).join(' '));
    check(`${world} §3.10: the shell does not write depth (it would hide its own contents)`,
      shells.every((m) => (m.material as THREE.Material).depthWrite === false));

    // The bright thing: whichever part gains the most brightness day → night.
    const brightnessOf = (m: THREE.Material): number => {
      const p = m as THREE.MeshPhongMaterial & THREE.MeshBasicMaterial;
      const s = (c?: THREE.Color): number => (c ? c.r + c.g + c.b : 0);
      return s(p.color) + s(p.emissive) * (p.emissiveIntensity ?? 1);
    };
    ours.setNight(0);
    const dayB = ourMeshes.map((m) => brightnessOf(m.material as THREE.Material));
    ours.setNight(1);
    const nightB = ourMeshes.map((m) => brightnessOf(m.material as THREE.Material));
    let bulbIdx = -1;
    let bulbGain = 0;
    for (let i = 0; i < ourMeshes.length; i++) {
      const gain = nightB[i] - dayB[i];
      // Shells brighten too (a little emissive stain); the BULB is the one that
      // brightens and is not a shell.
      if (gain > bulbGain && !shells.includes(ourMeshes[i])) { bulbGain = gain; bulbIdx = i; }
    }
    check(`${world} §3.10: something that is NOT the shell lights up`,
      bulbIdx >= 0 && bulbGain > 0.2, `part ${bulbIdx}, +${bulbGain.toFixed(2)}`);
    // The two rules below are calibrated off the DEMO's own lamp, so they need
    // the same part to exist on both sides. If the part lists have diverged the
    // diff above has already said so; failing loudly here beats indexing past
    // the end of the demo's list and reporting it as a thrown block.
    if (bulbIdx < 0 || !demoMeshes[bulbIdx]) {
      check(`${world} §3.10: the demo has the same part to calibrate against`,
        false, `bulb is part ${bulbIdx}, demo has ${demoMeshes.length} parts`);
      ours.dispose();
      strategy.dispose();
      continue;
    }

    const bulb = ourMeshes[bulbIdx];

    // 「亮的東西要遠小於罩子。整片亮 = 色塊。」— in radiometry, not just volume:
    // the shell may carry a HINT of the colour it is stained by, and no more of
    // the night's brightening than the demo gives it. Without this, a lamp can
    // pass every other assertion here while creeping back towards the thing
    // §3.10 was written about — a shade that glows as hard as its own bulb.
    const gainOf = (picked: THREE.Mesh[], set: (k: number) => void): number => {
      set(0);
      const day = picked.map((m) => brightnessOf(m.material as THREE.Material));
      set(1);
      const night = picked.map((m) => brightnessOf(m.material as THREE.Material));
      return night.reduce((a, v, i) => a + (v - day[i]), 0);
    };
    const ourShellGain = gainOf(shells, (k) => ours.setNight(k));
    const demoShellGain = gainOf(demoShells, (k) => demo.setNight(k));
    const ourBulbGain = gainOf([bulb], (k) => ours.setNight(k));
    const demoBulbGain = gainOf([demoMeshes[bulbIdx]], (k) => demo.setNight(k));
    const ourShare = ourShellGain / Math.max(ourBulbGain, 1e-9);
    const demoShare = demoShellGain / Math.max(demoBulbGain, 1e-9);
    check(`${world} §3.10: the shell only takes a HINT of the glow — no larger a share `
      + 'of the night than the demo gives it',
      ourShare <= demoShare + 1e-6 && demoShare < 1,
      `shell gains ${(ourShare * 100).toFixed(1)}% of what the bulb gains, demo ${(demoShare * 100).toFixed(1)}%`);

    const survives = nightBrightnessSurvivesDarkness(
      bulb.material as THREE.Material, () => ours.setNight(0), () => ours.setNight(1),
    );
    check(`${world} §3.10: the bright part keeps its brightness on the darkest frame `
      + '(unlit, or carried in emissive)', survives.ok, survives.why);

    // 「在裡面」— the bulb's world box sits inside the shell's.
    ours.setNight(1);
    const shellBox = new THREE.Box3();
    for (const s of shells) shellBox.union(worldBox(s));
    const bulbBox = worldBox(bulb);
    check(`${world} §3.10: the bright part is INSIDE the shell`,
      shellBox.containsBox(bulbBox),
      `bulb y ${bulbBox.min.y.toFixed(2)}..${bulbBox.max.y.toFixed(2)} `
      + `in shell y ${shellBox.min.y.toFixed(2)}..${shellBox.max.y.toFixed(2)}`);

    // 「小」— and no bigger, relative to the shell, than the DEMO makes it. The
    // ratio comes off the demo's own geometry; nothing is transcribed.
    demo.setNight(1);
    const demoShellBox = new THREE.Box3();
    for (const s of demoShells) demoShellBox.union(worldBox(s));
    const demoBulbBox = worldBox(demoMeshes[bulbIdx]);
    const vol = (b: THREE.Box3): number => {
      const s = b.getSize(new THREE.Vector3());
      return Math.max(s.x * s.y * s.z, 1e-12);
    };
    const demoRatio = vol(demoBulbBox) / vol(demoShellBox);
    const ourRatio = vol(bulbBox) / vol(shellBox);
    check(`${world} §3.10: the bright part is SMALL against the shell — no larger a `
      + 'share than the demo gives it',
      ourRatio <= demoRatio + 1e-6 && demoRatio < 0.25,
      `ours ${(ourRatio * 100).toFixed(2)}% of the shell's volume, demo ${(demoRatio * 100).toFixed(2)}%`);

    ours.setNight(0);
    ours.dispose();
    strategy.dispose();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 太陽陰影圖 —— 對三支 demo
// ══════════════════════════════════════════════════════════════════════════
//
// gameview 一直在四個 style 檔裡設 castShadow / receiveShadow,卻從來沒開過
// shadowMap —— 旗標設了、影子圖沒算過。這一節把「三支 demo 的 sunLight.shadow
// 區塊」原文切出來比對,並且**不比對抄過來的常數**:每個數字都是當場從 HTML
// 讀出來的。

const SHADOW_DEMOS = {
  plastic: 'plan/plastic-town-demo.html',
  paper: 'plan/paper-town-demo.html',
  circuit: 'plan/circuit-town-demo.html',
} as const;

const D2R = Math.PI / 180;

/** The demo's OWN script block — never the bundled three.js above it. */
function demoScript(file: string): string {
  const src = readFileSync(file, 'utf8');
  const at = src.lastIndexOf('<script>');
  if (at < 0) throw new Error(`no demo script in ${file}`);
  return src.slice(at);
}

function demoNum(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  if (!m) throw new Error(`cannot read ${what} out of the demo`);
  return Number(m[1]);
}

function demoWord(src: string, re: RegExp, what: string): string {
  const m = src.match(re);
  if (!m) throw new Error(`cannot read ${what} out of the demo`);
  return m[1];
}

interface DemoShadow {
  enabled: string;
  type: string;
  castShadow: string;
  mapSize: number;
  left: number; right: number; top: number; bottom: number;
  near: number; far: number;
  bias: number; normalBias: number;
  /** `sunLight.position.set(bp.x + X, Y, bp.z + Z)` — the per-frame rider follow. */
  followOffset: [number, number, number];
}

function readDemoShadow(file: string): DemoShadow {
  const s = demoScript(file);
  const camera = (side: string): number =>
    demoNum(s, new RegExp(`sunLight\\.shadow\\.camera\\.${side}\\s*=\\s*(-?[\\d.]+)`), `camera.${side}`);
  // 太陽會動之後,`sunLight.position.set(bp.x + 150, 190, bp.z + 90)` 那一行不存在
  // 了 —— 每一幀掛上去的是 `skyKey`,而 skyKey 是天相滑桿算出來的。這裡改讀那根
  // 滑桿的**正午端**,也就是 demo 原本釘死的那顆太陽,三個數字一個都沒動。
  // 形狀完全一樣:從 demo 讀三個數字,讀不到就 throw。而「天相 0.5 真的算得出這
  // 三個數字」是 checkSunShadowVsDemos **執行** demo 的函式去證的,不是這裡。
  const follow = s.match(
    /const SKY_NOON = \{ x: (-?[\d.]+), y: (-?[\d.]+), z: (-?[\d.]+) \};/,
  );
  if (!follow) throw new Error(`no sky-phase noon sun in ${file}`);
  return {
    enabled: demoWord(s, /renderer\.shadowMap\.enabled\s*=\s*(\w+)/, 'shadowMap.enabled'),
    type: demoWord(s, /renderer\.shadowMap\.type\s*=\s*THREE\.(\w+)/, 'shadowMap.type'),
    castShadow: demoWord(s, /sunLight\.castShadow\s*=\s*(\w+)/, 'sunLight.castShadow'),
    mapSize: demoNum(s, /sunLight\.shadow\.mapSize\.set\((\d+),\s*\d+\)/, 'mapSize'),
    left: camera('left'), right: camera('right'),
    top: camera('top'), bottom: camera('bottom'),
    near: camera('near'), far: camera('far'),
    bias: demoNum(s, /sunLight\.shadow\.bias\s*=\s*(-?[\d.]+)/, 'bias'),
    normalBias: demoNum(s, /sunLight\.shadow\.normalBias\s*=\s*(-?[\d.]+)/, 'normalBias'),
    followOffset: [Number(follow[1]), Number(follow[2]), Number(follow[3])],
  };
}

/**
 * GameRenderer's own methods, taken off the prototype so a stand-in can run
 * **them** instead of a re-implementation. `directionalLight.castShadow` has two
 * owners now (the quality tier's ceiling and the sky's horizon gain), and a
 * second copy of that AND living in this file would be a mirror — which is the
 * exact failure this port keeps tripping over.
 */
const rendererProto = GameRenderer.prototype as unknown as {
  setShadowLevel(level: ShadowLevel): void;
  setKeyLightShadowGain(gain: number): void;
  syncKeyLightCastShadow(): void;
};

/**
 * The GameRenderer surface SkyAndFog talks to. One factory rather than a copy
 * per check — the day the class grows a method, one place stops compiling
 * instead of three blocks silently throwing.
 *
 * The key light is `configureSunShadow`d, as the real constructor does it: the
 * horizon gain is computed FROM that block (box, map size, normalBias), so a
 * bare `DirectionalLight` (normalBias 0) would divide by zero and hand every
 * check a NaN intensity instead of a failure.
 */
function fakeGameRenderer(): {
  scene: THREE.Scene;
  ambientLight: THREE.AmbientLight;
  directionalLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
  camera: THREE.PerspectiveCamera;
  renderer: {
    shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
    // `SkyAndFog.update()` sizes the point-sprite particles off this.
    domElement: { width: number; height: number };
  };
  shadowLevel: ShadowLevel;
  keyLightGain: number;
  setToneMappingExposure: () => void;
  setFog: () => void;
  setBackground: () => void;
  keyLightCalls: [number, number][];
  keyLightGains: number[];
  setKeyLightDirection: (elevationDeg: number, azimuthDeg: number) => void;
  setShadowLevel: (level: ShadowLevel) => void;
  setKeyLightShadowGain: (gain: number) => void;
  syncKeyLightCastShadow: () => void;
} {
  const keyLightCalls: [number, number][] = [];
  const keyLightGains: number[] = [];
  const directionalLight = new THREE.DirectionalLight();
  configureSunShadow(directionalLight);
  return {
    scene: new THREE.Scene(),
    ambientLight: new THREE.AmbientLight(),
    directionalLight,
    hemisphereLight: new THREE.HemisphereLight(),
    camera: new THREE.PerspectiveCamera(),
    renderer: {
      shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
      domElement: { width: 1920, height: 1080 },
    },
    // The two fields the borrowed methods below own, at the class's own defaults.
    shadowLevel: 'full',
    keyLightGain: 1,
    setToneMappingExposure: () => {},
    setFog: () => {},
    setBackground: () => {},
    keyLightCalls,
    keyLightGains,
    setKeyLightDirection: (e: number, a: number) => { keyLightCalls.push([e, a]); },
    // Borrowed, not re-implemented — see `rendererProto`. The recorder only
    // watches; the field and the flag are written by GameRenderer's own code.
    setShadowLevel: rendererProto.setShadowLevel,
    setKeyLightShadowGain(gain: number) {
      keyLightGains.push(gain);
      rendererProto.setKeyLightShadowGain.call(this, gain);
    },
    syncKeyLightCastShadow: rendererProto.syncKeyLightCastShadow,
  };
}

async function checkSunShadowVsDemos(): Promise<void> {
  console.log('\n[sun shadow map vs demos]');

  const demos = Object.fromEntries(
    Object.entries(SHADOW_DEMOS).map(([k, f]) => [k, readDemoShadow(f)]),
  ) as Record<keyof typeof SHADOW_DEMOS, DemoShadow>;
  const all = Object.values(demos);
  const same = <T>(pick: (d: DemoShadow) => T): boolean =>
    all.every((d) => JSON.stringify(pick(d)) === JSON.stringify(pick(all[0])));

  // ── What the three demos actually agree on ──
  check('all three demos switch the shadow map on, with the same filter',
    same((d) => [d.enabled, d.type]) && all[0].enabled === 'true',
    `${all[0].enabled} / THREE.${all[0].type}`);
  // The renderer-side pair, taken from the shipped tier levels rather than from
  // a constant: `off` is a type the presets deliberately never use, so asking
  // the function is the only way to see what a rider actually gets.
  for (const level of ['half', 'full'] as const) {
    const stub = { shadowMap: { enabled: false, type: THREE.BasicShadowMap } };
    const light = new THREE.DirectionalLight();
    applySunShadowLevel(stub, light, level);
    check(`tier '${level}': the renderer gets the demos' own pair`,
      stub.shadowMap.enabled === (all[0].enabled === 'true')
      && stub.shadowMap.type === (THREE as unknown as Record<string, THREE.ShadowMapType>)[all[0].type]
      && light.castShadow,
      `enabled=${stub.shadowMap.enabled} type=${all[0].type}`);
  }

  const configured = new THREE.DirectionalLight();
  configureSunShadow(configured);
  check('all three demos ask the sun to cast — and configureSunShadow does too',
    same((d) => d.castShadow) && all[0].castShadow === 'true' && configured.castShadow);
  check('all three demos use the same shadow map size — and so do we',
    same((d) => d.mapSize) && SHADOW_MAP_SIZE === all[0].mapSize,
    `demo ${all[0].mapSize}² / ours ${SHADOW_MAP_SIZE}²`);
  check('all three demos use the same square ortho box — and so do we',
    same((d) => [d.left, d.right, d.top, d.bottom])
    && all[0].right === -all[0].left && all[0].top === all[0].right && all[0].bottom === all[0].left
    && SHADOW_HALF_EXTENT === all[0].right,
    `demo ±${all[0].right} m / ours ±${SHADOW_HALF_EXTENT} m`);
  check('all three demos use the same near plane and depth bias — and so do we',
    same((d) => [d.near, d.bias]) && SHADOW_NEAR === all[0].near && SHADOW_BIAS === all[0].bias,
    `near ${all[0].near}, bias ${all[0].bias}`);

  // Texel density is the thing the box and the map size jointly buy. It is the
  // number a "make the box cover the fog instead" change would quietly destroy,
  // so it is asserted in metres rather than left implicit in the two operands.
  const demoTexel = (all[0].right * 2) / all[0].mapSize;
  const ourTexel = (SHADOW_HALF_EXTENT * 2) / SHADOW_MAP_SIZE;
  check('shadow sharpness is the demos\': same metres per texel',
    Math.abs(demoTexel - ourTexel) < 1e-9,
    `${ourTexel.toFixed(4)} m/texel across ${SHADOW_HALF_EXTENT * 2} m`);

  // ── …and the one thing they do NOT ──
  //
  // Asserted as a DIFFERENCE, not skipped: the brief that ordered this port said
  // the three blocks were identical, and they are not. Recording it here is what
  // stops the next reader re-discovering it (or, worse, "fixing" circuit).
  const biases = { plastic: demos.plastic.normalBias, paper: demos.paper.normalBias, circuit: demos.circuit.normalBias };
  check('normalBias is the one value the demos disagree on — circuit runs tighter',
    biases.plastic === biases.paper && biases.circuit !== biases.plastic
    && biases.circuit < biases.plastic,
    `plastic ${biases.plastic} / paper ${biases.paper} / circuit ${biases.circuit}`);
  check('the default is the value two of the three agree on',
    SHADOW_NORMAL_BIAS === biases.plastic,
    `ours ${SHADOW_NORMAL_BIAS}`);

  // ── And every world now actually GETS its demo's number ──
  // The disagreement above was recorded for days while all three worlds shipped
  // 1.5, because `normalBias` is a light property and nothing routed a per-world
  // value to the light. These read the strategies and the renderer path, so the
  // wiring cannot rot back into "recorded but not applied".
  {
    const byStyle: Record<string, number> = {
      plastic: biases.plastic, paper: biases.paper, circuit: biases.circuit,
    };
    const light = new THREE.DirectionalLight();
    configureSunShadow(light);
    let bad = 0;
    const seen: string[] = [];
    for (const [style, want] of Object.entries(byStyle)) {
      const st = await createTerrainStyleStrategy(style as 'plastic' | 'paper' | 'circuit');
      // Exactly what useTerrainRenderer does at both strategy sites.
      light.shadow.normalBias = st.shadowNormalBias ?? SHADOW_NORMAL_BIAS;
      seen.push(`${style} ${light.shadow.normalBias}`);
      if (light.shadow.normalBias !== want) bad++;
    }
    check('每個世界拿到的是它自己 demo 的 normalBias(不是多數決那個)',
      bad === 0, seen.join(' / '));
    // 只宣告不等於送得到。這條盯的是**送達的路徑**,不是那個欄位。
    const probe = new THREE.DirectionalLight();
    configureSunShadow(probe);
    const before = probe.shadow.normalBias;
    probe.shadow.normalBias = (await createTerrainStyleStrategy('circuit')).shadowNormalBias
      ?? SHADOW_NORMAL_BIAS;
    check('電子世界的 1.2 真的離開了 strategy —— 不是宣告完就沒下文',
      before === biases.plastic && probe.shadow.normalBias === biases.circuit,
      `configureSunShadow ${before} → strategy ${probe.shadow.normalBias}`);
  }

  // ── The demos' per-frame rider follow ──
  check('all three demos re-park the sun on the rider every frame, at the same offset',
    same((d) => d.followOffset),
    `bp + (${all[0].followOffset.join(', ')})`);
  // ── …and the sun is no longer pinned: one sky-phase slider, in all three ──
  //
  // 這裡原本寫的是「三個 demo 整場把太陽釘在一個仰角」。那句話記錄的是 demo 的
  // **缺陷**,不是規格 —— 跟瓦楞紙樹的 receiveShadow 同一個形狀:通道一補上,
  // 斷言就該從「偏離」變成「正面陳述」。三份 demo 現在共用同一根天相滑桿
  // (?sky=0 午夜 / 0.25 日出 / 0.5 正午 / 0.75 日落),日與月是它的兩端。
  {
    const SKY_END = '// ══ SKY 區塊結束 ══';
    const skySection = (f: string): string => {
      const src = readFileSync(f, 'utf8');
      const a = src.indexOf('── SKY 區塊開始 ──'), b = src.indexOf(SKY_END);
      return a >= 0 && b > a ? src.slice(a, b + SKY_END.length) : '';
    };
    /** SKY 區塊的**純**那一半,從 HTML 切出來執行(§0.0 第 5 點)。 */
    const arcOf = (f: string): ((p: number) => {
      key: { x: number; y: number; z: number };
      sun: { x: number; y: number; z: number };
      moon: { x: number; y: number; z: number };
      isDay: boolean; sunElev: number; keyElev: number; night: number;
    }) => {
      const sec = skySection(f);
      const a = sec.indexOf('const SKY_NOON ='), b = sec.indexOf('  // ── 這根滑桿接到世界上');
      if (a < 0 || b <= a) throw new Error(`no pure sky arc in ${f}`);
      return new Function(`${sec.slice(a, b)}\nreturn skyCelestial;`)();
    };

    const files = Object.values(SHADOW_DEMOS);
    // 1. 逐字相同(DEMO_POC_GUIDE §5)。「複製三次」正是最容易分岔的形狀 ——
    //    只有塑膠 demo 問過招牌朝哪邊,另外兩個的字朝著行進方向、騎士看不到。
    const secs = files.map(skySection);
    const sameText = secs.every((x) => x === secs[0]) && secs[0].length > 5000;
    const firstDiff = sameText ? -1 : [...secs[0]].findIndex((c, i) => c !== secs[1][i]);
    check('三份 demo 的天相滑桿(SKY 區塊)逐字相同', sameText,
      sameText ? `${secs[0].length} chars` : `第一個差異在第 ${firstDiff} 個字元`);
    // 而且三份都真的把主光掛在它算出來的那一顆上,那一行也逐字相同。
    const parks = files.map((f) => {
      const m = /sunLight\.position\.set\(bp\.x \+ (\w+)\.x, \1\.y, bp\.z \+ \1\.z\);/
        .exec(demoScript(f));
      return m ? m[0] : '';
    });
    check('三份 demo 每一幀都把主光掛在天相算出來的那顆上,而且逐字相同',
      parks.every((p) => p !== '' && p === parks[0]), parks[0] || '(找不到)');

    const arcs = files.map(arcOf);
    const vec = (v: { x: number; y: number; z: number }): string => `(${v.x}, ${v.y}, ${v.z})`;
    // 2. 天相 0.5 **逐位元組**復刻原本那顆釘死的太陽。這是「這根滑桿沒有改變
    //    預設外觀」的唯一證據,而且它是**執行** demo 的函式得到的 —— 上面
    //    readDemoShadow 用正規表示式讀的 SKY_NOON 是宣告,這裡是算出來的值,
    //    兩條不同的路必須落在同一個點上。
    const noon = arcs.map((a) => a(0.5).key);
    const exactNoon = noon.every((n, i) => n.x === all[i].followOffset[0]
      && n.y === all[i].followOffset[1] && n.z === all[i].followOffset[2]);
    check('天相 0.5 逐位元組復刻 demo 原本釘死的那顆太陽',
      exactNoon && same((d) => d.followOffset), vec(noon[0]));
    // 3. 月亮在正對面,所以**午夜的月亮剛好站在正午的太陽那個位置** —— ?night=1
    //    因此就是 ?sky=0,主光的位置一個位元組都沒變。這不是巧合是推論,而它讓
    //    既有的夜間自檢一個字都不用改。
    const midnight = arcs.map((a) => a(0));
    check('天相 0(午夜)換月亮當班,而月亮就站在正午太陽那個位置 —— ?night=1 = ?sky=0',
      midnight.every((m, i) => !m.isDay && m.key.x === noon[i].x
        && m.key.y === noon[i].y && m.key.z === noon[i].z),
      vec(midnight[0].key));
    // 4. 四個整點相位是精確的。Math.sin(Math.PI) 是 1.22e-16 而不是 0,不擋的話
    //    第 2 條會變成 149.99999999999997。夜間程度的兩端也一樣要精確。
    const cardinal = arcs.every((a) => a(0.25).sunElev === 0 && a(0.75).sunElev === 0
      && a(0.5).night === 0 && a(0).night === 1);
    check('日出 / 日落仰角精確為 0,正午 / 午夜的夜間程度精確為 0 / 1', cardinal,
      `0.25 → ${arcs[0](0.25).sunElev}°, 0.5 → night ${arcs[0](0.5).night}`);
    // 5. 滑桿真的掃過整片天:主光的仰角從 0 一路到正午那個角度,而且太陽跌到
    //    地平線下時是**月亮接手**,不是把太陽夾住。gameview 那道 MIN_LIGHT_ELEV
    //    = 15° 沒有 demo 依據,已經照 demo 刪掉了(見 sky-and-fog.ts)。
    let lo = Infinity, hi = -Infinity, below15 = 0, wrongBody = 0;
    for (let i = 0; i < 1000; i++) {
      const st = arcs[0](i / 1000);
      lo = Math.min(lo, st.keyElev); hi = Math.max(hi, st.keyElev);
      if (st.keyElev < 15) below15++;
      // 主光一定是**站在地平線上的那一顆**,而且它的仰角就是那一顆的仰角。
      if (st.isDay !== (st.sun.y >= 0) || st.key !== (st.isDay ? st.sun : st.moon)) wrongBody++;
    }
    const noonElev = Math.asin(all[0].followOffset[1]
      / Math.hypot(...all[0].followOffset)) / D2R;
    check('主光跟著當班的那一顆,仰角掃到 0° —— demo 不夾 15°,那個夾值是 gameview 發明的',
      wrongBody === 0 && lo === 0 && Math.abs(hi - noonElev) < 1e-9 && below15 > 100,
      `主光仰角 ${lo.toFixed(2)}…${hi.toFixed(2)}°(正午 ${noonElev.toFixed(2)}°),`
      + `其中 ${(below15 / 10).toFixed(1)}% 的天相低於 15°;換錯顆 ${wrongBody} 次`);

    // 6. 主光在地平線附近**收掉**,而不是被抬到 15°。這是 demo 對「太陽在 0°、
    //    −5°、−10° 時陰影該怎麼辦」的答案,而 gameview 的 MIN_LIGHT_ELEV = 15°
    //    已經被它取代(day-night-lighting.ts 的 skyKeyFullDeg / skyKeyGainAt,
    //    收在 sky-and-fog.ts 的 applyLighting;主光實際拿到什麼由
    //    checkKeyLightDirectionRouting 那幾條問)。
    {
      type Gain = { skyKeyFullDeg: (h: number, m: number, nb: number) => number;
        skyKeyGainAt: (e: number, f: number) => number };
      const gains = files.map((f) => {
        const sec = skySection(f);
        const a = sec.indexOf('const SKY_NOON ='), b = sec.indexOf('  // ── 這根滑桿接到世界上');
        return new Function(`${sec.slice(a, b)}\nreturn { skyKeyFullDeg, skyKeyGainAt };`)() as Gain;
      });
      // 門檻是**每個世界自己那塊 sunLight.shadow 算出來的**,不是打進來的常數:
      // 框的半徑、陰影圖邊長、以及它自己的 normalBias。電子的 1.2 因此給出一個
      // 不同的角度 —— 那個既有的、有理由的分歧一路傳到這裡,沒有被抹平。
      const full = all.map((d, i) => gains[i].skyKeyFullDeg(d.right, d.mapSize, d.normalBias));
      // 「算得出來」不等於「餵的是那三個值」。突變測試從這裡走過去一次:把 demo
      // 裡的 normalBias 換成寫死的 1.5,上面那一行一聲不吭 —— 因為它是**檢查**在
      // 呼叫那支函式,不是 demo。所以連呼叫點一起釘,而且三份逐字相同。
      const fed = files.map((f) => {
        const m = /skyKeyFullDeg\(\n\s*sunLight\.shadow\.camera\.right, sunLight\.shadow\.mapSize\.x, sunLight\.shadow\.normalBias\);/
          .exec(demoScript(f));
        return m ? m[0] : '';
      });
      check('收光的門檻由每個世界自己的 shadow 設定算出來 —— 電子的 normalBias 1.2 給出不一樣的角度',
        full[0] === full[1] && full[2] > full[0] && full[0] > 5 && full[2] < 45
        && fed.every((x) => x !== '' && x === fed[0]),
        `plastic/paper ${full[0].toFixed(2)}° / circuit ${full[2].toFixed(2)}°`
        + (fed.every((x) => x !== '') ? '' : ' —— 但餵進去的不是 sunLight.shadow'));
      // 0° 與地平線以下全部給 0:主光不照、陰影不投(applyDayNight 那兩行),
      // 天光接手。這三個角度就是使用者點名要 demo 回答的那三個。
      const zeroed = [0, -5, -10].every((e) => gains.every((g, i) => g.skyKeyGainAt(e, full[i]) === 0));
      // 而正午必須是**全額** —— 這根滑桿不准改變預設外觀。
      const noonFull = gains.every((g, i) => g.skyKeyGainAt(noonElev, full[i]) === 1);
      check('主光在 0° / −5° / −10° 一律收到 0(陰影跟著關),正午仍然是全額',
        zeroed && noonFull,
        `gain(0°)=${gains[0].skyKeyGainAt(0, full[0])} gain(${noonElev.toFixed(1)}°)=`
        + `${gains[0].skyKeyGainAt(noonElev, full[0])}`);
      // 反向對照:這條斜坡真的在**動**(不是一支永遠回 0 或永遠回 1 的函式),
      // 而且是單調的 —— 不然上面兩條在「gain 根本沒接上」時也會過。
      let mono = true, span = 0;
      for (let e = 0; e <= 90; e += 0.5) {
        const a = gains[0].skyKeyGainAt(e, full[0]);
        const b = gains[0].skyKeyGainAt(e + 0.5, full[0]);
        if (b < a) mono = false;
        if (a > 0 && a < 1) span += 0.5;
      }
      check('…而且那條斜坡是活的:單調上升,而且真的有一段中間值',
        mono && span > 5, `中間值涵蓋 ${span}° 的仰角`);
      // 送得到:三份 demo 的 applyDayNight 都把增益**乘**進主光、並且用它關陰影,
      // 而且那兩行逐字相同。「宣告了不等於送得到」——normalBias 那次就是這樣。
      const wired = files.map((f) => {
        const s = demoScript(f);
        const m = /\n(\s*sunLight\.intensity = \(DAY\.sunI \+ \(NIGHT\.sunI - DAY\.sunI\) \* k\) \* skyKeyGain;\n\s*sunLight\.castShadow = skyKeyGain > 0;)\n/
          .exec(s);
        return m ? m[1].trim() : '';
      });
      check('三份 demo 都把增益乘進主光、並用它關掉陰影,而且那兩行逐字相同',
        wired.every((w) => w !== '' && w === wired[0]),
        wired[0] ? wired[0].split('\n')[0].trim() : '(找不到)');

      // 而 gameview 抄過來的那兩支,跟**執行 demo 原始碼**得到的逐位元組相同
      // (§0.0 第 5 點:不比對抄進來的常數,比對跑出來的值)。掃過整條斜坡與
      // 兩個世界的門檻,不是只點一個角度 —— 只點一個角度的話,把 smoothstep
      // 換成 clamp 也照樣過。
      let drift = 0, worst = '';
      for (const [i, g] of gains.entries()) {
        const oursFull = skyKeyFullDeg(all[i].right, all[i].mapSize, all[i].normalBias);
        if (oursFull !== full[i]) { drift++; worst = `門檻 ${oursFull} ≠ ${full[i]}`; }
        for (let e = -15; e <= 90; e += 0.25) {
          const ours = skyKeyGainAt(e, oursFull);
          const theirs = g.skyKeyGainAt(e, full[i]);
          if (ours !== theirs) { drift++; if (!worst) worst = `${e}° → ${ours} ≠ ${theirs}`; }
        }
      }
      check('gameview 的 skyKeyFullDeg / skyKeyGainAt 跟執行 demo 得到的逐位元組相同',
        drift === 0, drift === 0 ? `3 個世界 × 421 個仰角全中` : `${drift} 處不同:${worst}`);
    }

    // 7. 網址是真相來源(跟設定面板同一套機制),而鎖是一道**牆**。整個 SKY 區塊
    //    —— 含讀網址與那顆 fa-lock 背後的狀態 —— 在替身上跑起來,直接問它。
    const runSky = (f: string, search: string): {
      target: number; locked: boolean; set: (p: number) => boolean;
    } => {
      const sec = skySection(f);
      const a = sec.indexOf('const SKY_NOON =');
      if (a < 0) throw new Error(`no sky block in ${f}`);
      // 圓盤的替身。天球落地之後這一段會讀圓盤的幾何半徑、寫它的 scale ——
      // 那不是這條檢查在問的事,但替身得長得像,不然整段跑不起來。
      const disc = (r: number): unknown => ({
        position: new THREE.Vector3(1, 1, 1),
        scale: new THREE.Vector3(1, 1, 1),
        geometry: { parameters: { radius: r } },
        lookAt: () => {},
      });
      // 天球的三個界是**世界自己宣告的**(SKY 區塊只讀它們),所以從那份 demo 讀。
      const shell = (n: string): number =>
        demoNum(demoScript(f), new RegExp(`const ${n} = (\\d+);`), `${n} in ${f}`);
      const light = new THREE.DirectionalLight();
      configureSunShadow(light);
      return new Function(
        'location', 'sunDisc', 'moonDisc', 'skyAnchor', 'applyDayNight', 'sunLight',
        'SKY_SHELL_MIN', 'SKY_SHELL_R', 'SKY_SHELL_MAX',
        `let nightBlend = 0;\n${sec.slice(a)}\nreturn skyControl;`,
      )({ search }, disc(42), disc(34), { position: new THREE.Vector3() }, () => {}, light,
        shell('SKY_SHELL_MIN'), shell('SKY_SHELL_R'), shell('SKY_SHELL_MAX'));
    };
    const modes: [string, number, boolean][] = [
      ['', 0.5, false],                    // 預設就是正午 —— 滑桿沒改變預設外觀
      ['?sky=0.75', 0.75, false],
      ['?night=1', 0, false],              // 別名,既有自檢不用動
      ['?sky=0.5&night=1', 0.5, false],    // 明講的 ?sky= 壓過別名
      ['?sky=1.25', 0.25, false],          // 相位繞回去,不是夾住
      ['?sky=0.3&skylock=1', 0.3, true],
    ];
    let badQs = '';
    for (const f of files) {
      for (const [qs, want, lock] of modes) {
        const c = runSky(f, qs);
        if (c.target !== want || c.locked !== lock) {
          badQs += ` ${f.split('/').pop()}「${qs || '(空)'}」→ ${c.target}/${c.locked}`;
        }
      }
    }
    check('三份 demo 對 ?sky= / ?night= / ?skylock= 解出同一組天相',
      badQs === '', badQs || `${modes.length} 組 × ${files.length} 份全中`);
    // 鎖住 = 頁面裡沒有任何東西改得動天相。換地點 / 換世界 / 圖磚重載靠網址帶著
    // 它,?d= 跳里程與 chunk 重建靠這道牆(chunk 是拿當下的 nightBlend 補的)。
    const locked = runSky(files[0], '?sky=0.3&skylock=1');
    const free = runSky(files[0], '?sky=0.3');
    check('?skylock=1 之後沒有東西改得動天相,拿掉就改得動',
      locked.set(0.7) === false && locked.target === 0.3
      && free.set(0.7) === true && free.target === 0.7,
      `鎖住 ${locked.target} / 沒鎖 ${free.target}`);
  }
}

/**
 * The frustum: it must contain every caster the box can hold, at every hour.
 *
 * This is where the port stops copying. `near = 20 / far = 600` are safe in the
 * demos ONLY because their sun never moves; ours swings from the horizon to
 * overhead. The counter-example at the end of this block is the evidence for
 * that claim, run rather than asserted in prose.
 *
 * The sweep used to start at 15 — sky-and-fog's `MIN_LIGHT_ELEV`. That clamp is
 * gone (the demos收的是光不是角度, `skyKeyGainAt`), so the sweep starts at 0.
 * None of the numbers it tests moved: `SHADOW_HALF_DEPTH` is `hypot(E√2, V)`,
 * the maximum over the WHOLE sphere of directions, so it never depended on where
 * the clamp sat — which is the property the wider start now demonstrates rather
 * than assumes.
 */
function checkShadowFrustum(): void {
  console.log('\n[shadow frustum vs the sun\'s whole range]');

  const E = SHADOW_HALF_EXTENT;
  const V = SHADOW_VERTICAL_REACH;
  const dir = new THREE.Vector3();
  const corner = new THREE.Vector3();

  // Every direction the key light can take: elevation from the horizon up
  // (nothing clamps it any more), azimuth free.
  const sweep = (
    lightDistance: number, near: number, far: number, at: (y: number) => number[],
  ): { worst: string; inside: boolean; minD: number; maxD: number } => {
    let minD = Infinity;
    let maxD = -Infinity;
    let worst = '';
    let inside = true;
    for (let elev = 0; elev <= 90; elev += 1) {
      for (let azim = 0; azim < 360; azim += 5) {
        dir.setFromSphericalCoords(1, D2R * (90 - elev), D2R * azim);
        for (const y of at(0)) {
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              corner.set(sx * E, y, sz * E);
              const d = lightDistance - dir.dot(corner);
              if (d < minD) minD = d;
              if (d > maxD) maxD = d;
              if ((d < near - 1e-6 || d > far + 1e-6) && inside) {
                inside = false;
                worst = `elev ${elev}° azim ${azim}° y ${y} → depth ${d.toFixed(1)} m`;
              }
            }
          }
        }
      }
    }
    return { worst, inside, minD, maxD };
  };

  const ours = sweep(SHADOW_LIGHT_DISTANCE, SHADOW_NEAR, SHADOW_FAR, () => [V, -V]);
  check('the whole box stays between near and far, at every hour of the day',
    ours.inside,
    `depth ${ours.minD.toFixed(1)}…${ours.maxD.toFixed(1)} m in [${SHADOW_NEAR}, ${SHADOW_FAR.toFixed(1)}]`);
  // …and no wider than it has to be. Both ends are asserted because a frustum
  // padded "to be safe" is how a depth range quietly becomes 10 km.
  check('and it is exactly that big — a metre off either plane and the box clips',
    Math.abs(ours.minD - SHADOW_NEAR) < 0.5 && Math.abs(ours.maxD - SHADOW_FAR) < 0.5,
    `slack ${(ours.minD - SHADOW_NEAR).toFixed(2)} m near, ${(SHADOW_FAR - ours.maxD).toFixed(2)} m far`);

  // The counter-example — rebuilt, because its premise is gone.
  //
  // 它原本靠的是「demo 的太陽整場不動」,所以只能拿 gameview 的角度範圍去假設。
  // demo 現在自己有一根天相滑桿了,反例因此改成掃**demo 自己那條弧**:SKY 區塊
  // 的純函式從 HTML 切出來執行(§0.0 第 5 點,不比對抄進來的常數),一格一格問
  // 它主光在哪。而且垂直帶取 **V = 0** —— demo 的地面是一張平的切割墊,不借
  // gameview 的 383.5 m 來把話講大;連平地都撐不住才是真的撐不住。
  const demo = readDemoShadow(SHADOW_DEMOS.plastic);
  const demoDist = Math.hypot(...demo.followOffset);
  const demoArc = (() => {
    const src = readFileSync(SHADOW_DEMOS.plastic, 'utf8');
    const a = src.indexOf('const SKY_NOON ='), b = src.indexOf('  // ── 這根滑桿接到世界上');
    if (a < 0 || b <= a) throw new Error('demo no longer declares a sky arc');
    return new Function(`${src.slice(a, b)}\nreturn skyCelestial;`)() as
      (p: number) => { key: { x: number; y: number; z: number }; keyElev: number };
  })();
  /** Worst (smallest) depth any corner of a ±E × ±band box reaches on the demo's own arc. */
  const arcWorst = (
    lightDistance: number, band: number,
  ): { depth: number; phase: number; elev: number } => {
    let depth = Infinity, phase = -1, elev = 0;
    for (let i = 0; i < 2000; i++) {
      const p = i / 2000;
      const st = demoArc(p);
      const inv = 1 / Math.hypot(st.key.x, st.key.y, st.key.z);
      dir.set(st.key.x * inv, st.key.y * inv, st.key.z * inv);
      for (const y of [band, -band]) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            corner.set(sx * E, y, sz * E);
            const d = lightDistance - dir.dot(corner);
            if (d < depth) { depth = d; phase = p; elev = st.keyElev; }
          }
        }
      }
    }
    return { depth, phase, elev };
  };
  const demoOwn = arcWorst(demoDist, 0);
  check('the demo\'s own near/far do NOT survive the demo\'s OWN sky slider — even on flat ground',
    demoOwn.depth < demo.near,
    `天相 ${demoOwn.phase.toFixed(3)}(主光 ${demoOwn.elev.toFixed(1)}°):框的遠角落落在 `
    + `${demoOwn.depth.toFixed(1)} m,而 near 是 ${demo.near}`);
  // …and no `far` can rescue it: the light itself is parked too close. An
  // orthographic box of half-extent E projects at most hypot(E√2, V) onto the
  // light axis (that IS the derivation SHADOW_HALF_DEPTH comes from), so the
  // light has to stand at least `near + that` away. The demo hangs it at
  // |(150, 190, 90)| and its own ±180 box needs 254.6 m of that before the
  // ground has any relief at all.
  const needFlat = demo.near + SHADOW_HALF_EXTENT * Math.SQRT2;
  check('…and no far plane can rescue it: the light distance itself is short of near + E√2',
    demoDist < needFlat,
    `light at ${demoDist.toFixed(1)} m < ${needFlat.toFixed(1)} m (short by `
    + `${(needFlat - demoDist).toFixed(1)} m, with V = 0)`);
  // The positive half: ours is elevation-INDEPENDENT by construction. `sweep`
  // above walks the whole sphere in 1° steps; this walks the demo's OWN arc in
  // 2000 phases, so the two agree from different directions.
  const oursOnArc = arcWorst(SHADOW_LIGHT_DISTANCE, V);
  check('ours holds at every phase of the demo\'s arc — including below 15°, down to 0°',
    oursOnArc.depth >= SHADOW_NEAR - 1e-6,
    `worst 天相 ${oursOnArc.phase.toFixed(3)}(主光 ${oursOnArc.elev.toFixed(1)}°) → `
    + `${oursOnArc.depth.toFixed(1)} m ≥ near ${SHADOW_NEAR}`);

  // ── Scenarios, in the world's own numbers rather than the constant's ──
  //
  // Measured on the saved 45 km Taipei route: DEM within 180 m of the road spans
  // +94.7 … −107.5 m, and BOXSTATS puts the tallest extruded building at 161 m.
  const ROUTE_TALLEST_CASTER = 94.7 + 161;
  const ROUTE_DEEPEST_RECEIVER = -107.5;
  const measured = sweep(SHADOW_LIGHT_DISTANCE, SHADOW_NEAR, SHADOW_FAR,
    () => [ROUTE_TALLEST_CASTER, ROUTE_DEEPEST_RECEIVER]);
  check('a 161 m tower on the route\'s highest ground still casts, at every hour',
    measured.inside, `+${ROUTE_TALLEST_CASTER} m … ${ROUTE_DEEPEST_RECEIVER} m`);

  // What the headroom is FOR. The route that was measured is a river-valley city
  // ride; the game imports GPX, and a mountain route puts a 300 m wall beside the
  // road. Shave the band to the measurement and this is the case that goes.
  const mountain = sweep(SHADOW_LIGHT_DISTANCE, SHADOW_NEAR, SHADOW_FAR, () => [300, -300]);
  check('so does a 300 m hillside — the band is not shaved to the one route it was measured on',
    mountain.inside, `±300 m`);

  // …and the check can fail. A band nothing escapes would be a band that proves
  // nothing about its size.
  const absurd = sweep(SHADOW_LIGHT_DISTANCE, SHADOW_NEAR, SHADOW_FAR, () => [900, -900]);
  check('a 900 m cliff does NOT fit — the containment test has teeth',
    !absurd.inside, absurd.worst);

  // The exported helper agrees with the arithmetic above: it is what the frustum
  // is derived from, so a drift between them would make every check here vacuous.
  dir.setFromSphericalCoords(1, D2R * 30, D2R * 210);
  corner.set(37, -12, 91);
  check('shadowDepthOf() is the same projection the sweep uses',
    Math.abs(shadowDepthOf(dir, corner) - (SHADOW_LIGHT_DISTANCE - dir.dot(corner))) < 1e-9);
}

/**
 * The box rides with the rider, and survives a floating-origin rebase.
 *
 * Driven through three's OWN shadow camera (`LightShadow.updateMatrices`) rather
 * than through our arithmetic — the question is where three will actually
 * project a caster, and only three can answer that.
 */
function checkShadowRidesWithRider(): void {
  console.log('\n[shadow box rides with the rider]');

  const light = new THREE.DirectionalLight();
  const target = new THREE.Object3D();
  light.target = target;
  configureSunShadow(light);

  const dir = new THREE.Vector3().setFromSphericalCoords(1, D2R * (90 - 47), D2R * 140);
  const project = (rider: THREE.Vector3, caster: THREE.Vector3): THREE.Vector3 => {
    anchorSunShadow(light, target, rider, dir);
    light.updateMatrixWorld(true);
    target.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);
    return caster.clone().applyMatrix4(light.shadow.camera.matrixWorldInverse);
  };

  // 4 km down a route, which is where the pre-port arrangement fell apart.
  const rider = new THREE.Vector3(2800, 61, -2900);
  const caster = new THREE.Vector3(2800 + 40, 61 + 30, -2900 - 25);
  const before = project(rider, caster);

  const atRider = project(rider, rider.clone());
  check('the box is centred on the rider — the rider sits on the shadow camera\'s axis',
    Math.abs(atRider.x) < 1e-3 && Math.abs(atRider.y) < 1e-3
    && Math.abs(atRider.z + SHADOW_LIGHT_DISTANCE) < 1e-3,
    `rider at (${atRider.x.toFixed(3)}, ${atRider.y.toFixed(3)}, ${atRider.z.toFixed(1)}) in shadow space`);

  // A rebase moves the whole scene by one delta — rider and casters together.
  const delta = new THREE.Vector3(-1731.4, -58.25, 2604.9);
  const after = project(rider.clone().add(delta), caster.clone().add(delta));
  check('a floating-origin rebase does not move the shadows',
    after.distanceTo(before) < 1e-3,
    `caster moved ${after.distanceTo(before).toExponential(1)} m in shadow space`);

  // And the bug this replaces: a key light parked at a fixed radius about the
  // SCENE ORIGIN, which is what sky-and-fog used to do. Same caster, same hour.
  light.position.copy(dir).multiplyScalar(200);
  target.position.set(0, 0, 0);
  light.updateMatrixWorld(true);
  target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  const origin = caster.clone().applyMatrix4(light.shadow.camera.matrixWorldInverse);
  check('parked at the scene origin instead, the same caster is nowhere near the box',
    Math.max(Math.abs(origin.x), Math.abs(origin.y)) > SHADOW_HALF_EXTENT,
    `(${origin.x.toFixed(0)}, ${origin.y.toFixed(0)}) vs a ±${SHADOW_HALF_EXTENT} m box`);
}

/**
 * SkyAndFog hands the light its DIRECTION and stops writing its position — and,
 * since the `MIN_LIGHT_ELEV` clamp came out, what the key light **actually ends
 * up holding** after a real `applyLighting`: `.intensity` and `.castShadow`.
 *
 * The second half is deliberately not a test of `skyKeyGainAt`. A pure function
 * asserted against itself is the shape that let five things this session be
 * "recorded but never delivered"; these run the real update path and then read
 * the light.
 */
async function checkKeyLightDirectionRouting(): Promise<void> {
  console.log('\n[key light direction routing]');

  const fake = fakeGameRenderer();
  fake.directionalLight.position.set(123, 456, 789);
  const sky = new SkyAndFog(fake as never) as any;
  sky.init();
  sky.setPalette(createPlasticTerrainStyle().skyPalette);

  const apply = (elevation: number, azimuth: number): void => {
    sky.applyLighting({
      sunElevation: elevation, sunAzimuth: azimuth,
      moonElevation: elevation, moonAzimuth: azimuth,
      isDaytime: elevation > 0, dayFactor: elevation > 0 ? 1 : 0,
      moonPhase: 0.5, moonIllumination: 0.5,
    }, new THREE.Vector3());
  };

  apply(63, 214);
  check('sky-and-fog aims the key light through setKeyLightDirection',
    fake.keyLightCalls.length === 1 && fake.keyLightCalls[0][0] === 63 && fake.keyLightCalls[0][1] === 214,
    JSON.stringify(fake.keyLightCalls));
  check('…and no longer writes the light\'s position, which now carries the rider anchor',
    fake.directionalLight.position.equals(new THREE.Vector3(123, 456, 789)));

  // 仰角是**真的**。這裡原本斷言的是「地平線以下的太陽會被夾到 MIN_LIGHT_ELEV
  // = 15° 才送出去」——那個夾值沒有 demo 依據,而且它把日出畫成早上九點。demo
  // 的答案往反方向走:低角度是真的,收的是**光**(skyKeyGainAt),不是角度。
  apply(-31, 88);
  check('地平線以下的太陽照樣以真實仰角送進去 —— MIN_LIGHT_ELEV 那道夾值已經刪掉',
    fake.keyLightCalls[1][0] === -31, `${fake.keyLightCalls[1][0]}°`);

  // ── 主光**實際上**拿到什麼 ──
  //
  // 「記錄了 ≠ 送得到」。上面兩條問的是 setKeyLightDirection 收到什麼;這裡問的是
  // 跑完一次真的 applyLighting 之後,那盞 `directionalLight` 身上的 `.intensity`
  // 與 `.castShadow` 變成什麼 —— 純函式回什麼不算數。
  const light = fake.directionalLight;
  const palette = createPlasticTerrainStyle().skyPalette;
  /** 沒有增益時 applyLighting 會寫進去的值,由同一支 computeDayNightLighting 算。 */
  const baseAt = (elev: number): number => computeDayNightLighting({
    sunElevation: elev, sunAzimuth: 88, moonElevation: elev, moonAzimuth: 88,
    moonPhase: 0.5, isDaytime: elev > 0, dayFactor: elev > 0 ? 1 : 0,
  } as CelestialState, 'sunny', palette).directionalIntensity;
  /** 門檻由**那盞燈自己那塊 shadow** 算出來,跟 demo 同一支函式、同一組引數。 */
  const fullOf = (): number => skyKeyFullDeg(
    light.shadow.camera.right, light.shadow.mapSize.x, light.shadow.normalBias);

  // 正午(demo 那顆釘死的太陽,47.36°):增益 1,主光**一格都沒動**。乘法是不是
  // 真的發生過,由下面幾條負責 —— 這一條負責「預設外觀沒被這次移植改掉」。
  const NOON_ELEV = Math.asin(190 / Math.hypot(150, 190, 90)) / D2R;
  apply(NOON_ELEV, 88);
  check('正午(demo 那顆太陽 47.36°)主光拿到的是全額,陰影照投 —— 預設外觀一格都沒動',
    light.intensity === baseAt(NOON_ELEV) && light.castShadow
    && fake.keyLightGains[fake.keyLightGains.length - 1] === 1,
    `intensity ${light.intensity} = base ${baseAt(NOON_ELEV)}, castShadow ${light.castShadow}`);

  // 0° / −5° / −10°:使用者點名要 demo 回答的那三個角度。主光不照、陰影不投。
  const zeroed = [0, -5, -10].map((e) => {
    apply(e, 88);
    return { e, i: light.intensity, cast: light.castShadow, base: baseAt(e) };
  });
  check('0° / −5° / −10°:主光的 intensity 收到 0,castShadow 一起關掉 —— 天光接手',
    zeroed.every((z) => z.i === 0 && !z.cast && z.base > 0),
    zeroed.map((z) => `${z.e}° → ${z.i}(不收的話是 ${z.base.toFixed(2)})`).join(' / '));

  // 而斜坡真的在中間:一個既不是 0 也不是全額的仰角,陰影仍然開著。
  apply(10, 88);
  const mid = { i: light.intensity, base: baseAt(10), cast: light.castShadow };
  check('中途的仰角拿到的是中間值(不是 0 也不是全額),而且陰影還開著',
    mid.i > 0 && mid.i < mid.base && mid.cast
    && Math.abs(mid.i - mid.base * skyKeyGainAt(10, fullOf())) < 1e-12,
    `10° → ${mid.i.toFixed(3)} / ${mid.base.toFixed(3)}(gain ${skyKeyGainAt(10, fullOf()).toFixed(4)})`);

  // 逐世界:門檻是那盞燈自己的 normalBias 算出來的,所以電子世界的 1.2 在同一個
  // 仰角上拿到的**比較少**。這條走的是真的 setSunShadowNormalBias 會寫的那個欄位。
  const BETWEEN = 20.5; // 落在 plastic/paper 19.42° 與 circuit 21.65° 中間
  apply(BETWEEN, 88);
  const wide = light.intensity;
  light.shadow.normalBias = 1.2;
  apply(BETWEEN, 88);
  const tight = light.intensity;
  check('逐世界的門檻真的傳到主光:同一個仰角,電子的 normalBias 1.2 拿到的比較少',
    wide === baseAt(BETWEEN) && tight < wide && tight > 0
    && fullOf() > 21 && fullOf() < 22,
    `${BETWEEN}° → 1.5: ${wide.toFixed(4)}(門檻 19.42°) / 1.2: ${tight.toFixed(4)}(門檻 ${fullOf().toFixed(2)}°)`);
  light.shadow.normalBias = SHADOW_NORMAL_BIAS;

  // castShadow 的**兩個**擁有者。品質層級把陰影整個關掉時,天相增益不准把它偷偷
  // 打開 —— 那會在剛要求少一點的機器上換來一輪 shader 重編。
  fake.setShadowLevel('off');
  apply(NOON_ELEV, 88);
  check('品質層級關掉陰影時,正午的增益也打不開它 —— castShadow 有兩個擁有者',
    !light.castShadow && light.intensity === baseAt(NOON_ELEV),
    `castShadow ${light.castShadow},intensity 照樣是全額 ${light.intensity}`);
  fake.setShadowLevel('full');
  apply(NOON_ELEV, 88);
  check('層級收回來就恢復投影(這條測試本身是活的)', light.castShadow);

  // ══ 夜間地板 ══════════════════════════════════════════════════════════════
  //
  // demo 的夜**是有主光的**:它的月亮是太陽的正對面,所以 `?night=1` 的當班天體
  // 站在 +47.38°、gain 恰好 1、拿的是 `skyPalette.night` 的 sunColor / sunIntensity。
  // gameview 的月亮不是正對面(`sun-moon-calc.ts`:`-sunElev × (0.3 + 0.7·滿月度)`),
  // 虧月時它掛得低,`skyKeyGainAt` 於是收掉一截 demo 從來不收的光 —— 剩下半球光
  // (藍紫)與環境光扛整個夜。地板補的就是那一截,而且**只補照明**。
  //
  // 上面每一條都還在,而且是這一條的反向對照:0° / −5° / −10° 依然是 0(當班天體
  // 在地平線下就沒有東西可以補),正午依然是全額(地板在地平線以上恆為 0)。
  const applySunMoon = (sunElev: number, moonElev: number): void => {
    sky.applyLighting({
      sunElevation: sunElev, sunAzimuth: 88,
      moonElevation: moonElev, moonAzimuth: 268,
      moonPhase: 0.5, isDaytime: sunElev > 0, dayFactor: sunElev > 0 ? 1 : 0,
    }, new THREE.Vector3());
  };
  /** gameview 自己那支月亮模型,照抄 `sun-moon-calc.ts` 的 `moonPosition`。 */
  const moonElevOf = (sunElev: number, phase: number): number =>
    -sunElev * (0.3 + 0.7 * (1 - 2 * Math.abs(phase - 0.5)));

  // 台北 21:00 的太陽仰角,兩種月相 —— 這就是「無月的夜」與「月圓的夜」。
  const NIGHT_SUN = -27.05;
  const NEW_MOON = moonElevOf(NIGHT_SUN, 0);   // +8.115°
  const FULL_MOON = moonElevOf(NIGHT_SUN, 0.5); // +27.05°

  // 1) 逐世界:無月的夜,主光實際拿到的**就是這個世界 skyPalette.night 的那一盞**。
  //    值(0.7 / 0.7 / 0.62)與門檻(19.4175° / 19.4175° / 21.6529°)都是逐世界的。
  {
    const worlds: [string, Awaited<ReturnType<typeof createTerrainStyleStrategy>>][] = [
      ['plastic', await createTerrainStyleStrategy('plastic')],
      ['paper', await createTerrainStyleStrategy('paper')],
      ['circuit', await createTerrainStyleStrategy('circuit')],
    ];
    const rows: string[] = [];
    let allOk = true, anyBare = false;
    for (const [name, strat] of worlds) {
      sky.setPalette(strat.skyPalette);
      light.shadow.normalBias = strat.shadowNormalBias ?? SHADOW_NORMAL_BIAS;
      const full = fullOf();
      const bare = skyKeyGainAt(NEW_MOON, full);          // 沒有地板時的增益
      applySunMoon(NIGHT_SUN, NEW_MOON);
      // 「增益變成 1」問的是 ===(同一支 computeDayNightLighting,同一條路);
      // 「而那個值就是色票裡的那一個」只能問到 1e-12 —— `lerp(2.0, 0.62, 1)` 是
      // 0.6200000000000001,那是 IEEE 的零頭,不是移植走樣。
      const want = computeDayNightLighting({
        sunElevation: NIGHT_SUN, sunAzimuth: 88,
        moonElevation: NEW_MOON, moonAzimuth: 268,
        moonPhase: 0.5, isDaytime: false, dayFactor: 0,
      } as CelestialState, 'sunny', strat.skyPalette).directionalIntensity;
      const declared = strat.skyPalette.night.sunIntensity;
      const ok = light.intensity === want
        && Math.abs(want - declared) < 1e-12
        && light.color.getHex() === strat.skyPalette.night.sunColor;
      if (!ok) allOk = false;
      if (bare < 0.5) anyBare = true;
      rows.push(`${name} ${light.intensity.toFixed(4)}(色票 ${declared},沒地板只有 `
        + `${(declared * bare).toFixed(4)})`);
    }
    check('無月的夜:三個世界的主光拿到的正好是自己 skyPalette.night 的那一盞',
      allOk && anyBare, rows.join(' / '));
    sky.setPalette(palette);
    light.shadow.normalBias = SHADOW_NORMAL_BIAS;
  }

  // 2) 月圓的夜地板**一格都沒動** —— demo 的弧上月亮就在 −sunElev,真月亮追平它,
  //    所以 max(gain, floor) 兩邊相等。使用者實騎那一晚(月相 0.466)走的正是這條。
  applySunMoon(NIGHT_SUN, FULL_MOON);
  const atFull = light.intensity;
  const fullGain = skyKeyGainAt(FULL_MOON, fullOf());
  check('月圓的夜:真月亮追平 demo 的弧,地板一格都沒動',
    nightKeyFloorGain(NIGHT_SUN, FULL_MOON, fullOf()) === fullGain
    && atFull === baseAt(NIGHT_SUN) * fullGain,
    `gain ${fullGain} = floor ${nightKeyFloorGain(NIGHT_SUN, FULL_MOON, fullOf())},`
    + `intensity ${atFull.toFixed(4)}`);

  // 3) 「不該亮的時候亮了也要失敗」之一:**整個白天一格都沒動**。掃 0…90°,
  //    月亮放在 demo 的正對面位置,逐點要求 `===` 沒有地板時的值。
  {
    let drift = 0, worst = '';
    for (let e = 0; e <= 90; e += 0.25) {
      applySunMoon(e, -e);
      const want = baseAt(e) * skyKeyGainAt(e, fullOf());
      if (light.intensity !== want) {
        drift++;
        if (!worst) worst = `${e}° → ${light.intensity} ≠ ${want}`;
      }
    }
    check('地平線以上一格都沒動:361 個仰角逐點 === 沒有地板時的值',
      drift === 0, drift === 0 ? '361 / 361' : `${drift} 處不同:${worst}`);
  }

  // 4) 「不該亮的時候亮了也要失敗」之二:**當班天體在地平線下就沒有東西可以補**。
  //    這是 demo 自己的規矩(gain(0°) = gain(−5°) = 0),地板不准繞過它。
  {
    const under = [0, -5, -10].map((m) => {
      applySunMoon(NIGHT_SUN, m);
      return { m, i: light.intensity, cast: light.castShadow,
        ramp: skyKeyGainAt(-NIGHT_SUN, fullOf()) };
    });
    check('當班天體在地平線下:地板不補、陰影不投 —— 即使太陽已經沉到 −27°',
      under.every((u) => u.i === 0 && !u.cast && u.ramp === 1),
      under.map((u) => `月 ${u.m}° → ${u.i}(斜坡本身是 ${u.ramp})`).join(' / '));
  }

  // 5) 地板只補**照明**,不准把陰影開回來:無月的夜,送進 setKeyLightShadowGain
  //    的必須還是**真的**增益(0.35 左右),不是被地板抬過的 1。
  applySunMoon(NIGHT_SUN, NEW_MOON);
  const shadowGain = fake.keyLightGains[fake.keyLightGains.length - 1];
  const realGain = skyKeyGainAt(NEW_MOON, fullOf());
  check('地板只影響照明:陰影拿到的還是真月亮的增益,不是被抬過的那個',
    shadowGain === realGain && shadowGain < 1
    && light.intensity === baseAt(NIGHT_SUN),
    `陰影增益 ${shadowGain.toFixed(4)},照明增益 ${(light.intensity / baseAt(NIGHT_SUN)).toFixed(4)}`);

  // 6) 反向對照:地板真的在**動**,而且永遠夾在「真月亮」與「demo 的月亮」之間。
  //    只點一個角度的話,一支永遠回 1 的地板也會過上面每一條。
  {
    let lifted = 0, over = 0, under = 0;
    for (let s = -1; s >= -60; s -= 0.5) {
      const m = moonElevOf(s, 0); // 無月
      const full = fullOf();
      const floor = nightKeyFloorGain(s, m, full);
      const real = skyKeyGainAt(m, full);
      const demo = skyKeyGainAt(-s, full);
      if (floor > real) lifted++;
      if (floor > demo) over++;
      if (floor < real) under++;
    }
    check('…而且地板永遠落在「真月亮」與「demo 的月亮」之間,並且真的抬過東西',
      lifted > 20 && over === 0 && under === 0,
      `120 個仰角裡抬高了 ${lifted} 個,超過 demo ${over} 次,低於真月亮 ${under} 次`);
  }
}

/**
 * The flags the four style files have been setting all along must now reach a
 * draw call. A castShadow on a mesh the merger throws away is still dead.
 */
async function checkShadowFlagsReachGeometry(): Promise<void> {
  console.log('\n[shadow flags reach the geometry]');

  const originLat = 25;
  const originLon = 121;

  // ── Terrain: casts AND receives (a deliberate step past the demos' flat
  //    baseboard — gameview's relief and its baseboard are one mesh). ──
  const points = Array.from({ length: 24 }, (_, i) => ({
    lat: originLat, lon: originLon + i * 0.0009, ele: 40 + i,
  }));
  const cum = points.map((_, i) => i * 90);
  const terrainStyle = createPlasticTerrainStyle();
  const terrain = await buildTerrainChunk(
    { points, cumulativeDistances: cum, startIdx: 0, endIdx: points.length - 1, chunkIndex: 0 },
    FLAT_SAMPLER, originLat, originLon, 0, terrainStyle,
  );
  check('terrain casts and receives',
    terrain.mesh.castShadow && terrain.mesh.receiveShadow,
    `cast=${terrain.mesh.castShadow} recv=${terrain.mesh.receiveShadow}`);
  terrain.mesh.geometry.dispose();

  // ── Road: receives only. The ribbon lies ON the terrain, so a road that does
  //    not sample the map cuts a lit strip through every shadow crossing it. ──
  const roadFeats = [{
    layer: 'transportation',
    properties: { class: 'primary' },
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [p.lon, p.lat]),
    },
  }] as never;
  // `ground` must answer — the ribbon drapes on the chunk's height grid, and the
  // default `() => null` reads as "outside this corridor" and drops every road.
  const roads = await buildRoadMeshes(
    roadFeats, FLAT_SAMPLER, originLat, originLon, 0, terrainStyle, () => 0,
  );
  check('road receives, and does not cast',
    roads.meshes.length > 0
    && roads.meshes.every((m) => m.receiveShadow && !m.castShadow),
    `${roads.meshes.length} road draw(s)`);
  disposeRoadMesh(roads);

  // ── Landuse: same contract, same reason. ──
  const square = (i: number): [number, number][] => {
    const lon = originLon + i * 0.003;
    return [[lon, originLat], [lon + 0.002, originLat], [lon + 0.002, originLat + 0.002],
      [lon, originLat + 0.002], [lon, originLat]];
  };
  const landuseFeats = [
    { layer: 'landuse', geometry: { type: 'Polygon', coordinates: [square(0)] }, properties: { class: 'residential' } },
    { layer: 'park', geometry: { type: 'Polygon', coordinates: [square(1)] }, properties: { class: 'park' } },
  ] as never;
  const landuse = await buildLanduseMeshes(landuseFeats, FLAT_SAMPLER, originLat, originLon, 0, terrainStyle);
  const landuseDrawn = landuse.layers.filter((l) => l.count > 0);
  check('every landuse layer with polygons in it receives, and none casts',
    landuseDrawn.length > 0
    && landuseDrawn.every((l) => l.mesh.receiveShadow && !l.mesh.castShadow),
    `${landuseDrawn.length} populated layer(s)`);
  disposeLanduseMeshes(landuse);

  // ── Trees: cast AND receive, the demos' box batcher. ──
  const trees = await buildTreeMeshes(
    [{ layer: 'landcover', geometry: { type: 'Polygon', coordinates: [square(2)] }, properties: { class: 'wood' } }] as never,
    FLAT_SAMPLER, originLat, originLon, 0, terrainStyle,
  );
  check('trees cast and receive',
    trees.treeCount > 0 && trees.mesh.castShadow && trees.mesh.receiveShadow,
    `${trees.treeCount} trees`);
  disposeTreeMesh(trees);
  terrainStyle.dispose();

  // ── Buildings, in all three worlds ──
  const footprints = [0, 1, 2, 3, 4, 5].map((i) => ({
    coordinates: synthFootprint(originLat, originLon, i * 45, 0, 18, 14),
    height: 22,
  }));
  /** `world:cast/recv` for every world that actually builds an ink outline. */
  const outlines: string[] = [];
  for (const world of ['plastic', 'paper', 'circuit'] as const) {
    const strategy = await createTerrainStyleStrategy(world);
    const result = await buildBuildingMeshes(
      footprints, FLAT_SAMPLER, originLat, originLon, 0, strategy, () => 0, undefined,
      () => 'commercial' as const,
    );
    const wallMaterial = strategy.createBuildingMaterial();
    const bodies: THREE.Mesh[] = [];
    const decorations: THREE.Mesh[] = [];
    result.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.attributes?.position) return;
      if (m.material === wallMaterial) bodies.push(m);
      else decorations.push(m);
    });
    check(`${world}: every building body casts and receives`,
      bodies.length > 0 && bodies.every((m) => m.castShadow && m.receiveShadow),
      `${bodies.length} body draw(s)`);
    check(`${world}: at least one decoration draw survives the merge still casting`,
      decorations.some((m) => m.castShadow),
      `${decorations.filter((m) => m.castShadow).length} of ${decorations.length} deco draw(s) cast`);

    // The ink outline is an INVERTED HULL — a size larger than the body by
    // construction — so it must never cast, or every shadow in the corrugated
    // world grows by `inkThickness`. Asked of `createOutline` directly rather
    // than looked for in the chunk: with a box-decomposing style the merged-wall
    // path is not taken at all, and a check that finds nothing to look at is a
    // check that always passes.
    const probe = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    probe.castShadow = true;
    probe.receiveShadow = true;
    const outline = strategy.createOutline?.(probe) ?? null;
    if (outline) outlines.push(`${world}:${outline.castShadow}/${outline.receiveShadow}`);
    probe.geometry.dispose();
    (probe.material as THREE.Material).dispose();

    disposeBuildingMesh(result);
    strategy.dispose();
  }
  // Asserted once, across the worlds, with EXISTENCE in the same assertion: a
  // world whose ink is off returns null, and "no outline to check" must not read
  // as "the outline behaves".
  check('the ink outline exists in the world that has one, and does NOT take the body\'s flags',
    outlines.length > 0 && outlines.every((o) => o.endsWith(':false/false')),
    outlines.join(' ') || 'no world built an outline');
}

/**
 * The decoration merge must carry the flags, not average them.
 *
 * `circuit-terrain-style.ts` turns castShadow OFF on ~20 parts that share
 * materials with parts that keep it on (a lens dome and its body are both
 * `lensMat`). The flags are per-DRAW, so a merge that buckets on material alone
 * hands one batch two answers — which is the bug the circuit demo wrote its
 * `batchOf` key to avoid.
 */
async function checkDecorationShadowBatching(): Promise<void> {
  console.log('\n[decoration merge carries the shadow flags]');

  const originLat = 25;
  const originLon = 121;
  const strategy = createPlasticTerrainStyle();
  // ONE material, two parts, opposite castShadow — the exact shape circuit's LED
  // has. Both are plain meshes so they take the merged path, not the template one.
  const shared = new THREE.MeshBasicMaterial({ color: 0x8899aa });
  // The BATCHED path out of the merge takes different code to the merged one, so
  // it gets its own pair: one strategy-owned template, two InstancedMeshes over
  // it that disagree about casting. Tagged the way `markInstanceTemplate` tags.
  const template = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  template.userData.instanceTemplate = true;
  const tplMat = new THREE.MeshBasicMaterial({ color: 0x223344 });
  const stamp = (cast: boolean, y: number): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(template, tplMat, 2);
    for (let i = 0; i < 2; i++) {
      im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 3 - 1.5, y, 0));
    }
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = cast;
    im.receiveShadow = cast;
    return im;
  };
  const staged: TerrainStyleStrategy = Object.assign(
    Object.create(Object.getPrototypeOf(strategy) as object), strategy, {
      buildBuildingDecoration: (b: { height: number }) => {
        const root = new THREE.Group();
        const solid = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), shared);
        solid.position.y = b.height * 0.6;
        solid.castShadow = true;
        solid.receiveShadow = true;
        root.add(solid);
        const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
        glass.position.y = b.height * 0.8;
        glass.castShadow = false;
        glass.receiveShadow = false;
        root.add(glass);
        root.add(stamp(true, b.height * 0.3));
        root.add(stamp(false, b.height * 0.45));
        return root;
      },
    },
  );

  const footprints = [0, 1, 2].map((i) => ({
    coordinates: synthFootprint(originLat, originLon, i * 45, 0, 18, 14),
    height: 20,
  }));
  const result = await buildBuildingMeshes(
    footprints, FLAT_SAMPLER, originLat, originLon, 0, staged, () => 0, undefined,
    () => 'commercial' as const,
  );

  const onShared: THREE.Mesh[] = [];
  result.mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material === shared) onShared.push(m);
  });
  check('one material with two shadow answers becomes TWO draws, not one',
    onShared.length === 2, `${onShared.length} draw(s) on the shared material`);
  const casting = onShared.filter((m) => m.castShadow);
  const notCasting = onShared.filter((m) => !m.castShadow);
  check('…and each draw keeps the answer its own parts gave',
    casting.length === 1 && notCasting.length === 1
    && casting[0].receiveShadow && !notCasting[0].receiveShadow,
    `${casting.length} casting / ${notCasting.length} not`);
  // The parts must actually still be there. A merge that "separated" them by
  // dropping one would satisfy the counts above and lose half the trim.
  const verts = onShared.map((m) => m.geometry.attributes.position.count).sort((a, b) => b - a);
  check('…with every instance still in the buffer (24 verts a box, 3 buildings each)',
    verts.length === 2 && verts[0] === 24 * 3 && verts[1] === 24 * 3,
    verts.join(' + '));

  // The batched path: same template, same material, two answers → two
  // InstancedMeshes. This is a separate code path from the merged one above, and
  // it is the one every repeated part in all three worlds actually takes.
  const onTemplate: THREE.InstancedMesh[] = [];
  result.mesh.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && im.material === tplMat) onTemplate.push(im);
  });
  check('the batched path splits on the flags too',
    onTemplate.length === 2, `${onTemplate.length} instanced draw(s) on the shared template`);
  check('…each carrying its own answer, and all six instances',
    onTemplate.filter((m) => m.castShadow).length === 1
    && onTemplate.filter((m) => !m.castShadow).length === 1
    && onTemplate.every((m) => m.count === 6 && m.receiveShadow === m.castShadow),
    onTemplate.map((m) => `${m.castShadow ? 'cast' : 'no-cast'}×${m.count}`).join(' + '));

  disposeBuildingMesh(result);
  shared.dispose();
  template.dispose();
  tplMat.dispose();
  strategy.dispose();
}

/** The tier ceiling: a tier may reduce how much, not to none. */
function checkShadowQualityTiers(): void {
  console.log('\n[shadow quality tiers]');

  const sizes = Object.fromEntries(
    (['low', 'medium', 'high'] as const).map(
      (t) => [t, SHADOW_MAP_SIZE_BY_LEVEL[QUALITY_PRESETS[t].sunShadow]],
    ),
  ) as Record<'low' | 'medium' | 'high', number>;

  check('no tier turns the sun\'s shadow off — same rule as maxLiveLampLights',
    (['low', 'medium', 'high'] as const).every((t) => QUALITY_PRESETS[t].sunShadow !== 'off'),
    (['low', 'medium', 'high'] as const).map((t) => `${t}=${QUALITY_PRESETS[t].sunShadow}`).join(' '));
  check('the top tier is the demos\' own map, unmodified',
    sizes.high === SHADOW_MAP_SIZE, `${sizes.high}²`);
  check('the N100 tier is cheaper, and by a whole power of two',
    sizes.low < sizes.high && sizes.high % sizes.low === 0 && sizes.high / sizes.low === 2,
    `low ${sizes.low}² vs high ${sizes.high}² — ${((sizes.low / sizes.high) ** 2 * 100).toFixed(0)}% of the depth target`);

  // 'off' is a real level even though no tier picks it: it is the one-word change
  // the N100's avgGpuMs might ask for, so it has to work.
  const stub = { shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap } };
  const light = new THREE.DirectionalLight();
  configureSunShadow(light);
  applySunShadowLevel(stub, light, 'off');
  check('\'off\' really switches it off, light included',
    !stub.shadowMap.enabled && !light.castShadow);

  // Resizing must free the old target. A tier drop that leaked 16 MB per change
  // would be worse than the effect it saves.
  applySunShadowLevel(stub, light, 'full');
  const big = { dispose: 0 };
  light.shadow.map = { dispose: () => { big.dispose++; } } as never;
  applySunShadowLevel(stub, light, 'half');
  check('dropping a tier frees the old depth target and resizes',
    big.dispose === 1 && light.shadow.map === null
    && light.shadow.mapSize.width === SHADOW_MAP_SIZE / 2,
    `${light.shadow.mapSize.width}², ${big.dispose} target freed`);
  // …and does not churn when nothing changed.
  applySunShadowLevel(stub, light, 'half');
  check('re-applying the same level is a no-op', big.dispose === 1);

  // The frustum is set once and never moves with the tier — only the map size
  // does, because `shadowMap.type` is a shader #define and flipping it mid-ride
  // recompiles every material in the scene.
  check('the tier never touches the frustum or the filter',
    light.shadow.camera.right === SHADOW_HALF_EXTENT
    && light.shadow.camera.far === SHADOW_FAR
    && stub.shadowMap.type === THREE.PCFSoftShadowMap);
}

/**
 * Run one block, and never let it take the rest of the suite with it.
 *
 * A throwing block used to abort the whole run: when the route-line meshes were
 * renamed `route/core`, `getObjectByName('core')` returned undefined and the
 * suite stopped there — silently leaving every later block unrun for long
 * enough that three of them bit-rotted against signatures that had since
 * changed. A crash is a failure, not an exit.
 */
async function block(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`  ✗ ${label} THREW — ${(err as Error).message}`);
  }
}

console.log('=== Third-person diorama — headless check ===');

// ═══════════════════════════════════════════════════════════════════════════
// 地圖資料的 class 真的被讀了嗎,以及「一盞燈一份材質」
// ═══════════════════════════════════════════════════════════════════════════
//
// 四件互相獨立、都很小的事,共通點是**它們全部只有量出來才看得見**:
//
//  1. 招牌的種子是那棟建築,不是它在 chunk 陣列裡的位置。
//  2. `water` 圖層的 `class` 有人讀了 —— 游泳池不再是湖。
//  3. `aeroway` 的 Point(`gate`)不會膨脹 `featureCount`。
//  4. 一個世界的路燈共用幾何,而**會被 setNight 寫的材質不共用**。
//  5. 空的地被層不再各自帶一份 three 的預設材質。
//
// 每一條都打在**真的被建出來的東西**上:頂點、mesh 的 geometry 物件、census 數
// 得到的材質 —— 不是打在宣告或設定上。這個 repo 最常見的缺陷是「記錄了 ≠ 送得
// 到」,而 1 跟 4 各自都曾經是那個形狀。
async function checkMapDataAndSharing(): Promise<void> {
  console.log('\n[map data + sharing]');

  const originLat = 25;
  const originLon = 121;

  // ── 1. 招牌的種子是這棟建築,不是它在陣列裡的第幾個 ──
  //
  // `fpIdx` 每個 chunk 從 0 重來,所以整串詞序**每 2 km(CHUNK_LENGTH)原樣重播
  // 一次**:塑膠貨架的前十二家店固定是
  // BOAT CAFE DECO BEAD BOAT MALL DUO MART HALL HALL BAKE BOAT。
  //
  // 這裡量的是招牌的**幾何**,不是 `signContent` 的回傳字串:字串那一層已經有人
  // 驗了,而「換了種子但沒送到招牌上」正是這個 repo 最常見的那種缺陷。
  //
  // ⚠ 只挑**招牌那幾份材質**的 mesh 來雜湊。整塊 chunk 一起雜湊是不行的:本體、
  //   屋頂飾條與宣告的燈**照舊**吃 `fpIdx`(那是逐件 demo diff 釘住的東西,這次
  //   沒有動它),所以把 fpIdx 推移之後整塊 chunk 本來就會變 —— 第一版就是這樣
  //   紅的,而它紅得沒有意義。`mergeBuildingDecorations` 逐材質合併,而招牌的
  //   材質是 strategy 自己那幾份 singleton,所以「材質屬於招牌」= 「這份幾何全部
  //   是招牌」。
  {
    const strat = createPlasticTerrainStyle();
    const routeDist = (_x: number, z: number) => Math.abs(z);
    const box = {
      cx: 0, cz: 0, width: 18, depth: 14, rotY: 0,
      height: 22, baseY: 0, skirt: 1.5, color: 0xcccccc,
    };
    /** 招牌用到的那幾份材質(strategy 的 singleton)—— 12 個 seed 的聯集。 */
    const signMats = new Set<THREE.Material>();
    for (let seed = 0; seed < 12; seed++) {
      mountShopSign(strat, box, 0, seed, 'commercial', routeDist, 0.8)?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
          if (mat) signMats.add(mat);
        }
      });
    }

    const scratch = new THREE.Vector3();
    /** 這個 chunk 裡所有招牌的幾何指紋 —— 減掉這批建築的中心,好跨 chunk 比。 */
    const signHash = (root: THREE.Object3D, cx: number): { hash: string; verts: number } => {
      root.updateMatrixWorld(true);
      const h = createHash('sha256');
      let verts = 0;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        if (!mats.some((x) => x && signMats.has(x))) return;
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;
        h.update(`|${pos.count}|`);
        for (let i = 0; i < pos.count; i++) {
          scratch.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          h.update(`${(scratch.x - cx).toFixed(2)},${scratch.y.toFixed(2)},${scratch.z.toFixed(2)};`);
          verts++;
        }
      });
      return { hash: h.digest('hex'), verts };
    };

    /** 一排 12 棟一模一樣的建築,整排平移 `shiftM` 公尺(= 換一個 chunk)。 */
    const runAt = async (shiftM: number, pad = 0): Promise<{ hash: string; verts: number }> => {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        coordinates: synthFootprint(originLat, originLon, shiftM - 60 + i * 22, 40, 18, 14),
        height: 20 + (i % 3) * 4,
      }));
      // `pad` 塞在前面,把每一棟的 fpIdx 整體推後 —— 「綁陣列位置」的實作會因此
      // 換掉整排的詞,綁地點的不會。
      //
      // 用**退化的**輪廓(兩個點):`buildBuildingMeshes` 在迴圈第一行就
      // `if (fp.coordinates.length < 3) continue`,所以它們一個頂點都不貢獻,
      // 而 `fpIdx` 照樣被它們用掉 —— 換掉的剛好只有種子這一件事。
      const pads = Array.from({ length: pad }, (_, i) => ({
        coordinates: [
          [originLon + i * 1e-5, originLat] as [number, number],
          [originLon + i * 1e-5, originLat] as [number, number],
        ],
        height: 24,
      }));
      const r = await buildBuildingMeshes(
        [...pads, ...rows], FLAT_SAMPLER, originLat, originLon, 0, strat,
        () => 0, routeDist, () => 'commercial',
      );
      const out = signHash(r.mesh, shiftM);
      disposeBuildingMesh(r);
      return out;
    };
    const chunk0 = await runAt(0);
    const chunk1 = await runAt(2000);
    const chunk2 = await runAt(4000);
    const chunk0again = await runAt(0);
    const chunk0padded = await runAt(0, 3);

    check('招牌:(這排真的蓋出招牌幾何了 —— 不然下面四條是空的)',
      chunk0.verts > 0, `${chunk0.verts} 個招牌頂點`);
    check('招牌:同一排建築在下一個 chunk 不再說同樣的話',
      chunk0.hash !== chunk1.hash && chunk1.hash !== chunk2.hash
      && chunk0.hash !== chunk2.hash,
      `${chunk0.hash.slice(0, 8)} / ${chunk1.hash.slice(0, 8)} / ${chunk2.hash.slice(0, 8)}`);
    // 決定論:同一條路線同一個位置,重跑必須拿到同一塊招牌。
    check('招牌:同一個地點重蓋一次,逐位元組相同(決定論沒有被換掉)',
      chunk0.hash === chunk0again.hash, chunk0.hash.slice(0, 16));
    // 而且不隨陣列位置動 —— 這才是換掉 `fpIdx` 真正買到的東西。上游多三個
    // 多邊形、圖磚視窗換一批鄰居、擁有權重新分配,都會把 fpIdx 整體推移。
    check('招牌:在它前面多塞三個(不畫的)輪廓,這一排的招牌一個字都沒變',
      chunk0.hash === chunk0padded.hash,
      `${chunk0.hash.slice(0, 8)} vs ${chunk0padded.hash.slice(0, 8)}`);
    // 反向對照:那三個 pad **真的**把 fpIdx 推移了 —— 不然上一條是恆真句。
    // 本體與飾條照舊吃 fpIdx,所以整塊 chunk 的雜湊必須因為它們而改變。
    {
      const wholeHash = async (pad: number): Promise<string> => {
        const rows = Array.from({ length: 12 }, (_, i) => ({
          coordinates: synthFootprint(originLat, originLon, -60 + i * 22, 40, 18, 14),
          height: 20 + (i % 3) * 4,
        }));
        const pads = Array.from({ length: pad }, (_, i) => ({
          coordinates: [
            [originLon + i * 1e-5, originLat] as [number, number],
            [originLon + i * 1e-5, originLat] as [number, number],
          ],
          height: 24,
        }));
        const r = await buildBuildingMeshes(
          [...pads, ...rows], FLAT_SAMPLER, originLat, originLon, 0, strat,
          () => 0, routeDist, () => 'commercial',
        );
        const h = createHash('sha256');
        r.mesh.updateMatrixWorld(true);
        r.mesh.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
          if (!pos) return;
          h.update(`|${pos.count}|`);
          for (let i = 0; i < pos.count; i++) {
            scratch.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
            h.update(`${scratch.x.toFixed(2)},${scratch.y.toFixed(2)},${scratch.z.toFixed(2)};`);
          }
        });
        disposeBuildingMesh(r);
        return h.digest('hex');
      };
      const w0 = await wholeHash(0);
      const w3 = await wholeHash(3);
      check('招牌:(那三個 pad 真的把 fpIdx 推移了 —— 本體/飾條照舊隨它變)',
        w0 !== w3, `${w0.slice(0, 8)} vs ${w3.slice(0, 8)}`);
    }
    strat.dispose();
  }

  // ── 1b. 反向對照:上面那幾條只有在「這排建築真的掛了招牌」時才有意義 ──
  {
    const strat = createPlasticTerrainStyle();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      coordinates: synthFootprint(originLat, originLon, -60 + i * 22, 40, 18, 14),
      height: 20 + (i % 3) * 4,
    }));
    const r = await buildBuildingMeshes(
      rows, FLAT_SAMPLER, originLat, originLon, 0, strat,
      () => 0, (_x, z) => Math.abs(z), () => 'commercial',
    );
    check('招牌:(這排建築真的掛了招牌 —— 不然上面幾條是空的)',
      (r.signsByZone?.[0]?.[1] ?? 0) >= 6, `${r.signsByZone?.[0]?.[1] ?? 0} 塊`);
    disposeBuildingMesh(r);
    strat.dispose();
  }

  // ── 2. `water` 的 class 有人讀了 ──
  //
  // 那個欄位從來沒被讀過,所以每一座後院泳池都拿到基隆河的材質、基隆河的 0.1 m
  // 板、基隆河的反光。實測(`decodeMVTTile`,3×3 z14 視窗,執行時抓、不存):
  // 洛杉磯 swimming_pool 2901 / lake 7 / pond 9 / river 4 —— 99.3% 是泳池。
  {
    const strat = createPlasticTerrainStyle();
    const H = 2e-4;
    const waterPoly = (cls: string, lon: number): unknown => ({
      layer: 'water',
      properties: { class: cls },
      geometry: {
        type: 'Polygon',
        coordinates: [[[lon - H, 25 - H], [lon + H, 25 - H], [lon + H, 25 + H], [lon - H, 25 + H]]],
      },
    });
    const flat = {
      getElevationSync: () => 0, getElevation: async () => 0,
    } as unknown as Parameters<typeof buildLanduseMeshes>[1];
    const verts = async (classes: string[]): Promise<number> => {
      const r = await buildLanduseMeshes(
        classes.map((c, i) => waterPoly(c, originLon + i * 1e-3)) as never,
        flat, originLat, originLon, 0, strat,
      );
      const g = r.layers.find((l) => l.kind === 'water')!.mesh.geometry;
      const n = (g.getAttribute('position') as THREE.BufferAttribute | undefined)?.count ?? 0;
      disposeLanduseMeshes(r);
      return n;
    };
    const lakeOnly = await verts(['lake']);
    const poolOnly = await verts(['swimming_pool']);
    const both = await verts(['lake', 'swimming_pool']);
    const four = await verts(['lake', 'ocean', 'river', 'pond']);
    check('水面:一座湖有面積(不然下面三條是空的)', lakeOnly > 0, `${lakeOnly} 個頂點`);
    check('水面:一座游泳池一個頂點都不畫', poolOnly === 0, `${poolOnly} 個頂點`);
    check('水面:湖 + 泳池 = 只有那座湖', both === lakeOnly, `${both} vs ${lakeOnly}`);
    // 反向對照:擋掉的只有泳池,不是「小的都不畫」。四個 class 一個都不能少。
    check('水面:ocean / lake / river / pond 四種一個都沒被誤傷',
      four === lakeOnly * 4, `${four} vs ${lakeOnly} × 4`);
    // 未知的 class 要**留著**——這一層照定義就是水,黑名單才是安全的預設值。
    const unknown = await verts(['reservoir_nobody_has_seen_yet']);
    check('水面:沒見過的 class 照樣是水(黑名單,不是白名單)',
      unknown === lakeOnly, `${unknown} vs ${lakeOnly}`);
    strat.dispose();
  }

  // ── 2b. 2D 跟 3D 同一套政策(`road-classes.ts` 那條規矩的水面版) ──
  {
    const cls = (layer: string, c: string): unknown =>
      ({ layer, properties: { class: c }, geometry: { type: 'Point', coordinates: [121, 25] } });
    const got = (layer: string, c: string): string | null =>
      classifyFeature(cls(layer, c) as never);
    check('水面 2D:游泳池不畫、其他水面照畫(兩個 renderer 同一份政策)',
      got('water', 'swimming_pool') === null
      && got('water', 'lake') === 'water'
      && got('water', 'ocean') === 'water'
      && got('water', 'pond') === 'water',
      `pool → ${got('water', 'swimming_pool')} · lake → ${got('water', 'lake')}`);
  }

  // ── 3. `aeroway` 的 Point 不再膨脹 featureCount ──
  //
  // 資料是有的:Narita 105 個、松山 13 個,全部是 Point。`TerrainChunkManager`
  // 拿 `featureCount > 0` 決定這個 chunk 有沒有跑道,所以一個「只有登機門」的
  // chunk 會生出一個空 mesh 加進場景 —— 一次 draw call、一份幾何、一份材質,
  // 換到零個像素。
  {
    const strat = createPlasticTerrainStyle();
    const flat = {
      getElevationSync: () => 0, getElevation: async () => 0,
    } as unknown as Parameters<typeof buildAerowayMeshes>[1];
    const gate = (lon: number): unknown => ({
      layer: 'aeroway',
      properties: { class: 'gate' },
      geometry: { type: 'Point', coordinates: [lon, 25] },
    });
    const runway = (lon: number): unknown => ({
      layer: 'aeroway',
      properties: { class: 'runway' },
      geometry: { type: 'LineString', coordinates: [[lon, 25], [lon + 3e-3, 25.0005]] },
    });
    const build = (feats: unknown[]) => buildAerowayMeshes(
      feats as never, flat, originLat, originLon, 0, strat, () => 0,
    );
    const onlyGates = await build([gate(121.001), gate(121.002), gate(121.003)]);
    const onlyRunway = await build([runway(121.001)]);
    const mixed = await build([gate(121.001), runway(121.002), gate(121.003)]);
    const vertsOf = (r: { mesh: THREE.Mesh }): number =>
      (r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.count ?? 0;

    check('跑道:一條真的跑道有面積(不然下面三條是空的)',
      vertsOf(onlyRunway) > 0 && onlyRunway.featureCount === 1, `${vertsOf(onlyRunway)} 個頂點`);
    check('登機門:三個 Point 之後 featureCount 還是 0(chunk manager 因此不收它)',
      onlyGates.featureCount === 0 && vertsOf(onlyGates) === 0,
      `featureCount ${onlyGates.featureCount} · ${vertsOf(onlyGates)} 個頂點`);
    check('登機門:混在跑道裡也只算那條跑道',
      mixed.featureCount === 1 && vertsOf(mixed) === vertsOf(onlyRunway),
      `featureCount ${mixed.featureCount} · ${vertsOf(mixed)} vs ${vertsOf(onlyRunway)} 個頂點`);
    // 而且那個「什麼都沒有」的 mesh 是共用的空殼,不是 three 的一份新預設。
    check('登機門:空的結果吃共用的空殼(不是 new THREE.Mesh() 的一份新預設)',
      isEmptyMesh(onlyGates.mesh) && onlyGates.mesh.geometry === (await build([])).mesh.geometry,
      `shared = ${isEmptyMesh(onlyGates.mesh)}`);
    disposeAerowayMeshes(onlyGates);
    disposeAerowayMeshes(onlyRunway);
    disposeAerowayMeshes(mixed);
    // 空殼被 dispose 過之後**還能用** —— `disposeAerowayMeshes` 不准動它。
    const after = await build([gate(121.004)]);
    check('登機門:回收之後那個空殼還在(共用的東西不准被 chunk 回收掉)',
      isEmptyMesh(after.mesh), `${after.mesh.geometry.uuid.slice(0, 8)}`);
    disposeAerowayMeshes(after);
    strat.dispose();
  }

  // ── 4. 路燈:幾何共用,被 setNight 寫的材質**不**共用 ──
  //
  // 池子一開場就蓋 TUNNEL_POOL_SIZE = 20 盞,球場與遊樂場再各站一盞。量到的池子
  // 本身(一條普通的路上 10 盞,`scene-census.mjs`):
  //   plastic 30 draw / 30 geo / 30 mat · paper 40/40/40 · circuit 100/100/22
  // 而 §6 的整個世界預算是 70 個材質。
  //
  // 那條界線不是「能共用就共用」:`setNight` 會寫殼與亮點的材質,而
  // `street-lamp.ts` 的 `update()` **刻意**給池子 `litFactor`(隧道裡恆為 1)、
  // 給球場邊那盞原始的 `nightFactor`。跨過那條線共用一份被寫的材質,最後一個寫
  // 的人贏,隧道會在正午變黑。所以下面兩條要一起成立。
  for (const world of ['plastic', 'paper', 'circuit'] as const) {
    const st = await createTerrainStyleStrategy(world);
    const lamps = [0, 1, 2, 3, 4, 5].map((i) => st.buildStreetLamp(i));
    const geoOf = (p: { group: THREE.Object3D }): THREE.BufferGeometry[] => {
      const out: THREE.BufferGeometry[] = [];
      p.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push((o as THREE.Mesh).geometry); });
      return out;
    };
    const a = geoOf(lamps[0]);
    const shared = lamps.every((l) => {
      const g = geoOf(l);
      return g.length === a.length && g.every((x, i) => x === a[i]);
    });
    check(`${world}: 六盞路燈用的是同一份幾何(逐件同一個物件)`,
      a.length > 0 && shared, `${a.length} 件幾何`);
    check(`${world}: …而那份幾何標了 shared,disposeGroup 不准收它`,
      a.every((g) => g.userData?.shared === true));

    // 兩個方向:被 setNight 寫的材質**不能**是同一個物件,而且要證明它真的被寫。
    const litMats = (p: { group: THREE.Object3D }): THREE.Material[] => {
      const out: THREE.Material[] = [];
      p.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
          if (mat && !mat.userData?.shared) out.push(mat);
        }
      });
      return out;
    };
    const colOf = (mats: THREE.Material[]): string =>
      mats.map((m) => {
        const c = (m as THREE.MeshPhongMaterial).color;
        const e = (m as THREE.MeshPhongMaterial).emissive;
        return `${c ? c.getHexString() : '-'}/${e ? e.getHexString() : '-'}/${m.opacity.toFixed(3)}`;
      }).join(' ');
    // 同色的兩盞 —— 調色盤長度 3 或 4,所以 index i 與 i + 12 一定同色。
    const twinA = st.buildStreetLamp(0);
    const twinB = st.buildStreetLamp(12);
    const mA = litMats(twinA);
    const mB = litMats(twinB);
    check(`${world}: 同一個顏色的兩盞燈,會被 setNight 寫的材質不是同一份`,
      mA.length > 0 && mA.length === mB.length && mA.every((m, i) => m !== mB[i]),
      `${mA.length} 份逐盞材質`);
    twinA.setNight(0);
    twinB.setNight(0);
    const before = colOf(mB);
    twinA.setNight(1);
    check(`${world}: (setNight 真的在寫那幾份材質 —— 不然上一條是空的)`,
      colOf(mA) !== before, `${colOf(mA)} vs ${before}`);
    check(`${world}: 把一盞推到夜裡,另一盞一個通道都沒動(隧道不會點亮外面的球場)`,
      colOf(mB) === before, `${colOf(mB)} vs ${before}`);
    // 收掉一盞,另一盞的幾何不准被 dispose —— 共用幾何最容易錯的就是這一步。
    //
    // ⚠ 用 **dispose 事件**當探針,不是看 `getAttribute('position')` 還在不在:
    //   three 的 `BufferGeometry.dispose()` **不會**清掉 attribute,它只發一個
    //   事件讓 renderer 去釋放 GPU buffer。第一版就是那樣寫的,而
    //   「`disposeGroup` 不再認 shared 幾何」這個突變**沒有被抓到** —— 一條看不見
    //   自己要防的那件事的斷言。
    const geoDisposed = new Set<THREE.BufferGeometry>();
    for (const g of geoOf(twinB)) {
      g.addEventListener('dispose', () => { geoDisposed.add(g); });
    }
    // 正向對照:同一次 sweep 裡,twinA **自己那幾份**材質必須真的被收掉。
    // 逐**物件**去重:電子那盞的 lensMat 掛在四個 mesh 上,`mA` 因此有五筆卻只有
    // 兩份材質 —— 拿長度去比會永遠差三份。
    const uniqA = [...new Set(mA)];
    const matDisposed = new Set<THREE.Material>();
    for (const m of uniqA) m.addEventListener('dispose', () => { matDisposed.add(m); });
    twinA.dispose();
    check(`${world}: (dispose 真的跑了 —— 那盞燈自己那幾份材質被收掉了)`,
      uniqA.length > 0 && matDisposed.size === uniqA.length,
      `${matDisposed.size}/${uniqA.length} 份材質`);
    check(`${world}: 收掉一盞燈,共用的幾何一份都沒被 dispose(另一盞還在用)`,
      geoDisposed.size === 0 && geoOf(twinB).length === a.length,
      `${geoDisposed.size} 份被收掉`);
    twinB.dispose();
    for (const l of lamps) l.dispose();
    st.dispose();
  }

  // ── 5. 空的地被層共用一個空殼 ──
  //
  // 九格地被每個 chunk 都建,地圖沒給的那幾格以前各自 `new THREE.Mesh()` ——
  // 三個 chunk 量到 14 份 three 預設材質,佔 §6 那 70 個預算的 19%,而它們一個
  // 像素都不畫。
  {
    const strat = createPlasticTerrainStyle();
    const flat = {
      getElevationSync: () => 0, getElevation: async () => 0,
    } as unknown as Parameters<typeof buildLanduseMeshes>[1];
    const r1 = await buildLanduseMeshes([] as never, flat, originLat, originLon, 0, strat);
    const r2 = await buildLanduseMeshes([] as never, flat, originLat, originLon, 0, strat);
    const all = [...r1.layers, ...r2.layers];
    const geos = new Set(all.map((l) => l.mesh.geometry));
    const mats = new Set(all.map((l) => l.mesh.material as THREE.Material));
    check('空地被:兩個 chunk 的九格空層,加起來只有一份幾何、一份材質',
      all.length === 18 && geos.size === 1 && mats.size === 1,
      `${all.length} 層 → ${geos.size} 份幾何 / ${mats.size} 份材質`);
    check('空地被:…而它們標了 shared',
      [...geos][0].userData?.shared === true && [...mats][0].userData?.shared === true);
    disposeLanduseMeshes(r1);
    // 收掉一個 chunk 之後,另一個 chunk 的空殼**還在**。
    const r3 = await buildLanduseMeshes([] as never, flat, originLat, originLon, 0, strat);
    check('空地被:回收一個 chunk 之後那個空殼還是同一份(沒有被收掉)',
      r3.layers[0].mesh.geometry === [...geos][0], `${r3.layers[0].mesh.geometry.uuid.slice(0, 8)}`);
    disposeLanduseMeshes(r2);
    disposeLanduseMeshes(r3);
    strat.dispose();
  }
}


await block('style/cuphead', () => checkStyle('cuphead (paper / cardboard)', createPaperTerrainStyle()));
await block('style/plastic', () => checkStyle('plastic (toy blocks)', createPlasticTerrainStyle()));
await block('instanced bodies/cuphead',
  () => checkInstancedBodies('cuphead (paper / merge path)', createPaperTerrainStyle()));
await block('instanced bodies/plastic',
  () => checkInstancedBodies('plastic (toy blocks)', createPlasticTerrainStyle()));
// The zone each world batches most of: the toy world's hospital is the domino
// wall (pips and grooves by the hundred), the corrugated world's residential is
// the sleeved eraser.
await block('instanced trim/cuphead',
  () => checkDecorationBatching('cuphead (eraser sleeve)', createPaperTerrainStyle(), 'residential', false));
await block('instanced trim/plastic',
  () => checkDecorationBatching('plastic (domino pips)', createPlasticTerrainStyle(), 'hospital', true));
await block('cup tower fit', checkCupTowerFit);
await block('zone bodies vs demo', checkPlasticBodiesVsDemo);
await block('zone bodies vs demo/paper', checkPaperBodiesVsDemo);
await block('surfaces vs demo/paper', checkPaperPropsVsDemo);
await block('the school across both renderers', checkSchoolAcrossRenderers);
await block('decoration uv', checkDecorationUV);
await block('heading', checkHeading);
await block('orbit camera', checkOrbitCamera);
await block('camera collision', checkCameraCollision);
await block('camera lift', checkCameraLift);
await block('yield budget', checkYieldBudgetIsShared);
await block('night is lit', checkNightIsLit);
await block('every world: lights + signs', checkEveryWorldHasNightLightsAndSigns);
await block('zones', checkZones);
await block('night grade', checkNightGrade);
await block('2D footprint sizing', check2DFootprintSizing);
await block('sign spec', checkSignSpec);
await block('training signs', checkTrainingSigns);
await block('training signs 2D', checkTrainingSigns2D);
await block('zoning', checkZoning);
await block('sign placement/cuphead', () => checkSignPlacement('cuphead (label tape)', createPaperTerrainStyle()));
await block('sign placement/plastic', () => checkSignPlacement('plastic (sticker)', createPlasticTerrainStyle()));
await block('lamps', checkLamps);
await block('route line/cuphead', () => checkRouteLine('cuphead (highlighter swipe)', createPaperTerrainStyle()));
await block('route line/plastic', () => checkRouteLine('plastic (neon tape)', createPlasticTerrainStyle()));
await block('ground ribbons', checkGroundRibbons);
await block('corridor fold', checkCorridorFold);
await block('waterways', checkWaterways);
await block('aeroways/cuphead', () => checkAeroways('cuphead (balloon plane)', createPaperTerrainStyle()));
await block('aeroways/plastic', () => checkAeroways('plastic (brick plane)', createPlasticTerrainStyle()));
await block('zone decals/cuphead', () => checkZoneDecals('cuphead (gouache wash)', createPaperTerrainStyle()));
await block('zone decals/plastic', () => checkZoneDecals('plastic (candy wash)', createPlasticTerrainStyle()));
await block('baseplate studs vs demo', checkPlasticGroundStuds);
await block('mountain ring vs demo/paper', checkPaperMountainsVsDemo);
await block('mountain ring vs demo/plastic', checkPlasticMountainsVsDemo);
await block('street lamp vs demo', checkStreetLampsVsDemo);
await block('mountain ridge line branch', checkMountainRidgeLineBranch);
await block('mountain ring fog clearance', checkMountainFogClearance);
await block('gradient sky', checkGradientSky);
await block('sky covers the visible band', checkSkyCoversVisibleBand);
await block('acrylic case/cuphead',
  () => checkAcrylicCase('cuphead (model presentation case)', createPaperTerrainStyle()));
await block('acrylic case/plastic',
  () => checkAcrylicCase('plastic (toy display box)', createPlasticTerrainStyle()));
await block('heavy effect gating', checkHeavyEffectGating);
await block('scene bloom', checkSceneBloom);
await block('world options', checkWorldOptionRoundTrip);
await block('lighting/cuphead', () => checkLighting('cuphead (paper)', createPaperTerrainStyle()));
await block('lighting/plastic', () => checkLighting('plastic (toy blocks)', createPlasticTerrainStyle()));
await block('palette/cuphead', () =>
  checkSkyPaletteMatchesDemo('cuphead (paper)', createPaperTerrainStyle(), 'plan/paper-town-demo.html'));
await block('palette/plastic', () =>
  checkSkyPaletteMatchesDemo('plastic (toy blocks)', createPlasticTerrainStyle(), 'plan/plastic-town-demo.html'));
// 電子世界原本**沒有註冊在這裡** —— §11.2 的「第三個世界靜靜掉進 else」,而且是
// 突變測出來的:把 gameview 的 skyBottom 改掉、demo 不動,全場照樣 2527 ✓ 全綠。
// 也就是說這個世界的 DAY/NIGHT 從來沒有被釘在它自己的 demo 上過。
await block('palette/circuit', () =>
  checkSkyPaletteMatchesDemo('circuit (PCB)', createCircuitTerrainStyle(), 'plan/circuit-town-demo.html'));
await block('celestial discs/cuphead', () =>
  checkCelestialDiscs('cuphead (paper)', createPaperTerrainStyle(), 'plan/paper-town-demo.html', 'paperDisc'));
await block('celestial discs/plastic', () =>
  checkCelestialDiscs('plastic (toy blocks)', createPlasticTerrainStyle(), 'plan/plastic-town-demo.html', 'plasticDisc'));
await block('celestial discs/circuit', () =>
  checkCelestialDiscs('circuit (single-board)', createCircuitTerrainStyle(), 'plan/circuit-town-demo.html', 'skyDisc'));
await block('celestial design vs demos', checkCelestialDesign);
await block('sun shadow map vs demos', checkSunShadowVsDemos);
await block('shadow frustum', checkShadowFrustum);
await block('shadow rides with rider', checkShadowRidesWithRider);
await block('key light direction routing', checkKeyLightDirectionRouting);
await block('shadow flags reach geometry', checkShadowFlagsReachGeometry);
await block('decoration shadow batching', checkDecorationShadowBatching);
await block('shadow quality tiers', checkShadowQualityTiers);
await block('celestial sky behaviour', checkCelestialSkyBehaviour);
await block('clouds/cuphead', checkPaperClouds);
await block('clouds/plastic', checkPlasticClouds);
await block('cloud deck behaviour', checkCloudDeckBehaviour);
// 主題配樂:世界的第三件交付物(CUSTOM_WORLD_INSTRUCTIONS §1)。它 diff 的不是
// 幾何而是 Web Audio graph,而且會把 document / window / Math.random / setInterval
// 全部換掉再換回來,所以獨立成一個模組、放在最後跑。
await block('theme music vs demo', () => checkThemeMusicVsDemo(check));
await block('map data + sharing', checkMapDataAndSharing);

// 獨立成檔的 demo 逐件比對。每一支都在自己的 JSDoc 裡寫了「請這樣註冊」,而那句話
// 在註解裡躺了好幾天沒有人照做 —— 六個檔、上千條斷言,`check:3d` **一次都沒跑過**,
// 而我一路引用它的 ✓ 數當作它們通過了。所以這裡改成一張表 + 一條守門的斷言。
//
// 守門那條**必須讀這張表本身**。第一版把表抄了第二份給它比,於是從迴圈裡刪掉一支
// 照樣全過 —— 跟它要防的病一模一樣,是突變測試抓到的。
const STANDALONE_CHECKS = [
  'circuit-board-vs-demo',   // 板面(絲印、阻焊、鑽孔)
  'circuit-3d-vs-demo',      // 電子世界 3D 零件
  'circuit-2d-vs-demo',      // 電子世界 2D
  'terrain-band-vs-demo',    // 地形分層設色
  'zone-plan-vs-demo',       // 分區→量體的 80/20 傾向 + bandPaint 的基準面
  'road-class-vs-demo',      // 道路等級寬度系統 + 換級處的 45° 錐段
  'route-body-vs-demo',      // 路線本體 = 一串接龍的杜邦線
  'rider-signals-vs-demo',   // 即時訊號(踏頻/功率)→ 造型層:hook、曲柄、每一跳
  'pedal-signals-vs-demo',   // demo 這一側:PEDAL 區塊三份相同 + 三種不同種類的反應
  'props-vs-demo',           // 金幣 / checkpoint / 擺件 / 樹 / 水面
  'shadow-flags-vs-demo',    // castShadow / receiveShadow
  'plastic-letters-vs-demo', // 字母積木的 3D 字形幾何   ⚠ 佔位
  'mountain-ring-vs-demo',   // 遠山環的分層與旗標       ⚠ 佔位
  'paper-props-vs-demo',     // contourPlate + 白膠痕    ⚠ 佔位
  'street-lamp-vs-demo',     // 路燈站上路之後:顏色/左右/朝向/亮的那幾盞
  'sky-vs-demo',             // 星星的大小模型 + 日照數學(7 個 sky* 函式)
  'landuse-rings-vs-demo',   // 地被的環:luRings / luRingInfo / luKindOf
];
for (const mod of STANDALONE_CHECKS) {
  await block(`${mod.replace(/-vs-demo$/, '')} vs demo`, async () => {
    failures += ((await import(`./${mod}.ts`)) as { failureCount(): number }).failureCount();
  });
}

// 模組邊界檢查。**刻意不叫 `*-vs-demo.ts`** —— 它不是 demo diff(它讀的是 import
// 圖,不是幾何),而下面那條守門斷言只列舉 `*-vs-demo.ts`,所以它單獨註冊在這裡。
// 它要防的東西見 `plan/world-modularity-refactor.md`。
await block('world boundary', async () => {
  failures += ((await import('./world-boundary.ts')) as { failureCount(): number }).failureCount();
});

// 這張表如果漏掉一支,新檔案就會像先前那六個一樣靜靜地不執行。
{
  const { readdirSync } = await import('node:fs');
  const onDisk = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('-vs-demo.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
  // music-vs-demo 走上面的具名匯入(它要接 diorama 的 check callback),所以它是
  // 這張表之外唯一合法的例外 —— 而且是**寫死在這裡的一個名字**,不是一份副本。
  const MUSIC = 'music-vs-demo';
  const registered = [...STANDALONE_CHECKS, MUSIC].sort();
  check(
    `every *-vs-demo.ts is registered (on disk: ${onDisk.length})`,
    onDisk.join(',') === registered.join(','),
    `未註冊: ${onDisk.filter((m) => !registered.includes(m)).join(', ') || '(無)'}` +
      ` / 註冊了但檔案不在: ${registered.filter((m) => !onDisk.includes(m)).join(', ') || '(無)'}`,
  );
}

console.log(
  failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} CHECK(S) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * 2D buildings must size to their footprint (`plan/migrate-demo-worlds.md` §3.12).
 *
 * The bug: `gridBox` rounded to whole 24 px bricks with a 2-row floor, so
 * 15×10, 15×19, 17×29 and 29×48 — a 4 m house through a 20 m block, the four
 * commonest footprints on a real street — all drew as one 24×48 object.
 *
 * This checks EVERY zone, not just one. The tempting version tests
 * `residential`, which is the body the fix works best on; a check that only
 * exercises the case that passes proves the mechanism exists, not that the bug
 * is gone. School in particular has a real floor and is asserted at its actual
 * value, so both a regression and an improvement show up.
 */
async function check2DFootprintSizing(): Promise<void> {
  console.log('\n[2D building footprint sizing]');

  // The four commonest street footprints. 40×84 is deliberately excluded — it
  // was never ambiguous, so including it would flatter the result.
  const FOOTPRINTS: [number, number][] = [[15, 10], [15, 19], [17, 29], [29, 48]];
  const ZONES = ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const;

  const plastic = await createStyleStrategy('plastic');
  const boxesFor = (zone: string): string[] => FOOTPRINTS.map(([w, h]) => {
    const rep = plastic.renderBuilding(
      makeGraphics2D(new Sink2D()) as never, 240 - w / 2, 480 - h, w, h, 0, 0, zone as never);
    return rep ? `${Math.round(rep.w)}x${Math.round(rep.h)}` : 'none';
  });

  const distinct = new Map<string, number>();
  for (const z of ZONES) distinct.set(z, new Set(boxesFor(z)).size);

  // Four of the five bodies can tell all four footprints apart.
  const fourWay = ZONES.filter((z) => z !== 'school');
  check(
    'four street footprints are four different objects (§3.12)',
    fourWay.every((z) => distinct.get(z) === 4),
    fourWay.map((z) => `${z}=${distinct.get(z)}`).join(' '),
  );

  // School is the honest exception, asserted at its real value so nobody
  // "tidies" it back to one box and nobody has to rediscover why it is 2: the
  // letter-block row cannot be shorter than one row of blocks, so the three
  // small footprints share it. If this ever becomes 3+, that is an improvement
  // and this check should be raised, not deleted.
  check(
    'school is the known exception — one row of letter blocks is its floor',
    distinct.get('school') === 2,
    `school=${distinct.get('school')} → ${boxesFor('school').join(' ')}`,
  );

  // The next two apply to the `gridBox` bodies only. School is a row of letter
  // blocks and hospital is a wall of dominoes — those parts have their own
  // module sizes (56/81 px, 54 px), and forcing them onto the brick grid would
  // be making the check convenient rather than true.
  const GRID_ZONES = ['residential', 'commercial', 'industrial'] as const;

  // Quantised, not continuously scaled: this world is built out of bricks, so a
  // smooth 15×10 box would be the wrong language even though it would trivially
  // pass the distinctness check above.
  const gridBoxes = GRID_ZONES.flatMap(boxesFor);
  check(
    'brick bodies sit on the half-brick (12 px) grid',
    gridBoxes.every((b) => b !== 'none'
      && b.split('x').every((v) => Number(v) > 0 && Number(v) % 12 === 0)),
    [...new Set(gridBoxes)].join(' '),
  );

  // Round UP, not nearest: a footprint gets the bricks that COVER it. Nearest
  // folds 15×19 and 17×29 back onto one box, which is the bug again.
  check(
    'brick quantisation rounds up — never fewer bricks than the footprint needs',
    GRID_ZONES.every((z) => boxesFor(z).every((b, i) => {
      const [w, h] = b.split('x').map(Number);
      return w >= FOOTPRINTS[i][0] && h >= FOOTPRINTS[i][1];
    })),
    GRID_ZONES.map((z) => `${z}:${boxesFor(z).join(',')}`).join(' '),
  );

  // School earns its exemption rather than just being excluded from the rule: a
  // sign row is a LOW WIDE thing, so on a tall footprint it is deliberately
  // shorter and wider than the nominal box. If it ever starts filling a tall
  // box, it has stopped being a sign row.
  const schoolTall = boxesFor('school')[3].split('x').map(Number);
  check(
    'the school sign row stays low and wide on a tall footprint',
    schoolTall[0] > FOOTPRINTS[3][0] && schoolTall[1] < FOOTPRINTS[3][1],
    `${schoolTall[0]}x${schoolTall[1]} for a ${FOOTPRINTS[3][0]}x${FOOTPRINTS[3][1]} footprint`,
  );

  // Cuphead never had this bug (its box derives from the nominal one). Assert
  // it, so the plastic fix cannot be "helpfully" generalised onto a world that
  // did not need it.
  const cuphead = await createStyleStrategy('cuphead');
  const cupBoxes = FOOTPRINTS.map(([w, h]) => {
    const rep = cuphead.renderBuilding(
      makeGraphics2D(new Sink2D()) as never, 240 - w / 2, 480 - h, w, h, 0, 0, 'residential' as never);
    return rep ? `${Math.round(rep.w)}x${Math.round(rep.h)}` : 'none';
  });
  check(
    'cuphead already told them apart and still does',
    new Set(cupBoxes).size === 4,
    cupBoxes.join(' '),
  );
}

/**
 * Every world — not a hand-written list of them — must have the two pipelines
 * that make a district read as a district after dark.
 *
 * ALL the per-world checks in this file are registered as hand-written pairs
 * (`'…/cuphead'`, `'…/plastic'`). That was fine while there were two worlds and
 * silently useless the moment there is a third: `buildSign?` and
 * `buildBuildingLights?` are both OPTIONAL, so a new world can land with no
 * signs and no night lights and every check here stays green.
 *
 * So this one enumerates `WORLD_OPTIONS` instead of naming worlds. A new
 * `WorldStyle` enrols itself the moment it is added, and the requirement
 * arrives with it rather than waiting for someone to remember.
 *
 * "Lit" deliberately means lit by EITHER route, because both are legitimate:
 *  · window quads from `buildBuildingLights`, or
 *  · a night-lit material registered via `registerNightLitMaterial` and driven
 *    by the one global `setNightLitFactor` write.
 * The corrugated world's eraser is the reason — its light is the red plastic
 * film round its sleeve, and DEVPLAN lists `[]` as its honest answer. Demanding
 * window placements would be satisfied by faking windows onto an eraser, which
 * is precisely what this mechanism exists to prevent.
 */
async function checkEveryWorldHasNightLightsAndSigns(): Promise<void> {
  console.log('\n[every world: zone night lights + writable signs]');

  const worlds = Object.keys(WORLD_OPTIONS) as WorldStyle[];
  check('there is a world list to iterate at all', worlds.length >= 2, worlds.join(' '));

  for (const world of worlds) {
    // A world listed in WORLD_OPTIONS whose strategy will not load is a failed
    // check, not a thrown block: a throw here would abort every remaining
    // assertion in the run and report a truncated pass count as if it were a
    // clean one. This file has been bitten by exactly that before.
    let strategy: TerrainStyleStrategy;
    try {
      strategy = await createTerrainStyleStrategy(terrainStyleFromWorldStyle(world));
    } catch (e) {
      check(`${world}: its strategy loads at all`, false, String((e as Error).message).slice(0, 120));
      continue;
    }
    try {
      // ── Signs that can carry text ──
      const shop = strategy.buildSign?.('shop', 'CAFE', 8);
      check(
        `${world}: can write on a sign`,
        !!shop,
        shop ? `${shop.width.toFixed(1)} m wide` : 'buildSign not implemented',
      );
      // A sign that ignores its text is a decal, not a sign. `SignParts` only
      // reports width/height, so count the geometry the glyphs actually put in
      // the group — two different words cannot produce identical strokes.
      const verts = (p: { group: THREE.Object3D } | null | undefined): number => {
        let n = 0;
        p?.group.traverse((o) => {
          const g = (o as THREE.Mesh).geometry;
          n += g?.getAttribute?.('position')?.count ?? 0;
        });
        return n;
      };
      const other = strategy.buildSign?.('shop', 'MILL', 8);
      const a = verts(shop), b = verts(other);
      check(
        `${world}: the sign's text actually changes it`,
        a > 0 && b > 0 && a !== b,
        `CAFE ${a} verts vs MILL ${b}`,
      );
      other?.dispose();
      shop?.dispose();

      // ── Per-zone night lights, by either route ──
      const box = {
        cx: 0, cz: 0, width: 16, depth: 12, rotY: 0,
        height: 24, baseY: 0, skirt: 1.5, color: 0xcccccc,
      };
      const litZones: string[] = [];
      for (const zone of ZONE_KINDS) {
        const quads = strategy.buildBuildingLights?.(box, 5, zone) ?? [];
        if (quads.length > 0) { litZones.push(`${zone}:win`); continue; }

        // The material route. Build the body's decoration and see whether the
        // one global night write moves any emissive on it.
        const deco = strategy.buildBuildingDecoration(box, 5, zone);
        const mats: THREE.Material[] = [];
        deco?.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          if (m instanceof THREE.Material && (m as THREE.MeshPhongMaterial).emissive) mats.push(m);
        });
        setNightLitFactor(0);
        const dark = mats.map((m) => (m as THREE.MeshPhongMaterial).emissive.getHex());
        setNightLitFactor(1);
        const glowed = mats.some((m, i) => (m as THREE.MeshPhongMaterial).emissive.getHex() !== dark[i]);
        setNightLitFactor(0);
        if (glowed) litZones.push(`${zone}:seam`);
      }

      // Not every zone must light — an industrial yard legitimately stays dark,
      // and `[]` is a real answer. But a world where NOTHING lights has not
      // implemented the pipeline, it has skipped it.
      check(
        `${world}: at least one zone lights up at night`,
        litZones.length > 0,
        litZones.length ? litZones.join(' ') : 'no zone lights by either route',
      );
      // Residential is the one that must: it is the commonest district by far,
      // and a night ride through unlit housing is the reported 「超級黑」.
      check(
        `${world}: residential housing is lit after dark`,
        litZones.some((z) => z.startsWith('residential')),
        litZones.join(' ') || 'none',
      );
    } finally {
      strategy.dispose();
    }
  }
}

/**
 * The cooperative-yield budget is shared, because the main thread is one thing.
 *
 * `build-yield.ts` always documented this ("share it across a build's loops so
 * the budget is global, not per-loop") and nothing enforced it. All seven
 * builders called `createYielder()` for themselves, and the chunk manager runs
 * five of them concurrently in one `Promise.all` — so N independent 10 ms
 * budgets could stack into one uninterrupted burst before the browser painted.
 * The N100 log showed the result: frames of 1017 ms with 927 ms of JS in them,
 * every stall within 3 s of a chunk event.
 */
async function checkYieldBudgetIsShared(): Promise<void> {
  console.log('\n[cooperative yield budget]');

  const { createYielder, resetYieldClockForTests } =
    await import('@/game/terrain/build-yield');

  // Two yielders, as two concurrent builders would have. Burn the interval on
  // the first; the SECOND must then yield, because they ration one thread.
  resetYieldClockForTests();
  const a = createYielder(10);

  const spin = (ms: number): void => {
    const t = performance.now();
    while (performance.now() - t < ms) { /* burn */ }
  };

  // Nothing has been spent yet: it should not yield.
  let yielded = await didYield(a);
  check('a fresh budget does not yield', !yielded);

  // `b` is created AFTER the work, deliberately. Under the per-yielder clocks
  // this replaced, `b` would start its own 10 ms fresh and sail past — which is
  // exactly the bug (a builder joining a busy thread believing the thread is
  // idle). Under one shared clock it must yield immediately.
  spin(12);
  const b = createYielder(10);
  yielded = await didYield(b);
  check(
    'work done by ONE builder makes ANOTHER builder yield (shared budget)',
    yielded,
    yielded ? 'b yielded after a burned the interval' : 'b kept going — budgets are per-yielder again',
  );

  // And the yield reset it for everybody.
  yielded = await didYield(a);
  check('a yield resets the budget for every builder', !yielded);
}

/** Did this yielder actually hand the thread back? Detected via a macrotask
 *  ordering probe: a `setTimeout(0)` queued first must land BEFORE the call
 *  returns if — and only if — the call awaited a macrotask of its own. */
async function didYield(y: () => Promise<void>): Promise<boolean> {
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  await y();
  return timerFired;
}

// ── ONE school, TWO renderers ────────────────────────────────────────────────
//
// The corrugated world's school became three stacked archive boxes in 3D while
// the 2D side elevation was still drawing an abacus, and `check:3d` went from
// 2305 assertions to 2319 without a single one going red. Nothing in this file
// tied the two shapes together; the only cross-renderer assertion the paper
// world had was about what its signs SAY. This is the missing one.
//
// ── Picking a quantity that can actually cross the fence ──
//
// 3D ships triangles, 2D ships canvas commands, so nothing can be diffed
// directly. What CAN cross is a RATIO — but only a ratio of quantities both
// renderers actually possess, and that rules out more than it looks like:
//
//  ✗ the handle COUNT. `terrain-builder.renderBuilding` computes
//    `widthPx = max(15, min(40, heightPx * 0.6))` — the 2D width is a clamped
//    function of the HEIGHT and the footprint's own width never arrives. An 82 m
//    school and a 15 m one both turn up 15–40 px wide, so the 3D world's
//    `round(w_metres / 22)` has no 2D counterpart and a check on the count would
//    only be pinning a number somebody chose to make it pass.
//  ✗ the lid's OVERHANG ratio. Same root cause plus a second one: 0.7 m of
//    overhang on a footprint tens of metres across lands under 2 px in the 2D
//    drawing, which is inside `wob`'s own ±0.8 px jitter, so the 2D deliberately
//    does not draw a step at all (see `fileBoxes`). Asserting a ratio that one
//    side does not have would be asserting a constant.
//  ✓ the STACK's own divisions. `tierH = h / 3` on both sides, of each
//    renderer's own body height — dimensionless, engine-free, and load-bearing:
//    it is the whole silhouette.
//  ✓ the handle LAYOUT, normalised into the body's width: `(k + 0.5) / n`.
//    Independent of what `n` is, so it survives the count divergence above, and
//    it is compared at footprints chosen to give the two sides the SAME n so the
//    two normalised sets have to be equal element for element.
//  ✓ the bezel RAMP as a cyclic sequence of hues aligned at the lit one. Both
//    pick a box's colour with `(c0 + tier) % 4` and both light index 1, so "the
//    amber box is the lit one" is only the same statement if the ramps run in the
//    same order. The two palettes are deliberately NOT equal (2D is muted to
//    watercolour), which is exactly why the invariant is hue ORDER and not value.
//  ✓ the sign's anchor stated as a COINCIDENCE rather than a number: the plate's
//    centre is the MIDDLE lid's own centre. True to the last decimal on both
//    sides for completely different reasons, which is what a shared rule looks
//    like.
//
// Everything below is read off DRAWN output — `BoxPart`s on one side, recorded
// `Graphics` commands on the other — never off a constant in either file.
async function checkSchoolAcrossRenderers(): Promise<void> {
  console.log('\n[the school across both renderers]');

  const s3 = createPaperTerrainStyle();
  const s2 = await createStyleStrategy('cuphead');
  const box3 = (w: number, d: number, h: number): BuildingBox => ({
    cx: 0, cz: 0, width: w, depth: d, rotY: 0, height: h, baseY: 0, skirt: 0, color: 0,
  });
  /** A seed at which the 3D zone roll really lands on the file-box body — it is
   *  the one body made of cubes alone (see `kindOf` above). */
  const seed3 = (b: BuildingBox): number => {
    for (let sd = 0; sd < 256; sd++) {
      const parts = s3.buildBuildingBoxes?.(b, sd, 'school');
      if (parts && new Set(parts.map((p) => p.shape ?? 'box')).size === 1) return sd;
    }
    return -1;
  };

  type Cmd = {
    t: string; col: number; a: number; w?: number;
    pts?: number[][]; x1?: number; y1?: number; x2?: number; y2?: number;
  };
  /** Drive the 2D style and keep the commands plus the box it reported. */
  const rec2 = (
    w: number, h: number, ci: number, sd: number, zone: ZoneKind, lights = false,
  ): { cmds: Cmd[]; rep: { x: number; y: number; w: number; h: number } | null } => {
    const sink = new Sink2D();
    const gfx = makeGraphics2D(sink) as never;
    const rep = s2.renderBuilding(gfx, 200 - w / 2, 500 - h, w, h, ci, sd, zone, []) ?? null;
    if (lights) {
      const lit = new Sink2D();
      s2.renderBuildingLights?.(
        makeGraphics2D(lit) as never, 200 - w / 2, 500 - h, w, h, ci, sd, zone);
      return { cmds: (lit as unknown as { cmds: Cmd[] }).cmds, rep };
    }
    return { cmds: (sink as unknown as { cmds: Cmd[] }).cmds, rep };
  };
  /** …at a seed where the 2D roll lands on the file box. `bodyBox` multiplies the
   *  nominal width by 1.95 for this body and by nothing near it for the other
   *  four, so the reported width identifies it exactly. */
  const seed2 = (w: number, h: number, zone: ZoneKind): number => {
    for (let sd = 0; sd < 4000; sd++) {
      const r = rec2(w, h, 0, sd, zone);
      if (r.rep && Math.abs(r.rep.w - w * 1.95) < 1e-6) return sd;
    }
    return -1;
  };
  const mean = (xs: number[]): number => xs.reduce((a, v) => a + v, 0) / xs.length;

  // ── the three divisions ────────────────────────────────────────────────────
  //
  // 3D: the lid parts are the ones overhanging the footprint on BOTH horizontal
  // axes; a `BoxPart`'s `y` IS its centre. 2D: the lid bands are the full-width
  // filled quads other than the mass (the mass is the one with the tall span),
  // and a band's centre is the mean of its four corners — which is also what
  // cancels most of `wob`'s jitter.
  const lids3 = (b: BuildingBox): { centre: number; top: number }[] => {
    const parts = s3.buildBuildingBoxes?.(b, seed3(b), 'school') ?? [];
    return parts
      .filter((p) => p.w > b.width + 1e-6 && p.d > b.depth + 1e-6)
      .map((p) => ({ centre: p.y, top: p.y + p.h / 2 }))
      .sort((p, q) => p.centre - q.centre);
  };
  /**
   * The 2D lid courses, from the SEAM RULE rather than from the band's corners.
   *
   * `wobQuad` moves every corner by up to `wob() * 0.8` = 2.08 px, so a band's
   * centre read off its four corners carries ±2 px — on a 22 px stack that is a
   * quarter of a tier and the assertion below would have to be so loose it could
   * not tell three tiers from four. The seam is `lineBetween(x1 + wob, top,
   * x2 + wob, top)`: only the ENDS are wobbled, the y is exact. So the y comes
   * from the rule and the band's existence is counted from the fills.
   */
  const lids2 = (
    cmds: Cmd[], rep: { x: number; y: number; w: number; h: number },
  ): { tops: number[]; bands: number } => {
    const bands = cmds.filter((c) => {
      if (c.t !== 'poly' || !c.pts || c.pts.length !== 4) return false;
      const xs = c.pts.map((q) => q[0]);
      const ys = c.pts.map((q) => q[1]);
      return Math.abs((Math.max(...xs) - Math.min(...xs)) - rep.w) < 5
        && Math.max(...ys) - Math.min(...ys) < rep.h * 0.9;
    }).length;
    const tops = cmds
      .filter((c) => c.t === 'line' && Math.abs((c.w ?? 0) - 1.6) < 1e-9
        && Math.abs((c.y1 ?? 0) - (c.y2 ?? 0)) < 1e-9)
      .map((c) => 500 - (c.y1 ?? 0))
      .sort((a, b) => a - b);
    return { tops, bands };
  };

  {
    // Three sizes each, and the two sides do NOT have to be the same building —
    // the invariant is a ratio of each body to itself.
    const B3 = [[17, 6.8, 10], [39.3, 20.3, 12], [82, 76, 19]] as const;
    const B2 = [[15, 25], [24, 40], [40, 300]] as const;
    let bad = '';
    const shown: string[] = [];
    for (const [w, d, h] of B3) {
      const L = lids3(box3(w, d, h));
      const H = Math.max(1, h);
      if (L.length !== 3) { bad ||= `3D ${w}x${h}: ${L.length} lids`; continue; }
      const g1 = L[1].centre - L[0].centre, g2 = L[2].centre - L[1].centre;
      if (Math.abs(g1 - g2) > 1e-9 || Math.abs(g1 - H / 3) > 1e-9) {
        bad ||= `3D ${w}x${h}: gaps ${g1.toFixed(4)}/${g2.toFixed(4)} vs H/3 ${(H / 3).toFixed(4)}`;
      }
      if (Math.abs(L[2].top - H) > 1e-9) bad ||= `3D ${w}x${h}: top lid caps at ${L[2].top.toFixed(4)} not ${H}`;
      shown.push(`3D ${h}m→${(g1 / H).toFixed(4)}`);
    }
    for (const [w, h] of B2) {
      const sd = seed2(w, h, 'residential');
      const r = rec2(w, h, 0, sd, 'residential');
      if (sd < 0 || !r.rep) { bad ||= `2D ${w}x${h}: no file-box seed`; continue; }
      const L = lids2(r.cmds, r.rep);
      if (L.tops.length !== 3 || L.bands !== 3) {
        bad ||= `2D ${w}x${h}: ${L.tops.length} seams / ${L.bands} bands`;
        continue;
      }
      const H = r.rep.h;
      const g1 = L.tops[1] - L.tops[0], g2 = L.tops[2] - L.tops[1];
      // EXACT, because the seam's y carries no wobble (see `lids2`).
      if (Math.abs(g1 - g2) > 1e-9 || Math.abs(g1 - H / 3) > 1e-9) {
        bad ||= `2D ${w}x${h}: gaps ${g1.toFixed(4)}/${g2.toFixed(4)} vs H/3 ${(H / 3).toFixed(4)}`;
      }
      if (Math.abs(L.tops[2] - H) > 1e-9) bad ||= `2D ${w}x${h}: top seam at ${L.tops[2].toFixed(4)} not ${H.toFixed(4)}`;
      shown.push(`2D ${H.toFixed(0)}px→${(g1 / H).toFixed(4)}`);
    }
    check('both renderers cut the school into THREE EQUAL boxes, and the top lid '
      + 'caps the body (the one ratio that survives 2D never seeing the footprint width)',
      !bad, bad || shown.join(' '));
  }

  // ── the handle row, normalised into the body width ─────────────────────────
  {
    // Footprints chosen so the two sides land on the SAME number of holes —
    // 3D counts off metres at a 22 m pitch, 2D off pixels at 26, so this is the
    // only way the two normalised sets can be compared element for element.
    const PAIRS: { n: number; b3: readonly [number, number, number]; b2: readonly [number, number] }[] = [
      { n: 1, b3: [17, 6.8, 10], b2: [15, 25] },
      { n: 2, b3: [40, 18, 12], b2: [24, 40] },
      { n: 3, b3: [66, 30, 16], b2: [40, 72] },
    ];
    let bad = '';
    const shown: string[] = [];
    for (const { n, b3, b2 } of PAIRS) {
      const b = box3(...b3);
      const parts = s3.buildBuildingBoxes?.(b, seed3(b), 'school') ?? [];
      // Everything that is neither a full-footprint mass nor an overhanging lid
      // is a handle part. Among those the RECESS is the colour with the fewest
      // parts: 3 per row against a bezel colour's 4 per row, at every n.
      const rest = parts.filter((p) => !(p.w > b.width + 1e-6 && p.d > b.depth + 1e-6)
        && !(Math.abs(p.w - b.width) < 1e-6 && Math.abs(p.d - b.depth) < 1e-6));
      const byCol = new Map<number, typeof rest>();
      for (const p of rest) {
        if (!byCol.has(p.color)) byCol.set(p.color, []);
        byCol.get(p.color)!.push(p);
      }
      const recess = [...byCol.values()].sort((u, v) => u.length - v.length)[0] ?? [];
      const x3 = [...new Set(recess.map((p) => Number(((p.x + b3[0] / 2) / b3[0]).toFixed(6))))].sort();

      const sd = seed2(b2[0], b2[1], 'residential');
      const r = rec2(b2[0], b2[1], 0, sd, 'residential');
      if (sd < 0 || !r.rep) { bad ||= `n=${n}: no 2D file-box seed`; continue; }
      // Unsigned district on purpose: with no label tape the only quads are the
      // mass, the three lid bands and the recesses, so the recesses are simply
      // "not full width" — no colour constant needed on either side.
      const slots = r.cmds.filter((c) => c.t === 'poly' && c.pts && c.pts.length === 4)
        .map((c) => c.pts!)
        .filter((pts) => {
          const xs = pts.map((q) => q[0]);
          return Math.abs((Math.max(...xs) - Math.min(...xs)) - r.rep!.w) >= 3;
        });
      const x2 = slots.map((pts) => (mean(pts.map((q) => q[0])) - r.rep!.x) / r.rep!.w);
      const want = Array.from({ length: n }, (_, k) => (k + 0.5) / n);
      // 2.1 px is `wob`'s own bound: `wob` peaks at ±2.6 and `wobQuad` scales it
      // by 0.8, so a slot's mean x cannot be further than that from where the
      // formula put it. Expressed in normalised units it shrinks as the body
      // grows, and it is an order of magnitude under the 1/n spacing it has to
      // resolve. Counted per TARGET rather than de-duplicated into a set: the
      // three tiers wobble independently, so their three x's are near-equal but
      // not equal, and a set would report three "different" holes.
      const tol = 2.1 / r.rep!.w;
      const hits = want.map((t) => x2.filter((v) => Math.abs(v - t) < tol).length);
      const ok3 = x3.length === n && x3.every((v, i) => Math.abs(v - want[i]) < 1e-6);
      const ok2 = x2.length === 3 * n && hits.every((c) => c === 3);
      if (!ok3 || !ok2) {
        bad ||= `n=${n}: 3D [${x3.map((v) => v.toFixed(3))}] 2D ${x2.length} slots hitting [${hits}] `
          + `of want [${want.map((v) => v.toFixed(3))}]`;
      }
      shown.push(`n=${n} ✓`);
    }
    check('the handle row is laid out the same way in both — evenly spaced, each '
      + 'centred in its own cell, at (k + 0.5) / n',
      !bad, bad || shown.join(' '));
  }

  // ── the bezel ramp: four hues, same cyclic order, aligned at the lit one ────
  {
    /** 0–360. */
    const hue = (hex: number): number => {
      const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, bl = (hex & 255) / 255;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn;
      if (d < 1e-9) return 0;
      const h = mx === r ? ((g - bl) / d + (g < bl ? 6 : 0)) : mx === g ? (bl - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    /** Walk a successor map into the cycle it encodes, starting at `from`. */
    const cycle = (succ: Map<number, number>, from: number, n: number): number[] => {
      const out = [from];
      for (let i = 1; i < n; i++) {
        const nx = succ.get(out[out.length - 1]);
        if (nx === undefined || out.includes(nx)) break;
        out.push(nx);
      }
      return out;
    };

    // 3D: for each building the three boxes wear three CONSECUTIVE ramp entries
    // bottom to top, so every adjacent pair is one edge of the cycle. Sweep seeds
    // until all four edges have been seen.
    const b = box3(40, 18, 12);
    const succ3 = new Map<number, number>();
    let lit3 = -1;
    for (let sd = 0; sd < 400; sd++) {
      const parts = s3.buildBuildingBoxes?.(b, sd, 'school');
      if (!parts || new Set(parts.map((p) => p.shape ?? 'box')).size !== 1) continue;
      const rest = parts.filter((p) => !(p.w > b.width + 1e-6 && p.d > b.depth + 1e-6)
        && !(Math.abs(p.w - b.width) < 1e-6 && Math.abs(p.d - b.depth) < 1e-6));
      const byCol = new Map<number, number[]>();
      for (const p of rest) {
        if (!byCol.has(p.color)) byCol.set(p.color, []);
        byCol.get(p.color)!.push(p.y);
      }
      const cols = [...byCol.entries()].sort((u, v) => u[1].length - v[1].length);
      const bezels = cols.slice(1).sort((u, v) => mean(u[1]) - mean(v[1])).map((e) => e[0]);
      for (let i = 0; i + 1 < bezels.length; i++) succ3.set(bezels[i], bezels[i + 1]);
      if (lit3 < 0) {
        const quads = s3.buildBuildingLights?.(b, sd, 'school') ?? [];
        const eq = (u: number, v: number) => Math.abs(u - v) < 1e-9;
        for (const q of quads) {
          const hit = rest.find((p) => eq(p.x, q.x) && eq(p.y, q.y) && eq(p.w, q.w) && eq(p.h, q.h));
          if (hit) { lit3 = hit.color; break; }
        }
      }
    }

    // 2D: `colorIndex` IS this renderer's `c0`, so four values give the whole
    // ramp; the bezels are the 2.2 px strokes that are not the ink pen.
    const succ2 = new Map<number, number>();
    let lit2 = -1;
    for (let ci = 0; ci < 4; ci++) {
      const sd = seed2(24, 40, 'residential');
      const day = rec2(24, 40, ci, sd, 'residential');
      const byCol = new Map<number, number[]>();
      for (const c of day.cmds) {
        if (c.t !== 'line' || Math.abs((c.w ?? 0) - 2.2) > 1e-9) continue;
        if (!byCol.has(c.col)) byCol.set(c.col, []);
        byCol.get(c.col)!.push(((c.y1 ?? 0) + (c.y2 ?? 0)) / 2);
      }
      const bezels = [...byCol.entries()].sort((u, v) => mean(v[1]) - mean(u[1])).map((e) => e[0]);
      for (let i = 0; i + 1 < bezels.length; i++) succ2.set(bezels[i], bezels[i + 1]);
      if (lit2 < 0) {
        const night = rec2(24, 40, ci, sd, 'residential', true);
        const ys = night.cmds.filter((c) => c.t === 'line')
          .map((c) => ((c.y1 ?? 0) + (c.y2 ?? 0)) / 2);
        if (ys.length) {
          const gy = mean(ys);
          let best = -1, bd = Infinity;
          for (const [col, list] of byCol) {
            const dd = Math.abs(mean(list) - gy);
            if (dd < bd) { bd = dd; best = col; }
          }
          lit2 = best;
        }
      }
    }

    const ramp3 = cycle(succ3, lit3, 4);
    const ramp2 = cycle(succ2, lit2, 4);
    check('each renderer\'s bezel ramp really is a FOUR-colour cycle and the lit '
      + 'entry is on it (otherwise the comparison below is vacuous)',
      succ3.size === 4 && succ2.size === 4 && ramp3.length === 4 && ramp2.length === 4
      && lit3 >= 0 && lit2 >= 0,
      `3D edges ${succ3.size} cycle ${ramp3.length} lit #${lit3.toString(16)} | `
      + `2D edges ${succ2.size} cycle ${ramp2.length} lit #${lit2.toString(16)}`);

    if (ramp3.length === 4 && ramp2.length === 4) {
      // Aligned at the LIT entry, then compared as hues. Not as values: the 2D
      // palette is deliberately muted to watercolour, so equal hex would be the
      // wrong assertion and equal ORDER is the right one.
      const dh = ramp3.map((c, i) => {
        const d = Math.abs(hue(c) - hue(ramp2[i]));
        return Math.min(d, 360 - d);
      });
      check('…and the two ramps run in the SAME cyclic hue order once aligned at '
        + 'the lit colour — that is what makes "the amber box is the lit one" one '
        + 'statement instead of two',
        dh.every((d) => d < 30),
        ramp3.map((c, i) => `${hue(c).toFixed(0)}°/${hue(ramp2[i]).toFixed(0)}°`).join(' '));
    }
  }

  // ── the sign is on the MIDDLE lid, stated as a coincidence ─────────────────
  {
    let bad = '';
    const shown: string[] = [];
    for (const [w, d, h] of [[17, 6.8, 10], [39.3, 20.3, 12], [82, 76, 19]] as const) {
      const b = box3(w, d, h);
      const L = lids3(b);
      const a = s3.signAnchor?.(b, 'school');
      if (!a || L.length !== 3) { bad ||= `3D ${w}x${h}: anchor ${JSON.stringify(a)}`; continue; }
      if (Math.abs(a.centerY - L[1].centre) > 1e-9) {
        bad ||= `3D ${w}x${h}: anchor ${a.centerY.toFixed(4)} vs middle lid ${L[1].centre.toFixed(4)}`;
      }
      shown.push(`3D ${h}m ✓`);
    }
    for (const [w, h] of [[24, 40], [40, 72], [40, 300]] as const) {
      const sd = seed2(w, h, 'school');
      const r = rec2(w, h, 0, sd, 'school');
      if (sd < 0 || !r.rep) { bad ||= `2D ${w}x${h}: no file-box seed`; continue; }
      const L = lids2(r.cmds, r.rep);
      // The label tape's strip is the only EIGHT-point polygon this body draws,
      // and it is drawn twice — its cast shadow first, then the tape. The second
      // one is the tape, and the mean of its eight corners is exactly the centre
      // `signPlacement` asked for.
      const strips = r.cmds.filter((c) => c.t === 'poly' && c.pts && c.pts.length === 8);
      if (L.tops.length !== 3 || strips.length !== 2) {
        bad ||= `2D ${w}x${h}: ${L.tops.length} seams / ${strips.length} strips`;
        continue;
      }
      // The middle band's centre is its seam MINUS half the band, and the band's
      // height is the gap between the top seam and the body top... which is not
      // available here without recomputing the layout. So the comparison is made
      // against the seam and the half-band is carried as the tolerance: the tape
      // must sit inside the middle lid band, `[seam − lidH, seam]`, and `lidH` is
      // at most a third of a tier by construction (`min(3.4k, tierH * 0.34)`).
      const tape = 500 - mean(strips[1].pts!.map((q) => q[1]));
      const lidMax = (L.tops[1] - L.tops[0]) * 0.34;
      if (!(tape <= L.tops[1] + 1e-6 && tape >= L.tops[1] - lidMax)) {
        bad ||= `2D ${w}x${h}: tape ${tape.toFixed(2)} outside the middle band `
          + `[${(L.tops[1] - lidMax).toFixed(2)}, ${L.tops[1].toFixed(2)}]`;
      }
      shown.push(`2D ${w}x${h} ✓`);
    }
    check('the label lands on the MIDDLE box\'s lid rim in both renderers — its '
      + 'centre IS that lid\'s centre, which the 3D names outright and the 2D '
      + 'arrives at from `2h/3 − lidH/2`',
      !bad, bad || shown.join(' '));
  }

  // ── and the 2D side really is the 2D DEMO's code ─────────────────────────
  //
  // Until this ran, NOTHING in `check:3d` executed `plan/phaser-handdrawn-demo
  // .html`. It was read twice as TEXT (a regex for the night veil colour, a
  // regex for the sun/moon hexes) and never once run — so the paper world's 2D
  // bodies had no demo diff at all, where `circuit-2d-vs-demo.ts` gives the
  // electronics world one. That is the same hole as §0.0 rule 6 ("照抄 is a
  // one-off action, 還是一樣 is not"), just in the renderer nobody was looking at.
  //
  // The demo's `drawFileBoxes` is sliced out with `wob`, `wq`, `PXM` and the
  // palette, run against the same recording stub the port is driven through, and
  // diffed COMMAND FOR COMMAND. Three things make that possible:
  //  · `grow = 1` on the demo's side and `k = 1` on the port's, which needs the
  //    drawn height at or above `demoH` — hence heights of 80/90/100 nominal.
  //  · seed 0 on the port's side, because the demo's wobble seeds are literals
  //    (`wq(…, 4)`, `wq(…, 7 + t * 3)`) where the port offsets them by the
  //    building's own hash (`seed + 4`) so neighbours do not wobble alike.
  //  · the school SIGNS itself, and the demo's dispatcher draws that tape from
  //    `drawLabelTape`, not from the body. So the demo's stream has to be a
  //    PREFIX of the port's, and what follows it has to be the tape — asserted,
  //    or "prefix" quietly becomes "we stopped drawing".
  {
    const src2 = readFileSync('plan/phaser-handdrawn-demo.html', 'utf8');
    const at2 = (n: string): number => {
      const i = src2.indexOf(n);
      if (i < 0) throw new Error(`the 2D demo no longer contains ${JSON.stringify(n)}`);
      return i;
    };
    /** A top-level `const x = {` … `\n};` object literal. */
    const objAt = (n: string): string => {
      const a = at2(n);
      return src2.slice(a, src2.indexOf('\n};', a) + 3);
    };
    const lineAt = (n: string): string => src2.slice(at2(n), src2.indexOf('\n', at2(n)));
    /** A top-level `function f(` … `\n}`. */
    const fnAt = (n: string): string => {
      const a = at2(n);
      return src2.slice(a, src2.indexOf('\n}', a) + 2);
    };
    /** A CLASS METHOD, promoted to a standalone function. */
    const methodAt = (n: string): string => {
      const a = at2(n);
      return `function ${src2.slice(a, src2.indexOf('\n  }', a) + 4).trimStart()}`;
    };
    const demoSrc = [
      lineAt('const PXM = 3;'),
      objAt('const PAINTED = {'),
      lineAt('const RING_PAINTED = '),
      fnAt('function wob(x, seed) {'),
      methodAt('  wq(g, x, y, w, h, seed) {'),
      methodAt('  drawFileBoxes(g, b, grow) {').replace(/this\.wq/g, 'wq'),
      // Paint mode ON, which is the demo's own default (`?paint=0` is the other
      // state and it only recolours, so it cannot change a command's geometry).
      'const C = PAINTED;',
      'const RING = RING_PAINTED;',
      'return (g, b) => drawFileBoxes(g, b, 1);',
    ].join('\n');
    const demoDraw = new Function('terrainY', demoSrc)(() => 498) as
      (g: unknown, b: { d: number; off: number; w: number; h: number; ci: number }) => void;

    let bad = '';
    const shown: string[] = [];
    // ⚠ 33 and 45 are here for the HANDLE PITCH and nothing else. At the other
    // three widths `round(w / 26)` and `round(w / 25)` agree (3/3, 2/2, 5/5), so a
    // mutation of the pitch survived the whole diff — measured, not guessed. Drawn
    // 64.35 px rounds to 2 at a 26 px pitch and 3 at 25; drawn 87.75 rounds to 3
    // and 4. Both heights keep `k` at 1 (drawn h ≥ demoH = 63) and stay under
    // `maxAR`, which is what lets the demo and the port be compared at all.
    for (const [W, H] of [[40, 80], [30, 90], [60, 100], [33, 90], [45, 100]] as const) {
      const dSink = new Sink2D();
      // `x = b.d * PXM + b.off` and `y = terrainY(…) + 2`, so these put the demo's
      // body at exactly the (200, 500) the port's is placed at.
      demoDraw(makeGraphics2D(dSink) as never, { d: 200 / 3, off: 0, w: W, h: H, ci: 0 });
      const theirs = (dSink as unknown as { cmds: Cmd[] }).cmds;
      const ours = rec2(W, H, 0, 0, 'school').cmds;
      if (theirs.length === 0) { bad ||= `${W}x${H}: demo drew nothing`; continue; }
      if (ours.length <= theirs.length) {
        bad ||= `${W}x${H}: demo ${theirs.length} cmds vs ours ${ours.length} — the tape is missing`;
        continue;
      }
      for (let i = 0; i < theirs.length && !bad; i++) {
        const a = theirs[i], b = ours[i];
        const key = (c: Cmd): string => [
          c.t, `#${c.col.toString(16).padStart(6, '0')}`, c.a.toFixed(4),
          (c.w ?? 0).toFixed(4),
          (c.pts ?? [[c.x1 ?? 0, c.y1 ?? 0], [c.x2 ?? 0, c.y2 ?? 0]])
            .map((q) => `${q[0].toFixed(4)},${q[1].toFixed(4)}`).join(' '),
        ].join('|');
        if (key(a) !== key(b)) bad = `${W}x${H} cmd ${i}: demo ${key(a)} vs ours ${key(b)}`;
      }
      // What follows the prefix must be the label tape, not nothing: its strip is
      // the district's own tape colour, which appears nowhere in the body.
      const tail = ours.slice(theirs.length);
      if (!bad && !tail.some((c) => c.col === 0x3f8f8c)) {
        bad = `${W}x${H}: ${tail.length} commands after the body but no tape among them`;
      }
      shown.push(`${W}x${H} ${theirs.length}+${ours.length - theirs.length}`);
    }
    check('2D: the port draws the DEMO\'s file boxes, command for command — same '
      + 'colours, alphas, pen widths and points, with the label tape appended '
      + '(the 2D demo had never been executed by any check before this)',
      !bad, bad || `${shown.join(' ')} (body cmds + tape cmds)`);
  }

  s3.dispose();
}
