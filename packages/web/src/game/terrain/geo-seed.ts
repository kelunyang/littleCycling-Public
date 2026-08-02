/**
 * One stable integer for one place on Earth.
 *
 * ## Why this is not just "the demos' expression"
 *
 * The hash itself IS the demos' expression, character for character
 * (`plan/*-town-demo.html`, the LANDUSE block):
 *
 * ```js
 * const seed = ((Math.round(info.cx * 4) * 73856093) ^ (Math.round(info.cz * 4) * 19349663)) >>> 0;
 * ```
 *
 * What changed is **what goes in**. A demo has ONE origin for the whole page, so
 * `info.cx` (metres east of that origin) is as good an identity as any. gameview
 * does not:
 *
 *  · the origin is the ROUTE's first point, so the same pitch sits at a
 *    different `cx` on every route that passes it;
 *  · `TerrainChunkManager.updateOrigin` re-bases the world mid-ride (it has no
 *    caller today, but `plan/DEMO_POC_GUIDE.md` §3.4 has「世界抬升」on the POC
 *    control bar precisely so this class of bug becomes visible), and every
 *    chunk built after the re-base measures from somewhere else.
 *
 * That is `plan/DEMO_POC_GUIDE.md` §2 case **A** — a question the demo's input
 * can never ask — and the answer is not to change the demo's hash but to feed it
 * a coordinate the demo would have produced if its origin were the equator and
 * the prime meridian.
 *
 * So: metres from (0°, 0°) on the same equirectangular scale the rest of this
 * package uses (`111320` m per degree, longitude shrunk by cos φ), quantised to
 * 0.25 m by the demos' own `Math.round(v * 4)`.
 *
 * ## Range, checked
 *
 * `|X| ≤ 180 × 111320 = 2.004e7` and `|Z| ≤ 90 × 111320 = 1.002e7`, so the
 * largest product is `8.01e7 × 73856093 ≈ 5.92e15`, comfortably inside 2^53 —
 * every multiplication below is EXACT before `^` truncates it to int32. A
 * coordinate frame that overflowed there would collapse whole regions onto one
 * seed and nothing would say so.
 *
 * ## What it is NOT
 *
 * Not an array index. `street-lamp.ts`'s `poolIndexFor` explains at length why
 * binding a lamp's identity to its position in an array is a bug riders reported
 * from the saddle; the same applies to「這個 chunk 的第幾棟」for a shop sign. A
 * chunk boundary, a different tile window or one more polygon upstream re-numbers
 * everything after it — and re-numbering is exactly what an identity must not do.
 */

/** Metres per degree of latitude — the constant every projection here uses. */
const M_PER_DEG = 111320;

/**
 * A stable 32-bit identity for the point (`lon`, `lat`).
 *
 * Deterministic and origin-independent: the same coordinates give the same
 * integer in every chunk, on every route, before and after a re-base.
 */
export function geoSeed(lon: number, lat: number): number {
  const cx = lon * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const cz = -lat * M_PER_DEG;
  return ((Math.round(cx * 4) * 73856093) ^ (Math.round(cz * 4) * 19349663)) >>> 0;
}
