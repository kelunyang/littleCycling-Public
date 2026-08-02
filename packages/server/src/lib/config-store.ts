/**
 * Config persistence — reads/writes data/config.json.
 * Deep-merges with DEFAULT_CONFIG so missing fields are always filled.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, DATA_ATTRIBUTIONS, type AppConfig, type LlmProvider } from '@littlecycling/shared';

/**
 * Required first-run personalization fields. If any of these is missing from
 * the raw config.json (age additionally must be > 0), the frontend auto-opens
 * the settings drawer to prompt the rider. Paths are dot-notated into AppConfig.
 */
export const REQUIRED_PERSONAL_SETTINGS = [
  'training.hrMax',
  'training.ftp',
  'training.age',
  'sensor.wheelCircumference',
  'sensor.trainerModel',
] as const;

/** Read a dot-path (e.g. 'training.age') out of a plain object, or undefined. */
function getPath(obj: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Does a required field count as "provided"? age must be a number > 0. */
function isProvided(path: string, val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (path === 'training.age') return typeof val === 'number' && val > 0;
  return true;
}

/**
 * Given the RAW parsed config.json (before the DEFAULT_CONFIG deep-merge),
 * return which required personalization fields are still missing.
 *
 * Judged against the raw file, NOT the merged config: save() writes the full
 * merged config back to disk, so DEFAULT hrMax/ftp/sensor values would always
 * look "present" — only `training.age` (which has no default) and the persisted
 * `setupCompleted` flag reliably reflect the rider's intent. If setupCompleted
 * is true, setup is done → returns [] (never prompt again). Pass null (missing/
 * malformed file) to mark every field missing — a genuine first run.
 */
export function computeMissingSettings(raw: Record<string, unknown> | null): string[] {
  if (raw && raw.setupCompleted === true) return [];
  return REQUIRED_PERSONAL_SETTINGS.filter((path) => !isProvided(path, getPath(raw, path)));
}

/**
 * After a PATCH: drop from `missing` any required field the payload explicitly
 * provides (age still must be > 0 to count). Fields absent from the patch stay
 * missing. Returns the new list.
 */
export function removeProvidedFromMissing(
  missing: string[],
  patch: Record<string, unknown>,
): string[] {
  return missing.filter((path) => {
    const val = getPath(patch, path);
    if (val === undefined) return true; // not in this patch → still missing
    return !isProvided(path, val);
  });
}

/**
 * Config sub-trees a PATCH REPLACES wholesale instead of deep-merging.
 *
 * `map.worldOptions` is stored SPARSELY — a key's absence means "use the
 * declared default" (see shared/world-options.ts). A deep merge cannot express
 * absence: putting a slider back where it started would leave the old value
 * sitting in config.json forever, pinning that option and making any later
 * change to the default unreachable for anyone who has ever opened the panel.
 * The client always sends the COMPLETE sparse map, so replacing is both safe
 * and the only way the sparseness stays true.
 */
const REPLACE_WHOLE_PATHS = ['map.worldOptions'] as const;

/**
 * Overwrite the replace-whole paths in a merged config with the patch's own
 * value. Runs AFTER deepMerge; a path the patch does not mention is untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyReplaceWholePaths(merged: any, patch: any): void {
  for (const path of REPLACE_WHOLE_PATHS) {
    const keys = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let src: any = patch;
    for (const key of keys) {
      if (src === null || typeof src !== 'object' || !(key in src)) { src = undefined; break; }
      src = src[key];
    }
    if (src === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dst: any = merged;
    for (const key of keys.slice(0, -1)) {
      if (dst === null || typeof dst !== 'object') { dst = undefined; break; }
      dst = dst[key];
    }
    if (dst !== null && dst !== undefined && typeof dst === 'object') {
      dst[keys[keys.length - 1]] = src;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge<T>(base: T, patch: any): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    const baseVal = result[key];
    const patchVal = patch[key];
    if (
      baseVal && patchVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof patchVal === 'object' && !Array.isArray(patchVal)
    ) {
      result[key] = deepMerge(baseVal, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result as T;
}

/**
 * Migrate the legacy `map.phaserStyle` key to `map.worldStyle` in-place.
 * Old config.json files (written before the world-style rename) only have
 * `phaserStyle`; without this a rider who picked hand-drawn would be reset to
 * the default. Runs on the parsed object BEFORE the default deep-merge so the
 * carried-over value wins over DEFAULT_CONFIG's `worldStyle: 'plastic'`.
 */
function migrateWorldStyle(parsed: Record<string, unknown>): void {
  const map = parsed.map;
  if (!map || typeof map !== 'object') return;
  const m = map as Record<string, unknown>;
  if (m.worldStyle === undefined && typeof m.phaserStyle === 'string') {
    m.worldStyle = m.phaserStyle;
  }
  // Drop the obsolete key so it stops lingering in config.json after re-save.
  delete m.phaserStyle;
}

export class ConfigStore {
  private config: AppConfig;
  /**
   * Legacy `llm[]` array pulled out of an old config.json on load. LLM providers
   * now live in SQLite; this holds them one-shot until the server migrates them
   * (see takeLegacyLlm). Not part of AppConfig — never merged back or persisted.
   */
  private legacyLlm: LlmProvider[] = [];
  /**
   * Required personalization fields still missing from the raw config.json.
   * Computed on load, refreshed by markPatched. Injected (never persisted) into
   * getRedacted so the frontend can auto-open the settings drawer.
   */
  private missingSettings: string[] = [];

  constructor(private configPath: string) {
    this.config = DEFAULT_CONFIG;
  }

  /** Load config from disk, merging with defaults for missing fields. */
  load(): AppConfig {
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Extract any legacy `llm[]` before the merge so it never lands back in
      // AppConfig (which no longer declares it). Backfill stable ids — the DB
      // migration + key reconcile match by id, so every provider needs one.
      if (Array.isArray(parsed.llm)) {
        this.legacyLlm = (parsed.llm as LlmProvider[]).map((p) => ({
          ...p,
          id: p.id || globalThis.crypto.randomUUID(),
        }));
      }
      delete parsed.llm;
      migrateWorldStyle(parsed);
      // Judge missing personalization fields against the RAW file (before the
      // default merge) — see computeMissingSettings for why raw, not merged.
      this.missingSettings = computeMissingSettings(parsed);
      this.config = deepMerge(DEFAULT_CONFIG, parsed);
    } catch {
      // File missing or malformed — genuine first run: every required field is
      // missing. Use defaults and persist to disk.
      this.missingSettings = computeMissingSettings(null);
      this.config = { ...DEFAULT_CONFIG };
      this.save(this.config as unknown as Record<string, unknown>);
    }
    return this.config;
  }

  /**
   * Hand off (once) any legacy LLM providers found in config.json on load, so
   * the server can migrate them into SQLite. Returns [] once consumed. The
   * caller should re-save the config afterwards to strip the stale `llm[]` key.
   */
  takeLegacyLlm(): LlmProvider[] {
    const out = this.legacyLlm;
    this.legacyLlm = [];
    return out;
  }

  /** Deep-merge partial update into current config, persist to disk. */
  save(partial: Record<string, unknown>): AppConfig {
    // `attributions` and `missingSettings` are GET-only injected fields (see
    // getRedacted); drop them so a client echoing back the full config can't
    // persist them into config.json.
    const { attributions: _attributions, missingSettings: _missingSettings, ...rest } = partial;
    this.config = deepMerge(this.config, rest);
    // Sparse leaves (map.worldOptions) must be replaced, not merged — a deep
    // merge can never remove a key, and removal is how a value goes back to
    // following the default.
    applyReplaceWholePaths(this.config, rest);
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    return this.config;
  }

  /** Return cached config (call load() first). */
  get(): AppConfig {
    return this.config;
  }

  /**
   * After a PATCH: drop any required personalization field the payload provides
   * from the missing list. Once nothing is missing, flag setupCompleted (and
   * persist) so we never prompt again — even if a later edit blanks a field or
   * a DEFAULT gets re-written to disk. No-op once setup is already complete.
   */
  markPatched(patch: Record<string, unknown>): void {
    if (this.config.setupCompleted) {
      this.missingSettings = [];
      return;
    }
    this.missingSettings = removeProvidedFromMissing(this.missingSettings, patch);
    if (this.missingSettings.length === 0) {
      this.save({ setupCompleted: true });
    }
  }

  /** Required personalization fields still missing (empty once setup is done). */
  getMissingSettings(): string[] {
    return this.missingSettings;
  }

  /**
   * Config for reading out to clients. LLM providers are no longer part of
   * config (they live in SQLite, served by /api/llm-providers); the only
   * injected field here is the static data-source attributions.
   */
  getRedacted(): AppConfig {
    return {
      ...this.config,
      // Static credit lines for the map/terrain/weather data sources. Injected
      // here (never persisted) so the frontend can render them; a PATCH that
      // echoes this back is ignored — see save().
      attributions: DATA_ATTRIBUTIONS,
      // First-run personalization fields still missing — the frontend uses this
      // to auto-open the settings drawer. Injected, never persisted.
      missingSettings: this.missingSettings,
    };
  }
}
