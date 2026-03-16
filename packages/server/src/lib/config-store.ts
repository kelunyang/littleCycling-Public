/**
 * Config persistence — reads/writes data/config.json.
 * Deep-merges with DEFAULT_CONFIG so missing fields are always filled.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '@littlecycling/shared';

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

export class ConfigStore {
  private config: AppConfig;

  constructor(private configPath: string) {
    this.config = DEFAULT_CONFIG;
  }

  /** Load config from disk, merging with defaults for missing fields. */
  load(): AppConfig {
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.config = deepMerge(DEFAULT_CONFIG, parsed);
    } catch {
      // File missing or malformed — use defaults and persist to disk
      this.config = { ...DEFAULT_CONFIG };
      this.save(this.config as unknown as Record<string, unknown>);
    }
    return this.config;
  }

  /** Deep-merge partial update into current config, persist to disk. */
  save(partial: Record<string, unknown>): AppConfig {
    this.config = deepMerge(this.config, partial);
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    return this.config;
  }

  /** Return cached config (call load() first). */
  get(): AppConfig {
    return this.config;
  }
}
