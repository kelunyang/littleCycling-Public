/**
 * Fetch raster map tiles and composite them into a Three.js texture
 * for terrain chunk surface rendering.
 *
 * Uses OpenStreetMap raster tiles by default. Tiles are fetched via
 * <img> + <canvas> to avoid CORS issues.
 */

import * as THREE from 'three';

const TILE_SIZE = 256;
const DEFAULT_ZOOM = 17;
const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export interface TileTextureOptions {
  zoom?: number;
  tileUrl?: string;
}

/**
 * Fetch raster map tiles covering a geographic bounding box and return
 * a composited Three.js texture.
 *
 * @param bounds - Geographic bounding box
 * @param options - Tile source options
 * @returns CanvasTexture covering the bounds, or null on failure
 */
export async function fetchTerrainTexture(
  bounds: { south: number; north: number; west: number; east: number },
  options?: TileTextureOptions,
): Promise<THREE.CanvasTexture | null> {
  const zoom = options?.zoom ?? DEFAULT_ZOOM;
  const tileUrl = options?.tileUrl ?? DEFAULT_TILE_URL;

  // Convert bounds to tile coordinates
  const nw = latLonToTile(bounds.north, bounds.west, zoom);
  const se = latLonToTile(bounds.south, bounds.east, zoom);

  const minTX = Math.min(nw.x, se.x);
  const maxTX = Math.max(nw.x, se.x);
  const minTY = Math.min(nw.y, se.y);
  const maxTY = Math.max(nw.y, se.y);

  const tilesX = maxTX - minTX + 1;
  const tilesY = maxTY - minTY + 1;

  // Create composite canvas
  const canvas = document.createElement('canvas');
  canvas.width = tilesX * TILE_SIZE;
  canvas.height = tilesY * TILE_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Fetch all tiles in parallel
  const fetches: Promise<{ img: HTMLImageElement; col: number; row: number } | null>[] = [];
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const col = tx - minTX;
      const row = ty - minTY;
      fetches.push(
        fetchTileImage(tileUrl, zoom, tx, ty)
          .then((img) => ({ img, col, row }))
          .catch(() => null),
      );
    }
  }

  const results = await Promise.all(fetches);

  let successCount = 0;
  const totalCount = fetches.length;
  for (const result of results) {
    if (result) {
      ctx.drawImage(result.img, result.col * TILE_SIZE, result.row * TILE_SIZE);
      successCount++;
    }
  }

  if (successCount === 0) {
    console.warn(`[TerrainTexture] All ${totalCount} tiles failed to load for bounds`, bounds);
    return null;
  }
  if (successCount < totalCount) {
    console.warn(`[TerrainTexture] ${totalCount - successCount}/${totalCount} tiles failed`);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  // Store tile bounds info on texture for UV calculation
  // The texture covers the area from tile (minTX, minTY) to (maxTX+1, maxTY+1)
  const tileBoundsWest = tileToLon(minTX, zoom);
  const tileBoundsEast = tileToLon(maxTX + 1, zoom);
  const tileBoundsNorth = tileToLat(minTY, zoom);
  const tileBoundsSouth = tileToLat(maxTY + 1, zoom);

  texture.userData = {
    west: tileBoundsWest,
    east: tileBoundsEast,
    north: tileBoundsNorth,
    south: tileBoundsSouth,
  };

  return texture;
}

/**
 * Compute UV coordinates for a geographic position within a tile texture.
 * The texture's userData must contain {west, east, north, south} bounds.
 */
export function geoToUV(
  lat: number,
  lon: number,
  textureBounds: { west: number; east: number; north: number; south: number },
): [number, number] {
  const u = (lon - textureBounds.west) / (textureBounds.east - textureBounds.west);
  // V is inverted: texture top = north (v=0), bottom = south (v=1)
  // Three.js UV: v=0 is bottom, v=1 is top → flip
  const v = 1 - (lat - textureBounds.south) / (textureBounds.north - textureBounds.south);
  return [
    Math.max(0, Math.min(1, u)),
    Math.max(0, Math.min(1, v)),
  ];
}

// ── Tile math ──

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.max(0, Math.min(x, n - 1)),
    y: Math.max(0, Math.min(y, n - 1)),
  };
}

function tileToLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function fetchTileImage(
  urlTemplate: string,
  z: number,
  x: number,
  y: number,
): Promise<HTMLImageElement> {
  const url = urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`[TerrainTexture] Failed to load tile: ${url}`);
      reject(new Error(`Failed to load tile: ${url}`));
    };
    img.src = url;
  });
}
