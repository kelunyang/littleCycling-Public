/**
 * Plastic style strategy — neon Tetris.
 *
 * The 2D counterpart of the 3D plastic world's quantized brick terrain: the
 * ground is a wall of stacked tetromino blocks glowing against a dark grid,
 * buildings are block towers, and the world *drops into place* on entry.
 *
 * Glow is faked with layered strokes (dark fill → bright inner stroke → two
 * fading outer strokes), not postFX — one Graphics, no extra render targets.
 *
 * Colour source: `styles/themes.scss` `$plastic` map (`--pl-*`). Canvas/JS
 * can't read CSS vars, so these are MIRRORED values — change themes.scss and
 * sync here (see CLAUDE.md 主題配色規範). ORANGE and BLUE below complete the
 * seven tetromino colours and have no themes.scss counterpart yet.
 */

import type Phaser from 'phaser';
import { INTRO_DURATION_S, type PhaserStyleStrategy } from './phaser-style-strategy';

// ── Tetromino palette (mirrors themes.scss $plastic unless noted) ──

const T_CYAN = 0x00d8ff;   // --pl-cyan    (I)
const T_YELLOW = 0xffea00; // --pl-yellow  (O)
const T_PURPLE = 0xd500f9; // --pl-purple  (T)
const T_GREEN = 0x76ff03;  // --pl-green   (S)
const T_ORANGE = 0xff8c1a; // no themes.scss token — tetromino L
const T_BLUE = 0x2979ff;   // no themes.scss token — tetromino J
const T_PINK = 0xff3b8d;   // --pl-pink    (Z)

/** The seven block colours, cycled across the terrain surface. */
const NEON: readonly number[] = [T_CYAN, T_YELLOW, T_PURPLE, T_GREEN, T_ORANGE, T_BLUE, T_PINK];

/** Grid cell size — terrain, buildings and the backdrop grid all share it. */
const TILE = 24;
/** How many rows of the terrain surface get the bright tetromino treatment;
 *  everything below is the cheap unlit "bedrock" fill. */
const SURFACE_ROWS = 2;

/** Entrance animation: how far each column falls, and how long its fall takes. */
const DROP_HEIGHT_PX = 520;
const DROP_FALL_S = 0.5;

const DEEP_FILL = 0x1a1035;  // bedrock body (between --pl-page-lo and --pl-ink)
const DEEP_LINE = 0x2d2260;  // bedrock grid lines
const NIGHT_BG = 0x0a081a;   // --pl-page-lo
const DAY_BG = 0x261a55;     // --pl-page-hi

// ── Palette ──

const PALETTE = {
  terrainFill: DEEP_FILL,
  terrainOutline: T_CYAN,
  ink: 0x1a1140,           // --pl-ink
  skyDayTop: 0x1d1545,
  skyDayBottom: DAY_BG,
  buildingColors: [...NEON],
  treeTrunk: 0x2d2260,
  treeCanopy: T_GREEN,
  treeCanopyColors: [
    T_GREEN,
    0x00c853, // --pl-green-deep
    T_CYAN,
    T_PURPLE,
  ],
  waterFill: 0x2979ff,
  waterOutline: T_CYAN,
  grassOverlay: T_GREEN,
  lampPost: 0x2d2260,
  lampGlow: T_YELLOW,
  mountainFar: 0x2a1e5c,
  mountainNear: 0x3a2a72,
  cloud: 0x6a5acd,
  moon: 0xe8e0ff,
  coinGold: T_YELLOW,
  coinHighlight: 0xffffff,
  coinOutline: 0xffb300, // --pl-amber
  markerTick: T_CYAN,
  fogColor: 0x3a2a72,
  cyclistBody: 0xffffff,
  cyclistHelmet: T_YELLOW,
  cyclistSkin: 0xffcc80,
} as const;

// ── Block drawing ──

function darken(color: number, f: number): number {
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/** One glowing tetromino cell at grid position (x, y), size px. */
function neonCell(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number, size: number, color: number, alpha: number,
) {
  gfx.fillStyle(darken(color, 0.24), alpha);
  gfx.fillRect(x + 1, y + 1, size - 2, size - 2);
  gfx.lineStyle(4, color, 0.22 * alpha);   // outer bloom
  gfx.strokeRect(x, y, size, size);
  gfx.lineStyle(2, color, 0.95 * alpha);   // bright edge
  gfx.strokeRect(x + 2, y + 2, size - 4, size - 4);
  gfx.lineStyle(1, 0xffffff, 0.5 * alpha); // top highlight
  gfx.lineBetween(x + 3, y + 3, x + size - 3, y + 3);
}

/** Deterministic 0..1 from any number — same block, same colour, every frame. */
function seeded(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Sample the terrain surface Y at world X by interpolating the profile points. */
function surfaceYAt(points: { x: number; y: number }[], x: number): number {
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

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// ── Cyclist constants ──

const CYCLIST_W = 48;
const CYCLIST_H = 48;
// Neon rider: cyan frame, pink rims, white-hot body, gold helmet.
const CYCLIST_COLORS = {
  helmet: '#ffea00',
  body: '#ffffff',
  skin: '#ffcc80',
  bike: '#00d8ff',
  wheel: '#ff3b8d',
  spoke: '#ffffff',
  pedal: '#d500f9',
};

// ── Coin constants ──

const COIN_SIZE = 12;

// ── Strategy implementation ──

export function createPlasticStyle(): PhaserStyleStrategy {
  return {
    style: 'plastic',
    palette: {
      ...PALETTE,
      buildingColors: [...PALETTE.buildingColors] as number[],
      treeCanopyColors: [...PALETTE.treeCanopyColors] as number[],
    },

    // ── Terrain ──

    /** Objects stand on top of the drawn block row (top edge of the surface
     *  cell, 1px above the highlight line) — mirrors drawTerrainSurface's
     *  floor() quantisation so the rider never sinks into a block. */
    snapGroundY(y) {
      return Math.floor(y / TILE) * TILE - 1;
    },

    /**
     * Terrain as stacked tetromino columns.
     *
     * Two layers: a single dark bedrock polygon (cheap, covers everything down
     * to the view bottom) topped by SURFACE_ROWS of glowing blocks. Only the
     * top rows pay the multi-stroke glow cost, so the draw-call count tracks
     * the visible column count, not the terrain depth.
     *
     * Intro: each column drops in from above, delayed by its distance from
     * `intro.originX` — a Tetris piece falling into place, left to right.
     */
    drawTerrainSurface(gfx, points, bottomY, _seed, intro) {
      if (points.length < 2) return;

      const col0 = Math.floor(points[0].x / TILE);
      const col1 = Math.ceil(points[points.length - 1].x / TILE);
      const originCol = intro ? Math.floor(intro.originX / TILE) : 0;

      /** Falling offset for a column during the intro (0 once it has landed).
       *  The delay is capped so that even a column that scrolled into view late
       *  (fast rider, wide screen) still lands before the intro window closes —
       *  otherwise it would snap down the frame the intro ends. */
      const dropOffset = (col: number): number => {
        if (!intro) return 0;
        const delay = Math.min(
          Math.max(0, col - originCol) * 0.035,
          INTRO_DURATION_S - DROP_FALL_S - 0.1,
        );
        const k = easeOutCubic((intro.t - delay) / DROP_FALL_S);
        return -(1 - k) * DROP_HEIGHT_PX;
      };

      // Precompute each column's top row + drop, used by both layers below.
      const cols: { col: number; topRow: number; off: number }[] = [];
      for (let col = col0; col <= col1; col++) {
        const x = col * TILE;
        cols.push({
          col,
          topRow: Math.floor(surfaceYAt(points, x) / TILE),
          off: dropOffset(col),
        });
      }

      // ── Bedrock: one polygon + faint grid ──
      gfx.fillStyle(DEEP_FILL, 1);
      gfx.beginPath();
      gfx.moveTo(col0 * TILE, bottomY);
      for (const c of cols) {
        const y = (c.topRow + SURFACE_ROWS) * TILE + c.off;
        gfx.lineTo(c.col * TILE, y);
        gfx.lineTo(c.col * TILE + TILE, y);
      }
      gfx.lineTo((col1 + 1) * TILE, bottomY);
      gfx.closePath();
      gfx.fillPath();

      gfx.lineStyle(1, DEEP_LINE, 0.5);
      for (const c of cols) {
        const y = (c.topRow + SURFACE_ROWS) * TILE + c.off;
        gfx.lineBetween(c.col * TILE, y, c.col * TILE, bottomY);
      }
      // Horizontal bedrock courses, from the shallowest surface down.
      const minTopRow = Math.min(...cols.map((c) => c.topRow));
      for (let y = (minTopRow + SURFACE_ROWS) * TILE; y < bottomY; y += TILE) {
        gfx.lineBetween(col0 * TILE, y, (col1 + 1) * TILE, y);
      }

      // ── Surface: glowing tetromino blocks ──
      for (const c of cols) {
        for (let r = 0; r < SURFACE_ROWS; r++) {
          const row = c.topRow + r;
          // Colour by grid position, not by index — the pattern stays put on
          // the world as the camera scrolls.
          const color = NEON[(((c.col % 7) + (row % 7) * 3) % 7 + 7) % 7];
          neonCell(gfx, c.col * TILE, row * TILE + c.off, TILE, color, r === 0 ? 1 : 0.55);
        }
      }
    },

    /** Neon grid backdrop — sits over the sky, behind the terrain, and drifts
     *  at a slight parallax so speed reads even against an empty horizon. */
    drawBackdrop(scene) {
      const w = scene.scale.width;
      const h = scene.scale.height;
      const key = '__plastic_grid__';

      if (!scene.textures.exists(key)) {
        const tex = scene.textures.createCanvas(key, TILE, TILE);
        if (!tex) return null;
        const ctx = tex.getContext();
        ctx.clearRect(0, 0, TILE, TILE);
        ctx.strokeStyle = 'rgba(0,216,255,1)'; // --pl-cyan
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(TILE - 0.5, 0); ctx.lineTo(TILE - 0.5, TILE);
        ctx.moveTo(0, TILE - 0.5); ctx.lineTo(TILE, TILE - 0.5);
        ctx.stroke();
        tex.refresh();
      }

      // 2× overscan — the camera-lift zoom scales scrollFactor'd layers too.
      // Screen-fixed; the parallax comes from the scene scrolling the TEXTURE
      // (see updateBackdrop in phaser2d-scene). A scrollFactor'd sprite would
      // physically slide off screen a couple of km into the ride.
      const grid = scene.add.tileSprite(-w * 0.5, -h * 0.5, w * 2, h * 2, key);
      grid.setOrigin(0);
      grid.setScrollFactor(0);
      grid.setData('parallax', 0.15);
      grid.setDepth(-80); // sky is -100, terrain 0
      grid.setAlpha(0.09);
      return grid;
    },

    drawOverlay(scene) {
      // scale.width/height 跟隨 resize;game.config 是建立當下的尺寸,永不更新
      const w = scene.scale.width;
      const h = scene.scale.height;
      const gfx = scene.add.graphics();
      gfx.setScrollFactor(0);
      gfx.setDepth(999);

      // CRT scanlines — 2× overscan so the camera-lift zoom-out (which also
      // scales scrollFactor(0) layers) never exposes unfiltered edges.
      gfx.fillStyle(0x000000, 0.06);
      for (let y = -Math.ceil(h * 0.5); y < h * 1.5; y += 3) {
        gfx.fillRect(-w * 0.5, y, w * 2, 1);
      }

      return gfx;
    },

    // No per-frame overlay update needed for CRT
    updateOverlay: undefined,

    // ── Background features ──

    /** Building as a tetromino tower: the box is snapped to the terrain grid
     *  and filled with 2×2 clumps of one colour each, so it reads as stacked
     *  pieces rather than a pixel grid. Windows are lit cells. */
    renderBuilding(gfx, x, y, w, h, colorIndex, seed) {
      const cols = Math.max(1, Math.round(w / TILE));
      const rows = Math.max(2, Math.round(h / TILE));
      // Snap the footprint to the world grid so towers line up with the ground.
      const baseCol = Math.round(x / TILE);
      const groundRow = Math.round((y + h) / TILE);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const col = baseCol + c;
          const row = groundRow - 1 - r;
          // 2×2 clumps share a colour → tetromino-shaped patches up the tower.
          const piece = colorIndex + Math.floor(r / 2) * 3 + Math.floor(c / 2);
          const color = NEON[((piece % 7) + 7) % 7];
          neonCell(gfx, col * TILE, row * TILE, TILE, color, 0.8);

          // Lit window — deterministic per cell.
          if (seeded(col * 7 + row * 13 + seed) > 0.55) {
            gfx.fillStyle(0xffffff, 0.85);
            gfx.fillRect(col * TILE + TILE / 2 - 2, row * TILE + TILE / 2 - 2, 4, 4);
          }
        }
      }
    },

    /** Tree as a small block stack: a 1-cell trunk under a 2–3 cell crown. */
    renderTree(gfx, x, y, _size, seed) {
      const half = TILE / 2;
      const col = Math.round(x / half);
      const groundRow = Math.round(y / half);
      const canopyColor = PALETTE.treeCanopyColors[seed % PALETTE.treeCanopyColors.length];
      const tall = seed % 2 === 0;

      // Trunk (half-tile blocks — full tiles would dwarf the buildings)
      neonCell(gfx, col * half, (groundRow - 1) * half, half, T_PURPLE, 0.7);
      // Crown
      neonCell(gfx, col * half, (groundRow - 2) * half, half, canopyColor, 0.95);
      neonCell(gfx, (col - 1) * half, (groundRow - 2) * half, half, canopyColor, 0.75);
      neonCell(gfx, (col + 1) * half, (groundRow - 2) * half, half, canopyColor, 0.75);
      if (tall) {
        neonCell(gfx, col * half, (groundRow - 3) * half, half, canopyColor, 0.9);
      }
    },

    renderWater(gfx, x, y, _w, h, _seed) {
      const waterWidth = 60;

      // Glowing pool: dark body + bright surface line
      gfx.fillStyle(darken(PALETTE.waterFill, 0.4), 0.75);
      gfx.fillRect(x - waterWidth / 2, y, waterWidth, h);
      gfx.lineStyle(4, PALETTE.waterOutline, 0.2);
      gfx.lineBetween(x - waterWidth / 2, y, x + waterWidth / 2, y);
      gfx.lineStyle(2, PALETTE.waterOutline, 0.9);
      gfx.lineBetween(x - waterWidth / 2, y, x + waterWidth / 2, y);

      return { x, y, w: waterWidth };
    },

    renderGrass(gfx, x, y, _w, _h, _seed) {
      // A run of glowing studs along the surface rather than a flat band.
      gfx.fillStyle(PALETTE.grassOverlay, 0.5);
      for (let i = -12; i <= 12; i += 6) {
        gfx.fillRect(x + i, y - 3, 3, 3);
      }
      gfx.fillStyle(PALETTE.grassOverlay, 0.15);
      gfx.fillRect(x - 15, y - 2, 30, 4);
    },

    /** Sand: amber studs, dimmer and sparser than grass. */
    renderSand(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(0xffb300, 0.45); // --pl-amber
      for (let i = -18; i <= 18; i += 8) {
        if (seeded(seed + i) < 0.25) continue;
        gfx.fillRect(x + i, y - 3, 3, 3);
      }
      gfx.fillStyle(0xffb300, 0.12);
      gfx.fillRect(x - 20, y - 2, 40, 4);
    },

    /** Urban: a quiet row of dark cell shadows under the neon towers. */
    renderUrban(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(DEEP_LINE, 0.35);
      for (let i = -30; i <= 30; i += 10) {
        if (seeded(seed + i * 3) < 0.3) continue;
        gfx.fillRect(x + i, y - 2, 6, 3);
      }
    },

    /** Waterway: same glowing pool as renderWater, narrower. */
    renderWaterway(gfx, x, y, w, h, _seed) {
      gfx.fillStyle(darken(PALETTE.waterFill, 0.4), 0.75);
      gfx.fillRect(x - w / 2, y, w, h);
      gfx.lineStyle(4, PALETTE.waterOutline, 0.2);
      gfx.lineBetween(x - w / 2, y, x + w / 2, y);
      gfx.lineStyle(2, PALETTE.waterOutline, 0.9);
      gfx.lineBetween(x - w / 2, y, x + w / 2, y);
      return { x, y, w };
    },

    /** Aeroway: dark concrete block strip with a glowing centreline. */
    renderAeroway(gfx, x, y, w, kind, _seed) {
      const half = w / 2;
      const stripH = TILE / 2;
      gfx.fillStyle(0x2a2a3e, 0.9);
      gfx.fillRect(x - half, y - stripH, w, stripH);
      gfx.lineStyle(1, T_CYAN, 0.4);
      gfx.strokeRect(x - half, y - stripH, w, stripH);
      // Centreline dashes — runway gets the bold neon treatment
      gfx.fillStyle(T_YELLOW, kind === 'runway' ? 0.9 : 0.5);
      for (let i = -half + 4; i < half - 8; i += 16) {
        gfx.fillRect(x + i, y - stripH / 2 - 1, 8, 2);
      }
    },

    /** Road: a half-tile asphalt band riding the block tops, with neon lane
     *  dashes — paved stretches read against the raw tetromino ground. */
    renderRoadSurface(gfx, points, _seed) {
      const H = TILE / 2;
      // Asphalt band
      gfx.fillStyle(0x11101f, 0.85);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y);
      for (const p of points) gfx.lineTo(p.x, p.y);
      for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + H);
      gfx.closePath();
      gfx.fillPath();
      // Edge glow
      gfx.lineStyle(1, T_CYAN, 0.35);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + 1);
      for (const p of points) gfx.lineTo(p.x, p.y + 1);
      gfx.strokePath();
      // Lane dashes
      gfx.fillStyle(T_YELLOW, 0.8);
      for (let i = 0; i < points.length; i += 6) {
        const p = points[i];
        gfx.fillRect(p.x, p.y + H / 2 - 1, 10, 2);
      }
    },

    renderRoadLamp(gfx, x, y, seed) {
      const poleH = 35 + (seed % 10);
      const armW = 8;

      // Pole
      gfx.fillStyle(PALETTE.lampPost, 1);
      gfx.fillRect(x - 1, y - poleH, 2, poleH);

      // Arm (horizontal)
      gfx.fillRect(x, y - poleH, armW, 2);

      // Lamp housing
      gfx.fillStyle(0x333333, 1);
      gfx.fillRect(x + armW - 3, y - poleH - 1, 6, 4);
    },

    renderRoadLampGlow(gfx, x, y, seed) {
      const poleH = 35 + (seed % 10);
      const armW = 8;

      // Glow circle
      gfx.fillStyle(PALETTE.lampGlow, 0.15);
      gfx.fillCircle(x + armW, y - poleH + 2, 18);
      gfx.fillStyle(PALETTE.lampGlow, 0.25);
      gfx.fillCircle(x + armW, y - poleH + 2, 8);

      // Light beam (small cone on ground)
      gfx.fillStyle(PALETTE.lampGlow, 0.06);
      gfx.fillTriangle(
        x + armW - 2, y - poleH + 4,
        x + armW + 2, y - poleH + 4,
        x + armW, y,
      );
    },

    // ── Sky / weather ──

    /** Always a dark arcade sky — daylight only shifts the violet up a notch,
     *  because neon needs something dark to glow against. */
    getSkyColors(sunElevation, weather) {
      let topColor: number;
      let bottomColor: number;

      if (sunElevation > 10) {
        topColor = 0x1d1545;
        bottomColor = DAY_BG;
      } else if (sunElevation > 0) {
        const t = sunElevation / 10;
        topColor = lerpColor(0x120c33, 0x1d1545, t);
        bottomColor = lerpColor(0x4a1f66, DAY_BG, t); // dusk magenta
      } else if (sunElevation > -6) {
        const t = (sunElevation + 6) / 6;
        topColor = lerpColor(0x07050f, 0x120c33, t);
        bottomColor = lerpColor(0x14103a, 0x4a1f66, t);
      } else if (sunElevation > -12) {
        const t = (sunElevation + 12) / 6;
        topColor = lerpColor(0x05030e, 0x07050f, t);
        bottomColor = lerpColor(NIGHT_BG, 0x14103a, t);
      } else {
        topColor = 0x05030e;
        bottomColor = NIGHT_BG;
      }

      // Weather brightness
      const wb: Record<string, number> = { sunny: 1.0, cloudy: 0.7, rainy: 0.5, snowy: 0.6 };
      const brightness = wb[weather] ?? 1.0;
      if (brightness < 1.0) {
        topColor = lerpColor(topColor, 0x000000, 1 - brightness);
        bottomColor = lerpColor(bottomColor, 0x000000, 1 - brightness);
      }

      return { top: topColor, bottom: bottomColor };
    },

    /** Cloud as a loose block cluster — a drifting tetromino, basically.
     *  (The caller sets the base fill colour before calling.) */
    drawCloud(gfx, cx, cy, w, h, seed) {
      const unit = Math.max(6, Math.round(w / 5));
      const cells: [number, number][] = [[0, 0], [1, 0], [2, 0], [1, -1], [2, -1], [3, 0]];
      for (const [gx, gy] of cells) {
        if (seeded(seed + gx * 3 + gy * 7) < 0.15) continue; // ragged edge
        gfx.fillRect(cx - w * 0.4 + gx * unit, cy + gy * unit - h * 0.1, unit - 1, unit - 1);
      }
      gfx.fillStyle(0xffffff, 0.18);
      gfx.fillRect(cx - w * 0.4, cy - h * 0.1, unit - 1, 2);
    },

    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      // Use seed to vary phase offsets so mountains look different each session
      const s1 = Math.sin(seed * 0.1) * 3;
      const s2 = Math.sin(seed * 0.17) * 2;
      const s3 = Math.sin(seed * 0.31) * 4;
      const points: { x: number; y: number }[] = [];
      if (layer === 'far') {
        for (let x = 0; x <= totalWidth; x += 4) {
          const y = baseY
            - Math.sin(x * 0.003 + s1) * skyH * 0.12
            - Math.sin(x * 0.0071 + 1.3 + s2) * skyH * 0.08
            - Math.sin(x * 0.0023 + 2.7 + s3) * skyH * 0.06
            - Math.max(0, Math.sin(x * 0.0011 + s1 * 0.5) * skyH * 0.1);
          points.push({ x, y });
        }
      } else {
        for (let x = 0; x <= totalWidth; x += 4) {
          const y = baseY
            - Math.abs(Math.sin(x * 0.002 + 0.5 + s1)) * skyH * 0.08
            - Math.abs(Math.sin(x * 0.005 + 1.1 + s2)) * skyH * 0.05;
          points.push({ x, y });
        }
      }
      return points;
    },

    /** Distant skyline: flat-topped silhouette + a glowing cyan ridge line,
     *  so the horizon reads as more blocks rather than rolling hills. */
    drawMountainSilhouette(gfx, points, color, bottomY, _seed) {
      // Quantise the ridge to the grid — the far city is blocks too.
      const stepped = points.map((p) => ({ x: p.x, y: Math.round(p.y / TILE) * TILE }));

      gfx.fillStyle(color, 0.8);
      gfx.beginPath();
      gfx.moveTo(stepped[0].x, bottomY);
      let prevY = stepped[0].y;
      for (const pt of stepped) {
        if (pt.y !== prevY) gfx.lineTo(pt.x, prevY); // square the step
        gfx.lineTo(pt.x, pt.y);
        prevY = pt.y;
      }
      gfx.lineTo(stepped[stepped.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();

      gfx.lineStyle(1.5, T_CYAN, 0.25);
      gfx.beginPath();
      gfx.moveTo(stepped[0].x, stepped[0].y);
      prevY = stepped[0].y;
      for (const pt of stepped) {
        if (pt.y !== prevY) gfx.lineTo(pt.x, prevY);
        gfx.lineTo(pt.x, pt.y);
        prevY = pt.y;
      }
      gfx.strokePath();
    },

    drawMoon(gfx, cx, cy, radius, phase, _seed) {
      const brightness = 0.3 + 0.7 * Math.abs(phase - 0.5) * 2;
      gfx.fillStyle(PALETTE.moon, brightness);
      gfx.fillCircle(cx, cy, radius);

      if (phase < 0.45 || phase > 0.55) {
        const shadowOffset = (phase < 0.5 ? 1 : -1) * radius * 0.8;
        // Shadow uses sky-matching color — caller should set appropriate color
        gfx.fillCircle(cx + shadowOffset, cy, radius * 0.9);
      }
    },

    drawStar(gfx, x, y, size, brightness, _seed) {
      gfx.fillStyle(0xffffff, brightness);
      gfx.fillCircle(x, y, size);
    },

    // ── Cyclist ──

    getCyclistFrameSize() {
      return { w: CYCLIST_W, h: CYCLIST_H };
    },

    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const cx = ox + CYCLIST_W / 2;
      const groundY = CYCLIST_H - 2;
      const FRAME_COUNT = 6;

      const rockOffset = params.rockAmplitude * Math.sin((frame / FRAME_COUNT) * Math.PI * 2);
      const pedalAngle = (frame / FRAME_COUNT) * Math.PI * 2;

      // ── Bicycle ──
      const wheelR = 8;
      const wheelY = groundY - wheelR;
      const rearWheelX = cx - 8;
      const frontWheelX = cx + 10;
      const bbX = cx;
      const bbY = wheelY - 4;

      // Wheels
      ctx.strokeStyle = CYCLIST_COLORS.wheel;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rearWheelX, wheelY, wheelR, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(frontWheelX, wheelY, wheelR, 0, Math.PI * 2); ctx.stroke();

      // Spokes
      ctx.strokeStyle = CYCLIST_COLORS.spoke;
      ctx.lineWidth = 0.5;
      for (let s = 0; s < 4; s++) {
        const sa = (s / 4) * Math.PI * 2 + pedalAngle;
        ctx.beginPath(); ctx.moveTo(rearWheelX, wheelY);
        ctx.lineTo(rearWheelX + Math.cos(sa) * wheelR, wheelY + Math.sin(sa) * wheelR); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(frontWheelX, wheelY);
        ctx.lineTo(frontWheelX + Math.cos(sa) * wheelR, wheelY + Math.sin(sa) * wheelR); ctx.stroke();
      }

      // Frame
      ctx.strokeStyle = CYCLIST_COLORS.bike;
      ctx.lineWidth = 2;
      const seatX = cx - 3;
      const seatY = bbY - 14;
      ctx.beginPath(); ctx.moveTo(bbX, bbY); ctx.lineTo(seatX, seatY); ctx.stroke();
      const headX = cx + 6;
      const headY = bbY - 12;
      ctx.beginPath(); ctx.moveTo(bbX, bbY); ctx.lineTo(headX, headY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(seatX, seatY); ctx.lineTo(headX, headY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bbX, bbY); ctx.lineTo(rearWheelX, wheelY); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(seatX, seatY); ctx.lineTo(rearWheelX, wheelY); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(headX, headY); ctx.lineTo(frontWheelX, wheelY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(headX - 2, headY - 2); ctx.lineTo(headX + 4, headY - 3); ctx.stroke();

      // ── Pedals + cranks ──
      const crankR = 5;
      const pedalR1X = bbX + Math.cos(pedalAngle) * crankR;
      const pedalR1Y = bbY + Math.sin(pedalAngle) * crankR;
      const pedalR2X = bbX + Math.cos(pedalAngle + Math.PI) * crankR;
      const pedalR2Y = bbY + Math.sin(pedalAngle + Math.PI) * crankR;

      ctx.strokeStyle = CYCLIST_COLORS.pedal;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(pedalR1X, pedalR1Y); ctx.lineTo(pedalR2X, pedalR2Y); ctx.stroke();
      ctx.fillStyle = CYCLIST_COLORS.pedal;
      ctx.fillRect(pedalR1X - 2, pedalR1Y - 1, 4, 2);
      ctx.fillRect(pedalR2X - 2, pedalR2Y - 1, 4, 2);

      // ── Rider body ──
      const hipX = seatX + rockOffset;
      const hipY = seatY - params.hipOffsetY;

      const torsoRad = params.torsoAngle * (Math.PI / 180);
      const torsoLen = 14;
      const shoulderX = hipX + Math.sin(torsoRad) * torsoLen * 0.6 + rockOffset * 0.5;
      const shoulderY = hipY - Math.cos(torsoRad) * torsoLen;

      // Legs
      ctx.strokeStyle = CYCLIST_COLORS.body;
      ctx.lineWidth = 2.5;
      const kneeR1X = (hipX + pedalR1X) / 2 + 3;
      const kneeR1Y = (hipY + pedalR1Y) / 2 + 2;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(kneeR1X, kneeR1Y); ctx.lineTo(pedalR1X, pedalR1Y); ctx.stroke();
      const kneeR2X = (hipX + pedalR2X) / 2 + 3;
      const kneeR2Y = (hipY + pedalR2Y) / 2 + 2;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(kneeR2X, kneeR2Y); ctx.lineTo(pedalR2X, pedalR2Y); ctx.stroke();

      // Torso
      ctx.strokeStyle = CYCLIST_COLORS.body;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(shoulderX, shoulderY); ctx.stroke();

      // Arms
      ctx.lineWidth = 2;
      ctx.strokeStyle = CYCLIST_COLORS.skin;
      ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX + 1, headY - 2); ctx.stroke();

      // Head
      const headCX = shoulderX - 1;
      const headCY = shoulderY - 5 + params.headTilt;
      ctx.fillStyle = CYCLIST_COLORS.helmet;
      ctx.beginPath(); ctx.arc(headCX, headCY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CYCLIST_COLORS.skin;
      ctx.beginPath(); ctx.arc(headCX + 1, headCY + 1, 2, 0, Math.PI * 2); ctx.fill();
    },

    getCyclistZone5Tint(isDarkened) {
      if (!isDarkened) return null;
      const flash = Math.sin(Date.now() * 0.01) > 0;
      return flash ? 0xff3333 : 0xcc2222;
    },

    // ── Coins ──

    getCoinSize() {
      return COIN_SIZE;
    },

    /** Coin as a glowing O-piece: a yellow block with a bright rim.
     *  The canvas is size×2 square, so the block half-extent leaves 2 px for
     *  the outer bloom stroke to sit inside the texture. */
    drawCoinTexture(ctx, cx, cy, size, _seed) {
      const s = size - 2;
      // Outer bloom
      ctx.strokeStyle = 'rgba(255,234,0,0.25)';
      ctx.lineWidth = 4;
      ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
      // Dark body (glow reads against it)
      ctx.fillStyle = '#3d3800';
      ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
      // Bright edge
      ctx.strokeStyle = '#ffea00';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - s + 1, cy - s + 1, s * 2 - 2, s * 2 - 2);
      // Inner stud + top highlight
      ctx.fillStyle = '#ffea00';
      ctx.fillRect(cx - s * 0.35, cy - s * 0.35, s * 0.7, s * 0.7);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - s + 2, cy - s + 2);
      ctx.lineTo(cx + s - 2, cy - s + 2);
      ctx.stroke();
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'Consolas, "Courier New", "Noto Sans TC", monospace';
    },

    /** Flag as a glowing block banner on a neon pole. */
    drawFlag(gfx, x, y, color, _label, _seed) {
      const flagH = 30;
      const flagW = 20;
      const poleH = flagH + 15;

      // Pole — glow + core
      gfx.lineStyle(4, T_CYAN, 0.2);
      gfx.lineBetween(x, y, x, y - poleH);
      gfx.lineStyle(2, T_CYAN, 0.9);
      gfx.lineBetween(x, y, x, y - poleH);

      // Banner: 5×4 px blocks, checkered brightness
      const cell = 5;
      for (let fy = 0; fy < flagH / 2; fy += cell) {
        for (let fx = 0; fx < flagW; fx += cell) {
          const on = (Math.floor(fx / cell) + Math.floor(fy / cell)) % 2 === 0;
          gfx.fillStyle(on ? color : darken(color, 0.35), on ? 1 : 0.85);
          gfx.fillRect(x + fx + 0.5, y - poleH + fy + 0.5, cell - 1, cell - 1);
        }
      }
      gfx.lineStyle(1, color, 0.5);
      gfx.strokeRect(x, y - poleH, flagW, flagH / 2);
    },

    // ── Wind particles ──

    getWindParticleColor() {
      return 0xffffff;
    },

    getWindParticleAlpha() {
      return 0.5;
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
