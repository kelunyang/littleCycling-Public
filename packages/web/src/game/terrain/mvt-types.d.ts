/**
 * Type declarations for @mapbox/vector-tile.
 * The package doesn't ship its own types.
 */

declare module '@mapbox/vector-tile' {
  import type Pbf from 'pbf';

  export class VectorTile {
    constructor(pbf: Pbf);
    layers: { [layerName: string]: VectorTileLayer };
  }

  export class VectorTileLayer {
    version: number;
    name: string;
    extent: number;
    length: number;
    feature(i: number): VectorTileFeature;
  }

  export class VectorTileFeature {
    static types: string[];
    type: number; // 1=Point, 2=LineString, 3=Polygon
    extent: number;
    id: number | undefined;
    properties: Record<string, any>;
    loadGeometry(): Array<Array<{ x: number; y: number }>>;
    toGeoJSON(x: number, y: number, z: number): GeoJSON.Feature;
  }
}
