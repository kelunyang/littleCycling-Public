/**
 * Adapter layer that wraps MapLibre GL JS behind a common interface.
 * Only the methods actually used by this project are included so the
 * surface area stays minimal.
 */

/* ── Common types ─────────────────────────────────────────────── */

/** Subset of map methods used by this project. */
export interface GameMap {
  addSource(id: string, source: any): void;
  addLayer(layer: any, before?: string): void;
  getSource(id: string): any;
  setTerrain(options: any): void;
  setSky?(options: any): void;
  setFog?(options: any): void;
  jumpTo(options: {
    center: [number, number];
    bearing: number;
    pitch: number;
    zoom?: number;
  }): void;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: any,
  ): void;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
  getBearing(): number;
  triggerRepaint(): void;
  resize(): void;
  on(event: string, handler: (...args: any[]) => void): void;
  remove(): void;
}

/** CustomLayerInterface shared between both providers. */
export interface GameCustomLayerInterface {
  id: string;
  type: 'custom';
  renderingMode?: '3d';
  onAdd?(map: any, gl: WebGLRenderingContext): void;
  render?(gl: WebGLRenderingContext, matrix: ArrayLike<number>): void;
  onRemove?(map: any, gl: WebGLRenderingContext): void;
}

/** Result of MercatorCoordinate.fromLngLat(). */
export interface MercatorCoordinateResult {
  x: number;
  y: number;
  z: number;
  meterInMercatorCoordinateUnits(): number;
}

/** Callback that converts [lng,lat]+altitude to MercatorCoordinate. */
export type MercatorFromLngLat = (
  lngLat: [number, number],
  altitude: number,
) => MercatorCoordinateResult;

/* ── Adapter ──────────────────────────────────────────────────── */

export interface MapAdapter {
  map: GameMap;
  mercatorFromLngLat: MercatorFromLngLat;
  terrainExaggeration: number;
}

export interface MapAdapterOptions {
  container: HTMLElement;
  style: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  antialias: boolean;
}

/**
 * Create a MapLibre GL JS map instance.
 */
export async function createMapAdapter(
  options: MapAdapterOptions & { terrainExaggeration?: number },
): Promise<MapAdapter> {
  const exaggeration = options.terrainExaggeration ?? 1;

  const maplibregl = (await import('maplibre-gl')).default;
  const map = new maplibregl.Map({
    ...options,
    maxTileCacheSize: 200,
  });
  return {
    map: map as unknown as GameMap,
    terrainExaggeration: exaggeration,
    mercatorFromLngLat: (lngLat, alt) =>
      maplibregl.MercatorCoordinate.fromLngLat(
        lngLat,
        alt * exaggeration,
      ) as MercatorCoordinateResult,
  };
}
