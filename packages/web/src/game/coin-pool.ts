import * as THREE from 'three';
import { createCoinMesh } from './coin-mesh';

/**
 * Object pool for coin meshes.
 * Avoids GC pressure from frequent creation/destruction.
 */
export class CoinPool {
  private free: THREE.Mesh[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  acquire(): THREE.Mesh {
    let mesh = this.free.pop();
    if (!mesh) {
      mesh = createCoinMesh();
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  release(mesh: THREE.Mesh) {
    mesh.visible = false;
    this.free.push(mesh);
  }

  dispose() {
    for (const mesh of this.free) {
      this.scene.remove(mesh);
    }
    this.free.length = 0;
  }
}
