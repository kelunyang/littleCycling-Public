/**
 * Cuphead hand-drawn style strategy — 1930s vintage aesthetic.
 *
 * All visual elements are procedurally drawn with:
 * - Wobbly ink outlines (seed-based, deterministic)
 * - Watercolor-style fills (layered semi-transparent)
 * - Cross-hatching for shadows
 * - Organic blob shapes (trees, clouds, moon)
 * - Film grain overlay (pre-rendered canvas, shifted every 4 frames)
 * - Warm muted color palette replacing neon
 * - 64×64 rubber-hose cyclist with pie-cut eyes
 */

import type Phaser from 'phaser';
import type { PhaserStyleStrategy } from './phaser-style-strategy';
import * as P from './cuphead-palette';
import {
  seededRandom,
  generateWobbleOffsets,
  drawInkLine,
  drawInkRect,
  drawSimpleHatch,
  drawWatercolorFill,
  drawOrganicBlob,
  generateFilmGrainCanvas,
} from './cuphead-draw';

// ── Film grain state (module-level, shared across resize) ──
let grainImage: Phaser.GameObjects.Image | null = null;
const GRAIN_TEXTURE_KEY = '__cuphead_grain__';
const IRIS_TEXTURE_KEY = '__cuphead_iris__';

// ── Terrain watercolour layers ──
// The terrain's permanent paint job — the entrance animation brushes the same
// three layers in one at a time. Each layer sits a little lower than the one
// above so the edges bleed like wet paint.
const WASHES: readonly { color: number; alpha: number; dy: number }[] = [
  { color: 0x7a8a5a, alpha: 0.5, dy: 16 },  // dusty sage under-wash
  { color: 0x8a9a6a, alpha: 0.45, dy: 7 },  // mid tone
  { color: P.TERRAIN_FILL, alpha: 0.85, dy: 0 },
];

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Smooth deterministic wobble — same world x, same offset, every frame.
 *  (The demo's `wob`: two incommensurate sines, no RNG jitter.) */
function wob(x: number, seed: number): number {
  return Math.sin(x * 0.045 + seed) * 1.6 + Math.sin(x * 0.13 + seed * 2.3) * 1.0;
}

/** Linear-interpolated surface Y at world x from the terrain point list. */
function surfYAt(points: { x: number; y: number }[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const p0 = points[lo];
  const p1 = points[hi];
  const span = p1.x - p0.x;
  const t = span > 0 ? (x - p0.x) / span : 0;
  return p0.y + (p1.y - p0.y) * t;
}

/** Demo's ink tree: wobbly trunk strokes under a lumpy 24-gon canopy blob. */
function drawInkTree(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number, s: number, seed: number,
): void {
  gfx.lineStyle(3, P.INK, 0.95);
  gfx.lineBetween(x + wob(x, 2), y, x + wob(x, 5), y - 26 * s);
  gfx.fillStyle(P.TERRAIN_FILL, 0.9);
  gfx.lineStyle(2.5, P.INK, 0.9);
  gfx.beginPath();
  for (let j = 0; j <= 24; j++) {
    const a = (j / 24) * Math.PI * 2;
    const r = (16 + Math.sin(a * 5 + seed) * 4.5) * s;
    const px = x + Math.cos(a) * r;
    const py = y - 26 * s - 10 * s + Math.sin(a) * r * 0.85;
    if (j === 0) gfx.moveTo(px, py); else gfx.lineTo(px, py);
  }
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
}

/**
 * Decorative ink trees scattered along the terrain — the demo world is dotted
 * with them everywhere, not only where OSM happens to map a forest. Placed on
 * a deterministic world grid (~270px), skipping steep ground; MVT forest trees
 * still draw on top where real forests exist, which only adds foliage.
 * During the intro each tree "grows" in with a staggered delay.
 */
function drawScatteredTrees(
  gfx: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  introT: number | null,
): void {
  if (points.length < 2) return;
  const SPACING = 270; // ≈90 m at 3 px/m
  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  for (let gx = Math.ceil(x0 / SPACING) * SPACING; gx < x1; gx += SPACING) {
    if (seededRandom(gx) < 0.45) continue;
    // Skip steep ground — trees on a wall read as a mistake.
    const dy = surfYAt(points, gx + 15) - surfYAt(points, gx - 15);
    if (Math.abs(dy / 30) > 0.12) continue;

    let grow = 1;
    if (introT !== null) {
      grow = easeOutCubic((introT - 1.9 - seededRandom(gx * 11) * 0.8) / 0.45);
      if (grow <= 0) continue;
    }
    const x = gx + (seededRandom(gx * 3) - 0.5) * 50;
    const s = (0.7 + seededRandom(gx * 7) * 0.7) * grow;
    drawInkTree(gfx, x, surfYAt(points, x) + 2, s, gx);
  }
}

/** One watercolour layer: fill from the (already wobbled) surface, shifted
 *  down by the layer's dy, to the bottom of the view. */
function fillWash(
  gfx: Phaser.GameObjects.Graphics,
  pts: { x: number; y: number }[],
  bottomY: number,
  wash: { color: number; alpha: number; dy: number },
): void {
  gfx.fillStyle(wash.color, wash.alpha);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, bottomY);
  for (const p of pts) gfx.lineTo(p.x, p.y + wash.dy);
  gfx.lineTo(pts[pts.length - 1].x, bottomY);
  gfx.closePath();
  gfx.fillPath();
}

/** The pen line along the surface: a 4px ink stroke with a thin offset echo —
 *  one pass of a nib leaves two edges, and that is what sells "drawn". */
function strokeTerrainInk(
  gfx: Phaser.GameObjects.Graphics,
  pts: { x: number; y: number }[],
): void {
  gfx.lineStyle(4, P.INK, 1);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) gfx.lineTo(p.x, p.y);
  gfx.strokePath();
  gfx.lineStyle(1.5, P.INK, 0.55);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, pts[0].y + 5);
  for (const p of pts) gfx.lineTo(p.x, p.y + 5);
  gfx.strokePath();
}

/** Hatch shading on the STEEP stretches only — three 45° strokes below the
 *  surface every ~36px where the grade exceeds ~4%. Flat ground stays clean
 *  paper; the pen only shades where the hill needs explaining. */
function drawTerrainHatch(
  gfx: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  bottomY: number,
  alpha: number,
): void {
  if (points.length < 5) return;
  // Visual-slope threshold for a ~4% grade at the scene's px-per-metre scales
  // (4 px/m vertical over 3 px/m horizontal).
  const SLOPE_MIN = 0.053;
  const STEP_PX = 36;
  gfx.lineStyle(1.5, P.TERRAIN_OUTLINE, 0.6 * alpha);
  let nextX = points[0].x;
  for (let i = 2; i < points.length - 2; i++) {
    const p = points[i];
    if (p.x < nextX) continue;
    nextX = p.x + STEP_PX;
    const a = points[i - 2];
    const b = points[i + 2];
    const dx = b.x - a.x;
    if (dx <= 0 || Math.abs((b.y - a.y) / dx) < SLOPE_MIN) continue;
    for (let k = 0; k < 3; k++) {
      const yy = p.y + 10 + k * 11;
      if (yy > bottomY) break;
      gfx.lineBetween(p.x - 7, yy + 7, p.x + 7, yy - 7);
    }
  }
}

// ── Cyclist frame size (larger for rubber-hose detail) ──
const CYCLIST_W = 64;
const CYCLIST_H = 64;
const FRAME_COUNT = 6;

// ── Coin size ──
const COIN_SIZE = 14;

// ── Ink color as CSS hex ──
const INK_HEX = `#${P.INK.toString(16).padStart(6, '0')}`;

export function createCupheadStyle(): PhaserStyleStrategy {
  return {
    style: 'cuphead',
    cloudsOnSunny: true, // a 1930s cartoon sky always has ink clouds in it
    palette: {
      terrainFill: P.TERRAIN_FILL,
      terrainOutline: P.TERRAIN_OUTLINE,
      ink: P.INK,
      skyDayTop: P.SKY_DAY_TOP,
      skyDayBottom: P.SKY_DAY_BOTTOM,
      buildingColors: [...P.BUILDING_COLORS],
      treeTrunk: P.TREE_TRUNK,
      treeCanopy: P.TREE_CANOPY,
      treeCanopyColors: [...P.TREE_CANOPY_COLORS],
      waterFill: P.WATER_FILL,
      waterOutline: P.WATER_OUTLINE,
      grassOverlay: P.GRASS_OVERLAY,
      lampPost: P.LAMP_POST,
      lampGlow: P.LAMP_GLOW,
      mountainFar: P.MOUNTAIN_FAR,
      mountainNear: P.MOUNTAIN_NEAR,
      cloud: P.CLOUD,
      moon: P.MOON,
      coinGold: P.COIN_GOLD,
      coinHighlight: P.COIN_HIGHLIGHT,
      coinOutline: P.COIN_OUTLINE,
      markerTick: P.MARKER_TICK,
      fogColor: P.FOG_COLOR,
      cyclistBody: P.CYCLIST_BODY,
      cyclistHelmet: P.CYCLIST_HELMET,
      cyclistSkin: P.CYCLIST_SKIN,
    },

    // ── Terrain ──

    /**
     * Terrain surface — and, on entry, the animation of it being *drawn*:
     * an ink pen strokes the outline left-to-right (0–1.1 s), watercolour
     * washes brush in behind it one layer at a time (from 0.7 s), then the
     * hatch shading fades up (1.7 s). The plastic world drops into place;
     * this one gets painted.
     */
    drawTerrainSurface(gfx, points, bottomY, seed, intro) {
      if (points.length < 2) return;
      const wobble = generateWobbleOffsets(points.length, seed, 1.8);
      const wobbly = points.map((pt, i) => ({
        x: pt.x + (wobble[i]?.dx ?? 0),
        y: pt.y + (wobble[i]?.dy ?? 0),
      }));

      // Steady state IS the intro's final frame — same washes, same pen line —
      // so the animation ends without a visible switch of rendering paths.
      if (!intro) {
        for (const wash of WASHES) fillWash(gfx, wobbly, bottomY, wash);
        strokeTerrainInk(gfx, wobbly);
        drawTerrainHatch(gfx, wobbly, bottomY, 1);
        drawScatteredTrees(gfx, wobbly, null);
        return;
      }

      // The reveal sweeps from where the view started, not from the (moving)
      // left edge of the current point list.
      const sweepFrom = intro.originX - 70;
      const sweepSpan = (wobbly[wobbly.length - 1].x - sweepFrom) + 140;

      // ── Watercolour washes (three layers, brushed in one after another) ──
      for (let i = 0; i < WASHES.length; i++) {
        const wash = WASHES[i];
        const k = (intro.t - 0.7 - i * 0.45) / 0.9;
        if (k <= 0) continue;

        let layer = wobbly;
        let brushX: number | null = null;
        if (k < 1) {
          brushX = sweepFrom + sweepSpan * easeOutCubic(k);
          layer = wobbly.filter((p) => p.x <= brushX!);
          if (layer.length < 2) continue;
        }

        fillWash(gfx, layer, bottomY, wash);

        // Wet brush head: a blob of pigment with a drag mark behind it.
        if (brushX !== null) {
          const tip = layer[layer.length - 1];
          gfx.fillStyle(wash.color, 0.55);
          gfx.fillEllipse(tip.x, tip.y + wash.dy + 6, 34, 16);
          gfx.fillStyle(wash.color, 0.3);
          gfx.fillEllipse(tip.x - 14, tip.y + wash.dy + 20, 26, 12);
        }
      }

      // ── Ink outline, drawn by a travelling pen nib ──
      const inkK = intro.t / 1.1;
      let inkPts = wobbly;
      let nib: { x: number; y: number } | null = null;
      if (inkK < 1) {
        const cutX = sweepFrom + sweepSpan * easeOutCubic(inkK);
        inkPts = wobbly.filter((p) => p.x <= cutX);
        nib = inkPts.length > 0 ? inkPts[inkPts.length - 1] : null;
      }
      if (inkPts.length >= 2) strokeTerrainInk(gfx, inkPts);
      if (nib) {
        gfx.fillStyle(P.INK, 1);
        gfx.fillCircle(nib.x, nib.y, 3.5);
        gfx.lineStyle(3, P.INK, 0.9);
        gfx.lineBetween(nib.x, nib.y, nib.x + 14, nib.y - 22); // pen shaft
      }

      // ── Hatch shading, fading up once the paint is down ──
      const hatchA = Math.min(1, Math.max(0, (intro.t - 1.7) / 0.6));
      if (hatchA > 0) drawTerrainHatch(gfx, wobbly, bottomY, hatchA);

      // ── Trees grow in last, staggered ──
      drawScatteredTrees(gfx, wobbly, intro.t);
    },

    drawOverlay(scene) {
      // scale.width/height 跟隨 resize;game.config 是建立當下的尺寸,永不更新
      const w = scene.scale.width;
      const h = scene.scale.height;

      // Generate film grain texture
      if (scene.textures.exists(GRAIN_TEXTURE_KEY)) {
        scene.textures.remove(GRAIN_TEXTURE_KEY);
      }
      const grainCanvas = generateFilmGrainCanvas(w, h, 0.5);

      // Add warm tint to the grain
      const ctx = grainCanvas.getContext('2d')!;
      const r = (P.GRAIN_TINT >> 16) & 0xff;
      const g = (P.GRAIN_TINT >> 8) & 0xff;
      const b = P.GRAIN_TINT & 0xff;
      ctx.fillStyle = `rgba(${r},${g},${b},${P.GRAIN_ALPHA})`;
      ctx.fillRect(0, 0, w, h);

      scene.textures.addCanvas(GRAIN_TEXTURE_KEY, grainCanvas);
      grainImage = scene.add.image(w / 2, h / 2, GRAIN_TEXTURE_KEY);
      grainImage.setAlpha(0.8);
      // 2× overscan: camera-lift zoom-out scales scrollFactor(0) layers too;
      // without this the grain would shrink and leave clean borders.
      grainImage.setScale(2);

      // Both overlay pieces ride in one container (drawOverlay returns a
      // single object that the scene destroys/recreates on resize). Children
      // of a container follow ITS scrollFactor, so it carries the (0, 0).
      const container = scene.add.container(0, 0, [grainImage]);
      container.setScrollFactor(0);
      container.setDepth(999);

      // Iris vignette — the 1930s picture-frame darkening at the corners.
      // Game mode already gets a vignette from the cycling-glasses PostFX;
      // doubling them up goes muddy, so the iris only draws on welcome.
      const mode = (scene as Partial<{ sceneMode: string }>).sceneMode;
      if (mode === 'welcome') {
        if (scene.textures.exists(IRIS_TEXTURE_KEY)) {
          scene.textures.remove(IRIS_TEXTURE_KEY);
        }
        const tex = scene.textures.createCanvas(IRIS_TEXTURE_KEY, w, h);
        if (tex) {
          const ictx = tex.getContext();
          const grad = ictx.createRadialGradient(
            w / 2, h / 2, Math.min(w, h) * 0.42,
            w / 2, h / 2, Math.max(w, h) * 0.78,
          );
          grad.addColorStop(0, 'rgba(42,36,32,0)');   // P.INK, transparent
          grad.addColorStop(1, 'rgba(42,36,32,0.5)'); // P.INK at the corners
          ictx.fillStyle = grad;
          ictx.fillRect(0, 0, w, h);
          tex.refresh();
          const iris = scene.add.image(w / 2, h / 2, IRIS_TEXTURE_KEY);
          iris.setScale(2); // 2× overscan, same reason as the grain
          container.add(iris);
        }
      }

      return container;
    },

    updateOverlay(frameCount) {
      if (!grainImage) return;
      // Shift grain position every 4 frames for flickering effect
      if (frameCount % 4 === 0) {
        const shift = (frameCount / 4) % 4;
        grainImage.setPosition(
          grainImage.x + (shift === 0 ? 0 : shift === 1 ? 1 : shift === 2 ? -1 : 0),
          grainImage.y + (shift === 0 ? 1 : shift === 1 ? 0 : shift === 2 ? 0 : -1),
        );
      }
    },

    // ── Background features ──

    renderBuilding(gfx, x, y, w, h, colorIndex, seed) {
      const color = P.BUILDING_COLORS[colorIndex % P.BUILDING_COLORS.length];

      // Watercolor fill body
      drawWatercolorFill(gfx, x, y, w, h, color, seed, 3);

      // Ink outline
      drawInkRect(gfx, x, y, w, h, seed, 2.5, P.INK);

      // Warm yellow windows
      const winSize = 3;
      const winGap = 6;
      for (let wy = y + 5; wy < y + h - 5; wy += winGap) {
        for (let wx = x + 4; wx < x + w - 4; wx += winGap) {
          gfx.fillStyle(0xd4b050, 0.5);
          gfx.fillRect(wx, wy, winSize, winSize);
        }
      }

      // Right-side shadow hatch
      const shadowW = Math.min(w * 0.3, 8);
      drawSimpleHatch(gfx, x + w - shadowW, y, shadowW, h, P.INK, 0.1, 4);

      // Wobbly roofline
      drawInkLine(gfx, x - 2, y, x + w + 2, y, seed + 500, 2, P.INK);
    },

    renderTree(gfx, x, y, size, seed) {
      // Per-tree size variation
      const scale = 0.8 + ((seed % 100) / 100) * 0.5;
      const treeH = (18 + (seed % 12)) * scale;
      const crownR = (7 + (seed % 5)) * scale;
      const trunkH = (5 + (seed % 3)) * scale;

      const canopyColor = P.TREE_CANOPY_COLORS[seed % P.TREE_CANOPY_COLORS.length];
      // Three blob silhouettes: round (single blob), tall (vertical ellipse-ish via stacked blobs), wide (two-blob bushy)
      const shape = seed % 3;

      // Wobbly trunk
      drawInkLine(gfx, x, y, x + (seededRandom(seed + 10) - 0.5) * 3, y - trunkH, seed, 3, P.TREE_TRUNK);

      const canopyCy = y - trunkH - crownR * 0.7;

      if (shape === 0) {
        // Round single blob — original look
        drawOrganicBlob(gfx, x, canopyCy, crownR, seed + 50, canopyColor, P.INK, 2);
      } else if (shape === 1) {
        // Tall poplar — two stacked blobs
        const upperCy = canopyCy - crownR * 0.7;
        drawOrganicBlob(gfx, x, canopyCy, crownR * 0.85, seed + 50, canopyColor, P.INK, 2);
        drawOrganicBlob(gfx, x, upperCy, crownR * 0.65, seed + 90, canopyColor, P.INK, 2);
      } else {
        // Wide bushy — twin side-by-side blobs
        drawOrganicBlob(gfx, x - crownR * 0.4, canopyCy, crownR * 0.75, seed + 50, canopyColor, P.INK, 2);
        drawOrganicBlob(gfx, x + crownR * 0.4, canopyCy - crownR * 0.2, crownR * 0.7, seed + 110, canopyColor, P.INK, 2);
      }

      // Highlight spot (slightly lighter than canopy)
      gfx.fillStyle(0x8aaa5a, 0.3);
      gfx.fillCircle(x - crownR * 0.3, canopyCy - crownR * 0.2, crownR * 0.35);

      // Shadow hatch on right side of canopy
      drawSimpleHatch(
        gfx,
        x, canopyCy - crownR * 0.3,
        crownR, crownR * 0.8,
        P.INK, 0.08, 3,
      );
    },

    renderWater(gfx, x, y, w, h, seed) {
      const waterWidth = 60;

      // Watercolor fill
      drawWatercolorFill(gfx, x - waterWidth / 2, y, waterWidth, h, P.WATER_FILL, seed, 3);

      // Wobbly surface line
      drawInkLine(
        gfx,
        x - waterWidth / 2, y,
        x + waterWidth / 2, y,
        seed + 77, 2.5, P.WATER_OUTLINE,
      );

      // Subtle wave marks
      for (let i = 0; i < 2; i++) {
        const lineY = y + 5 + i * 8;
        drawInkLine(
          gfx,
          x - waterWidth / 3, lineY,
          x + waterWidth / 3, lineY,
          seed + 200 + i, 1, P.WATER_OUTLINE, 0.3,
        );
      }

      return { x, y, w: waterWidth };
    },

    renderGrass(gfx, x, y, _w, _h, seed) {
      // 2-3 small organic blobs
      const count = 2 + Math.floor(seededRandom(seed) * 2);
      for (let i = 0; i < count; i++) {
        const bx = x - 8 + seededRandom(seed + i * 41) * 16;
        const by = y - 1;
        const br = 2 + seededRandom(seed + i * 67) * 2;
        drawOrganicBlob(gfx, bx, by, br, seed + i * 100, P.GRASS_OVERLAY, P.INK, 1, 0.4);
      }
    },

    /** Sand: warm sandstone hump with ink stipple — a pen-shaded dune. */
    renderSand(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(0xc4a87a, 0.55); // P.MARKER_TICK sandstone
      gfx.beginPath();
      gfx.moveTo(x - 22, y);
      for (let i = -22; i <= 22; i += 4) {
        gfx.lineTo(x + i, y - 3 - Math.sin((i + 22) / 44 * Math.PI) * 3 + wob(x + i, seed));
      }
      gfx.lineTo(x + 22, y);
      gfx.closePath();
      gfx.fillPath();
      // Ink stipple
      gfx.fillStyle(P.INK, 0.4);
      for (let i = 0; i < 7; i++) {
        const sx = x + (seededRandom(seed + i * 13) - 0.5) * 40;
        const sy = y - 2 - seededRandom(seed + i * 29) * 4;
        gfx.fillRect(sx, sy, 1.2, 1.2);
      }
    },

    /** Urban: a warm-grey wash band with sparse ink flecks — cobbles, not
     *  countryside. Kept quiet so buildings carry the town. */
    renderUrban(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(P.FOG_COLOR, 0.25);
      gfx.fillRect(x - 30, y - 3, 60, 5);
      gfx.fillStyle(P.INK, 0.3);
      for (let i = 0; i < 5; i++) {
        const sx = x + (seededRandom(seed + i * 17) - 0.5) * 55;
        gfx.fillRect(sx, y - 2 + seededRandom(seed + i * 7) * 2, 2, 1.2);
      }
    },

    /** Waterway: teal channel with wobbled ink banks — renderWater, narrowed. */
    renderWaterway(gfx, x, y, w, h, seed) {
      const half = w / 2;
      gfx.fillStyle(P.WATER_FILL, 0.55);
      gfx.fillRect(x - half, y, w, h);
      // Ink banks
      gfx.lineStyle(2, P.INK, 0.7);
      gfx.lineBetween(x - half + wob(y, seed), y, x - half + wob(y + 40, seed), y + h);
      gfx.lineBetween(x + half + wob(y, seed + 3), y, x + half + wob(y + 40, seed + 3), y + h);
      // Surface line
      gfx.lineStyle(2, P.WATER_OUTLINE, 0.6);
      gfx.lineBetween(x - half, y, x + half, y);
      return { x, y, w };
    },

    /** Aeroway: warm concrete strip, ink edges, white dashes — and a little
     *  tethered balloon-plane bobbing over the runway (the 3D cuphead world
     *  parks one at every aerodrome too). */
    renderAeroway(gfx, x, y, w, kind, seed) {
      const half = w / 2;
      const stripH = 7;
      gfx.fillStyle(0x9a8a7a, 0.7); // P.FOG_COLOR — warm concrete
      gfx.fillRect(x - half, y - stripH, w, stripH);
      gfx.lineStyle(2, P.INK, 0.7);
      gfx.lineBetween(x - half, y - stripH, x + half, y - stripH);
      gfx.lineBetween(x - half, y, x + half, y);
      gfx.fillStyle(0xffffff, 0.7);
      for (let i = -half + 4; i < half - 10; i += 18) {
        gfx.fillRect(x + i, y - stripH / 2 - 1, 9, 2);
      }
      if (kind !== 'runway') return;

      // Balloon plane: round body + triangle wing + rope down to the strip
      const px = x + (seededRandom(seed) - 0.5) * w * 0.5;
      const py = y - 60 - seededRandom(seed + 5) * 15;
      gfx.lineStyle(1.5, P.INK, 0.8);
      gfx.lineBetween(px, py + 9, px, y - stripH); // tether
      gfx.fillStyle(0xa0523c, 0.95);               // brick-red body
      gfx.lineStyle(2, P.INK, 0.9);
      gfx.beginPath();
      gfx.arc(px, py, 9, 0, Math.PI * 2);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      gfx.fillStyle(0xc4a035, 0.95);               // mustard wing
      gfx.fillTriangle(px - 2, py, px - 14, py - 7, px - 12, py + 4);
      gfx.lineStyle(1.5, P.INK, 0.9);
      gfx.strokeTriangle(px - 2, py, px - 14, py - 7, px - 12, py + 4);
      // Propeller tick
      gfx.lineStyle(1.5, P.INK, 0.8);
      gfx.lineBetween(px + 9, py - 5, px + 11, py + 5);
    },

    /** Road: a dirt-track band — warm earth wash between two wobbled ink
     *  edges, with dashed wheel ruts down the middle. */
    renderRoadSurface(gfx, points, seed) {
      const H = 8;
      // Earth wash
      gfx.fillStyle(0xb5a67a, 0.5); // khaki earth
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + 1);
      for (const p of points) gfx.lineTo(p.x, p.y + 1);
      for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + H);
      gfx.closePath();
      gfx.fillPath();
      // Lower ink edge (the surface's own double-stroke line is the upper one)
      gfx.lineStyle(1.5, P.INK, 0.5);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + H + wob(points[0].x, seed));
      for (const p of points) gfx.lineTo(p.x, p.y + H + wob(p.x, seed));
      gfx.strokePath();
      // Wheel-rut dashes
      gfx.lineStyle(1.2, P.INK, 0.35);
      for (let i = 2; i < points.length - 3; i += 5) {
        const p = points[i];
        gfx.lineBetween(p.x, p.y + H * 0.55, p.x + 12, p.y + H * 0.55);
      }
    },

    renderRoadLamp(gfx, x, y, seed) {
      const poleH = 35 + (seed % 10);
      const armW = 8;

      // Wobbly pole
      drawInkLine(gfx, x, y, x + (seededRandom(seed + 20) - 0.5) * 2, y - poleH, seed + 300, 2.5, P.LAMP_POST);

      // Arm
      drawInkLine(gfx, x, y - poleH, x + armW, y - poleH + 1, seed + 310, 2, P.LAMP_POST);

      // Lamp housing (organic blob)
      drawOrganicBlob(gfx, x + armW, y - poleH, 4, seed + 320, P.LAMP_POST, P.INK, 1.5);

      // Hatch shadow at base
      drawSimpleHatch(gfx, x - 3, y - 5, 6, 5, P.INK, 0.08, 3);
    },

    renderRoadLampGlow(gfx, x, y, seed) {
      const poleH = 35 + (seed % 10);
      const armW = 8;

      // Warm glow
      gfx.fillStyle(P.LAMP_GLOW, 0.12);
      gfx.fillCircle(x + armW, y - poleH + 2, 16);
      gfx.fillStyle(P.LAMP_GLOW, 0.2);
      gfx.fillCircle(x + armW, y - poleH + 2, 7);
    },

    // ── Sky / weather ──

    getSkyColors(sunElevation, weather) {
      let topColor: number;
      let bottomColor: number;

      if (sunElevation > 10) {
        topColor = P.SKY_DAY_TOP;
        bottomColor = P.SKY_DAY_BOTTOM;
      } else if (sunElevation > 0) {
        const t = sunElevation / 10;
        topColor = lerpColor(P.SKY_DUSK_TOP, P.SKY_DAY_TOP, t);
        bottomColor = lerpColor(P.SKY_DUSK_BOTTOM, P.SKY_DAY_BOTTOM, t);
      } else if (sunElevation > -6) {
        const t = (sunElevation + 6) / 6;
        topColor = lerpColor(P.SKY_NIGHT_TOP, P.SKY_DUSK_TOP, t);
        bottomColor = lerpColor(P.SKY_NIGHT_BOTTOM, P.SKY_DUSK_BOTTOM, t);
      } else {
        topColor = P.SKY_NIGHT_TOP;
        bottomColor = P.SKY_NIGHT_BOTTOM;
      }

      // Weather dimming
      const wb: Record<string, number> = { sunny: 1.0, cloudy: 0.75, rainy: 0.55, snowy: 0.65 };
      const brightness = wb[weather] ?? 1.0;
      if (brightness < 1.0) {
        topColor = lerpColor(topColor, 0x0a0a0a, 1 - brightness);
        bottomColor = lerpColor(bottomColor, 0x0a0a0a, 1 - brightness);
      }

      return { top: topColor, bottom: bottomColor };
    },

    /** Demo's cloud: one squashed 7-lobe blob with a bold ink outline —
     *  reads as a single confident pen shape, not a cluster of puffs. */
    drawCloud(gfx, cx, cy, w, _h, seed) {
      const s = w / 110; // demo blob is ~110px wide at scale 1
      gfx.fillStyle(P.CLOUD, 0.9);
      gfx.lineStyle(2.5, P.INK, 0.75);
      gfx.beginPath();
      const lobes = 7;
      for (let j = 0; j <= lobes * 8; j++) {
        const a = (j / (lobes * 8)) * Math.PI * 2;
        const r = (34 + Math.sin(a * lobes + seed) * 10 + wob(j * 9, seed) * 2) * s;
        const px = cx + Math.cos(a) * r * 1.6;
        const py = cy + Math.sin(a) * r * 0.62; // demo's squash — h is implied by w
        if (j === 0) gfx.moveTo(px, py); else gfx.lineTo(px, py);
      }
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    },

    /** Demo's mountain profile: two incommensurate sines + wobble around the
     *  base line — soft rolling ranges, not jagged peaks. The far layer is
     *  taller and lazier; the near one busier and lower. */
    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      const points: { x: number; y: number }[] = [];
      const s = layer === 'far' ? 5 + seed * 0.37 : 11 + seed * 0.37;
      const amp = skyH * (layer === 'far' ? 0.11 : 0.085);
      const freq = layer === 'far' ? 0.0016 : 0.003;
      for (let x = 0; x <= totalWidth; x += 6) {
        const y = baseY
          + Math.sin(x * freq + s) * amp
          + Math.sin(x * freq * 2.7 + s * 2) * amp * 0.45
          + wob(x, s) * 2;
        points.push({ x, y });
      }
      return points;
    },

    /** Demo's range drawing: a near-opaque fill with a bold 3px ink outline —
     *  the outline (0.35 far / 0.5 near) is what makes them read as DRAWN.
     *  (Weather passes seed 0 for the far layer, 1 for the near one.) */
    drawMountainSilhouette(gfx, points, color, bottomY, seed) {
      gfx.fillStyle(color, 0.9);
      gfx.lineStyle(3, P.INK, seed === 0 ? 0.35 : 0.5);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (const pt of points) gfx.lineTo(pt.x, pt.y);
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    },

    drawMoon(gfx, cx, cy, radius, phase, seed) {
      drawOrganicBlob(gfx, cx, cy, radius, seed, P.MOON, P.INK, 2);
    },

    /** Mustard ink-outlined disc with twelve radiating pen strokes — the
     *  demo's hand-drawn sun. Replaces the (style-gated-off) Preetham sky
     *  as the only daytime sun. */
    drawSun(gfx, cx, cy, radius, seed) {
      gfx.fillStyle(P.SUN, 1);
      gfx.fillCircle(cx, cy, radius);
      gfx.lineStyle(3, P.INK, 0.8);
      gfx.strokeCircle(cx, cy, radius);

      gfx.lineStyle(2.5, P.INK, 0.7);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.2;
        const r1 = radius + 7 + seededRandom(seed + i) * 3;
        const r2 = r1 + 9 + seededRandom(seed + i * 31) * 6;
        gfx.lineBetween(
          cx + Math.cos(a) * r1, cy + Math.sin(a) * r1,
          cx + Math.cos(a) * r2, cy + Math.sin(a) * r2,
        );
      }
    },

    drawStar(gfx, x, y, size, brightness, seed) {
      // Slightly larger stars than plastic
      const starSize = size * 1.3;
      gfx.fillStyle(0xffffff, brightness);
      gfx.fillCircle(x, y, starSize);

      // 10% chance of cross-star sparkle
      if (seededRandom(seed) < 0.1) {
        gfx.lineStyle(0.5, 0xffffff, brightness * 0.6);
        const armLen = starSize * 2.5;
        gfx.lineBetween(x - armLen, y, x + armLen, y);
        gfx.lineBetween(x, y - armLen, x, y + armLen);
      }
    },

    // ── Cyclist (64×64 rubber-hose style) ──

    getCyclistFrameSize() {
      return { w: CYCLIST_W, h: CYCLIST_H };
    },

    /** The demo's ink noodle rider, ported 1:1 — big 3.5px ink wheels with
     *  rotating spokes, a solid red watercolour jersey patch, straight noodle
     *  limbs, cream head under a leather half-cap, one ink-dot eye. The pose
     *  params map to small offsets so the pose system still reads (standing
     *  rocks the body, aero leans it, headTilt nods the head). */
    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const cx = ox + CYCLIST_W / 2;
      const groundY = CYCLIST_H - 2;
      const R = 11;                    // demo wheel radius
      const axleY = groundY - R;       // demo's origin: the wheel axle line
      const pedalAngle = (frame / FRAME_COUNT) * Math.PI * 2;
      const rock = params.rockAmplitude * Math.sin(pedalAngle);
      const lift = params.hipOffsetY * 0.6;
      const lean = Math.sin(params.torsoAngle * (Math.PI / 180)) * 6;
      const X = (dx: number) => cx + dx;
      const Y = (dy: number) => axleY + dy;

      const bodyHex = `#${P.CYCLIST_BODY.toString(16).padStart(6, '0')}`;
      const skinHex = `#${P.CYCLIST_SKIN.toString(16).padStart(6, '0')}`;
      const capHex = `#${P.CYCLIST_HELMET.toString(16).padStart(6, '0')}`;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // ── Wheels + rotating spokes ──
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 3.5;
      for (const wx of [-15, 15]) {
        ctx.beginPath(); ctx.arc(X(wx), Y(0), R, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.lineWidth = 2;
      for (const wx of [-15, 15]) {
        for (let i = 0; i < 4; i++) {
          const a = pedalAngle + (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(X(wx), Y(0));
          ctx.lineTo(X(wx) + Math.cos(a) * (R - 2), Y(0) + Math.sin(a) * (R - 2));
          ctx.stroke();
        }
      }

      // ── Frame ──
      ctx.lineWidth = 3;
      const seg = (x1: number, y1: number, x2: number, y2: number) => {
        ctx.beginPath(); ctx.moveTo(X(x1), Y(y1)); ctx.lineTo(X(x2), Y(y2)); ctx.stroke();
      };
      seg(-15, 0, 0, -3);
      seg(0, -3, 15, 0);
      seg(0, -3, -4, -14);
      seg(15, 0, 10, -15);

      // ── Noodle legs (two phases of the same pedal circle) ──
      ctx.lineWidth = 3;
      const hipY = -13 - lift;
      seg(-2, hipY, Math.cos(pedalAngle) * 7, -3 + Math.sin(pedalAngle) * 7);
      seg(-2, hipY, -Math.cos(pedalAngle) * 7, -3 - Math.sin(pedalAngle) * 7);

      // ── Jersey: solid red watercolour patch, ink outlined ──
      const quad: [number, number][] = [
        [-6 + rock, -14 - lift],
        [2 + rock + lean, -28 - lift],
        [9 + rock + lean, -24 - lift],
        [4 + rock, -12 - lift],
      ];
      ctx.fillStyle = bodyHex;
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(X(quad[0][0]), Y(quad[0][1]));
      for (let i = 1; i < quad.length; i++) ctx.lineTo(X(quad[i][0]), Y(quad[i][1]));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // ── Arm to the bars ──
      ctx.lineWidth = 3;
      seg(5 + rock + lean, -24 - lift, 11, -16);

      // ── Head: cream disc + leather half-cap + ink-dot eye ──
      const hx = X(6 + rock + lean);
      const hy = Y(-33 - lift + params.headTilt);
      ctx.fillStyle = skinHex;
      ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = capHex;
      ctx.beginPath(); ctx.arc(hx, hy - 2, 7.5, Math.PI, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = INK_HEX;
      ctx.beginPath(); ctx.arc(hx + 2.5, hy, 1.8, 0, Math.PI * 2); ctx.fill();
    },

    getCyclistZone5Tint(isDarkened) {
      if (!isDarkened) return null;
      // Warm red-brown pulsing instead of neon red
      const pulse = Math.sin(Date.now() * 0.008) * 0.5 + 0.5;
      return pulse > 0.5 ? 0xc44a3a : 0xa03828;
    },

    // ── Coins ──

    getCoinSize() {
      return COIN_SIZE;
    },

    drawCoinTexture(ctx, cx, cy, size, seed) {
      const coinHex = `#${P.COIN_GOLD.toString(16).padStart(6, '0')}`;
      const highlightHex = `#${P.COIN_HIGHLIGHT.toString(16).padStart(6, '0')}`;

      // Dark gold fill
      ctx.fillStyle = coinHex;
      ctx.beginPath();
      ctx.arc(cx, cy, size - 1, 0, Math.PI * 2);
      ctx.fill();

      // Highlight
      ctx.fillStyle = highlightHex;
      ctx.beginPath();
      ctx.arc(cx - 2, cy - 2, size * 0.4, 0, Math.PI * 2);
      ctx.fill();

      // Five-pointed star instead of dollar sign
      ctx.fillStyle = INK_HEX;
      const starR = size * 0.35;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const outerAngle = (i * 2 * Math.PI / 5) - Math.PI / 2;
        const innerAngle = outerAngle + Math.PI / 5;
        const ox = cx + Math.cos(outerAngle) * starR;
        const oy = cy + Math.sin(outerAngle) * starR;
        const ix = cx + Math.cos(innerAngle) * starR * 0.4;
        const iy = cy + Math.sin(innerAngle) * starR * 0.4;
        if (i === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
      ctx.fill();

      // Ink outline
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, size - 1, 0, Math.PI * 2);
      ctx.stroke();

      // Shadow hatch on bottom-right
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, size - 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.15;
      for (let d = 0; d < size * 2; d += 3) {
        ctx.beginPath();
        ctx.moveTo(cx + d - size, cy + size);
        ctx.lineTo(cx + d, cy);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'Georgia, "Noto Sans TC", serif';
    },

    drawFlag(gfx, x, y, color, label, seed) {
      const poleH = 45;
      const flagW = 18;
      const flagH = 12;

      // Wobbly pole
      drawInkLine(gfx, x, y, x + (seededRandom(seed) - 0.5) * 2, y - poleH, seed, 2.5, P.INK);

      // Triangular pennant flag
      gfx.fillStyle(color, 0.85);
      gfx.fillTriangle(
        x, y - poleH,
        x + flagW, y - poleH + flagH / 2,
        x, y - poleH + flagH,
      );

      // Flag ink outline
      gfx.lineStyle(1.5, P.INK, 0.8);
      gfx.beginPath();
      gfx.moveTo(x, y - poleH);
      gfx.lineTo(x + flagW, y - poleH + flagH / 2);
      gfx.lineTo(x, y - poleH + flagH);
      gfx.closePath();
      gfx.strokePath();

      // Hatch on flag
      drawSimpleHatch(gfx, x, y - poleH, flagW, flagH, P.INK, 0.1, 3);
    },

    // ── Wind particles ──

    getWindParticleColor() {
      return P.WIND_COLOR;
    },

    getWindParticleAlpha() {
      return P.WIND_ALPHA;
    },
  };
}

// ── Helper ──

function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;
  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return (r << 16) | (g << 8) | b;
}
