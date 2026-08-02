/**
 * Demo → gameview coverage inventory.
 *
 * ── Why this exists ──
 *
 * **The demos in `plan/` are not prototypes. They are the POC whose code gets
 * transplanted into the frontend once it runs.** That is the project's working
 * model, and it has one consequence that keeps being forgotten: a demo function
 * is not a *reference* for gameview to reimplement, it is the *source* gameview
 * is supposed to end up containing.
 *
 * Every time that was forgotten, the same thing happened — someone read the
 * demo, understood the shape, and wrote their own version against gameview's
 * interfaces. It always looked right and it was never the same. The plastic cup
 * tower is the worked example: taper 0.6914 → 0.700, 14 facets → 8, the rim
 * dropped entirely, the grid recomputed. Nothing recorded it and nothing caught
 * it, and the window/sign anchors the developer had positioned against that
 * geometry were silently invalidated.
 *
 * So this answers, mechanically and repeatedly: **which of each demo's model
 * functions actually exist in the ported world, and which do not?**
 *
 * ── What it does and does not prove ──
 *
 * It is an INVENTORY, not a fidelity check. It reports whether a demo function
 * has a counterpart at all. Whether that counterpart draws the same thing is
 * what the per-body demo-diff checks in `diorama.ts` are for (they slice the
 * demo's source out of the HTML and execute it).
 *
 * Read a ✗ as "definitely missing" and a ✓ as "present, fidelity unknown".
 *
 * Usage:  node scripts/headless-check/demo-coverage.mjs [--verbose]
 */

import { readFileSync } from 'node:fs';

/** Which demo feeds which style file(s). */
const WORLDS = [
  {
    name: 'plastic (toy blocks)',
    demo: 'plan/plastic-town-demo.html',
    targets: [
      'packages/web/src/game/terrain/plastic-terrain-style.ts',
      // The baseplate studs land in two halves: the style declares the unit
      // stud, the LOD table and the colours; `ground-studs.ts` holds the demo's
      // `studInstances` / `studLevelFor` / `applyStudLod`, which are renderer
      // code and not style code. Without this the report calls them missing.
      'packages/web/src/game/terrain/ground-studs.ts',
    ],
  },
  {
    name: 'cuphead (paper / cardboard)',
    demo: 'plan/paper-town-demo.html',
    targets: ['packages/web/src/game/terrain/paper-terrain-style.ts'],
  },
  {
    name: 'circuit (electronics)',
    demo: 'plan/circuit-town-demo.html',
    targets: ['packages/web/src/game/terrain/circuit-terrain-style.ts'],
  },
];

/**
 * Names that are the demo's own SCAFFOLDING, not its models.
 *
 * gameview already has a renderer, a camera, a chunk manager, a weather system
 * and a ride loop — those must NOT be ported, and counting them as missing
 * would make every world look permanently incomplete and train everyone to
 * ignore the report.
 */
const SCAFFOLDING = new Set([
  // maths / rng / colour helpers gameview has its own of
  'mulberry32', 'clamp', 'lerp', 'lerpC', 'smoothstep', 'rgbOf', 'tint', 'hash',
  'brightenHex', 'mergeGeos', 'matKey', 'snap', 'wrap9', 'step', 'add', 'put',
  'mid', 'k', 'a', 'j', 'x', 'cx', 'cw', 'sw', 'tw', 'bx', 'ax', 'rx', 'w1',
  'ci', 'cv', 'f', 'hv', 'inst', 'build', 'path', 'shared', 'flus', 'lig', 'lay',
  // demo app shell
  'RENDER_SCALE', 'onBoard', 'extendPath', 'pathAt', 'tx', 'tz', 'extendZones',
  'zoneAt', 'zoneSpans', 'extendRoads', 'roadSpans', 'offsetAt',
  // material factories gameview owns via the strategy interface
  'gradientMap', 'toon', 'toonShared', 'gloss', 'glossShared', 'metal',

  // ── The demo's APP SHELL: deliberately NOT ported ──
  // gameview already owns a renderer, camera, chunk manager, weather system,
  // post pipeline, input and ride loop. Counting these as "missing" would make
  // every world look permanently incomplete, and a report that can never reach
  // 100 % is a report everyone learns to ignore.
  'readControls', 'refreshQs', 'resize', 'setDraft', 'setRaining', 'readPedal',
  'buildChunk', 'disposeChunk', 'isFree', 'place', 'harvest', 'prof',
  'applyDayNight', 'applyWeather', 'applyRain', 'applyPaintMode', 'applyBulb',
  'applyTubeLight', 'applyDomeTint',
  'cadenceSpeed', 'wattGain', 'wheel',
  // per-chunk batching infrastructure — gameview's chunk pipeline is its own
  'batchCommit', 'batchOf', 'batchRelease', 'batchGroup', 'flushParts',
  'writeParts', 'protoParts', 'bakeParts', 'boxBatcher', 'studBucket',
  'treeBucket', 'coinBatch', 'signBin',
  // post-processing chain — gameview has EffectComposer + scene-bloom-pass
  'POST_LEVEL', 'buildPost', 'renderPost', 'mkRT', 'bloomStrength',
  // small geometry/uv utilities with gameview equivalents
  'uvSide', 'uvTop', 'uvTopR', 'chordCut', 'ang', 'wrapN', 'mirror', 'skew',
  'rectShape', 'blobShape', 'unitCyl', 'unitCone', 'unitSphere', 'cyl', 'box',
  'scaledBox', 'mergeGeos', 'extendDupont',
]);

/**
 * Model functions gameview reaches through a DIFFERENT name, because the
 * strategy interface names the slot rather than the shape.
 *
 * Kept as an explicit table rather than loosened matching: "the port renamed
 * it" and "the port never happened" look identical to a grep, and only one of
 * them is acceptable.
 */
const ALIASES = {
  // demo name          → what to look for in the ported style
  ribbonSeg: 'buildRoadRibbon|roadRibbon|ribbon',
  sideWallSeg: 'sideWall|buildSideWall',
  makeCheckpoint: 'buildCheckpoint',
  makeCoin: 'buildCoinMesh',
  makeZonedBuilding: 'buildBuildingBody|buildBuildingBoxes',
  buildingKindFor: 'pickBodyKind|buildingKindFor|bodyFor',
  dressBuilding: 'buildBuildingDecoration',
  addBuildingLights: 'buildBuildingLights',
  pushBuildingLights: 'buildBuildingLights',
  glyphOf: 'SIGN_GLYPHS|signStrokes',
  glyphStrokes: 'SIGN_GLYPHS|signStrokes',
  labelSign: 'buildSign',
  makeSignFor: 'buildSign',
  epaperSign: 'buildSign',
  mountSign: 'mountShopSign',
  stars: 'starParticles|createStars',
  lightning: 'LightningBolt|lightning-bolt',
  rain: 'rainParticles|createRain',
};

/** Looks like a model/texture builder rather than a helper. */
function isModelFn(name) {
  if (SCAFFOLDING.has(name)) return false;
  if (name.length <= 2) return false;                 // one/two-letter locals
  if (/^(on|handle|update|tick|animate|init|main|fmt)/i.test(name)) return false;
  // `geo*` / `GEO_*` is the demos' real-map loader (`?loc=`): tile fetch, PNG
  // decode, Web Mercator, route extraction. It draws NOTHING, so it has no
  // shape to be ported — gameview's counterparts are ElevationSampler and
  // MVTFetcher, which this tool cannot match because it fingerprints magic
  // numbers in geometry. Left in, it added ~14 phantom "absent model functions"
  // per world and inflated the headline count by 40%.
  if (/^(geo[A-Z]|GEO_)/.test(name)) return false;
  return true;
}

/**
 * Numbers common enough to prove nothing. A port sharing `0.5` with the demo is
 * not evidence of anything; sharing `1.62` and `0.14` and `3.5` is.
 */
const BORING = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '16', '20',
  '100', '255', '360', '180', '90', '45', '0.0', '1.0', '2.0', '0.5', '1.5',
  '0.1', '0.2', '0.3', '0.4', '0.6', '0.7', '0.8', '0.9', '0.25', '0.75',
]);

/**
 * A demo function's FINGERPRINT: the distinctive numeric literals in its body.
 *
 * Names are the wrong thing to match on. gameview names a slot
 * (`buildStreetLamp`), the demo names a shape (`bubbleLamp`), and a grep cannot
 * tell "renamed during a faithful port" from "never ported" — the first version
 * of this tool reported the bubble lamp, the highlighter lamp and the whole
 * eraser house as missing when all three are present.
 *
 * Magic numbers survive renaming. `CylinderGeometry(1.62, 1.12, 3.0, 14…)` is
 * the cup wherever it lives and whatever it is called, and if the port shares
 * those numbers it copied them.
 */
function fingerprint(body) {
  const nums = new Set();
  for (const m of body.matchAll(/(?<![\w.])(\d+\.\d+|\d{2,})(?![\w.])/g)) {
    if (!BORING.has(m[1])) nums.add(m[1]);
  }
  return [...nums];
}

/**
 * Where the declaration starting at `at` closes, by brace counting.
 *
 * Crude on purpose — braces inside strings, regexes or comments will confuse
 * it. That is acceptable because it is only ever used as an UPPER BOUND
 * (`min(nextDeclaration, bodyEnd)`): getting it wrong can only make a
 * fingerprint shorter, never let it swallow a neighbour. A short fingerprint
 * understates coverage, which is the safe direction for a tool whose `absent`
 * column is the trustworthy one.
 */
function bodyEnd(src, at) {
  const open = src.indexOf('{', at);
  if (open < 0) return src.length;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

function demoModelFns(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  // Block 0 is the bundled three.js; the demo's own code is block 1.
  const src = blocks[1] ?? '';
  const out = [];
  const re = /^[ \t]*(?:function|const)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:=[ \t]*)?(?:\(|function)/gm;
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push([m[1], m.index]);
  for (let i = 0; i < starts.length; i++) {
    const [name, at] = starts[i];
    if (!isModelFn(name)) continue;
    // End at the function's OWN closing brace, not at the next declaration.
    //
    // Running to the next declaration swallows whatever sits between them —
    // comment blocks, `const` tables, a whole other section of the demo — and
    // those numbers then count as this function's fingerprint. It reported
    // `bubbleLamp 9/13` (a "partial", i.e. "this is what a re-derivation looks
    // like") when the lamp was fine: the window had eaten the poker-chip coin
    // section, so the four "missing" numbers were two draw-call counts from a
    // prose comment and two coin scale constants. It sent an investigation at
    // the wrong world.
    const nextDecl = i + 1 < starts.length ? starts[i + 1][1] : src.length;
    out.push({ name, fp: fingerprint(src.slice(at, Math.min(nextDecl, bodyEnd(src, at)))) });
  }
  return out;
}

let missingTotal = 0;
const verbose = process.argv.includes('--verbose');

for (const world of WORLDS) {
  let html;
  try {
    html = readFileSync(world.demo, 'utf8');
  } catch {
    console.log(`\n${world.name}: demo not found (${world.demo}) — skipped`);
    continue;
  }
  let target = '';
  let targetMissing = false;
  for (const t of world.targets) {
    try { target += readFileSync(t, 'utf8'); } catch { targetMissing = true; }
  }

  const fns = demoModelFns(html).sort((a, b) => a.name.localeCompare(b.name));

  // A function scores by how much of its fingerprint survived into the port.
  // Name or alias still counts — a copied function that kept its name is the
  // clearest case of all — but a rename can no longer hide a missing model.
  const scored = fns.map((f) => {
    const named = new RegExp(`\\b${f.name}\\b`).test(target)
      || (ALIASES[f.name] && new RegExp(ALIASES[f.name]).test(target));
    const found = f.fp.filter((n) => target.includes(n));
    const ratio = f.fp.length ? found.length / f.fp.length : (named ? 1 : 0);
    return { ...f, named, found: found.length, ratio };
  });

  // Thresholds, and why: a function with most of its magic numbers in the port
  // was copied; one with almost none was not, whatever it is called. The middle
  // is where a re-derivation lands, which is exactly the case worth surfacing.
  const copied = scored.filter((s) => s.named || s.ratio >= 0.6);
  const partial = scored.filter((s) => !s.named && s.ratio >= 0.2 && s.ratio < 0.6);
  // A function whose fingerprint came back EMPTY carries no numeric evidence at
  // all, so `ratio` is 0 by construction and it lands in `absent` no matter what
  // the port contains. Calling that "absent" is a lie the tool told three times
  // in a row on 2026-07-29/30: `bandPaint`, `zoneStuds`, `pickBuildingKind`,
  // `luKindOf`, `luRings`, `luRingInfo` were all reported missing while sitting
  // in the port under other names (and `bandPaint`/`luKindOf` had been copied
  // demo-ward FROM gameview — the ticket pointed backwards). Split them out:
  // the honest verdict is "this tool cannot see this one", which is a request to
  // go read the code, not a work item.
  const blind = scored.filter((s) => !s.named && s.ratio < 0.2 && s.fp.length === 0);
  const absent = scored.filter((s) => !s.named && s.ratio < 0.2 && s.fp.length > 0);
  missingTotal += absent.length;

  const pct = fns.length ? Math.round((copied.length / fns.length) * 100) : 0;
  console.log(`\n${world.name}`);
  console.log(`  ${world.demo} → ${world.targets.map((t) => t.split('/').pop()).join(', ')}`
    + (targetMissing ? '  (target missing!)' : ''));
  console.log(`  ${copied.length}/${fns.length} present (${pct}%)   `
    + `${partial.length} partial   ${absent.length} absent   ${blind.length} 看不見`);
  if (partial.length) {
    console.log(`  PARTIAL — some of the demo's numbers, not most. This is what a`);
    console.log(`  re-derivation looks like; check these against the demo:`);
    for (const s of partial) {
      console.log(`    ${s.name.padEnd(22)} ${s.found}/${s.fp.length} numbers`);
    }
  }
  if (absent.length) {
    console.log(`  ABSENT (${absent.length}) — 指紋在,但港口裡找不到那些數字:`);
    const names = absent.map((s) => s.name);
    for (let i = 0; i < names.length; i += 6) {
      console.log('    ' + names.slice(i, i + 6).join('  '));
    }
  }
  if (blind.length) {
    console.log(`  看不見 (${blind.length}) — 指紋是空的,這一欄**只比對過名字**。`);
    console.log(`  不是待辦清單:改過名字、住在共用模組、或本來就是從 gameview`);
    console.log(`  反方向抄進 demo 的,都會落在這裡。派工之前去讀程式碼。`);
    const names = blind.map((s) => s.name);
    for (let i = 0; i < names.length; i += 6) {
      console.log('    ' + names.slice(i, i + 6).join('  '));
    }
  }
  if (verbose) {
    for (const s of copied) {
      console.log(`    ✓ ${s.name.padEnd(22)} ${s.named ? 'by name' : `${s.found}/${s.fp.length} numbers`}`);
    }
  }
}

console.log(`\n${missingTotal} demo model function(s) with no counterpart across all worlds.`);
console.log('⚠ Presence ≠ fidelity. A ✓ only means a name exists; whether it draws the');
console.log('  same thing is what the per-body demo-diff checks in diorama.ts prove.');
