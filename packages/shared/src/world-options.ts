/**
 * Per-world player options — DECLARATION ONLY.
 *
 * Each world style declares the knobs that are meaningful for it; the welcome
 * screen renders whatever it finds here by `kind`, so adding a fourth world
 * means adding a row to WORLD_OPTIONS and touching no UI.
 *
 * WHY a static table instead of a method on the terrain strategy:
 *  - The strategy factories are code-split behind a dynamic import (they drag in
 *    Three.js). The welcome screen only needs to draw a few switches; pulling a
 *    whole 3D pipeline into that bundle to ask it "what are your options" is a
 *    bad trade.
 *  - A declaration is data. It has no behaviour to inherit.
 *
 * WHY `Record<WorldStyle, …>` rather than a partial map: the fourth world must
 * fail to COMPILE if nobody declares it. This codebase already carries several
 * `style === 'cuphead' ? A : B` two-way branches that a third world would fall
 * silently into; nothing added here is allowed to repeat that.
 *
 * Option keys are `StyleParams` field names (see
 * web/src/game/terrain/terrain-style-strategy.ts) — applying them is a plain
 * overlay onto the strategy's default params. That coupling is enforced at
 * compile time on the web side via `WorldOptionKey`.
 */

/** World visual style — spans all render modes (Phaser 2D + Three.js 3D). */
export type WorldStyle = 'plastic' | 'cuphead' | 'circuit';

/** Which renderer draws the ride. */
export type RenderMode = 'maplibre' | 'threejs' | 'phaser';

/** Everything an option can be worth. Stored as-is in config.json. */
export type WorldOptionValue = boolean | number | string;

/**
 * One declared option. `modes` omitted = applies to every render mode; listing
 * modes hides the control when the rider is on a renderer that ignores it (a
 * visible switch that the current renderer cannot honour is the same lie as one
 * with no code behind it).
 *
 * Arrays are `readonly` so the table can be declared `as const` — that is what
 * keeps `WorldOptionKey` a literal union instead of `string`.
 */
export type WorldOption =
  | {
      key: string;
      kind: 'toggle';
      label: string;
      hint?: string;
      default: boolean;
      modes?: readonly RenderMode[];
    }
  | {
      key: string;
      kind: 'range';
      label: string;
      hint?: string;
      min: number;
      max: number;
      step: number;
      unit?: string;
      default: number;
      modes?: readonly RenderMode[];
    }
  | {
      key: string;
      kind: 'enum';
      label: string;
      hint?: string;
      choices: readonly { value: string; label: string }[];
      default: string;
      modes?: readonly RenderMode[];
    };

/**
 * The options each world offers.
 *
 * Every entry here has been traced to code that reads the matching `StyleParams`
 * field. Nothing goes in this table on the strength of "it sounds like it should
 * work" — a switch that does nothing is worse than no switch.
 *
 * Defaults MUST equal `defaultStyleParams()` for the matching terrain style,
 * because "value === default" is what decides that a value is NOT persisted.
 *
 * All of today's options are Three.js-only: the Phaser 2D renderer has its own
 * style strategy and never reads StyleParams, and MapLibre draws a realistic map
 * with no world style at all.
 */
export const WORLD_OPTIONS = {
  // Toy blocks. Its whole look is the stepped terrain, so both knobs are about
  // how block-like the ground reads.
  plastic: [
    {
      key: 'quantEnabled',
      kind: 'toggle',
      label: '階梯地形',
      hint: '關掉會變成平滑的山坡，不再是一格格堆起來的積木',
      default: true,
      modes: ['threejs'],
    },
    {
      key: 'heightJitter',
      kind: 'range',
      label: '積木高低不齊',
      // Only the quantised builder applies the sink, so this knob does nothing
      // while 階梯地形 is off. Say so rather than let it look broken.
      hint: '同一層的積木下沉一點點，像手堆的；需要開著「階梯地形」',
      min: 0,
      max: 4,
      step: 0.1,
      unit: 'm',
      default: 1.5,
      modes: ['threejs'],
    },
    {
      key: 'acrylicCaseEnabled',
      kind: 'toggle',
      label: '壓克力展示盒',
      // Say the tier can override it. A switch the rider flips with nothing
      // happening reads as broken; a switch that says "unless your machine is
      // too slow" reads as honest.
      hint: '整個世界罩在玩具展示盒底下；低畫質分級會自動關掉',
      default: true,
      modes: ['threejs'],
    },
    {
      key: 'sceneBloomEnabled',
      kind: 'toggle',
      label: '夜間光暈',
      hint: '夜裡讓路燈與金幣的高光溢出來一點；低畫質分級會自動關掉',
      default: true,
      modes: ['threejs'],
    },
  ],
  // Corrugated cardboard. Its look is carried by the cut edges, the ink line,
  // and the screen-space paper pass — one knob each.
  cuphead: [
    {
      key: 'inkEnabled',
      kind: 'toggle',
      label: '墨線輪廓',
      hint: '物件描一圈黑邊，像畫在紙上剪下來的',
      default: true,
      modes: ['threejs'],
    },
    {
      key: 'corrugationStrength',
      kind: 'range',
      label: '瓦楞紋強度',
      hint: '地形切面上那一條條瓦楞紙芯的深淺',
      min: 0,
      max: 1.5,
      step: 0.05,
      default: 1,
      modes: ['threejs'],
    },
    // 這顆滑桿現在只管**紙纖維**。色階化與降飽和曾經也掛在這裡，2026-07-28 量到
    // 它們是「同一件事做第二次」：色階化 toon 的 gradientMap 已經在每個材質上做
    // 過，而降飽和 `paperify()` 已經在色票裡抽掉 45%。兩者疊在整個畫面上，把地面
    // 的綠 `#6d9a46` 推成 `#808457`（R≈G 的土黃），整份色票色相位移最多 36°。
    // 理由與量到的數字寫在 `web/src/game/terrain/paper-effect-pass.ts` 的檔頭。
    {
      key: 'paperStrength',
      kind: 'range',
      label: '紙質後製強度',
      hint: '整個畫面疊一層紙纖維顆粒，0 = 完全關掉',
      min: 0,
      max: 1,
      step: 0.05,
      default: 1,
      modes: ['threejs'],
    },
    {
      key: 'acrylicCaseEnabled',
      kind: 'toggle',
      label: '壓克力罩',
      hint: '整個模型罩在評圖用的壓克力罩底下；低畫質分級會自動關掉',
      default: true,
      modes: ['threejs'],
    },
    // 上色 ↔ 素紙板。兩支瓦楞紙 demo 從頭就有這顆按鈕(`?paint=0`,按鈕上寫的是
    // 現在是哪一態:「上色:廣告顏料 / 上色:素紙板」),移植時機制搬過來了、開關
    // 沒有。這一列就是那顆按鈕。
    //
    // 「素」在這個世界不是灰階、也不是把全部塗成同一個棕色:是**還沒上色的稿**
    // ——墨線都在,顏料還沒刷上去,每一塊填色依明度分五階換成牛皮紙色。天空、
    // 日月與墨線不動,它們在紙的背後或本來就是畫本身。
    //
    // ⚠ 3D 那半**已經落地**(2026-07-28,`paper-terrain-style.ts`):踏面的分層色
    // 換成 demo 那兩個交替的牛皮紙色、量體/分區/公園的顏料筆觸拿掉、剪紙樹換成
    // demo 的 `painted = false` 那一張。策略在建材質時讀 `params.paintEnabled`,
    // 而 `applyWorldOptions()` **不**依 render mode 過濾（它把整個 world 的值原封
    // 寫上 `strat.params`），所以那條線今天就是通的。
    //
    // 但 modes 這裡**還是只掛 2D**，而且是刻意的：把 'threejs' 加進去，下面
    // `WorldOptionKey` 的切分會立刻要求 `paintEnabled` 是 `StyleParams` 的欄位，
    // 而且 diorama 的 `[world options — round trip]` 會要求
    // 「宣告的預設值 === `defaultStyleParams('paper')` 的值」。那兩樣都住在
    // `web/src/game/terrain/terrain-style-strategy.ts`，這一輪由別的 agent 握著。
    //
    // 交還給主線的**一個 commit**要同時做完三件事，缺一件就編不過或紅一條：
    //   1. `StyleParams` 加 `paintEnabled: boolean`
    //   2. `defaultStyleParams` 三個世界各給值（paper `true`；plastic / circuit
    //      也要有，欄位是必填的 —— 它們不讀它，跟 `bumpEnabled` 同一個處境）
    //   3. 這一列的 modes 改成 `['phaser', 'threejs']`，並刪掉
    //      `paper-terrain-style.ts` 裡那段補預設值的 `if (paintEnabled === undefined)`
    {
      key: 'paintEnabled',
      kind: 'toggle',
      label: '上色',
      hint: '關掉就是還沒上色的素紙板：墨線都在，廣告顏料還沒刷上去',
      default: true,
      modes: ['phaser', 'threejs'],
    },
    // No bloom switch here, and that is a LOOK decision rather than an omission:
    // DEVPLAN gives the corrugated world no bloom at all, because poster paint
    // does not glow and the moment it does this stops being that world.
  ],
  // Circuit board. Its look is the powered PCB: stacked-board terrain, and the
  // strong night bloom that makes traces / nixie tubes / LEDs actually glow —
  // the demo's own hierarchy is 電子=強 bloom, 積木=弱, 瓦楞紙=無.
  circuit: [
    {
      key: 'quantEnabled',
      kind: 'toggle',
      label: '疊層板地形',
      hint: '關掉會變成平滑的山坡，不再是一層層疊起來的電路板',
      default: true,
      modes: ['threejs'],
    },
    {
      key: 'acrylicCaseEnabled',
      kind: 'toggle',
      label: '防塵罩',
      hint: '整塊板子罩在防塵防靜電罩底下；低畫質分級會自動關掉',
      default: true,
      modes: ['threejs'],
    },
    {
      key: 'sceneBloomEnabled',
      kind: 'toggle',
      label: '夜間光暈',
      hint: '走線、輝光管與 LED 的光外溢出來；低畫質分級會自動關掉',
      default: true,
      modes: ['threejs'],
    },
  ],
} as const satisfies Record<WorldStyle, readonly WorldOption[]>;

/** One declared option, as inferred from the `as const` table above. */
type AnyWorldOption = (typeof WORLD_OPTIONS)[WorldStyle][number];

/**
 * The options ONLY the Phaser 2D renderer honours.
 *
 * `modes: ['phaser']` exactly — an option listing both renderers still has to be
 * a `StyleParams` field, because the 3D side really will be handed it.
 */
type PhaserOnlyOption = Extract<AnyWorldOption, { modes: readonly ['phaser'] }>;

/** Every option key any world declares, across both renderers. */
export type AnyWorldOptionKey = AnyWorldOption['key'];

/**
 * The option keys the THREE.JS renderer must have a field for. Literal union
 * (that is what `as const` above buys) so the web side can assert at COMPILE
 * time that each one names a real `StyleParams` field — see the assertion in
 * terrain-style-strategy.ts.
 *
 * WHY this is the 3D-only subset rather than every key, and why that is NOT a
 * loosening of that assertion: the coupling it enforces is
 * "`applyWorldOptions` writes this key straight onto `StyleParams`", and that is
 * only true of keys the 3D renderer is given. The Phaser 2D renderer has its own
 * style strategy and has never read `StyleParams` at all (it is why every option
 * in this file used to be `modes: ['threejs']`), so requiring a `StyleParams`
 * field for a 2D-only switch would mean adding a field nothing reads — the exact
 * shape of lie the assertion exists to catch, just pointing the other way.
 *
 * A 2D-only key is NOT thereby unchecked. It gets the same treatment against the
 * thing that DOES read it: `PhaserWorldOptionKey extends keyof PhaserWorldOptions`
 * in `web/src/game/phaser/phaser-style-strategy.ts`. Both halves of the table are
 * pinned to a renderer that honours them; neither can carry a dead switch.
 */
export type WorldOptionKey = Exclude<AnyWorldOption, PhaserOnlyOption>['key'];

/** The 2D-only option keys — checked against `PhaserWorldOptions` on the web
 *  side, the same way `WorldOptionKey` is checked against `StyleParams`. */
export type PhaserWorldOptionKey = PhaserOnlyOption['key'];

/**
 * Sparse per-world values as persisted in `AppConfig.map.worldOptions`. Only
 * entries that DIFFER from the declared default are stored — see
 * `sparseWorldOptions` for why.
 */
export type WorldOptionsConfig = Partial<Record<WorldStyle, Record<string, WorldOptionValue>>>;

/**
 * Options a world offers, optionally narrowed to one render mode. Returned as
 * the widened `WorldOption[]` so UI code can iterate generically.
 */
export function worldOptionsFor(
  style: WorldStyle,
  mode?: RenderMode,
): readonly WorldOption[] {
  const all = WORLD_OPTIONS[style] as readonly WorldOption[];
  if (!mode) return all;
  return all.filter((o) => !o.modes || o.modes.includes(mode));
}

/** Decimal places implied by a step, so 0.1-stepping can't leak float dust. */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Clamp + snap a range value onto its declared grid.
 *
 * Sliders emit values like 1.5000000000000002, which would never compare equal
 * to the declared default and so would be persisted forever as a "change" the
 * rider never made. Snapping first is what makes the sparse test reliable.
 */
export function snapWorldOptionValue(opt: WorldOption, value: WorldOptionValue): WorldOptionValue {
  if (opt.kind === 'toggle') return value === true;
  if (opt.kind === 'enum') {
    return opt.choices.some((c) => c.value === value) ? value : opt.default;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return opt.default;
  const clamped = Math.min(opt.max, Math.max(opt.min, num));
  const snapped = opt.min + Math.round((clamped - opt.min) / opt.step) * opt.step;
  return Number(snapped.toFixed(decimalsOf(opt.step)));
}

/** True when a stored value is the wrong shape for its declared kind. */
function typeMatches(opt: WorldOption, value: WorldOptionValue): boolean {
  if (opt.kind === 'toggle') return typeof value === 'boolean';
  if (opt.kind === 'range') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

/** Declared defaults for a world, keyed by option key. */
export function worldOptionDefaults(style: WorldStyle): Record<string, WorldOptionValue> {
  const out: Record<string, WorldOptionValue> = {};
  for (const opt of WORLD_OPTIONS[style] as readonly WorldOption[]) out[opt.key] = opt.default;
  return out;
}

/**
 * The FULL value set for a world: declared defaults with the rider's stored
 * overrides laid on top. Anything the rider never touched — and anything stored
 * under a key or type this build no longer declares — falls back to the default,
 * which is precisely what makes changing a default later actually reach people
 * who have already played.
 *
 * Not filtered by render mode: the values are applied to the renderer, and a
 * renderer that ignores a field is harmless. Filtering belongs in the UI.
 */
export function resolveWorldOptions(
  style: WorldStyle,
  stored: WorldOptionsConfig | undefined,
): Record<string, WorldOptionValue> {
  const out = worldOptionDefaults(style);
  const overrides = stored?.[style];
  if (!overrides) return out;
  for (const opt of WORLD_OPTIONS[style] as readonly WorldOption[]) {
    const raw = overrides[opt.key];
    if (raw === undefined || !typeMatches(opt, raw)) continue;
    out[opt.key] = snapWorldOptionValue(opt, raw);
  }
  return out;
}

/**
 * Strip a full value set down to what actually needs persisting: only the
 * entries that differ from the declared default.
 *
 * Storing everything would pin each option at whatever the default happened to
 * be on the day the rider first opened the panel — later tuning of the defaults
 * would then reach nobody who has ever played, which is the opposite of what a
 * default is for. It also keeps config.json readable by a human.
 */
export function sparseWorldOptions(
  style: WorldStyle,
  values: Record<string, WorldOptionValue>,
): Record<string, WorldOptionValue> {
  const out: Record<string, WorldOptionValue> = {};
  for (const opt of WORLD_OPTIONS[style] as readonly WorldOption[]) {
    const raw = values[opt.key];
    if (raw === undefined || !typeMatches(opt, raw)) continue;
    const snapped = snapWorldOptionValue(opt, raw);
    if (snapped !== opt.default) out[opt.key] = snapped;
  }
  return out;
}

/**
 * Apply one edit and return the WHOLE new sparse map, ready to PATCH.
 *
 * Returns a fresh object (never mutates `stored`) and drops the world's entry
 * entirely once nothing differs from the defaults, so putting every slider back
 * where it started leaves config.json exactly as it was before.
 *
 * NOTE: the server merges config patches deeply, so `map.worldOptions` is
 * treated there as a replace-whole leaf — otherwise the keys this function
 * deliberately omits would survive the merge and the sparseness would be a lie.
 * See ConfigStore.save in packages/server.
 */
export function withWorldOption(
  stored: WorldOptionsConfig | undefined,
  style: WorldStyle,
  key: string,
  value: WorldOptionValue,
): WorldOptionsConfig {
  const next: WorldOptionsConfig = { ...stored };
  const merged = { ...resolveWorldOptions(style, stored), [key]: value };
  const sparse = sparseWorldOptions(style, merged);
  if (Object.keys(sparse).length === 0) delete next[style];
  else next[style] = sparse;
  return next;
}

/** Drop every override for one world (the panel's "back to defaults" button). */
export function clearWorldOptions(
  stored: WorldOptionsConfig | undefined,
  style: WorldStyle,
): WorldOptionsConfig {
  const next: WorldOptionsConfig = { ...stored };
  delete next[style];
  return next;
}

/** Does this world currently carry any non-default value? */
export function hasWorldOptionOverrides(
  stored: WorldOptionsConfig | undefined,
  style: WorldStyle,
): boolean {
  const overrides = stored?.[style];
  return !!overrides && Object.keys(overrides).length > 0;
}
