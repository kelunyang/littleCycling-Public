/**
 * Phaser 2D side-scrolling scene.
 *
 * Mario/Contra-style: cyclist rides left-to-right, terrain scrolls,
 * camera tracks the rider at ~30% from the left edge.
 *
 * The scene reads state from the PhaserBridge (written by Vue each frame)
 * and updates all visual elements accordingly.
 *
 * Performance notes:
 * - Sky rendering is handled by PhaserWeatherSystem (not here)
 * - CRT overlay is drawn once in create() (static)
 * - Terrain uses a dirty flag to skip redraws when camera hasn't moved
 */

import Phaser from 'phaser';
import type { ZoneKind } from '@/game/terrain/land-zone';
import type { WaterFeaturePos } from './terrain-builder';
import { zoneAtDistance, type ZoneBand } from './zone-bands';
import { lerpColor } from './phaser-weather';
import { INTRO_DURATION_S, type PhaserStyleStrategy } from './phaser-style-strategy';
import {
  CyclingGlassesPipeline,
  CYCLING_GLASSES_PIPELINE_KEY,
  type GlassesLens,
  type WeatherType as GlassesWeatherType,
  type ZoneType as GlassesZoneType,
} from './cycling-glasses-pipeline';
import {
  TunnelVisionPipeline,
  TUNNEL_VISION_PIPELINE_KEY,
  computeTunnelIntensity,
} from './tunnel-vision-pipeline';
import { PhaserLensMarksManager, type MarkType } from './phaser-lens-marks-manager';

/** Plain JS object for Vue ↔ Phaser per-frame communication. */
export interface PhaserBridge {
  distanceM: number;
  elevationM: number;
  speedKmh: number;
  cadenceRpm: number;
  isDarkened: boolean;
  bearing: number;
  weather: string;         // sunny | cloudy | rainy | snowy
  sunElevation: number;    // degrees (-90..90)
  moonPhase: number;       // 0..1
}

/** Pixels per meter for the 2D world. */
export const PX_PER_METER = 3;

/** Vertical pixels per meter of ELEVATION. Single source of truth shared by
 *  eleToY and getTerrainSlope, so the drawn grade always equals the cyclist's
 *  lean angle. Relative to PX_PER_METER (3) this is a 4/3 exaggeration. */
export const ELEVATION_EXAGGERATION = 4;

/** Opacity of a workout flag the rider has already ridden past. */
const PASSED_FLAG_ALPHA = 0.25;

/** Camera zoom when the cinematic lift is fully up. Hard floor 0.5 — all
 *  screen-fixed layers are drawn with 2× overscan, which only covers the
 *  widened view down to zoom 0.5. */
const LIFT_ZOOM_MIN = 0.55;

/** User wheel-zoom range (2D port of the 3D orbit camera's wheel zoom —
 *  the camera stays locked on the rider, only the framing changes).
 *  The floor shares LIFT_ZOOM_MIN's overscan constraint; the ceiling is
 *  where the chunky 2D shapes stop flattering themselves. */
const USER_ZOOM_MAX = 1.8;
/** Multiplicative wheel sensitivity (zoom *= exp(-deltaY · this)). */
const USER_ZOOM_WHEEL_SPEED = 0.0011;

/** Seconds to ease the camera back onto the rider when leaving 自由 mode. */
const REATTACH_S = 0.8;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Cyclist screen position as fraction of viewport width from left.
 * 0.5 keeps the rider perfectly centered horizontally so the world scrolls
 * symmetrically on both sides as they pedal. */
const CYCLIST_SCREEN_X = 0.5;

/** Ground baseline Y position (pixels from top) — terrain is drawn relative to this. */
export const GROUND_BASELINE_Y = 0.75; // 75% down from top

export type PhaserSceneMode = 'game' | 'welcome';

export class Phaser2DScene extends Phaser.Scene {
  private bridge: PhaserBridge;
  private strategy: PhaserStyleStrategy;
  private mode: PhaserSceneMode;
  /** Override of GROUND_BASELINE_Y for this scene instance. Game mode uses
   *  the default 0.75; Welcome lowers it (~0.90) so the green ground band
   *  takes only 10–20 % of screen height instead of ~25 %. */
  private groundBaselineFraction: number = GROUND_BASELINE_Y;

  // Promise that resolves when create() finishes — await before using scene objects
  private _readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => { this._readyResolve = r; });

  // Graphics layers (initialized in create())
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private overlayObj!: Phaser.GameObjects.GameObject | null;
  /** Style backdrop between sky and terrain (plastic's neon grid); null for
   *  styles that don't want one. Recreated on resize, like overlayObj. */
  private backdropObj: Phaser.GameObjects.GameObject | null = null;
  private markerGfx!: Phaser.GameObjects.Graphics;

  // Independent layers — route line/markers (with Bloom) and text labels stay
  // off the main display list so they can be styled & filtered separately.
  private routeLayer!: Phaser.GameObjects.Layer;
  private textLayer!: Phaser.GameObjects.Layer;

  // Per-km distance labels. Phaser Text can't batch (one canvas texture each)
  // and Phaser does no frustum culling, so off-screen labels are hidden each
  // frame to drop their texture-bind + draw-call.
  private kmLabels: Phaser.GameObjects.Text[] = [];

  // Cycling-glasses post-processing
  private glassesPipeline: CyclingGlassesPipeline | null = null;
  private tunnelPipeline: TunnelVisionPipeline | null = null;
  private lensMarks: PhaserLensMarksManager | null = null;
  private markAccumulator = 0;
  private currentMarksWeather: GlassesWeatherType = 'sunny';
  private currentZone: GlassesZoneType = 'open';

  /** Second camera for the chunks' additive night lights — carries NO post
   *  pipelines and renders after the main camera, so what it draws composites
   *  ABOVE the night veil in the glasses pipeline. The 2D demos do the same
   *  thing with depth (glow 885 over veil 880); a post pass has no "above",
   *  only another camera does. Null in welcome mode, which runs without the
   *  pipelines and therefore has no veil to escape.
   *  See adoptNightLights() and plan/phaser-2d-lighting.md (option D). */
  private lightsCamera: Phaser.Cameras.Scene2D.Camera | null = null;

  // Speed/wind particle emitter (driven by ride speed, not weather wind)
  private windEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Last rounded speed pushed into windEmitter — avoids reallocating the
   *  speedX range object every frame when the speed hasn't meaningfully moved. */
  private lastWindSpeed = NaN;

  // Environmental wind magnitude (0..2) — drives lens-mark spawn rate
  private windMagnitude = 0;

  // Water shimmer
  private waterShimmerGfx!: Phaser.GameObjects.Graphics;
  private waterShimmerFrame = 0;
  private waterFeatures: WaterFeaturePos[] = [];
  /** Land-use districts along the route, sorted and non-overlapping. */
  private zoneBands: ZoneBand[] = [];

  // Terrain data (set externally after scene is ready)
  private elevationProfile: { distM: number; eleM: number }[] = [];
  private minElevation = 0;

  // World dimensions
  private totalRouteDistPx = 0;
  private totalRouteDistM = 0;

  /** START/FINISH label texts — tracked so drawStaticMarkers can destroy them
   *  before redrawing (a resize re-lays the markers; untracked texts would be
   *  left floating at the old ground height). */
  private staticFlagTexts: Phaser.GameObjects.Text[] = [];

  // ── Finish-line aircraft (Lakitu-style guide hovering over the route finish) ──
  /** Redrawn each frame while riding; lives in routeLayer so plastic gets the
   *  route bloom and cuphead stays matte. */
  private finishAircraftGfx!: Phaser.GameObjects.Graphics;
  /** Banner Text pinned over the aircraft's board — created lazily on the first
   *  aircraft frame (Phaser Text = one texture each; never per-frame recreate). */
  private finishBannerText: Phaser.GameObjects.Text | null = null;
  /** Current banner string — only setText when it actually changes. */
  private finishBannerStr = '';
  /** Smoothed terrain-follow base Y for the hover (exponential), so the craft
   *  doesn't judder on terrain steps while pinned to the moving screen edge.
   *  NaN = snap to target next frame. */
  private finishAircraftBaseY = NaN;
  /** 預估終點在玩家前方多少公尺(server finishTarget)。NaN = 還沒收到幀 → 不畫。 */
  private finishLeadM = NaN;

  // Workout checkpoint flags (2D counterpart of CheckpointFlagManager)
  private workoutFlagGfx!: Phaser.GameObjects.Graphics;
  private workoutFlagFadedGfx!: Phaser.GameObjects.Graphics;
  private workoutFlagTexts: Phaser.GameObjects.Text[] = [];
  private workoutFlags: { distM: number; color: number; label: string }[] = [];
  /** How many flags the rider has passed; -1 forces the next redraw. */
  private passedFlagCount = -1;

  // Dirty flag — skip terrain redraw when camera hasn't moved
  private lastTerrainScrollX = NaN;
  private lastTerrainScrollY = NaN;
  private lastTerrainZoom = 1;

  /** Smoothed camera scrollY (vertical follow). NaN = snap to target on the
   *  next frame (first frame, lap wrap, teleport). */
  private camScrollY = NaN;

  /** Cinematic lift blend weight (0 = normal chase, 1 = fully pulled back).
   *  Driven externally by usePhaserRenderer via setCameraLift(). */
  private liftWeightNow = 0;

  /** User-controlled zoom (mouse wheel), 1 = default framing. The cinematic
   *  lift blends from this toward LIFT_ZOOM_MIN, so a peek/finale always
   *  pulls back to the same wide shot no matter how far in the user is. */
  private userZoom = 1;

  /** 跟車 (third) or 自由 (orbit) — the 2D reading of the 3D camera modes.
   *  Free mode detaches the camera: drag to pan the world, wheel to zoom, the
   *  rider is free to ride out of shot. */
  private cameraMode: 'third' | 'orbit' = 'third';
  /** World-space camera centre while detached. */
  private freeCenterX = 0;
  private freeCenterY = 0;
  /** Re-attach blend (0 → 1 over REATTACH_S) — going back to 跟車 eases the
   *  camera home instead of teleporting it off the rider's panned-away view. */
  private reattachT = 1;
  private reattachFromX = 0;
  private reattachFromY = 0;

  // ── Entrance animation (plastic: blocks drop; cuphead: ink + wash) ──
  /** Seconds since the intro started; INTRO_DURATION_S+ means "done". */
  private introT = INTRO_DURATION_S;
  /** World X the reveal sweeps out from (view's left edge at intro start). */
  private introOriginX = 0;

  // Zone color filter overlay
  private zoneFilterGfx!: Phaser.GameObjects.Graphics;
  private currentZoneColor = 0;
  private targetZoneColor = 0;
  private zoneFilterAlpha = 0;
  private targetZoneAlpha = 0;

  // Overlay frame counter (for animated overlays like film grain)
  private overlayFrameCount = 0;

  constructor(bridge: PhaserBridge, strategy: PhaserStyleStrategy, mode: PhaserSceneMode = 'game') {
    super({ key: 'Phaser2DScene' });
    this.bridge = bridge;
    this.strategy = strategy;
    this.mode = mode;
  }

  create() {
    // ── Lights camera (option D) — set up FIRST, before any object exists ──
    // The glasses pipeline's night veil runs on the main camera's COMPOSITED
    // frame, so anything that camera renders — the additive lights included —
    // is veiled with the world, and the lit:unlit ratio stays where it was
    // (check:3d asserts that arithmetic). The demos draw their glow ABOVE the
    // veil; the only thing that runs after a camera's post pipeline is a later
    // camera, so the lights get one of their own, with no pipelines on it.
    //
    // Membership is default-OUT: every object is ignored by this camera the
    // moment it is added (the scene-level ADDED_TO_SCENE event fires for root
    // and Layer adds alike), and adoptNightLights() exempts the chunk lights
    // layers one by one. Default-out because the failure mode of a hand-kept
    // ignore list is an object drawn TWICE — once veiled, once not — and
    // nobody enumerates every label, emitter and tree a scene grows.
    if (this.mode === 'game') {
      const lightsCam = this.cameras.add();
      this.lightsCamera = lightsCam;
      this.events.on(
        Phaser.Scenes.Events.ADDED_TO_SCENE,
        (obj: Phaser.GameObjects.GameObject) => { obj.cameraFilter |= lightsCam.id; },
      );
    }

    // Terrain graphics — scrolls with the world
    this.terrainGfx = this.add.graphics();

    // Route layer holds anything that should glow (distance markers, flags) —
    // a Bloom FX is attached to the layer so its contents render with neon edges.
    this.routeLayer = this.add.layer();
    this.routeLayer.setDepth(60);

    // Text layer holds in-world text (km labels, START/FINISH) so it stays on
    // its own display list, separate from the bloomed route geometry.
    this.textLayer = this.add.layer();
    this.textLayer.setDepth(70);

    // Distance markers — scrolls with the world; lives inside the route layer.
    this.markerGfx = this.add.graphics();
    this.markerGfx.setDepth(50);
    this.routeLayer.add(this.markerGfx);

    // Workout checkpoint flags: ahead-of-rider on one layer, already-passed on
    // a dimmed one, so fading a flag is a layer alpha, not a per-shape redraw.
    this.workoutFlagGfx = this.add.graphics();
    this.workoutFlagGfx.setDepth(50);
    this.routeLayer.add(this.workoutFlagGfx);
    this.workoutFlagFadedGfx = this.add.graphics();
    this.workoutFlagFadedGfx.setDepth(49);
    this.workoutFlagFadedGfx.setAlpha(PASSED_FLAG_ALPHA);
    this.routeLayer.add(this.workoutFlagFadedGfx);

    // Finish-line aircraft — above the flags, inside the route layer so the
    // plastic saucer picks up the route bloom (cuphead's matte layer has none).
    this.finishAircraftGfx = this.add.graphics();
    this.finishAircraftGfx.setDepth(52);
    this.routeLayer.add(this.finishAircraftGfx);

    // Apply Bloom FX to the route layer so markers/flags get a soft glow —
    // plastic only, fewer blur steps (see applyRouteBloom).
    this.applyRouteBloom();

    // Water shimmer layer — above terrain features
    this.waterShimmerGfx = this.add.graphics();
    this.waterShimmerGfx.setDepth(16);

    // Zone color filter — semi-transparent fullscreen overlay
    this.zoneFilterGfx = this.add.graphics();
    this.zoneFilterGfx.setScrollFactor(0);
    this.zoneFilterGfx.setDepth(950);

    // Style backdrop (plastic's neon grid) — behind the terrain, over the sky.
    this.backdropObj = this.strategy.drawBackdrop?.(this) ?? null;

    // Wheel zoom (game only — the welcome backdrop lives on a scrollable
    // page). 2D port of the orbit camera's wheel: framing changes, the
    // camera never leaves the rider. Multiplicative so each notch feels
    // equal at any zoom level.
    if (this.mode === 'game') {
      this.input.on(
        'wheel',
        (_p: unknown, _o: unknown, _dx: number, deltaY: number) => {
          this.userZoom = Phaser.Math.Clamp(
            this.userZoom * Math.exp(-deltaY * USER_ZOOM_WHEEL_SPEED),
            LIFT_ZOOM_MIN,
            USER_ZOOM_MAX,
          );
        },
      );

      // Drag to pan — only in 自由 mode (in 跟車 the camera is the rider's, and
      // a drag that silently does nothing is better than one that fights them).
      this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
        if (this.cameraMode !== 'orbit' || !p.isDown) return;
        const zoom = this.cameras.main.zoom;
        // Screen delta → world delta: drag right, world moves right with you.
        this.freeCenterX -= (p.x - p.prevPosition.x) / zoom;
        this.freeCenterY -= (p.y - p.prevPosition.y) / zoom;
      });
    }

    // Style-specific overlay (CRT scanlines for plastic, film grain for cuphead, etc.)
    this.overlayObj = this.strategy.drawOverlay(this);

    // ── Cycling-glasses post-processing (game mode only) ──
    // Welcome backdrop reuses this scene but per the design rule must NOT
    // apply the glasses/tunnel PostFX overlays.
    if (this.mode === 'game') {
      // Lens marks first (canvas → Phaser CanvasTexture), then attach pipelines
      // to the main camera so the whole canvas renders through the glasses.
      this.lensMarks = new PhaserLensMarksManager(this);

      this.cameras.main.setPostPipeline([CYCLING_GLASSES_PIPELINE_KEY, TUNNEL_VISION_PIPELINE_KEY]);
      const glasses = this.cameras.main.getPostPipeline(CYCLING_GLASSES_PIPELINE_KEY);
      const tunnel = this.cameras.main.getPostPipeline(TUNNEL_VISION_PIPELINE_KEY);
      this.glassesPipeline = (Array.isArray(glasses) ? glasses[0] : glasses) as CyclingGlassesPipeline;
      this.tunnelPipeline = (Array.isArray(tunnel) ? tunnel[0] : tunnel) as TunnelVisionPipeline;
      if (this.glassesPipeline && this.lensMarks) {
        // Looked up lazily — Phaser may allocate the canvas's GL texture on first
        // upload, after this scene.create() runs.
        const marks = this.lensMarks;
        this.glassesPipeline.setMarksTextureSource(() => marks.glTexture);
      }
    }

    // Speed/wind particle emitter
    const windColor = this.strategy.getWindParticleColor();
    const windKey = '__wind_particle__';
    if (!this.textures.exists(windKey)) {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 1;
      const ctx = c.getContext('2d')!;
      const r = (windColor >> 16) & 0xff;
      const g = (windColor >> 8) & 0xff;
      const b = windColor & 0xff;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 2, 1);
      this.textures.addCanvas(windKey, c);
    }
    const initH = Number(this.game.config.height);
    this.windEmitter = this.add.particles(0, 0, windKey, {
      x: { min: 0, max: Number(this.game.config.width) + 100 },
      y: { min: 0, max: initH },
      speedX: { min: -400, max: -200 },
      speedY: 0,
      lifespan: 800,
      frequency: 80,
      quantity: 1,
      alpha: { start: this.strategy.getWindParticleAlpha(), end: 0 },
      scaleX: { min: 3, max: 8 },
      active: false,
    });
    this.windEmitter.setScrollFactor(0);
    this.windEmitter.setDepth(450);

    // Signal that the scene is ready for external use
    this._readyResolve();
  }

  /**
   * Load the elevation profile for terrain rendering.
   * Called by usePhaserRenderer after init.
   */
  setElevationProfile(profile: { distM: number; eleM: number }[]) {
    this.elevationProfile = profile;
    this.snapCamera(); // new anchor elevation — don't slide from the old one
    // NOTE: the intro is NOT started here. Setting the profile happens while
    // the loading overlay still covers the canvas, so the animation would play
    // out unseen. GameView calls playIntro() when the rider actually sets off.
    if (profile.length > 0) {
      this.minElevation = Math.min(...profile.map((p) => p.eleM));
      this.totalRouteDistM = profile[profile.length - 1].distM;
      this.totalRouteDistPx = this.totalRouteDistM * PX_PER_METER;

      // Draw static markers (flags, distance ticks) — game mode only.
      // Welcome backdrop runs on a synthetic profile and skips km labels.
      if (this.mode === 'game') {
        this.drawStaticMarkers();
      }
    }
  }

  /** Update water feature positions for shimmer animation. */
  setWaterFeatures(features: WaterFeaturePos[]) {
    this.waterFeatures = features;
  }

  /**
   * The route's land-use districts, as distance bands (see `buildZoneBands`).
   *
   * Pushed by `TerrainChunkManager2D` when it is built, because the manager is
   * the only thing that holds the projected features. Empty means "no zoning
   * known", and `drawTerrain` then hands `drawTerrainSurface` nothing — which is
   * the state every style drew in before the zones existed.
   */
  setZoneBands(bands: ZoneBand[]) {
    this.zoneBands = bands;
    this.lastTerrainScrollX = NaN;   // the board's colours changed; redraw
  }

  /** The district at a route distance, or null outside every band. */
  private zoneAtDist(distM: number): ZoneKind | null {
    return zoneAtDistance(this.zoneBands, distM);
  }

  /**
   * Called every frame by Phaser (driven externally via tick()).
   */
  update(_time: number, _delta: number) {
    const dtSec = _delta / 1000;
    const { distanceM } = this.bridge;
    const w = this.game.canvas.width;
    const h = this.game.canvas.height;

    // ── Camera: follow cyclist ──
    // X: rider pinned at CYCLIST_SCREEN_X. Y: smoothed so the rider settles at
    // the ground baseline — climbing scrolls the whole world down instead of
    // flattening the elevation into a fixed pixel span. Zoom: cinematic lift.
    const cam = this.cameras.main;
    const worldX = distanceM * PX_PER_METER;
    const riderY = this.getTerrainY(distanceM);
    const targetScrollY = riderY - h * this.groundBaselineFraction;
    if (Number.isNaN(this.camScrollY)) this.camScrollY = targetScrollY;
    this.camScrollY += (targetScrollY - this.camScrollY) * (1 - Math.exp(-dtSec * 4));

    // Lift blends from the user's zoom toward the fixed wide shot; the floor
    // is the overscan hard limit either way.
    const zoom = Phaser.Math.Clamp(
      this.userZoom + (LIFT_ZOOM_MIN - this.userZoom) * this.liftWeightNow,
      LIFT_ZOOM_MIN,
      USER_ZOOM_MAX,
    );
    cam.setZoom(zoom);

    // centerOn is zoom-safe (zoom anchors on the viewport centre); the lift
    // also raises the view a little so the pull-back shows more sky.
    const chaseX = worldX + (0.5 - CYCLIST_SCREEN_X) * w;
    const chaseY = this.camScrollY + h * 0.5 - this.liftWeightNow * h * 0.1;

    if (this.cameraMode === 'orbit') {
      // 自由: the camera stays where the rider dragged it (see the pointer
      // handlers). The rider keeps riding — out of frame if they like.
      cam.centerOn(this.freeCenterX, this.freeCenterY);
    } else if (this.reattachT < 1) {
      // Easing home after 自由 → 跟車, so the world doesn't snap.
      this.reattachT = Math.min(1, this.reattachT + dtSec / REATTACH_S);
      const k = easeInOutCubic(this.reattachT);
      cam.centerOn(
        this.reattachFromX + (chaseX - this.reattachFromX) * k,
        this.reattachFromY + (chaseY - this.reattachFromY) * k,
      );
    } else {
      cam.centerOn(chaseX, chaseY);
    }

    // The lights camera shadows the main camera exactly — same scroll, same
    // zoom. It is not a different view, only a different place in the
    // compositing order. Copied after every branch above so 自由 mode and the
    // re-attach ease stay in lockstep too.
    if (this.lightsCamera) {
      this.lightsCamera.setScroll(cam.scrollX, cam.scrollY);
      this.lightsCamera.setZoom(cam.zoom);
    }

    // ── Style backdrop parallax ──
    // The backdrop is screen-fixed; its texture scrolls at a fraction of the
    // camera, which parallaxes without ever sliding the sprite off screen.
    if (this.backdropObj instanceof Phaser.GameObjects.TileSprite) {
      const parallax = (this.backdropObj.getData('parallax') as number | undefined) ?? 0;
      if (parallax > 0) {
        this.backdropObj.setTilePosition(cam.scrollX * parallax, cam.scrollY * parallax);
      }
    }

    // ── Entrance animation ──
    // Runs on a wall clock, not on camera movement — so it must bypass the
    // terrain dirty flag below (the rider may still be standing still).
    const introRunning = this.introT < INTRO_DURATION_S;
    if (introRunning) this.introT += dtSec;

    // ── Terrain (only redraw when camera moves — or while the intro plays) ──
    const scrollX = cam.scrollX;
    const scrollY = cam.scrollY;
    if (
      introRunning
      || Math.abs(scrollX - this.lastTerrainScrollX) >= 1
      || Math.abs(scrollY - this.lastTerrainScrollY) >= 1
      || Math.abs(zoom - this.lastTerrainZoom) >= 0.001
      || Number.isNaN(this.lastTerrainScrollX)
    ) {
      this.lastTerrainScrollX = scrollX;
      this.lastTerrainScrollY = scrollY;
      this.lastTerrainZoom = zoom;
      this.drawTerrain(h);

      // Cull off-screen km labels alongside the terrain redraw (both are driven
      // by camera movement). label.x is world-space; hide anything outside the
      // view so Phaser skips its (unbatchable) text draw.
      if (this.kmLabels.length > 0) {
        const view = this.getViewRect();
        const cullLeft = view.left - 100;
        const cullRight = view.right + 100;
        for (const lbl of this.kmLabels) {
          lbl.setVisible(lbl.x >= cullLeft && lbl.x <= cullRight);
        }
      }
    }

    // ── Finish-line aircraft (Lakitu-style guide over the route finish) ──
    this.updateFinishAircraft(dtSec);

    // ── Speed/wind particles ──
    const speed = this.bridge.speedKmh;
    const windActive = speed >= 10;
    if (this.windEmitter.active !== windActive) this.windEmitter.active = windActive;
    if (windActive) {
      // Only reconfigure when the rounded speed changes — else this allocates a
      // fresh speedX range object every frame.
      const spd = Math.round(speed);
      if (spd !== this.lastWindSpeed) {
        this.lastWindSpeed = spd;
        this.windEmitter.frequency = Math.max(10, 80 - spd);
        this.windEmitter.speedX = { min: -(spd * 15 + 200), max: -(spd * 10 + 100) } as any;
      }
    }

    // ── Water shimmer (every 3 frames) ──
    this.waterShimmerFrame++;
    if (this.waterShimmerFrame % 3 === 0) {
      this.drawWaterShimmer();
    }

    // ── Zone color filter (smooth lerp) ──
    this.updateZoneFilter(w, h);

    // ── Overlay animation (film grain shift etc.) ──
    this.overlayFrameCount++;
    this.strategy.updateOverlay?.(this.overlayFrameCount);

    // ── Cycling-glasses post-processing tick ──
    this.tickGlasses(dtSec);
  }

  /**
   * Drive lens-mark spawning, mark fade, and pipeline transition lerps.
   * Mark spawning is weather + zone driven (mirrors useTerrainRenderer behaviour).
   */
  private tickGlasses(dt: number) {
    if (!this.lensMarks || !this.glassesPipeline) return;

    // Weather-driven marks (rain/snow) at fixed rate.
    this.markAccumulator += dt;
    const rate = this.getMarkSpawnRate(this.currentMarksWeather);
    while (rate.interval > 0 && this.markAccumulator >= rate.interval) {
      this.markAccumulator -= rate.interval;
      if (Math.random() < rate.chance) {
        this.lensMarks.addMark(rate.type);
      }
    }

    // Zone-driven ambient marks. Wind boosts dust/leaf spawn (1× .. 2×).
    const windFactor = 1 + this.windMagnitude * 0.5;
    if (this.currentZone === 'forest') {
      if (Math.random() < dt * 0.25 * windFactor) this.lensMarks.addMark('leaf');
    } else if (this.currentZone === 'open') {
      if (Math.random() < dt * 0.08 * windFactor) this.lensMarks.addMark('leaf');
      if (Math.random() < dt * 0.15 * windFactor) this.lensMarks.addMark('dust');
    } else {
      if (Math.random() < dt * 0.3 * windFactor) this.lensMarks.addMark('dust');
    }

    this.lensMarks.update(dt);
    this.glassesPipeline.tick(dt);
  }

  private getMarkSpawnRate(weather: GlassesWeatherType): { type: MarkType; interval: number; chance: number } {
    switch (weather) {
      case 'rainy': return { type: 'rain', interval: 0.3, chance: 0.8 };
      case 'snowy': return { type: 'snow', interval: 0.6, chance: 0.7 };
      default: return { type: 'dust', interval: 0, chance: 0 };
    }
  }

  // ── Public glasses API (called from usePhaserRenderer) ──

  setLens(lens: GlassesLens) {
    this.glassesPipeline?.setLens(lens);
  }

  setMarksWeather(weather: GlassesWeatherType) {
    this.currentMarksWeather = weather;
    this.glassesPipeline?.setWeather(weather);
  }

  /** Set wind magnitude (0..2). Drives leaf/dust lens-mark spawn rate. */
  setWindMagnitude(mag: number) {
    this.windMagnitude = Math.max(0, Math.min(2, mag));
  }

  /** Trigger a brief camera flash to accompany a lightning strike. */
  triggerLightningFlash() {
    // Phaser camera flash: 180ms slight white fade, on top of the bolt graphic.
    this.cameras.main.flash(180, 220, 230, 255, true);
  }

  triggerCoinGlow() {
    this.glassesPipeline?.triggerCoinGlow();
    this.lensMarks?.addMark('coin');
  }

  addLensMark(type: MarkType) {
    this.lensMarks?.addMark(type);
  }

  updatePhysiology(hrZone: number | null, speedKmh: number) {
    if (!this.tunnelPipeline) return;
    const intensity = computeTunnelIntensity(hrZone, speedKmh);
    this.tunnelPipeline.setIntensity(intensity);
  }

  /**
   * How far into night we are (0 = noon, 1 = deep night).
   *
   * This is what makes the 2D WORLD darken. Phaser has no light term, so
   * nothing in a chunk reacts to nightfall on its own; the glasses pipeline is
   * the only place a multiplier can reach every drawn pixel at once. See
   * night-grade.ts, and `plan/phaser-2d-lighting.md` for why it lives here.
   *
   * The additive lights layers are the one thing NOT under it: they render on
   * lightsCamera, above the veil (adoptNightLights), which is what gives them
   * headroom to read at all.
   *
   * Welcome-backdrop mode deliberately runs without the pipelines, so it also
   * runs without the night dim — the same exemption the glasses effect has.
   */
  setNightFactor(f: number) {
    this.glassesPipeline?.setNightFactor(f, this.strategy.style);
  }

  /**
   * Route a chunk's additive lights layer past the night veil (option D).
   *
   * The main camera stops rendering it — otherwise it would ALSO be drawn
   * under the veil, i.e. twice — and the pipeline-free lights camera picks it
   * up (clearing the bit the ADDED_TO_SCENE hook set). What the lights give up
   * by leaving the main camera: lens tint, vignette, barrel distortion and the
   * tunnel-vision blur no longer touch them — the demos make the same trade,
   * their glow layer sits above every screen effect. Distortion is the visible
   * one: at the frame's far corners a glow can sit a few px off its distorted
   * building; at the centre, where the rider's eye lives, the offset is ~0.
   *
   * Welcome mode has no veil, so the lights simply stay on the main camera
   * and this is a no-op.
   */
  adoptNightLights(gfx: Phaser.GameObjects.Graphics): void {
    if (!this.lightsCamera) return;
    this.cameras.main.ignore(gfx);
    gfx.cameraFilter &= ~this.lightsCamera.id;
  }

  setEnvironmentZone(zone: GlassesZoneType) {
    if (this.currentZone === zone) return;
    this.currentZone = zone;
    this.glassesPipeline?.setZone(zone);
  }

  /**
   * Set the zone color overlay. Pass null to clear.
   * Color transitions smoothly via lerp.
   */
  setZoneColor(color: number | null, alpha = 0.10) {
    if (color === null) {
      this.targetZoneAlpha = 0;
    } else {
      this.targetZoneColor = color;
      this.targetZoneAlpha = alpha;
    }
  }

  /**
   * Draw workout segment flags at the specified distances.
   */
  /** Place the workout checkpoint flags. They live on their own two layers —
   *  one at full strength, one dimmed — so passing one only costs a redraw of
   *  the flags, not of every distance tick. */
  drawWorkoutFlags(segments: { distM: number; color: number; label: string }[]) {
    this.workoutFlags = [...segments];
    this.passedFlagCount = -1; // force the first redraw
    this.updateWorkoutFlags(this.bridge.distanceM);
  }

  /**
   * Fade the flags the rider has already ridden past (mirrors the 3D
   * CheckpointFlagManager). Cheap to call every frame: it only redraws when
   * the number of passed flags actually changes — once per interval.
   */
  updateWorkoutFlags(riderDistM: number) {
    if (this.workoutFlags.length === 0) return;

    const PASSED_MARGIN_M = 20;
    let passed = 0;
    for (const f of this.workoutFlags) {
      if (riderDistM > f.distM + PASSED_MARGIN_M) passed++;
    }
    if (passed === this.passedFlagCount) return;
    this.passedFlagCount = passed;

    this.workoutFlagGfx.clear();
    this.workoutFlagFadedGfx.clear();
    for (const t of this.workoutFlagTexts) t.destroy();
    this.workoutFlagTexts.length = 0;

    for (const f of this.workoutFlags) {
      const isPassed = riderDistM > f.distM + PASSED_MARGIN_M;
      const gfx = isPassed ? this.workoutFlagFadedGfx : this.workoutFlagGfx;
      const text = this.drawFlag(f.distM, f.color, f.label, gfx);
      if (isPassed) text.setAlpha(PASSED_FLAG_ALPHA);
      this.workoutFlagTexts.push(text);
    }
  }

  /**
   * Redraw the finish-line aircraft (a Lakitu-style guide, NES-Mario cloud
   * turtle). The target is the *predicted* end of the ride, not the route's end
   * — in a timed session the clock stops the ride long before the route runs
   * out (see the server's finishTarget). While that point is off-screen the
   * craft is pinned near the screen's leading (right) edge; once it scrolls into
   * view the craft settles over it. Single clamp:
   *   displayedX = min(playerX + leadPx, view.right − MARGIN_PX).
   *
   * The craft is always on-screen (the clamp guarantees it), so there is no
   * culling — a single object redrawn each frame, which the blink/bob/spin
   * animation needs. The banner Text is created once and only repositioned.
   */
  private updateFinishAircraft(dtSec: number) {
    const draw = this.strategy.drawAircraft;
    if (this.mode !== 'game' || this.totalRouteDistM <= 0 || !draw || Number.isNaN(this.finishLeadM)) {
      // Welcome mode / no route / a style without an aircraft: keep it clear.
      this.finishAircraftGfx.clear();
      this.finishBannerText?.setVisible(false);
      return;
    }

    // Lakitu clamp — pin to the leading screen edge until the finish is in view.
    const MARGIN_PX = 80;
    const view = this.getViewRect();
    const targetX = (this.bridge.distanceM + this.finishLeadM) * PX_PER_METER;
    const displayedX = Math.min(targetX, view.right - MARGIN_PX);

    // Hover above the terrain at the displayed X. Smooth the terrain-follow
    // BASE (so steps/edge motion don't judder), then add a crisp bob on top.
    const HOVER_PX = 150;
    const baseTarget = this.getTerrainY(displayedX / PX_PER_METER) - HOVER_PX;
    if (Number.isNaN(this.finishAircraftBaseY)) this.finishAircraftBaseY = baseTarget;
    this.finishAircraftBaseY += (baseTarget - this.finishAircraftBaseY) * (1 - Math.exp(-dtSec * 6));
    const bob = Math.sin((this.time.now / 1000) * 0.9) * 6;
    const y = this.finishAircraftBaseY + bob;

    const animPhase = this.time.now / 1000;
    // Fixed seed — the finish aircraft is a single persistent object, not a
    // per-position feature, so its wobble stays put frame to frame.
    const seed = 4207;

    this.finishAircraftGfx.clear();
    const banner = draw(this.finishAircraftGfx, displayedX, y, seed, animPhase);

    // Banner Text — one texture, created once, then only moved (perf discipline:
    // never destroy/recreate a Phaser Text per frame).
    if (!this.finishBannerText) {
      // plastic's board is dark → white text; cuphead's kraft sign → ink text;
      // circuit has no aircraft hook today, but if one lands its banner is an
      // e-paper module on a dark board → silk white (never a silent else).
      const color = this.strategy.style === 'cuphead' ? '#2a2420' : '#ffffff';
      this.finishBannerText = this.add.text(banner.bannerCx, banner.bannerCy, this.finishBannerStr, {
        fontSize: '11px',
        color,
        fontFamily: this.strategy.getMarkerFont(),
        align: 'center',
      });
      this.finishBannerText.setOrigin(0.5);
      this.finishBannerText.setDepth(53);
      this.textLayer.add(this.finishBannerText);
    }
    this.finishBannerText.setPosition(banner.bannerCx, banner.bannerCy);
    this.finishBannerText.setVisible(true);
  }

  /**
   * Set the finish-banner readout (fed ~1 Hz from the game loop). Formats the
   * zh-TW string 「剩 X.X km」 plus optional 「 · N 分」 (Math.ceil(ms/60000),
   * clamped ≥0; freeRoam/no target passes null → km only). Skips the setText
   * when the string is unchanged.
   */
  /** 餵預估終點:玩家前方 leadM 公尺(server finishTarget.remainingM)。 */
  setFinishTarget(leadM: number) {
    this.finishLeadM = Math.max(0, leadM);
  }

  setFinishBannerInfo(remainingKm: number, remainingMs: number | null) {
    const km = Math.max(0, remainingKm);
    let str = `剩 ${km.toFixed(1)} km`;
    if (remainingMs !== null) {
      const mins = Math.max(0, Math.ceil(remainingMs / 60000));
      str += ` · ${mins} 分`;
    }
    if (str === this.finishBannerStr) return;
    this.finishBannerStr = str;
    this.finishBannerText?.setText(str);
  }

  /**
   * (Re)apply the route-layer bloom. Neon glow suits the plastic style; the
   * cuphead hand-drawn ink should stay matte, so it gets no bloom at all. Fewer
   * blur steps (2 vs the former 4) roughly halves the per-frame blur-chain cost.
   */
  private applyRouteBloom() {
    const fx = this.routeLayer.postFX;
    if (!fx) return;
    fx.clear();
    // plastic: neon route tape. circuit: the route IS the powered dupont wire —
    // the one thing in that world that must visibly glow (its 3D demo is the
    // only strong-bloom world of the three). cuphead: poster paint does not
    // glow, so no bloom, and that is a look decision (DEVPLAN).
    if (this.strategy.style === 'plastic' || this.strategy.style === 'circuit') {
      // (color, offsetX, offsetY, blurStrength, strength, steps)
      fx.addBloom(0xffffff, 1, 1, 1, 1.2, 2);
    }
  }

  /** Smoothly transition zone filter overlay. */
  private updateZoneFilter(w: number, h: number) {
    // Lerp alpha
    const lerpRate = 0.08;
    this.zoneFilterAlpha += (this.targetZoneAlpha - this.zoneFilterAlpha) * lerpRate;

    // Lerp color
    if (this.targetZoneAlpha > 0 && this.currentZoneColor !== this.targetZoneColor) {
      this.currentZoneColor = lerpColor(this.currentZoneColor, this.targetZoneColor, lerpRate * 2);
    }

    this.zoneFilterGfx.clear();
    if (this.zoneFilterAlpha < 0.005) return;

    this.zoneFilterGfx.fillStyle(this.currentZoneColor, this.zoneFilterAlpha);
    // 2× overscan: zoom also scales scrollFactor(0) layers, so a screen-sized
    // rect would shrink and expose its edges during the camera lift.
    this.zoneFilterGfx.fillRect(-w * 0.5, -h * 0.5, w * 2, h * 2);
  }

  /** Draw animated shimmer highlights on water surfaces. */
  private drawWaterShimmer() {
    this.waterShimmerGfx.clear();
    if (this.waterFeatures.length === 0) return;

    const view = this.getViewRect();
    const camLeft = view.left - 50;
    const camRight = view.right + 50;
    const time = this.waterShimmerFrame * 0.15;

    for (const wf of this.waterFeatures) {
      // Skip off-screen water
      if (wf.x + wf.width / 2 < camLeft || wf.x - wf.width / 2 > camRight) continue;

      // Draw 2-3 sine wave highlight lines
      this.waterShimmerGfx.lineStyle(1, this.strategy.palette.waterOutline, 0.4);
      for (let i = 0; i < 3; i++) {
        this.waterShimmerGfx.beginPath();
        const lineY = wf.groundY + 3 + i * 5;
        const startX = wf.x - wf.width / 2;
        const endX = wf.x + wf.width / 2;
        this.waterShimmerGfx.moveTo(startX, lineY);
        for (let sx = startX + 4; sx <= endX; sx += 4) {
          const dy = Math.sin((sx * 0.15) + time + i * 2) * 1.5;
          this.waterShimmerGfx.lineTo(sx, lineY + dy);
        }
        this.waterShimmerGfx.strokePath();
      }
    }
  }

  /** Map elevation → scene Y. Single source of truth shared by the terrain
   *  surface, markers, coins and the cyclist so they always agree.
   *
   *  Fixed scale (ELEVATION_EXAGGERATION px per elevation metre), anchored so
   *  the route's lowest point sits on the baseline. The old global min/max
   *  normalisation squeezed a whole route's climbing into <1 px/m — the rider
   *  leaned into a grade the terrain barely showed. Keeping the surface on
   *  screen is now the vertical camera follow's job, not this mapping's. */
  eleToY(eleM: number, baselineY: number): number {
    return baselineY - (eleM - this.minElevation) * ELEVATION_EXAGGERATION;
  }

  /** Camera view rectangle in world coordinates, zoom-aware. Computed from
   *  the values set this frame (cam.worldView lags until the next preRender). */
  private getViewRect(): { left: number; right: number; top: number; bottom: number } {
    const cam = this.cameras.main;
    const w = this.game.canvas.width;
    const h = this.game.canvas.height;
    const viewW = w / cam.zoom;
    const viewH = h / cam.zoom;
    const left = cam.scrollX + (w - viewW) / 2;
    const top = cam.scrollY + (h - viewH) / 2;
    return { left, right: left + viewW, top, bottom: top + viewH };
  }

  /** Set the cinematic lift blend weight (0..1) — pulls the camera back via
   *  zoom. Driven per-frame by usePhaserRenderer from a CameraLift. */
  setCameraLift(weight: number) {
    this.liftWeightNow = Math.max(0, Math.min(1, weight));
  }

  /** Programmatic zoom set (wheel input normally drives this; exposed so
   *  setCameraOptions / future HUD controls can too). Clamped to the same
   *  range as the wheel. */
  setUserZoom(zoom: number) {
    this.userZoom = Phaser.Math.Clamp(zoom, LIFT_ZOOM_MIN, USER_ZOOM_MAX);
  }

  /** 跟車 ('third') / 自由 ('orbit'). Detaching hands the camera to the mouse;
   *  re-attaching eases it back onto the rider (REATTACH_S). No-op if the mode
   *  hasn't actually changed — this is called every frame from the game loop. */
  setCameraMode(mode: 'third' | 'orbit') {
    if (mode === this.cameraMode) return;
    const cam = this.cameras.main;
    const centre = cam.worldView;

    if (mode === 'orbit') {
      // Take over from wherever the chase camera currently is.
      this.freeCenterX = centre.centerX;
      this.freeCenterY = centre.centerY;
      this.input.setDefaultCursor('grab');
    } else {
      this.input.setDefaultCursor('default');
      // Ease home from wherever the rider left the camera.
      this.reattachFromX = centre.centerX;
      this.reattachFromY = centre.centerY;
      this.reattachT = 0;
      // The vertical follow was frozen while detached; restart it from here so
      // it doesn't also try to catch up from a stale value.
      this.camScrollY = cam.scrollY;
    }
    this.cameraMode = mode;
  }

  /** (Re)start the entrance animation from the rider's current position. */
  replayIntro() {
    this.introT = 0;
    this.introOriginX = this.getViewRect().left;
    this.lastTerrainScrollX = NaN; // force the first intro frame to draw
  }

  /** Seconds since the entrance animation started (>= INTRO_DURATION_S when
   *  it is over). Styles time their own stages off this. */
  getIntroT(): number {
    return this.introT;
  }

  /** Drop the smoothed vertical follow and snap to the target next frame.
   *  Call on discontinuous jumps (lap wrap, replay seek) so the camera does
   *  not visibly slide between the two elevations. */
  snapCamera() {
    this.camScrollY = NaN;
  }

  /** Draw terrain from elevation profile — delegates visual style to strategy. */
  private drawTerrain(h: number) {
    this.terrainGfx.clear();

    if (this.elevationProfile.length < 2) return;

    const baselineY = h * this.groundBaselineFraction;

    // Determine visible range in world X (zoom-aware)
    const view = this.getViewRect();
    const margin = 50;
    const visLeft = view.left - margin;
    const visRight = view.right + margin;

    // Build point array for the visible terrain surface, and — when the route
    // has been zoned — the district at each of those samples. The two arrays are
    // filled in the same pass because `drawTerrainSurface`'s contract is that
    // `zones[i]` belongs to `points[i]`; building them separately is how they
    // would come to disagree by one sample at a chunk edge.
    const points: { x: number; y: number }[] = [];
    const zoned = this.zoneBands.length > 0;
    const zones: (ZoneKind | null)[] | undefined = zoned ? [] : undefined;
    for (const pt of this.elevationProfile) {
      const x = pt.distM * PX_PER_METER;
      if (x < visLeft) continue;
      points.push({ x, y: this.eleToY(pt.eleM, baselineY) });
      zones?.push(this.zoneAtDist(pt.distM));
      if (x > visRight) break;
    }

    if (points.length === 0) return;

    // Seed from camera position for deterministic wobble in hand-drawn styles
    const seed = Math.abs(Math.round(view.left * 0.1)) % 10000;

    // Fill down to the actual view bottom — with vertical follow and zoom the
    // camera bottom is no longer the canvas height.
    const intro = this.introT < INTRO_DURATION_S
      ? { t: this.introT, originX: this.introOriginX }
      : undefined;
    this.strategy.drawTerrainSurface(this.terrainGfx, points, view.bottom + 8, seed, intro, zones);
  }

  /**
   * Get the terrain surface Y coordinate for a given route distance.
   */
  getTerrainY(distanceM: number): number {
    const h = this.game.canvas.height;
    const baselineY = h * this.groundBaselineFraction;

    if (this.elevationProfile.length < 2) return baselineY;

    let lo = 0;
    let hi = this.elevationProfile.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.elevationProfile[mid].distM <= distanceM) lo = mid;
      else hi = mid;
    }

    const p0 = this.elevationProfile[lo];
    const p1 = this.elevationProfile[hi];
    const segLen = p1.distM - p0.distM;
    const t = segLen > 0 ? (distanceM - p0.distM) / segLen : 0;
    const ele = p0.eleM + (p1.eleM - p0.eleM) * Math.max(0, Math.min(1, t));

    const y = this.eleToY(ele, baselineY);
    // Land on the surface the style draws, not the mathematical one (the
    // Tetris style quantises to block rows). The camera also follows this
    // stepped value — its exponential smoothing turns the steps into an
    // arcade-appropriate gentle bob.
    return this.strategy.snapGroundY ? this.strategy.snapGroundY(y) : y;
  }

  /**
   * Get the terrain surface slope (degrees) at a given distance.
   */
  getTerrainSlope(distanceM: number): number {
    if (this.elevationProfile.length < 2) return 0;

    let lo = 0;
    let hi = this.elevationProfile.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.elevationProfile[mid].distM <= distanceM) lo = mid;
      else hi = mid;
    }

    const p0 = this.elevationProfile[lo];
    const p1 = this.elevationProfile[hi];
    const dx = (p1.distM - p0.distM) * PX_PER_METER;
    const dy = (p1.eleM - p0.eleM) * ELEVATION_EXAGGERATION;
    if (dx === 0) return 0;
    return Math.atan2(-dy, dx) * (180 / Math.PI);
  }

  // ── Visual polish ──

  /** Draw static markers: start/finish flags, distance ticks. */
  private drawStaticMarkers() {
    this.markerGfx.clear();
    // Reset any labels from a prior call (setElevationProfile + every resize).
    for (const lbl of this.kmLabels) lbl.destroy();
    this.kmLabels.length = 0;
    for (const t of this.staticFlagTexts) t.destroy();
    this.staticFlagTexts.length = 0;
    if (this.elevationProfile.length < 2) return;

    const markerColor = this.strategy.palette.markerTick;
    const markerFont = this.strategy.getMarkerFont();
    const markerHex = `#${markerColor.toString(16).padStart(6, '0')}`;

    const tickInterval = this.totalRouteDistM > 10000 ? 1000 : 500;
    for (let d = tickInterval; d < this.totalRouteDistM; d += tickInterval) {
      const x = d * PX_PER_METER;
      const groundY = this.getTerrainY(d);
      const isKm = d % 1000 === 0;

      this.markerGfx.lineStyle(isKm ? 2 : 1, markerColor, isKm ? 0.5 : 0.25);
      this.markerGfx.lineBetween(x, groundY, x, groundY - (isKm ? 20 : 10));

      if (isKm) {
        const label = this.add.text(x, groundY - 25, `${d / 1000}km`, {
          fontSize: '9px',
          color: markerHex,
          fontFamily: markerFont,
          align: 'center',
        });
        label.setOrigin(0.5, 1);
        label.setAlpha(0.6);
        label.setDepth(50);
        this.textLayer.add(label);
        this.kmLabels.push(label);
      }
    }

    this.staticFlagTexts.push(this.drawFlag(0, 0x76ff03, 'START'));
    this.staticFlagTexts.push(this.drawFlag(this.totalRouteDistM, 0xff3366, 'FINISH'));
  }

  /** Draw a flag at a given route distance — delegates to strategy.
   *  `gfx` defaults to the static marker layer (START/FINISH); workout flags
   *  pass their own layer so they can be faded once ridden past. */
  private drawFlag(
    distM: number,
    color: number,
    label: string,
    gfx: Phaser.GameObjects.Graphics = this.markerGfx,
  ): Phaser.GameObjects.Text {
    const x = distM * PX_PER_METER;
    const groundY = this.getTerrainY(distM);
    const seed = Math.abs(Math.round(distM * 7)) % 10000;

    this.strategy.drawFlag(gfx, x, groundY, color, label, seed);

    // Label text above the flag
    const markerFont = this.strategy.getMarkerFont();
    const text = this.add.text(x + 10, groundY - 50, label, {
      fontSize: '8px',
      color: `#${color.toString(16).padStart(6, '0')}`,
      fontFamily: markerFont,
      fontStyle: 'bold',
    });
    text.setOrigin(0.5, 1);
    text.setDepth(50);
    this.textLayer.add(text);
    return text;
  }

  /** Move the ground/sky boundary. Welcome lowers this so the visible green
   *  ground band shrinks to 10–20 % of canvas height; game mode keeps the
   *  default 0.75. Triggers a terrain redraw on the next frame. */
  setGroundBaselineFraction(fraction: number) {
    this.groundBaselineFraction = Math.max(0.5, Math.min(0.95, fraction));
    this.lastTerrainScrollX = NaN;
  }

  /** Read by PhaserWeatherSystem and TerrainChunkManager2D so sky/parallax
   *  and scenery features all stay vertically aligned with the terrain. */
  getGroundBaselineFraction(): number {
    return this.groundBaselineFraction;
  }

  /** 'game' or 'welcome' — style strategies use this to skip effects the game
   *  mode already gets from the glasses PostFX (e.g. cuphead's iris vignette,
   *  which would double up with the pipeline's own). */
  get sceneMode(): PhaserSceneMode {
    return this.mode;
  }

  /** Handle resize — recreate overlay/backdrop and reset terrain dirty flag.
   *  Everything positioned off the ground line must re-lay: the baseline is a
   *  fraction of the canvas height, so a resize MOVES the ground. */
  onResize(_w: number, _h: number) {
    // Destroy old overlay and recreate via strategy
    if (this.overlayObj) {
      this.overlayObj.destroy();
    }
    this.overlayObj = this.strategy.drawOverlay(this);

    this.backdropObj?.destroy();
    this.backdropObj = this.strategy.drawBackdrop?.(this) ?? null;

    // Re-seat ground-anchored one-shot drawings (km ticks, START/FINISH,
    // workout flags). Chunk scenery is the chunk manager's problem — the
    // renderer calls its reload() alongside this.
    if (this.mode === 'game' && this.elevationProfile.length >= 2) {
      this.drawStaticMarkers();
      this.passedFlagCount = -1; // force the flag layers to redraw
      this.updateWorkoutFlags(this.bridge.distanceM);
    }

    this.lastTerrainScrollX = NaN;
  }

  /**
   * Hot-swap the visual style strategy without rebuilding the Phaser game.
   * Rebuilds overlay + wind emitter (whose colors depend on the strategy)
   * and forces a terrain redraw on the next frame.
   *
   * Cyclist sprite textures are managed by cyclist-sprite.ts — caller must
   * separately invoke rebuildCyclistTextures() to refresh them.
   */
  setStrategy(newStrategy: PhaserStyleStrategy) {
    this.strategy = newStrategy;

    // Route bloom is style-dependent (plastic glows, cuphead doesn't).
    this.applyRouteBloom();

    // Rebuild overlay (CRT scanlines / film grain) + backdrop (neon grid)
    if (this.overlayObj) {
      this.overlayObj.destroy();
    }
    this.overlayObj = this.strategy.drawOverlay(this);

    this.backdropObj?.destroy();
    this.backdropObj = this.strategy.drawBackdrop?.(this) ?? null;

    // Rebuild wind emitter — its texture color comes from the strategy
    const initW = Number(this.game.config.width);
    const initH = Number(this.game.config.height);
    const wasActive = this.windEmitter.active;
    this.windEmitter.destroy();
    if (this.textures.exists('__wind_particle__')) {
      this.textures.remove('__wind_particle__');
    }
    const windColor = this.strategy.getWindParticleColor();
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 1;
    const wctx = c.getContext('2d')!;
    const wr = (windColor >> 16) & 0xff;
    const wg = (windColor >> 8) & 0xff;
    const wb = windColor & 0xff;
    wctx.fillStyle = `rgb(${wr},${wg},${wb})`;
    wctx.fillRect(0, 0, 2, 1);
    this.textures.addCanvas('__wind_particle__', c);
    this.windEmitter = this.add.particles(0, 0, '__wind_particle__', {
      x: { min: 0, max: initW + 100 },
      y: { min: 0, max: initH },
      speedX: { min: -400, max: -200 },
      speedY: 0,
      lifespan: 800,
      frequency: 80,
      quantity: 1,
      alpha: { start: this.strategy.getWindParticleAlpha(), end: 0 },
      scaleX: { min: 3, max: 8 },
      active: wasActive,
    });
    this.windEmitter.setScrollFactor(0);
    this.windEmitter.setDepth(450);

    // Finish-banner Text: font (getMarkerFont) and colour are style-dependent,
    // so drop it — the next aircraft frame lazily recreates it with the new
    // strategy. The last banner string is retained (finishBannerStr) and passed
    // straight back in, so the readout doesn't blank on a theme swap.
    this.finishBannerText?.destroy();
    this.finishBannerText = null;
    // Next drawAircraft frame uses the new strategy automatically (cleared gfx).
    this.finishAircraftGfx.clear();

    // Force terrain redraw next frame
    this.lastTerrainScrollX = NaN;
  }
}
