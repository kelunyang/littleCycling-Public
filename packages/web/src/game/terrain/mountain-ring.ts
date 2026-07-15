/**
 * Distant mountain silhouette — the one piece of far scenery the 3D world was
 * missing (Phaser 2D has had its two-layer parallax mountains all along).
 *
 * Two vertical strip rings around the rider plus a horizon disc:
 *  - The rings TRANSLATE with the rider but never rotate, so the near ring
 *    slides past the far one exactly like 2D parallax.
 *  - The disc is the surface the whole diorama sits on (cuphead → desk wood,
 *    plastic → toy play-mat). It fills the void beyond the terrain corridor,
 *    which the sky dome would otherwise paint (three's `Sky` is a BackSide box
 *    covering the lower hemisphere too — that's what the old 10 km ground plane
 *    was for). It is an ANNULUS starting just past the corridor, so it can
 *    never slice through the terrain the rider is actually riding on, however
 *    deep the valley.
 *
 * Profiles come from the strategy (`generateMountainProfile`), so cuphead gets
 * jagged peaks and plastic gets quantised brick steps. Toon materials → the
 * day/night lighting tints them for free. 3 draw calls total.
 */

import * as THREE from 'three';
import type { MountainLayer, TerrainStyleStrategy } from './terrain-style-strategy';

/** Ring radii in metres. Sunny fog is 800–3000, so both sit inside the haze. */
const NEAR_RADIUS = 1700;
const FAR_RADIUS = 2600;

/** Peak heights at full profile (1.0). Tuned to the demos' angular size. */
const NEAR_MAX_HEIGHT = 560;
const FAR_MAX_HEIGHT = 430;

/** Segments around each ring — 160 matches the demos' jaggedness. */
const SEGMENTS = 160;

/** How far the rings' skirts drop below the rider, so no gap ever shows. */
const SKIRT_DROP = 400;

/**
 * The horizon disc sits this far below the rider's ground — the step down from
 * the diorama's baseboard to the desk it stands on (the demos use ~10 m below a
 * 65 m half-board; the game's corridor is far wider, so the step is bigger).
 */
const DISC_DROP = 35;

/** Clearance between the terrain corridor's edge and the disc's inner rim. */
const DISC_INNER_MARGIN = 40;

/** Disc outer radius: past the far ring, inside the sky dome (scaled 4500). */
const DISC_OUTER_RADIUS = 4000;

/** Fallback corridor half-width when the caller doesn't pass one (config default). */
const DEFAULT_CORRIDOR_HALF_WIDTH = 500;

export class MountainRing {
  private readonly scene: THREE.Scene;
  private readonly seed: number;
  private readonly discInnerRadius: number;

  private near: THREE.Mesh | null = null;
  private far: THREE.Mesh | null = null;
  private disc: THREE.Mesh | null = null;

  /**
   * @param seed  Skyline seed — randomise once per session (same as the 2D
   *              `mountainSeed`) so every ride gets its own horizon.
   * @param corridorHalfWidth  The terrain corridor's half-width; the disc starts
   *              beyond it so it never overlaps real terrain.
   */
  constructor(
    scene: THREE.Scene,
    strategy: TerrainStyleStrategy,
    seed: number,
    corridorHalfWidth = DEFAULT_CORRIDOR_HALF_WIDTH,
  ) {
    this.scene = scene;
    this.seed = seed;
    this.discInnerRadius = Math.min(
      corridorHalfWidth + DISC_INNER_MARGIN,
      DISC_OUTER_RADIUS - 100,
    );
    this.build(strategy);
  }

  /** Rebuild both rings + disc for a new style (world-style switch). */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.disposeMeshes();
    this.build(strategy);
  }

  private build(strategy: TerrainStyleStrategy): void {
    this.far = this.buildRing(strategy, 'far', FAR_RADIUS, FAR_MAX_HEIGHT, this.seed);
    this.near = this.buildRing(strategy, 'near', NEAR_RADIUS, NEAR_MAX_HEIGHT, this.seed ^ 0x5f3759df);
    this.scene.add(this.far);
    this.scene.add(this.near);

    // Annulus, not a full circle: the hole is where the terrain corridor lives,
    // so the disc can never be drawn on top of the ground the rider is on.
    const discGeo = new THREE.RingGeometry(this.discInnerRadius, DISC_OUTER_RADIUS, 64, 1);
    discGeo.rotateX(-Math.PI / 2);
    // Toon (not Basic) so the desk / play-mat darkens with the day-night cycle.
    const discMat = new THREE.MeshToonMaterial({
      color: strategy.horizonColor,
      side: THREE.DoubleSide,
    });
    this.disc = new THREE.Mesh(discGeo, discMat);
    this.disc.frustumCulled = false;
    this.scene.add(this.disc);
  }

  /**
   * One ring: a vertical strip whose top edge follows the style's profile and
   * whose bottom edge drops far below. DoubleSide because the ring is seen from
   * the inside (demo pitfall #2: a single-sided strip with the wrong winding
   * disappears entirely).
   */
  private buildRing(
    strategy: TerrainStyleStrategy,
    layer: MountainLayer,
    radius: number,
    maxHeight: number,
    seed: number,
  ): THREE.Mesh {
    const profile = strategy.generateMountainProfile(layer, seed, SEGMENTS);

    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const h = (profile[i] ?? 0) * maxHeight;
      positions.push(x, -SKIRT_DROP, z);
      positions.push(x, h, z);
      if (i < SEGMENTS) {
        const k = i * 2;
        indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshToonMaterial({
      color: strategy.mountainColor(layer),
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // The ring is always centred on the rider — culling it by its (stale)
    // bounding sphere would pop the whole horizon out.
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Follow the rider. Translation only — no rotation — so the two rings drift
   * against each other and read as parallax.
   *
   * @param riderPosition  Rider ground position in scene metres.
   */
  update(riderPosition: THREE.Vector3): void {
    const { x, y, z } = riderPosition;
    this.near?.position.set(x, y, z);
    this.far?.position.set(x, y, z);
    this.disc?.position.set(x, y - DISC_DROP, z);
  }

  private disposeMeshes(): void {
    for (const mesh of [this.near, this.far, this.disc]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.near = null;
    this.far = null;
    this.disc = null;
  }

  dispose(): void {
    this.disposeMeshes();
  }
}
