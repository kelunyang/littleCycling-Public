/**
 * MapLibre custom layer that renders a Three.js red ball on the 3D map.
 *
 * Uses the standard MapLibre custom layer pattern:
 * - Pick a model origin in Mercator coordinates
 * - Build a model→mercator transform (translate + scale + rotation)
 * - Multiply MapLibre's projection matrix with the model transform
 * - Position the ball mesh in meters relative to the origin
 */

import * as THREE from 'three';
import type { GameMap, GameCustomLayerInterface, MercatorFromLngLat } from './map-adapter';
import { createBallMesh, setBallDarkened } from './ball-mesh';
import { CoinPool } from './coin-pool';
import type { CoinVisual, CoinLayerInterface } from './coin-interface';

export type { CoinVisual, CoinLayerInterface };

/** Internal coin with typed mesh for Three.js rendering. */
interface ThreeCoinVisual extends CoinVisual {
  mesh: THREE.Mesh;
}

export class ThreeBallLayer implements GameCustomLayerInterface {
  id = 'three-ball';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private camera!: THREE.Camera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private ball!: THREE.Mesh;
  private map!: GameMap;

  // Model origin in Mercator (set once, stays fixed)
  private originMerc = { x: 0.5, y: 0.5, z: 0 };
  private originScale = 1; // meters per mercator unit at origin

  // Ball position in meters relative to origin
  private ballOffsetM = { x: 0, y: 0, z: 0 };

  // Current LngLat for the ball
  private ballLngLat: [number, number] = [0, 0];
  private ballAltitude = 0;

  // Coin system
  private coins: ThreeCoinVisual[] = [];
  private coinPool!: CoinPool;
  private frameCount = 0;

  constructor(private mercatorFromLngLat: MercatorFromLngLat) {}

  onAdd(map: any, gl: WebGLRenderingContext) {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(0, 70, 100).normalize();
    this.scene.add(directional);

    // Ball
    this.ball = createBallMesh();
    this.scene.add(this.ball);

    // Coin pool
    this.coinPool = new CoinPool(this.scene);

    // Renderer — reuse MapLibre's GL context
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as any,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGLRenderingContext, matrix: ArrayLike<number>) {
    if (!this.ball) return;

    this.frameCount++;

    // The ball sits at origin, offset vertically by altitude
    // Ball radius is 3 in Three.js units = 3 meters
    this.ball.position.set(
      this.ballOffsetM.x,
      this.ballOffsetM.z + 3, // raise ball above ground by its radius
      this.ballOffsetM.y,
    );

    // Update coin positions relative to ball (origin)
    const cosLat = Math.cos((this.ballLngLat[1] * Math.PI) / 180);
    for (const coin of this.coins) {
      const dLon = coin.lngLat[0] - this.ballLngLat[0];
      const dLat = coin.lngLat[1] - this.ballLngLat[1];
      const offsetX = dLon * 111320 * cosLat;
      const offsetY = dLat * 111320;
      const offsetZ = coin.altitude - this.ballAltitude;

      // Coin height: 2m above ground + gentle bobbing
      const bob = Math.sin(this.frameCount * 0.05 + offsetX) * 0.3;
      // Negate offsetY: scene +Z maps to Mercator +Y (south), but +dLat = north
      coin.mesh.position.set(offsetX, offsetZ + 2 + bob, -offsetY);

      // Spin around vertical axis (coin stands upright via mesh factory)
      coin.mesh.rotation.y += 0.05;
    }

    // Build model transform: translate to mercator origin, then scale from meters to mercator units
    const metersToMerc = 1 / this.originScale;
    const modelMatrix = new THREE.Matrix4()
      .makeTranslation(this.originMerc.x, this.originMerc.y, this.originMerc.z)
      .scale(new THREE.Vector3(metersToMerc, -metersToMerc, metersToMerc))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

    // MapLibre v4: projection matrix is the second argument (mercator → clip space)
    const projMatrix = new THREE.Matrix4().fromArray(matrix);
    this.camera.projectionMatrix = projMatrix.multiply(modelMatrix);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }

  setBallPosition(lngLat: [number, number], altitudeM: number) {
    this.ballLngLat = lngLat;
    this.ballAltitude = altitudeM;

    // Compute mercator for the ball
    const ballMerc = this.mercatorFromLngLat(lngLat, altitudeM);

    // Update origin to ball position (so ball is always at scene center = best precision)
    this.originMerc = { x: ballMerc.x, y: ballMerc.y, z: ballMerc.z };
    this.originScale = 1 / ballMerc.meterInMercatorCoordinateUnits();

    // Ball is at origin → offset is zero
    this.ballOffsetM = { x: 0, y: 0, z: 0 };

    this.map?.triggerRepaint();
  }

  setDarkened(dark: boolean) {
    if (this.ball) {
      setBallDarkened(this.ball, dark);
    }
  }

  // ── Coin management ──

  spawnCoin(lngLat: [number, number], altitude: number): CoinVisual {
    const mesh = this.coinPool.acquire();
    const coin: ThreeCoinVisual = { mesh, lngLat, altitude };
    this.coins.push(coin);
    this.map?.triggerRepaint();
    return coin;
  }

  removeCoin(coin: CoinVisual) {
    const idx = this.coins.indexOf(coin as ThreeCoinVisual);
    if (idx >= 0) {
      this.coins.splice(idx, 1);
      this.coinPool.release(coin.mesh as THREE.Mesh);
    }
  }

  clearCoins() {
    for (const coin of this.coins) {
      this.coinPool.release(coin.mesh);
    }
    this.coins.length = 0;
  }
}
