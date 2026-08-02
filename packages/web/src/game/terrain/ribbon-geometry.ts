/**
 * Ground-hugging ribbons — the shared spine of roads, waterways and runways.
 *
 * ## Why this exists
 *
 * These three all used to build their own ribbon, and all three sank into the
 * terrain. The terrain is a staircase: each cell's tread is
 * `round(AVERAGE of its 4 corner DEM samples / layerHeight) * layerHeight`
 * (`quantized-terrain.ts`). The ribbons instead took a POINT DEM sample at each
 * raw MVT vertex and quantised that on its own. Two different functions:
 *
 *  - near a layer boundary, `round(point)` lands a whole step (6 m plastic /
 *    12 m paper) below `round(cell average)` → the road is buried in the tread
 *    it is supposed to sit on;
 *  - MVT vertices can be tens of metres apart, so the straight chord between
 *    them cuts clean through any step that rises in between.
 *
 * Meanwhile the route line raycasts the REAL terrain mesh, so it correctly sat
 * on top of the staircase — which is why the world looked like "the road is
 * underground and the guide line is flying".
 *
 * ## The fix
 *
 * Resample the centreline every few metres and put every vertex on the actual
 * terrain surface, exactly the way the street lamps, coins and checkpoint flags
 * already do (`chunkManager.raycastGroundHeight`). The quantised formula stays
 * only as a fallback for when the ray misses (a chunk that has not streamed in
 * yet), so nothing ever ends up with no height at all.
 */

import * as THREE from 'three';

/** Ground height at a scene-space (x, z), or null if no terrain is there yet.
 *  `preferY` disambiguates stacked corridor layers (a climb passing back over
 *  the valley covers one (x, z) twice): implementations should return the
 *  layer closest to it. Ribbons pass their PREVIOUS sample's height, so a road
 *  stays on the deck it started on instead of zigzagging between layers. */
export type GroundFn = (x: number, z: number, preferY?: number) => number | null;

/**
 * Metres between resampled vertices. The route line uses 6 m; roads carry far
 * more geometry, so 8 m keeps the cost down while still tracking the treads
 * (a cell is 24–32 m across, so this is ~3–4 samples per step).
 */
export const RIBBON_STEP_M = 8;

/**
 * Largest vertical step allowed between two ADJACENT resampled vertices before
 * the ribbon splits instead of bridging them.
 *
 * A corridor that folds back over itself covers one (x, z) at two very
 * different heights, and any lookup that picks the wrong one hands this builder
 * a height 60-150 m off its neighbours. The quad that then bridges them is the
 * "black arch flying out of the mountain": a near-vertical, near-degenerate
 * sliver stretching from the valley road up onto the ridge deck.
 *
 * `preferY` (threaded from the previous vertex, below) is the primary defence —
 * this is the backstop for the first vertex of a ribbon and for anything the
 * upstream probe cannot disambiguate. The budget has to clear a legitimate
 * staircase riser (12 m paper layer) plus a steep grade over one step, so 15 m
 * is generous for real roads and still an order of magnitude under the arches.
 */
const MAX_RIBBON_JUMP_M = 15;

/**
 * "No sample kept yet" — and it MUST NOT be -1.
 *
 * The stitch test is `prevKeptSample === i - 1`. With -1 as the sentinel that
 * is trivially true at `i === 0`, so every ribbon stitched its first sample to
 * vertices -2 and -1. `setIndex()` on a plain number array picks Uint16 when no
 * value reaches 65535, so -2 and -1 were stored as 65534 and 65535 — indices
 * far past a buffer holding a few thousand vertices. WebGL then draws two
 * triangles from undefined vertex data, which is where the black lines that
 * "fly out of the mountain" came from: one stray pair per ribbon, on every
 * road, waterway and runway in the world.
 *
 * The headless probe caught it as `idx[0]=65534 but pos.count=6844`
 * (ROADAUDIT=runs). MAX_RIBBON_JUMP_M accidentally suppressed the ones whose
 * first sample sat more than 15 m from y=0, which is why the symptom got better
 * but never went away.
 */
const NO_PREV_SAMPLE = -2;

/**
 * Shortest stitched fragment worth drawing, in metres.
 *
 * A ribbon splits wherever the ground function refuses a sample, so a road
 * crossing broken terrain comes out as a string of disconnected pieces. A piece
 * this short is not a road any more — it is a dark rectangle lying on the
 * hillside, and a scatter of them is what the diorama reads as litter.
 *
 * Measured over the Dazhi route before this gate: 35 runs under 15 m, together
 * ~300 m out of 39 km of ribbon (0.8%). So the cost of dropping them is
 * negligible and the policy is already settled — missing roads are fine, and
 * this is a toy diorama, not a survey map.
 *
 * Deliberately NOT paired with an "abandon the whole feature if it lost N% of
 * its samples" rule: the riverside chunk refuses 48% of its samples and still
 * puts 95% of its length into runs longer than 100 m. A percentage gate there
 * would delete most of the riverside network to fix nothing.
 */
const MIN_RIBBON_RUN_M = 15;

/**
 * Blank out samples whose stitched run is too short to be worth drawing.
 *
 * Mirrors the emitter's own stitching rule (adjacent kept samples, within
 * MAX_RIBBON_JUMP_M) so the runs measured here are exactly the runs that would
 * be drawn — then returns a copy of `ys` with the doomed runs nulled, and the
 * unchanged emitter below simply never sees them.
 */
function dropShortRuns(samples: Sample[], ys: (number | null)[]): (number | null)[] {
  const n = samples.length;
  const out = ys.slice();
  let runStart = -1;    // first sample index of the current run
  let runLast = -1;     // last KEPT sample index of it (a run is contiguous)
  let prevKept = NO_PREV_SAMPLE;
  let prevY = 0;

  const closeRun = (): void => {
    if (runStart < 0) return;
    const long = runLast > runStart
      && samples[runLast].alongM - samples[runStart].alongM >= MIN_RIBBON_RUN_M;
    if (!long) for (let k = runStart; k <= runLast; k++) out[k] = null;
    runStart = -1;
  };

  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y === null) continue;
    const stitched = prevKept === i - 1 && Math.abs(y - prevY) <= MAX_RIBBON_JUMP_M;
    if (!stitched) {
      closeRun();
      runStart = i;
    }
    runLast = i;
    prevKept = i;
    prevY = y;
  }
  closeRun();
  return out;
}

/**
 * A ribbon whose width CHANGES along its length — the demo's `busWidthAt(d)`,
 * which is how the circuit world crosses a road-class boundary.
 *
 * `plan/circuit-town-demo.html`, verbatim:
 *
 * > 這個里程的走線寬度。段內固定,換級處走一段 **45° 的梯形漸變** —— 邊緣橫向
 * > 移動的速率等於沿路前進的速率,那正是 PCB 換線寬的做法(直接斷階在阻抗上是
 * > 一個台階,佈線軟體也不准)。
 *
 * and on WHERE the wedge goes:
 *
 * > 錐段整段擺在**新的那一級裡**(從段界往前),不跨界 —— 跨界的話錐段會被兩張
 * > 不同公稱寬的貼圖各畫一半,接縫剛好落在寬度正在變的地方,最難看的位置。
 *
 * That second reason ports as-is: gameview's road meshes are bucketed by
 * MATERIAL and circuit's material is per WIDTH, so a wedge straddling the joint
 * would be drawn half by one texture and half by another. Hence the ramp lives
 * entirely inside ONE feature — this profile's `startLen` / `endLen`.
 *
 * The demo's chain has an order (mileage), so it can say "the new one". A road
 * network has none, and a rule that reads the MVT winding breaks continuity the
 * moment two ways meet start-to-start (both would ramp, and they would disagree
 * about the width AT the joint). See `road-renderer`'s junction index for the
 * order-free rule that replaces it.
 */
export interface RibbonWidthProfile {
  /** Full width at `alongM = 0` (the junction's width, ≥ the nominal one). */
  startWidth: number;
  /** Metres over which `startWidth` ramps to the nominal width. 0 = no ramp. */
  startLen: number;
  /** Full width at the far end. */
  endWidth: number;
  endLen: number;
  /** The class's own full width — what the ribbon is between the two ramps, and
   *  what its texture was drawn for. */
  nominalWidth: number;
  /**
   * Half-span of `v` for a sample of the given ACTUAL width — the demo's `hv`
   * in `busSeg`, and its reason:
   *
   * > **v 不是固定的 0..1**。貼圖是照某一級的公稱寬畫的(阻焊邊 = BUS_MASK/nomW),
   * > 錐段上的實際寬度跟公稱寬不一樣,所以要反算 v 的半幅,阻焊邊在世界裡才會
   * > 一路維持 1 公尺;不反算的話錐段上的綠邊會跟著縮,看起來像金屬被削掉一角。
   *
   * Omit and `v` runs 0…1 across, exactly as it always did.
   */
  uvHalfSpan?: (actualWidth: number) => number;
}

/** A width profile resolved against a known total length (ramps clamped, the
 *  sample distances the emitter must not miss precomputed). */
interface ResolvedWidth {
  widthAt: (alongM: number) => number;
  uvHalfSpan: (actualWidth: number) => number;
  /** Distances that MUST land on a vertex — the wedge's two corners. */
  breaks: number[];
}

/**
 * Clamp a profile's ramps to the line it is on and hand back the evaluator.
 *
 * The demo never meets the overlap case (its segments are 140–260 m and a ramp
 * is at most 3 m), but MVT hands out stubs of any length, so the ramps are
 * capped at half the line each. That trades the 45° for continuity at both
 * joints, and only on a line shorter than `startLen + endLen` — which
 * `MIN_RIBBON_RUN_M` (15 m) already drops long before it can be seen.
 */
function resolveWidth(p: RibbonWidthProfile, totalM: number): ResolvedWidth {
  const w = p.nominalWidth;
  const half = Math.max(0, totalM / 2);
  const ls = Math.min(Math.max(0, p.startLen), half);
  const le = Math.min(Math.max(0, p.endLen), half);
  const breaks: number[] = [];
  if (ls > 0) breaks.push(ls);
  if (le > 0) breaks.push(totalM - le);
  breaks.sort((a, b) => a - b);
  return {
    // The demo's own line: `return wp + (w - wp) * ((d - s.d0) / L);`
    widthAt: (d) => {
      if (ls > 0 && d < ls) return p.startWidth + (w - p.startWidth) * (d / ls);
      const fromEnd = totalM - d;
      if (le > 0 && fromEnd < le) return p.endWidth + (w - p.endWidth) * (fromEnd / le);
      return w;
    },
    uvHalfSpan: p.uvHalfSpan ?? (() => 0.5),
    breaks,
  };
}

export interface GroundRibbonOptions {
  /** Half the ribbon's width, in metres. Ignored where `widthProfile` is set. */
  halfWidth: number;
  /** Metres above the ground the ribbon floats (road 0.3, water 0.15, …). */
  heightOffset: number;
  /** Set to vary the width along the ribbon (circuit's 45° class-change wedge);
   *  omit and the ribbon is a constant `halfWidth` with `v` = 0/1, byte for byte
   *  what it was before this existed. */
  widthProfile?: RibbonWidthProfile;
  resampleStepM?: number;
  /** Per-vertex colour (roads tint by class). */
  color?: THREE.Color;
  /** Emit uv: u = metres along the ribbon, v = 0/1 across it (dashes, tape). */
  emitUv?: boolean;
  /** Ownership clip: samples where this returns false are dropped (the ribbon
   *  splits there). Used to give each feature exactly ONE owning chunk in the
   *  padded-corridor overlap band, instead of every overlapping chunk building
   *  its own copy at a slightly different height. */
  keep?: (lon: number, lat: number) => boolean;
}

export interface RibbonProjection {
  originLat: number;
  originLon: number;
  cosOrigin: number;
}

/** A resampled centreline point, in scene metres. */
interface Sample {
  x: number;
  z: number;
  /** Metres travelled along the line to here. */
  alongM: number;
  /** The source coordinate pair this came from (for the fallback height). */
  lon: number;
  lat: number;
}

/**
 * Smallest gap between two resampled vertices, metres — the demo's own number
 * (`busSeg`: `if (d - last < 0.05) continue;   // 去掉重複 / 退化成零面積的一格`).
 * Only ever reached by an inserted wedge corner: the fixed step is metres apart.
 */
const MIN_SAMPLE_GAP_M = 0.05;

/**
 * Walk a lon/lat polyline and emit a point every `stepM` metres. The original
 * vertices are kept (they are where the line actually bends).
 *
 * `breaks` are distances that must land ON a vertex. The demo's `busSeg` does
 * exactly this, and says why:
 *
 * > **寬度沿路變**,而且錐段短(最短 1 公尺)。均勻取樣一定會把錐形的兩個轉角
 * > 切掉,所以取樣點除了固定步距之外,還要**把每個錐段的起訖點硬插進去** ——
 * > 梯形是線性的,端點對上了整段就是精確的,不必把步距壓到 0.2 公尺。
 */
function resample(
  coords: [number, number][],
  proj: RibbonProjection,
  stepM: number,
  breaks: readonly number[] = [],
): Sample[] {
  const sx = (lon: number) => (lon - proj.originLon) * 111320 * proj.cosOrigin;
  const sz = (lat: number) => -(lat - proj.originLat) * 111320;

  const out: Sample[] = [];
  let alongM = 0;
  let nextBreak = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon0, lat0] = coords[i];
    const [lon1, lat1] = coords[i + 1];
    const x0 = sx(lon0), z0 = sz(lat0);
    const x1 = sx(lon1), z1 = sz(lat1);
    const len = Math.hypot(x1 - x0, z1 - z0);

    out.push({ x: x0, z: z0, alongM, lon: lon0, lat: lat0 });

    // The fixed-step interior samples, kept in their ORIGINAL form (`t` from
    // `s * stepM / len`, distance from `alongM + len * t`) so a ribbon with no
    // breaks comes out byte for byte what it did before `breaks` existed.
    const interior: { t: number; d: number }[] = [];
    const steps = Math.floor(len / stepM);
    for (let s = 1; s <= steps; s++) {
      const t = (s * stepM) / len;
      if (t >= 1) break;
      interior.push({ t, d: alongM + len * t });
    }
    // …then any break falling strictly inside this source segment. A break at a
    // source vertex needs no insertion — that vertex is already emitted.
    while (nextBreak < breaks.length && breaks[nextBreak] <= alongM) nextBreak++;
    for (; nextBreak < breaks.length && breaks[nextBreak] < alongM + len; nextBreak++) {
      const d = breaks[nextBreak];
      interior.push({ t: len > 0 ? (d - alongM) / len : 0, d });
    }
    interior.sort((a, b) => a.d - b.d);

    let last = alongM;
    for (const e of interior) {
      if (e.d - last < MIN_SAMPLE_GAP_M) continue;
      last = e.d;
      out.push({
        x: x0 + (x1 - x0) * e.t,
        z: z0 + (z1 - z0) * e.t,
        alongM: e.d,
        lon: lon0 + (lon1 - lon0) * e.t,
        lat: lat0 + (lat1 - lat0) * e.t,
      });
    }
    alongM += len;
  }

  const [lonN, latN] = coords[coords.length - 1];
  out.push({ x: sx(lonN), z: sz(latN), alongM, lon: lonN, lat: latN });

  return out;
}

/** Total length of a projected polyline, metres — needed BEFORE resampling so a
 *  width profile's far-end ramp knows where it starts. */
function polylineLength(coords: [number, number][], proj: RibbonProjection): number {
  const sx = (lon: number) => (lon - proj.originLon) * 111320 * proj.cosOrigin;
  const sz = (lat: number) => -(lat - proj.originLat) * 111320;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += Math.hypot(
      sx(coords[i + 1][0]) - sx(coords[i][0]),
      sz(coords[i + 1][1]) - sz(coords[i][1]),
    );
  }
  return total;
}

/**
 * Turn resampled centreline points + per-sample heights into a flat strip.
 *
 * `ys` runs parallel to `samples`; a null height means "no terrain here" and
 * SPLITS the strip: the sample emits no vertices and no quad bridges the gap.
 * (The old behaviour invented a height from a point-quantised DEM formula —
 * a DIFFERENT quantiser from the terrain's cell average, which produced
 * whole-step cliffs in the ribbon exactly at the corridor edge.)
 */
function assembleStrip(
  samples: Sample[],
  ys: (number | null)[],
  opts: GroundRibbonOptions,
  width: ResolvedWidth | null = null,
): THREE.BufferGeometry | null {
  const n = samples.length;
  let keptCount = 0;
  for (let i = 0; i < n; i++) if (ys[i] !== null) keptCount++;
  if (keptCount < 2) return null;

  const positions = new Float32Array(keptCount * 2 * 3);
  const colors = opts.color ? new Float32Array(keptCount * 2 * 3) : null;
  const uvs = opts.emitUv ? new Float32Array(keptCount * 2 * 2) : null;
  const indices: number[] = [];

  let lastPx = 0;
  let lastPz = 1; // fallback perpendicular for a degenerate first segment
  let slot = 0;   // vertex-pair slot of the current kept sample
  let prevKeptSample = NO_PREV_SAMPLE; // sample index of the previous kept sample
  let prevY = 0;  // surface height of that sample (deck-flip guard)

  for (let i = 0; i < n; i++) {
    const y0 = ys[i];
    if (y0 === null) continue;
    const s = samples[i];
    const y = y0 + opts.heightOffset;

    // Direction from the geometric neighbour (dropped samples still exist as
    // positions); reuse the last one on a degenerate segment.
    const j = i < n - 1 ? i + 1 : i - 1;
    let dx = samples[j].x - s.x;
    let dz = samples[j].z - s.z;
    if (i === n - 1) { dx = -dx; dz = -dz; }
    const len = Math.hypot(dx, dz);
    // Half-width AT THIS SAMPLE. Without a profile this is `opts.halfWidth` and
    // every expression below is the one that was here before, character for
    // character — including the unscaled `lastPx/lastPz` fallback, which a
    // degenerate segment still inherits from its neighbour rather than from the
    // width (a degenerate sample has no direction to be wide in).
    const halfWidth = width ? width.widthAt(s.alongM) / 2 : opts.halfWidth;
    let px = lastPx, pz = lastPz;
    if (len > 1e-3) {
      px = (-dz / len) * halfWidth;
      pz = (dx / len) * halfWidth;
      lastPx = px;
      lastPz = pz;
    }

    const vi = slot * 2;
    positions[vi * 3] = s.x + px;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = s.z + pz;
    positions[(vi + 1) * 3] = s.x - px;
    positions[(vi + 1) * 3 + 1] = y;
    positions[(vi + 1) * 3 + 2] = s.z - pz;

    if (colors && opts.color) {
      const c = opts.color;
      colors[vi * 3] = c.r;
      colors[vi * 3 + 1] = c.g;
      colors[vi * 3 + 2] = c.b;
      colors[(vi + 1) * 3] = c.r;
      colors[(vi + 1) * 3 + 1] = c.g;
      colors[(vi + 1) * 3 + 2] = c.b;
    }

    if (uvs) {
      // v is 0/1 across — unless the width profile says the texture's border is
      // a fixed world metre count, in which case the span is reverse-computed so
      // that border stays that many metres wherever the ribbon is wider or
      // narrower than the texture's nominal width (demo `busSeg`'s `hv`).
      const hv = width ? width.uvHalfSpan(halfWidth * 2) : 0.5;
      uvs[vi * 2] = s.alongM;
      uvs[vi * 2 + 1] = 0.5 - hv;
      uvs[(vi + 1) * 2] = s.alongM;
      uvs[(vi + 1) * 2 + 1] = 0.5 + hv;
    }

    // Bridge a quad only to the DIRECTLY preceding sample — a dropped sample in
    // between means the ribbon is split there — and only when the two heights
    // are physically walkable apart (see MAX_RIBBON_JUMP_M): a deck flip would
    // otherwise weld the valley to the ridge with a vertical sliver.
    if (prevKeptSample === i - 1 && Math.abs(y - prevY) <= MAX_RIBBON_JUMP_M) {
      const a = vi - 2, b = vi - 1, c = vi, d = vi + 1;
      indices.push(a, b, c, b, d, c);
    }
    prevY = y;
    prevKeptSample = i;
    slot++;
  }

  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build one ribbon that follows the terrain.
 *
 * @param ground  Terrain probe (raycast). Returns null where no terrain is
 *                loaded — the ribbon now SPLITS there instead of inventing a
 *                height with the old (mismatched) quantised fallback formula.
 */
export function buildGroundRibbon(
  coords: [number, number][],
  proj: RibbonProjection,
  ground: GroundFn,
  opts: GroundRibbonOptions,
): THREE.BufferGeometry | null {
  if (coords.length < 2) return null;

  const width = opts.widthProfile
    ? resolveWidth(opts.widthProfile, polylineLength(coords, proj))
    : null;
  const samples = resample(coords, proj, opts.resampleStepM ?? RIBBON_STEP_M, width?.breaks);
  if (samples.length < 2) return null;

  const ys = dropShortRuns(samples, probeHeights(samples, ground, opts));
  return assembleStrip(samples, ys, opts, width);
}

/**
 * Height for every sample, walking the line so each probe can be told which
 * deck the ribbon is already on.
 *
 * This is what `GroundFn`'s `preferY` was always documented to receive and
 * never actually got: both builders used to call `ground(s.x, s.z)` with no
 * third argument, so every sample resolved its corridor layer independently.
 * Where a climb's corridor passes back over the valley, that let a single road
 * flip decks mid-ribbon — the valley half at ~0 m, the next sample 8 m along at
 * ~70 m on the ridge pass — and the bridging quad became a black arch across
 * the sky. Carrying the previous height forward pins the whole ribbon to one
 * deck.
 */
function probeHeights(
  samples: Sample[],
  ground: GroundFn,
  opts: GroundRibbonOptions,
): (number | null)[] {
  const ys: (number | null)[] = new Array(samples.length);
  let prevY: number | undefined;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const y = opts.keep && !opts.keep(s.lon, s.lat) ? null : ground(s.x, s.z, prevY);
    ys[i] = y;
    if (y !== null) prevY = y;
  }
  return ys;
}

/** Railing height above the road surface, metres. */
const BRIDGE_RAIL_HEIGHT = 1.1;

export interface RibbonWithRailsResult {
  /** The road strip — same attribute layout as other road ribbons. */
  ribbon: THREE.BufferGeometry;
  /** Two side railings (vertical strips, double-faced), or null when nothing
   *  survived. Separate geometry: railings use their own flat material, not
   *  the road's dashed texture. */
  rail: THREE.BufferGeometry | null;
}

/**
 * A ground ribbon PLUS side railings following the same draped heights —
 * bridges are drawn as plain surface roads (this is a toy diorama, not a city
 * skyline), the railings are what says "bridge".
 */
export function buildGroundRibbonWithRails(
  coords: [number, number][],
  proj: RibbonProjection,
  ground: GroundFn,
  opts: GroundRibbonOptions,
): RibbonWithRailsResult | null {
  if (coords.length < 2) return null;

  const width = opts.widthProfile
    ? resolveWidth(opts.widthProfile, polylineLength(coords, proj))
    : null;
  const samples = resample(coords, proj, opts.resampleStepM ?? RIBBON_STEP_M, width?.breaks);
  if (samples.length < 2) return null;

  // Filtered ONCE, here — the deck and its railings must agree on which runs
  // exist, or a bridge keeps its handrails after the deck under them was
  // dropped for being too short.
  const ys = dropShortRuns(samples, probeHeights(samples, ground, opts));

  const ribbon = assembleStrip(samples, ys, opts, width);
  if (!ribbon) return null;
  return { ribbon, rail: buildRibbonRails(samples, ys, opts, width) };
}

/** Two vertical railing strips along the ribbon edges, faces emitted both ways
 *  so the shared single-colour material needs no DoubleSide bookkeeping. Null
 *  heights split the rails exactly like they split the ribbon. */
function buildRibbonRails(
  samples: Sample[],
  ys: (number | null)[],
  opts: GroundRibbonOptions,
  width: ResolvedWidth | null = null,
): THREE.BufferGeometry | null {
  const n = samples.length;
  let keptCount = 0;
  for (let i = 0; i < n; i++) if (ys[i] !== null) keptCount++;
  if (keptCount < 2) return null;

  // side 0 = +perp edge, side 1 = −perp edge; 2 vertices (bottom, top) each.
  const positions = new Float32Array(keptCount * 2 * 2 * 3);
  const indices: number[] = [];

  let lastPx = 0;
  let lastPz = 1;
  let slot = 0;
  let prevKeptSample = NO_PREV_SAMPLE;
  let prevY = 0;
  for (let i = 0; i < n; i++) {
    const y0 = ys[i];
    if (y0 === null) continue;
    const s = samples[i];
    const yBottom = y0 + opts.heightOffset;
    const yTop = yBottom + BRIDGE_RAIL_HEIGHT;

    const j = i < n - 1 ? i + 1 : i - 1;
    let dx = samples[j].x - s.x;
    let dz = samples[j].z - s.z;
    if (i === n - 1) { dx = -dx; dz = -dz; }
    const len = Math.hypot(dx, dz);
    // Railings ride the deck's own edge, so they take the SAME per-sample width.
    const halfWidth = width ? width.widthAt(s.alongM) / 2 : opts.halfWidth;
    let px = lastPx, pz = lastPz;
    if (len > 1e-3) {
      px = (-dz / len) * halfWidth;
      pz = (dx / len) * halfWidth;
      lastPx = px;
      lastPz = pz;
    }

    // Same deck-flip guard as the road strip — rails must split wherever it does.
    const bridge = prevKeptSample === i - 1 && Math.abs(y0 - prevY) <= MAX_RIBBON_JUMP_M;

    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const base = (slot * 2 + side) * 2; // vertex index of this sample+side's bottom
      positions[base * 3] = s.x + px * sign;
      positions[base * 3 + 1] = yBottom;
      positions[base * 3 + 2] = s.z + pz * sign;
      positions[(base + 1) * 3] = s.x + px * sign;
      positions[(base + 1) * 3 + 1] = yTop;
      positions[(base + 1) * 3 + 2] = s.z + pz * sign;

      // Bridge a quad only to the DIRECTLY preceding kept sample — a dropped
      // sample splits the railing exactly where it splits the ribbon.
      if (bridge) {
        const prev = ((slot - 1) * 2 + side) * 2;
        // Both windings → visible from both sides with a plain material.
        indices.push(prev, prev + 1, base, prev + 1, base + 1, base);
        indices.push(base, prev + 1, prev, base, base + 1, prev + 1);
      }
    }
    prevY = y0;
    prevKeptSample = i;
    slot++;
  }

  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Merge ribbons into one buffer. Attributes are carried through only if the
 * FIRST geometry has them — every ribbon in one merge comes from the same
 * builder, so they always agree.
 */
export function mergeRibbonGeometries(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  const first = geometries[0];
  const withColor = !!first.getAttribute('color');
  const withUv = !!first.getAttribute('uv');

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.getAttribute('position').count;
    indexCount += g.index?.count ?? 0;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = withColor ? new Float32Array(vertexCount * 3) : null;
  const uvs = withUv ? new Float32Array(vertexCount * 2) : null;
  const indices = new Uint32Array(indexCount);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const col = g.getAttribute('color');
    const uv = g.getAttribute('uv');
    const count = pos.count;

    positions.set(pos.array as Float32Array, vertOffset * 3);
    if (norm) normals.set(norm.array as Float32Array, vertOffset * 3);
    if (colors && col) colors.set(col.array as Float32Array, vertOffset * 3);
    if (uvs && uv) uvs.set(uv.array as Float32Array, vertOffset * 2);

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
    }
    vertOffset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
