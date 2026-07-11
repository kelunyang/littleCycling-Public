/**
 * Phaser.Game factory for the Phaser 2D side-scrolling mode.
 *
 * Dynamic-imports Phaser for code-splitting (~1MB) and creates a
 * game instance whose loop is driven externally by useGameLoop.
 *
 * Uses WebGL renderer so custom PostFX pipelines (cycling glasses +
 * tunnel vision) can run as GLSL shaders. The pipelines are registered
 * via the GameConfig.pipeline map before the game boots.
 *
 * Phaser's internal rAF loop is paused via sleep() after the first
 * frame (postBoot fires before loop.start(), so sleep() must be
 * deferred). Each frame, the caller invokes tick() which calls
 * game.loop.tick() — one full Phaser frame without restarting rAF.
 */

import type { Phaser2DScene, PhaserBridge, PhaserSceneMode } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

export interface PhaserGameInstance {
  game: Phaser.Game;
  scene: Phaser2DScene;
  bridge: PhaserBridge;
  /** Drive one full Phaser frame (scene update + render). */
  tick(dtMs: number): void;
  destroy(): void;
}

export interface PhaserGameOptions {
  /** Defaults to 'game'. 'welcome' skips the cycling-glasses post-FX so the welcome backdrop stays clean. */
  mode?: PhaserSceneMode;
}

/**
 * Create a Phaser game attached to the given canvas element.
 *
 * Phaser's internal loop is disabled — the caller drives rendering
 * via `tick()` each frame, matching how useGameLoop controls Three.js.
 */
export async function createPhaserGame(
  canvas: HTMLCanvasElement,
  strategy: PhaserStyleStrategy,
  options: PhaserGameOptions = {},
): Promise<PhaserGameInstance> {
  // Dynamic import for code splitting
  const Phaser = await import('phaser');
  const { Phaser2DScene: SceneClass } = await import('./phaser2d-scene');
  const { CyclingGlassesPipeline, CYCLING_GLASSES_PIPELINE_KEY } = await import('./cycling-glasses-pipeline');
  const { TunnelVisionPipeline, TUNNEL_VISION_PIPELINE_KEY } = await import('./tunnel-vision-pipeline');

  // Shared bridge object — plain JS, not reactive
  const bridge: PhaserBridge = {
    distanceM: 0,
    elevationM: 0,
    speedKmh: 0,
    cadenceRpm: 0,
    isDarkened: false,
    bearing: 0,
    weather: 'sunny',
    sunElevation: 45,
    moonPhase: 0,
  };

  const scene = new SceneClass(bridge, strategy, options.mode ?? 'game');

  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    canvas,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    backgroundColor: '#000000',
    scene: [scene],
    autoFocus: false,
    render: {
      pixelArt: true,
      antialias: false,
    },
    // Custom GLSL pipelines for the cycling-glasses look (lens tint, vignette,
    // distortion, lens marks, zone ambient, coin glow) and tunnel vision blur.
    pipeline: {
      [CYCLING_GLASSES_PIPELINE_KEY]: CyclingGlassesPipeline,
      [TUNNEL_VISION_PIPELINE_KEY]: TunnelVisionPipeline,
    } as any,
    // No physics engine — ball movement comes from the server simulation
    physics: {
      default: false as any,
    },
    callbacks: {
      postBoot: (g) => {
        // postBoot fires BEFORE loop.start() in Phaser's boot sequence,
        // so sleep()/stop() here are no-ops (running is still false).
        // Defer to after the first frame when running=true.
        g.events.once('step', () => {
          g.loop.sleep();
        });
      },
    },
  });

  function tick(_dtMs: number) {
    if (!game) return;
    // tick() manually fires one Phaser frame through TimeStep's proper
    // timing pipeline (delta smoothing, frame counting) without scheduling
    // another rAF. Safe because sleep() kept started=true.
    game.loop.tick();
  }

  function destroy() {
    game.destroy(false);
  }

  return { game, scene, bridge, tick, destroy };
}
