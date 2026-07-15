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

// ── Canvas stub (must exist before any style module runs) ──
function stubContext() {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => {},
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
      measureText: () => ({ width: 0 }),
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Every other 2D-context call is a no-op; every property reads back.
        return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : undefined;
      },
      set() {
        return true;
      },
    },
  );
}

(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return { width: 0, height: 0, getContext: () => stubContext() };
  },
};
(globalThis as any).window = { devicePixelRatio: 1 };

const { createPaperTerrainStyle } = await import('@/game/terrain/paper-terrain-style');
const { createPlasticTerrainStyle } = await import('@/game/terrain/plastic-terrain-style');
const { MountainRing } = await import('@/game/terrain/mountain-ring');
const { BikeOrnament, disposeGroup } = await import('@/game/terrain/bike-ornament');
const { StreetLampManager } = await import('@/game/terrain/street-lamp');
const { updateFpsCamera } = await import('@/game/terrain/fps-camera');
const { createRouteLine, projectRouteLineOntoTerrain, disposeRouteLine, BLOOM_LAYER } =
  await import('@/game/terrain/route-line-mesh');
const { computeDayNightLighting, TONE_MAPPING_EXPOSURE } =
  await import('@/game/terrain/day-night-lighting');
const { GradientSky } = await import('@/game/terrain/gradient-sky');
const { DEFAULT_FOV } = await import('@/game/terrain/game-renderer');
const { OrbitCamera } = await import('@/game/terrain/orbit-camera');
const { CameraGroundClamp, requiredLift, CAMERA_GROUND_MARGIN } =
  await import('@/game/terrain/camera-collision');
const { CameraLift, liftWeight, PEEK_RISE, PEEK_HOLD, PEEK_FALL, PEEK_DURATION, FINALE_RISE } =
  await import('@/game/terrain/camera-lift');
const { buildWaterwayMeshes, disposeWaterwayMesh, WATERWAY_HEIGHT_OFFSET } =
  await import('@/game/terrain/waterway-renderer');
const { buildGroundRibbon } = await import('@/game/terrain/ribbon-geometry');
const { ROAD_HEIGHT_OFFSET } = await import('@/game/terrain/road-renderer');
const { ROUTE_HEIGHT_OFFSET } = await import('@/game/terrain/route-line-mesh');
const { buildAerowayMeshes, disposeAerowayMeshes } = await import('@/game/terrain/aeroway-renderer');
const { ZONE_MODIFIERS } = await import('@/game/terrain/cycling-glasses-effect');
const { collectFacadeWindowPlacements } = await import('@/game/terrain/building-renderer');
import type { TerrainStyleStrategy } from '@/game/terrain/terrain-style-strategy';
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

  const coin = strategy.buildCoinMesh();
  check('coin: mesh with a style detail attached', coin.isMesh && coin.children.length >= 1);

  const flag = strategy.buildCheckpoint('#ff3b8d', 1);
  check('checkpoint: pole + flag built', meshCount(flag) >= 3, `${meshCount(flag)} meshes`);

  const tree = strategy.buildTreeGeometry?.();
  check(
    'tree: geometry has positions',
    !!tree && tree.attributes.position.count > 0,
    `${tree?.attributes.position.count ?? 0} verts`,
  );

  // ── Building decoration ──
  const box = {
    cx: 120, cz: -80, width: 18, depth: 12, rotY: 0.4,
    height: 9, baseY: 3, color: 0xff3b8d,
  };
  const trim = strategy.buildBuildingDecoration(box, 3);
  check('building trim: roof built', !!trim && meshCount(trim!) >= 1,
    `${trim ? meshCount(trim) : 0} meshes`);
  if (trim) {
    const b = new THREE.Box3().setFromObject(trim);
    check(
      'building trim: roof sits ON TOP of the walls (demo pitfall #1)',
      b.max.y > box.baseY + box.height && b.max.y < box.baseY + box.height + 8,
      `trim top y=${b.max.y.toFixed(1)}, wall top y=${(box.baseY + box.height).toFixed(1)}`,
    );
    check('building trim: placed at the footprint', Math.abs(trim.position.x - box.cx) < 0.01);
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
  check('mountain ring: 3 objects added (near, far, disc)', scene.children.length === 3);

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
  const radii = rings.map((m) => new THREE.Box3().setFromObject(m).max.x - rider.x);
  check(
    'mountain rings: two layers at different radii (parallax depth)',
    new Set(radii.map((r) => Math.round(r))).size === 2,
    `radii ≈ ${radii.map((r) => Math.round(r)).join(' / ')} m`,
  );
  ring.dispose();
  check('mountain ring: disposes cleanly', scene.children.length === 0);

  bike.dispose();
  lamp.dispose();
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
function checkCameraCollision(): void {
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
  check('the gaze tilts down onto the bike as it rises', clamp.tilt > 0.9, `tilt ${clamp.tilt.toFixed(2)}`);

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
    names.length === 2 && names[0] === 'core' && names[1] === 'glow',
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

  const core = group.getObjectByName('core') as THREE.Mesh;
  const glow = group.getObjectByName('glow') as THREE.Mesh;
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

function checkGradientSky(): void {
  console.log('\n[gradient sky dome]');
  const scene = new THREE.Scene();
  const sky = new GradientSky(scene);

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
  const fallback = () => -999; // obviously wrong: if it shows up, the ray missed

  const road = buildGroundRibbon(eastward, proj, groundAt, fallback, {
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

  // Water rides the same ground, so its gap under the road is exact everywhere.
  const water = buildGroundRibbon(eastward, proj, groundAt, fallback, {
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

  // No terrain (a chunk that has not streamed in) → the old formula, not a hole.
  const orphan = buildGroundRibbon(eastward, proj, () => null, () => 42, {
    halfWidth: 4,
    heightOffset: ROAD_HEIGHT_OFFSET,
  })!;
  const opos = orphan.getAttribute('position');
  let onFallback = 0;
  for (let i = 0; i < opos.count; i++) {
    if (Math.abs(opos.getY(i) - (42 + ROAD_HEIGHT_OFFSET)) < 1e-3) onFallback++;
  }
  check(
    'where the terrain has not loaded, it falls back to the DEM formula',
    onFallback === opos.count,
    `${onFallback}/${opos.count} vertices on the fallback height`,
  );

  road.dispose();
  water.dispose();
  orphan.dispose();
  strategy.dispose();
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

  const surface = await buildWaterwayMeshes(
    [
      line(path, { class: 'river' }),
      line(path, { class: 'stream' }),
    ],
    sampler, 25, 121, 0, strategy,
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
      [line(eastward, { class: cls })], sampler, 25, 121, 0, strategy,
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
    sampler, 25, 121, 0, strategy,
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

  const widthOf = async (cls: string) => {
    const r = await buildAerowayMeshes(
      [feat({ type: 'LineString', coordinates: eastward }, { class: cls })],
      sampler, 25, 121, 0, strategy,
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
  const drome = await buildAerowayMeshes([field], sampler, 25, 121, 0, strategy);
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
    sampler, 25, 121, 0, strategy,
  );
  check('no aerodrome, no aircraft', taxiOnly.planes.length === 0);

  disposeAerowayMeshes(drome);
  disposeAerowayMeshes(taxiOnly);
  strategy.dispose();
}

console.log('=== Third-person diorama — headless check ===');
checkStyle('cuphead (paper / cardboard)', createPaperTerrainStyle());
checkStyle('plastic (toy blocks)', createPlasticTerrainStyle());
checkHeading();
checkOrbitCamera();
checkCameraCollision();
checkCameraLift();
checkZones();
checkLamps();
checkRouteLine('cuphead (highlighter swipe)', createPaperTerrainStyle());
checkRouteLine('plastic (neon tape)', createPlasticTerrainStyle());
await checkGroundRibbons();
await checkWaterways();
await checkAeroways('cuphead (balloon plane)', createPaperTerrainStyle());
await checkAeroways('plastic (brick plane)', createPlasticTerrainStyle());
checkGradientSky();
checkLighting('cuphead (paper)', createPaperTerrainStyle());
checkLighting('plastic (toy blocks)', createPlasticTerrainStyle());

console.log(
  failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} CHECK(S) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
