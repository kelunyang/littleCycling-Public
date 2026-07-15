/**
 * Plastic (toy BLOCKS) terrain style.
 *
 * A thin wrapper over `cartoon-materials.ts` (toon materials + neon palette).
 * The blocky look comes from the quantised terrain engine: cubic steps
 * (`layerHeight`/`gridSize`) plus a slight per-block height jitter
 * (`heightJitter`) so same-layer blocks read as hand-stacked bricks.
 */

import * as THREE from 'three';
import {
  terrainVertexColor as cmTerrainVertexColor,
  buildingColorFromCoord,
  roadColorForClass,
  roadWidthForClass,
  urbanColorForClass,
  TREE_TRUNK_COLOR,
  TREE_CANOPY_COLORS,
  createTerrainToonMaterial,
  createParkToonMaterial,
  createForestToonMaterial,
  createSandToonMaterial,
  createUrbanToonMaterial,
  createTreeMaterial,
  GRADIENT_MAP,
} from './cartoon-materials';
import { disposeGroup } from './bike-ornament';
import {
  defaultStyleParams,
  mulberry32,
  quantizeToLayer,
  type BikeOrnamentParts,
  type StreetLampParts,
  type StyleParams,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';

/**
 * Candy palette — MIRRORED from `styles/themes.scss` ($plastic map). Canvas and
 * WebGL materials can't read CSS custom properties, so these are hand-copied;
 * per CLAUDE.md, changing themes.scss means updating this block too.
 */
const CANDY = {
  ink: 0x1a1140,
  pink: 0xff3b8d,
  purple: 0xd500f9,
  cyan: 0x00d8ff,
  yellow: 0xffea00,
  amber: 0xffb300,
  green: 0x76ff03,
  mint: 0xb9f6ca,
} as const;

/** Brick colours cycled per building / per stacked storey. */
const BRICK_COLORS = [
  CANDY.pink, CANDY.cyan, CANDY.yellow, CANDY.green, CANDY.purple, CANDY.amber,
];

/** Toy play-mat the whole world sits on (matches the demo's purple mat). */
const PLAY_MAT_COLOR = 0x5a4aa8;

/** Two silhouette greens for the block mountain rings. */
const MOUNTAIN_FAR_COLOR = 0x4a9a78;
const MOUNTAIN_NEAR_COLOR = 0x1f7a52;

/** Brighten a colour toward white — glossy stud caps. */
function brighten(hex: number, f: number): number {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), f).getHex();
}

/** Glossy plastic material. */
function gloss(color: number, shininess = 90): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({ color, specular: 0xffffff, shininess });
}

/** Metres of road per repeat of the road texture (sets the dash pitch). */
const ROAD_TEXTURE_METERS = 12;

/** Unit stud (base at y = 0) — scaled per instance. Shared by every prop. */
function studGeometry(): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 12);
  geo.translate(0, 0.5, 0);
  return geo;
}

/**
 * An `nx × nz` grid of studs capping a `w × d` brick top at height `topY`,
 * centred on the local origin. One InstancedMesh per call — cheap, and it keeps
 * the "it's made of bricks" read on every prop.
 */
function studGrid(
  w: number,
  d: number,
  topY: number,
  color: number,
  nx = Math.max(2, Math.round(w / 3)),
  nz = Math.max(2, Math.round(d / 3)),
): THREE.InstancedMesh {
  const radius = Math.min(w / nx, d / nz) * 0.32;
  const height = Math.min(radius, 0.6);
  const mesh = new THREE.InstancedMesh(
    studGeometry(),
    new THREE.MeshToonMaterial({ color, gradientMap: GRADIENT_MAP }),
    nx * nz,
  );
  const dummy = new THREE.Object3D();
  let i = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      dummy.position.set(
        -w / 2 + (ix + 0.5) * (w / nx),
        topY,
        -d / 2 + (iz + 0.5) * (d / nz),
      );
      dummy.scale.set(radius, height, radius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Toy brick bike — black tyres, yellow hubs, glossy hot-pink tube frame.
 * Local axes: forward = +x, axle = z (see bike-ornament.ts).
 * Recipe lifted from `plan/ref-demo-plastic-src.js`.
 */
function buildBrickBike(): BikeOrnamentParts {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);

  const frameMat = gloss(CANDY.pink, 110);
  const tyreMat = new THREE.MeshToonMaterial({ color: 0x262a38, gradientMap: GRADIENT_MAP });
  const hubMat = gloss(0xffd400, 120);
  const spokeMat = gloss(0xf4f8ff, 100);
  const inkMat = new THREE.MeshToonMaterial({ color: CANDY.ink, gradientMap: GRADIENT_MAP });
  const crankMat = gloss(0xc8cdd4, 90);
  const pedalMat = new THREE.MeshToonMaterial({ color: CANDY.yellow, gradientMap: GRADIENT_MAP });

  const R = 2.1;
  const wheels: THREE.Object3D[] = [];
  for (const x of [-2.9, 2.9]) {
    const wheel = new THREE.Group();
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.42, 12, 36), tyreMat));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 16), hubMat);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.22, R * 2 - 0.6, 0.22), spokeMat);
      spoke.rotation.z = (i / 3) * Math.PI;
      wheel.add(spoke);
    }
    wheel.position.set(x, R, 0);
    lean.add(wheel);
    wheels.push(wheel);
  }

  // One bent tube for the whole frame (rear axle → seat → bottom bracket →
  // head tube → front axle), exactly like the demo.
  const framePath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.9, R, 0),
    new THREE.Vector3(-1.0, 5.1, 0),
    new THREE.Vector3(-0.1, 2.3, 0),
    new THREE.Vector3(2.3, 5.3, 0),
    new THREE.Vector3(2.9, R, 0),
  ], false, 'catmullrom', 0.12);
  lean.add(new THREE.Mesh(new THREE.TubeGeometry(framePath, 48, 0.26, 10), frameMat));
  lean.add(new THREE.Mesh(new THREE.TubeGeometry(
    new THREE.LineCurve3(new THREE.Vector3(-1.0, 5.0, 0), new THREE.Vector3(2.25, 5.2, 0)),
    2, 0.24, 10,
  ), frameMat));

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 3.4, 10), inkMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(2.3, 5.6, 0);
  lean.add(bar);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.7, 10), hubMat);
    grip.rotation.x = Math.PI / 2;
    grip.position.set(2.3, 5.6, 1.75 * s);
    lean.add(grip);
  }

  const saddle = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.8, 1.2), inkMat);
  saddle.position.set(-1.05, 6.0, 0);
  lean.add(saddle);
  const saddleStud = studGrid(2.1, 1.2, 6.4, 0x3a2a70, 1, 1);
  saddleStud.position.x = -1.05;
  lean.add(saddleStud);

  const crank = new THREE.Group();
  crank.position.set(-0.1, 2.3, 0);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.5, 8), crankMat);
    arm.position.set(0, 0.75 * s, 0.5 * s);
    crank.add(arm);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.65), pedalMat);
    pedal.position.set(0, 1.5 * s, 0.78 * s);
    crank.add(pedal);
  }
  lean.add(crank);

  return { root, lean, wheels, crank, dispose: () => disposeGroup(root) };
}

/** Brick street lamp — grey post, translucent yellow head that lights at night. */
function buildBrickLamp(): StreetLampParts {
  const group = new THREE.Group();
  const poleMat = new THREE.MeshToonMaterial({ color: 0x8a90a0, gradientMap: GRADIENT_MAP });

  const foot = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 2), poleMat);
  foot.position.y = 0.6;
  group.add(foot);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 8.5, 10), poleMat);
  pole.position.y = 1.2 + 4.25;
  group.add(pole);

  const headMat = new THREE.MeshPhongMaterial({
    color: CANDY.yellow,
    transparent: true,
    opacity: 0.85,
    specular: 0xffffff,
    shininess: 130,
    emissive: 0x000000,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), headMat);
  head.position.y = 10.5;
  group.add(head);
  group.add(studGrid(1.8, 1.8, 11.4, brighten(CANDY.yellow, 0.3), 1, 1));

  const light = new THREE.PointLight(0xffe860, 0, 26, 1.8);
  light.position.y = 10.4;
  group.add(light);

  let night = 0;
  let lightEnabled = true;

  return {
    group,
    setNight: (k) => {
      night = k;
      headMat.emissive.setRGB(k * 0.95, k * 0.82, k * 0.1);
      light.intensity = k * 14;
      // A dozen point lights in the scene cost real fragment work even at zero
      // intensity — hiding them by day takes them out of the render list.
      light.visible = lightEnabled && k > 0.02;
    },
    setLightEnabled: (enabled) => {
      lightEnabled = enabled;
      light.visible = enabled && night > 0.02;
    },
    dispose: () => disposeGroup(group),
  };
}

/**
 * Glossy road board with white dashes down the middle. Tiles along the road's
 * u axis (one repeat = ROAD_TEXTURE_METERS of road), v spans the road width.
 */
function createRoadTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#3a4055';
  ctx.fillRect(0, 0, w, h);

  // Slight sheen bands along the edges — moulded plastic, not asphalt.
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(0, 4, w, 5);
  ctx.fillRect(0, h - 9, w, 5);

  // Centre dashes: half the repeat painted, half blank.
  ctx.fillStyle = '#f0f4ff';
  ctx.fillRect(0, h / 2 - 3, w * 0.5, 6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Ground-overlay textures (farmland / sports) ──
// ShapeGeometry UVs are scene metres → `repeat = 1 / tile-metres`. Moulded
// plastic, so unlike the paper skin these lines are dead straight on purpose.

/** One farmland tile = 16 m picnic-check board in two moulded greens. */
function createFarmlandCheckTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const half = size / 2;
  ctx.fillStyle = '#9ccc3f';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#7db32e';
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);
  // A thin seam between tiles, like snapped-together plates.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, half - 1, size, 2);
  ctx.fillRect(half - 1, 0, 2, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 16, 1 / 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One sports tile = 20 m glossy pitch plate: bright green + crisp white lines. */
function createSportsPlateTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#37d158';
  ctx.fillRect(0, 0, size, size);
  // Court boundary + centre line, printed-on sharp.
  ctx.strokeStyle = '#f0f4ff';
  ctx.lineWidth = 4;
  const inset = 12;
  ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
  ctx.beginPath();
  ctx.moveTo(size / 2, inset);
  ctx.lineTo(size / 2, size - inset);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 20, 1 / 20);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Toy brick plane parked on the apron (origin at ground). Same construction
 * language as the brick bike: boxy shapes, glossy candy trim, black tyres.
 */
function buildBrickPlane(): THREE.Group {
  const group = new THREE.Group();

  const shellMat = gloss(0xf4f8ff, 120);
  const trimMat = gloss(CANDY.pink, 100);
  const wingMat = gloss(CANDY.yellow, 90);
  const windowMat = new THREE.MeshToonMaterial({ color: CANDY.ink, gradientMap: GRADIENT_MAP });
  const tyreMat = new THREE.MeshToonMaterial({ color: 0x14121f, gradientMap: GRADIENT_MAP });

  const BODY_Y = 1.7; // fuselage centreline height (clears the wheels)

  // Fuselage + pink nose block + tail fin.
  const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.7, 1.7), shellMat);
  body.position.y = BODY_Y;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 1.5), trimMat);
  nose.position.set(3.7, BODY_Y - 0.1, 0);
  group.add(nose);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.3), trimMat);
  fin.position.set(-2.9, BODY_Y + 1.5, 0);
  group.add(fin);
  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.22, 2.8), wingMat);
  tailPlane.position.set(-2.9, BODY_Y + 0.75, 0);
  group.add(tailPlane);

  // One flat wing plate straight through the body.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.26, 8.4), wingMat);
  wing.position.set(0.6, BODY_Y + 0.55, 0);
  group.add(wing);

  // Round window dots down each flank.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 10), windowMat);
      dot.rotation.x = Math.PI / 2;
      dot.position.set(2.2 - i * 1.25, BODY_Y + 0.25, side * 0.9);
      group.add(dot);
    }
  }

  // Propeller disc + three landing wheels (tyre + candy hub, like the bike's).
  const prop = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.16, 14), trimMat);
  prop.rotation.z = Math.PI / 2;
  prop.position.set(4.4, BODY_Y - 0.1, 0);
  group.add(prop);
  const wheelAt = (x: number, z: number) => {
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14), tyreMat);
    tyre.rotation.x = Math.PI / 2;
    tyre.position.set(x, 0.55, z);
    group.add(tyre);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.46, 10), wingMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(x, 0.55, z);
    group.add(hub);
  };
  wheelAt(1.6, -1.1);
  wheelAt(1.6, 1.1);
  wheelAt(-2.4, 0);

  return group;
}

export function createPlasticTerrainStyle(): TerrainStyleStrategy {
  const params: StyleParams = defaultStyleParams('plastic');

  // Shared singleton building material (matches the former module-level const).
  let buildingMaterial: THREE.MeshToonMaterial | null = null;

  // Shared singletons for the building trim (roofs / windows / stud caps). The
  // chunk disposer skips anything tagged `userData.shared`.
  const trimMaterials = new Map<string, THREE.Material>();
  const sharedTrim = (key: string, make: () => THREE.Material): THREE.Material => {
    let mat = trimMaterials.get(key);
    if (!mat) {
      mat = make();
      mat.userData.shared = true;
      trimMaterials.set(key, mat);
    }
    return mat;
  };
  const brickMat = (hex: number) =>
    sharedTrim(`brick-${hex}`, () => new THREE.MeshToonMaterial({
      color: hex, gradientMap: GRADIENT_MAP,
    }));

  // Road texture (dashes baked in) — one per strategy, cloned per material so
  // each road mesh can keep its own repeat.
  let roadTexture: THREE.CanvasTexture | null = null;
  const roadTex = () => {
    if (!roadTexture) roadTexture = createRoadTexture();
    return roadTexture;
  };

  // Ground-overlay textures — one per strategy, shared by every chunk's overlay.
  const overlayTextures = new Map<string, THREE.CanvasTexture>();
  const overlayTex = (key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture => {
    let tex = overlayTextures.get(key);
    if (!tex) {
      tex = make();
      overlayTextures.set(key, tex);
    }
    return tex;
  };

  const strategy: TerrainStyleStrategy = {
    style: 'plastic',
    params,

    // ── Colours ──
    terrainVertexColor: (elevation, worldX, worldZ) =>
      cmTerrainVertexColor(elevation, worldX, worldZ),
    buildingColor: (lon, lat) => buildingColorFromCoord(lon, lat),
    roadColor: (cls) => roadColorForClass(cls),
    roadWidth: (cls) => roadWidthForClass(cls),
    urbanColor: (cls) => urbanColorForClass(cls),
    treeTrunkColor: TREE_TRUNK_COLOR,
    treeCanopyColors: TREE_CANOPY_COLORS,

    // ── Materials ──
    createTerrainMaterial: () => createTerrainToonMaterial(),
    createBuildingMaterial: () => {
      if (!buildingMaterial) {
        buildingMaterial = new THREE.MeshToonMaterial({
          vertexColors: true,
          gradientMap: GRADIENT_MAP,
          side: THREE.DoubleSide,
        });
      }
      return buildingMaterial;
    },
    // Glossy road board with the white dashes baked into the texture — the road
    // ribbon carries metre-scale u so the dashes keep a constant pitch.
    createRoadMaterial: () => {
      const map = roadTex();
      map.repeat.set(1 / ROAD_TEXTURE_METERS, 1);
      return new THREE.MeshPhongMaterial({
        map,
        specular: 0xffffff,
        shininess: 70,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
    },
    // Water = a transparent moulded brick: glossy, cyan, catches the sun.
    createWaterMaterial: () => new THREE.MeshPhongMaterial({
      color: CANDY.cyan,
      specular: 0xffffff,
      shininess: 160,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
    }),
    createParkMaterial: () => createParkToonMaterial(),
    createForestMaterial: () => createForestToonMaterial(),
    createSandMaterial: () => createSandToonMaterial(),
    createUrbanMaterial: (color) => createUrbanToonMaterial(color),
    createTreeMaterial: () => createTreeMaterial(),
    // Wetland = a jelly brick: like the water piece but greener and duller.
    createWetlandMaterial: () => new THREE.MeshPhongMaterial({
      color: 0x27d4a0,
      specular: 0xffffff,
      shininess: 110,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createFarmlandMaterial: () => new THREE.MeshToonMaterial({
      map: overlayTex('farmland', createFarmlandCheckTexture),
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // Sports pitch = a printed glossy plate.
    createSportsFieldMaterial: () => new THREE.MeshPhongMaterial({
      map: overlayTex('sports', createSportsPlateTexture),
      specular: 0xffffff,
      shininess: 80,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),

    // ── Diorama props ──

    horizonColor: PLAY_MAT_COLOR,

    // Candy-shop daylight → deep violet toy-box night. Straight from the plastic
    // demo (ref-demo-plastic-src.js DAY/NIGHT); tuned for exposure 1.05.
    skyPalette: {
      day: {
        skyTop: 0x8fd8ee, skyBottom: 0xffe0ef, fog: 0xefd8e8,
        sunColor: 0xfff6e0, sunIntensity: 2.0,
        hemiSky: 0xd8f0f8, hemiGround: 0x6ec06e, hemiIntensity: 0.9,
        ambientColor: 0xfff0f8, ambientIntensity: 0.35,
      },
      night: {
        skyTop: 0x14103a, skyBottom: 0x3a2a66, fog: 0x241d4d,
        sunColor: 0x8fa8e8, sunIntensity: 0.7,
        hemiSky: 0x2a2c60, hemiGround: 0x1c3a24, hemiIntensity: 0.5,
        ambientColor: 0xfff0f8, ambientIntensity: 0.18,
      },
    },

    // Neon tape down the middle of the road, purple spill underneath — the
    // widths/opacities are the plastic demo's (hl 1.6 @ 0.95, glow 4.2 @ 0.28).
    routeLine: {
      coreColor: CANDY.pink,
      coreWidth: 1.6,
      coreOpacity: 0.95,
      glowColor: CANDY.purple,
      glowWidth: 4.2,
      glowOpacity: 0.28,
    },
    tintTreeInstances: true,
    // Ink outlines are off for plastic anyway (params.inkEnabled = false).
    outlineTrees: true,

    mountainColor: (layer) =>
      layer === 'near' ? MOUNTAIN_NEAR_COLOR : MOUNTAIN_FAR_COLOR,

    // Two sine waves mixed, then QUANTISED to 6 levels and held for a few
    // segments → the stepped brick skyline (the plastic answer to cuphead's
    // jagged peaks).
    generateMountainProfile: (_layer, seed, segments) => {
      const rng = mulberry32(seed);
      const phase1 = rng() * 9;
      const phase2 = rng() * 9;
      const levels = 6;
      const profile: number[] = [];
      let held = 0;
      let current = 0;
      for (let i = 0; i <= segments; i++) {
        if (held <= 0) {
          const a = (i / segments) * Math.PI * 2;
          const raw = 0.5 + 0.32 * Math.sin(a * 5 + phase1) + 0.22 * Math.sin(a * 11 + phase2);
          current = Math.round(Math.max(0.12, Math.min(1, raw)) * levels) / levels;
          held = 2 + Math.floor(rng() * 3);
        }
        profile.push(current);
        held--;
      }
      return profile;
    },

    buildBikeOrnament: () => buildBrickBike(),
    buildPlaneOrnament: () => buildBrickPlane(),

    buildStreetLamp: () => buildBrickLamp(),

    // Coin = a round brick tile with a stud on its face.
    buildCoinMesh: () => {
      const mat = gloss(0xffd400, 120);
      mat.emissive.setHex(0x4a3a00);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.5, 20), mat);
      disc.geometry.rotateX(Math.PI / 2);
      const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.35, 14), mat);
      stud.geometry.rotateX(Math.PI / 2);
      stud.position.z = 0.42;
      disc.add(stud);
      disc.userData.isCoin = true;
      return disc;
    },

    // Checkpoint = 2×2 base brick + grey post + coloured flag brick.
    buildCheckpoint: (color) => {
      const group = new THREE.Group();
      const flagColor = new THREE.Color(color);
      const poleMat = new THREE.MeshToonMaterial({ color: 0x8a90a0, gradientMap: GRADIENT_MAP });

      const foot = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 3), poleMat);
      foot.position.y = 0.7;
      group.add(foot);
      group.add(studGrid(3, 3, 1.4, 0xaab0c0, 2, 2));

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12, 10), poleMat);
      pole.position.y = 1.4 + 6;
      group.add(pole);

      const flagMat = new THREE.MeshToonMaterial({ color: flagColor, gradientMap: GRADIENT_MAP });
      const flag = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 0.5), flagMat);
      flag.position.set(3.2, 11, 0);
      group.add(flag);

      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 12, 10),
        new THREE.MeshPhongMaterial({ color: flagColor, specular: 0xffffff, shininess: 120 }),
      );
      cap.position.y = 13.6;
      group.add(cap);
      return group;
    },

    // Roof for one brick building. The walls are the merged MVT extrusion; this
    // adds the toy silhouette: a pitched roof brick, or a stud cap on tall
    // towers. Windows are batched separately — see collectFacadeWindows.
    buildBuildingDecoration: (box, seed) => {
      const group = new THREE.Group();
      const roofColor = BRICK_COLORS[(seed + 2) % BRICK_COLORS.length];
      const top = box.baseY + box.height;
      const tall = box.height > 14;

      if (tall) {
        // Tower: a smaller brick set back on the roof, plus stud caps.
        const capW = box.width * 0.55;
        const capD = box.depth * 0.55;
        const capH = Math.min(6, box.height * 0.2);
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(capW, capH, capD),
          brickMat(roofColor),
        );
        cap.position.set(0, top + capH / 2, 0);
        group.add(cap);
        group.add(studGrid(capW, capD, top + capH, brighten(roofColor, 0.25), 2, 2));
      } else {
        // House: a triangular-prism roof brick sitting on the walls.
        const shape = new THREE.Shape();
        const hw = box.width / 2 + 0.4;
        shape.moveTo(-hw, 0);
        shape.lineTo(hw, 0);
        shape.lineTo(0, Math.min(4.5, box.width * 0.45));
        shape.closePath();
        const depth = box.depth + 0.8;
        const roof = new THREE.Mesh(
          new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }),
          brickMat(roofColor),
        );
        // ExtrudeGeometry pushes along +z; centre it across the depth.
        roof.position.set(0, top, -depth / 2);
        group.add(roof);
      }

      group.position.set(box.cx, 0, box.cz);
      group.rotation.y = box.rotY;
      return group;
    },

    // Glossy white window boxes proud of the two long faces — the building
    // renderer grids, rotates, and batches them (one InstancedMesh per chunk).
    facadeWindows: {
      colSpacing: 5,
      rowSpacing: 5,
      skipProb: 0.12,
      faceOffset: 0.1,
      flipBackFace: false, // solid glossy boxes look the same from both sides
      createTemplate: () => ({
        geometry: new THREE.BoxGeometry(1.9, 1.5, 0.3),
        material: sharedTrim('window', () => gloss(0xf4f8ff, 140)),
      }),
    },

    // ── Geometry hooks ──
    quantizeElevation: (absEle) => quantizeToLayer(absEle, params),

    // Block trees — stacked cuboids (trunk + tiered canopy).
    buildTreeGeometry: () => buildBlockTreeGeometry(strategy.treeTrunkColor, strategy.treeCanopyColors[0]),

    // ── Post ──
    // Plastic uses no screen-space pass — geometry + toon shading carry the look.
    createPostPass: () => null,
    applyPostParams: () => { /* no post pass */ },

    dispose: () => {
      buildingMaterial?.dispose();
      buildingMaterial = null;
      for (const mat of trimMaterials.values()) mat.dispose();
      trimMaterials.clear();
      roadTexture?.dispose();
      roadTexture = null;
      for (const tex of overlayTextures.values()) tex.dispose();
      overlayTextures.clear();
    },
  };

  return strategy;
}

/**
 * Build one block tree: a cuboid trunk + tiered cuboid canopy, vertex-coloured
 * (trunk brown, canopy green). Non-indexed so it flat-shades crisply and
 * concatenates trivially. Sized to roughly match the former cone tree so the
 * instance scale/placement still reads well.
 */
function buildBlockTreeGeometry(trunkColor: number, canopyColor: number): THREE.BufferGeometry {
  const trunk = new THREE.Color(trunkColor);
  const canopy = new THREE.Color(canopyColor);

  const parts: { geo: THREE.BoxGeometry; y: number; color: THREE.Color }[] = [
    { geo: new THREE.BoxGeometry(0.8, 2.0, 0.8), y: 1.0, color: trunk },
    { geo: new THREE.BoxGeometry(4.2, 2.0, 4.2), y: 3.2, color: canopy },
    { geo: new THREE.BoxGeometry(3.0, 1.6, 3.0), y: 5.0, color: canopy },
    { geo: new THREE.BoxGeometry(1.6, 1.4, 1.6), y: 6.4, color: canopy },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  for (const part of parts) {
    part.geo.translate(0, part.y, 0);
    const ng = part.geo.toNonIndexed();
    const pos = ng.attributes.position.array as ArrayLike<number>;
    const nrm = ng.attributes.normal.array as ArrayLike<number>;
    const vCount = ng.attributes.position.count;
    for (let i = 0; i < vCount * 3; i++) {
      positions.push(pos[i]);
      normals.push(nrm[i]);
    }
    for (let v = 0; v < vCount; v++) {
      colors.push(part.color.r, part.color.g, part.color.b);
    }
    ng.dispose();
    part.geo.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}
