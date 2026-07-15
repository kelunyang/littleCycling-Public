/**
 * Application config type definition and defaults.
 * Persisted in data/config.json, editable via the settings page.
 */

import type { DataSourceAttribution } from './attributions.js';

/**
 * LLM provider configuration (OpenAI-compatible endpoints).
 *
 * NOTE: providers are NO LONGER stored in config.json / AppConfig — they live
 * in SQLite (table `llm_providers`) and are read/written via the
 * `/api/llm-providers` endpoints. This type is still the shared shape used by
 * that API, the DB layer and the settings UI. Legacy config.json `llm[]` arrays
 * are migrated into SQLite once on server startup.
 */
export interface LlmProvider {
  id: string;                // stable id — used to preserve the stored key across edits
  name: string;              // display name, e.g. 'DeepSeek'
  key: string;               // API key
  endpoint: string;          // base URL, e.g. 'https://api.deepseek.com/v1'
  model: string;             // model ID, e.g. 'deepseek-chat'
  enabled: boolean;          // whether this provider is active
  /**
   * Transient, GET-only flag: signals whether a key is stored, WITHOUT
   * exposing the value. Set by the server's redacted config read; never
   * persisted to data/config.json.
   */
  hasKey?: boolean;
}

/**
 * Update-check status — computed by the server (git HEAD vs the public repo's
 * latest commit) and persisted into config.json. The frontend only reads this
 * to decide whether to show a "git pull" reminder; it never sets it.
 */
export interface UpdateStatus {
  localHash: string | null;   // running checkout's HEAD (full sha)
  localDate: number | null;   // local HEAD commit time (ms)
  remoteHash: string | null;  // public repo's latest commit sha
  remoteDate: number | null;  // public latest commit time (ms)
  remoteUrl: string | null;   // link shown in the update prompt
  updateAvailable: boolean;
  checkedAt: number | null;   // when the check last completed (ms)
}

export interface AppConfig {
  sensor: {
    wheelCircumference: number;  // meters
    trainerModel: string;        // key in POWER_CURVES
  };
  training: {
    defaultDuration: number;     // ms
    hrMax: number;               // bpm
    ftp: number;                 // watts
    /**
     * Optional age (years). When set, the settings UI derives hrMax from it
     * via the Tanaka formula (hrMaxFromAge). hrMax stays independently
     * editable, so a rider who knows their measured max can override it.
     */
    age?: number;
    /**
     * Optional rider weight (kg). Enables W/kg and more accurate load metrics
     * in the AI coach analysis; absent → those metrics are skipped.
     */
    weightKg?: number;
  };
  server: {
    wsPort: number;
  };
  map: {
    basemapStyle: string;
    renderMode: 'maplibre' | 'threejs' | 'phaser';
    /**
     * World visual style — spans all render modes (Phaser 2D + Three.js 3D).
     * `plastic` → neon/blocks; `cuphead` → hand-drawn/corrugated paper.
     * (Renamed from the former `phaserStyle`; old config.json values are
     * migrated on load — see ConfigStore.load in the server.)
     */
    worldStyle: 'plastic' | 'cuphead';
    cameraHeight: number;    // 1-30m, camera height above ground
    cameraPitch: number;     // 1-60°, downward pitch angle
    cameraLookAhead: number; // 10-200m, look-ahead distance
    viewRange: number;       // 100-1000, corridor half-width in meters
    dayNightEnabled: boolean; // real-time day/night cycle based on route location
  };
  sound: {
    enabled: boolean;  // master sound on/off toggle
  };
  recording: {
    /**
     * Persist raw sensor frames to data/sessions/ride-{id}-{ts}.jsonl.
     * Required if you ever want to replay or repair a ride from raw
     * frames (e.g. after fixing a parser bug). Default on; turn off to
     * save disk if you don't need the audit trail.
     */
    persistRawFrames: boolean;
  };
  debug: boolean; // enable verbose console logging for terrain, MVT, weather, etc.
  /** Server-managed update-check result; the frontend reads it, never writes it. */
  update: UpdateStatus;
  /**
   * True once the rider has completed first-run personalization (all required
   * fields filled). Persisted in config.json. Because save() re-writes the full
   * deep-merged config, DEFAULT values for hrMax/ftp/sensor always end up on
   * disk and can't tell "user set" from "default" — this flag is the reliable
   * "setup done, never prompt again" signal. Set by the server after a PATCH
   * that leaves no required field missing; never written by the frontend.
   */
  setupCompleted?: boolean;
  /**
   * Static attribution notices for the map / terrain / weather data sources.
   * Server-injected on the redacted GET read (never persisted); the frontend
   * only renders it. See DATA_ATTRIBUTIONS in attributions.ts.
   */
  attributions?: DataSourceAttribution[];
  /**
   * Required personalization fields still missing from config.json on first
   * use (e.g. `['training.age']`). Server-injected on the redacted GET read and
   * refreshed on every PATCH response (never persisted); the frontend reads it
   * to auto-open the settings drawer and highlight the fields. Empty once setup
   * is complete. See ConfigStore.computeMissingSettings in the server.
   */
  missingSettings?: string[];
}

export const DEFAULT_CONFIG: AppConfig = {
  sensor: {
    wheelCircumference: 2.105,
    trainerModel: 'generic-fluid',
  },
  training: {
    defaultDuration: 30 * 60 * 1000, // 30 minutes
    hrMax: 190,
    ftp: 200,
  },
  server: {
    wsPort: 8765,
  },
  map: {
    basemapStyle: 'liberty',
    renderMode: 'threejs',
    worldStyle: 'plastic',
    cameraHeight: 15,
    cameraPitch: 12,
    cameraLookAhead: 80,
    viewRange: 500,
    dayNightEnabled: true,
  },
  sound: {
    enabled: true,
  },
  recording: {
    persistRawFrames: true,
  },
  setupCompleted: false,
  debug: false,
  update: {
    localHash: null,
    localDate: null,
    remoteHash: null,
    remoteDate: null,
    remoteUrl: null,
    updateAvailable: false,
    checkedAt: null,
  },
};
