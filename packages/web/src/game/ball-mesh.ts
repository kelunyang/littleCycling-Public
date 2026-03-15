import * as THREE from 'three';

const NORMAL_COLOR = 0xff0000;
const NORMAL_EMISSIVE = 0x330000;
const DARK_COLOR = 0x660000;
const DARK_EMISSIVE = 0x000000;

export function createBallMesh(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(3, 24, 16);
  const material = new THREE.MeshPhongMaterial({
    color: NORMAL_COLOR,
    emissive: NORMAL_EMISSIVE,
    shininess: 80,
  });
  return new THREE.Mesh(geometry, material);
}

export function setBallDarkened(ball: THREE.Mesh, dark: boolean) {
  const mat = ball.material as THREE.MeshPhongMaterial;
  mat.color.setHex(dark ? DARK_COLOR : NORMAL_COLOR);
  mat.emissive.setHex(dark ? DARK_EMISSIVE : NORMAL_EMISSIVE);
}
