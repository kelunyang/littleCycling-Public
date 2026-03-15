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
  drawWobblyTerrainPath,
  generateFilmGrainCanvas,
  drawInkLineCtx,
  drawOrganicBlobCtx,
} from './cuphead-draw';

// ── Film grain state (module-level, shared across resize) ──
let grainImage: Phaser.GameObjects.Image | null = null;
const GRAIN_TEXTURE_KEY = '__cuphead_grain__';

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
    palette: {
      terrainFill: P.TERRAIN_FILL,
      terrainOutline: P.TERRAIN_OUTLINE,
      ink: P.INK,
      skyDayTop: P.SKY_DAY_TOP,
      skyDayBottom: P.SKY_DAY_BOTTOM,
      buildingColors: [...P.BUILDING_COLORS],
      treeTrunk: P.TREE_TRUNK,
      treeCanopy: P.TREE_CANOPY,
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

    drawTerrainSurface(gfx, points, bottomY, seed) {
      const wobble = generateWobbleOffsets(points.length, seed, 1.8);
      drawWobblyTerrainPath(
        gfx, points, wobble,
        P.TERRAIN_FILL, P.TERRAIN_OUTLINE, 3, bottomY,
      );

      // Add subtle cross-hatch shading on the terrain surface
      if (points.length >= 2) {
        const left = points[0].x;
        const right = points[points.length - 1].x;
        const avgY = points.reduce((s, p) => s + p.y, 0) / points.length;
        drawSimpleHatch(gfx, left, avgY, right - left, bottomY - avgY, P.INK, 0.06, 8);
      }
    },

    drawOverlay(scene) {
      const w = Number(scene.game.config.width);
      const h = Number(scene.game.config.height);

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
      grainImage.setScrollFactor(0);
      grainImage.setDepth(999);
      grainImage.setAlpha(0.8);

      return grainImage;
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
      const treeH = 18 + (seed % 12);
      const crownR = 7 + (seed % 5);
      const trunkH = 5 + (seed % 3);

      // Wobbly trunk
      drawInkLine(gfx, x, y, x + (seededRandom(seed + 10) - 0.5) * 3, y - trunkH, seed, 3, P.TREE_TRUNK);

      // Organic blob canopy
      const canopyCy = y - trunkH - crownR * 0.7;
      drawOrganicBlob(gfx, x, canopyCy, crownR, seed + 50, P.TREE_CANOPY, P.INK, 2);

      // Highlight spot
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

    renderRoadLamp(gfx, x, y, seed) {
      const poleH = 35 + (seed % 10);
      const armW = 8;

      // Wobbly pole
      drawInkLine(gfx, x, y, x + (seededRandom(seed + 20) - 0.5) * 2, y - poleH, seed + 300, 2.5, P.LAMP_POST);

      // Arm
      drawInkLine(gfx, x, y - poleH, x + armW, y - poleH + 1, seed + 310, 2, P.LAMP_POST);

      // Lamp housing (organic blob)
      drawOrganicBlob(gfx, x + armW, y - poleH, 4, seed + 320, P.LAMP_POST, P.INK, 1.5);

      // Warm glow
      gfx.fillStyle(P.LAMP_GLOW, 0.12);
      gfx.fillCircle(x + armW, y - poleH + 2, 16);
      gfx.fillStyle(P.LAMP_GLOW, 0.2);
      gfx.fillCircle(x + armW, y - poleH + 2, 7);

      // Hatch shadow at base
      drawSimpleHatch(gfx, x - 3, y - 5, 6, 5, P.INK, 0.08, 3);
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

    drawCloud(gfx, cx, cy, w, h, seed) {
      // 2-3 overlapping organic blobs for puffy cloud
      const blobCount = 2 + Math.floor(seededRandom(seed + 7) * 2);
      for (let i = 0; i < blobCount; i++) {
        const bx = cx + (seededRandom(seed + i * 31) - 0.5) * w * 0.5;
        const by = cy + (seededRandom(seed + i * 47) - 0.5) * h * 0.3;
        const br = (w * 0.25) + seededRandom(seed + i * 61) * (w * 0.15);
        drawOrganicBlob(gfx, bx, by, br, seed + i * 100, P.CLOUD, P.INK, 1.5, 0.6);
      }

      // Bottom shadow hatch
      drawSimpleHatch(
        gfx,
        cx - w * 0.3, cy + h * 0.1,
        w * 0.6, h * 0.3,
        P.INK, 0.06, 4,
      );
    },

    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      const points: { x: number; y: number }[] = [];

      if (layer === 'far') {
        // Cuphead-style jagged peaks — triangular with varied heights and spacing
        let x = 0;
        let peakIndex = 0;
        while (x <= totalWidth) {
          // Each peak has deterministic random height and width, varied by session seed
          const r1 = seededRandom(peakIndex * 137 + 42 + seed);
          const r2 = seededRandom(peakIndex * 197 + 88 + seed);
          const r3 = seededRandom(peakIndex * 251 + 13 + seed);

          // Peak width: 200-400px
          const peakWidth = 200 + r1 * 200;
          // Peak height: 18-28% of skyH (much taller than plastic's ~12%)
          const peakHeight = skyH * (0.18 + r2 * 0.10);
          // Valley depth: shallow connection between peaks
          const valleyDepth = skyH * (0.02 + r3 * 0.04);

          // Rising slope to peak
          const peakX = x + peakWidth * 0.5;
          const halfW = peakWidth * 0.5;
          for (let dx = 0; dx <= peakWidth && (x + dx) <= totalWidth; dx += 4) {
            const t = dx / peakWidth;
            let elevation: number;

            // 10% chance of flat-top mountain
            const isFlat = seededRandom(peakIndex * 311 + 7 + seed) < 0.1;
            // 15% chance of twin peaks
            const isTwin = seededRandom(peakIndex * 373 + 3 + seed) < 0.15;

            if (isFlat && t > 0.35 && t < 0.65) {
              // Flat plateau
              elevation = peakHeight * 0.9;
            } else if (isTwin) {
              // Twin peaks — two summits with a saddle
              const twin1 = Math.max(0, 1 - Math.abs(t - 0.35) * 5);
              const twin2 = Math.max(0, 1 - Math.abs(t - 0.65) * 5);
              elevation = Math.max(twin1, twin2) * peakHeight;
            } else {
              // Standard triangular peak with slight curve
              const dist = Math.abs(t - 0.5) * 2; // 0 at center, 1 at edges
              elevation = (1 - dist * dist) * peakHeight; // quadratic for slight curve
            }

            // Add small wobble for hand-drawn feel
            const wobble = (seededRandom(peakIndex * 73 + Math.floor(dx / 4) * 17 + seed) - 0.5) * 3;

            points.push({
              x: x + dx,
              y: baseY - elevation - valleyDepth + wobble,
            });
          }

          x += peakWidth;
          peakIndex++;
        }
      } else {
        // Near layer: rolling hills — rounder, bigger amplitude than plastic
        const phaseShift = seededRandom(seed + 500) * Math.PI * 2;
        for (let x = 0; x <= totalWidth; x += 4) {
          const r = seededRandom(Math.floor(x / 300) * 59 + 7 + seed);
          const ampMod = 0.7 + r * 0.6; // amplitude modulation per hill
          const y = baseY
            - Math.abs(Math.sin(x * 0.0015 + 0.5 + phaseShift)) * skyH * 0.12 * ampMod
            - Math.abs(Math.sin(x * 0.004 + 1.1 + phaseShift * 0.7)) * skyH * 0.06 * ampMod
            + (seededRandom(Math.floor(x / 4) * 31 + 99 + seed) - 0.5) * 2; // subtle wobble
          points.push({ x, y });
        }
      }

      return points;
    },

    drawMountainSilhouette(gfx, points, color, bottomY, seed) {
      // Generate wobble for mountain outline
      const wobble = generateWobbleOffsets(points.length, seed * 1000 + 777, 2.5);

      // Fill with wobbled outline
      gfx.fillStyle(color, 0.7);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (let i = 0; i < points.length; i++) {
        gfx.lineTo(
          points[i].x + (wobble[i]?.dx ?? 0),
          points[i].y + (wobble[i]?.dy ?? 0),
        );
      }
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();

      // Ink outline on top (2-3px)
      gfx.lineStyle(2.5, P.INK, 0.3);
      gfx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const px = points[i].x + (wobble[i]?.dx ?? 0);
        const py = points[i].y + (wobble[i]?.dy ?? 0);
        if (i === 0) gfx.moveTo(px, py);
        else gfx.lineTo(px, py);
      }
      gfx.strokePath();

      // Subtle body hatch
      if (points.length >= 2) {
        const left = points[0].x;
        const right = points[points.length - 1].x;
        const topY = Math.min(...points.map(p => p.y));
        drawSimpleHatch(gfx, left, topY, right - left, bottomY - topY, P.INK, 0.04, 12);
      }
    },

    drawMoon(gfx, cx, cy, radius, phase, seed) {
      drawOrganicBlob(gfx, cx, cy, radius, seed, P.MOON, P.INK, 2);
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

    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const cx = ox + CYCLIST_W / 2;
      const groundY = CYCLIST_H - 2;

      const rockOffset = params.rockAmplitude * Math.sin((frame / FRAME_COUNT) * Math.PI * 2);
      const pedalAngle = (frame / FRAME_COUNT) * Math.PI * 2;

      // Pedal top/bottom squash/stretch
      const squash = 1 + Math.sin(pedalAngle) * 0.05;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // ── Bicycle ──
      const wheelR = 10;
      const wheelY = groundY - wheelR;
      const rearWheelX = cx - 10;
      const frontWheelX = cx + 13;
      const bbX = cx;
      const bbY = wheelY - 5;

      // Wheels — ink circles
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(rearWheelX, wheelY, wheelR, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(frontWheelX, wheelY, wheelR, 0, Math.PI * 2); ctx.stroke();

      // Spokes
      ctx.lineWidth = 0.8;
      for (let s = 0; s < 4; s++) {
        const sa = (s / 4) * Math.PI * 2 + pedalAngle;
        ctx.beginPath(); ctx.moveTo(rearWheelX, wheelY);
        ctx.lineTo(rearWheelX + Math.cos(sa) * wheelR * 0.8, wheelY + Math.sin(sa) * wheelR * 0.8);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(frontWheelX, wheelY);
        ctx.lineTo(frontWheelX + Math.cos(sa) * wheelR * 0.8, wheelY + Math.sin(sa) * wheelR * 0.8);
        ctx.stroke();
      }

      // Frame — ink lines
      const seatX = cx - 4;
      const seatY = bbY - 16;
      const headX = cx + 8;
      const headY = bbY - 14;

      drawInkLineCtx(ctx, bbX, bbY, seatX, seatY, frame * 100, 2.5, INK_HEX);
      drawInkLineCtx(ctx, bbX, bbY, headX, headY, frame * 100 + 10, 2.5, INK_HEX);
      drawInkLineCtx(ctx, seatX, seatY, headX, headY, frame * 100 + 20, 2, INK_HEX);
      drawInkLineCtx(ctx, bbX, bbY, rearWheelX, wheelY, frame * 100 + 30, 2.5, INK_HEX);
      drawInkLineCtx(ctx, seatX, seatY, rearWheelX, wheelY, frame * 100 + 40, 1.5, INK_HEX);
      drawInkLineCtx(ctx, headX, headY, frontWheelX, wheelY, frame * 100 + 50, 2.5, INK_HEX);

      // Handlebar
      drawInkLineCtx(ctx, headX - 2, headY - 2, headX + 5, headY - 4, frame * 100 + 60, 2, INK_HEX);

      // ── Pedals + cranks ──
      const crankR = 6;
      const p1X = bbX + Math.cos(pedalAngle) * crankR;
      const p1Y = bbY + Math.sin(pedalAngle) * crankR;
      const p2X = bbX + Math.cos(pedalAngle + Math.PI) * crankR;
      const p2Y = bbY + Math.sin(pedalAngle + Math.PI) * crankR;

      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(p1X, p1Y); ctx.lineTo(p2X, p2Y); ctx.stroke();

      // Dark brown shoes on pedals
      const shoeHex = '#3a2a1a';
      ctx.fillStyle = shoeHex;
      ctx.fillRect(p1X - 3, p1Y - 2, 6, 4);
      ctx.fillRect(p2X - 3, p2Y - 2, 6, 4);

      // ── Rider body (rubber-hose style) ──
      const hipX = seatX + rockOffset;
      const hipY = seatY - params.hipOffsetY;

      const torsoRad = params.torsoAngle * (Math.PI / 180);
      const torsoLen = 16;
      const shoulderX = hipX + Math.sin(torsoRad) * torsoLen * 0.6 + rockOffset * 0.5;
      const shoulderY = hipY - Math.cos(torsoRad) * torsoLen;

      // Legs — rounded, thick ink
      const bodyHex = `#${P.CYCLIST_BODY.toString(16).padStart(6, '0')}`;
      const skinHex = `#${P.CYCLIST_SKIN.toString(16).padStart(6, '0')}`;
      const helmetHex = `#${P.CYCLIST_HELMET.toString(16).padStart(6, '0')}`;

      ctx.strokeStyle = bodyHex;
      ctx.lineWidth = 4.5;
      const k1X = (hipX + p1X) / 2 + 4;
      const k1Y = (hipY + p1Y) / 2 + 2;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.quadraticCurveTo(k1X, k1Y, p1X, p1Y); ctx.stroke();
      const k2X = (hipX + p2X) / 2 + 4;
      const k2Y = (hipY + p2Y) / 2 + 2;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.quadraticCurveTo(k2X, k2Y, p2X, p2Y); ctx.stroke();

      // Re-trace legs with ink outline
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.quadraticCurveTo(k1X, k1Y, p1X, p1Y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.quadraticCurveTo(k2X, k2Y, p2X, p2Y); ctx.stroke();

      // Torso — tapered bezier with body color
      ctx.strokeStyle = bodyHex;
      ctx.lineWidth = 5 * squash;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      const midX = (hipX + shoulderX) / 2 + rockOffset * 0.3;
      const midY = (hipY + shoulderY) / 2;
      ctx.quadraticCurveTo(midX, midY, shoulderX, shoulderY);
      ctx.stroke();

      // Torso ink re-trace
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.quadraticCurveTo(midX, midY, shoulderX, shoulderY);
      ctx.stroke();

      // Arms → handlebars (skin color with ink re-trace)
      ctx.strokeStyle = skinHex;
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX + 2, headY - 3); ctx.stroke();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY); ctx.lineTo(headX + 2, headY - 3); ctx.stroke();

      // White gloves on handlebars
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(headX + 2, headY - 3, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(headX + 2, headY - 3, 3, 0, Math.PI * 2); ctx.stroke();

      // ── Head (organic blob with pie-cut eyes) ──
      const headCX = shoulderX - 1;
      const headCY = shoulderY - 6 + params.headTilt;
      const headR = 5;

      // Leather cap (helmet)
      drawOrganicBlobCtx(ctx, headCX, headCY - 1, headR * 0.9, frame * 100 + 70, helmetHex, INK_HEX, 1.5);

      // Face (skin)
      ctx.fillStyle = skinHex;
      ctx.beginPath();
      ctx.arc(headCX + 1, headCY + 1, headR * 0.65, 0, Math.PI * 2);
      ctx.fill();

      // Pie-cut eye (classic 1930s style)
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(headCX + 2, headCY, 2.2, 0, Math.PI * 2);
      ctx.fill();
      // Pie cut — black wedge
      ctx.fillStyle = INK_HEX;
      ctx.beginPath();
      ctx.moveTo(headCX + 2, headCY);
      ctx.arc(headCX + 2, headCY, 2.2, -Math.PI * 0.3, Math.PI * 0.3);
      ctx.closePath();
      ctx.fill();
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
      return 'Georgia, serif';
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
