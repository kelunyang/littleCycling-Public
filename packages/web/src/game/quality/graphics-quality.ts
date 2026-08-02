/**
 * Graphics-quality tiers for the Three.js renderer.
 *
 * A single tier bundles every effect-budget knob the renderer cares about
 * (post-processing, particle counts, dynamic lights, terrain LOD…). The user
 * picks 'auto' | 'low' | 'medium' | 'high' in settings; 'auto' hands control to
 * the runtime fps governor below, the fixed tiers pin the budget.
 *
 * IMPORTANT: this module is pure data + logic. It never touches the render
 * loop directly — a later pass wires `QUALITY_PRESETS`, `guessInitialTier` and
 * `createQualityGovernor` into GameView. Keep it side-effect free (the only
 * exception is the throwaway probe canvas inside `guessInitialTier`).
 */

export type QualityTier = 'low' | 'medium' | 'high';

/** How much of the acrylic display case is built — see `acrylic-case.ts`. */
export type AcrylicCaseLevel = 'off' | 'shell' | 'full';

/** How much of the scene bloom chain runs — see `scene-bloom-pass.ts`. */
export type SceneBloomLevel = 'off' | 'cheap' | 'full';

/**
 * How much of the sun's shadow map is rendered — see `game-renderer.ts`.
 *
 * `full` is the demos' own map verbatim, 2048² — 0.176 m per texel across the
 * ±180 m box. `half` is 1024²: the same shadows cast by the same objects onto the
 * same receivers, at 0.352 m per texel, for a quarter of the depth target to
 * rasterise and 12 MB of it back on a machine whose dense-urban load is CPU/RAM
 * bound.
 *
 * The FILTER is not a tier knob. `PCFSoftShadowMap` is the demos' and it stays,
 * partly because a soft edge is a look rather than a budget, and partly because
 * `shadowMap.type` is a shader `#define`: changing it mid-ride recompiles every
 * material in the scene, which is exactly the hitch `applyQualityTier` is written
 * to avoid. Resizing the map only reallocates a render target.
 *
 * `off` exists and NO TIER USES IT. That is the deliberate part: ground contact
 * shadow is not an effect on top of this world, it is what stops every building
 * and tree from floating on a colour block (plan/2026-summer.md 「沒有接地陰影,
 * 房子樹木就是浮在色塊上,這是最大的一項」), so the same rule as
 * `maxLiveLampLights` applies — a tier may reduce HOW MUCH, not to NONE.
 *
 * The counter-argument is real and is why `hard` exists rather than nothing: a
 * shadow map is a second geometry pass, and the demos push ~111 K triangles into
 * it where a dense gameview chunk pushes millions. The evidence in favour is that
 * the demos hold 30 fps on the target N100 *with* 2048² PCFSoft *and* eight live
 * PointLights, which gameview's low tier does not have. That is encouraging, not
 * decisive — GPU cost cannot be measured from WSL. If `avgGpuMs` (gpu-timer.ts,
 * in the per-second perf record) jumps on the N100, this is the switch: `low`
 * becomes `'off'` and nothing else changes.
 */
export type ShadowLevel = 'off' | 'half' | 'full';

export interface QualityParams {
  /** devicePixelRatio cap fed to renderer.setPixelRatio(). */
  pixelRatio: number;
  /** Whether the CYCLING-GLASSES selective bloom pass runs at all.
   *
   *  This is the lens effect in cycling-glasses-effect.ts: a second render of
   *  the scene masked to BLOOM_LAYER, blurred through UnrealBloomPass. It is NOT
   *  the demos' whole-scene bloom — that one is `sceneBloom`, below, and the two
   *  are independent. (The bloom render-target resolution scale is not a tier
   *  knob — it lives as BLOOM_RESOLUTION_SCALE in cycling-glasses-effect.ts.) */
  bloomEnabled: boolean;
  /**
   * The demos' hand-rolled WHOLE-SCENE threshold bloom (`scene-bloom-pass.ts`).
   *
   * A ceiling, not a switch: the rider asks for it per world
   * (`StyleParams.sceneBloomEnabled`), and this decides how much of that wish
   * survives. `off` at `low` is not negotiable — measured on the target N100,
   * bloom's cost is pure GPU and scales with PIXELS (+16.6 ms on the demo, a
   * whole vsync, with jsMs unmoved), on a frame that is already 64 ms. A switch
   * that drops that machine to 10 fps is a trap, not a feature.
   */
  sceneBloom: SceneBloomLevel;
  /**
   * The acrylic display case over the diorama (`acrylic-case.ts`).
   *
   * Same contract as `sceneBloom`: the rider's switch is intent, this is the
   * ceiling, and the fps governor moves it by moving the tier. `shell` keeps the
   * 罩壁 — shell + rim, the two parts that say "case" — and drops the lit lip
   * and the rain film.
   *
   * ⚠ Do NOT re-derive this from a bounding-sphere metric. `PERF_AUDIT.md` named
   * this the top fill-rate risk on exactly that evidence and was wrong by two
   * orders of magnitude: measured, the demo's case cost 0.2 ms, because terrain
   * and the mountain rings occlude nearly all of it and the hidden fragments die
   * on early-Z. 大包圍球 ≠ 填得多.
   */
  acrylicCase: AcrylicCaseLevel;
  /**
   * The sun's shadow map (`game-renderer.ts`).
   *
   * Unlike `acrylicCase` / `sceneBloom` there is no rider switch to AND with —
   * the rider's intent here is "play the game", because the four style files have
   * been setting `castShadow` / `receiveShadow` on their props all along. This is
   * the ceiling and the whole of it.
   */
  sunShadow: ShadowLevel;
  /** true = full cycling-glasses FX chain; false = cheap tint-only glasses. */
  glassesFullFx: boolean;
  /** Max particles in the rain system. */
  rainParticleCount: number;
  /** Max particles in the snow system. */
  snowParticleCount: number;
  /** Kick up road dust behind the rider. */
  dustEnabled: boolean;
  /** Blowing leaves ambient particles. */
  leavesEnabled: boolean;
  /** Billboard cloud count. */
  cloudCount: number;
  /** Cap on simultaneously-lit street lamps (0 = lamps are unlit meshes). */
  maxLiveLampLights: number;
  /** Multiplier applied to terrain grid spacing (higher = coarser = cheaper). */
  gridSizeMultiplier: number;
  /** Per-chunk extruded-building budget (largest footprints kept). Dense z14
   *  tiles carry thousands of merged footprints; the tier caps how many a
   *  chunk extrudes so weak iGPUs stay above water while strong ones get the
   *  whole city. */
  maxBuildingsPerChunk: number;
  /** Drop detail on far terrain chunks. */
  farChunkLod: boolean;
  /** Paper-style ink outline pass (cuphead world style). */
  paperOutlineEnabled: boolean;
  /** Paper-style bump/corrugation detail (cuphead world style). */
  paperBumpEnabled: boolean;
  /** Sample count used by the sightline-clamp raycast. */
  sightlineSamples: number;
  /** Run the sightline clamp every N frames (1 = every frame). */
  sightlineFrameInterval: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityParams> = {
  low: {
    pixelRatio: 1.0,
    bloomEnabled: false,
    // Both heavy full-screen effects OFF, and the tier wins over the rider's
    // switch. This is the N100 tier — 16 fps median, 64 ms frames, fill-rate
    // bound with fourteen ground-covering layers already stacked.
    sceneBloom: 'off',
    acrylicCase: 'off',
    // NOT 'off'. See ShadowLevel — the cheap map keeps the world standing on its
    // own ground, and this is the one knob to reach for first if the N100's
    // `avgGpuMs` says otherwise.
    sunShadow: 'half',
    glassesFullFx: false,
    rainParticleCount: 800,
    snowParticleCount: 500,
    dustEnabled: false,
    leavesEnabled: false,
    cloudCount: 8,
    // NOT zero, however tempting. At 0 the night is lit by ambient 0.18 + hemi
    // 0.5 + moon 0.7 and nothing else — no pool of light anywhere in the frame
    // — and the world reads as black (cuphead) or as a flat purple wash
    // (plastic, whose night sky and fog are purple). Reported from a real ride.
    //
    // Everything else about gameview's night already matches the demo exactly:
    // the light sums (3.25 day → 1.38 night), the fog colour, and each lamp's
    // own `PointLight(colour, 0, 26, 1.8)` at `intensity = k * 14`. The demo
    // lights EVERY lamp; this tier lit none, and that one number was the whole
    // difference.
    //
    // A tier may reduce HOW MANY lamps cast light — nobody can tell 8 from 3 —
    // but not to none, because that stops being "the same world drawn more
    // cheaply" and becomes a different world. Same principle as the zone
    // brightness floor that `check:3d` guards.
    maxLiveLampLights: 3,
    gridSizeMultiplier: 1.5,
    maxBuildingsPerChunk: 800,
    farChunkLod: true,
    paperOutlineEnabled: false,
    paperBumpEnabled: false,
    sightlineSamples: 3,
    sightlineFrameInterval: 2,
  },
  medium: {
    pixelRatio: 1.25,
    bloomEnabled: true,
    // The demos' own default is the cheap chain (`POST_LEVEL = 1`): the glow is
    // all there, only its near-end detail and the render target's MSAA are not.
    sceneBloom: 'cheap',
    // 罩壁 only. The crown streaks live in the shell, so the cut-down case still
    // reads as a case rather than as tinted air.
    acrylicCase: 'shell',
    // The demos' own map from here up. A shadow at half resolution reads as a
    // blurrier shadow, not as a cheaper world, so there is no middle rung worth
    // inventing between `half` and the demos'.
    sunShadow: 'full',
    glassesFullFx: true,
    rainParticleCount: 1500,
    snowParticleCount: 1000,
    dustEnabled: true,
    leavesEnabled: true,
    cloudCount: 12,
    maxLiveLampLights: 4,
    gridSizeMultiplier: 1.25,
    maxBuildingsPerChunk: 2000,
    farChunkLod: true,
    paperOutlineEnabled: true,
    paperBumpEnabled: false,
    sightlineSamples: 5,
    sightlineFrameInterval: 1,
  },
  high: {
    pixelRatio: 1.5,
    bloomEnabled: true,
    sceneBloom: 'full',
    acrylicCase: 'full',
    sunShadow: 'full',
    glassesFullFx: true,
    rainParticleCount: 3000,
    snowParticleCount: 2000,
    dustEnabled: true,
    leavesEnabled: true,
    cloudCount: 18,
    maxLiveLampLights: 8,
    gridSizeMultiplier: 1.0,
    maxBuildingsPerChunk: 3000,
    farChunkLod: false,
    paperOutlineEnabled: true,
    paperBumpEnabled: true,
    sightlineSamples: 5,
    sightlineFrameInterval: 1,
  },
};

/**
 * First-guess tier from device hints. HEURISTIC ONLY — treat the result as a
 * starting point, never as the truth.
 *
 * The GPU renderer string from WEBGL_debug_renderer_info is unreliable: on most
 * browsers it comes back through an ANGLE wrapper ("ANGLE (Intel, …)"), is
 * deliberately masked, or reports a software rasterizer name that doesn't match
 * real throughput. So the string only nudges the guess; the fps governor
 * (createQualityGovernor) is the real authority and will correct a bad guess
 * within the first minute of play.
 */
export function guessInitialTier(): QualityTier {
  let renderer = '';
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
      }
      // Release the probe context so it doesn't count against the browser's
      // live-context limit.
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch {
    // Any failure just means we fall through to the CPU/memory heuristic.
    renderer = '';
  }

  // Weak/integrated/software GPUs → start low.
  if (/UHD|HD Graphics|N100|Celeron|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(renderer)) {
    return 'low';
  }
  // Discrete GPU hints → start high; the governor can still drop it.
  if (/RTX|GTX|Radeon RX|Arc A|Arc B/i.test(renderer)) {
    return 'high';
  }

  // No decisive GPU signal — fall back to CPU cores / device memory.
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  if (cores <= 4 || memory <= 4) return 'low';
  if (cores <= 8) return 'medium';
  // Plenty of cores but no discrete-GPU signal — stay conservative and let the
  // governor raise us if the frame rate proves it out.
  return 'medium';
}

const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high'];

/** Next tier down, or the same tier if already at the floor. */
function tierDown(tier: QualityTier): QualityTier {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? TIER_ORDER[i - 1] : tier;
}

/** Next tier up, or the same tier if already at the ceiling. */
function tierUp(tier: QualityTier): QualityTier {
  const i = TIER_ORDER.indexOf(tier);
  return i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : tier;
}

export interface QualityGovernor {
  /** Feed one averaged fps sample (~one per second). */
  pushFpsSample(fps: number): void;
  /** Current tier. */
  getTier(): QualityTier;
  /** Detach — no timers are held, but call it for symmetry/future-proofing. */
  dispose(): void;
}

/**
 * Runtime fps governor. The caller pushes one averaged fps sample per second
 * (the game loop already computes fps once/sec). The governor:
 *
 *  - Drops a tier (never below 'low') when TWO consecutive 5-sample windows
 *    both average below 45 fps — a sustained slump, not a one-off hitch.
 *  - Raises a tier at most ONCE per lifetime, and only after 12 consecutive
 *    samples (~60s) all above 58 fps. The single-raise cap is deliberate
 *    hysteresis: it stops the governor oscillating up/down forever on a machine
 *    that sits right at the boundary.
 *
 * Window/streak state is reset after any tier change so the next decision
 * starts from clean measurements. Purely sample-count driven — no Date.now,
 * no timers.
 */
export function createQualityGovernor(opts: {
  initialTier: QualityTier;
  onTierChange: (tier: QualityTier, reason: string) => void;
}): QualityGovernor {
  const WINDOW_SIZE = 5;
  const LOW_FPS = 45;
  const HIGH_FPS = 58;
  const RAISE_STREAK = 12;

  let tier = opts.initialTier;

  // Rolling window for the drop decision.
  let window: number[] = [];
  let lowWindows = 0; // consecutive completed windows averaging < LOW_FPS

  // Streak for the (one-shot) raise decision.
  let highStreak = 0;
  let raiseUsed = false;

  function resetState(): void {
    window = [];
    lowWindows = 0;
    highStreak = 0;
  }

  function pushFpsSample(fps: number): void {
    // ── Raise streak (one raise per lifetime) ──
    if (!raiseUsed && tier !== 'high') {
      if (fps > HIGH_FPS) {
        highStreak++;
        if (highStreak >= RAISE_STREAK) {
          const next = tierUp(tier);
          if (next !== tier) {
            tier = next;
            raiseUsed = true;
            resetState();
            opts.onTierChange(tier, `sustained ${RAISE_STREAK}s above ${HIGH_FPS} fps`);
            return;
          }
        }
      } else {
        highStreak = 0;
      }
    }

    // ── Drop windows ──
    window.push(fps);
    if (window.length >= WINDOW_SIZE) {
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      window = [];
      if (avg < LOW_FPS) {
        lowWindows++;
        if (lowWindows >= 2 && tier !== 'low') {
          const next = tierDown(tier);
          tier = next;
          resetState();
          opts.onTierChange(tier, `two windows below ${LOW_FPS} fps (avg ~${Math.round(avg)})`);
          return;
        }
      } else {
        lowWindows = 0;
      }
    }
  }

  return {
    pushFpsSample,
    getTier: () => tier,
    dispose: () => {
      resetState();
    },
  };
}
