import * as THREE from 'three';
import { createCoinMesh } from './coin-mesh';

/**
 * Object pool for coin meshes.
 * Avoids GC pressure from frequent creation/destruction.
 *
 * The coin's LOOK comes from the caller: the Three.js world passes the active
 * world-style factory (cuphead → gold push-pin, plastic → stud-topped tile);
 * other renderers fall back to the plain gold disc.
 */
export class CoinPool {
  private free: THREE.Mesh[] = [];
  private all: THREE.Mesh[] = [];
  private scene: THREE.Scene;
  private readonly factory: () => THREE.Mesh;

  constructor(scene: THREE.Scene, factory: () => THREE.Mesh = createCoinMesh) {
    this.scene = scene;
    this.factory = factory;
  }

  acquire(): THREE.Mesh {
    let mesh = this.free.pop();
    if (!mesh) {
      mesh = this.factory();
      this.scene.add(mesh);
      this.all.push(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  release(mesh: THREE.Mesh) {
    mesh.visible = false;
    this.free.push(mesh);
  }

  /** Remove every mesh this pool ever handed out, and free its GPU resources. */
  dispose() {
    for (const mesh of this.all) {
      this.scene.remove(mesh);
      mesh.traverse((obj) => {
        const m = obj as THREE.Mesh;
        // The legacy `createCoinMesh` hands out module-level singletons shared
        // with the other renderers — tagged `shared`, and not ours to free.
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
        const mat = m.material;
        if (mat instanceof THREE.Material && !mat.userData.shared) mat.dispose();
      });
    }
    this.free.length = 0;
    this.all.length = 0;
  }
}
