/**
 * MVT survey — what map data does a route actually contain, and how much of it
 * do we draw?
 *
 * Walks a saved route, fetches the same OpenFreeMap tiles the game fetches, and
 * tallies EVERY layer/class in them — including the layers `mvt-fetcher.ts` does
 * not ask for, which are the real blind spots. Each row is then labelled with
 * what the game currently does with it:
 *
 *   rendered        we draw geometry for it
 *   detected_only   we read it (zone detection) but draw nothing  ← the tunnel bug
 *   fetched_ignored we download it and throw it away
 *   not_fetched     we never even ask for it
 *
 * No riding required: this covers 100% of the route, not just the parts a rider
 * happened to pass. Tiles come from OpenFreeMap (already the game's basemap
 * source — see DEVPLAN 外部資料源與版權); nothing new is introduced here.
 *
 * Usage:
 *   node scripts/mvt-survey/survey.mjs                     # every route in data/routes
 *   node scripts/mvt-survey/survey.mjs <route.json> ...    # specific routes
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTES_DIR = resolve(ROOT, 'data', 'routes');
const OUT_DIR = resolve(ROOT, 'data', 'mvt-survey');

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Must match mvt-fetcher.ts. */
const MVT_ZOOM = 14;
const WANTED_LAYERS = [
  'transportation', 'building', 'water', 'waterway', 'landcover', 'landuse', 'park', 'aeroway',
];

/** Corridor half-width the game streams (config.ts viewRange default). */
const CORRIDOR_HALF_WIDTH_M = 500;

/** Tiles fetched at once — be a good citizen on a free tile server. */
const CONCURRENCY = 6;

// ── What the game does with each feature (mirrors the renderers) ──

/**
 * Returns [status, note]. Kept as one table so it is obvious what is being
 * claimed, and so a renderer change that leaves this stale is easy to spot.
 */
function classify(layer, props) {
  const cls = props.class ?? '';
  const brunnel = props.brunnel ?? '';

  if (!WANTED_LAYERS.includes(layer)) {
    return ['not_fetched', 'layer is not in mvt-fetcher WANTED_LAYERS'];
  }

  switch (layer) {
    case 'building':
      return ['rendered', 'building-renderer: extruded walls + roof/window trim'];

    case 'transportation':
      if (brunnel === 'tunnel') {
        return [
          'detected_only',
          'road-renderer draws it as a NORMAL road (no tunnel geometry); ' +
            'zone-detector flags it as a tunnel zone',
        ];
      }
      if (brunnel === 'bridge') {
        return ['rendered', 'road-renderer draws it as a normal road — no bridge deck/pillars'];
      }
      return ['rendered', 'road-renderer: ribbon along the way'];

    case 'water':
      if (cls === 'swimming_pool') {
        return [
          'fetched_ignored',
          'DELIBERATELY skipped: a back-garden pool is not landscape water, and no ' +
            'demo draws one — see water-classes.ts (2901 of them in one LA window)',
        ];
      }
      return ['rendered', 'landuse-renderer: water surface'];

    case 'waterway':
      if (brunnel === 'tunnel' || brunnel === 'culvert') {
        return [
          'fetched_ignored',
          'DELIBERATELY skipped: culverted reaches run under the road — a ribbon ' +
            'here would lie across the tarmac',
        ];
      }
      return ['rendered', 'waterway-renderer: ribbon, width by class (river 6 m … ditch 1.5 m)'];

    case 'landcover':
      if (cls === 'wood' || cls === 'forest') return ['rendered', 'trees + forest overlay'];
      if (cls === 'grass' || cls === 'park') return ['rendered', 'park overlay'];
      if (cls === 'sand') return ['rendered', 'sand overlay'];
      if (cls === 'wetland') return ['rendered', 'wetland overlay (marsh paper / jelly brick)'];
      if (cls === 'farmland' || cls === 'plant_nursery') {
        return ['rendered', 'farmland overlay (furrowed kraft / picnic check)'];
      }
      return ['fetched_ignored', 'landcover class not handled by landuse-renderer'];

    case 'landuse':
      if (
        ['residential', 'commercial', 'industrial', 'retail',
         'school', 'hospital', 'university', 'college', 'kindergarten', 'library', 'education',
        ].includes(cls)
      ) {
        return ['rendered', 'urban overlay (tints the ground; institutions fold in here)'];
      }
      if (['pitch', 'playground', 'track', 'stadium'].includes(cls)) {
        return ['rendered', 'sports-field overlay (court lines)'];
      }
      return ['fetched_ignored', 'landuse class not handled by landuse-renderer'];

    case 'park':
      return ['rendered', 'park overlay'];

    case 'aeroway':
      if (cls === 'runway' || cls === 'taxiway') {
        return ['rendered', 'aeroway-renderer: paved ribbon (runway 30 m / taxiway 15 m)'];
      }
      if (cls === 'aerodrome') {
        return ['rendered', 'apron slab + one toy aircraft (balloon plane / brick plane)'];
      }
      if (cls === 'apron' || cls === 'helipad') {
        return ['rendered', 'aeroway-renderer: paved slab (every POLYGON becomes one)'];
      }
      return [
        'fetched_ignored',
        'gate is a POINT — a parking-stand label with no extent, and no demo draws ' +
          'one; aeroway-renderer drops it before it can inflate featureCount',
      ];

    default:
      return ['fetched_ignored', ''];
  }
}

// ── Tile maths (same as mvt-fetcher.ts) ──

function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: Math.max(0, Math.min(x, n - 1)), y: Math.max(0, Math.min(y, n - 1)) };
}

/** Every tile the streamed corridor around the route touches. */
function tilesForRoute(points) {
  const tiles = new Map();
  const dLat = CORRIDOR_HALF_WIDTH_M / 111320;

  for (const p of points) {
    const dLon = CORRIDOR_HALF_WIDTH_M / (111320 * Math.cos((p.lat * Math.PI) / 180));
    // Corners of the corridor box around this point.
    for (const [lat, lon] of [
      [p.lat - dLat, p.lon - dLon],
      [p.lat - dLat, p.lon + dLon],
      [p.lat + dLat, p.lon - dLon],
      [p.lat + dLat, p.lon + dLon],
    ]) {
      const t = latLonToTile(lat, lon, MVT_ZOOM);
      tiles.set(`${t.x}/${t.y}`, t);
    }
  }
  return [...tiles.values()];
}

// ── Fetch ──

async function resolveTileUrl() {
  const resp = await fetch(TILEJSON_URL);
  if (!resp.ok) throw new Error(`TileJSON ${resp.status}`);
  const json = await resp.json();
  if (!json.tiles?.length) throw new Error('TileJSON has no tiles array');
  return json.tiles[0];
}

async function fetchTile(template, x, y) {
  const url = template
    .replace('{z}', String(MVT_ZOOM))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) return null; // ocean / no data
    throw new Error(`tile ${x}/${y}: ${resp.status}`);
  }
  return new VectorTile(new Pbf(await resp.arrayBuffer()));
}

/** Run tasks with a fixed concurrency, reporting progress. */
async function pool(items, worker) {
  const results = [];
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
      done++;
      if (done % 10 === 0 || done === items.length) {
        process.stdout.write(`\r  tiles ${done}/${items.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  process.stdout.write('\n');
  return results;
}

// ── Survey one route ──

async function surveyRoute(routePath, template) {
  const route = JSON.parse(readFileSync(routePath, 'utf-8'));
  const points = route.points ?? [];
  if (points.length === 0) {
    console.log(`  (no points, skipping)`);
    return null;
  }

  const tiles = tilesForRoute(points);
  console.log(`  ${points.length} route points → ${tiles.length} tiles @ z${MVT_ZOOM}`);

  // key: layer|class|subclass|brunnel
  const tally = new Map();
  let missing = 0;

  await pool(tiles, async (t) => {
    let tile;
    try {
      tile = await fetchTile(template, t.x, t.y);
    } catch (err) {
      console.warn(`\n  ! ${err.message}`);
      return;
    }
    if (!tile) {
      missing++;
      return;
    }

    // EVERY layer in the tile — including the ones the game never asks for.
    for (const layerName of Object.keys(tile.layers)) {
      const layer = tile.layers[layerName];
      for (let i = 0; i < layer.length; i++) {
        const props = layer.feature(i).properties || {};
        const key = [
          layerName,
          props.class ?? '',
          props.subclass ?? '',
          props.brunnel ?? '',
        ].join('|');
        const row = tally.get(key);
        if (row) row.count++;
        else tally.set(key, { layer: layerName, props, count: 1 });
      }
    }
  });

  if (missing) console.log(`  (${missing} tiles had no data — ocean/void)`);

  const total = [...tally.values()].reduce((s, r) => s + r.count, 0);
  const rows = [...tally.entries()]
    .map(([key, r]) => {
      const [layer, cls, subclass, brunnel] = key.split('|');
      const [status, note] = classify(layer, r.props);
      return { layer, cls, subclass, brunnel, count: r.count, status, note };
    })
    .sort((a, b) => b.count - a.count);

  return { route, rows, total };
}

// ── CSV ──

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, rows, total) {
  const header = ['layer', 'class', 'subclass', 'brunnel', 'count', 'share_pct', 'status', 'note'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.layer,
        r.cls,
        r.subclass,
        r.brunnel,
        r.count,
        ((r.count / total) * 100).toFixed(2),
        r.status,
        r.note,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

// ── Main ──

const args = process.argv.slice(2);
const routePaths =
  args.length > 0
    ? args.map((a) => resolve(a))
    : readdirSync(ROUTES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => resolve(ROUTES_DIR, f));

mkdirSync(OUT_DIR, { recursive: true });

console.log('Resolving OpenFreeMap tile URL…');
const template = await resolveTileUrl();

const summary = new Map(); // status → count, across all routes

for (const routePath of routePaths) {
  console.log(`\n${basename(routePath)}`);
  const result = await surveyRoute(routePath, template);
  if (!result) continue;

  const { route, rows, total } = result;
  const outPath = resolve(OUT_DIR, `${route.id ?? basename(routePath, '.json')}.csv`);
  writeCsv(outPath, rows, total);

  // Per-route status breakdown.
  const byStatus = new Map();
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.count);
    summary.set(r.status, (summary.get(r.status) ?? 0) + r.count);
  }

  console.log(`  ${total} features, ${rows.length} distinct kinds → ${outPath}`);
  for (const [status, count] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(16)} ${String(count).padStart(7)}  ${((count / total) * 100).toFixed(1)}%`);
  }

  // The headline: what we pull down and drop, and what we never look at.
  const gaps = rows
    .filter((r) => r.status !== 'rendered')
    .slice(0, 12);
  if (gaps.length) {
    console.log('  biggest gaps:');
    for (const r of gaps) {
      const name = [r.layer, r.cls, r.subclass, r.brunnel].filter(Boolean).join('/');
      console.log(`    ${String(r.count).padStart(6)}  ${name.padEnd(38)} ${r.status}`);
    }
  }
}

console.log('\n── all routes ──');
const grand = [...summary.values()].reduce((a, b) => a + b, 0);
for (const [status, count] of [...summary].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(16)} ${String(count).padStart(8)}  ${((count / grand) * 100).toFixed(1)}%`);
}
