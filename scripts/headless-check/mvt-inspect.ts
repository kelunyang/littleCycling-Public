/**
 * Dump the raw OpenFreeMap MVT for a lat/lon box through the PRODUCTION decoder
 * and flag anything geometrically absurd — the "is the source data itself mad?"
 * question, answered without a browser.
 *
 *   BBOX=25.0798,121.5531,25.0859,121.5587 node --no-warnings \
 *     --import ./scripts/headless-check/register.mjs scripts/headless-check/mvt-inspect.ts
 */

const { decodeMVTTile } = await import('@/game/terrain/mvt-fetcher');

const [south, west, north, east] = (process.env.BBOX ?? '25.0798,121.5531,25.0859,121.5587')
  .split(',').map(Number);
const LAYERS = (process.env.LAYERS ?? 'transportation,aeroway,waterway').split(',');
const Z = 14, n2 = 2 ** Z;

const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n2);
const ty = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2);
};

const tilejson = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tpl = tilejson.tiles[0] as string;

const cosLat = Math.cos(((south + north) / 2) * Math.PI / 180);
const metres = (a: [number, number], b: [number, number]): number =>
  Math.hypot((b[0] - a[0]) * 111320 * cosLat, (b[1] - a[1]) * 111320);

interface Row {
  layer: string; cls: string; brunnel: string; olayer: unknown;
  pts: number; longest: number; span: number; total: number;
  name: string; sample: string;
}
const rows: Row[] = [];
let seen = 0;

for (let x = tx(west); x <= tx(east); x++) {
  for (let y = ty(north); y <= ty(south); y++) {
    const buf = await (await fetch(
      tpl.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)),
    )).arrayBuffer();
    const feats = decodeMVTTile(buf, x, y, Z);
    console.log(`tile ${Z}/${x}/${y}: ${feats.length} features`);

    for (const f of feats) {
      if (!LAYERS.includes(f.layer)) continue;
      const g = f.geometry;
      let lines: [number, number][][];
      if (g.type === 'LineString') lines = [g.coordinates as [number, number][]];
      else if (g.type === 'MultiLineString') lines = g.coordinates as [number, number][][];
      else if (g.type === 'Polygon') lines = [(g.coordinates as any)[0]];
      else if (g.type === 'MultiPolygon') lines = (g.coordinates as any).map((p: any) => p[0]);
      else continue;

      for (const coords of lines) {
        if (!coords || coords.length < 2) continue;
        // Only features that actually touch the query box.
        let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
        for (const [lo, la] of coords) {
          mnLa = Math.min(mnLa, la); mxLa = Math.max(mxLa, la);
          mnLo = Math.min(mnLo, lo); mxLo = Math.max(mxLo, lo);
        }
        if (mxLa < south || mnLa > north || mxLo < west || mnLo > east) continue;
        seen++;

        let longest = 0, total = 0;
        let worst = '';
        for (let i = 0; i < coords.length - 1; i++) {
          const d = metres(coords[i], coords[i + 1]);
          total += d;
          if (d > longest) {
            longest = d;
            worst = `${coords[i][1].toFixed(5)},${coords[i][0].toFixed(5)} → ${coords[i + 1][1].toFixed(5)},${coords[i + 1][0].toFixed(5)}`;
          }
        }
        const span = Math.max(metres([mnLo, mnLa], [mxLo, mnLa]), metres([mnLo, mnLa], [mnLo, mxLa]));
        rows.push({
          layer: f.layer,
          cls: String(f.properties.class ?? '—'),
          brunnel: String(f.properties.brunnel ?? '—'),
          olayer: f.properties.layer ?? 0,
          pts: coords.length, longest, span, total,
          name: String(f.properties.name ?? ''),
          sample: worst,
        });
      }
    }
  }
}

console.log(`\n${seen} line/ring pieces touch the box\n`);

rows.sort((a, b) => b.longest - a.longest);
console.log('── longest single segment (a straight chord the ribbon must follow) ──');
for (const r of rows.slice(0, 15)) {
  console.log(
    `  ${r.layer}/${r.cls}${r.brunnel !== '—' ? `[${r.brunnel}]` : ''} osmLayer=${r.olayer} ` +
    `pts=${r.pts} longest=${r.longest.toFixed(0)}m total=${r.total.toFixed(0)}m span=${r.span.toFixed(0)}m ` +
    `${r.name}\n      ${r.sample}`,
  );
}

const byClass = new Map<string, number>();
for (const r of rows) {
  const k = `${r.layer}/${r.cls}${r.brunnel !== '—' ? `[${r.brunnel}]` : ''}`;
  byClass.set(k, (byClass.get(k) ?? 0) + 1);
}
console.log('\n── counts by class ──');
for (const [k, v] of [...byClass].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

const osmLayers = new Map<string, number>();
for (const r of rows) {
  const k = String(r.olayer);
  osmLayers.set(k, (osmLayers.get(k) ?? 0) + 1);
}
console.log('\n── OSM `layer` tag distribution (elevated/buried z-order) ──');
for (const [k, v] of [...osmLayers].sort()) console.log(`  layer=${k}: ${v}`);
