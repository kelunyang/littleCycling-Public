import * as THREE from 'three';

// Shared geometry & material (avoid duplicating for every coin)
// Rotate geometry so the coin stands upright (flat face vertical).
// CylinderGeometry axis is Y; rotateX(π/2) moves it to Z, so mesh.rotation.y spins correctly.
const coinGeometry = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 16);
coinGeometry.rotateX(Math.PI / 2);

const coinMaterial = new THREE.MeshPhongMaterial({
  color: 0xffd700,
  emissive: 0x886600,
  shininess: 120,
  specular: 0xffffff,
});

export function createCoinMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(coinGeometry, coinMaterial);
  mesh.userData.isCoin = true;
  return mesh;
}
