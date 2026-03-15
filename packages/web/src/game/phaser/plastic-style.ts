/**
 * Plastic style strategy — the original neon/flat cartoon visual style.
 *
 * Extracts all style-specific drawing code (colors, shapes, overlays)
 * from phaser2d-scene, terrain-builder, phaser-weather, cyclist-sprite,
 * and phaser-coin-layer into a single Strategy implementation.
 */

import type Phaser from 'phaser';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

// ── Palette ──

const PALETTE = {
  terrainFill: 0x4a7c3f,
  terrainOutline: 0x2d5a1e,
  ink: 0x1a1a2e,           // dark outline for buildings
  skyDayTop: 0x1a73e8,
  skyDayBottom: 0x87ceeb,
  buildingColors: [
    0xff3366, // neon pink
    0x00e5ff, // electric blue
    0x76ff03, // acid green
    0xffea00, // neon yellow
    0xd500f9, // neon purple
    0xff6d00, // neon orange
  ],
  treeTrunk: 0x5d4037,
  treeCanopy: 0x2e7d32,
  waterFill: 0x1565c0,
  waterOutline: 0x42a5f5,
  grassOverlay: 0x66bb6a,
  lampPost: 0x555555,
  lampGlow: 0xffea00,
  mountainFar: 0x4a6fa5,
  mountainNear: 0x4a6fa5,
  cloud: 0xcccccc,
  moon: 0xf5f5dc,
  coinGold: 0xffd700,
  coinHighlight: 0xffea00,
  coinOutline: 0xb8860b,
  markerTick: 0x00e5ff,
  fogColor: 0x8899aa,
  cyclistBody: 0xff3366,
  cyclistHelmet: 0x00e5ff,
  cyclistSkin: 0xffcc80,
} as const;

// ── Cyclist constants ──

const CYCLIST_W = 48;
const CYCLIST_H = 48;
const CYCLIST_COLORS = {
  helmet: '#00e5ff',
  body: '#ff3366',
  skin: '#ffcc80',
  bike: '#333333',
  wheel: '#666666',
  spoke: '#999999',
  pedal: '#444444',
};

// ── Coin constants ──

const COIN_SIZE = 12;

// ── Strategy implementation ──

export function createPlasticStyle(): PhaserStyleStrategy {
  return {
    style: 'plastic',
    palette: { ...PALETTE, buildingColors: [...PALETTE.buildingColors] as number[] },

    // ── Terrain ──

    drawTerrainSurface(gfx, points, bottomY, _seed) {
      // Fill
      gfx.beginPath();
      let started = false;
      for (const pt of points) {
        if (!started) { gfx.moveTo(pt.x, pt.y); started = true; }
        else gfx.lineTo(pt.x, pt.y);
      }
      if (!started) return;
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.lineTo(points[0].x, bottomY);
      gfx.closePath();
      gfx.fillStyle(PALETTE.terrainFill, 1);
      gfx.fillPath();

      // Outline
      gfx.lineStyle(2, PALETTE.terrainOutline, 1);
      gfx.beginPath();
      started = false;
      for (const pt of points) {
        if (!started) { gfx.moveTo(pt.x, pt.y); started = true; }
        else gfx.lineTo(pt.x, pt.y);
      }
      gfx.strokePath();
    },

    drawOverlay(scene) {
      const w = Number(scene.game.config.width);
      const h = Number(scene.game.config.height);
      const gfx = scene.add.graphics();
      gfx.setScrollFactor(0);
      gfx.setDepth(999);

      // CRT scanlines
      gfx.fillStyle(0x000000, 0.06);
      for (let y = 0; y < h; y += 3) {
        gfx.fillRect(0, y, w, 1);
      }

      // Vignette corners
      gfx.fillStyle(0x000000, 0.15);
      const cs = 80;
      gfx.fillTriangle(0, 0, cs, 0, 0, cs);
      gfx.fillTriangle(w, 0, w - cs, 0, w, cs);
      gfx.fillTriangle(0, h, cs, h, 0, h - cs);
      gfx.fillTriangle(w, h, w - cs, h, w, h - cs);

      return gfx;
    },

    // No per-frame overlay update needed for CRT
    updateOverlay: undefined,

    // ── Background features ──

    renderBuilding(gfx, x, y, w, h, colorIndex, _seed) {
      const color = PALETTE.buildingColors[colorIndex % PALETTE.buildingColors.length];

      // Body
      gfx.fillStyle(color, 0.85);
      gfx.fillRect(x, y, w, h);

      // Dark outline
      gfx.lineStyle(1, PALETTE.ink, 0.8);
      gfx.strokeRect(x, y, w, h);

      // Window grid
      gfx.fillStyle(0xffffff, 0.3);
      const winSize = 3;
      const winGap = 6;
      for (let wy = y + 5; wy < y + h - 5; wy += winGap) {
        for (let wx = x + 4; wx < x + w - 4; wx += winGap) {
          gfx.fillRect(wx, wy, winSize, winSize);
        }
      }
    },

    renderTree(gfx, x, y, size, seed) {
      const treeH = 18 + (seed % 12);
      const crownW = 12 + (seed % 8);
      const trunkH = 5 + (seed % 3);
      const trunkW = 3;

      // Trunk
      gfx.fillStyle(PALETTE.treeTrunk, 1);
      gfx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);

      // Crown (triangle)
      const crownBase = y - trunkH;
      const crownTop = crownBase - treeH + trunkH;
      gfx.fillStyle(PALETTE.treeCanopy, 1);
      gfx.fillTriangle(x, crownTop, x - crownW / 2, crownBase, x + crownW / 2, crownBase);

      // Highlight edge
      gfx.lineStyle(1, PALETTE.grassOverlay, 0.6);
      gfx.lineBetween(x, crownTop, x + crownW / 2, crownBase);
    },

    renderWater(gfx, x, y, w, h, _seed) {
      const waterWidth = 60;

      // Blue fill below terrain
      gfx.fillStyle(PALETTE.waterFill, 0.6);
      gfx.fillRect(x - waterWidth / 2, y, waterWidth, h);

      // Surface line
      gfx.lineStyle(2, PALETTE.waterOutline, 0.5);
      gfx.lineBetween(x - waterWidth / 2, y, x + waterWidth / 2, y);

      return { x, y, w: waterWidth };
    },

    renderGrass(gfx, x, y, _w, _h, _seed) {
      gfx.fillStyle(PALETTE.grassOverlay, 0.3);
      gfx.fillRect(x - 15, y - 2, 30, 4);
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

    getSkyColors(sunElevation, weather) {
      let topColor: number;
      let bottomColor: number;

      if (sunElevation > 10) {
        topColor = 0x1a73e8;
        bottomColor = 0x87ceeb;
      } else if (sunElevation > 0) {
        const t = sunElevation / 10;
        topColor = lerpColor(0x2d1b69, 0x1a73e8, t);
        bottomColor = lerpColor(0xff8a65, 0x87ceeb, t);
      } else if (sunElevation > -6) {
        const t = (sunElevation + 6) / 6;
        topColor = lerpColor(0x0a0a1a, 0x2d1b69, t);
        bottomColor = lerpColor(0x1a1a3a, 0xff8a65, t);
      } else if (sunElevation > -12) {
        const t = (sunElevation + 12) / 6;
        topColor = lerpColor(0x050510, 0x0a0a1a, t);
        bottomColor = lerpColor(0x0d0d20, 0x1a1a3a, t);
      } else {
        topColor = 0x050510;
        bottomColor = 0x0d0d20;
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

    drawCloud(gfx, cx, cy, w, h, _seed) {
      gfx.fillEllipse(cx, cy, w, h);
      gfx.fillStyle(0xffffff, 0.3);
      gfx.fillEllipse(cx - w * 0.15, cy - h * 0.1, w * 0.7, h * 0.6);
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

    drawMountainSilhouette(gfx, points, color, bottomY, _seed) {
      gfx.fillStyle(color, 0.7);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (const pt of points) {
        gfx.lineTo(pt.x, pt.y);
      }
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();
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

    drawCoinTexture(ctx, cx, cy, size, _seed) {
      // Outer ring (gold)
      ctx.fillStyle = '#ffd700';
      ctx.beginPath();
      ctx.arc(cx, cy, size - 1, 0, Math.PI * 2);
      ctx.fill();

      // Inner highlight
      ctx.fillStyle = '#ffea00';
      ctx.beginPath();
      ctx.arc(cx - 2, cy - 2, size * 0.5, 0, Math.PI * 2);
      ctx.fill();

      // Dollar sign
      ctx.fillStyle = '#b8860b';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', cx, cy + 1);

      // Dark outline
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, size - 1, 0, Math.PI * 2);
      ctx.stroke();
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'monospace';
    },

    drawFlag(gfx, x, y, color, label, _seed) {
      const flagH = 30;
      const flagW = 20;
      const poleH = flagH + 15;

      // Pole
      gfx.lineStyle(2, 0x888888, 1);
      gfx.lineBetween(x, y, x, y - poleH);

      // Flag body
      gfx.fillStyle(color, 0.9);
      gfx.fillRect(x, y - poleH, flagW, flagH / 2);

      // Checkered pattern
      const checkSize = 4;
      for (let fy = 0; fy < flagH / 2; fy += checkSize) {
        for (let fx = 0; fx < flagW; fx += checkSize) {
          if ((Math.floor(fx / checkSize) + Math.floor(fy / checkSize)) % 2 === 0) {
            gfx.fillStyle(0xffffff, 0.3);
            gfx.fillRect(x + fx, y - poleH + fy, checkSize, checkSize);
          }
        }
      }
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
