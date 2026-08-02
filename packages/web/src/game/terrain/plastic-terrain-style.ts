/**
 * Plastic (toy BLOCKS) terrain style.
 *
 * Its palette and material factories live next door in `plastic-materials.ts`
 * — this world's own shelf, not a shared one (`plan/world-modularity-refactor.md`).
 * The blocky look comes from the quantised terrain engine: cubic steps
 * (`layerHeight`/`gridSize`) plus a slight per-block height jitter
 * (`heightJitter`) so same-layer blocks read as hand-stacked bricks.
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SceneBloomPass } from './scene-bloom-pass';
import {
  terrainVertexColor as pmTerrainVertexColor,
  buildingColorFromCoord,
  roadColorForClass,
  roadWidthForClass,
  createTerrainToonMaterial,
  createParkToonMaterial,
  createForestToonMaterial,
  createTreeMaterial,
} from './plastic-materials';
import { GRADIENT_MAP } from './cartoon-materials';
import { disposeGroup } from './bike-ornament';
import {
  registerNightLitMaterial,
  unregisterNightLitMaterial,
  type WindowPlacement,
} from './building-lights';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  celestialDiscRadius,
  defaultStyleParams,
  mulberry32,
  markInstanceTemplate,
  quantizeToLayer,
  type BikeOrnamentParts,
  type BoxPart,
  type BuildingBox,
  type LandusePropContext,
  type PartShape,
  type FinishAirshipParts,
  type SignParts,
  type SignPurpose,
  type StreetLampParts,
  type StyleParams,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';
import { SIGN_RATIO, sanitizeSignText, signStrokes, type ZoneKind } from './sign-spec';
import { buildStrokeGeometry, buildSignTriangleGeometry, roundedPlateShape } from './sign-builder';

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

/**
 * Sign carrier: the printed sticker sheet that comes in the toy box.
 *
 * NOT letter bricks, even though this world has a full geometric alphabet in
 * relief — letter bricks are already the school building (DEVPLAN「一個元件只能
 * 有一個身分」). The two stay apart because a sticker is PRINTED: its relief is
 * a fraction of a letter brick's, and it is applied crooked with a bubble in one
 * corner, which no moulded brick ever is.
 */
const STICKER_FIELD_COLORS: Record<ZoneKind, number> = {
  commercial: CANDY.pink,
  school: CANDY.cyan,
  hospital: 0xf5f7ff,
  residential: CANDY.mint,
  industrial: CANDY.amber,
};

/** The white border every toy-set sticker is die-cut with. */
const STICKER_BACKING_COLOR = 0xf7f8fb;

/** Hospital triangle. Never a red cross — see `sign-spec.ts`. */
const STICKER_TRIANGLE_COLOR = 0xe23b3b;

/** Width ceiling in metres. Letter bricks are 24 m wide here; without a cap a
 *  sign on a wide building becomes a wall. */
const SIGN_MAX_WIDTH = 8.5;

/** Brick colours cycled per building / per stacked storey. */
const BRICK_COLORS = [
  CANDY.pink, CANDY.cyan, CANDY.yellow, CANDY.green, CANDY.purple, CANDY.amber,
];

/**
 * The stacking tower's own constants, from `plan/plastic-town-demo.html`:
 * one slab is `LAYER_H` thick, layers show a `SLAB_GAP` seam, and a slab pulled
 * out of the stack never juts further than `MAX_PULL` (any more and it pokes
 * into the road).
 *
 * These are the demo's literals, not a re-derivation. `LAYER_H` is the only one
 * that becomes a target rather than the value used — see `plasticTowerSlabs`
 * for why a body has to end exactly at `box.height`.
 */
const LAYER_H = 2.3;
const SLAB_GAP = 0.16;
const MAX_PULL = 3.2;

/**
 * Clay dries a shade paler than it was pressed, so the pixel house's palette is
 * the candy one pulled toward white. It is also the cheapest half of what keeps
 * the clay house apart from the stacking tower, which uses the palette raw.
 */
const CLAY_LIGHTEN = 0.34;
/** The pixel house's window: a voxel RECOLOURED, never a hole cut in the shell. */
const CLAY_WINDOW_COLOR = 0xfff3b0;
/** …and its door, same trick, one voxel of the ground floor. */
const CLAY_DOOR_COLOR = 0x6b4a2a;
/** Domino plates. Nothing else in this world is white — that alone separates the
 *  hospital wall from three candy-coloured neighbours at any distance. */
const PORCELAIN_COLOR = 0xf6f8ff;
const DOMINO_PLINTH_COLOR = 0xc9cfe4;
/** The plate a cup tower stands its next storey of cups on. */
const CUP_PLATE_COLOR = 0xf4f6ff;
/** Letter blocks stand on a solid bar, so the gaps between them are not holes. */
const ABC_PLINTH_COLOR = 0xeef1ff;

/**
 * The BASEPLATE the whole world stands on, out past the terrain corridor.
 *
 * Colour is the demo's play-mat violet (`mat0`), NOT the demo's bright-green
 * board, and that is a deliberate departure from「底板 = 亮綠」. In the demo the
 * green board is the corridor you ride on and the violet mat is the table it
 * lies on; gameview's corridor is real quantised terrain in this world's greens,
 * so a green baseplate stretching to the horizon would merge straight into it
 * and there would be nothing left saying "the model ends here, the table starts".
 * Violet keeps that edge — and against it the studs read at a glance.
 */
const BASEPLATE_COLOR = 0x5a4aa8;
/** Stud caps, and the shadow under them: the same violet lifted / dropped. */
const BASEPLATE_STUD_TOP = 0x7d6cd0;
const BASEPLATE_STUD_SHADE = 0x3d3078;
/**
 * Ground metres per stud. A real baseplate's pitch is 8 mm; here one stud is
 * 16 m, because the surface it lives on starts ~540 m from the rider and runs to
 * 4 km. Anything at true toy pitch would be finer than a pixel at the disc's
 * inner rim and would mip straight to flat violet — the studs would exist only
 * in the texture file. 16 m holds a readable cell for the first few hundred
 * metres of mat and fades honestly beyond that, which is what a real baseplate
 * does when you back away from it.
 */
const BASEPLATE_STUD_PITCH = 16;
/** Studs per texture tile → tile = 8 × 16 = 128 m. */
const BASEPLATE_STUDS_PER_TILE = 8;
const BASEPLATE_TILE_METERS = BASEPLATE_STUD_PITCH * BASEPLATE_STUDS_PER_TILE;

/**
 * District wash colours — the demo's `ZONE_COLOR`, straight from the candy
 * palette, and the hues are chosen the way the demo chose them: five separated
 * hues (mint / 55° / 190° / 288° / 330°) so that at 0.6 opacity over ground they
 * stay apart instead of collapsing into one muddy tint. Green is not in the list
 * on purpose — it belongs to grass and trees, and a green district would be
 * indistinguishable from a park.
 */
const ZONE_DECAL_COLORS: Record<ZoneKind, number> = {
  residential: CANDY.mint,
  commercial: CANDY.yellow,
  industrial: CANDY.cyan,
  school: CANDY.purple,
  hospital: CANDY.pink,
};

/**
 * The board's own green — the demo's `C.baseGreen`.
 *
 * It is ALSO `TERRAIN_COLOR_STOPS[0]` in `plastic-materials.ts` (the grass stop
 * every route under 500 m sits on), which is why a baseplate stud can take it
 * unchanged: the stud and the ground it is moulded with really are one colour
 * here. Nothing to reconcile — the two numbers were already the same one.
 */
const BASE_GREEN = 0x39e75f;

/** 公園的凸點 = 公園色。同一塊塑膠射出來的東西不會兩個色。(demo: `'#66ff70'`) */
const PARK_STUD_COLOR = 0x66ff70;

/**
 * 地形的**單色分層**(製圖上的 hypsometric tinting,單色相流派)。
 *
 * demo(`plan/plastic-town-demo.html`)的原文,一個字沒改:
 *
 * > 原本每一階都用同一組綠,疊起來就糊成一坨 —— 那是任何一張地圖都不會做的事:
 * > 用同一個色帶塗完整個高程範圍。分層設色的兩條慣例是:
 * >   ・**色帶按高度分階**(這裡走單色相的明度階,不是綠→黃→褐的色相階 ——
 * >     色相階會讓地形不再是一片綠,那是另一種世界了)
 * >   ・**踏面 = 色帶,側面 = 等高線**。層積模型的垂直面就是上面那片板的切口,
 * >     在讀圖上扮演的角色是等高線本身,所以側面一律比自己的踏面深一階。
 * >
 * > 方向是**山腳深、山頭淡**(跟瓦楞紙世界一致,也是經典色階的方向)。底板就是
 * > 第 0 階,顏色一格沒動 —— 亮綠底板是這個世界的招牌,不能為了分層去改它。
 * > 越高越淡,頂上那階接近薄荷白,剛好就是經典色階頂端的雪。
 * >
 * > 全部是玩具磚真的有的綠。階高 = 4(一片 plasticSlab 的厚度)。
 *
 * 第 0 階的 `top` 就是 `BASE_GREEN` / `TERRAIN_COLOR_STOPS[0]` / demo 的
 * `C.baseGreen` —— 三個數字本來就是同一個,所以「底板顏色一格沒動」在這裡是
 * 字面上成立的,不是近似。
 */
const TERRAIN_BAND: readonly { top: string; side: string }[] = [
  { top: '#39e75f', side: '#1fae44' },   // 0 底板(維持原色)
  { top: '#5cef7d', side: '#2fbe58' },
  { top: '#7ef59a', side: '#46cf74' },
  { top: '#9ffab6', side: '#63dc90' },
  { top: '#bffdd0', side: '#84e8ab' },
];

/**
 * 階高。demo 是 `const STEP_H = 4;`——**一片 plasticSlab 的厚度**,也就是它的
 * 地形量化階。
 *
 * ⚠ 這段原本寫著「gameview 的量化階是 `params.layerHeight`(預設 6…),所以搬過來的是
 * **關係**而不是 4 這個數字」。**那個 6 是移植時發明的,2026-07-29 已經改回 demo 的 4**
 * (`defaultStyleParams`,連同 paper 12 → 3.2 —— 那個 3.75 倍讓瓦楞紙的台階與豎邊紋理
 * 一起走樣)。關係仍然成立且仍然是重點,但現在**數字也對了**,而且有斷言把它釘在
 * demo 的 `STEP_H` 上(`terrain-band-vs-demo.ts` 的 `[terrace step height vs demo]`)。
 *
 * 使用者仍然可以在調校面板改它(滑桿 step 已改成 0.1,不然回不到 paper 的 3.2)。
 *
 * 這個選擇是量出來的,不是猜的:大直路線實測,離路面 0…4 階之內的格子佔 86.1%
 * (0 階 21.0% / +1 13.2% / +2 5.9% / +3 4.1% / +4 3.0%,路面以下 39% 全部夾在
 * 第 0 階),所以五階色帶蓋得住這條路線絕大部分的地形。真正撞到表尾夾死的只有
 * 13.9%,而且都在遠處的山腰以上。
 */
const bandColors = TERRAIN_BAND.map((b) => ({
  top: new THREE.Color(b.top),
  side: new THREE.Color(b.side),
}));

/**
 * 貼花疊在底板上實際看到的顏色(0.6 分區色 + 0.4 底板綠)。凸點吃這個。
 *
 * demo 的 `zoneStudColor` 原封搬過來,連同它的理由:
 *
 * > 分區貼花底下的凸點要**跟著分區的顏色**,不是留著底板綠。貼花是半透明色塊
 * > (opacity 0.6)刷在板子上,而凸點是從 0 長到 0.7、整根穿出色塊的 —— 凸點留
 * > 綠色的話,讀起來是「綠色的釘子插過一張色紙」,不是「一塊有顏色的積木」。同
 * > 一塊塑膠射出來的東西不會兩個色,這條規則在分區上也一樣成立。
 * >
 * > 顏色取貼花實際疊出來的結果(0.6 分區色 + 0.4 底板色),不是分區色原值 ——
 * > 直接用原值的話凸點會比它腳下的板面濃一階,反而更跳。
 *
 * Memoised exactly like the demo's `zoneStudCache`: the colour is what buckets
 * the studs into InstancedMeshes, so it has to be the same number every call.
 */
const zoneStudCache = new Map<string, number>();
function zoneStudColor(zone: ZoneKind, band: number): number {
  const key = `${zone}|${band}`;
  let c = zoneStudCache.get(key);
  if (c === undefined) {
    // 「0.4 底板色」 —— 底板現在是**這一階的**踏面色,不是固定的亮綠。凸點跟著
    // 它腳下那塊磚走,分層設色也是磚的一部分。
    c = new THREE.Color(ZONE_DECAL_COLORS[zone]).lerp(bandColors[band].top, 0.4).getHex();
    zoneStudCache.set(key, c);
  }
  return c;
}

/** Two silhouette greens for the block mountain rings. */
const MOUNTAIN_FAR_COLOR = 0x4a9a78;
const MOUNTAIN_NEAR_COLOR = 0x1f7a52;

/** Brighten a colour toward white — glossy stud caps. */
function brighten(hex: number, f: number): number {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), f).getHex();
}

/** Darken a colour toward black — buried cores, the drink inside a cup. */
function deepen(hex: number, f: number): number {
  return new THREE.Color(hex).lerp(new THREE.Color(0x000000), f).getHex();
}

/** Glossy plastic material. */
function gloss(color: number, shininess = 90): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({ color, specular: 0xffffff, shininess });
}

/** Metres of road per repeat of the road texture (sets the dash pitch). */
const ROAD_TEXTURE_METERS = 12;

/**
 * One part of a themed body, in the building box's local frame.
 *
 * This is the renderer's `BoxPart` under the name the file has always used for
 * it. Not a copy: `buildBuildingBoxes` hands these straight to the building
 * renderer, which instances them, so a field added here has to mean the same
 * thing on both sides. `rotY` is used by the clay house only — a hand-pressed
 * lump is never square to its neighbour, and without the yaw the voxels snap
 * back into a grid and the house reads as another brick stack. `shape: 'cone'`
 * is used by the cup tower only, and is the whole reason it is no longer the one
 * body in this world that had to be merged.
 */
type ColoredBox = BoxPart;

/**
 * Merge axis-aligned coloured boxes into ONE geometry with baked vertex
 * colours and flat normals.
 *
 * THE SLOW PATH, kept for the bodies that are not all boxes (the cup tower) and
 * for anything that has to hand back real geometry. Everything that IS all
 * boxes now goes out as `BoxPart`s through `buildBuildingBoxes` and is
 * instanced by the building renderer instead — same picture, ~60× less CPU and
 * RAM (see `BoxPart` for the measurement). Both paths read the SAME layout
 * functions, which is what stops them drifting.
 *
 * A merged body has to arrive as one geometry that already carries its colours
 * — the merge path has a single vertex-colour material for the whole chunk, so
 * a multi-coloured building cannot be a Group of per-colour meshes.
 * (`building-renderer.ts` leaves a body's `color` attribute alone precisely so
 * this works.)
 *
 * 24 vertices per box, not 8: the faces need their own normals or the toon
 * shading rounds the corners off and the stack turns to mush.
 */
function buildColoredBoxes(boxes: ColoredBox[]): THREE.BufferGeometry {
  const n = boxes.length;
  const positions = new Float32Array(n * 24 * 3);
  const normals = new Float32Array(n * 24 * 3);
  const colors = new Float32Array(n * 24 * 3);
  const indices = new Uint32Array(n * 36);

  // +x, −x, +y, −y, +z, −z: face normal, then the two in-plane axes.
  const FACES: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];

  let v = 0;
  let i = 0;
  const lv = [0, 0, 0];
  // Scratch for the tilted case only (the clay house). One matrix reused, not
  // one per box: a 1 876-voxel house would otherwise allocate 1 876 of them.
  const rot = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const rv = new THREE.Vector3();
  for (const b of boxes) {
    const half = [b.w / 2, b.h / 2, b.d / 2];
    const centre = [b.x, b.y, b.z];
    const col = new THREE.Color(b.color);
    // Rotation is applied to the LOCAL corner offset, not to `half[c]` in
    // place: the axis-aligned form only works because exactly one of nrm/ax/ay
    // is non-zero per component, which stops being true the moment the box
    // turns.
    //
    // Yaw keeps its closed form because it is four bodies out of five and every
    // part of every other style. A TILTED part goes through the same
    // Euler→Matrix conversion `pushBodyBoxes` uses on the instanced side, so
    // the two paths agree by construction rather than by two hand-written sign
    // conventions matching.
    //
    // ⚠ UNEXERCISED, and deliberately said so. `rotX`/`rotZ` exist for the clay
    // house, and a clay lump is a `'clayCube'` — it leaves through
    // `buildTemplatePart`, not through here. So no style currently hands this
    // function a tilted BOX, and `npm run check:3d` cannot catch it going
    // wrong (mutating `tilted` to `false` passes the suite). It is kept because
    // `BoxPart` promises the fields on every part, not only on templated ones;
    // the first style that tilts a plain box gets a correct answer and also
    // gets this branch under test for the first time.
    const tilted = !!(b.rotX || b.rotZ);
    if (tilted) rot.makeRotationFromEuler(euler.set(b.rotX ?? 0, b.rotY ?? 0, b.rotZ ?? 0));
    const yaw = b.rotY ?? 0;
    const cy = tilted ? 1 : (yaw ? Math.cos(yaw) : 1);
    const sy = tilted ? 0 : (yaw ? Math.sin(yaw) : 0);
    for (const [nrm, ax, ay] of FACES) {
      const base = v;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        for (let c = 0; c < 3; c++) lv[c] = (nrm[c] + ax[c] * su + ay[c] * sv) * half[c];
        if (tilted) {
          rv.set(lv[0], lv[1], lv[2]).applyMatrix4(rot);
          positions[v * 3] = centre[0] + rv.x;
          positions[v * 3 + 1] = centre[1] + rv.y;
          positions[v * 3 + 2] = centre[2] + rv.z;
          rv.set(nrm[0], nrm[1], nrm[2]).applyMatrix4(rot);
          normals[v * 3] = rv.x;
          normals[v * 3 + 1] = rv.y;
          normals[v * 3 + 2] = rv.z;
        } else {
          positions[v * 3] = centre[0] + lv[0] * cy + lv[2] * sy;
          positions[v * 3 + 1] = centre[1] + lv[1];
          positions[v * 3 + 2] = centre[2] - lv[0] * sy + lv[2] * cy;
          normals[v * 3] = nrm[0] * cy + nrm[2] * sy;
          normals[v * 3 + 1] = nrm[1];
          normals[v * 3 + 2] = -nrm[0] * sy + nrm[2] * cy;
        }
        colors[v * 3] = col.r;
        colors[v * 3 + 1] = col.g;
        colors[v * 3 + 2] = col.b;
        v++;
      }
      indices[i++] = base; indices[i++] = base + 1; indices[i++] = base + 2;
      indices[i++] = base; indices[i++] = base + 2; indices[i++] = base + 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ── The unit templates this style instances (`BoxPart.shape`) ───────────────
//
// Copied out of `plan/plastic-town-demo.html` rather than re-derived, then
// normalised to unit extents (the frame `buildPartTemplate` documents). The
// demo's own numbers are kept as the literals they are in the demo, with the
// normalising divisor written next to them, so a diff against the demo is a
// glance rather than an archaeology dig.
//
// Why these are the style's and not the renderer's: they used to be ONE
// renderer-owned frustum with a taper of 0.7 and eight facets, which the cup had
// to be squeezed into. See `PartShape` — the squeeze cost the cup its rim and
// six of its fourteen facets, and nothing recorded that it had.

/** The demo's cup: `CylinderGeometry(1.62, 1.12, 3.0, 14, 1, true)`. */
const CUP_R_TOP = 1.62;
const CUP_R_BOTTOM = 1.12;
const CUP_HEIGHT = 3.0;
const CUP_SEGMENTS = 14;
/** …and the rim on top of it: `TorusGeometry(1.62, 0.14, 6, 16)`. */
const CUP_RIM_TUBE = 0.14;
const CUP_RIM_RADIAL = 6;
const CUP_RIM_TUBULAR = 16;
/** The demo's shelf between two storeys: `CylinderGeometry(1, 1, 0.22, 20)`. */
const CUP_PLATE_SEGMENTS = 20;
const CUP_PLATE_THICKNESS = 0.22;
/** …and the grid the cups are laid on, `3.5` m in the demo. NOT derived from
 *  the footprint: a fixed pitch with a count that drops by one per storey is
 *  the whole mechanism that makes the tower a trapezoid. */
const CUP_PITCH = 3.5;
/**
 * Ceiling on the ground storey's grid, and it is THE DEMO'S OWN GRID:
 * `cupTower(13, 9, 3)` gives `round(13 / 3.5)` = 4 columns by `round(9 / 3.5)`
 * = 3 rows. See `cupTowerLayout` for the measurement that made a ceiling
 * necessary at all — MVT industrial footprints reach 83 × 61 m, where the
 * demo's uncapped rule asks for 408 cups on one storey.
 */
const CUP_MAX_COLS = 4;
const CUP_MAX_ROWS = 3;

/**
 * The demo's rounded clay cube, `clayCubeGeo`, verbatim.
 *
 * "ExtrudeGeometry's bevel pushes OUTWARD, so the outline and the depth both
 * have to shrink by one bevel first or the result comes out bigger than a unit"
 * — the demo's own comment, and the reason the numbers look off by 2·b. What
 * comes out already spans −0.5 … +0.5 on every axis, so it needs no
 * normalisation of ours.
 */
function buildClayCubeTemplate(): THREE.BufferGeometry {
  const b = 0.13;
  const s = 1 - 2 * b;
  const h = s / 2;
  const k = s * 0.22;
  const sh = new THREE.Shape();
  sh.moveTo(-h + k, -h);
  sh.lineTo(h - k, -h); sh.quadraticCurveTo(h, -h, h, -h + k);
  sh.lineTo(h, h - k); sh.quadraticCurveTo(h, h, h - k, h);
  sh.lineTo(-h + k, h); sh.quadraticCurveTo(-h, h, -h, h - k);
  sh.lineTo(-h, -h + k); sh.quadraticCurveTo(-h, -h, -h + k, -h);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: s, bevelEnabled: true, bevelThickness: b, bevelSize: b,
    bevelSegments: 1, curveSegments: 1,
  });
  g.center();
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * The SOLID inside one cup — the demo's cup profile, filled and capped.
 *
 * The demo's cup is an OPEN shell drawn with a translucent `DoubleSide`
 * material: you see the far wall through the near one, and that translucency is
 * one of the five feels this world keeps its five buildings apart with. A merged
 * chunk body is opaque, single-sided and shares one material with 800 other
 * buildings, so the cup arrives in two halves — this solid, which is the body
 * and carries the volume, and the see-through wall around it, which is trim
 * (`buildCupWalls`) and is where the demo's open shell and its rim actually go.
 *
 * What is NOT adapted: the profile. 1.12/1.62 and fourteen facets, exactly the
 * demo's, so the solid and the wall around it are the same cone and the wall
 * cannot be pierced from inside.
 */
function buildCupTemplate(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(
    0.5, 0.5 * (CUP_R_BOTTOM / CUP_R_TOP), 1, CUP_SEGMENTS);
}

/** The demo's `cupPlateGeo`, normalised: a 20-sided disc one unit across and
 *  one unit thick, so `w`/`d` are its diameters and `h` its thickness. */
function buildPlateTemplate(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.5, 0.5, 1, CUP_PLATE_SEGMENTS);
}

/**
 * THE DEMO'S `cupGeo`, verbatim, normalised to unit extents.
 *
 *     const body = new THREE.CylinderGeometry(1.62, 1.12, 3.0, 14, 1, true);
 *     body.translate(0, 1.5, 0);
 *     const lip = new THREE.TorusGeometry(1.62, 0.14, 6, 16);
 *     lip.rotateX(Math.PI / 2);
 *     lip.translate(0, 3.0, 0);
 *     return mergeGeos([body, lip]);
 *
 * The OPEN shell plus the rim, which is what a translucent cup is: you see the
 * far wall through the near one, and the rim is the only horizontal line on the
 * whole vessel — the thing that reads as "cup" rather than "cone" at riding
 * distance. Both had been lost, because the shape used to be a renderer-owned
 * frustum with eight facets, no rim, and a taper of 0.7 against the demo's
 * 1.12/1.62 = 0.691.
 *
 * `mergeGeometries(…, false)` rather than the demo's hand-rolled `mergeGeos`:
 * same job, and it is already imported here. uv is dropped by the merge, which
 * the cup material does not have a map for anyway.
 */
function buildCupWallTemplate(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(
    CUP_R_TOP, CUP_R_BOTTOM, CUP_HEIGHT, CUP_SEGMENTS, 1, true);
  body.translate(0, CUP_HEIGHT / 2, 0);
  const lip = new THREE.TorusGeometry(
    CUP_R_TOP, CUP_RIM_TUBE, CUP_RIM_RADIAL, CUP_RIM_TUBULAR);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, CUP_HEIGHT, 0);
  body.deleteAttribute('uv');
  lip.deleteAttribute('uv');
  const merged = mergeGeometries([body.toNonIndexed(), lip.toNonIndexed()], false);
  body.dispose();
  lip.dispose();
  // Unit extents: full width 1 across the RIM-LESS body (so an instance scale of
  // `2 * rTop` gives a cup of top radius `rTop`), full height 1, centred.
  merged.scale(1 / (2 * CUP_R_TOP), 1 / CUP_HEIGHT, 1 / (2 * CUP_R_TOP));
  merged.translate(0, -0.5, 0);
  return merged;
}

/**
 * Template cache. Strategy-owned singletons that outlive every chunk — the
 * renderer clones what it is given (`unitPartGeometry`), so handing back the
 * cache entry is safe and is the point. Freed in `dispose()`.
 */
const PART_TEMPLATES = new Map<PartShape, THREE.BufferGeometry>();
function partTemplate(shape: PartShape): THREE.BufferGeometry | null {
  let geo = PART_TEMPLATES.get(shape);
  if (!geo) {
    if (shape === 'clayCube') geo = buildClayCubeTemplate();
    else if (shape === 'cup') geo = buildCupTemplate();
    else if (shape === 'plate') geo = buildPlateTemplate();
    else return null;
    PART_TEMPLATES.set(shape, geo);
  }
  return geo;
}

/**
 * One non-box part as real geometry, in the SAME frame and with the same
 * transform order the renderer's instance matrix uses (R · S, then the offset).
 * Scale first, then rotate: doing it the other way round shears a template whose
 * x and z extents differ, and the two paths would quietly disagree.
 *
 * Reads the SAME template the renderer instances rather than rebuilding the
 * shape, which is what makes "the merged body and the instanced body are the
 * same building" true by construction instead of by inspection.
 */
function buildTemplatePart(p: ColoredBox): THREE.BufferGeometry {
  const template = partTemplate(p.shape!);
  if (!template) throw new Error(`plastic style has no template for part shape '${p.shape}'`);
  const geo = template.clone();
  geo.scale(p.w, p.h, p.d);
  if (p.rotX || p.rotZ) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0)));
  } else if (p.rotY) {
    geo.rotateY(p.rotY);
  }
  geo.translate(p.x, p.y, p.z);
  return paintGeometry(geo, p.color);
}

/**
 * A whole body as ONE geometry — the merge path, kept honest against the
 * instanced one.
 *
 * Parts land in the buffer in the order they were given, whatever their shape,
 * because that is the order the renderer fills its instance batches in and the
 * two have to be comparable part by part (`npm run check:3d` does exactly that).
 * The all-boxes case, which is four bodies out of five, still goes straight
 * through the hand-written writer with no merge at all.
 */
function buildBodyGeometry(parts: ColoredBox[]): THREE.BufferGeometry {
  let shaped = 0;
  for (const p of parts) if (p.shape && p.shape !== 'box') shaped++;
  if (shaped === 0) return buildColoredBoxes(parts);

  const chunks: THREE.BufferGeometry[] = [];
  let run: ColoredBox[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    chunks.push(buildColoredBoxes(run));
    run = [];
  };
  for (const p of parts) {
    if (p.shape && p.shape !== 'box') {
      flushRun();
      chunks.push(buildTemplatePart(p));
    } else {
      run.push(p);
    }
  }
  flushRun();

  if (chunks.length === 1) return chunks[0];
  const merged = mergeGeometries(chunks, false);
  for (const g of chunks) g.dispose();
  return merged;
}

/**
 * Arch outline for a tunnel mouth: a rectangle with a semicircular top, as a
 * closed Shape (or Path, for the opening cut out of a frame).
 */
function archOutline<T extends THREE.Shape | THREE.Path>(
  out: T, w: number, h: number,
): T {
  const hw = w / 2;
  const straight = Math.max(0.1, h - hw);
  out.moveTo(-hw, 0);
  out.lineTo(-hw, straight);
  out.absarc(0, straight, hw, Math.PI, 0, true);
  out.lineTo(hw, 0);
  out.closePath();
  return out;
}

/** A `w × d` rectangle centred on the origin, for bevelled extrusions. */
function rectShape(w: number, d: number): THREE.Shape {
  const hw = Math.max(0.1, w) / 2;
  const hd = Math.max(0.1, d) / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.closePath();
  return shape;
}

/**
 * Unit stud (radius 1, base at y = 0, height 1) — scaled per instance. ONE per
 * segment count, shared by every prop (bike saddle, plane crown, sign frame),
 * the brick clouds and the baseplate.
 *
 * demo 的 `makeStudGeo` 原封搬過來(`plan/plastic-town-demo.html`),連同它的理由:
 *
 * > 凸點是這個世界唯一的身分,所以一顆都不能少。但它同時也是最貴的東西:三千多顆
 * > × three 的 CylinderGeometry(…,12) 48 面 = 十六萬個三角形,佔全場超過六成。
 * > **幾何本身砍到骨頭**:底蓋永遠貼在一個面上,一個 pixel 都看不到 → 不做。頂蓋
 * > 用扇形三角化(n-2 片)而不是繞中心的傘骨(n 片)。n 邊 = 3n-2 片,three 的 n
 * > 邊圓柱是 4n 片 —— 同邊數就先省掉四分之一。
 *
 * 這裡換掉的正是那顆 `CylinderGeometry(1, 1, 1, segments)`:demo 自己就寫了
 * 「這是要搬進 gameview 的那一招,不是 demo 的權宜」,而同一種零件只能有一份做法
 * ——底板的凸點與道具上的凸點是同一顆塑膠。
 *
 * `segments` 的預設留著(demo 的 `makeStudGeo` 沒有預設):騎士走得到的道具吃 12
 * 段的圓凸點,底板依 chunk 距離自己指定 8 / 6 / 4(見 `STUD_LOD`)。
 */
function makeStudGeo(segments = 12): THREE.BufferGeometry {
  const n = segments;
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    pos.push(cx, 0, cz, cx, 1, cz);          // 側面:下、上(法線朝外,平滑)
    nor.push(cx, 0, cz, cx, 0, cz);
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(Math.cos(a), 1, Math.sin(a));    // 頂蓋:自己一份,法線朝上
    nor.push(0, 1, 0);
  }
  // ⚠ 繞法(winding)一錯就整顆翻面:法線朝內 → 亮面變暗殼,而且 three 預設
  // FrontSide 會把正面剔掉,瀏覽器裡等於看穿過去。角度沿 +x→+z 遞增,從上往下
  // 看是順時針,所以側面的兩片跟頂蓋的扇形都要用「下、上、下一格」這個順序。
  for (let i = 0; i < n; i++) {
    const k = i * 2, k2 = ((i + 1) % n) * 2;
    idx.push(k, k + 1, k2, k + 1, k2 + 1, k2);
  }
  for (let i = 1; i < n - 1; i++) idx.push(2 * n, 2 * n + i + 1, 2 * n + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Side counts for the three stud LOD levels — the demo's `STUD_LOD`, and the
 * whole point of it: all three are the SAME unit stud (radius 1, height 1, base
 * at y = 0), so swapping level costs one `mesh.geometry =` and not a single byte
 * of instance matrix. See `applyStudLod` in `ground-studs.ts`.
 */
const STUD_LOD = [8, 6, 4] as const;

/**
 * An `nx × nz` grid of studs capping a `w × d` brick top at height `topY`,
 * centred on the local origin. One InstancedMesh per call — cheap, and it keeps
 * the "it's made of bricks" read on every prop.
 */
/**
 * Stud materials memoized by color (module-level, like GRADIENT_MAP). A fresh
 * material per stud grid gave every tall building a unique material identity,
 * which defeated decoration merging — a downtown chunk retained thousands of
 * materials and one draw call per building. Shared instances let decorations
 * with the same palette color collapse into a single merged mesh.
 */
const STUD_MATERIALS = new Map<number, THREE.MeshToonMaterial>();

function studMaterial(color: number): THREE.MeshToonMaterial {
  let mat = STUD_MATERIALS.get(color);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color, gradientMap: GRADIENT_MAP });
    mat.userData.shared = true;
    STUD_MATERIALS.set(color, mat);
  }
  return mat;
}

function studGrid(
  w: number,
  d: number,
  topY: number,
  color: number,
  nx = Math.max(2, Math.round(w / 3)),
  nz = Math.max(2, Math.round(d / 3)),
  segments = 12,
  // Overrides for callers whose studs must NOT share the memoized material
  // (the clouds: immersion fades their materials, and fading studMaterial()
  // would fade every same-coloured stud in the world), or whose geometry/
  // height the demo pins (cloud studs are the demo's fixed 0.55, not the
  // radius-capped default), or whose radius AND height the demo states outright
  // (the bike saddle's single stud is the demo's 0.4 / 0.3, not a grid pitch).
  opts?: {
    geometry?: THREE.BufferGeometry; material?: THREE.Material;
    height?: number; radius?: number;
  },
): THREE.InstancedMesh {
  const radius = opts?.radius ?? Math.min(w / nx, d / nz) * 0.32;
  const height = opts?.height ?? Math.min(radius, 0.6);
  const mesh = new THREE.InstancedMesh(
    opts?.geometry ?? makeStudGeo(segments),
    opts?.material ?? studMaterial(color),
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
    // The three parts the demo's bike declares, and only those three:
    // `tire.castShadow` / `frame.castShadow` / `saddle.castShadow`, each with
    // receiveShadow left off. They are the silhouette; the hub, the spokes, the
    // bars, the grips and the crank all sit inside it, and the bike is never
    // more than a couple of metres off the ground with the rider on top of it.
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(R, 0.42, 12, 36), tyreMat);
    tyre.castShadow = true;
    wheel.add(tyre);
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
  const frame = new THREE.Mesh(new THREE.TubeGeometry(framePath, 48, 0.26, 10), frameMat);
  frame.castShadow = true;
  lean.add(frame);
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
  saddle.castShadow = true;
  lean.add(saddle);
  // demo: `studInstances([[-1.05, 6.4, 0]], 0.4, 0.3, '#3a2a70')` —— 半徑 0.4、
  // 高 0.3。`studGrid` 的預設是「格寬推半徑、半徑當高」,套在 2.1×1.2 的座墊上
  // 會算出 0.384/0.384:高多了 28%,凸點就不是坐在座墊上的一顆,而是一根柱子。
  const saddleStud = studGrid(2.1, 1.2, 6.4, 0x3a2a70, 1, 1, STUD_LOD[0], {
    radius: 0.4, height: 0.3,
  });
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
/**
 * Street lamp: BLOWN BUBBLE PLASTIC — the tube of goo you squeeze onto a straw
 * and inflate into a thin, shiny balloon that holds its shape.
 *
 * It beats the old glowing brick for one reason: it is ALREADY a membrane
 * around air, which is what a lampshade is.
 *
 * Two things carry the read, and neither is the bubble's colour:
 *  1. The ROLLED TAIL. The tube is the toothpaste kind, rolled up from the
 *     bottom as it is used. That rolled cylinder is the lamp's foot and the
 *     most recognisable part of its silhouette; the flattened section above it
 *     is WIDER than the round barrel (flattened = half the circumference), and
 *     that step from flat to round is the whole trick. A smooth taper reads as
 *     a vase.
 *  2. A MEMBRANE, not a ball. DoubleSide + low opacity, so the far wall of the
 *     bubble shows through. A solid sphere can only glow all over, and glowing
 *     all over is a colour blob (CUSTOM_WORLD_INSTRUCTIONS §3.10).
 *
 * What lights up at night is the blob of un-inflated goo at the neck — small,
 * inside, wrapped in a shell that stays translucent.
 *
 * ⚠ FULL SIZE, no scale factor. The port used to multiply the whole lamp by
 * 0.81「to sit in the same streetscape as the brick lamp it replaced」—— 那盞磚
 * 頭燈早就不存在了,而 demo 的世界(這個世界的其他每一件道具都是照抄它的)沒有
 * 那個係數。0.81 還只縮了形體:`PointLight` 的 distance 26 沒跟著縮,所以那顆
 * 燈照得比自己的桿子高。三個世界只有這一盞被縮過,而 demo 裡塑膠燈本來是三盞
 * 裡最高的一盞——縮完就變成最矮的。
 */
const BUBBLE_COLS = [CANDY.pink, CANDY.cyan, CANDY.yellow, CANDY.green] as const;

/**
 * Everything about a bubble lamp that every bubble lamp has in common.
 *
 * ## What this is worth, measured
 *
 * `StreetLampManager` builds `TUNNEL_POOL_SIZE` = 20 lamps up front and shows 10
 * on an ordinary road (20 in a tunnel); the landuse renderer stands one more on
 * every pitch and playground within 65 m of the route. Every one of them used to
 * mint its own copy of three identical geometries and three materials. The pool
 * ALONE, censused with `scene-census.mjs`:
 *
 * ```
 *                  draw calls   unique geo   unique mat
 *   plastic  road       30           30          30      ← 43% of §6's whole
 *   plastic  tunnel     60           60          60         budget of 70, and
 *   paper    road       40           40          40         not one pixel of it
 *   paper    tunnel     80           80          80         is a different shape
 *   circuit  road      100          100          22      ← already shared its
 *   circuit  tunnel    200          200          42         pin/cup materials
 * ```
 *
 * The geometry is the same solid for every lamp in the world — the colour lives
 * entirely in the materials — so it is cached once here, tagged
 * `userData.shared` so `disposeGroup` leaves it alone (that flag is why
 * `bike-ornament.ts` had to learn about shared geometry).
 *
 * ## Why the tube's material is shared and the other two are NOT
 *
 * `setNight` WRITES to `bubbleMat` (emissive + opacity) and `blobMat` (colour).
 * A written-to material can only be shared by lamps that are always told the
 * same night — and this world's lamps are not:
 *
 *   street-lamp.ts, `update()`:  pool lamps take `litFactor = inTunnel ? 1 : n`
 *                                fixed lamps take the RAW `nightFactor`
 *
 * so a pitch beside a tunnel mouth and a lamp inside the bore disagree by
 * design (「a tunnel does not light a pitch outside it」). Sharing across that
 * line means the last writer wins and the tunnel goes dark at noon. `tubeMat`
 * is never written to, so it is shared per colour — 4 for the whole world
 * instead of one per lamp.
 *
 * Cross-WORLD sharing would still be wrong (`plan/world-modularity-refactor.md`:
 * 共用機制不共用造型); this cache is module-local to the toy world.
 */
interface BubbleLampGeometry {
  tube: THREE.BufferGeometry;
  bubble: THREE.BufferGeometry;
  blob: THREE.BufferGeometry;
}
let bubbleLampGeo: BubbleLampGeometry | null = null;
const bubbleTubeMats = new Map<number, THREE.MeshPhongMaterial>();

function bubbleLampGeometry(): BubbleLampGeometry {
  if (bubbleLampGeo) return bubbleLampGeo;

  // Tube: rolled tail + two flattened steps + barrel + shoulder + threads +
  // neck, merged into one draw call (every lamp is the same shape).
  //
  // Part ORDER is the demo's `bubbleTubeGeo`: threads first, then the neck. The
  // port had those two swapped. It draws the same solid — but only while the
  // order matches can `[street lamp vs demo]` diff the merged buffer TRIANGLE BY
  // TRIANGLE, and an in-order diff is the only kind that sees a reversed
  // winding. Trade the order away and the check has to fall back to comparing
  // sets, which cannot.
  const roll = new THREE.CylinderGeometry(0.48, 0.48, 2.95, 8);
  roll.rotateZ(Math.PI / 2);
  roll.translate(0, 0.48, 0);
  const tubeParts: THREE.BufferGeometry[] = [
    roll,
    new THREE.BoxGeometry(2.45, 0.9, 0.42).translate(0, 1.42, 0),
    new THREE.BoxGeometry(2.05, 0.8, 0.62).translate(0, 2.15, 0),
    new THREE.CylinderGeometry(0.85, 0.85, 5.5, 12).translate(0, 5.15, 0),
    new THREE.CylinderGeometry(0.44, 0.85, 0.9, 12).translate(0, 8.35, 0),
  ];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.TorusGeometry(0.44, 0.075, 5, 10);
    t.rotateX(Math.PI / 2);
    t.translate(0, 8.95 + i * 0.26, 0);
    tubeParts.push(t);
  }
  tubeParts.push(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 10).translate(0, 9.35, 0));
  const tube = mergeGeometries(tubeParts, false);
  for (const g of tubeParts) g.dispose();

  // The bubble: sphere + the open-ended pinch it was blown through. Open-ended
  // on purpose — a capped cone leaves a solid disc floating inside the film.
  const sphere = new THREE.SphereGeometry(1.95, 18, 14);
  sphere.scale(1, 1.06, 1);
  sphere.translate(0, 12.1, 0);
  const neck = new THREE.CylinderGeometry(1.15, 0.46, 1.1, 12, 1, true);
  neck.translate(0, 10.25, 0);
  const bubble = mergeGeometries([sphere, neck], false);
  sphere.dispose();
  neck.dispose();

  const blob = new THREE.SphereGeometry(0.54, 10, 8);
  blob.scale(1, 0.78, 1);
  blob.translate(0, 10.6, 0);

  for (const g of [tube, bubble, blob]) g.userData.shared = true;
  bubbleLampGeo = { tube, bubble, blob };
  return bubbleLampGeo;
}

function bubbleTubeMaterial(slot: number, col: THREE.Color): THREE.MeshPhongMaterial {
  let mat = bubbleTubeMats.get(slot);
  if (!mat) {
    mat = new THREE.MeshPhongMaterial({ color: col, specular: 0xffffff, shininess: 120 });
    mat.userData.shared = true;
    bubbleTubeMats.set(slot, mat);
  }
  return mat;
}

function buildBubbleLamp(index: number): StreetLampParts {
  const group = new THREE.Group();
  const slot = index % BUBBLE_COLS.length;
  const col = new THREE.Color(BUBBLE_COLS[slot]);
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const geo = bubbleLampGeometry();

  const tube = new THREE.Mesh(geo.tube, bubbleTubeMaterial(slot, col));
  tube.castShadow = true;
  tube.receiveShadow = true;
  group.add(tube);

  const bubbleMat = new THREE.MeshPhongMaterial({
    color: col, transparent: true, opacity: 0.28, side: THREE.DoubleSide,
    specular: 0xffffff, shininess: 210, emissive: 0x000000, depthWrite: false,
  });
  // The film casts no shadow: its shadow is a solid black disc, which cancels
  // out the one thing the film is for.
  group.add(new THREE.Mesh(geo.bubble, bubbleMat));
  owned.push(bubbleMat);

  // The un-inflated goo stuck at the pinch — the only thing that glows, and
  // UNLIT (MeshBasic) so it stays that way: setNight writes up to 2.0 into its
  // colour, and on a lit material the night's own ambient would multiply that
  // straight back down — leaving the film brighter than the thing inside it.
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x2a2438 });
  group.add(new THREE.Mesh(geo.blob, blobMat));
  owned.push(blobMat);

  const light = new THREE.PointLight(col, 0, 26, 1.8);
  light.position.y = 10.8;   // on the blob: bright spot and cast light agree
  group.add(light);

  let night = 0;
  let lightEnabled = true;

  return {
    group,
    setNight: (k) => {
      night = k;
      bubbleMat.emissive.setRGB(col.r * k * 0.3, col.g * k * 0.3, col.b * k * 0.3);
      // More transparent at night, not less — an opaque film hides its own lamp.
      bubbleMat.opacity = 0.28 - 0.05 * k;
      // 0.7 white + 1.3 colour: the white term pushes every hue past the point
      // where it reads as a light rather than a bright patch of paint.
      const w = 0.7 * k, c = 1.3 * k, d = 0.16 * (1 - k);
      blobMat.color.setRGB(d + w + col.r * c, d + w + col.g * c, d + w + col.b * c);
      light.intensity = k * 14;
      // A dozen point lights in the scene cost real fragment work even at zero
      // intensity — hiding them by day takes them out of the render list.
      light.visible = lightEnabled && k > 0.02;
    },
    setLightEnabled: (enabled) => {
      lightEnabled = enabled;
      light.visible = enabled && night > 0.02;
    },
    dispose: () => {
      disposeGroup(group);
      for (const o of owned) o.dispose();
    },
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

// ══ 地被的貨架:五格的貼圖 ═══════════════════════════════════════════════
//
// 全部照抄 `plan/plastic-town-demo.html` 的 `LU_STYLE` 段(§0.0 第 1 條):色票、
// 畫布尺寸、亂數種子、rng 抽取順序一個都沒動。demo 那一段自己寫下了為什麼 ——
// 五格分成兩組,每一組**內部**必須分得出來:
//
//   自然的一對   農田 = 規則的行列(人種的)   濕地 = 不規則 + 水
//   玩具的三個   球場 = 平的、只有線 ＜ 遊樂場 = 有小結構 ＞ 沙地 = 只有顆粒
//
// 而騎士眼高 6.3 m 的掠角(§3.4)下,每一格只准挑**一個**活得下來的訊號:
//   農田 → 壟的方向與間距(所以壟很寬:4 m 一個週期)
//   沙地 → 顏色與粗糙度      球場 → 兩個方向的長白線
//   遊樂場 → 剪影(五格裡唯一站得起來的,見 `buildLanduseProps`)
//   濕地 → 深色的積水斑 + 立起來的軟糖條
//
// **五格沒有一格長樹**:這個世界的樹是毛根扭出來的,park / forest 已經在種它了
// (§3.3 一個元件只能有一個身分)。農田的「作物」是印在壟上的苗,不是立體的。
//
// ⚠ **一處刻意沒照抄:`side`。** demo 五格走的都是它 `toon()` / `gloss()` 的預設
//   `FrontSide`,這裡五格全部維持 gameview 既有的 `DoubleSide`。理由不是保守 ——
//   demo 的地被板是**貼著地面鋪**的(它的走廊是平滑的一張帶子),永遠不可能從下面
//   看到;gameview 的板子是**平的、而且 floor 到它碰得到的最低那一階**,
//   `landuse-renderer` 明文寫著它在高的踏面上「就該躲進地形底下」。而 gameview 另外
//   四格地被(water / park / forest / 分區標示)本來就全是 DoubleSide,五格改成
//   FrontSide 會在同一層裡留下一條沒有人記錄的分歧。
//   (量過:`ShapeGeometry` 會把繞序正規化,CW / CCW 兩種環進去出來的面法向都是
//    +y,所以 FrontSide 在幾何上是安全的 —— 這一條是**一致性**的取捨,不是繞序。)

/**
 * 地被的色票。`CANDY`(themes.scss 的 $plastic)是給**零件**用的螢光糖果色,同樣
 * 的濃度鋪滿一塊 30 m 的地會整片跳出來、把旁邊的房子壓掉,所以這一組是 CANDY 的
 * 同族低一到兩階 —— 跟 `PARK_COLOR` / 池底色同一個作法,那兩個也不在 CANDY 裡。
 * demo 的 `LU_C`,逐值照抄。
 */
const LU_C = {
  // 農田的綠**刻意往黃的那一邊偏**:底板綠是 #39e75f、公園是 #66ff70,同一個
  // 色相再放一塊田,遠看就是三塊一樣的綠地。作物本來也比草皮黃。
  farmRidge: '#84e04a',   // 壟面:種了的那一條,糖果萊姆綠
  farmFurrow: '#33903c',  // 壟溝:沒種的那一條,深兩階
  farmSprout: '#1d6f2c',  // 苗的三叉
  farmBud: '#c8f57a',     // 苗心
  jelly: '#3fd2b0',       // 軟糖片的底色
  jellyHi: '#8ff0d8',     // 軟糖裡透光的亮斑
  water: '#1a7f9c',       // 積水
  reed: '#5fe0a8',        // 軟糖條(立起來的那幾根,跟片是同一種材料)
  court: '#1f8fd1',       // 球場薄板磚
  line: '#f4f8ff',        // 白線用的 1×N 白色薄板磚
  mat: '#ff7a45',         // 遊樂場的橡膠軟墊
  sand: '#f0dcae',        // 沙地底板
  sandDark: '#d9bd83',    // 散開的 1×1 凸點:背光的那一半
  sandStud: '#e8d09a',    // 同上,受光的那一半
  sandTop: '#fbeecb',     // 凸點頂面
} as const;

/** demo 的 `const TS = 256;`。前綴是這個檔的慣例(demo 的 `C` 在這裡叫 `CANDY`)。 */
const LU_TS = 256;

/** 畫在九宮格上,四邊都不會被切掉(只畫真的會壓到畫布的那幾格)。
 *  ⚠ **`rng()` 必須在呼叫這支之前抽完**,抽在 `draw` 裡拿到的會是九個不一樣的
 *    點,而不是同一個點的九份複製(§7.1)。 */
function wrap9(
  g: CanvasRenderingContext2D, draw: () => void, x: number, y: number, r: number,
): void {
  for (let dx = -1; dx <= 1; dx++) {
    if (dx < 0 && x <= LU_TS - r) continue;
    if (dx > 0 && x >= r) continue;
    for (let dy = -1; dy <= 1; dy++) {
      if (dy < 0 && y <= LU_TS - r) continue;
      if (dy > 0 && y >= r) continue;
      g.save(); g.translate(dx * LU_TS, dy * LU_TS); draw(); g.restore();
    }
  }
}

/**
 * 一張會 repeat 的地被貼圖。
 *
 * **uv 是世界公尺** —— 地被的 `ShapeGeometry` 直接把 (x, z) 寫進 uv,所以
 * `repeat = 1 / 這張圖代表幾公尺`,也就是「每公尺幾張」。跨 chunk 因此天生連續:
 * 同一塊田被切成兩個 chunk 也不會在邊界上錯半條壟。
 */
function luTex(
  metres: number,
  draw: (g: CanvasRenderingContext2D, px: number, ppm: number) => void,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = LU_TS;
  const g = c.getContext('2d')!;
  draw(g, LU_TS, LU_TS / metres);      // ppm = 每公尺幾個 pixel
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / metres, 1 / metres);
  return t;
}

// ── 農田:壟 + 苗,全部印在板子上 ──────────────────────────────────────
//
// 提案是「凸點被種了」—— 底板本來就有凸點格,每顆凸點上種一株。**印出來的那顆
// 凸點被拿掉了**,兩個理由:
//  ・**沙地的身分就是「散開的 1×1 圓凸點」**。農田再印一格凸點,兩塊地遠看就是
//    同一種顆粒感,只差顏色(§3.3)。
//  ・§3.4 說得很白:一格只准有**一個**活得下來的訊號。農田的那一個是壟的方向與
//    間距,再印一層等距的圓點只會跟它搶。
//
// 壟做得**很寬**(4 m 一個週期 = 2 m 壟面 + 2 m 溝)。掠角下窄壟在十幾公尺外就糊
// 成一片平均色,寬壟才留得住方向。週期 64 px 整除 256 → 左右邊界必然對得上(§7.1)。
//
// ⚠ 壟的方向是**世界軸向的**,不是每塊田自己的朝向:uv 是世界公尺,而材質是
//   chunk 之間共用的單例,沒有地方可以塞「這塊田轉了幾度」。在這個世界這剛好是
//   對的 —— 底板的凸點格也是全世界同一個方向。
function luFarmCanvas(g: CanvasRenderingContext2D, px: number, ppm: number): void {
  // 底色鋪**壟面**(不是溝):probe 的貼圖替身色取面積最大的那次 `fillRect`
  // (§10.6),鋪壟面的話 3D 圖上的農田才是它真正的主色。
  g.fillStyle = LU_C.farmRidge;
  g.fillRect(0, 0, px, px);
  const period = 4 * ppm;                 // 一壟 + 一溝
  const ridge = 2 * ppm;                  // 壟面
  const rows = px / period;               // 4,整數
  g.fillStyle = LU_C.farmFurrow;
  for (let k = 0; k < rows; k++) g.fillRect(k * period + ridge, 0, period - ridge, px);
  // 苗:壟心一列,2 m 一株。從天上看是一朵三叉的小苗,不是一根草。
  const step = 2 * ppm;
  g.lineCap = 'round';
  g.lineWidth = 0.16 * ppm;
  for (let k = 0; k < rows; k++) {
    const cx = k * period + ridge / 2;
    for (let j = 0; j < px / step; j++) {
      const cy = (j + 0.5) * step;
      g.strokeStyle = LU_C.farmSprout;
      for (let a = 0; a < 3; a++) {
        const th = (a / 3) * Math.PI * 2 + 0.5;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(th) * 0.5 * ppm, cy + Math.sin(th) * 0.5 * ppm);
        g.stroke();
      }
      g.fillStyle = LU_C.farmBud;
      g.beginPath();
      g.arc(cx, cy, 0.14 * ppm, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// ── 濕地:軟糖片 ──────────────────────────────────────────────────────
//
// 半透明、亮面、不規則的一片軟糖,上面壓著深色的積水斑。**一條直線都沒有**:
// 農田那格是印死的等距行列,這格連兩個斑之間的距離都不重複 —— 兩塊地擺在一起
// 時,「規則 vs 不規則」是唯一需要讀出來的差別。
function luWetCanvas(g: CanvasRenderingContext2D, px: number, ppm: number): void {
  g.fillStyle = LU_C.jelly;
  g.fillRect(0, 0, px, px);
  // 種子寫死:這張圖只建一次、chunk 之間共用,不能吃任何 chunk 的亂數流。
  const rng = mulberry32(0x7e71a4d);
  for (let i = 0; i < 11; i++) {
    const x = rng() * px, y = rng() * px;
    const rad = (1.1 + rng() * 2.3) * ppm;
    const n = 9;
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const rr = rad * (0.58 + rng() * 0.6);
      pts.push([Math.cos(th) * rr, Math.sin(th) * rr]);
    }
    // 三分之一畫成軟糖裡透光的亮斑,其餘是積水。⚠ rng() 全部抽完才進 wrap9。
    const col = i % 3 === 0 ? LU_C.jellyHi : LU_C.water;
    wrap9(g, () => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x + pts[0][0], y + pts[0][1]);
      for (let k = 1; k < n; k++) g.lineTo(x + pts[k][0], y + pts[k][1]);
      g.closePath();
      g.fill();
    }, x, y, rad * 1.2);
  }
}

// ── 球場:單色薄板磚 + 1×N 白色薄板磚拼出來的線 ────────────────────────
/**
 * 一條白線畫成一節一節的薄板磚。**這個世界沒有「畫」出來的線** —— 線是一排白色
 * 薄板拼出來的,所以節與節之間看得到縫。節數用「切幾段」而不是「每次走幾公尺」,
 * 所以永遠整除線長(§7.1)。
 */
function luLineBricks(
  g: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number, w: number, ppm: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const segs = Math.max(1, Math.round(len / (2 * ppm)));    // 一節約 2 m
  const step = len / segs;
  const gap = 0.2 * ppm;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;         // 只走水平/垂直
  for (let k = 0; k < segs; k++) {
    const bx = x0 + ux * k * step, by = y0 + uy * k * step;
    g.fillRect(bx - (uy ? w / 2 : 0), by - (ux ? w / 2 : 0),
      ux ? step - gap : w, uy ? step - gap : w);
  }
}

function luSportCanvas(g: CanvasRenderingContext2D, px: number, ppm: number): void {
  g.fillStyle = LU_C.court;
  g.fillRect(0, 0, px, px);
  // 一張圖 = 一面球場,四周留 2 m 的走道。repeat 出去就是一排一排的球場,那正是
  // 球場用地的樣子(而且四邊都是素色 → 接縫必然對得上)。一張圖代表 25.6 m,
  // 所以一面場 21.6 m 見方 —— 大致是一面籃球場。
  const a = 2 * ppm, b = px - 2 * ppm;
  const w = 0.5 * ppm;
  g.fillStyle = LU_C.line;
  luLineBricks(g, a, a, b, a, w, ppm);
  luLineBricks(g, a, b, b, b, w, ppm);
  luLineBricks(g, a, a, a, b, w, ppm);
  luLineBricks(g, b, a, b, b, w, ppm);
  luLineBricks(g, a, px / 2, b, px / 2, w, ppm);            // 中線
  // **沒有中圈。** 白線是直的薄板磚,這個世界的貨架上沒有彎的白線(§3.8)——
  // 想要一個圓就得發明一種新零件,那比少一個圓貴得多。
}

// ── 沙地:散開的 1×1 圓凸點 ────────────────────────────────────────────
//
// 這個世界最小的原子鬆掉了,散了一地。**一件幾何都沒有** —— 掠角下一顆 0.6 m 的
// 凸點只有一兩個 pixel,幾何跟貼圖畫出來完全一樣,而幾何要付 draw call。剩下的
// 訊號就是顏色與粗糙度,所以顆粒畫兩階明度(受光的一半 + 背光的一半),遠看糊掉
// 之後正好是「粗」的那個感覺。
function luSandCanvas(g: CanvasRenderingContext2D, px: number, ppm: number): void {
  g.fillStyle = LU_C.sand;
  g.fillRect(0, 0, px, px);
  const rng = mulberry32(0x5a4d129);
  for (let i = 0; i < 150; i++) {
    const x = rng() * px, y = rng() * px;
    const r = (0.28 + rng() * 0.22) * ppm;
    const dark = rng() < 0.42;
    const ring = dark ? LU_C.sandDark : LU_C.sandStud;
    const top = dark ? LU_C.sandStud : LU_C.sandTop;
    wrap9(g, () => {                                        // ⚠ rng() 已抽完
      g.fillStyle = ring;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = top;
      g.beginPath(); g.arc(x, y, r * 0.54, 0, Math.PI * 2); g.fill();
    }, x, y, r);
  }
}

// ── 會站起來的東西的常數(demo 的 `LU_REED_MAX` / `LU_PROP_MIN_R` / `LU_UNIT`)──
//
// 上限**寫死、不隨面積長**:台北一個 3×3 圖磚窗口實測有 512 塊 sports、69 塊
// playground,一塊地多一個 draw call 就是多幾百個。所以會站起來的只有兩格:
//   濕地   ≤ LU_REED_MAX(15)根軟糖條 → 1 個 InstancedMesh
//   遊樂場 固定 9 個積木件            → 3 個 InstancedMesh(黃/青/粉)
const LU_REED_MAX = 15;       // 一塊濕地最多幾根軟糖條
const LU_PROP_MIN_R = 6;      // 比這還小的地塊不放東西:結構會比地本身還大

/**
 * 這一格的「1×1」有多大。**不要拿真實世界的尺寸來設計這兩座結構** —— demo 第一版
 * 用了人的尺度(梯階 0.85 m、滑梯高 3.2 m),render 出來像一把牙籤插在地上:這個
 * 世界的底板凸點就有 3 m 寬、抽抽樂塔一層 2.3 m(`LAYER_H`)、建築頂上的凸點格
 * 3 m。1×1 = 2 m 是這幾個數字之間唯一講得通的值,而且梯頂剛好落在騎士眼高
 * (6.3 m)上,剪影才在天際線上有東西可以咬(§3.4)。
 */
const LU_UNIT = 2.0;

/** `#rrggbb` for a canvas fill/stroke — the palette is stored as numbers. */
function cssHex(hex: number): string {
  return `#${new THREE.Color(hex).getHexString()}`;
}

/**
 * The baseplate the diorama stands on: moulded violet with ONE STUD PER CELL,
 * drawn as a texture rather than as geometry.
 *
 * The demo's baseplate has real cylinder studs, and it can: its board is 130 m
 * wide. Ours is a 4 km disc, so one stud per 16 m cell is 250 000 studs — a
 * quarter of a million instances of an eight-sided cylinder to carry a pattern
 * that is a few pixels tall past the first few hundred metres. The pattern is
 * the identity here, not the geometry (the 2D world made the same call and
 * dropped the road rather than the studs), so it goes in a tile: one sampler
 * read on a surface that was being rasterised anyway, and no new draw call.
 *
 * Each stud is a shadow, a cap and a highlight — the three marks that make a
 * flat circle read as a raised cylinder under a light from the upper left, which
 * is where this world's sun sits at the hours you actually ride.
 *
 * SEAMS: studs sit at cell CENTRES, so no stud ever crosses the tile edge and
 * the 8×8 grid tiles cleanly. Moving them to cell corners would put a quarter
 * disc on each side of every seam and needs all four to line up exactly.
 */
function createBaseplateTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = cssHex(BASEPLATE_COLOR);
  ctx.fillRect(0, 0, size, size);

  const cell = size / BASEPLATE_STUDS_PER_TILE;
  // 0.31 of the pitch is the real stud-diameter-to-pitch ratio (5 mm on 8 mm)
  // halved — get this wrong and the plate reads as bubble wrap or as a waffle.
  const r = cell * 0.31;
  for (let gy = 0; gy < BASEPLATE_STUDS_PER_TILE; gy++) {
    for (let gx = 0; gx < BASEPLATE_STUDS_PER_TILE; gx++) {
      const cx = (gx + 0.5) * cell;
      const cy = (gy + 0.5) * cell;
      // Contact shadow, offset away from the light.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = cssHex(BASEPLATE_STUD_SHADE);
      ctx.beginPath();
      ctx.arc(cx + r * 0.22, cy + r * 0.26, r * 1.06, 0, Math.PI * 2);
      ctx.fill();
      // Cap.
      ctx.globalAlpha = 1;
      ctx.fillStyle = cssHex(BASEPLATE_STUD_TOP);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // Gloss — small, pushed to the upper-left RIM. Bigger or more centred and
      // each stud reads as a bullseye (a pupil in an eye) instead of as a
      // cylinder catching the light; that was the first version.
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx - r * 0.4, cy - r * 0.42, r * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // The disc's UVs are scene metres (see mountain-ring.setMetreUVs).
  tex.repeat.set(1 / BASEPLATE_TILE_METERS, 1 / BASEPLATE_TILE_METERS);
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

// ── Finish airship (toy UFO) ──

/** Rim-light colours: the one lit bulb is bright, the rest a dim amber. */
const RIM_LIGHT_ON = 0xfff27a;
const RIM_LIGHT_OFF = 0x6e5410;
/** Number of rim lights round the saucer edge (chase-blink). */
const UFO_RIM_COUNT = 10;

/**
 * Draw the LED dot-matrix banner text into `ctx`. Dark navy board, bright cyan
 * glow text, a thin grid punched over it so it reads as an LED matrix panel.
 * Auto-shrinks the font so long strings fit the 512-wide board.
 */
function drawLedBanner(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  ctx.clearRect(0, 0, w, h);
  // Board background — near-black navy.
  ctx.fillStyle = '#0a0b1e';
  ctx.fillRect(0, 0, w, h);

  if (text) {
    // Fit the font to the board width (CJK glyphs come from the system sans).
    let font = 60;
    ctx.font = `bold ${font}px sans-serif`;
    while (ctx.measureText(text).width > w - 28 && font > 22) {
      font -= 2;
      ctx.font = `bold ${font}px sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#00d8ff';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#66e8ff';
    ctx.fillText(text, w / 2, h / 2 + 2);
    // Hot core pass — brighter centre so the glow reads as lit LEDs, not blur.
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#eaffff';
    ctx.fillText(text, w / 2, h / 2 + 2);
    ctx.shadowBlur = 0;
  }

  // Dot-matrix grid: punch dark gaps between the LED cells.
  ctx.fillStyle = 'rgba(10,11,30,0.85)';
  const cell = 8;
  for (let x = 0; x < w; x += cell) ctx.fillRect(x, 0, 2, h);
  for (let y = 0; y < h; y += cell) ctx.fillRect(0, y, w, 2);
}

/**
 * Toy UFO — a smooth candy lentil disc (~16 m across, lathe profile) with a
 * glossy bumper ring, a stud crown, a translucent dome with a little brick pilot
 * inside, a blinking antenna beacon, a two-headed chase of rim lights, a pulsing
 * tractor-beam glow, and an LED dot-matrix banner in an ink bezel hung below on
 * thin rods. Every material sets `fog: false` so it stays visible through
 * weather fog (see FinishAirshipParts contract).
 */
function buildToyUfo(): FinishAirshipParts {
  const root = new THREE.Group();
  const toon = (color: number) =>
    new THREE.MeshToonMaterial({ color, gradientMap: GRADIENT_MAP, fog: false });

  // Body — disc + dome + lights (banner hangs separately and stays put).
  const body = new THREE.Group();
  root.add(body);

  const DISC_R = 8; // ~16 m diameter

  // Candy lentil disc — lathe profile from bottom centre out to the rim and up
  // to the dome base (the top hole hides under the dome).
  const profile = [
    new THREE.Vector2(0.0, -1.55),
    new THREE.Vector2(2.8, -1.45),
    new THREE.Vector2(5.4, -0.95),
    new THREE.Vector2(7.6, -0.2),
    new THREE.Vector2(DISC_R, 0.25),
    new THREE.Vector2(6.6, 0.95),
    new THREE.Vector2(4.0, 1.5),
    new THREE.Vector2(2.2, 1.7),
  ];
  const disc = new THREE.Mesh(new THREE.LatheGeometry(profile, 36), toon(CANDY.pink));
  body.add(disc);

  // Glossy bumper ring round the equator.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(DISC_R, 0.55, 12, 40),
    new THREE.MeshPhongMaterial({ color: CANDY.yellow, specular: 0xffffff, shininess: 90, fog: false }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.1;
  body.add(rim);

  // Stud crown round the dome — the "it's a toy brick" signature.
  const studMat = toon(brighten(CANDY.pink, 0.25));
  const studGeo = makeStudGeo();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stud = new THREE.Mesh(studGeo, studMat);
    stud.scale.set(0.55, 0.4, 0.55);
    stud.position.set(Math.cos(a) * 3.2, 1.52, Math.sin(a) * 3.2);
    body.add(stud);
  }

  // Translucent cockpit dome with a candy pilot inside.
  const domeMat = new THREE.MeshPhongMaterial({
    color: CANDY.cyan,
    transparent: true,
    opacity: 0.4,
    specular: 0xffffff,
    shininess: 130,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    domeMat,
  );
  dome.position.y = 1.6;
  body.add(dome);
  const pilotBody = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 1.1, 12), toon(CANDY.green));
  pilotBody.position.y = 2.2;
  body.add(pilotBody);
  const pilotHead = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), toon(CANDY.mint));
  pilotHead.position.y = 3.1;
  body.add(pilotHead);

  // Antenna with a blinking beacon on top of the dome.
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6), toon(CANDY.ink));
  antenna.position.y = 5.3;
  body.add(antenna);
  const beaconMat = new THREE.MeshBasicMaterial({ color: RIM_LIGHT_ON, fog: false });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), beaconMat);
  beacon.position.y = 6.2;
  body.add(beacon);

  // Ring of rim lights — each its own MeshBasicMaterial so the two-headed chase
  // can light them individually. Shared bulb geometry.
  const ringGroup = new THREE.Group();
  const bulbGeo = new THREE.SphereGeometry(0.55, 10, 8);
  const rimMats: THREE.MeshBasicMaterial[] = [];
  const bulbs: THREE.Mesh[] = [];
  for (let i = 0; i < UFO_RIM_COUNT; i++) {
    const a = (i / UFO_RIM_COUNT) * Math.PI * 2;
    const mat = new THREE.MeshBasicMaterial({ color: RIM_LIGHT_OFF, fog: false });
    rimMats.push(mat);
    const bulb = new THREE.Mesh(bulbGeo, mat);
    bulb.position.set(Math.cos(a) * 7.0, -0.85, Math.sin(a) * 7.0);
    ringGroup.add(bulb);
    bulbs.push(bulb);
  }
  body.add(ringGroup);

  // Pulsing tractor-beam glow under the hull.
  const beamMat = new THREE.MeshBasicMaterial({
    color: CANDY.cyan,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(4.6, 5.2, 24, 1, true), beamMat);
  beam.position.y = -4.2;
  body.add(beam);

  // Hanging LED banner — panel in an ink bezel, on two thin rods.
  const bannerGroup = new THREE.Group();
  const rodMat = toon(CANDY.ink);
  const rodGeo = new THREE.CylinderGeometry(0.12, 0.12, 4.6, 6);
  for (const sx of [-3.5, 3.5]) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(sx, -4.3, 0);
    bannerGroup.add(rod);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  drawLedBanner(ctx, canvas.width, canvas.height, '');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const panelMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    fog: false,
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), panelMat);
  panel.position.set(0, -8.2, 0);
  bannerGroup.add(panel);
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(12.7, 3.7, 0.3), toon(CANDY.ink));
  bezel.position.set(0, -8.2, -0.2);
  bannerGroup.add(bezel);
  root.add(bannerGroup);

  return {
    root,
    setBannerText: (text: string) => {
      drawLedBanner(ctx, canvas.width, canvas.height, text);
      texture.needsUpdate = true;
    },
    setBannerVisible: (visible: boolean) => {
      bannerGroup.visible = visible;
    },
    update: (dt: number, elapsed: number) => {
      const head = Math.floor(elapsed * 6) % UFO_RIM_COUNT;
      const head2 = (head + UFO_RIM_COUNT / 2) % UFO_RIM_COUNT;
      for (let i = 0; i < UFO_RIM_COUNT; i++) {
        const lit = i === head || i === head2;
        rimMats[i].color.setHex(lit ? RIM_LIGHT_ON : RIM_LIGHT_OFF);
        bulbs[i].scale.setScalar(lit ? 1.35 : 1);
      }
      ringGroup.rotation.y -= dt * 0.5;
      beaconMat.color.setHex(Math.floor(elapsed * 3) % 2 === 0 ? RIM_LIGHT_ON : RIM_LIGHT_OFF);
      beamMat.opacity = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin(elapsed * 2.1));
    },
    dispose: () => {
      texture.dispose(); // CanvasTexture — disposeGroup doesn't touch material.map
      disposeGroup(root);
    },
  };
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

  // 積木雲的共用資源(懶建)。單位方塊靠 scale 帶尺寸,所以整層雲共用一顆
  // 方塊、一顆 8 段 stud、兩份材質 —— demo 的 plasticBox 每朵各擠一份
  // BoxGeometry 是因為它要在幾何上掛小孩,這裡凸點改掛在雲的 group 上,
  // 幾何就能共用。材質**不走** brickMat/studMaterial 的快取:入雲淡出會寫
  // 雲材質的 opacity,共用快取會把同色的建築跟著淡掉(合約見 buildCloud)。
  let cloudBoxGeo: THREE.BoxGeometry | null = null;
  let cloudWhiteMat: THREE.MeshToonMaterial | null = null;
  let cloudPaleMat: THREE.MeshToonMaterial | null = null;

  /**
   * The three unit studs of `STUD_LOD`, built once per strategy.
   *
   * demo 的 `const studGeos = STUD_LOD.map(makeStudGeo); const studGeo = studGeos[0];`
   * ——**一份**。底板的凸點靠它換 LOD,而雲的凸點在 demo 裡走的也是 `studGeos[0]`
   * (`addStudsRect` → `studInstances` → `studGeo`),所以這裡不再另外開一顆 8 段的。
   */
  let studLods: THREE.BufferGeometry[] | null = null;
  const studGeos = (): THREE.BufferGeometry[] => {
    if (!studLods) {
      studLods = STUD_LOD.map((n) => {
        const g = makeStudGeo(n);
        g.userData.shared = true;
        return g;
      });
    }
    return studLods;
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

  // ── Sign materials ──────────────────────────────────────────────────────
  // Singletons tagged `userData.shared`, so per-chunk disposers leave them
  // alone; freed in `dispose()`. Lazy: a route with no shops never builds them.
  const signMats = new Map<string, THREE.Material>();
  const signMat = (key: string, make: () => THREE.Material): THREE.Material => {
    let m = signMats.get(key);
    if (!m) {
      m = make();
      m.userData.shared = true;
      signMats.set(key, m);
    }
    return m;
  };

  // ── Trim that lights up at night ────────────────────────────────────────
  // Route A of the two the demo lays out above `WIN_LIT`: the light IS one of
  // the body's own materials, so it costs no geometry and no draw call — one
  // global write drives every chunk (`setNightLitFactor`). Registration is by
  // material identity, and every one of these has to come back out in
  // `dispose()` or a style swap leaves the old world's materials being written
  // every frame.
  const nightLitTrims = new Set<THREE.Material & { emissive: THREE.Color }>();
  const glowTrim = <T extends THREE.Material & { emissive: THREE.Color }>(
    key: string, make: () => T, glowHex: number,
    opts: { hideByDay?: boolean } = {},
  ): T => {
    const cached = trimMaterials.get(key);
    if (cached) return cached as T;
    const mat = make();
    mat.userData.shared = true;
    trimMaterials.set(key, mat);
    registerNightLitMaterial(mat, glowHex, opts);
    nightLitTrims.add(mat);
    return mat;
  };

  /**
   * Route B's material — the light FILM over a slab end (demo `winLightMat`).
   *
   * demo: `new THREE.MeshBasicMaterial({ color: 0x000000, fog: true })` whose
   * colour is written `WIN_LIT × k` every frame, and whose whole batch is
   * switched off by day. gameview's one night write is `emissive`, so this is a
   * Phong with a BLACK colour and BLACK specular instead: every lighting term is
   * identically zero, so what reaches the screen is `emissive` alone — the same
   * unlit `WIN_LIT × k` the demo draws. (The circuit world's nixie halo is the
   * same trick, for the same reason.)
   *
   * `hideByDay` is the demo's `im.visible = nightBlend > 0.02`: at k = 0 this
   * quad is BLACK, not invisible, so it has to be switched off rather than
   * faded — and 「全透明也是要付一次 draw call 跟一次 blend」.
   */
  const WIN_LIT = 0xffe7a6;
  const buildingLightMat = (): THREE.Material => glowTrim(
    'buildingLight',
    () => new THREE.MeshPhongMaterial({
      color: 0x000000, specular: 0x000000, shininess: 0,
    }),
    WIN_LIT,
    { hideByDay: true },
  );

  // The cup tower's walls: the one see-through surface in the world, and its
  // own night light (what glows is the drink inside, not a window cut in it).
  // `depthWrite: false` because a translucent shell that writes depth hides the
  // solid cone it is wrapped around — its own highlight.
  //
  // FrontSide, unlike the demo's cups, which are DoubleSide because they are
  // EMPTY and you can see the inside of their far wall. Ours are filled, so the
  // far wall is behind an opaque cone and never contributes anything — and this
  // is a blended surface on a machine that is fill-rate bound (see PERF_AUDIT /
  // the plan's §5), so halving its overdraw for nothing is worth having.
  const cupWallMat = (hex: number) => glowTrim(
    `cupWall-${hex}`,
    () => new THREE.MeshPhongMaterial({
      color: hex, specular: 0xffffff, shininess: 110,
      transparent: true, opacity: 0.62, depthWrite: false,
    }),
    deepen(hex, 0.5),   // it glows its OWN colour, not a shared warm white
  );

  // Letter blocks: hard gloss, and a rim of light around each stroke at night.
  // The rim's day colour is nearly black so it hides under the letter instead
  // of ringing every block with a grey halo.
  const abcLetterMat = (ink: boolean) => sharedTrim(
    ink ? 'abcInk' : 'abcLite',
    () => gloss(ink ? CANDY.ink : 0xfff7fb, 150),
  );
  const abcRimMat = () => glowTrim(
    'abcRim',
    () => new THREE.MeshPhongMaterial({ color: 0x2b2036, emissive: 0x000000, shininess: 20 }),
    0xffd77e,
  );

  // Domino pips and the scored centre line share one material: the line is the
  // groove that halves the plate, so it lights with the pips as one thing.
  const dominoInkMat = () => glowTrim(
    'dominoInk', () => gloss(CANDY.ink, 90), 0xffe1a0,
  );

  /** Merge one bucket of geometries into a single mesh and drop the sources.
   *  The chunk's decoration merger disposes what it is handed, so everything
   *  here has to be freshly built or a clone — never a cache entry. */
  const meshFrom = (
    parts: THREE.BufferGeometry[], material: THREE.Material, group: THREE.Group,
    cast = false, recv = false,
  ): void => {
    if (!parts.length) return;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const g of parts) g.dispose();
    const mesh = new THREE.Mesh(merged, material);
    // Shadow flags default OFF — three's own default, and the demo's for
    // anything it did not build through `plasticBox`/`scaledBox`/`boxBatcher`.
    // They go into `mergeBuildingDecorations`'s batch key, so a wrong one here
    // is both a wrong shadow AND an extra draw call.
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    group.add(mesh);
  };

  // ── Instance templates for the trim ──────────────────────────────────────
  //
  // The other way out of `mergeBuildingDecorations` (see `markInstanceTemplate`):
  // a part whose only difference between buildings is its SIZE never becomes
  // geometry at all. One unit-sized geometry lives here for the life of the
  // strategy and the chunk batches the matrices.
  //
  // The rule for what belongs here is "one unit shape covers every use of it".
  // The domino's pips and grooves qualify by the thousand; the cup walls do NOT,
  // and the reason is written where they are built.
  const trimTemplates = new Map<string, THREE.BufferGeometry>();
  const trimTemplate = (
    key: string, material: THREE.Material, make: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry => {
    let geo = trimTemplates.get(key);
    if (!geo) {
      geo = make();
      trimTemplates.set(key, geo);
    }
    // Re-tagged on every hand-out, not only on creation: one unit box is shared
    // by materials with different needs, and `markInstanceTemplate` is where the
    // black-part trap (vertexColors lives on the MATERIAL) is caught.
    return markInstanceTemplate(geo, material);
  };

  /** Scratch for composing one instance transform. Safe as closure state: none
   *  of these builders awaits, so no two can interleave mid-write. */
  const _im = new THREE.Matrix4();
  const _ip = new THREE.Vector3();
  const _iq = new THREE.Quaternion();
  const _ie = new THREE.Euler();
  const _is = new THREE.Vector3();
  /** Write instance `i`: yaw about +y, scaled, at (x, y, z) — the same
   *  T · Ry · S the renderer's own body batches compose.
   *
   *  Scale is floored at 0.1 mm: three's instanced-normal path divides by the
   *  squared length of each matrix column, so a zero extent (an MVT footprint
   *  whose `render_height` is literally 0 does reach here) is 0/0 = NaN, and a
   *  NaN normal is a black part in WebGL only, where no probe rasterises it. */
  const setTrimInstance = (
    mesh: THREE.InstancedMesh, i: number,
    x: number, y: number, z: number, rotY: number,
    sx: number, sy: number, sz: number,
  ): void => {
    _ie.set(0, rotY, 0);
    _is.set(Math.max(sx, 1e-4), Math.max(sy, 1e-4), Math.max(sz, 1e-4));
    mesh.setMatrixAt(i, _im.compose(_ip.set(x, y, z), _iq.setFromEuler(_ie), _is));
  };

  /** Local box frame → scene, the same transform the body gets. */
  const placeTrim = (group: THREE.Group, box: BuildingBox): THREE.Group => {
    group.position.set(box.cx, box.baseY, box.cz);
    group.rotation.y = box.rotY;
    return group;
  };

  /**
   * The cup tower's see-through walls: ONE unit cup, instanced, per storey
   * colour.
   *
   * ⚠ This used to build a fresh `CylinderGeometry` per cup and merge them,
   * with a comment explaining that batching was impossible because the ground
   * storey's wall is CUT OFF at y = 0 and so has a taper of its own. That was
   * true and it was also the single most expensive thing in this world. With the
   * demo's grid restored (fixed 3.5 m pitch, count from the footprint) the saved
   * Taipei route asks for 64 801 cups, and building two geometries each —
   * a 14-facet open frustum and a 16-segment torus rim — MEASURED 2 645 ms and
   * 9.77 M vertices over 1 000 bodies, against 27 ms for every body part of
   * every building in the same run. It was 99 % of the cost of the port.
   *
   * The demo does not do this. The demo builds `cupGeo` ONCE and hands it to an
   * `InstancedMesh` per storey — so instancing it here is not an optimisation
   * bolted onto the port, it is the part of the port that had been dropped.
   *
   * Six storey colours = six batches, and the colour has to stay a MATERIAL
   * rather than an instance colour because each one glows its own colour at
   * night through `registerNightLitMaterial`.
   */
  const buildCupWalls = (box: BuildingBox, seed: number): THREE.Object3D => {
    const lay = cupTowerLayout(box, seed);
    const group = new THREE.Group();
    const byColor = new Map<number, CupTowerLayout['cups']>();
    for (const c of lay.cups) {
      if (c.h < 0.2) continue;
      let arr = byColor.get(c.color);
      if (!arr) { arr = []; byColor.set(c.color, arr); }
      arr.push(c);
    }
    for (const [color, cups] of byColor) {
      const mat = cupWallMat(color);
      // demo `cupTower`: `im.castShadow = true` on the per-storey InstancedMesh
      // and NOTHING about receiveShadow — a translucent open shell has no lit
      // inside for a shadow to land on. (The white plate between storeys is the
      // other way round, `plate.receiveShadow = true`; it rides in the BODY, so
      // the body mesh's flags in `building-renderer` cover it.)
      trimBatch(group, 'cupWall', mat, buildCupWallTemplate, cups.length, (mesh) => {
        cups.forEach((c, i) => setTrimInstance(
          mesh, i, c.x, c.y, c.z, 0, 2 * c.rTop, c.h, 2 * c.rTop));
      }, true, false);
    }
    return placeTrim(group, box);
  };

  // The letter blocks' embossed letters, plus the rim that lights them.
  const buildLetterRelief = (box: BuildingBox, seed: number): THREE.Object3D => {
    const lay = alphabetBlocksLayout(box, seed);
    const group = new THREE.Group();
    const ink: THREE.BufferGeometry[] = [];
    const lite: THREE.BufferGeometry[] = [];
    const rims: THREE.BufferGeometry[] = [];
    for (const L of lay.letters) {
      // No `if (!src) continue` here any more: `letterGeo` always returns
      // something — the demo's crossed box for anything it cannot draw — so a
      // character the table lacks now shows up on the wall AND in the console
      // instead of leaving a blank face nobody can trace.
      const src = letterGeo(L.ch);
      (L.ink ? ink : lite).push(src.clone().applyMatrix4(L.matrix));
      rims.push(src.clone().applyMatrix4(L.rim));
    }
    // demo `alphabetBlocks`: the embossed letters are `im.castShadow = true`
    // with receiveShadow untouched (the relief is 0.36 m proud of a face that
    // already receives), and the RIM behind them is the demo's one explicit
    // `rim.castShadow = false` in this world — it is pressed INTO the face and
    // only its edge shows, so a shadow off it would be a black halo round every
    // letter. That false is a decision, not an omission.
    meshFrom(ink, abcLetterMat(true), group, true, false);
    meshFrom(lite, abcLetterMat(false), group, true, false);
    meshFrom(rims, abcRimMat(), group, false, false);
    return placeTrim(group, box);
  };

  /** Build one batched trim part: `n` instances of a unit template, filled by
   *  `fill`, or nothing at all when this building has none of them. */
  const trimBatch = (
    group: THREE.Group, key: string, material: THREE.Material,
    make: () => THREE.BufferGeometry, n: number,
    fill: (mesh: THREE.InstancedMesh) => void,
    cast = false, recv = false,
  ): void => {
    if (n <= 0) return;
    const mesh = new THREE.InstancedMesh(trimTemplate(key, material, make), material, n);
    // Set BEFORE `fill` so a builder that wants to say something else about
    // this batch still can — and read by `mergeBuildingDecorations`'s batch
    // key, which is why the two flags are per-batch rather than per-instance.
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    fill(mesh);
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };

  // The domino wall's pips, centre grooves, and the rooftop marker board.
  //
  // Every part of it is one unit shape at a different size, which is what makes
  // it the worst offender in this style and the best candidate for batching: a
  // hospital wall carries up to ~200 pips, and the 60 domino walls of one dense
  // Taipei chunk were ~30 ms of building and merging little discs.
  const buildDominoFaces = (box: BuildingBox, seed: number): THREE.Object3D => {
    const lay = dominoWallLayout(box, seed);
    const group = new THREE.Group();
    const ink = dominoInkMat();

    // The demo's pip: `CylinderGeometry(0.3, 0.3, 0.2, 10)` with its axis
    // rotated onto the face normal, so it stands PROUD of the plate. The unit
    // template is that cylinder normalised to a diameter of 1 — a placement
    // then scales it by the pip radius and its own depth ratio. This was a flat
    // six-sided disc; see `DOM_PIP_SEGMENTS` for why the reduction went back.
    trimBatch(group, 'dominoPip', ink, () => {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, DOM_PIP_SEGMENTS);
      g.rotateX(Math.PI / 2);   // axis onto +z, which `setTrimInstance` faces out
      return g;
    }, lay.pips.length, (mesh) => {
      lay.pips.forEach((p, i) => setTrimInstance(
        mesh, i, p.x, p.y, p.z, p.rotY, p.r * 2, p.r * 2, p.r * 2 * DOM_PIP_DEPTH));
    // demo `dominoWall`: pips and bars both go out through its `inst()` helper,
    // which opens BOTH flags (`im.castShadow = im.receiveShadow = true`).
    }, true, true);
    // …and the demo's scored centre line: a solid bar `scale(0.14, 0.16, …)`,
    // not a plane painted on the surface.
    trimBatch(group, 'dominoBar', ink, () => new THREE.BoxGeometry(1, 1, 1),
      lay.bars.length, (mesh) => {
        lay.bars.forEach((b, i) => setTrimInstance(
          mesh, i, b.x, b.y, b.z, b.rotY, b.w, b.t, b.t * (0.14 / 0.16)));
      }, true, true);

    // Rooftop marker: a solid board, both faces marked, so it reads coming from
    // either end of the street. Solid and 0.6 m thick — not cut out.
    const boardT = Math.min(0.6, (lay.alongX ? box.depth : box.width) * 0.2);
    const boardW = lay.signH * 1.14;
    trimBatch(group, 'unitBox', sharedTrim('dominoBoard', () => gloss(PORCELAIN_COLOR, 150)),
      () => new THREE.BoxGeometry(1, 1, 1), 1, (mesh) => {
        setTrimInstance(mesh, 0, 0, lay.signY, 0, 0,
          lay.alongX ? boardW : boardT, lay.signH, lay.alongX ? boardT : boardW);
      // demo: `board.castShadow = board.receiveShadow = true` — it is the one
      // solid slab up there and it takes the marks on both faces.
      }, true, true);

    // A TRIANGLE, never a cross: a red cross on white is protected by the
    // Geneva Conventions. Pink rather than pillar-box red for the same reason
    // the sticker signs are — and it happens to match the hospital zone's own
    // ground decal, so the mark answers the ground it stands on.
    //
    // The template is the unit prism: `buildSignTriangleGeometry` is linear in
    // its height and its depth, so (h, h, depth) on a (1, 1) one is the same
    // triangle it would have built directly.
    trimBatch(group, 'signTriangle', sharedTrim('dominoMark', () => gloss(CANDY.pink, 120)),
      () => buildSignTriangleGeometry(1, 1), 2, (mesh) => {
        [1, -1].forEach((side, i) => {
          setTrimInstance(mesh, i,
            lay.alongX ? 0 : side * (boardT / 2 + 0.02),
            lay.signY,
            lay.alongX ? side * (boardT / 2 + 0.02) : 0,
            lay.alongX ? (side > 0 ? 0 : Math.PI) : side * Math.PI / 2,
            lay.signH * 0.8, lay.signH * 0.8, 0.12);
        });
      // demo: `v.castShadow = true` and receiveShadow left alone — the mark is
      // a 0.12 m plate lying ON the board, so it has no lit side of its own.
      }, true, false);
    return placeTrim(group, box);
  };

  // ── 地被裡會站起來的東西(demo 的 `luBricks` / `luWetProps` / `luPlayProps`)──
  //
  // 所有權(§6,而且錯了很難查):`disposeLanduseMeshes` 會走過這裡回傳的整棵樹,
  // **把每一份沒有標 `userData.shared` 的幾何與材質 dispose 掉**。第一個被回收的
  // chunk 就會把別的 chunk 還在畫的東西放掉。所以這兩座結構一律用:
  //   幾何 → 下面這顆共用的單位立方(標了 shared,strategy 在 `dispose()` 收)
  //   材質 → `brickMat()` / `sharedTrim()` 拿出來的共用單例(它們本來就標了)
  // 剩下的只有每塊地自己的 `InstancedMesh`(instanceMatrix),那個本來就該被收。
  let luBoxGeo: THREE.BoxGeometry | null = null;
  const luUnitBox = (): THREE.BoxGeometry => {
    if (!luBoxGeo) {
      luBoxGeo = new THREE.BoxGeometry(1, 1, 1);
      luBoxGeo.userData.shared = true;
    }
    return luBoxGeo;
  };
  /** 軟糖條。demo:`glossShared(LU_C.reed, { shininess: 150 })` —— 跟腳下那一片
   *  是同一種材料(軟糖),只是立起來的那幾根。 */
  const luReedMat = () => sharedTrim('lu-reed', () => new THREE.MeshPhongMaterial({
    color: LU_C.reed, specular: 0xffffff, shininess: 150,
  }));

  /**
   * 幾個一樣的積木件收成一個 InstancedMesh。cells = [x, y, z, ry, rz, sx, sy, sz]。
   * demo 的 `luBricks`,照抄。
   */
  const luBricks = (
    group: THREE.Group, name: string, mat: THREE.Material, cells: number[][],
  ): void => {
    if (!cells.length) return;
    const im = new THREE.InstancedMesh(luUnitBox(), mat, cells.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      p.set(c[0], c[1], c[2]);
      // 'YXZ' = Ry·Rx·Rz,而 x 恆為 0 → 「先繞 y 擺好方位,再往前傾 rz」。
      // 這個世界其他地方只用得到繞 y(`setTrimInstance` 就只收 rotY),滑梯的斜坡
      // 是第一個需要第二軸的東西,所以這裡自己一支,不去動那支的合約。
      e.set(0, c[3], c[4], 'YXZ');
      q.setFromEuler(e);
      s.set(c[5], c[6], c[7]);
      im.setMatrixAt(i, m.compose(p, q, s));
    }
    // 名字純粹是為了 `prop-preview --focus`:這兩座結構在跟隨鏡頭裡只有幾十個
    // pixel,不拉近看根本判不出「認不認得出這是溜滑梯」。
    im.name = name;
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  };

  /**
   * 濕地:軟糖條。**不是草、不是蘆葦、更不是樹** —— 它跟腳下那一片是同一種東西
   * (軟糖),只是立起來的那幾根,所以整格濕地只有一種材料、一個身分。
   *
   * 擺法本身就是這一格的身分:**純 rng 的叢**,叢與叢之間不等距、一叢裡的每一根
   * 也不等距。農田那一格是印死的等距行列(2 m 一株、壟寬 2 m)。
   */
  const luWetProps = (ctx: LandusePropContext): THREE.Object3D | null => {
    const { rng, centerX: cx, centerZ: cz, radius: r } = ctx;
    if (r < LU_PROP_MIN_R) return null;
    const cells: number[][] = [];
    // 散佈半徑**夾在 30 m**(circuit demo 的同一格寫下的那條,合約的 docstring 也
    // 再說了一次):真的 MVT 濕地可以是一整片保育區(半徑幾百公尺),照 r 撒出去
    // 就是十五根互相看不到的針。上限是「十五根」不是「密度」,所以要把它們留在
    // 同一個看得完的範圍裡。demo 這裡寫的是 `r * 0.7`,其餘一字未改。
    const spread = Math.min(r, 30);
    const clumps = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < clumps && cells.length < LU_REED_MAX; i++) {
      const a = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * spread * 0.7;
      const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad;
      const n = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < n && cells.length < LU_REED_MAX; k++) {
        const x = bx + (rng() - 0.5) * 4.4, z = bz + (rng() - 0.5) * 4.4;
        const h = (1.2 + rng() * 0.9) * LU_UNIT;      // 2.4–4.2 m,一根軟糖條
        const spin = rng() * Math.PI;
        const lean = (rng() - 0.5) * 0.3;
        // demo 這裡是**逐根**取 `geoGroundY(x, z)`,因為 demo 的地被板是貼著地面
        // 鋪的(它的走廊是平滑的);gameview 的板子是**平的**、而且 floor 到最低的
        // 那一階,所以站的是 `slabY`。再去取一次 DEM 會讓腳落在板子的上一層或
        // 下一層(合約的 docstring 寫的就是這件事)。
        cells.push([x, ctx.slabY + h / 2, z, spin, lean,
          0.55 * LU_UNIT, h, 0.36 * LU_UNIT]);
      }
    }
    const group = new THREE.Group();
    luBricks(group, 'lu-reeds', luReedMat(), cells);
    return group.children.length ? group : null;
  };

  /**
   * 遊樂場:五格裡**唯一站得起來**的一格,而它的訊號就是剪影 —— 所以地墊什麼都
   * 不印,全部的預算花在兩座結構上。兩座都是這個世界貨架上本來就有的東西:
   *
   *   溜滑梯 = 3 塊 1×1 疊成的梯 + 一片平台 + **三段折線逼近的曲面斜坡磚**
   *            (積木做不出真的曲面,曲面斜坡磚本來就是一段一段折出來的)
   *   蹺蹺板 = 一塊長磚**架在一顆 1×1 上**
   *
   * 顏色三種(黃 / 青 / 粉,全部是 `CANDY` 裡本來就有、而且建築已經在用的糖果色,
   * 所以 `brickMat` 會直接命中既有的材質,unique material 一份都不會多),於是一塊
   * 遊樂場 = 3 個 draw call,不是 10 個。
   */
  const luPlayProps = (ctx: LandusePropContext): THREE.Object3D | null => {
    const { rng, centerX: cx, centerZ: cz, radius: r } = ctx;
    if (r < LU_PROP_MIN_R) return null;
    // 尺寸一律是 LU_UNIT(這個世界的 1×1)的倍數。s 只在地塊小到裝不下時才縮。
    const s = LU_UNIT * Math.min(1, r / 11);
    const a0 = rng() * Math.PI * 2;                 // 溜滑梯擺在這個方位
    const a1 = a0 + Math.PI + (rng() - 0.5) * 1.1;  // 蹺蹺板擺對面,兩座不會疊在一起
    const rad0 = (0.05 + rng() * 0.1) * r;          // 溜滑梯佔 14 m,只能靠中間
    const rad1 = (0.34 + rng() * 0.2) * r;
    const yellow: number[][] = [], cyan: number[][] = [], pink: number[][] = [];

    // ── 溜滑梯 ──
    {
      const px = cx + Math.cos(a0) * rad0, pz = cz + Math.sin(a0) * rad0;
      const gy = ctx.slabY, ang = rng() * Math.PI * 2;   // demo: gy = geoGroundY(px, pz)
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // 區域 (lx, ly) 的單位是「1×1 幾顆」→ 世界:Ry(ang)·(1,0,0) = (cos, 0, −sin)。
      const put = (
        arr: number[][], lx: number, ly: number, w: number, h: number, d: number, rz?: number,
      ): number => arr.push([
        px + lx * s * ca, gy + ly * s, pz - lx * s * sa, ang, rz || 0, w * s, h * s, d * s,
      ]);
      for (let k = 0; k < 3; k++) put(cyan, -3.1, 0.5 + k, 1, 1, 1);   // 梯:1×1 疊三顆
      put(yellow, -2.7, 3.175, 2.3, 0.35, 1.7);                       // 平台,踩在梯頂上
      // 曲面斜坡磚:三段,越往下越平(−33.7° → −25.3° → −15.1°)。積木做不出真的
      // 曲面,曲面斜坡磚本來就是一段一段折出來的 —— 三段的**單調變平**就是那個
      // 「曲」字。中點/長度/角度是從折點 (−2.1,3.0)(−0.6,2.0)(1.2,1.15)(3.6,0.5)
      // 一起算出來的,不要分開改;而且 (−2.1,3.0) 必須等於梯頂,不然滑梯會浮空。
      for (const seg of [[-1.35, 2.500, 1.803, -0.588],
        [0.30, 1.575, 1.991, -0.441], [2.40, 0.825, 2.486, -0.264]]) {
        put(yellow, seg[0], seg[1], seg[2], 0.28, 1.4, seg[3]);
      }
    }
    // ── 蹺蹺板 ──
    {
      const px = cx + Math.cos(a1) * rad1, pz = cz + Math.sin(a1) * rad1;
      const gy = ctx.slabY, ang = rng() * Math.PI * 2;   // demo: gy = geoGroundY(px, pz)
      cyan.push([px, gy + 0.5 * s, pz, ang, 0, s, s, s]);                       // 1×1 支點
      pink.push([px, gy + 1.15 * s, pz, ang, 0.26, 4 * s, 0.3 * s, 1 * s]);     // 架上去的長磚
    }

    const group = new THREE.Group();
    luBricks(group, 'lu-slide', brickMat(CANDY.yellow), yellow);
    luBricks(group, 'lu-frame', brickMat(CANDY.cyan), cyan);
    luBricks(group, 'lu-seesaw', brickMat(CANDY.pink), pink);
    return group.children.length ? group : null;
  };

  const strategy: TerrainStyleStrategy = {
    style: 'plastic',
    params,

    // ── Colours ──
    // 走廊的頂點色仍然照舊算(平滑地形那條路、chunk 接縫的 `prevEdge` 都還吃
    // 它);量化地形的踏面則由下面的 `bandAt` 蓋掉 —— 射出成型的塑膠是單一色,
    // 分層設色靠的就是「同一階 = 同一色」,再摻噪點就讀不出階了。
    terrainVertexColor: (elevation, worldX, worldZ) =>
      pmTerrainVertexColor(elevation, worldX, worldZ),
    /** demo 的 `bandAt` 原封搬過來,只有 `STEP_H` 換成這個世界的量化階。 */
    bandAt: (y) => bandColors[
      Math.min(TERRAIN_BAND.length - 1, Math.max(0, Math.round(y / Math.max(1, params.layerHeight))))
    ],
    buildingColor: (lon, lat) => buildingColorFromCoord(lon, lat),
    roadColor: (cls) => roadColorForClass(cls),
    roadWidth: (cls) => roadWidthForClass(cls),
    zoneDecalColor: (zone) => ZONE_DECAL_COLORS[zone ?? 'residential'],
    treeTrunkColor: COIL_TRUNK_COLOR,
    treeCanopyColors: COIL_GREENS,

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
    // The demo's `pondFilmMat`, number for number (opacity 0.6, not 0.62).
    createWaterMaterial: () => new THREE.MeshPhongMaterial({
      color: CANDY.cyan,
      specular: 0xffffff,
      shininess: 160,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    }),
    createParkMaterial: () => createParkToonMaterial(),
    createForestMaterial: () => createForestToonMaterial(),
    // 沙地 = 散開的 1×1 圓凸點。demo:`toon({ map: luTex(16, luSandCanvas) })`。
    // 這裡本來是一片素色的 `createSandToonMaterial()`,而素色沙地在掠角下跟素色
    // 農田、素色遊樂場長得一模一樣 —— 這一格的訊號(顏色與**粗糙度**)有一半在
    // 貼圖裡,拿掉貼圖等於拿掉一半。
    createSandMaterial: () => new THREE.MeshToonMaterial({
      map: overlayTex('sand', () => luTex(16, luSandCanvas)),
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // The district wash. Toon, not Basic — the demo's note: a Basic decal takes
    // no light, so at night the whole block glows on its own instead of going
    // down with everything else. `vertexColors` is what carries the five zones
    // on one material; `depthWrite: false` keeps a translucent plate from hiding
    // things that are legitimately level with it (studs, kerbs, low trim).
    createZoneDecalMaterial: () => new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    createTreeMaterial: () => createTreeMaterial(),
    // 濕地 = 一片**軟糖**:半透明 + 高光,底下透得出板子,那是「一片軟糖」跟
    // 「一塊綠磚」的差別。demo:`gloss('#ffffff', { map: luTex(16, luWetCanvas),
    // transparent: true, opacity: 0.84, depthWrite: false, shininess: 150 })`。
    // 色**在貼圖裡**(積水斑、透光的亮斑),所以材質本體是白的 —— 這裡本來是一塊
    // 素色 0x27d4a0 的磚,那等於把這一格唯一的訊號(不規則的斑)整個丟掉。
    // `depthWrite: false`:半透明的東西壓在地上,不關掉它會擋掉自己上面那幾根
    // 軟糖條(`buildLanduseProps` 種的那些)。
    createWetlandMaterial: () => new THREE.MeshPhongMaterial({
      color: 0xffffff,
      map: overlayTex('wetland', () => luTex(16, luWetCanvas)),
      specular: 0xffffff,
      shininess: 150,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // 農田 = 壟 + 苗。demo:`toon({ map: luTex(16, luFarmCanvas) })`。
    // 本來是 16 m 的野餐布方格(兩個綠格子),方格在掠角下沒有方向、也讀不出間距
    // —— 而「壟的方向與間距」正是這一格唯一活得下來的訊號(§3.4)。
    createFarmlandMaterial: () => new THREE.MeshToonMaterial({
      map: overlayTex('farmland', () => luTex(16, luFarmCanvas)),
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    /**
     * 球場 = 一面 21.6 m 的場,四周留 2 m 走道,白線是一節一節的薄板磚。
     * demo:`toon({ map: tex, emissiveMap: tex })` + `glowAtNight(m, '#eaf2ff', 0.5)`。
     *
     * ★ **五格裡唯一有燈的一格**(§3.9):球場有投射燈是真的;農田、濕地、遊樂場、
     *   沙地入夜就是暗的,而「這種東西沒有燈」是完全合法、比硬加一盞好的答案。
     *   刻意**沒有燈桿** —— 一根桿子就是第二個高的剪影,會跟遊樂場撞身分,而且
     *   512 塊球場 × 4 根桿子是 draw call 自殺。會亮的是被打亮的**地**。
     *
     * `emissiveMap` 掛**同一張**貼圖:不掛的話 emissive 是平均加在整片板子上的,
     * 白線會被自己的光洗掉;掛上去之後亮的是**線**,場地本身只微微泛藍 —— 那才是
     * 被投射燈打亮的球場,而不是一塊發光的板子。
     *
     * Phong → Toon:demo 用的是 `toon()`,而球場是一塊**霧面**的塑膠薄板(高光留
     * 給軟糖片那一格,兩格才分得開手感,§3.2)。
     */
    createSportsFieldMaterial: () => new THREE.MeshToonMaterial({
      // 夜:**這片地自己不發光**(使用者裁示,demo 已改)。原本這裡掛了
      // `emissiveMap` + `registerNightLitMaterial`,而一整片地面亮起來讀出來是
      // **招牌**不是照明 —— 招牌是別的元件的身分(§3.3),而且「整片自己亮」正是
      // §3.10「小、在裡面、被半透明的殼包著」的反面。
      //
      // demo(`luMat('sports')`)現在就是這一行:`toon({ map: luTex(25.6,
      // luSportCanvas) })`,沒有 emissive、沒有 emissiveMap、不進夜燈登記處。
      // 照亮它的是場邊那盞泡泡燈的 PointLight —— 燈的身分跟**地塊的 seed** 綁
      // (那塊地重心取整),不是路燈池的索引;池是滑動的,綁索引會讓同一座球場
      // 每 70 m 換一次色(`2427d86` 修過那個)。擺燈是 `landuse-renderer` 的事。
      map: overlayTex('sports', () => luTex(25.6, luSportCanvas)),
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    /**
     * 遊樂場的地墊。**一個圖案都不印,連一張 canvas 都不開**(demo:
     * `toon({ color: LU_C.mat })`)—— 遊樂場唯一活得下來的訊號是剪影(§3.4,
     * 那些結構在 `buildLanduseProps` 裡),地面再加花樣只會跟農田的絲印撞手感
     * (§3.2)。霧面(toon 沒有高光)= 橡膠軟墊,跟周圍亮面的塑膠件也分得開。
     */
    createPlaygroundMaterial: () => new THREE.MeshToonMaterial({
      color: LU_C.mat,
      gradientMap: GRADIENT_MAP,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),

    // ── Diorama props ──

    horizonColor: BASEPLATE_COLOR,

    // The baseplate. Toon so it goes down with the day/night cycle like every
    // other moulded surface, FrontSide because a 4 km plane seen from below is a
    // black wedge across the frame (mountain-ring.ts has the full story), and
    // opaque because it is the ground — the one thing on screen this size that
    // must not be another blended layer.
    createHorizonMaterial: () => new THREE.MeshToonMaterial({
      map: overlayTex('baseplate', createBaseplateTexture),
      gradientMap: GRADIENT_MAP,
      side: THREE.FrontSide,
    }),

    /**
     * …and the near half of the same baseplate, as REAL STUDS.
     *
     * Every number is the demo's own (`plan/plastic-town-demo.html`, the
     * 「底板凸點」 IIFE): 5 m lattice, 130 m board, road corridor at |lat| < 7.5,
     * 4 m inset at the board's edge, `studInstances(pts, 1.5, 0.7, col)`.
     *
     * `boardW = 130` is a real boundary, not a budget cut: the demo's board is
     * 130 m wide with side walls dropping 9 m, and everything past it is the
     * violet play mat. gameview keeps building ground out to ±500 m, so the
     * studs stop where the demo's board does and terrain carries on.
     */
    groundStuds: {
      pitch: 5,              // demo: `const STEP = 5;`
      halfWidth: 130 / 2,    // demo: `const boardW = 130;`
      edgeInset: 4,          // demo: `lat = -boardW / 2 + 4 … boardW / 2 - 4`
      corridorSkip: 7.5,     // demo: `if (Math.abs(lat) < 7.5) continue;`
      radius: 1.5,           // demo: `studInstances(pts, 1.5, 0.7, …)`
      height: 0.7,
      bandCount: TERRAIN_BAND.length,
      lodGeometries: () => studGeos(),
      /**
       * 凸點的顏色 = **它腳下那塊磚的顏色**,現在包含那塊磚的分層階。
       *
       * > 同一塊塑膠射出來的東西不會兩個色。
       *
       * demo 的小丘凸點就是這樣寫的(`for (const pt of pts) studPts.push(b1.top, pt)`
       * —— 直接吃那片 slab 的 `band.top`),這一版只是把「哪一階」從 demo 寫死的
       * 1 換成量出來的階。`band` 已經在 `ground-studs` 夾進表內。
       *
       * 公園是**畫在**街廓上的一塊不透明草地板,腳下那塊板就是草地色,所以它不
       * 跟著分層走(demo 同樣是固定的 `'#66ff70'`)。
       */
      colorFor: (ground, band = 0) => (
        ground === null ? bandColors[band].top.getHex()
          : ground === 'park' ? PARK_STUD_COLOR
            : zoneStudColor(ground, band)
      ),
      // Same memo as every other stud in this world (`studMaterial`), so a
      // bucket's material is shared across chunks and across props.
      materialFor: (color) => studMaterial(color),
    },

    /**
     * 底板的側牆 —— demo 的
     * `sideWallSeg(d0, d1, side * boardW / 2, -9, 0)` + `boardSideMat`。
     *
     * demo 那兩行原封不動:
     *
     * ```js
     * const boardSideMat = toonShared(C.baseSide, { side: THREE.DoubleSide });
     * for (const side of [-1, 1]) {
     *   const wallGeo = sideWallSeg(d0, d1, side * boardW / 2, -9, 0);
     * ```
     *
     * 顏色 `C.baseSide = '#1fae44'` 跟 `TERRAIN_BAND[0].side` **是同一個數字**
     * ——底板就是第 0 階,而「側面 = 等高線」在第 0 階上量的就是底板的模邊,所以
     * 這裡不是巧合也不是近似,是同一件東西的兩個名字(跟 `BASE_GREEN` 那段一樣)。
     * 引用色帶而不是再寫一次 hex,改色才只有一處。
     *
     * `DoubleSide`:牆只有一面朝外,但底板在陡坡上會被走廊切成前後兩截,背面朝
     * 鏡頭的那一段若剔除掉就會看穿到板子底下 —— demo 也是 DoubleSide。
     */
    sideWall: {
      drop: 9,               // demo: `sideWallSeg(…, -9, 0)`,板面在 y = 0
      createMaterial: () => sharedTrim('boardSide', () => new THREE.MeshToonMaterial({
        color: TERRAIN_BAND[0].side,
        gradientMap: GRADIENT_MAP,
        side: THREE.DoubleSide,
      })),
    },

    /**
     * The toy's DISPLAY BOX — the clear plastic case the set came in, still on
     * the shelf with the baseplate inside it. Blue-white and cold, the colour
     * injection-moulded PS actually is, against the candy palette underneath.
     *
     * Its streaks are the box's own: a thick-walled moulding reflects the room
     * light TWICE, a bright core with a fainter twin a few degrees off, plus one
     * short streak on the far side. That double is the difference between "clear
     * plastic box" and "pane of glass" — see the corrugated world for the other
     * answer. Numbers are the plastic demo's own (`plan/plastic-town-demo.html`).
     */
    acrylicCase: {
      tintDay: 0xdff0ff,
      tintNight: 0x6d7cc0,
      tintRain: 0x7fb6dc,
      rimDay: 0xcbe4f6,
      rimNight: 0x8493d4,
      lipColor: 0xeaf7fa,
      streakDay: 0xffffff,
      streakNight: 0xcbd6ff,
      rainFilmColor: 0xcfeaff,
      shellOpacity: 0.16,
      rimOpacity: 0.3,
      lipOpacity: 0.42,
      streakOpacity: 0.36,
      // [phi, phi width, theta start, theta length]. The tight pair at 0.60/0.79
      // is the double reflection off a thick moulded wall — the demo's own
      // numbers, and the thing that says "clear plastic box" rather than
      // "glass". Every theta run ends near 1.5: a streak that stops at the crown
      // is a streak the game camera never sees (see `AcrylicStreak`).
      //
      // FOUR, where the demo has three, and the reason is gameview-specific.
      // The case does not rotate — a reflection that swung round as you turned
      // would read as a glitch — so a streak is only in frame when the rider
      // happens to face it. The demo's camera runs a closed loop and sees them
      // all; a rider can hold one heading for an entire 45 km route. Spaced so
      // no gap between neighbours exceeds ~2.1 rad against a ~1.8 rad field of
      // view, ONE OR TWO are in frame from any heading, which is what the spec
      // asks for — it is the count on screen, not the count on the case.
      streaks: [
        [0.6, 0.075, 0.14, 1.38],
        [0.79, 0.032, 0.22, 1.22],
        [2.79, 0.058, 0.3, 1.06],
        [4.87, 0.05, 0.18, 1.3],
      ],
    },

    // Candy-shop daylight → deep violet toy-box night. Straight from the plastic
    // demo (ref-demo-plastic-src.js DAY/NIGHT); tuned for exposure 1.05.
    skyPalette: {
      // demo:`float h = clamp(vP.y / 260.0, …)` / `floor(h * 5.0) / 5.0` on its
      // 1100 m dome. 260 is this world's alone — paper and circuit say 500.
      gradient: { demoHeight: 260, steps: 5 },
      // demo 的星星那一段,原封搬過來(plan/plastic-town-demo.html):
      //   const n = 260 … ph = Math.random() * Math.PI * 0.42 + 0.08
      //   sg.fillStyle = '#fff2a0'; sg.arc(16, 16, 7, 0, Math.PI * 2);
      //   new THREE.PointsMaterial({ size: 28.42105263157895, … })
      // size 是**世界公尺**(sizeAttenuation),不是螢幕像素 —— 見 starPointSize。
      // 糖果色的暖黃,跟這個世界的日光同一支色溫。
      stars: {
        count: 260, size: 28.42105263157895,
        polarSpan: 0.42, polarMin: 0.08,
        spriteRadius: 7, color: '#fff2a0',
      },
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

    // 軟軟的發光彈力球 —— demo 的 `plasticDisc` 原封搬過來
    // (plan/plastic-town-demo.html)。一個物件、兩個色溫:白天暖光是太陽、夜裡冷光
    // 是月亮 —— 日與月是同一件事的兩端,跟天相滑桿一樣。
    //
    // ## 跟泡泡燈路燈為什麼分得開(§3.2 / §3.3)
    //
    // 這是這個造型唯一真正的風險:路燈 `buildBubbleLamp` 也是一顆會亮的球,而且
    // **角大小救不了** —— 泡泡燈的膜在 20 m 外約 11.1°、40 m 外 5.6°,跟太陽的
    // 7.59° 完全重疊。所以分辨只能靠剪影,三件事:
    //
    //  1. **輪廓** —— 泡泡燈是正圓的 `SphereGeometry` 而且架在桿子上;光球是 12 瓣
    //     波浪(徑向起伏 25.9%)、橫寬縱扁、沒有桿子。
    //  2. **實 vs 空** —— 泡泡燈是一層看得穿的膜(`DoubleSide` + opacity 0.28);
    //     光球是實心的,整顆都是那個光。
    //  3. **§3.10 在這裡是反過來的,而那是對的。** 那條說「發光面積 = 物件面積 →
    //     一塊會發光的色塊」,所以**燈**要做成「小亮點 + 半透明殼」。但太陽不是燈罩,
    //     它**就是**光源本身,而且 `buildCelestialDisc` 不參與打光(打光在
    //     skyPalette)。這個世界裡「整顆都在發光」是正確答案的東西只有這一個,所以
    //     那條規矩的失敗模式在這裡正好變成最好的辨識點 —— 內光刻意畫得很大
    //     (`R × 0.62`),畫成小點就變回路燈了。
    //
    // 邊緣語彙 = **凸粒**,跟本體連在一起(瓦楞紙那圈是離開本體的線段,那就是差別)。
    // 顏色全部出自這個世界的色票,一個新色都沒有;只有高光是純白,而那不是顏色。
    buildCelestialDisc: (body, shellRadius) => {
      // demo:`plasticDisc(42, '#ffb300', '#ffea00')` /
      //      `plasticDisc(34, '#00d8ff', '#b9f6ca')`
      const [demoRadius, shell, glow] = body === 'sun'
        ? [42, '#ffb300', '#ffea00'] as const
        : [34, '#00d8ff', '#b9f6ca'] as const;
      const r = celestialDiscRadius(body, shellRadius, demoRadius);
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const R = 42, NUB = 12, NUB_H = 6, P = 144;  // P / NUB = 12:每顆凸粒取樣數相同
      /**
       * 輪廓走**一條封閉折線**,不用 arc / ellipse,兩個理由:
       *  1. 軟球不是正圓,而 texture-probe 的 `ellipse()` 會退化成
       *     `arc((rx + ry) / 2)`(§10「probe 會騙你」)—— 用 ellipse 的話「壓扁」在
       *     驗收圖上就消失了,而壓扁正是它跟泡泡燈分得開的第一件事。
       *  2. 凸粒跟球身是**同一條輪廓**。
       */
      const rim = (a: number): [number, number] => {
        // 指數**小於 1**:凸起的頂是寬而圓的、只有交界處收成一道窄縫。反過來寫
        // (指數 > 1)畫出來是一顆齒輪,而且離瓦楞紙那圈放射線太近。
        const bump = Math.pow(Math.abs(Math.cos((a * NUB) / 2)), 0.55);
        const rr = R + NUB_H * bump;
        const sag = 0.055 * Math.max(0, Math.sin(a));  // canvas 的 +y 朝下 = 球的底
        return [64 + Math.cos(a) * rr * 1.05, 64 + Math.sin(a) * rr * (0.93 - sag)];
      };
      g.fillStyle = shell;
      g.beginPath();
      for (let k = 0; k <= P; k++) {
        const [x, y] = rim((k / P) * Math.PI * 2);
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      // 內光:大、偏左上一點(光從裡面透出來,不是貼在表面的一塊)。
      g.fillStyle = glow;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.arc(64 - 4, 64 - 5, R * 0.62, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      // 合模線:兩片模合起來留下的那道稜。軟塑膠玩具身上一定有,而泡泡燈沒有
      // —— 它是吹出來的,不是模出來的。
      g.strokeStyle = '#1a1140';
      g.lineWidth = 2.5;
      g.globalAlpha = 0.45;
      g.beginPath();
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const x = 64 - 4 + Math.sin(t * Math.PI) * 13;
        const y = 64 + (t * 2 - 1) * R * 0.92;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.globalAlpha = 1;
      // 軟的鏡面高光:一團,不是一道細弧。硬邊的細弧讀起來是硬塑膠。
      g.fillStyle = '#ffffff';
      g.globalAlpha = 0.5;
      g.beginPath();
      g.arc(48, 46, 13, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(56, 39, 7, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.Mesh(
        new THREE.CircleGeometry(r, 40),
        new THREE.MeshBasicMaterial({
          map: t, transparent: true, fog: false, depthWrite: false,
        }),
      );
    },

    // 積木雲 —— demo 的「積木雲」原封搬過來(plan/plastic-town-demo.html):
    // 白色大磚 + 淡藍小磚,小磚頂上一排凸點。高度、漂移、入雲淡出全歸
    // sky-and-fog(deck 行為不是造型)——這裡只管一朵雲長什麼樣。
    buildCloud: (_index, rand) => {
      // 亂數一律走 rand(預設 Math.random):three 每建一個物件都會為 uuid 抽
      // 四次 Math.random,check:3d 的 seeded 流直接吃全域的話永遠對不上 demo。
      const rnd = rand ?? Math.random;
      if (!cloudWhiteMat || !cloudPaleMat) {
        cloudBoxGeo = new THREE.BoxGeometry(1, 1, 1);
        cloudBoxGeo.userData.shared = true;
        cloudWhiteMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: GRADIENT_MAP });
        cloudWhiteMat.userData.shared = true;
        cloudPaleMat = new THREE.MeshToonMaterial({ color: 0xf4f6ff, gradientMap: GRADIENT_MAP });
        cloudPaleMat.userData.shared = true;
      }
      // 亂數的**消費順序**跟 demo 一字不差(w、再 b2 的橫向偏移):check:3d
      // 拿同一條 seeded 流跑 demo 原始碼跟這裡,逐件比對 —— 改順序會壞校準。
      const grp = new THREE.Group();
      const w = 16 + rnd() * 10;
      const b1 = new THREE.Mesh(cloudBoxGeo!, cloudWhiteMat);
      b1.scale.set(w, 5, 9);
      grp.add(b1);
      const b2 = new THREE.Mesh(cloudBoxGeo!, cloudPaleMat);
      b2.scale.set(w * 0.55, 4, 7);
      b2.position.set((rnd() - 0.5) * 4, 4.5, 0);
      grp.add(b2);
      // demo 把凸點掛在 b2 底下(區域座標、topY = 2);b2 在這裡是縮放過的
      // 單位方塊,凸點掛上去會一起被縮 —— 所以掛在 grp、平移到 b2 的位置,
      // 世界座標跟 demo 一樣(y = 4.5 + 2)。
      // demo 的雲凸點就是 `studGeos[0]`(STUD_LOD[0] = 8 段),跟底板凸點的最高
      // 級是同一顆單位 stud —— 這裡也共用同一顆。
      const studs = studGrid(w * 0.55, 7, 2, 0xffffff, undefined, undefined, 8, {
        geometry: studGeos()[0],
        material: cloudWhiteMat,
        height: 0.55, // demo 的 addStudsRect 固定 0.55,不是 radius 封頂的預設
      });
      studs.position.copy(b2.position);
      grp.add(studs);
      return grp;
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

    // NO INK LINE, and that is an answer rather than a gap: `blockMountainRing`
    // in plan/plastic-town-demo.html is one `toonShared(color)` strip and nothing
    // else. Moulded plastic has no brush to lift off a ridge — the crest band is
    // the paper world's mark, and giving it to this world would be exactly the
    // 手感撞號 §3.2 warns about.
    //
    // Fog stays ON, also the demo's: its ring is a physical object standing in
    // the haze (fog 260–780 with the far ring at 600 — 65% of the way in), not a
    // stroke that already means "far". `day-night-lighting.ts` holds the fog's
    // far end out so that fraction survives the rescale to a 2600 m ring.
    mountainRingFinish: () => ({
      ridgeLineColor: null,
      ridgeLineThickness: 0,
      fog: true,
    }),

    buildBikeOrnament: () => buildBrickBike(),
    buildPlaneOrnament: () => buildBrickPlane(),
    buildFinishAirship: () => buildToyUfo(),

    buildStreetLamp: (index = 0) => buildBubbleLamp(index),

    /**
     * 金幣 = 撲克籌碼(demo `coinField`,逐數字照抄)。
     *
     * 積木圓片(一片圓餅 + 面上一顆凸點)是 demo **換掉的**那一版:圓片太弱,
     * 轉起來只有一個特徵。籌碼有**滾花邊**跟**內圈嵌色**,轉動時兩個特徵輪流
     * 閃,遠比一塊平的圓餅好認 —— 這裡把那三件(本體 / 內圈 / 六塊滾花)搬回來。
     *
     * 姿態的合成跟 demo 相同:demo 是 `Euler(π/2, spin, 0, 'YXZ')`,也就是
     * `Ry(spin)·Rx(π/2)`;這裡把 `Rx(π/2)` 烘進幾何(子物件則放在自己的
     * `rotation.x`),外面由 `useTerrainRenderer` 每幀轉 `rotation.y` —— 兩個
     * 乘法順序一樣。
     *
     * 滾花走 InstancedMesh:demo 說得很明白,一枚 8 個 Mesh 是這個場景 draw
     * call 的真兇,它自己也是併成「本體 / 內圈 / 滾花」三批。這裡一枚 = 3 次
     * draw call(對上舊圓片的 2 次),而不是照著階層長成 8 次。
     */
    buildCoinMesh: () => {
      const coinMat = gloss(0xffd400, 120);
      coinMat.emissive.setHex(0x4a3a00);
      // 內圈與滾花同一份材質(demo:兩者都是 chipInnerMat)。
      const chipInnerMat = gloss(CANDY.pink, 120);
      chipInnerMat.emissive.setHex(0x3a0018);

      // demo:chipBaseGeo = CylinderGeometry(1,1,1,20),本體 scale(1.65,0.42,1.65)
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, 0.42, 20), coinMat);
      body.geometry.rotateX(Math.PI / 2);
      // demo `coinField`: `body.castShadow = true` — and that is the ONLY flag
      // on any of the three coin batches. The inner disc and the six knurls sit
      // INSIDE the body's own silhouette, so their shadows would be a second
      // copy of a shadow that is already there; and a coin hovering 3.4 m up
      // has nothing above it to receive one.
      body.castShadow = true;
      // 內圈:比本體薄但高出兩面 → 正面看是嵌進去的圓(demo 註解)
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.02, 0.48, 20), chipInnerMat);
      inner.geometry.rotateX(Math.PI / 2);
      body.add(inner);

      // 滾花:邊緣一圈嵌色的小塊,相對籌碼的位置是固定的(demo COIN_NUBS)
      const nubs = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.42, 0.34, 0.5), chipInnerMat, 6,
      );
      nubs.rotation.x = Math.PI / 2;   // 籌碼本體那一層的 Rx(π/2)
      const nubM = new THREE.Matrix4();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        nubs.setMatrixAt(i, nubM.makeRotationY(-a)
          .setPosition(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5));
      }
      nubs.instanceMatrix.needsUpdate = true;
      body.add(nubs);

      body.userData.isCoin = true;
      return body;
    },

    /**
     * Checkpoint = an octagonal toy road sign: moulded base, glossy post,
     * thick octagonal plate with the label stickered on.
     *
     * Not a flag on a pole any more. "A marker at the roadside" needs no
     * explaining when it is shaped like a road sign, and the plate is a writing
     * surface by nature — it takes the same sticker every shop front does.
     * OCTAGONAL on purpose: paper's checkpoint is a pin flag (post + rectangle)
     * and the shape has to be distinguishable from that across the whole world
     * set, so a round-ish face is the one that reads differently at silhouette
     * size.
     *
     * Everything here is built fresh per checkpoint — geometries AND materials.
     * `CheckpointFlagManager` fades a passed checkpoint by writing `opacity`
     * onto every material it can reach and disposes both on teardown, so a
     * shared singleton would fade (or free) every other prop wearing it.
     */
    buildCheckpoint: (color, _index, label) => {
      const group = new THREE.Group();
      const signColor = new THREE.Color(color);
      const bodyMat = new THREE.MeshPhongMaterial({
        color: signColor, specular: 0xffffff, shininess: 130,
      });
      const baseMat = new THREE.MeshToonMaterial({ color: 0x8a90a0, gradientMap: GRADIENT_MAP });

      // demo `makeCheckpoint`: `base.receiveShadow = true` (the moulded foot is
      // where the post's own shadow lands) and `post.castShadow = true` — each
      // part declares the ONE half of the job it actually does.
      const base = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.55, 14), baseMat);
      base.position.y = 0.28;
      base.receiveShadow = true;
      group.add(base);

      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6.2, 10), bodyMat);
      post.position.y = 3.4;
      post.castShadow = true;
      group.add(post);

      // 牌面要朝**騎士來的方向**。`CheckpointFlagManager` 擺放時做的是 demo 的
      // `cp.rotation.y = atan2(p.tx, p.tz)`,把局部 +Z 對到路線的前進方向,所以
      // 騎士是從 −Z 靠過來的 —— face 轉 180° 才是迎著他。demo 第一版轉了 90°
      // (以為 +X 面向馬路),結果整塊牌子側對騎手,只看得到背面跟一條邊。
      const face = new THREE.Group();
      face.position.y = 8.6;
      face.rotation.y = Math.PI;

      // Thick, not a card: a thin plate seen edge-on from the 6.3 m chase eye
      // has almost no projected area and the whole sign disappears.
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 0.72, 8), bodyMat);
      plate.rotation.x = Math.PI / 2;
      plate.castShadow = true;
      face.add(plate);

      // White octagon inset on the plate. It is what makes the thing read as a
      // sign FACE rather than a coloured disc when the label cannot be written
      // — `buildSign` returns null for text this world has no glyphs for, and
      // an unlabelled checkpoint still has to look like a sign.
      const stickerMat = new THREE.MeshPhongMaterial({
        color: STICKER_BACKING_COLOR, specular: 0xffffff, shininess: 60,
      });
      const sticker = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 0.1, 8), stickerMat);
      sticker.rotation.x = Math.PI / 2;
      sticker.position.z = 0.4;
      face.add(sticker);

      // The words themselves stay on the shared sign carrier (sign-spec /
      // sign-builder) — one world, one way of writing.
      const tag = strategy.buildSign?.('checkpoint', label ?? '', 5.2);
      if (tag) {
        tag.group.position.z = 0.48;
        face.add(tag.group);
      }

      group.add(face);
      return group;
    },

    /**
     * A printed sticker. Local frame: plate centred on the origin, face looking
     * down +Z, backing sitting just behind z = 0.
     *
     * Three things make it read as a sticker rather than a painted panel, and
     * dropping any one of them loses it: the white die-cut border, the 3–6°
     * crooked application, and the trapped bubble in one corner. The relief is
     * deliberately tiny (0.6 % of the width) — a letter brick's is seven times
     * that, which is what keeps the school building and the shop sign apart at
     * a distance.
     */
    buildSign: (purpose: SignPurpose, text, maxWidth, opts) => {
      const clean = sanitizeSignText(text);
      const symbol = opts?.symbol ?? null;
      if (!clean && !symbol) return null;
      const w = Math.min(maxWidth, SIGN_MAX_WIDTH);
      if (w < 2.5) return null;
      const h = w / SIGN_RATIO;
      const zone = opts?.zone ?? 'commercial';
      // Thickness floor: seen edge-on from a 6.3 m eye a thin card vanishes.
      const backT = Math.max(0.3, h * 0.2);
      const relief = Math.max(0.05, w * 0.006);

      const group = new THREE.Group();
      const geos: THREE.BufferGeometry[] = [];
      // A checkpoint OWNS its materials — `CheckpointFlagManager` fades a passed
      // flag by writing `opacity` onto every material it finds, and a shared
      // singleton there would fade every shop sign on the route with it.
      const owned: THREE.Material[] = [];
      const pick = (key: string, make: () => THREE.Material): THREE.Material => {
        if (purpose !== 'checkpoint') return signMat(key, make);
        const m = make();
        owned.push(m);
        return m;
      };
      const makeField = () => new THREE.MeshPhongMaterial({
        color: STICKER_FIELD_COLORS[zone], specular: 0xffffff, shininess: 110,
      });

      const backing = new THREE.ExtrudeGeometry(roundedPlateShape(w, h, h * 0.16), {
        depth: backT,
        bevelEnabled: false,
        curveSegments: 3,
      });
      backing.translate(0, 0, -backT);
      geos.push(backing);
      const backMesh = new THREE.Mesh(backing, pick('backing', () =>
        new THREE.MeshToonMaterial({ color: STICKER_BACKING_COLOR, gradientMap: GRADIENT_MAP })));
      backMesh.castShadow = true;
      backMesh.receiveShadow = true;
      group.add(backMesh);

      // Printed field, inset so the die-cut white border shows all round.
      const fieldW = w * 0.88;
      const fieldH = h * 0.8;
      const field = new THREE.ExtrudeGeometry(roundedPlateShape(fieldW, fieldH, fieldH * 0.14), {
        depth: relief * 0.6,
        bevelEnabled: false,
        curveSegments: 3,
      });
      geos.push(field);
      // demo `flushSigns`: the printed field goes out through `inst()` with the
      // mounting plate, and `inst()` opens both flags. The white sheet, the
      // letters and the trapped bubble go out through `bakeParts()` → a plain
      // `new THREE.Mesh(g, mat)` with NEITHER — they are 0.05–0.07 m films
      // lying on a board that already casts, so their shadow is inside its
      // shadow. Two different exits from the same function, and the difference
      // is the demo's answer.
      const fieldMesh = new THREE.Mesh(field, pick(`field:${zone}`, makeField));
      fieldMesh.castShadow = true;
      fieldMesh.receiveShadow = true;
      group.add(fieldMesh);

      if (symbol) {
        const tri = buildSignTriangleGeometry(fieldH, relief);
        tri.translate(0, 0, relief * 0.6);
        geos.push(tri);
        group.add(new THREE.Mesh(tri, pick('tri', () =>
          new THREE.MeshToonMaterial({
            color: STICKER_TRIANGLE_COLOR, gradientMap: GRADIENT_MAP,
          }))));
      } else {
        const strokes = buildStrokeGeometry(signStrokes(fieldW, fieldH, clean), relief);
        if (strokes) {
          strokes.translate(0, 0, relief * 0.6);
          geos.push(strokes);
          group.add(new THREE.Mesh(strokes, pick('ink', () =>
            new THREE.MeshToonMaterial({ color: CANDY.ink, gradientMap: GRADIENT_MAP }))));
        }
      }

      // The trapped bubble. Deterministic corner so a given sign is always the
      // same sticker — a bubble that wanders between frames reads as a glitch.
      const bubbleR = h * 0.13;
      const bubble = new THREE.SphereGeometry(bubbleR, 8, 6);
      bubble.scale(1, 1, 0.35);
      bubble.translate(-fieldW * 0.36, fieldH * 0.28, relief * 0.6);
      geos.push(bubble);
      group.add(new THREE.Mesh(bubble, pick(`field:${zone}`, makeField)));

      // Applied crooked. 3–6°, deterministic from the seed.
      const tilt = (3 + ((opts?.seed ?? 0) % 4)) * (Math.PI / 180);
      group.rotation.z = purpose === 'checkpoint' ? tilt : -tilt;

      return {
        group,
        width: w,
        height: h,
        dispose: () => {
          for (const g of geos) g.dispose();
          for (const m of owned) m.dispose();
        },
      };
    },

    // Matchbox body: a stacking-block tower (the developer's "積木/抽抽樂"
    // direction — see plan/plastic-town-demo.html, which this mirrors).
    //
    // Every layer is 2–4 smooth slabs laid side by side, crossed 90° against
    // the layer under it. Middle layers may lose a whole slab (a slot straight
    // through the tower) or have one pulled halfway out; whatever came out gets
    // restacked crooked on the roof.
    //
    // Why this and not a studded brick: the chase camera's eye is only 6.3 m
    // above the rider (fps-camera.ts CHASE_UP), so anything over ~6 m shows you
    // nothing but its walls. Studs live on the roof and are invisible to the
    // skyline; seams, slots and pulled slabs are all on the side, and they get
    // MORE legible the taller the building is.
    //
    // Copyright: block-pulling towers are a generic toy (many makers sell one).
    // Only the generic form is used — our own themes.scss $plastic palette, no
    // numbers, symbols or markings on any face, no specific product's trade
    // dress.
    //
    // …and four more, one per district — see "Zone buildings" at the bottom of
    // the file for what each one is and why. The tower stays the commercial
    // signature and the body every UNZONED footprint gets.
    //
    // NOTHING in the renderer reaches this hook any more: all five bodies leave
    // through `buildBuildingBoxes` below and are INSTANCED, the cup tower's
    // cones included. It stays because it is the second opinion — both hooks
    // read `plasticBodyBoxes`, and `npm run check:3d` compares the geometry this
    // builds against the matrices the renderer built, part by part. Delete it
    // and the two paths have nothing to disagree with.
    buildBuildingBody: (box, seed, zone) => buildBodyGeometry(plasticBodyBoxes(box, seed, zone)),

    /**
     * The same bodies, as parts, for the renderer's instanced batches. Never
     * null now — the cup tower's cups became `shape: 'cup'` parts, which was
     * worth 60 ms of body building plus 27 ms of merging on a dense Taipei
     * chunk. See `plasticBodyBoxes`.
     */
    buildBuildingBoxes: (box, seed, zone) => plasticBodyBoxes(box, seed, zone),

    /**
     * This world's shape vocabulary: three templates besides the cube, all
     * copied out of the demo — the cup's frustum, the demo's shelf disc, and
     * the demo's bevelled clay cube. Four batches per chunk, fixed, however
     * many buildings are in it.
     */
    buildPartTemplate: (shape) => partTemplate(shape),

    /**
     * Two of the five bodies answer here; three answer with an empty array,
     * which is a REAL answer and not a gap (DEVPLAN, and the demo's own note
     * above `WIN_LIT`). The split is which ROUTE the light takes:
     *
     *  · The letter blocks, the domino wall and the cup tower light up through
     *    a MATERIAL of their own — the letter rim, the pips, the cup wall (see
     *    `glowTrim` above). Nothing to place, so: [].
     *  · The tower lights a FACE of its body, so it places quads (below).
     *  · The clay house's window is a RECOLOURED VOXEL, which in the demo also
     *    took the material route. It cannot here: `building-renderer` merges
     *    every body in a chunk into one vertex-coloured mesh with one material,
     *    so a single voxel has no material to register. It places a quad on the
     *    face of that same voxel instead — the light still comes from the
     *    layout that decided where the yellow voxel went, which is the rule
     *    that matters. Lifting four voxels out into their own decoration mesh
     *    would buy the letter of the demo at the cost of a second material and
     *    a second geometry per house.
     *
     * The tower's windows ARE its exposed short faces — 「窗不必開,短面自己就是
     * 窗」. Every second layer of slabs is laid at 90° to the one under it, so
     * one pair of walls always shows a row of square slab ends. Those squares
     * are already there, already the right size, and already in the right
     * places; lighting a few of them is the whole feature. The generic facade
     * grid this replaced stamped its own rectangles across the wall, ignoring
     * the slabs entirely and landing half of them on a slab's long side where
     * nothing on a real toy tower ever is.
     *
     * Industrial gets none. A warehouse district with every unit lit reads as
     * housing; leaving it dark is what makes the zoning legible at night, and
     * "this kind of building has no lights" is a legal answer (§3.9).
     *
     * The roll uses its OWN rng stream. Sharing `buildBuildingBody`'s would
     * mean deciding which windows are lit also re-rolls which slabs got pulled
     * out — the shape would change when the lights did.
     */
    buildBuildingLights: (box, seed, zone) => {
      if (zone === 'industrial') return [];
      const kind = plasticBuildingKind(seed, zone);
      if (kind === 'clay') return clayHouseLayout(box, seed).windows;
      if (kind !== 'stack') return [];
      const rng = mulberry32((seed ^ 0x5f3a2b) >>> 0);
      const lit = zone === 'commercial' ? 0.55 : zone === 'residential' ? 0.42 : 0.34;
      const out: WindowPlacement[] = [];
      for (const s of plasticTowerSlabs(box, seed)) {
        if (s.core || s.alongX === undefined) continue;
        // The slab's LONG half-extent and its THICKNESS — the demo's `slabL` and
        // `slabT`, which is what `emitSlabFaceLights` is handed.
        const slabL = s.alongX ? s.w : s.d;
        const slabT = s.alongX ? s.d : s.w;
        // The short face has to be big enough to read as a window at all; a
        // sliver end on a narrow slab is a bright line, not a lit room.
        if (slabT < 1.1 || s.h < 1.1) continue;
        // demo `emitSlabFaceLights`: the quad is sized to the FACE it covers —
        // `qw = slabT * 0.68`, `qh = SLAB_H * 0.6` — which is the whole reason
        // a placement carries its own w/h. There is no "window size".
        const qw = slabT * 0.68;
        const qh = s.h * 0.6;
        const half = slabL / 2;
        // …and the slab's own yaw (layer tilt + pulled-slab spin) rotates the
        // offset AND the quad, exactly as the demo's `ry` does. Ignoring it
        // buries the light film inside a slab that is 3° off square.
        const ry = s.rotY ?? 0;
        for (const sign of [-1, 1]) {
          if (rng() > lit) continue;
          // demo: `dx = alongX ? cos(ry) * half * s : sin(ry) * half * s`,
          // `dz = alongX ? -sin(ry) * half * s : cos(ry) * half * s`, then
          // `x + dx * 1.03` — 3 % proud, proportional rather than a fixed nudge.
          const dx = (s.alongX ? Math.cos(ry) : Math.sin(ry)) * half * sign;
          const dz = (s.alongX ? -Math.sin(ry) : Math.cos(ry)) * half * sign;
          out.push({
            x: s.x + dx * 1.03,
            y: s.y,
            z: s.z + dz * 1.03,
            // A PlaneGeometry faces +z; yawed by `a` it faces (sin a, 0, cos a),
            // so +x wants `ry + π/2` and +z wants `ry`.
            rotY: s.alongX ? ry + sign * Math.PI / 2 : (sign > 0 ? ry : ry + Math.PI),
            w: qw,
            h: qh,
          });
        }
      }
      return out;
    },

    /** Route B's one material — see `buildingLightMat`. This world's lights are
     *  all the same warm film, so it takes no key. */
    createBuildingLightMaterial: () => buildingLightMat(),

    // Tunnel mouth: a brick arch with a flat black hole behind it. The road
    // itself stops at the hillside (a tunnel is inside the hill, not on it —
    // see road-renderer); this is what says "it goes through" rather than
    // "it just ends".
    buildTunnelPortal: (width) => {
      const group = new THREE.Group();
      const w = Math.max(5, width * 1.5);
      const h = Math.max(5, w * 0.75);
      const frameT = Math.max(0.8, w * 0.12);

      const outer = archOutline(new THREE.Shape(), w + frameT * 2, h + frameT);
      outer.holes.push(archOutline(new THREE.Path(), w, h));
      const frame = new THREE.Mesh(
        new THREE.ExtrudeGeometry(outer, { depth: 1.2, bevelEnabled: false, curveSegments: 6 }),
        brickMat(BRICK_COLORS[2]),
      );
      // Extrude runs +z; pull it back so the frame's FRONT face sits at z = 0.
      frame.position.z = -1.2;
      group.add(frame);

      // The mouth. Unlit and near-black on purpose: it stands for a hole, and
      // a lit surface pretending to be a hole goes pale the moment the sun
      // catches the slope it is cut into.
      const mouth = new THREE.Mesh(
        new THREE.ExtrudeGeometry(archOutline(new THREE.Shape(), w, h), {
          depth: 0.1, bevelEnabled: false, curveSegments: 6,
        }),
        sharedTrim('tunnelMouth', () => new THREE.MeshBasicMaterial({ color: 0x07060c })),
      );
      mouth.position.z = -1.4;
      group.add(mouth);

      group.add(studGrid(w + frameT * 2, 1.2, h + frameT, brighten(BRICK_COLORS[2], 0.25), 3, 1, 6));
      return group;
    },

    /**
     * Trim exists here for exactly one reason: a MATERIAL the merged body
     * cannot carry. The chunk's bodies are one mesh with one vertex-coloured
     * toon material, so anything that has to be glossy, see-through, or lit on
     * its own has to be a separate mesh — and everything that does not, is not.
     *
     * The tower and the clay house therefore have no trim at all: their whole
     * design is shape and colour, and both of those the body already carries.
     *
     * Each builder emits ONE pre-merged mesh per material per building.
     * `mergeBuildingDecorations` clones and bakes every mesh it is handed (and
     * every INSTANCE of an InstancedMesh separately), so a hundred little
     * meshes per building is a hundred clones — the merge is where a chunk's
     * build time goes, not the draw call.
     */
    buildBuildingDecoration: (box, seed, zone) => {
      switch (plasticBuildingKind(seed, zone)) {
        case 'cup': return buildCupWalls(box, seed);
        case 'alphabet': return buildLetterRelief(box, seed);
        case 'domino': return buildDominoFaces(box, seed);
        default: return null;
      }
    },

    // `facadeWindows` USED TO BE HERE — a 5 × 5 m grid of glossy white
    // `BoxGeometry(1.9, 1.5, 0.3)` window boxes stamped on the two long faces
    // of anything that had no themed body. Gone, along with the mechanism: the
    // demo deleted its own `addWindows()` and said why («那個網格完全不知道自己
    // 蓋在什麼上面»). A footprint with no themed body now has no lights, which
    // is the same legal answer the electrolytic capacitor gives.

    // ── Geometry hooks ──
    quantizeElevation: (absEle) => quantizeToLayer(absEle, params),

    // Pipe-cleaner trees — a fuzzy coil on a stub trunk (NOT a stack; see
    // `buildCoilTreeGeometry`). One geometry for the whole InstancedMesh, so
    // the demo's three-green cycle cannot live in the material here — it comes
    // from `tintTreeInstances`, which multiplies a per-tree canopy colour over
    // these vertex colours instead.
    buildTreeGeometry: () => buildCoilTreeGeometry(strategy.treeTrunkColor, strategy.treeCanopyColors[0]),

    /**
     * 地被裡會站起來的東西 —— demo 的 `LU_STYLE.props(kind, ctx)`,照抄。
     *
     * 五格裡只有兩格站得起來,另外三格回 `null`:壟、白線、沙粒**全部在貼圖裡**。
     * 那不是省略 —— 那三格在掠角下讀得到的訊號本來就不是立體的,而幾何要付的
     * draw call 在台北是以百計的(3×3 圖磚窗口實測 512 塊 sports)。
     * 「這一格什麼都不站起來」跟 §3.9 的「這種建築沒有燈」是同一個形狀的答案。
     */
    buildLanduseProps: (ctx) => {
      if (ctx.kind === 'wetland') return luWetProps(ctx);
      if (ctx.kind === 'playground') return luPlayProps(ctx);
      return null;
    },

    // ── Post ──
    /**
     * The toy world has no screen-space LOOK pass — geometry and toon shading
     * carry it. What it does have, per DEVPLAN, is a **very weak, night-only**
     * scene bloom: threshold high enough that only the street lamps and the
     * coins spill, so the plastic reads as glossy after dark instead of glowing.
     * (The corrugated world deliberately has none — poster paint does not glow.)
     *
     * This is NOT the cycling-glasses bloom; see `scene-bloom-pass.ts`.
     *
     * It rides the style-pass slot, which is free here precisely because plastic
     * has no look pass — one strategy, one pass into the composer. Returning
     * null when the rider has switched it off means the pass is never built and
     * never allocates a render target.
     */
    createPostPass: (width, height) => {
      if (!params.sceneBloomEnabled) return null;
      return new SceneBloomPass(width, height, {
        // Above ACES tone mapping at exposure 1.05, ordinary lit surfaces sit
        // well under this; lamp shells, window lights and coin speculars do not.
        threshold: 0.85,
        knee: 0.35,
      });
    },
    applyPostParams: (pass: ShaderPass) => {
      // Strength is a per-frame value (it follows the day/night blend), so it is
      // driven from `useTerrainRenderer`'s render loop, not from here. Nothing
      // in `params` belongs to this pass.
      void pass;
    },

    dispose: () => {
      buildingMaterial?.dispose();
      buildingMaterial = null;
      // Unregister BEFORE disposing: `setNightLitFactor` writes into every
      // registered material each frame, and a style swap that left these behind
      // would keep writing to the disposed ones.
      for (const mat of nightLitTrims) unregisterNightLitMaterial(mat);
      nightLitTrims.clear();
      for (const mat of trimMaterials.values()) mat.dispose();
      trimMaterials.clear();
      // Instance templates outlive every chunk on purpose (the chunks draw
      // clones), so the strategy is the only thing that can free them.
      for (const geo of trimTemplates.values()) geo.dispose();
      trimTemplates.clear();
      for (const geo of PART_TEMPLATES.values()) geo.dispose();
      PART_TEMPLATES.clear();
      roadTexture?.dispose();
      roadTexture = null;
      // Cloud singletons: the deck only ever disposed instance buffers (they
      // are marked userData.shared) — the strategy is the sole owner.
      cloudBoxGeo?.dispose();
      cloudBoxGeo = null;
      // 三顆單位 stud(STUD_LOD)——底板凸點與雲凸點共用,所以只有 strategy
      // 能放掉它們;chunk 的 dispose 只釋放 InstancedMesh 自己的 instanceMatrix。
      if (studLods) for (const g of studLods) g.dispose();
      studLods = null;
      // 地被道具的單位立方:標了 `userData.shared`,所以 `disposeLanduseMeshes`
      // 放它一馬 —— strategy 是唯一能放掉它的人。
      luBoxGeo?.dispose();
      luBoxGeo = null;
      cloudWhiteMat?.dispose();
      cloudWhiteMat = null;
      cloudPaleMat?.dispose();
      cloudPaleMat = null;
      for (const tex of overlayTextures.values()) tex.dispose();
      overlayTextures.clear();
      for (const mat of signMats.values()) mat.dispose();
      signMats.clear();
    },
  };

  return strategy;
}

/** Coil geometry — see `buildCoilTreeGeometry`. Tuned so the tree ends up the
 *  same height and footprint the stacked-cuboid tree had (~7.1 m tall, ~4.4 m
 *  across), because street lamps, bushes and building skirts were all placed
 *  against that silhouette. */
const COIL_TURNS = 6.2;
const COIL_SEG = 62;
const COIL_RADIUS = 1.7;
const COIL_BASE_Y = 1.6;
/** Ribbon height. The top vertex sits at `COIL_BASE_Y + COIL_HEIGHT * (1 + rise)`,
 *  so this is 5.5 m of canopy divided back out by the one extra pitch the top
 *  band adds — solve it here or the tree grows half a metre taller than the one
 *  it replaces. */
const COIL_HEIGHT = 5.5 / (1 + 0.92 / COIL_TURNS);
const TRUNK_WIDTH = 0.9;
const TRUNK_HEIGHT = 2.4;

/**
 * The demo's `COIL_GREENS` and `trunkMat`, verbatim.
 *
 * NOT `TREE_CANOPY_COLORS` — those are the generic cartoon greens the default
 * cone-and-cylinder tree falls back to, and they used to live on a shelf named
 * `cartoon-materials.ts` that read as shared, so this world quietly wore
 * another world's palette. (That is the drift `world-boundary.ts` now watches
 * for, and why the greens below and the shelf itself both moved into this
 * world's own files.) The demo picked these three deliberately:
 * 「壓得比地形色帶深一階:地形是 #39e75f → #7ef59a 那條淡的斜坡,樹要沉下去才跟
 * 山分得開。毛根本來就比塑膠磚吃光(絨面不反射),深一點反而更對。」
 */
const COIL_GREENS = [0x1a7d35, 0x248f42, 0x2ea34f] as const;
const COIL_TRUNK_COLOR = 0xa06a35;

/**
 * Build one pipe-cleaner tree: a conical helix of fuzzy ribbon on a cuboid
 * trunk, vertex-coloured (trunk brown, canopy green).
 *
 * Why not the stacked-cuboid tree it replaces: this world states everything by
 * STACKING (terrain layers, matchbox towers, mountains, bricks), so a stacked
 * tree read as more terrain — swapping the colour does not help, the grammar
 * has to change. A coil is the one construction this world does not otherwise
 * use, and fuzz is the one surface (everything else is glossy plastic).
 *
 * The fuzz is a SILHOUETTE effect, not geometry: a tree is ~40 px tall at
 * riding distance, so a single bristle is subpixel. Jittering the ribbon's
 * outer edge radially is what makes the outline fuzzy; growing actual bristles
 * costs hundreds of faces you would never see.
 *
 * Cost: 124 ribbon triangles + 12 trunk ≈ 136, against the old tree's 48. It is
 * one InstancedMesh either way (one draw call per chunk, 300 trees max), and
 * the coil has no stud caps — which is where most of the old tree's budget went
 * once you counted the tiers.
 */
function buildCoilTreeGeometry(trunkColor: number, canopyColor: number): THREE.BufferGeometry {
  const trunk = new THREE.Color(trunkColor);
  const canopy = new THREE.Color(canopyColor);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // ── Canopy: the coil ──
  const pitch = 1 / COIL_TURNS;
  for (let i = 0; i <= COIL_SEG; i++) {
    const t = i / COIL_SEG;
    const a = t * COIL_TURNS * Math.PI * 2;
    const cone = 1 - t * 0.84;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // The radial wobble on the outer edge IS the fuzz. Two incommensurate
    // periods stacked, otherwise it degenerates into a regular saw edge.
    const fz = 0.19 + 0.11 * Math.sin(i * 2.7) + 0.07 * Math.sin(i * 5.3 + 1.1);
    // The ribbon has to be a whole pitch TALL or a see-through gap opens
    // between consecutive turns and the tree becomes a wire coil instead of a
    // pipe cleaner. Bristles are dense; the fuzz is what fills the gap.
    const rise = pitch * 0.92;
    const y0 = COIL_BASE_Y + t * COIL_HEIGHT;
    const y1 = COIL_BASE_Y + (t + rise) * COIL_HEIGHT;
    positions.push(ca * cone * 0.78 * COIL_RADIUS, y0, sa * cone * 0.78 * COIL_RADIUS);
    positions.push(ca * (cone + fz) * COIL_RADIUS, y1, sa * (cone + fz) * COIL_RADIUS);
    // Normals are written by hand as outward-and-up. `computeVertexNormals()`
    // is WRONG here for two reasons: (1) a thin ribbon's face normals mostly
    // point straight up or straight down, so half the turns would shade dark;
    // (2) the tree material is DoubleSide — three flips the normal for back
    // faces inside the shader, but the headless rasteriser does not, so an
    // auto-computed normal makes the browser and the probe disagree, which is
    // the worst outcome (neither can be trusted). Outward-and-up is also how
    // real fuzz catches light: the bristles stand up.
    const ny = 0.55;
    const k = Math.hypot(1, ny);
    for (let v = 0; v < 2; v++) normals.push(ca / k, ny / k, sa / k);
    for (let v = 0; v < 2; v++) colors.push(canopy.r, canopy.g, canopy.b);
    if (i < COIL_SEG) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }

  // ── Trunk ──
  // A pipe cleaner tree is made by twisting one stem into a trunk and winding a
  // second one round it, so the trunk is fuzzy too — just a shade darker. Its
  // top is buried inside the first turn of the coil, so only the bare stub
  // under the canopy is ever seen.
  const box = new THREE.BoxGeometry(TRUNK_WIDTH, TRUNK_HEIGHT, TRUNK_WIDTH);
  box.translate(0, TRUNK_HEIGHT / 2, 0);
  const ng = box.toNonIndexed();
  const bPos = ng.attributes.position.array as ArrayLike<number>;
  const bNrm = ng.attributes.normal.array as ArrayLike<number>;
  const base = positions.length / 3;
  const vCount = ng.attributes.position.count;
  for (let i = 0; i < vCount * 3; i++) {
    positions.push(bPos[i]);
    normals.push(bNrm[i]);
  }
  for (let v = 0; v < vCount; v++) {
    colors.push(trunk.r, trunk.g, trunk.b);
    indices.push(base + v);
  }
  ng.dispose();
  box.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** One slab of the stacking tower. */
interface Slab {
  w: number; h: number; d: number;
  x: number; y: number; z: number;
  color: number;
  /** Yaw: the layer's own small crookedness plus, for an ejected slab, its
   *  spin. Both are yaws about +y, so the demo adds them and so does this. */
  rotY?: number;
  /** The tower's inner core — buried behind the layers, never a window. */
  core?: boolean;
  /** True when the slab runs along local +x, so its SHORT faces are the ±x
   *  ends. Every second layer flips this; that alternation is what leaves a
   *  square end exposed on one pair of walls per layer. */
  alongX?: boolean;
}

/**
 * The stacking tower's slab layout.
 *
 * Split out of `buildBuildingBody` because the LIGHTS have to come from the
 * same place as the SHAPE (DEVPLAN「決定形體的那個東西,必須同時決定燈」). The
 * tower's windows are the square short faces that every second layer leaves
 * exposed — there is nothing to place them on unless you know where the slabs
 * ended up, and recomputing the layout in a second function is how the two
 * quietly drift apart.
 *
 * Deterministic in `seed` alone: both callers build their own RNG from the same
 * seed and replay the same sequence, so asking for the lights cannot perturb
 * the shape.
 */
function plasticTowerSlabs(box: BuildingBox, seed: number): Slab[] {
  // ── The one adaptation: the demo's `layers` argument, from the box ──
  // `makeBuilding` calls `stackHouse(10, 10, 8, ci)`. Everything below this
  // block is that function transcribed; `w`, `d` and `layers` are the only
  // things it was ever told, and they are the only things derived here.
  //
  // `LAYER_H` is a TARGET rather than the literal thickness, because a body has
  // to end exactly at `box.height` (the sign, the lights and the roof trim all
  // hang off that number). Rounding to whole layers puts the effective
  // thickness within ±13 % of the demo's 2.3 m at the worst case and much
  // closer usually, and `SLAB_GAP` stays the demo's literal 0.16 — a seam is a
  // seam at any storey height.
  const layers = Math.max(1, Math.round(box.height / LAYER_H));
  const layerH = box.height / layers;
  const gap = SLAB_GAP;
  const rng = mulberry32(seed * 9176 + layers * 31 + 7);

  const slabs: Slab[] = [];
  // Core: a removed slab leaves a slot clean through the tower — without a
  // core you see the sky through the building. The demo's `w - 2.4` is kept
  // literally; `Math.max(1, …)` is a guard the demo never needed because its
  // house is 10 m wide and MVT hands us 2.5 m slivers.
  const coreH = box.height + box.skirt - gap;
  slabs.push({
    w: Math.max(1, box.width - 2.4), h: coreH, d: Math.max(1, box.depth - 2.4),
    x: 0, y: coreH / 2 - box.skirt, z: 0,
    color: deepen(BRICK_COLORS[seed % BRICK_COLORS.length], 0.55),
  });

  // Three colours per building, not all six — a whole street of rainbows
  // stops reading as individual buildings.
  const palette = [
    BRICK_COLORS[seed % BRICK_COLORS.length],
    BRICK_COLORS[(seed + 2) % BRICK_COLORS.length],
    BRICK_COLORS[(seed + 4) % BRICK_COLORS.length],
  ];
  const loose: number[] = [];

  for (let i = 0; i < layers; i++) {
    const alongX = i % 2 === 0;
    const span = alongX ? box.depth : box.width;
    const n = Math.max(2, Math.min(4, Math.round(span / 3.2)));
    const color = palette[i % palette.length];
    // The top layer stays whole: breaching it opens a hole in the ROOF, and
    // on a squat building one slab of three is a third of the core on show.
    // Removal is middle-layers-only too — a gutted bottom layer reads as
    // the foundations having vanished. The "someone played with this" note
    // is carried by the slabs restacked on top.
    const canRemove = i > 0 && i < layers - 1;
    // ⚠ DEVIATION FROM THE DEMO, and the only one in this body. The demo allows
    // `i < layers - 1`, GROUND FLOOR INCLUDED. A slab ejected downstairs juts
    // up to `MAX_PULL` = 3.2 m sideways with its underside ON THE ROAD, and
    // that is the overhang class the route-clearance sweep flagged (every
    // remaining violation sat at y = 1.8 m or below). So `i > 0`, and no more
    // than that: this used to add `i * layerH >= 3`, written when `layerH` was
    // `box.height / layers` and a squat house's middle layer really did start
    // at knee height. At the demo's fixed 2.3 m `LAYER_H` the first ejectable
    // layer's underside is 2.3 m — above everything the sweep found — so the
    // extra clause now only deletes slabs the demo puts there, and moves the
    // whole rng stream while doing it.
    const canPull = i > 0 && i < layers - 1;
    // A layer is one small yaw. The demo carried it on a `layerGrp`; there are
    // no parent nodes here, so it is multiplied into each slab's position and
    // its own spin (both are yaws, so they add). WITHOUT THIS the tower is
    // machined square, which is the single loudest difference between the demo
    // tower and the one this file used to build: it is hand-stacked, and a
    // hand-stacked thing is never aligned.
    const layerRot = (rng() - 0.5) * 0.05;
    const cosL = Math.cos(layerRot);
    const sinL = Math.sin(layerRot);
    const slabT = span / n - gap;
    const slabL = alongX ? box.width : box.depth;
    // The bottom layer swallows the skirt, so it is taller and sits lower —
    // the buried part is what stops a block straddling two terrain treads
    // from showing a floating edge.
    const thisH = (i === 0 ? layerH + box.skirt : layerH) - gap;
    const layerY = i === 0
      ? (layerH - box.skirt) / 2
      : i * layerH + layerH / 2;

    for (let k = 0; k < n; k++) {
      const roll = rng();
      if (canRemove && roll < 0.16) { loose.push(color); continue; }
      const off = -span / 2 + (k + 0.5) * (span / n);
      const pull = canPull && roll > 0.86
        ? Math.min(MAX_PULL, (0.22 + rng() * 0.22) * slabL)
        : 0;
      const lx = alongX ? pull : off;
      const lz = alongX ? off : pull;
      const spin = pull ? (rng() - 0.5) * 0.06 : 0;
      slabs.push({
        w: alongX ? slabL : slabT, h: thisH, d: alongX ? slabT : slabL,
        x: lx * cosL + lz * sinL, y: layerY, z: -lx * sinL + lz * cosL,
        rotY: layerRot + spin,
        color, alongX,
      });
    }
  }

  // Whatever was pulled out, restacked crooked on the roof — which also
  // happens to be what every Taipei rooftop looks like. The demo's `min(2, …)`
  // is restored: this file used to drop to one on buildings under 18 m because
  // a layer was then a third of the house, and at the demo's 2.3 m target a
  // layer is a third of nothing.
  let topY = box.height;
  for (let t = 0; t < Math.min(2, loose.length); t++) {
    const alongX = (layers + t) % 2 === 0;
    const span = alongX ? box.depth : box.width;
    const n = Math.max(2, Math.min(4, Math.round(span / 3.2)));
    const slabT = span / n - gap;
    const slabL = alongX ? box.width : box.depth;
    const jitter = (rng() - 0.5) * span * 0.3;
    const spin = (rng() - 0.5) * 0.12;
    slabs.push({
      w: alongX ? slabL : slabT, h: layerH - gap, d: alongX ? slabT : slabL,
      x: alongX ? 0 : jitter, y: topY + layerH / 2, z: alongX ? jitter : 0,
      rotY: spin,
      color: loose[t], alongX,
    });
    topY += layerH;
  }

  return slabs;
}

// ════════════════════════════════════════════════════════════════════════════
// Zone buildings — five outlines, five feels
// ════════════════════════════════════════════════════════════════════════════
//
// Ported from `plan/plastic-town-demo.html`, which is the spec:
//
//   residential  clay pixel house   gable, matte, hand-pressed lumps
//   commercial   stacking tower     tall box, coloured bands  (already here)
//   industrial   cup tower          trapezoid taper, translucent walls
//   school       letter blocks      low WIDE row, embossed letters, hard gloss
//   hospital     domino wall        ivory plates on edge, pips, red triangle
//
// The demo's rule, and the reason there are five and not three: a collision of
// FEEL is harder to spot than a collision of OUTLINE, and this world's first
// draft had two hard-gloss plastic buildings that read as one thing at two
// sizes. So the five differ in material as well as silhouette.
//
// **What does not survive the port, stated plainly.** `building-renderer` merges
// every body in a chunk into ONE mesh with ONE vertex-coloured toon material —
// that is what makes 800 buildings affordable. A body therefore cannot carry a
// material of its own, so four of the five feels (matte clay, glossy candy,
// translucent, glazed white) arrive as OUTLINE + COLOUR only. Where a feel is
// the whole identity of the building it moves into `buildBuildingDecoration`,
// which does keep its own materials: the letter blocks' hard-gloss embossed
// letters, the domino's ink pips, the cup tower's translucent walls. Everything
// else would cost a second draw call per material to say something the toon
// shader cannot say anyway.
//
// **Scaling.** The demo's five are fixed-size props (a 15 m house, a 9.4 m cup
// tower); here each one has to fill an arbitrary MVT box, 5 m to 145 m. Tiling a
// fixed unit does not work — a 40 m domino wall of 6 m plates is a picket fence.
// So every type derives its UNIT from the box while keeping its own proportion:
// a domino is always ~2.3× as tall as it is wide, a letter block is always
// roughly cubic, a cup is always a cup. A tall building gets bigger units, not
// more of them, which also bounds the triangle count on the tallest footprints.

/** The five bodies this style can build. */
type PlasticBuildingKind = 'stack' | 'clay' | 'cup' | 'alphabet' | 'domino';

/**
 * Floor on the height a body sizes itself from. MEASURED, not defensive.
 *
 * Every one of the demo's five builders scales a fixed prop by the height and
 * then counts units across the footprint at the scaled pitch. The demo's own
 * props are 6–18 m tall, so it never had to think about the divisor; the saved
 * Taipei route hands us `box.height` of exactly **0.0** (the minimum over 1 000
 * bodies), which makes the pitch zero and `Math.round(width / 0)` INFINITE.
 * That is not a slow build, it is a `RangeError`-free 4 GB heap exhaustion
 * inside chunk 2 — which is exactly how the first run of this port ended.
 *
 * One metre rather than a hair above zero because the count is `footprint /
 * (prop-pitch · height)`: at 0.1 m a 117 m industrial footprint still asks for
 * ~1 000 cups across.
 */
const MIN_BODY_HEIGHT = 1;

/**
 * Zone → body is a BIAS, not a mapping: 80 % the district's signature building,
 * 20 % one of two neighbouring types (the demo's own table). A street with one
 * or two outsiders on it reads as a city; a hard mapping reads as five blocks of
 * sample housing laid end to end.
 */
const ZONE_PLAN: Record<
  ZoneKind,
  { main: PlasticBuildingKind; near: readonly [PlasticBuildingKind, PlasticBuildingKind] }
> = {
  residential: { main: 'clay', near: ['stack', 'domino'] },
  commercial: { main: 'stack', near: ['alphabet', 'clay'] },
  industrial: { main: 'cup', near: ['stack', 'domino'] },
  school: { main: 'alphabet', near: ['clay', 'domino'] },
  hospital: { main: 'domino', near: ['stack', 'cup'] },
};

/**
 * Which body this footprint gets. Pure in `(seed, zone)` — deliberately NOT a
 * shuffle bag: a bag carries state between calls, so the body a footprint got
 * would depend on the order the chunk happened to visit its neighbours, and
 * `buildBuildingLights` (which has to re-derive the same answer) would get a
 * different one. Deterministic-in-seed is the contract `npm run check:3d`
 * pins with "lights: asking for them does not re-roll the shape".
 *
 * An UNZONED footprint keeps the stacking tower. Not residential: `zoneAt`
 * returns null for everything outside a landuse polygon, which is most of a
 * real route, and reading that as housing turns a rural road into a suburb
 * (building-renderer says so where it calls this).
 */
function plasticBuildingKind(
  seed: number,
  zone: ZoneKind | null | undefined,
): PlasticBuildingKind {
  if (!zone) return 'stack';
  const plan = ZONE_PLAN[zone];
  // Its own stream. Sharing the tower's (`seed * 9176 + 7`) would tie which
  // slabs get pulled out to which building type was rolled.
  const rng = mulberry32(seed * 26417 + 601);
  if (rng() < 0.8) return plan.main;
  return plan.near[rng() < 0.5 ? 0 : 1];
}

/**
 * The parts one body is made of.
 *
 * ONE function behind both `buildBuildingBody` and `buildBuildingBoxes`. The
 * renderer instances what comes back here, so if these two answers could ever
 * disagree, a building would change shape depending on which hook the renderer
 * reached for — the exact failure the `buildBuildingBoxes` contract warns about,
 * and one that would be invisible until someone compared two chunks side by
 * side.
 *
 * All five answer. The cup tower used to answer null (its cups are cones, and
 * `BoxPart` only spoke boxes), which put ~420 buildings of a dense Taipei chunk
 * back on the merge path and cost more than the 14 000 boxes of the other four
 * body types put together. A cup's taper is the constant 0.7, so one unit cone
 * covers every cup in the world — that is what `shape: 'cone'` is.
 */
function plasticBodyBoxes(
  box: BuildingBox,
  seed: number,
  zone: ZoneKind | null | undefined,
): ColoredBox[] {
  switch (plasticBuildingKind(seed, zone)) {
    case 'clay': return clayHouseLayout(box, seed).voxels;
    case 'alphabet': return alphabetBlocksLayout(box, seed).boxes;
    case 'domino': return dominoWallLayout(box, seed).boxes;
    case 'cup': return cupTowerParts(box, seed);
    default: return plasticTowerSlabs(box, seed);
  }
}

/** Give a geometry flat vertex colours so it can join a `buildColoredBoxes`
 *  merge (uv dropped — the merged building material has no map). */
function paintGeometry(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  const c = new THREE.Color(color);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// ── Residential: the clay pixel house ───────────────────────────────────────
//
// Hand-pressed clay cubes stacked into a house with a gabled top. The clay is
// carried by four things, and dropping any one of them turns it back into a
// brick stack:
//  · MATTE — the shared building material is already toon with no specular, so
//    this one comes free here and is the largest single vote.
//  · PALE  — clay dries a shade lighter, so the candy palette is pulled 34 %
//    toward white. The tower next door uses the same palette raw.
//  · NO TWO ALIKE — size, yaw and position all jitter per voxel.
//  · PRESSED TOGETHER — the voxels are drawn LARGER than their pitch, so the
//    seams are squash marks. Leave a gap and it reads as toy bricks instantly.
//
// Shell only: an interior voxel is never visible and costs 12 triangles to
// prove it. The shell stays closed, so the body is solid — a hollow one punches
// a hole in the dusk skyline, which is what got the demo's card house replaced.

/**
 * The demo's `CLAY_CUBE`, and the pitch it lays cubes at.
 *
 * `SP = S * 0.94` is load-bearing and is the demo's fourth clay rule: the pitch
 * is SMALLER than the cube, so neighbours press into each other and the seam is
 * a squash mark. Leave a gap and it reads as toy bricks instantly — the demo
 * says so in as many words.
 */
const CLAY_CUBE = 3.2;
const CLAY_PITCH_RATIO = 0.94;

interface ClayLayout {
  voxels: ColoredBox[];
  /** The recoloured window voxels' faces, as light quads (see the note where
   *  they are pushed). */
  windows: WindowPlacement[];
}

/**
 * The clay house's voxels, windows included — because in this body the windows
 * ARE voxels. §3.9 from the near side: the pass that decides which lump is the
 * yellow one is the pass that decides which lump glows, so the two cannot be
 * re-derived apart. The window lumps come out carrying `lit: 'clayWindow'`.
 */
function clayHouseLayout(box: BuildingBox, seed: number): ClayLayout {
  // ── The one adaptation: the demo's (w, d, bodyFloors), from the box ──
  // `makeBuilding` calls `clayHouse(15, 10, 3, ci)`. `nx`/`nz` are the demo's
  // own formulas on `box.width`/`box.depth`; the course count is the same
  // formula on the height, which the demo took as an argument instead.
  //
  // The demo lays a FIXED 3.2 m cube at a 0.94 pitch, so its house comes out
  // whatever size `nx * SP` happens to be. A body has to fill the footprint it
  // was given, so the cube is resized per axis to make `nx` of them span the
  // box exactly — the demo's 0.94 overlap and every jitter written as a
  // fraction of it are preserved, which is what the four clay rules actually
  // depend on. `k` carries the demo's absolute jitters (0.34 m, 0.22 m, tuned
  // against a 3.2 m cube) onto whatever the cube ends up being.
  const nx = Math.max(3, Math.round(box.width / CLAY_CUBE));
  const nz = Math.max(2, Math.round(box.depth / CLAY_CUBE));
  const total = Math.max(2, Math.round((box.height + box.skirt) / (CLAY_CUBE * CLAY_PITCH_RATIO)));
  const roofLayers = Math.min(total - 1, Math.max(1, Math.min(2, Math.floor((nx - 1) / 2))));
  const bodyFloors = total - roofLayers;
  // The demo's stream, key and all: `mulberry32(ci * 6151 + bodyFloors * 29 + 5)`.
  // The `bodyFloors` term matters — drop it and two houses of different heights
  // on the same seed get the SAME jitter sequence, which is visible on a street
  // where the same footprint repeats.
  const rng = mulberry32(seed * 6151 + bodyFloors * 29 + 5);

  const spx = box.width / nx;
  const spz = box.depth / nz;
  const spy = (box.height + box.skirt) / total;
  // The demo's cube:pitch ratio, per axis. `S` is the size a voxel would be at
  // its nominal scale; the per-voxel `0.94 + rng()*0.13` roll rides on top,
  // exactly as in the demo.
  const sx = spx / CLAY_PITCH_RATIO;
  const sy = spy / CLAY_PITCH_RATIO;
  const sz = spz / CLAY_PITCH_RATIO;
  const k = Math.min(sx, sz) / CLAY_CUBE;
  const body = brighten(BRICK_COLORS[seed % BRICK_COLORS.length], CLAY_LIGHTEN);
  const roof = brighten(BRICK_COLORS[(seed + 3) % BRICK_COLORS.length], CLAY_LIGHTEN);

  const doorIx = Math.floor(nx / 2);
  const voxels: ColoredBox[] = [];
  const windows: WindowPlacement[] = [];

  for (let iy = 0; iy < total; iy++) {
    // Each roof course pulls in one voxel on both x ends → a gable. z stays
    // full so the ridge has a direction; a pyramid would read as a tent.
    const inset = Math.max(0, iy - bodyFloors + 1);
    const x0 = inset;
    const x1 = nx - 1 - inset;
    if (x1 < x0) break;
    const isRoof = iy >= bodyFloors;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        // The demo's shell test, restored in full. This file had trimmed it to
        // `iy === layers - 1`, dropping `iy === 0` and `isRoof` — which is a
        // hole in the FLOOR of a house standing on a slope (the skirt is what
        // the ground course is for) and a hollow gable.
        const shell = ix === x0 || ix === x1 || iz === 0 || iz === nz - 1
          || iy === 0 || iy === total - 1 || isRoof;
        if (!shell) continue;
        let color = isRoof ? roof : body;
        let lit = false;
        // Door: one ground-floor voxel of the front face recoloured. Never a
        // hole — a hole stops it being a solid volume.
        //
        // Brightened like every other clay colour: the demo paints EVERY voxel
        // through `clayMat` = `toonShared(brightenHex(hex, 0.34))`, door and
        // window included, so the dried-clay shift is a property of the
        // material and not of the palette entry. This file used to apply it to
        // the body and roof only, which left a raw brown door on a pale house.
        if (iy === 0 && iz === nz - 1 && ix === doorIx) {
          color = brighten(CLAY_DOOR_COLOR, CLAY_LIGHTEN);
        // Windows: two voxels on each of the front and back faces of the
        // second course, RECOLOURED. A pixel house's window always was a
        // colour change rather than a cut-out, and at night that same voxel is
        // what lights up.
        } else if (iy === 1 && (iz === 0 || iz === nz - 1)
          && (ix === x0 + 1 || ix === x1 - 1)) {
          color = brighten(CLAY_WINDOW_COLOR, CLAY_LIGHTEN);
          lit = true;
        }
        // ⚠ THE DRAW ORDER IS THE DEMO'S — x, y, z, scale, then the three
        // tilts, exactly as `put()` pushes them, and EVERY draw happens on
        // every voxel. Reordering them or skipping one (this file computed the
        // scale first, and skipped the y jitter on the ground course) does not
        // change any single lump's rule; it re-rolls every lump after it, so
        // the whole house comes out different while every line still reads
        // correctly. That is the failure mode this ordering exists to avoid.
        const jx = (rng() - 0.5) * 0.34 * k;
        const jy = (rng() - 0.5) * 0.22 * k;
        const jz = (rng() - 0.5) * 0.34 * k;
        // Uniform, like the demo's `S * (0.94 + rng() * 0.13)`: a lump pressed
        // out of shape is still one lump, not a slab.
        const grow = CLAY_PITCH_RATIO + rng() * 0.13;
        // THREE axes, which is the demo's `e.set((rng()-.5)*0.13,
        // (rng()-.5)*0.5, (rng()-.5)*0.13)`. This file used to keep the yaw
        // and drop the two tilts, and a lump that only yaws sits dead level:
        // the course snaps back into a line and the house reads as the brick
        // stack next door. It is one of the four things the demo says the clay
        // IS, and it is the reason `BoxPart` has `rotX`/`rotZ` at all.
        const rotX = (rng() - 0.5) * 0.13;
        const rotY = (rng() - 0.5) * 0.5;
        const rotZ = (rng() - 0.5) * 0.13;

        const w = sx * grow;
        const h = sy * grow;
        const d = sz * grow;
        const x = (ix - (nx - 1) / 2) * spx + jx;
        // The demo stacks from y = 0 (`iy * SP + S / 2`); here the ground
        // course starts at −skirt so a house straddling two terrain treads
        // never shows a floating edge. The ground course is PINNED for the
        // same reason — everywhere else the demo's 0.22 m jitter is free.
        const y = iy === 0
          ? -box.skirt + h / 2
          : -box.skirt + iy * spy + sy / 2 + jy;
        const z = (iz - (nz - 1) / 2) * spz + jz;
        voxels.push({ w, h, d, x, y, z, color, rotX, rotY, rotZ, shape: 'clayCube' });
        if (lit) {
          // The demo lights the VOXEL (`glowAtNight(clayMat(CLAY_WIN_HEX),
          // '#ffd049', 0.85)`), which cannot be done here: every body in a chunk
          // is one InstancedMesh per shape over ONE vertex-coloured material, so
          // a single lump with its own emissive would be a second material and
          // therefore a second batch. So it is a film on the face of that same
          // lump — SIZED TO THAT FACE, out of the same pass that decided where
          // the yellow lump goes. That is the part the retired facade grid could
          // never do; the carrier is the only thing that differs from the demo.
          const out = iz === 0 ? -1 : 1;
          windows.push({
            x, y, z: z + out * (d / 2 + 0.06),
            rotY: out > 0 ? 0 : Math.PI,
            w: w * 0.86, h: h * 0.86,
          });
        }
      }
    }
  }
  return { voxels, windows };
}

// ── Industrial: the cup tower ───────────────────────────────────────────────
//
// The third silhouette in the skyline: a TRAPEZOID. A grid of moulded cups per
// storey, a white plate between storeys, and one fewer cup per side as it goes
// up. Without the plate the cups sit rim-on-base and the whole thing reads as a
// fluted column instead of something stacked.
//
// Translucency is the feel, and it is the one that cannot live in the body (see
// the note at the top of this section), so the cup WALLS are decoration with
// their own see-through material, and the body holds a smaller solid cone
// inside each one — the drink in the cup. That inner cone is what keeps the
// volume solid: an array of open shells would be a hole in the skyline at dusk.

/** How much of the cup the solid cone inside it fills. Below ~0.8 the cup reads
 *  as empty and the wall has nothing to be translucent against. */
const CUP_FILL = 0.86;

interface CupTowerLayout {
  // Only the TOP radius. The bottom is `rTop * CUP_R_BOTTOM / CUP_R_TOP`
  // wherever it is needed, and storing it would be storing the same number
  // twice: the wall and the solid inside it would then be free to taper
  // differently, and the solid would poke out through its own translucent cup.
  // Derived from the demo's two radii in both places, the wall is wider than
  // the solid by exactly `CUP_FILL` at every height.
  cups: { x: number; y: number; z: number; rTop: number; h: number; color: number }[];
  plates: ColoredBox[];
}

function cupTowerLayout(box: BuildingBox, seed: number): CupTowerLayout {
  // ── The one adaptation: the demo's (w, d, levels), from the box ──
  // `makeBuilding` calls `cupTower(13, 9, 3, ci)`. One storey is one cup plus
  // one shelf, `CUP_HEIGHT + CUP_PLATE_THICKNESS` = 3.22 m in the demo, so the
  // storey count is the height over that and `k` is what is left over — the
  // cup, the pitch and the shelf all scale by the SAME `k`, so a cup is a cup
  // at any building height instead of a differently-proportioned vessel.
  //
  // Everything else is the demo's, in particular the two numbers this file had
  // re-derived: the grid is `round(w / 3.5) - L` per storey (uncapped: fixed
  // pitch and a shrinking count is what MAKES the trapezoid), and the pitch is
  // the literal 3.5 m rather than a cell size read off the footprint.
  const storeyH = CUP_HEIGHT + CUP_PLATE_THICKNESS;
  const usableH = Math.max(MIN_BODY_HEIGHT, box.height);
  // `levels` cups and `levels - 1` shelves, which is the demo's own stack — so
  // at the demo's own 9.44 m this comes out at exactly 3 storeys and k = 1, and
  // the port reproduces `cupTower(13, 9, 3)` part for part.
  const levels = Math.max(1, Math.round(
    (usableH + CUP_PLATE_THICKNESS) / storeyH));
  const k = usableH / (levels * CUP_HEIGHT + (levels - 1) * CUP_PLATE_THICKNESS);
  const rng = mulberry32(seed * 7717 + levels * 23 + 11);
  const pitch = CUP_PITCH * k;
  const cupH = CUP_HEIGHT * k;
  const plateT = CUP_PLATE_THICKNESS * k;
  const rTop = CUP_R_TOP * k;

  const cups: CupTowerLayout['cups'] = [];
  // The skirt as ONE buried box rather than by stretching the ground storey's
  // cups down into it.
  //
  // Stretching them was what this used to do, and it cost the whole port: a
  // stretched cup pokes out below y = 0, so its translucent wall has to be CUT
  // at ground level, so the ground storey — which is the WIDEST storey — is the
  // one storey whose walls cannot share the unit cup. Measured on the saved
  // Taipei route: 16 347 of 64 801 cup walls were cut, and merging them was
  // 913 ms against 23 ms for every cup-tower body part in the same run.
  //
  // A buried box does the job the skirt exists for (a footprint straddling two
  // terrain treads must not show a floating edge) without any of that, and it
  // puts every cup in the world at y ≥ 0 — which is where the demo's are.
  const plates: ColoredBox[] = [{
    w: box.width, h: box.skirt, d: box.depth,
    x: 0, y: -box.skirt / 2, z: 0,
    color: deepen(BRICK_COLORS[seed % BRICK_COLORS.length], 0.55),
  }];
  let y = 0;
  for (let L = 0; L < levels; L++) {
    // The demo's `Math.round(w / 3.5) - L`, with a ceiling AT THE DEMO'S OWN
    // GRID — `cupTower(13, 9, 3)` works out to 4 columns by 3 rows, so no
    // industrial block gets a bigger tray than the one the demo drew, and at
    // the demo's own footprint the ceiling does not bind and the tower is
    // reproduced cup for cup (`npm run check:3d` asserts exactly that).
    //
    // MEASURED, on the saved Taipei route (423 cup towers, 546 industrial
    // footprints in chunk 2 alone). Uncapped, the demo's rule asks for 65 252
    // cups — 4 199 on the single 83 × 61 m block — and 18.15 M triangles, which
    // is 33× the whole scene's triangle count before this port and far outside
    // the range where the N100 data says triangles are free (that data spans
    // 79–231 draw calls at ~0.6 M triangles). At the demo's own grid it is
    // 9 782 cups and 2.84 M triangles. Fifteen million triangles is a cost;
    // this is the reduction that buys it, and it is the only cap in this file
    // that is not the demo's own number.
    const cols = Math.max(1, Math.min(CUP_MAX_COLS, Math.round(box.width / pitch)) - L);
    const rows = Math.max(1,
      Math.min(CUP_MAX_ROWS, Math.round(box.depth / pitch)) - (L > 0 ? 1 : 0));
    const color = BRICK_COLORS[(seed + L) % BRICK_COLORS.length];
    const base = y;
    const h = cupH;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cups.push({
          // The demo's `(rng() - 0.5) * 0.25`, in units of its own 3.5 m pitch.
          x: -((cols - 1) * pitch) / 2 + c * pitch + (rng() - 0.5) * 0.25 * k,
          y: base + h / 2,
          z: -((rows - 1) * pitch) / 2 + r * pitch + (rng() - 0.5) * 0.25 * k,
          rTop, h, color,
        });
      }
    }
    y += cupH;
    if (L < levels - 1) {
      // The demo's shelf: a ROUND plate (`CylinderGeometry(1, 1, 0.22, 20)`)
      // scaled `cols * 1.9` by `rows * 1.9` on a unit RADIUS — so its
      // DIAMETERS are `cols * 3.8` and `rows * 3.8`, at the demo's pitch. This
      // file had it as a box sized to the storey above; a rectangular shelf
      // under a round grid of cups is a different object.
      plates.push({
        w: Math.max(cols, 1) * 3.8 * k,
        h: plateT,
        d: Math.max(rows, 1) * 3.8 * k,
        x: 0, y: y + plateT / 2, z: 0,
        color: CUP_PLATE_COLOR,
        shape: 'plate',
      });
      y += plateT;
    }
  }
  return { cups, plates };
}

/**
 * The cup tower as instanceable parts: the shelf discs (`shape: 'plate'`), then
 * the solid inside each cup (`shape: 'cup'`).
 *
 * Plates FIRST, cups after, and that order is load-bearing — it is the order the
 * renderer fills its batches in and the order `buildBodyGeometry` writes
 * vertices in, so the two paths can be compared part by part.
 *
 * A part carries no taper of its own (see `BoxPart`), which is exactly why this
 * works: every cup in the world is the SAME frustum, at the demo's 1.12/1.62,
 * because the layout stores only `rTop` and the shape lives in one template. If
 * that ever becomes a per-tower roll, cups stop being instanceable and the tower
 * goes back on the merge path — said here rather than left to be rediscovered.
 */
function cupTowerParts(box: BuildingBox, seed: number): ColoredBox[] {
  const lay = cupTowerLayout(box, seed);
  const parts: ColoredBox[] = [...lay.plates];
  for (const c of lay.cups) {
    const dia = 2 * c.rTop * CUP_FILL;
    parts.push({
      w: dia, h: c.h, d: dia,
      x: c.x, y: c.y, z: c.z,
      // The drink is a shade darker than the cup around it.
      color: deepen(c.color, 0.22),
      shape: 'cup',
    });
  }
  return parts;
}

// ── School: the letter blocks ───────────────────────────────────────────────
//
// Moulded cubes with a letter on each visible face, laid out as a LOW WIDE row.
// Deliberately not stacked high — the clay house already owns "cubes piled up",
// and a second pile is a collision. Three things keep them apart, and it takes
// all three:
//  · HARD GLOSS on the letters (Phong, shininess 150) against clay's matte.
//    ⚠ the headless probe does not compute specular, so this one cannot be
//    checked from a PNG — only from the code.
//  · SQUARE CORNERS and no yaw to speak of, against clay's pressed lumps.
//  · The letters themselves.
//
// Letters are the demo's OWN `LETTERS` table, below — never a system font (it
// blurs at riding distance and every machine picks a different fallback, 法則
// 3.7). Single letters, never spelling a word: a moulded alphabet block is a
// generic toy, a word on one is somebody's packaging.
//
// ⚠ This used to borrow `sign-spec.ts`'s `SIGN_GLYPHS` through
// `signStrokes(1, 1, ch)`, with a comment about only admitting straight-stroke
// glyphs to keep the triangle count down. That was a re-derivation, and it is
// the same mistake the 2D side had already been caught making and had already
// backed out of (see `plastic-style.ts`'s `LETTER_STROKES` docstring). It cost
// three things at once:
//  · the SHAPES were the sign font's, not the letter block's;
//  · the cap height was `signStrokes`' 0.62 against the demo's 0.92, and the
//    stroke width its 0.17·cap = 0.105 against the demo's `LTR_T` = 0.15, so
//    every letter was two thirds the size and two thirds the weight;
//  · the alphabet was 15 straight-stroke letters instead of the demo's 26 —
//    the demo went to the trouble of drawing arcs out of short bars precisely
//    so a block could carry a B, an O or an S.
// Sharing was never a saving anyway: `SIGN_GLYPHS` is the CROSS-WORLD part
// (every sign in every world must letter identically), so it can never be
// edited for this building's convenience, and this table can never be edited
// for a sign's. Two fonts, on purpose — exactly as the 2D pair are.

/**
 * The demo's letter block: `ABC_S` on a side, standing on an `ABC_PLINTH`-thick
 * bar, laid at a pitch of `ABC_S + 0.5`. `ABC_PROP_H` is the whole prop's
 * height, which is what a storey of it costs.
 */
const ABC_S = 5.2;
const ABC_PLINTH = 0.9;
const ABC_PROP_H = ABC_PLINTH + ABC_S;

/** Emboss depth as a fraction of the block edge. The demo's `S * 0.075` on a
 *  5.2 m cube = 0.39 m — deep enough that the step still throws a shadow at
 *  riding distance. */
const ABC_EMBOSS = 0.075;
/** Smallest letter worth drawing, in metres of cap height. See the placement
 *  loop: this is the floor the demo's formula does not have. */
const ABC_MIN_LETTER = 1e-3;

// ── Geometric letters (for the alphabet blocks) — the demo's, verbatim ──────
// Straight bars plus arcs made of short bars, all of it drawn by hand. Unit
// glyph frame 1×1 (x, y ∈ ±0.5), thickness growing along +z from 0 to `LTR_E`,
// so setting one down IS the emboss.
const LTR_T = 0.15;   // stroke width
const LTR_E = 0.09;   // emboss depth, in the unit frame — a placement rescales it

function ltrBar(x: number, y: number, w: number, h: number, rot: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, LTR_E);
  if (rot) g.rotateZ(rot);
  g.translate(x, y, LTR_E / 2);
  return g;
}
/** An arc = a string of short bars round a circle. NOT a `TorusGeometry`: a
 *  torus has a ROUND section, which would nail the emboss depth to the stroke
 *  width and would not meet a straight stroke flush. */
function ltrArc(cx: number, cy: number, r: number, a0: number, sweep: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const n = Math.max(3, Math.round(Math.abs(sweep) / 0.42));
  const step = sweep / n;
  const seg = 2 * r * Math.tan(Math.abs(step) / 2) + LTR_T * 0.5;  // chord + a little overlap
  for (let i = 0; i < n; i++) {
    const a = a0 + (i + 0.5) * step;
    // a bar's local +y rotated by `a` = the tangent at that point on the circle
    out.push(ltrBar(cx + Math.cos(a) * r, cy + Math.sin(a) * r, LTR_T, seg, a));
  }
  return out;
}

const _PI = Math.PI;
/**
 * A–Z, then 0–9. The demo's table and the demo's ORDER — `LETTER_KEYS` below is
 * an index into it, so re-sorting the keys silently re-letters every school.
 *
 * ⚠ `rotateZ` with a POSITIVE angle pushes a bar's TOP end toward −x (three's
 * `makeRotationZ` is [cos, −sin; sin, cos]). A's two legs were once +0.30 /
 * −0.30 and came out wide at the top — a V with a crossbar. Same sign trap in
 * Z (its diagonal runs top-right to bottom-left, so a negative angle), in 2/4/7,
 * and in Q's tail. Every one of these is a comment in the demo because every one
 * of them was drawn backwards once.
 */
const LETTERS: Record<string, () => THREE.BufferGeometry[]> = {
  A: () => [ltrBar(-0.15, 0, LTR_T, 0.92, -0.30), ltrBar(0.15, 0, LTR_T, 0.92, 0.30), ltrBar(0, -0.10, 0.32, LTR_T, 0)],
  B: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ...ltrArc(-0.28, 0.23, 0.22, -_PI / 2, _PI), ...ltrArc(-0.28, -0.23, 0.24, -_PI / 2, _PI)],
  C: () => ltrArc(0, 0, 0.34, 0.42 * _PI, 1.16 * _PI),
  D: () => [ltrBar(-0.30, 0, LTR_T, 0.92, 0), ...ltrArc(-0.30, 0, 0.46, -_PI / 2, _PI)],
  E: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ltrBar(-0.04, 0.385, 0.48, LTR_T, 0), ltrBar(-0.08, 0, 0.40, LTR_T, 0), ltrBar(-0.04, -0.385, 0.48, LTR_T, 0)],
  H: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ltrBar(0.28, 0, LTR_T, 0.92, 0), ltrBar(0, 0, 0.56, LTR_T, 0)],
  I: () => [ltrBar(0, 0, LTR_T, 0.92, 0), ltrBar(0, 0.42, 0.44, LTR_T, 0), ltrBar(0, -0.42, 0.44, LTR_T, 0)],
  L: () => [ltrBar(-0.24, 0, LTR_T, 0.92, 0), ltrBar(0, -0.385, 0.48, LTR_T, 0)],
  O: () => ltrArc(0, 0, 0.34, 0, 2 * _PI),
  T: () => [ltrBar(0, 0.40, 0.66, LTR_T, 0), ltrBar(0, -0.04, LTR_T, 0.80, 0)],
  U: () => [ltrBar(-0.30, 0.16, LTR_T, 0.60, 0), ltrBar(0.30, 0.16, LTR_T, 0.60, 0), ...ltrArc(0, -0.16, 0.30, _PI, _PI)],
  X: () => [ltrBar(0, 0, LTR_T, 0.98, 0.50), ltrBar(0, 0, LTR_T, 0.98, -0.50)],
  Z: () => [ltrBar(0, 0.40, 0.60, LTR_T, 0), ltrBar(0, -0.40, 0.60, LTR_T, 0), ltrBar(0, 0, LTR_T, 0.94, -0.72)],
};
Object.assign(LETTERS, {
  F: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ltrBar(-0.02, 0.39, 0.52, LTR_T, 0),
    ltrBar(-0.06, 0.02, 0.44, LTR_T, 0)],
  G: () => [...ltrArc(0, 0, 0.34, 0.42 * _PI, 1.16 * _PI),
    ltrBar(0.30, -0.09, LTR_T, 0.36, 0), ltrBar(0.16, -0.24, 0.34, LTR_T, 0)],
  J: () => [ltrBar(0.22, 0.16, LTR_T, 0.60, 0), ...ltrArc(0, -0.16, 0.24, 0, -_PI)],
  K: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0),
    ltrBar(0.04, 0.20, LTR_T, 0.56, -0.72), ltrBar(0.04, -0.20, LTR_T, 0.56, 0.72)],
  M: () => [ltrBar(-0.32, 0, LTR_T, 0.92, 0), ltrBar(0.32, 0, LTR_T, 0.92, 0),
    ltrBar(-0.16, 0.14, LTR_T, 0.62, 0.52), ltrBar(0.16, 0.14, LTR_T, 0.62, -0.52)],
  N: () => [ltrBar(-0.26, 0, LTR_T, 0.92, 0), ltrBar(0.26, 0, LTR_T, 0.92, 0),
    ltrBar(0, 0, LTR_T, 1.02, 0.52)],
  P: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ...ltrArc(-0.28, 0.23, 0.24, -_PI / 2, _PI)],
  // ⚠ the tail has to CROSS the bowl to read. Tucked inside it (the first
  //   version) a Q is just an O at riding distance.
  Q: () => [...ltrArc(0, 0, 0.34, 0, 2 * _PI), ltrBar(0.24, -0.27, LTR_T, 0.46, 0.69)],
  R: () => [ltrBar(-0.28, 0, LTR_T, 0.92, 0), ...ltrArc(-0.28, 0.23, 0.24, -_PI / 2, _PI),
    ltrBar(0.10, -0.24, LTR_T, 0.50, 0.62)],
  // ⚠ this S was MIRRORED (a Ƨ) once. `ltrArc` covers [a0, a0 + sweep], so
  //   WHICH WAY THE GAP FACES is the letter's identity: the top bowl's gap
  //   faces bottom-right, the bottom bowl's top-left.
  S: () => [...ltrArc(0, 0.22, 0.22, 0.17 * _PI, 1.33 * _PI),
    ...ltrArc(0, -0.22, 0.22, -0.83 * _PI, 1.33 * _PI)],
  V: () => [ltrBar(-0.15, 0, LTR_T, 0.92, 0.30), ltrBar(0.15, 0, LTR_T, 0.92, -0.30)],
  W: () => [ltrBar(-0.30, 0, LTR_T, 0.92, 0.22), ltrBar(-0.10, 0, LTR_T, 0.92, -0.22),
    ltrBar(0.10, 0, LTR_T, 0.92, 0.22), ltrBar(0.30, 0, LTR_T, 0.92, -0.22)],
  Y: () => [ltrBar(-0.14, 0.24, LTR_T, 0.46, 0.52), ltrBar(0.14, 0.24, LTR_T, 0.46, -0.52),
    ltrBar(0, -0.22, LTR_T, 0.48, 0)],
});

/**
 * What a block may carry — taken BEFORE the digits go in, exactly as the demo
 * takes it. An alphabet block with a number on it is a different toy, and the
 * digits are only here because system-generated strings ("第 3 階段") need them.
 *
 * Exported for `scripts/headless-check/plastic-letters-vs-demo.ts`, which diffs
 * this alphabet and every glyph in it against the demo's, glyph by glyph.
 */
export const LETTER_KEYS = Object.keys(LETTERS);

Object.assign(LETTERS, {
  // Each digit is deliberately built on a DIFFERENT skeleton from the letter it
  // most resembles, not merely detailed differently: 0 is a ring with a slash
  // where O is a bare ring; 1 is a stem with a flag where I is a stem with
  // serifs; 5 has a flat square top where S has no straight line at all.
  '0': () => [...ltrArc(0, 0, 0.34, 0, 2 * _PI), ltrBar(0, 0, LTR_T, 0.52, -0.60)],
  '1': () => [ltrBar(0.02, 0, LTR_T, 0.92, 0), ltrBar(-0.14, 0.33, LTR_T, 0.34, 0.70)],
  '2': () => [...ltrArc(0, 0.20, 0.25, _PI, -1.25 * _PI),
    ltrBar(-0.05, -0.15, LTR_T, 0.60, -0.93), ltrBar(0, -0.40, 0.62, LTR_T, 0)],
  '3': () => [...ltrArc(-0.04, 0.21, 0.24, -0.62 * _PI, 1.42 * _PI),
    ...ltrArc(-0.04, -0.21, 0.25, -0.89 * _PI, 1.50 * _PI)],
  '4': () => [ltrBar(0.16, 0, LTR_T, 0.92, 0), ltrBar(-0.04, -0.06, 0.62, LTR_T, 0),
    ltrBar(-0.07, 0.19, LTR_T, 0.70, -0.74)],
  '5': () => [ltrBar(0.02, 0.40, 0.56, LTR_T, 0), ltrBar(-0.26, 0.20, LTR_T, 0.44, 0),
    ltrBar(-0.14, 0.00, 0.28, LTR_T, 0), ...ltrArc(-0.02, -0.16, 0.30, -0.94 * _PI, 1.46 * _PI)],
  // ⚠ 6 / 9's tail: it must be the SAME kind of arc as a C — centred on the
  //   glyph, bulging outward. Drawn as a big arc centred outside, it bulges
  //   inward and slices straight through the ring: a crossed-out O.
  '6': () => [...ltrArc(0, -0.15, 0.27, 0, 2 * _PI),
    ...ltrArc(0, 0.03, 0.34, 0.30 * _PI, 0.85 * _PI)],
  '7': () => [ltrBar(0, 0.40, 0.62, LTR_T, 0), ltrBar(0.04, -0.04, LTR_T, 0.90, -0.42)],
  '8': () => [...ltrArc(0, 0.21, 0.20, 0, 2 * _PI), ...ltrArc(0, -0.20, 0.22, 0, 2 * _PI)],
  '9': () => [...ltrArc(0, 0.15, 0.27, 0, 2 * _PI),
    ...ltrArc(0, -0.03, 0.34, 1.30 * _PI, 0.85 * _PI)],
});

/**
 * The missing-glyph mark: a CROSSED BOX. Never fall back to a system font
 * (法則 3.7), and never skip the character silently — skipping leaves a sign
 * reading "TART" with nothing logged and no clue that the S is what went.
 *
 * (Silently skipping is exactly what this file did before the demo's table was
 * brought over: `signStrokes` drops any character its alphabet lacks, and
 * `buildLetterRelief` then `continue`d past the empty geometry.)
 */
const LETTER_MISSING = (): THREE.BufferGeometry[] => [
  ltrBar(-0.40, 0, LTR_T, 0.92, 0), ltrBar(0.40, 0, LTR_T, 0.92, 0),
  ltrBar(0, 0.42, 0.94, LTR_T, 0), ltrBar(0, -0.42, 0.94, LTR_T, 0),
  ltrBar(0, 0, LTR_T, 1.10, 0.72), ltrBar(0, 0, LTR_T, 1.10, -0.72),
];
/** One complaint per character: chunks rebuild constantly and an unguarded warn
 *  would flood the console. */
const letterWarned = new Set<string>();

/**
 * One character = one merged geometry, cached for the life of the process and
 * shared between chunks. Built LAZILY, so extending the table to A–Z + 0–9
 * costs nothing for the characters nobody writes.
 *
 * Handed out to be CLONED, never lent: `mergeBuildingDecorations` disposes
 * every geometry it is given, and lending the cache entry would empty the cache
 * after one chunk.
 *
 * ⚠ ONE deviation from the demo: the demo's `mergeGeos` hand-rolls the merge
 * and keeps only `position` + `normal`, non-indexed. This uses the merge this
 * file already uses everywhere else, which keeps `uv` and the index. The
 * expanded triangle stream is identical — `plastic-letters-vs-demo.ts` asserts
 * exactly that, triangle for triangle — and keeping the attribute set means a
 * letter mesh can still be merged with its neighbours by
 * `mergeBuildingDecorations`, which is where all of these end up.
 *
 * Exported for `scripts/headless-check/plastic-letters-vs-demo.ts`.
 */
const LETTER_GEOS = new Map<string, THREE.BufferGeometry>();
export function letterGeo(ch: string): THREE.BufferGeometry {
  let g = LETTER_GEOS.get(ch);
  if (g === undefined) {
    const make = LETTERS[ch];
    if (!make && !letterWarned.has(ch)) {
      letterWarned.add(ch);
      console.warn(`[plastic] 字形表沒有 ${JSON.stringify(ch)},畫成打叉的方框; `
        + '請補進 LETTERS(不可退回系統字型)');
    }
    const parts = (make || LETTER_MISSING)();
    g = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
    if (parts.length > 1) for (const p of parts) p.dispose();
    LETTER_GEOS.set(ch, g);
  }
  return g;
}

interface AlphabetLayout {
  boxes: ColoredBox[];
  /** One embossed letter: where it sits and whether it is ink or white. */
  letters: { ch: string; matrix: THREE.Matrix4; rim: THREE.Matrix4; ink: boolean }[];
}

function alphabetBlocksLayout(box: BuildingBox, seed: number): AlphabetLayout {
  // ── The adaptation, and this is the body where it is largest ──
  // `makeBuilding` calls `alphabetBlocks(ci)` — NO size at all. The demo's
  // school is a fixed prop: a 0.9 m plinth carrying `n = 4 or 5` cubes of
  // `ABC_S = 5.2` at a pitch of `S + 0.5`, one row, never stacked, 6.1 m tall.
  //
  // So what is copied here is the PROPORTION, which is the part the developer
  // fixed: plinth : cube : pitch = 0.9 : 5.2 : 5.7. `k` scales that prop so a
  // whole number of storeys fills `box.height`, then shrinks if the prop would
  // hang over the footprint; `n` is the demo's row, extended along the box.
  //
  // Tiers are the one thing with no demo answer at all. A 40 m school is six
  // storeys of the demo's prop rather than one 40 m cube, because a single
  // cube scaled to 40 m overflows a 19 m footprint (which is the p50 here) and
  // because the letters would then be 26 m tall.
  const rng = mulberry32(seed * 5387 + 19);
  // The row runs along the footprint's longer axis — which is the street, since
  // the oriented box was fitted to the footprint's own longest edge.
  const alongX = box.width >= box.depth;
  const long = alongX ? box.width : box.depth;
  const across = alongX ? box.depth : box.width;

  const usableH = Math.max(MIN_BODY_HEIGHT, box.height);
  const tiers = Math.max(1, Math.round(usableH / ABC_PROP_H));
  // The prop's scale: one storey of it per tier, shrunk if `S + 1.6` would
  // reach past the footprint.
  const propK = Math.min(
    usableH / (tiers * ABC_PROP_H),
    Math.max(across, MIN_BODY_HEIGHT) / (ABC_S + 1.6),
  );
  const plinthH = Math.min(ABC_PLINTH * propK, box.height * 0.5);
  const avail = Math.max(1, box.height - plinthH);
  const pitchNominal = (ABC_S + 0.5) * propK;
  const n = Math.max(1, Math.round(long / pitchNominal));
  const pitch = long / n;
  const sLong = Math.min(ABC_S * propK, pitch * 0.92);
  const sY = avail / tiers;
  const sAcross = Math.min(across * 0.95, ABC_S * propK);

  const boxes: ColoredBox[] = [];
  const letters: AlphabetLayout['letters'] = [];

  // A solid plinth. The blocks are not floating, and it fills the gaps between
  // them from below — backlit, those gaps would otherwise be holes punched
  // through the skyline.
  boxes.push({
    w: box.width, h: plinthH + box.skirt, d: box.depth,
    x: 0, y: (plinthH - box.skirt) / 2, z: 0, color: ABC_PLINTH_COLOR,
  });

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  /** The demo's `cube` group, and the letter's transform inside it. */
  const cubeM = new THREE.Matrix4();
  const localM = new THREE.Matrix4();
  const emboss = Math.max(0.08, sAcross * ABC_EMBOSS);

  for (let t = 0; t < tiers; t++) {
    for (let i = 0; i < n; i++) {
      const color = BRICK_COLORS[(seed + (i + t) * 2) % BRICK_COLORS.length];
      const off = -long / 2 + (i + 0.5) * pitch;
      const cx = alongX ? off : 0;
      const cz = alongX ? 0 : off;
      const cy = plinthH + (t + 0.5) * sY;
      const yaw = (rng() - 0.5) * 0.06;   // set down by hand, not machined into a row
      boxes.push({
        w: alongX ? sLong : sAcross,
        h: sY,
        d: alongX ? sAcross : sLong,
        x: cx, y: cy, z: cz, color, rotY: yaw,
      });

      // Letter ink flips with the block's brightness, or a white letter on a
      // yellow block disappears completely.
      const c = new THREE.Color(color);
      const ink = c.r * 0.3 + c.g * 0.6 + c.b * 0.1 > 0.55;
      const ch = LETTER_KEYS[
        Math.floor(rng() * LETTER_KEYS.length) % LETTER_KEYS.length];
      // The demo's `k = S * 0.66`: a moulded block has a MARGIN round its
      // letter. Filling the face edge to edge (what this used to do) is a
      // printed tile, not a moulded one.
      const k = Math.min(sY, sAcross, sLong) * 0.66;
      const half = sAcross / 2;
      // ⚠ the demo's prop always has a size; a real route does not. A footprint
      // whose oriented box is zero across (MVT does produce degenerate rings)
      // drives `sAcross`, and therefore `k`, to zero — and an `O` at scale 0 is
      // 180 ZERO-AREA triangles, which the CPU probe cannot see (they vanish in
      // the rasteriser) and WebGL draws anyway. A NEAR-zero footprint is the
      // same thing in float32: at a 1 nm block the cross products underflow and
      // every letter triangle is degenerate again. So the floor is physical —
      // a letter under a millimetre is not a letter, and the block carrying it
      // is already smaller than a pixel from any camera.
      if (!(k > ABC_MIN_LETTER)) continue;
      // The demo's `faces` table, in CUBE-LOCAL coordinates — `[S/2,0,0]` and
      // `[-S/2,0,0]` for the two faces the rider passes, `[0,S/2,0]` for the
      // top. Only the axis swaps: the demo's row runs along z, so its two side
      // faces are ±x; a row that runs along x has them at ±z instead.
      //
      // The top face goes on for a single-tier row only — that is the only case
      // where the chase eye, 6.3 m up, is above the blocks and can see it.
      const faces: [number, number, number, number, number, number][] = alongX
        ? [
          [0, 0, half, 0, 0, 0],
          [0, 0, -half, 0, Math.PI, 0],
        ]
        : [
          [half, 0, 0, 0, Math.PI / 2, 0],
          [-half, 0, 0, 0, -Math.PI / 2, 0],
        ];
      if (tiers === 1) faces.push([0, sY / 2, 0, -Math.PI / 2, 0, 0]);
      // …and the demo's `cube`, which is what the letters are CHILDREN of. That
      // parenting is the whole reason for composing it this way rather than
      // folding the yaw into each letter's own euler: the yaw has to turn the
      // letter's POSITION with the face it sits on, not just its facing. Folded
      // in, the two side letters stayed at the un-yawed face centre (~80 mm off
      // a face that had moved) and the top letter tilted out of the block's top
      // plane instead of spinning in it.
      cubeM.makeRotationY(yaw).setPosition(cx, cy, cz);
      for (const f of faces) {
        pos.set(f[0], f[1], f[2]);
        euler.set(f[3], f[4], f[5]);
        quat.setFromEuler(euler);
        letters.push({
          ch, ink,
          // The demo's `ls = (k, k, S * 0.075 / LTR_E)` — the glyph is extruded
          // to `LTR_E` in its own frame, so the divide is what turns a metre
          // emboss into a scale factor. `emboss` IS the demo's `S * 0.075`,
          // floored (see above) because a route can hand over a zero.
          matrix: new THREE.Matrix4().multiplyMatrices(
            cubeM, localM.compose(pos, quat, scale.set(k, k, emboss / LTR_E))),
          // The rim is the SAME glyph, 1.16× and sunk to 42 % of the emboss, so
          // only a ring of light escapes around each stroke at night. Lighting
          // the whole stroke was too bright: a school is four to five blocks
          // with letters on three faces each, and it ended up outshining the
          // commercial towers — the brightness hierarchy inverted.
          rim: new THREE.Matrix4().multiplyMatrices(
            cubeM,
            localM.compose(pos, quat, scale.set(k * 1.16, k * 1.16, (emboss / LTR_E) * 0.42))),
        });
      }
    }
  }
  return { boxes, letters };
}

// ── Hospital: the domino wall ───────────────────────────────────────────────
//
// Ivory plates stood on edge, shoulder to shoulder. THREE rows where the
// footprint allows, two at the very least, and never one:
//  · One row is a thin plate. The chase eye sits 6.3 m above the rider
//    (`fps-camera.ts` CHASE_UP), so a plate seen edge-on has almost no area and
//    the building vanishes. This is exactly how the demo lost its card house.
//  · The gaps between plates are holes in the skyline. The middle row is
//    staggered half a pitch so it backs every seam, and the volume stays solid.
// The pips ARE the windows, so no square window is ever cut in the white — and
// the white itself is the separator: nothing else in this world is white.

/**
 * The demo's domino, and the bar it stands on. Every one of these is a RATIO
 * here rather than a length — the prop is 6.9 m tall and a hospital footprint
 * is not — but they are the demo's literals, so the ratios are the demo's:
 *   · `DOM_H / DOM_W`               = 2.385  tall-to-wide, at any size
 *   · `DOM_W / DOM_PITCH`           = 0.825  so a seam shows between plates
 *   · `DOM_D / (DOM_D + DOM_GAP)`   = 0.611  so the rows stand apart
 *   · `DOM_PLINTH_H / (…+ DOM_H)`   = 0.101  plinth against the whole prop
 */
const DOM_W = 2.6;
const DOM_D = 1.1;
const DOM_H = 6.2;
const DOM_PITCH = DOM_W + 0.55;
const DOM_GAP = 0.7;
const DOM_PLINTH_H = 0.7;
/** The demo's rooftop marker board: `scale(0.6, 4.4, 5.0)`. */
const DOM_SIGN_H = 4.4;
/** The demo's pip: `CylinderGeometry(0.3, 0.3, 0.2, 10)` laid on its side. Ten
 *  facets, and a real cylinder standing PROUD of the face — this had been
 *  flattened to a six-sided disc to save 16 triangles a pip, and triangles are
 *  the one thing that measured free on the N100 (`corr(frameMs, tris)` = −0.02,
 *  twice). A pip you can see the edge of is what makes the face read as moulded. */
const DOM_PIP_SEGMENTS = 10;
const DOM_PIP_DEPTH = 0.2 / 0.3;

/** Pip patterns on a 3×3 grid, in grid steps. The blank half is a plain face. */
const PIP_PATTERNS: readonly (readonly (readonly [number, number])[])[] = [
  [], [[0, 0]], [[-1, 1], [1, -1]], [[-1, 1], [0, 0], [1, -1]],
  [[-1, 1], [1, 1], [-1, -1], [1, -1]],
  [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]],
  [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]],
];

interface DominoLayout {
  boxes: ColoredBox[];
  /** Pips and the scored centre line, on the two outward-facing rows only. */
  pips: { x: number; y: number; z: number; rotY: number; r: number }[];
  bars: { x: number; y: number; z: number; rotY: number; w: number; t: number }[];
  /** Where the rooftop marker board hangs, and how tall it is. */
  signY: number;
  signH: number;
  /** True when the plates run along local +x — the marker board has to face the
   *  same way the plates do, and the decoration cannot re-derive it without
   *  re-deriving the whole wall. */
  alongX: boolean;
}

function dominoWallLayout(box: BuildingBox, seed: number): DominoLayout {
  // ── The adaptation, the second of the two bodies the demo gives no size ──
  // `makeBuilding` calls `dominoWall(ci)` — no arguments. The demo's hospital
  // is a fixed prop: three rows of `n = 6 or 7` plates, each `DOM_W × DOM_D ×
  // DOM_H`, at a pitch of `DOM_W + 0.55` with `DOM_GAP` between rows, on a
  // 0.7 m plinth.
  //
  // Copied here: every RATIO in that list, which is the part that makes a
  // domino a domino — `DOM_H : DOM_W` = 2.385 tall-to-wide, `DOM_W : pitch` =
  // 0.825 so a seam shows, `DOM_D : (DOM_D + DOM_GAP)` = 0.611 so the rows
  // stand apart. `k` is the prop's scale, taken from the wall height, and the
  // plate count comes off the long axis at the scaled pitch.
  const rng = mulberry32(seed * 4231 + 13);
  const alongX = box.width >= box.depth;
  const long = alongX ? box.width : box.depth;
  const across = alongX ? box.depth : box.width;

  // The demo's 0.7 m plinth under a 6.9 m prop.
  const plinthH = Math.min(0.9, box.height * (DOM_PLINTH_H / (DOM_PLINTH_H + DOM_H)));
  const wallH = Math.max(MIN_BODY_HEIGHT, box.height - plinthH);
  const k = wallH / DOM_H;
  // Rows across the short axis. Three when there is room for three; two is the
  // floor, and one is not an option at any footprint. Across is where the box
  // wins over the prop: a 40 m deep hospital cannot be three 1.1 m plates with
  // 0.7 m between them and 37 m of nothing, so the ROW SPACING is the box's and
  // only the plate's share of it (`DOM_D / (DOM_D + DOM_GAP)`) is the demo's.
  const rows = across >= 4.2 ? 3 : 2;
  const rowPitch = across / rows;
  const thick = rowPitch * (DOM_D / (DOM_D + DOM_GAP));
  // A domino is `DOM_H / DOM_W` = 2.385 times as tall as it is wide, at every
  // size. Deriving the plate width from the HEIGHT is what keeps that true on a
  // 40 m hospital; tiling a fixed 2.6 m plate up a tall box gives a picket
  // fence.
  //
  // …but never fewer than THREE plates in a row where the footprint can hold
  // them. A tall hospital on a short footprint works out at two by proportion,
  // and two plates read as a slab with a seam down the middle — the whole point
  // of the wall is that it is made of pieces. Past that the plates simply get
  // narrower than a real domino, which is a much smaller lie.
  const n = Math.max(2, Math.min(
    Math.max(3, Math.round(long / (DOM_PITCH * k))),
    Math.floor(long / 1.6),
  ));
  const pitch = long / n;
  const plateW = pitch * (DOM_W / DOM_PITCH);

  // The demo's ragged top edge, `DOM_H * (0.86 + rng() * 0.26)`, then
  // normalised so the tallest plate reaches exactly the box height — the body
  // has to fill the volume it was given, which the demo's fixed prop never had
  // to. (This file had 0.8 + rng()*0.2: a quarter of the demo's raggedness, so
  // the top edge read as one line with dents rather than as separate pieces.)
  const raw: number[] = [];
  let maxRaw = 0;
  for (let i = 0; i < rows * n; i++) {
    const h = 0.86 + rng() * 0.26;
    raw.push(h);
    if (h > maxRaw) maxRaw = h;
  }

  const boxes: ColoredBox[] = [{
    w: box.width, h: plinthH + box.skirt, d: box.depth,
    x: 0, y: (plinthH - box.skirt) / 2, z: 0, color: DOMINO_PLINTH_COLOR,
  }];
  const pips: DominoLayout['pips'] = [];
  const bars: DominoLayout['bars'] = [];
  let maxTop = plinthH;
  let rawIdx = 0;

  for (let r = 0; r < rows; r++) {
    const acrossOff = ((rows - 1) / 2 - r) * rowPitch;
    const stagger = r % 2 ? pitch / 2 : 0;
    const count = stagger ? n - 1 : n;
    // Only the two outer rows are ever seen face-on; pips on the middle row
    // would be sealed between two walls.
    const outward = r === 0 ? 1 : (r === rows - 1 ? -1 : 0);
    for (let i = 0; i < count; i++) {
      const alongOff = -long / 2 + (i + 0.5) * pitch + stagger;
      const h = wallH * (raw[rawIdx++ % raw.length] / maxRaw);
      const top = plinthH + h;
      if (top > maxTop) maxTop = top;
      const x = alongX ? alongOff : acrossOff;
      const z = alongX ? acrossOff : alongOff;
      boxes.push({
        w: alongX ? plateW : thick,
        h, d: alongX ? thick : plateW,
        x, y: plinthH + h / 2, z,
        color: PORCELAIN_COLOR,
      });
      if (!outward) continue;
      // The demo's `DOM_D / 2 + 0.06`, in the prop's own units.
      const faceOff = thick / 2 + 0.06 * k;
      const fx = alongX ? x : x + outward * faceOff;
      const fz = alongX ? z + outward * faceOff : z;
      const rotY = alongX
        ? (outward > 0 ? 0 : Math.PI)
        : outward * Math.PI / 2;
      // The scored line down the middle: the demo's `scale(0.14, 0.16,
      // DOM_W * 0.86)`, so it is 0.16 m tall on a 6.2 m plate — a groove, not
      // a band whose thickness tracks the plate (this used to be `h * 0.022`).
      bars.push({
        x: fx, y: plinthH + h / 2, z: fz, rotY,
        w: plateW * 0.86, t: 0.16 * k,
      });
      // The demo's pip is 0.3 m across on a 2.6 m plate.
      const pipR = Math.min(plateW, h / 2) * (0.3 / DOM_W);
      // In-face horizontal axis: the quad's own +x once it has been turned by
      // rotY. Spelling it out beats four hand-written sign cases.
      const ux = Math.cos(rotY);
      const uz = -Math.sin(rotY);
      for (const half of [1, -1]) {
        const pat = PIP_PATTERNS[Math.floor(rng() * PIP_PATTERNS.length) % PIP_PATTERNS.length];
        const cy = plinthH + h / 2 + half * (h / 2) * 0.47;
        for (const g of pat) {
          const along = g[0] * plateW * 0.24;
          pips.push({
            x: fx + ux * along,
            y: cy + g[1] * (h / 2) * 0.2,
            z: fz + uz * along,
            rotY, r: pipR,
          });
        }
      }
    }
  }

  // The demo's 4.4 m board, at the demo's own proportion of the wall
  // (4.4 / 6.2 = 0.71). At the demo's own size this IS 4.4 m; the ceiling only
  // binds above it, and it binds on purpose — the marker says "hospital", and
  // a 28 m one on a 40 m block stops being a marker and becomes the building.
  const signH = Math.min(DOM_SIGN_H, Math.max(1.6, wallH * (DOM_SIGN_H / DOM_H)));
  return { boxes, pips, bars, signY: maxTop + signH * 0.5 + 0.4, signH, alongX };
}
