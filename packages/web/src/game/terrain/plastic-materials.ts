/**
 * The PLASTIC world's own shelf: its palette and its material factories.
 *
 * Every line below was moved here verbatim from `cartoon-materials.ts`
 * (`plan/world-modularity-refactor.md` step 1). Nothing was rewritten — the
 * numbers, the comments and the order are the ones that shipped, because the
 * acceptance test for that move is that no pixel changes.
 *
 * Why it moved: `cartoon-materials.ts` was 297 lines of which 20 exports were
 * palette or material factory, and `plastic-terrain-style.ts` was the ONLY
 * importer. That is not a shared shelf — it is one world, split in half, with
 * the half that carries its look wearing a mechanism's name. The cost is
 * measurable: the plastic tree used to take `TREE_CANOPY_COLORS` off that shelf
 * (generic cartoon greens) instead of the demo's `COIL_GREENS`, and per-item
 * demo diffing never saw it, because a diff of geometry and material parameters
 * does not read imports — the colour it got was *a* colour, just the wrong one.
 *
 * `roadWidthForClass` / `ROAD_WIDTHS` came along for the same reason: the
 * plastic road width table belongs at the same level as circuit's `BUS_W`, not
 * behind a file named after a rendering technique.
 *
 * The boundary is enforced, not just documented — see
 * `scripts/headless-check/world-boundary.ts`.
 *
 * Still imported from the mechanism side: `GRADIENT_MAP` (the ramp texture the
 * toon materials sample) and `simpleNoise2D` (a hash-based value noise).
 */

import * as THREE from 'three';
import { injectCloudShadow } from './cloud-shadow';
import { GRADIENT_MAP, simpleNoise2D } from './cartoon-materials';

// ── Color palettes ──

/** Neon building colors — coordinate-hash selects one deterministically. */
export const BUILDING_COLORS = [
  0xff3366, // neon pink
  0x00e5ff, // electric blue
  0x76ff03, // acid green
  0xffea00, // neon yellow
  0xd500f9, // neon purple
  0xff6d00, // neon orange
] as const;

/** Road colors by class. */
export const ROAD_COLORS: Record<string, number> = {
  motorway: 0x2d2d2d,
  trunk: 0x2d2d2d,
  primary: 0x3a3a3a,
  secondary: 0x4a4a4a,
  tertiary: 0x5a5a5a,
  minor: 0x6b6b6b,
  service: 0x6b6b6b,
  path: 0x6b6b6b,
  track: 0x6b6b6b,
};

/** Road widths (meters) by class. */
export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 12,
  trunk: 10,
  primary: 8,
  secondary: 6,
  tertiary: 5,
  minor: 4,
  service: 3,
  path: 2,
  track: 2,
};

/** Terrain elevation color stops: [maxElevation, baseColor]. */
export const TERRAIN_COLOR_STOPS: [number, number][] = [
  [500, 0x39e75f],   // grass — neon green
  [1500, 0xe87d2f],  // dirt — neon orange
  [Infinity, 0x8c8c8c], // rock — gray
];

/** Secondary colors for Perlin noise mixing per terrain band. */
export const TERRAIN_NOISE_COLORS: [number, number[]][] = [
  [500, [0x1a8f3c, 0xc8e620]],          // jungle green, acid yellow
  [1500, [0x8b4513]],                    // dark brown
  [Infinity, [0x6a5acd]],               // graffiti gray-purple
];

export const WATER_COLOR = 0x1e90ff;   // toy blue (dodger blue)
export const PARK_COLOR = 0x00e676;    // neon mint
export const FOREST_COLOR = 0x1b5e20;  // deep forest green
export const SAND_COLOR = 0xd2b48c;    // sandy tan

/** Urban zone colors by landuse class. */
export const URBAN_COLORS: Record<string, number> = {
  residential: 0xb0bec5,   // light gray
  commercial: 0xffe082,    // warm yellow
  retail: 0xffe082,        // warm yellow (same as commercial)
  industrial: 0x90a4ae,    // steel gray
};

/**
 * Tree colors.
 *
 * ⚠ NOT what the plastic tree uses, and that is the whole point of this file's
 * existence: the tree wears the demo's `COIL_GREENS` / `COIL_TRUNK_COLOR`
 * (`plastic-terrain-style.ts`). These two are the generic cartoon greens the
 * default cone-and-cylinder tree in `tree-renderer.ts` falls back to for a style
 * that declares nothing of its own.
 */
export const TREE_TRUNK_COLOR = 0x5d4037;   // cartoon brown
export const TREE_CANOPY_COLORS = [
  0x2e7d32,  // forest green
  0x388e3c,  // medium green
  0x1b5e20,  // deep green
] as const;

// ── Material factories ──

/** Create a toon material for terrain with vertex colors. Cloud shadows (F3)
 *  are injected so clear-day terrain gets drifting soft dark patches. */
export function createTerrainToonMaterial(): THREE.MeshToonMaterial {
  return injectCloudShadow(new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
  }));
}

/** Create a toon material for buildings. Color is set per-building. */
export function createBuildingToonMaterial(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
  });
}

/** Create a toon material for roads. */
export function createRoadToonMaterial(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** Create a toon material for water bodies. */
export function createWaterToonMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: WATER_COLOR,
    gradientMap: GRADIENT_MAP,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
}

/** Create a toon material for parks/greenery. */
export function createParkToonMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: PARK_COLOR,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** Create a toon material for forest/wood areas. */
export function createForestToonMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: FOREST_COLOR,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** Create a toon material for sandy areas. */
export function createSandToonMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: SAND_COLOR,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** Create a toon material for urban landuse zones. */
export function createUrbanToonMaterial(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** Create a toon material for trees (vertex colors for trunk + canopy). */
export function createTreeMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
  });
}

/** Get urban zone color for a landuse class. Falls back to residential gray. */
export function urbanColorForClass(cls: string): number {
  return URBAN_COLORS[cls] ?? URBAN_COLORS.residential;
}

// ── Utilities ──

/**
 * Deterministic color selection for a building based on its coordinate.
 * Same building always gets the same color.
 */
export function buildingColorFromCoord(lon: number, lat: number): number {
  // Simple hash from coordinates
  const hash = Math.abs(Math.round(lon * 100000) * 31 + Math.round(lat * 100000) * 17);
  return BUILDING_COLORS[hash % BUILDING_COLORS.length];
}

/**
 * Get terrain base color for a given elevation.
 */
export function terrainColorForElevation(elevation: number): THREE.Color {
  for (const [maxElev, color] of TERRAIN_COLOR_STOPS) {
    if (elevation < maxElev) {
      return new THREE.Color(color);
    }
  }
  return new THREE.Color(TERRAIN_COLOR_STOPS[TERRAIN_COLOR_STOPS.length - 1][1]);
}

/**
 * Get a terrain vertex color with noise variation.
 * @param elevation - Elevation in meters
 * @param worldX - World X coordinate (for noise)
 * @param worldZ - World Z coordinate (for noise)
 * @param noiseScale - Scale of noise patches (default 0.002 → ~500m patches)
 */
export function terrainVertexColor(
  elevation: number,
  worldX: number,
  worldZ: number,
  noiseScale = 0.002,
): THREE.Color {
  const base = terrainColorForElevation(elevation);

  // Find which noise colors to mix in
  let noiseColors: number[] = [];
  for (const [maxElev, colors] of TERRAIN_NOISE_COLORS) {
    if (elevation < maxElev) {
      noiseColors = colors;
      break;
    }
  }

  if (noiseColors.length === 0) return base;

  // Sample noise at different scales for variety
  const n1 = simpleNoise2D(worldX * noiseScale, worldZ * noiseScale);
  const n2 = simpleNoise2D(worldX * noiseScale * 2.3 + 100, worldZ * noiseScale * 2.3 + 100);
  const combined = (n1 + n2 * 0.5) / 1.5;

  // Mix in a noise color based on the noise value
  const noiseColorIdx = Math.floor(combined * noiseColors.length) % noiseColors.length;
  const mixAmount = 0.15 + combined * 0.25; // 15-40% mix

  const noiseColor = new THREE.Color(noiseColors[noiseColorIdx]);
  base.lerp(noiseColor, mixAmount);

  return base;
}

/** Get road width for a given road class. */
export function roadWidthForClass(roadClass: string): number {
  return ROAD_WIDTHS[roadClass] ?? 4;
}

/** Get road color for a given road class. */
export function roadColorForClass(roadClass: string): number {
  return ROAD_COLORS[roadClass] ?? 0x5a5a5a;
}
