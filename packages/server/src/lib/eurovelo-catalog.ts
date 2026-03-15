/**
 * EuroVelo catalog — fetches route/stage metadata from eurovelo.com,
 * provides GPX download URLs for each stage.
 *
 * Data license: ODbL (Open Database License)
 * Attribution: "Contains information from EuroVelo GPX tracks, eurovelo.com, ODbL"
 *
 * GPX download: https://en.eurovelo.com/route/get-gpx/{gpxId}
 */

import type { RouteCatalog, CatalogRace, CatalogStage } from '@littlecycling/shared';

const BASE_URL = 'https://en.eurovelo.com';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const USER_AGENT = 'littleCycling/0.1 (personal cycling game)';

/** Known EuroVelo routes. */
const EUROVELO_ROUTES: { id: string; evNum: number; name: string }[] = [
  { id: 'ev1',  evNum: 1,  name: 'Atlantic Coast Route' },
  { id: 'ev2',  evNum: 2,  name: 'Capitals Route' },
  { id: 'ev3',  evNum: 3,  name: 'Pilgrims Route' },
  { id: 'ev4',  evNum: 4,  name: 'Central Europe Route' },
  { id: 'ev5',  evNum: 5,  name: 'Via Romea Francigena' },
  { id: 'ev6',  evNum: 6,  name: 'Atlantic – Black Sea' },
  { id: 'ev7',  evNum: 7,  name: 'Sun Route' },
  { id: 'ev8',  evNum: 8,  name: 'Mediterranean Route' },
  { id: 'ev9',  evNum: 9,  name: 'Baltic – Adriatic' },
  { id: 'ev10', evNum: 10, name: 'Baltic Sea Cycle Route' },
  { id: 'ev11', evNum: 11, name: 'East Europe Route' },
  { id: 'ev12', evNum: 12, name: 'North Sea Cycle Route' },
  { id: 'ev13', evNum: 13, name: 'Iron Curtain Trail' },
  { id: 'ev14', evNum: 14, name: 'Waters of Central Europe' },
  { id: 'ev15', evNum: 15, name: 'Rhine Cycle Route' },
  { id: 'ev17', evNum: 17, name: 'Rhone Cycle Route' },
  { id: 'ev19', evNum: 19, name: 'Meuse Cycle Route' },
];

interface CacheEntry {
  catalog: RouteCatalog;
  fetchedAt: number;
}

interface ParsedStage {
  name: string;
  slug: string;
}

export class EuroveloCatalog {
  private cache: CacheEntry | null = null;

  /** Get catalog (from cache if fresh, otherwise scrape). */
  async getCatalog(): Promise<RouteCatalog> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.catalog;
    }
    const catalog = await this.fetchAll();
    this.cache = { catalog, fetchedAt: Date.now() };
    return catalog;
  }

  /** Force refresh, bypassing cache. */
  async refresh(): Promise<RouteCatalog> {
    this.cache = null;
    return this.getCatalog();
  }

  /** Find a stage in the cached catalog. */
  async findStage(raceId: string, stageNum: number): Promise<{ race: CatalogRace; stage: CatalogStage } | null> {
    const catalog = await this.getCatalog();
    const race = catalog.races.find(r => r.id === raceId);
    if (!race) return null;
    const stage = race.stages.find(s => s.stage === stageNum);
    if (!stage) return null;
    return { race, stage };
  }

  /** Download GPX content for a given gpxId. */
  async downloadGpx(gpxId: number): Promise<string> {
    const url = `${BASE_URL}/route/get-gpx/${gpxId}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`Failed to download GPX (gpxId=${gpxId}): HTTP ${res.status}`);
    }
    return res.text();
  }

  // ── Internal ──

  private async fetchAll(): Promise<RouteCatalog> {
    const races: CatalogRace[] = [];

    // Fetch all routes in parallel (but limit concurrency to avoid hammering)
    const results = await Promise.allSettled(
      EUROVELO_ROUTES.map(cfg => this.fetchRoute(cfg)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.stages.length > 0) {
        races.push(result.value);
      } else if (result.status === 'rejected') {
        console.error(`[eurovelo] Failed to fetch route:`, result.reason);
      }
    }

    return { updatedAt: Date.now(), races };
  }

  private async fetchRoute(cfg: { id: string; evNum: number; name: string }): Promise<CatalogRace> {
    const pageUrl = `${BASE_URL}/ev${cfg.evNum}`;
    console.log(`[eurovelo] Fetching ${pageUrl}`);

    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${pageUrl}`);
    }

    const html = await res.text();
    const stageLinks = this.parseRoutePageStages(html, cfg.evNum);

    if (stageLinks.length === 0) {
      console.log(`[eurovelo] No stages found for EV${cfg.evNum}`);
      return { id: cfg.id, name: `EuroVelo ${cfg.evNum} — ${cfg.name}`, stages: [] };
    }

    // Fetch each stage page to get gpxId (in parallel)
    const stageResults = await Promise.allSettled(
      stageLinks.map((sl, idx) => this.fetchStagePage(cfg.evNum, sl, idx + 1)),
    );

    const stages: CatalogStage[] = [];
    for (const result of stageResults) {
      if (result.status === 'fulfilled' && result.value) {
        stages.push(result.value);
      }
    }

    return {
      id: cfg.id,
      name: `EuroVelo ${cfg.evNum} — ${cfg.name}`,
      stages,
    };
  }

  /** Parse the route page HTML to extract stage links from ev.routePageData or page structure. */
  private parseRoutePageStages(html: string, evNum: number): ParsedStage[] {
    const stages: ParsedStage[] = [];

    // Strategy 1: Find stage links by href pattern /evN/slug
    const linkPattern = new RegExp(`href="(?:${BASE_URL})?/ev${evNum}/([^"]+)"`, 'g');
    const seen = new Set<string>();

    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const slug = match[1];

      // Skip non-stage pages
      if (slug === 'stages' ||
          slug === 'countries' ||
          slug.startsWith('points-of-interest') ||
          slug.match(/^[a-z]{2,3}$/) || // country codes like "france", "germany" are too short to be stage names but some could match
          slug === 'route-planner' ||
          slug.includes('unmissable') ||
          slug.includes('news')) {
        continue;
      }

      if (!seen.has(slug)) {
        seen.add(slug);

        // Convert slug to readable name
        const name = slug
          .replace(/-+$/, '')        // trailing dashes
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        stages.push({ name, slug });
      }
    }

    // Strategy 2: Parse ev.routePageData for stage page URLs
    if (stages.length === 0) {
      const dataMatch = html.match(/ev\.routePageData\s*=\s*(\{[\s\S]*?\});/);
      if (dataMatch) {
        try {
          // Extract page URLs from the data object
          const pageUrlPattern = new RegExp(`/ev${evNum}/([^"]+)`, 'g');
          let urlMatch;
          while ((urlMatch = pageUrlPattern.exec(dataMatch[1])) !== null) {
            const slug = urlMatch[1];
            if (!seen.has(slug) && !slug.startsWith('points-of-interest')) {
              seen.add(slug);
              const name = slug.replace(/-+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              stages.push({ name, slug });
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    return stages;
  }

  /** Fetch a stage page and extract the GPX download ID. */
  private async fetchStagePage(evNum: number, stage: ParsedStage, stageNum: number): Promise<CatalogStage | null> {
    const url = `${BASE_URL}/ev${evNum}/${stage.slug}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) return null;

      const html = await res.text();

      // Look for /route/get-gpx/NNN in the page
      const gpxMatch = html.match(/\/route\/get-gpx\/(\d+)/);
      if (!gpxMatch) return null;

      const gpxId = parseInt(gpxMatch[1], 10);

      return {
        stage: stageNum,
        name: stage.name,
        distanceKm: 0,
        elevGainM: 0,
        gpxId,
      };
    } catch {
      return null;
    }
  }
}
