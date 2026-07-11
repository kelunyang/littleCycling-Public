/**
 * EuroVelo catalog — fetches the full route GPX from eurovelo.com,
 * parses stage list out of <trk><name> entries, and caches on disk
 * with HTTP If-Modified-Since for incremental refresh.
 *
 * Data license: ODbL — Open Database License
 * Source: https://en.eurovelo.com (released as open data 2024-10-09)
 *
 * GPX endpoint: GET https://en.eurovelo.com/route/get-gpx/{gpxId}
 *   Returns a single GPX file containing one <trk> per stage,
 *   each <name> formatted as "NN: Place A – Place B (Status Label)",
 *   e.g. "(Certified)", "(Developed + Signed)", "(Undeveloped / Unknown)".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import {
  calcRouteDistance,
  calcElevationGain,
} from '@littlecycling/shared';
import type {
  CatalogRace,
  CatalogStage,
  EuroVeloStageStatus,
  RouteCatalog,
  RoutePoint,
} from '@littlecycling/shared';

if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as Record<string, unknown>).DOMParser = LinkedomDOMParser;
}

const BASE_URL = 'https://en.eurovelo.com';
const USER_AGENT = 'littleCycling/0.1 (+https://github.com/kelunyang/littleCycling)';
// EuroVelo's officially-worded ODbL attribution. Per their License & Disclaimer,
// a per-download date belongs in "(DATE)" — we fill it with the route's actual
// download date when embedding the notice in an exported stage GPX; the catalog
// UI shows this date-less form plus each route's fetched date separately.
const ATTRIBUTION =
  'Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com, ' +
  'which is made available under the Open Database License (ODbL).';
const LICENSE_NAME = 'ODbL v1.0';
const LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const LICENSE_DOC_URL =
  'https://pro.eurovelo.com/download/document/ECF_GPX%20tracks_License%20and%20Disclaimer_20241007.pdf';

interface RouteConfig {
  id: string;
  evNum: number;
  gpxId: number;
  name: string;
}

/** EuroVelo route → gpxId mapping (verified 2026-05 by probing each /evN page). */
const ROUTES: RouteConfig[] = [
  { id: 'ev1',  evNum: 1,  gpxId: 2,   name: 'Atlantic Coast Route' },
  { id: 'ev2',  evNum: 2,  gpxId: 25,  name: 'Capitals Route' },
  { id: 'ev3',  evNum: 3,  gpxId: 26,  name: 'Pilgrims Route' },
  { id: 'ev4',  evNum: 4,  gpxId: 27,  name: 'Central Europe Route' },
  { id: 'ev5',  evNum: 5,  gpxId: 28,  name: 'Via Romea Francigena' },
  { id: 'ev6',  evNum: 6,  gpxId: 29,  name: 'Atlantic – Black Sea' },
  { id: 'ev7',  evNum: 7,  gpxId: 30,  name: 'Sun Route' },
  { id: 'ev8',  evNum: 8,  gpxId: 31,  name: 'Mediterranean Route' },
  { id: 'ev9',  evNum: 9,  gpxId: 32,  name: 'Baltic – Adriatic' },
  { id: 'ev10', evNum: 10, gpxId: 33,  name: 'Baltic Sea Cycle Route' },
  { id: 'ev11', evNum: 11, gpxId: 34,  name: 'East Europe Route' },
  { id: 'ev12', evNum: 12, gpxId: 35,  name: 'North Sea Cycle Route' },
  { id: 'ev13', evNum: 13, gpxId: 1,   name: 'Iron Curtain Trail' },
  { id: 'ev14', evNum: 14, gpxId: 512, name: 'Waters of Central Europe' },
  { id: 'ev15', evNum: 15, gpxId: 36,  name: 'Rhine Cycle Route' },
  { id: 'ev17', evNum: 17, gpxId: 37,  name: 'Rhone Cycle Route' },
  { id: 'ev19', evNum: 19, gpxId: 135, name: 'Meuse Cycle Route' },
];

interface RouteCacheEntry {
  gpxId: number;
  lastModified?: string;
  fetchedAt: number;
  stages: CatalogStage[];
}

// Bumped to 2 when EuroVelo changed stage-status labels (2026-07):
// version-1 caches were parsed with the old regex and hold empty stage
// lists that a 304 revalidation would otherwise keep alive forever.
const MANIFEST_VERSION = 2;

interface Manifest {
  version: typeof MANIFEST_VERSION;
  routes: Record<string, RouteCacheEntry>;
}

export class EuroVeloCatalog {
  private cacheDir: string;
  private manifestPath: string;
  private manifest: Manifest;

  constructor(dataDir: string) {
    this.cacheDir = join(dataDir, 'eurovelo-cache');
    mkdirSync(this.cacheDir, { recursive: true });
    this.manifestPath = join(this.cacheDir, 'manifest.json');
    this.manifest = this.loadManifest();
  }

  /** List all 17 routes with their cached stage list (empty if not yet fetched). */
  getCatalog(): RouteCatalog {
    return {
      updatedAt: Date.now(),
      attribution: ATTRIBUTION,
      licenseName: LICENSE_NAME,
      licenseUrl: LICENSE_URL,
      licenseDocUrl: LICENSE_DOC_URL,
      races: ROUTES.map((cfg) => this.toRace(cfg, this.manifest.routes[cfg.id])),
    };
  }

  /** Fetch a route's GPX (or revalidate via If-Modified-Since) and update cache. */
  async fetchRoute(routeId: string): Promise<CatalogRace> {
    const cfg = ROUTES.find((r) => r.id === routeId);
    if (!cfg) throw new Error(`Unknown route: ${routeId}`);

    const cached = this.manifest.routes[routeId];
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (cached?.lastModified && this.gpxExists(routeId)) {
      headers['If-Modified-Since'] = cached.lastModified;
    }

    const url = `${BASE_URL}/route/get-gpx/${cfg.gpxId}`;
    const res = await fetch(url, { headers });

    if (res.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      this.manifest.routes[routeId] = cached;
      this.saveManifest();
      return this.toRace(cfg, cached);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    const gpxXml = await res.text();
    const lastModified = res.headers.get('last-modified') ?? undefined;
    const stages = parseGpxStages(gpxXml);

    writeFileSync(this.gpxPath(routeId), gpxXml, 'utf-8');

    const entry: RouteCacheEntry = {
      gpxId: cfg.gpxId,
      lastModified,
      fetchedAt: Date.now(),
      stages,
    };
    this.manifest.routes[routeId] = entry;
    this.saveManifest();

    return this.toRace(cfg, entry);
  }

  /** Slice out a single stage's GPX as a self-contained, valid GPX 1.1 string. */
  getStageGpx(routeId: string, stageNum: number): string | null {
    const xml = this.readGpx(routeId);
    if (!xml) return null;

    const trkRegex = /<trk\b[^>]*>[\s\S]*?<\/trk>/g;
    let match: RegExpExecArray | null;
    while ((match = trkRegex.exec(xml)) !== null) {
      const block = match[0];
      const nameMatch = block.match(/<name>\s*0*(\d+)\s*:/);
      if (nameMatch && parseInt(nameMatch[1], 10) === stageNum) {
        return [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<gpx creator="littleCycling" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">',
          this.stageMetadataXml(routeId),
          block,
          '</gpx>',
          '',
        ].join('\n');
      }
    }
    return null;
  }

  /**
   * ODbL attribution embedded in every exported stage GPX, so the required
   * notice travels with the file (attribution + license + source + the date the
   * data was downloaded). Order follows the GPX 1.1 metadata schema.
   */
  private stageMetadataXml(routeId: string): string {
    const cfg = ROUTES.find((r) => r.id === routeId);
    const fetchedAt = this.manifest.routes[routeId]?.fetchedAt;
    const date = fetchedAt ? dayjs(fetchedAt).format('YYYY-MM-DD') : 'unknown date';
    const desc =
      `Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com on ${date}, ` +
      `which is made available under the Open Database License (ODbL).`;
    const sourceUrl = cfg ? `${BASE_URL}/ev${cfg.evNum}` : BASE_URL;
    const linkText = cfg ? xmlEscape(`EuroVelo ${cfg.evNum} — ${cfg.name}`) : 'EuroVelo';
    return [
      '  <metadata>',
      `    <desc>${xmlEscape(desc)}</desc>`,
      '    <copyright author="EuroVelo">',
      `      <license>${LICENSE_URL}</license>`,
      '    </copyright>',
      `    <link href="${sourceUrl}"><text>${linkText}</text></link>`,
      '  </metadata>',
    ].join('\n');
  }

  private readGpx(routeId: string): string | null {
    const path = this.gpxPath(routeId);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  private gpxExists(routeId: string): boolean {
    return existsSync(this.gpxPath(routeId));
  }

  private gpxPath(routeId: string): string {
    return join(this.cacheDir, `${routeId}.gpx`);
  }

  private toRace(cfg: RouteConfig, entry: RouteCacheEntry | undefined): CatalogRace {
    return {
      id: cfg.id,
      evNum: cfg.evNum,
      name: `EuroVelo ${cfg.evNum} — ${cfg.name}`,
      stages: entry?.stages ?? [],
      fetchedAt: entry?.fetchedAt ?? null,
    };
  }

  private loadManifest(): Manifest {
    if (existsSync(this.manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf-8')) as Manifest;
        if (parsed.version === MANIFEST_VERSION) return parsed;
      } catch {
        // fall through to fresh manifest
      }
    }
    return { version: MANIFEST_VERSION, routes: {} };
  }

  private saveManifest(): void {
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2) + '\n', 'utf-8');
  }
}

/** Parse stage metadata out of a full route GPX. */
function parseGpxStages(xml: string): CatalogStage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const trks = doc.getElementsByTagName('trk');
  const stages: CatalogStage[] = [];

  for (let i = 0; i < trks.length; i++) {
    const trk = trks[i];
    const nameText = trk.getElementsByTagName('name')[0]?.textContent ?? '';
    const m = nameText.trim().match(/^0*(\d+)\s*:\s*(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) continue;

    const stageNum = parseInt(m[1], 10);
    const name = m[2].trim();
    const status = parseStatus(m[3]);

    const trkpts = trk.getElementsByTagName('trkpt');
    const points: RoutePoint[] = [];
    for (let j = 0; j < trkpts.length; j++) {
      const pt = trkpts[j];
      const lat = parseFloat(pt.getAttribute('lat') ?? '0');
      const lon = parseFloat(pt.getAttribute('lon') ?? '0');
      const eleEl = pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent ?? '0') : 0;
      points.push({ lat, lon, ele });
    }

    stages.push({
      stage: stageNum,
      name,
      status,
      distanceKm: Math.round(calcRouteDistance(points) / 100) / 10,
      elevGainM: Math.round(calcElevationGain(points)),
    });
  }

  return stages;
}

/**
 * Map the human-readable status label to our enum. Observed labels (2026-07):
 * "Certified", "Developed + Signed", "Developed + Not Signed",
 * "Partially Developed + Signed", "Partially Developed + Not Signed",
 * "Undeveloped / Unknown".
 */
function parseStatus(raw: string): EuroVeloStageStatus {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('certified')) return 'CERTIFIED';
  if (s.startsWith('partially developed')) {
    return s.includes('not signed')
      ? 'PARTIALLY_DEVELOPED_UNSIGNED'
      : 'PARTIALLY_DEVELOPED_SIGNED';
  }
  if (s.startsWith('developed')) {
    return s.includes('not signed') ? 'DEVELOPED_UNSIGNED' : 'DEVELOPED_SIGNED';
  }
  if (s.startsWith('undeveloped')) return 'UNDEVELOPED';
  return 'OTHER';
}

/** Minimal XML text escaping for values embedded in the exported GPX metadata. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
