/**
 * Ghost rider (P8 幽靈車) — 過去的自己,以半透明的第二台 BikeOrnament 沿路線
 * 對騎。位置由 gameStateStore 的內插幽靈距離導出(與玩家同一條管線),這裡只
 * 負責視覺:半透明化、名牌、輪組動畫的速度推導。
 *
 * 半透明化:每次 build/換主題後 traverse 車體,把每個材質換成調過
 * transparent/opacity 的 clone(共享單例材質不可變異也不可 dispose —— 見
 * applyGhostTranslucency 的規則)。
 *
 * 名牌:billboard sprite(Canvas 烘字),不掛在車體上 —— 每幀跟位,玩家的
 * 名牌也用同一個 helper(useTerrainRenderer 持有),兩張名牌只在幽靈模式
 * 啟動時出現(開發者指定:防止玩家與幽靈搞混)。
 */

import * as THREE from 'three';
import { BikeOrnament } from './bike-ornament';
import type { TerrainStyleStrategy } from './terrain-style-strategy';

/** 幽靈車體不透明度(名牌另有自己的透明度)。 */
const GHOST_OPACITY = 0.45;

/** 名牌懸浮高度(公尺,車體上方)。玩家名牌(useTerrainRenderer 持有)共用。 */
export const NAMEPLATE_HEIGHT = 3.2;

/**
 * 烘一張名牌 sprite:深色圓角膠囊 + 白字。`ghost: true` 時整體再降透明度、
 * 文字帶淡紫,一眼分得出誰是幽靈。回傳的 sprite 由呼叫端 add 進 scene 並
 * 負責 dispose(material.map + material)。
 */
export function createNameplate(text: string, ghost: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = 'bold 44px "Segoe UI", "Noto Sans TC", sans-serif';
  ctx.font = font;
  const textW = Math.ceil(ctx.measureText(text).width);
  const padX = 28;
  const h = 76;
  canvas.width = textW + padX * 2;
  canvas.height = h;

  // 膠囊底。
  ctx.fillStyle = ghost ? 'rgba(30, 24, 52, 0.55)' : 'rgba(10, 14, 26, 0.7)';
  ctx.beginPath();
  const r = h / 2;
  ctx.roundRect(0, 4, canvas.width, h - 8, r);
  ctx.fill();

  // 文字。
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ghost ? 'rgba(214, 200, 255, 0.95)' : '#ffffff';
  ctx.fillText(text, canvas.width / 2, h / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: ghost ? 0.8 : 0.95,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  // 世界尺寸:高 ~1.6m,寬按長寬比。
  const worldH = 1.6;
  sprite.scale.set((canvas.width / h) * worldH, worldH, 1);
  return sprite;
}

/** 釋放 createNameplate 的 sprite(map + material)。 */
export function disposeNameplate(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

/**
 * 把一棵車體的所有材質換成半透明 clone,clone 存進 `cache`(來源材質 → clone)
 * 供重複使用(去重、以及來源為共享單例時跨重建重用)。
 *
 * 規則:同一個原始材質只 clone 一次(cache 對映);原始材質若非共享單例
 * (`userData.shared`)就地 dispose(clone 已取代它,否則洩漏);clone 標記
 * `userData.shared = true`,讓 BikeOrnament 重建/銷毀時的 disposeGroup 跳過它
 * —— clone 的釋放改由 GhostRider 透過 cache 掌管(見 disposeGhostMats)。
 */
function applyGhostTranslucency(
  root: THREE.Object3D,
  cache: Map<THREE.Material, THREE.Material>,
): void {
  const ghostify = (mat: THREE.Material): THREE.Material => {
    let clone = cache.get(mat);
    if (!clone) {
      clone = mat.clone();
      clone.userData = { shared: true };
      clone.transparent = true;
      clone.opacity = (mat.opacity || 1) * GHOST_OPACITY;
      clone.depthWrite = false;
      cache.set(mat, clone);
      if (!mat.userData?.shared) mat.dispose();
    }
    return clone;
  };
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.Sprite).isSprite) return;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    mesh.material = Array.isArray(mat) ? mat.map(ghostify) : ghostify(mat);
  });
}

export class GhostRider {
  private readonly scene: THREE.Scene;
  private bike: BikeOrnament;
  private nameplate: THREE.Sprite;

  /** 輪組動畫的速度推導(距離差/時間)。 */
  private lastDistM: number | null = null;
  private speedMps = 0;

  /**
   * 半透明 clone 快取(來源材質 → clone)。跨重建保留以去重/重用;GhostRider
   * 掌管其釋放(clone 標了 shared,BikeOrnament 的 disposeGroup 不碰)。用
   * Map(非 WeakMap)因為銷毀時需要走訪整批 clone 逐一 dispose。
   */
  private readonly ghostMats = new Map<THREE.Material, THREE.Material>();

  constructor(scene: THREE.Scene, strategy: TerrainStyleStrategy, label: string) {
    this.scene = scene;
    this.bike = new BikeOrnament(scene, strategy);
    if (this.bike.root) applyGhostTranslucency(this.bike.root, this.ghostMats);
    this.nameplate = createNameplate(label, true);
    scene.add(this.nameplate);
    this.setVisible(false); // 首幀資料到才現身
  }

  /** 主題切換:重建車體並重新半透明化(名牌與主題無關,不重建)。 */
  setStrategy(strategy: TerrainStyleStrategy): void {
    // 舊 clone 用的是舊主題的材質色/貼圖,換主題後不會再重用 —— 先釋放清空,
    // 再以新車體重建,避免跨主題累積洩漏。
    this.disposeGhostMats();
    this.bike.setStrategy(strategy);
    if (this.bike.root) applyGhostTranslucency(this.bike.root, this.ghostMats);
  }

  /** 釋放並清空所有半透明 clone(GhostRider 是它們的擁有者)。 */
  private disposeGhostMats(): void {
    for (const clone of this.ghostMats.values()) clone.dispose();
    this.ghostMats.clear();
  }

  /**
   * 每幀更新。`position` 為地面座標(y = 地面),與玩家的 BikeOrnament 同約定。
   * 速度由連續兩幀的距離差推導 —— 幽靈罰站(trace 平坦段)時輪子自然停轉。
   */
  update(position: THREE.Vector3, bearingDeg: number, distM: number, dt: number): void {
    if (dt > 0 && this.lastDistM !== null) {
      const inst = Math.max(0, (distM - this.lastDistM) / dt);
      // 輕平滑,避免 20Hz 差分抖動。
      this.speedMps += (inst - this.speedMps) * Math.min(1, dt * 5);
    }
    this.lastDistM = distM;

    this.bike.update(position, bearingDeg, this.speedMps, dt);
    this.nameplate.position.set(position.x, position.y + NAMEPLATE_HEIGHT, position.z);
  }

  setVisible(visible: boolean): void {
    this.bike.setVisible(visible);
    this.nameplate.visible = visible;
  }

  dispose(): void {
    this.bike.dispose();       // clone 標了 shared,disposeGroup 會跳過它們
    this.disposeGhostMats();   // 由 GhostRider 釋放 clone
    this.scene.remove(this.nameplate);
    disposeNameplate(this.nameplate);
  }
}
