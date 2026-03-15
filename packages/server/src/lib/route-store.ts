/**
 * Route CRUD — manages saved routes as JSON files in data/routes/.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import dayjs from 'dayjs';
import type { SavedRoute, RoutePoint } from '@littlecycling/shared';
import { calcRouteDistance, calcElevationGain, parseRouteFile } from '@littlecycling/shared';
import { parseFitRoute } from './fit-parser.js';

// Polyfill DOMParser for Node.js (shared gpx-parser uses it)
import { DOMParser as LinkedomDOMParser } from 'linkedom';
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as Record<string, unknown>).DOMParser = LinkedomDOMParser;
}

/** File extensions that can be auto-imported. */
const IMPORTABLE_EXTS = new Set(['.gpx', '.tcx', '.fit']);

/** Summary (without heavyweight points array) for list views. */
export type RouteSummary = Omit<SavedRoute, 'points'>;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export class RouteStore {
  constructor(private routesDir: string) {
    mkdirSync(routesDir, { recursive: true });
  }

  /** List all routes (without points) sorted by createdAt desc. */
  list(): RouteSummary[] {
    const files = readdirSync(this.routesDir).filter(f => f.endsWith('.json'));
    const summaries: RouteSummary[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.routesDir, file), 'utf-8');
        const route = JSON.parse(raw) as SavedRoute;
        const { points: _, ...summary } = route;
        summaries.push(summary);
      } catch {
        // Skip malformed files
      }
    }

    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get a single route by id (with full points). */
  get(id: string): SavedRoute | null {
    const filePath = join(this.routesDir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as SavedRoute;
    } catch {
      return null;
    }
  }

  /** Create a new route from parsed GPX/TCX points. */
  create(name: string, fileName: string, points: RoutePoint[]): SavedRoute {
    const id = `${slugify(name)}-${dayjs().format('YYYYMMDDHHmmss')}`;
    const route: SavedRoute = {
      id,
      name,
      fileName,
      points,
      distanceM: calcRouteDistance(points),
      elevGainM: calcElevationGain(points),
      createdAt: Date.now(),
    };
    writeFileSync(join(this.routesDir, `${id}.json`), JSON.stringify(route, null, 2) + '\n', 'utf-8');
    return route;
  }

  /** Update route metadata (currently: rename only). */
  update(id: string, patch: { name?: string }): SavedRoute | null {
    const route = this.get(id);
    if (!route) return null;
    if (patch.name !== undefined) route.name = patch.name;
    writeFileSync(join(this.routesDir, `${id}.json`), JSON.stringify(route, null, 2) + '\n', 'utf-8');
    return route;
  }

  /** Delete a route. Returns true if deleted, false if not found. */
  delete(id: string): boolean {
    const filePath = join(this.routesDir, `${id}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  /**
   * Auto-import: scan routesDir for raw GPX/TCX/FIT files, parse & import them,
   * then move the originals into an `imported/` subfolder so they aren't re-processed.
   * Returns the number of successfully imported files.
   */
  async autoImport(): Promise<number> {
    const files = readdirSync(this.routesDir).filter(f => {
      const ext = extname(f).toLowerCase();
      return IMPORTABLE_EXTS.has(ext);
    });

    if (files.length === 0) return 0;

    const importedDir = join(this.routesDir, 'imported');
    mkdirSync(importedDir, { recursive: true });

    let count = 0;

    for (const file of files) {
      const filePath = join(this.routesDir, file);
      const ext = extname(file).toLowerCase();
      const name = file.replace(/\.(gpx|tcx|fit)$/i, '');

      try {
        let points: RoutePoint[];

        if (ext === '.fit') {
          const buffer = Buffer.from(readFileSync(filePath));
          points = await parseFitRoute(buffer);
        } else {
          const xml = readFileSync(filePath, 'utf-8');
          points = parseRouteFile(xml, file);
        }

        if (points.length === 0) {
          console.warn(`[auto-import] Skipping ${file}: no route points found`);
          continue;
        }

        this.create(name, file, points);
        renameSync(filePath, join(importedDir, file));
        console.log(`[auto-import] Imported ${file} (${points.length} points)`);
        count++;
      } catch (err) {
        console.warn(`[auto-import] Failed to import ${file}:`, err instanceof Error ? err.message : err);
      }
    }

    return count;
  }
}
