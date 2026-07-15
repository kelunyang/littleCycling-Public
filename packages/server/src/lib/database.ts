/**
 * SQLite database layer for ride history and sensor samples.
 * Uses better-sqlite3 (synchronous API).
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import dayjs from 'dayjs';
import type {
  Ride, RideSample, RideDayCount, ComparisonSample, ActivePlanState, PlanDayCompletion,
  DetectedSensor, LlmProvider, TrainingPlan, TrainingPlanSummary,
  AnalysisReport, AnalysisReportSummary, AnalysisFocus,
} from '@littlecycling/shared';
import { getHrZone, resampleTo1Hz } from '@littlecycling/shared';

/** 由課表名稱產生 URL/檔名友善的 slug（原 PlanStore 搬過來，供課表 id 用）。 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export interface CreateRideOpts {
  startedAt: number;
  routeId?: string;
  routeName?: string;
  /** Sensors active at the start of the ride; serialised to JSON in the DB. */
  sensors?: DetectedSensor[];
  /**
   * 訓練模式標記：workout profile id（如 'ftp_test'）或
   * `plan:<planId>:<day>`（課表訓練）。自由騎不帶（NULL）。
   */
  workoutId?: string;
}

/** listRides 查詢選項；全部選填，維持既有預設行為。 */
export interface ListRidesOpts {
  limit?: number;
  offset?: number;
  routeId?: string;
  /** 起始時間 ms（含）— started_at >= from。 */
  from?: number;
  /** 結束時間 ms（含）— started_at <= to。 */
  to?: number;
  /** true 時排除 0 距離 / 0 功率的空紀錄。 */
  excludeEmpty?: boolean;
  /**
   * 訓練模式過濾：'plan'（課表訓練）、'free'（自由騎）、
   * 或指定的 workout profile id（如 'ftp_test'）。
   */
  mode?: string;
}

export interface EndRideSummary {
  endedAt: number;
  durationMs: number;
  distanceM: number;
  avgPowerW?: number;
  avgHr?: number;
  avgCadence?: number;
  avgSpeed?: number;
  maxHr?: number;
  maxPowerW?: number;
  maxSpeed?: number;
  totalCoins?: number;
  totalLaps?: number;
  /** % of hr>0 time in Z2/Z3 (0-100, one decimal). Server-sim rides only. */
  zoneSustainPct?: number;
}

export interface InsertSampleOpts {
  elapsedMs: number;
  hr?: number;
  powerW?: number;
  cadence?: number;
  speedKmh?: number;
}

export class RideDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
    this.recoverOrphanRides();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rides (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        duration_ms   INTEGER,
        distance_m    REAL DEFAULT 0,
        avg_power_w   REAL,
        avg_hr        REAL,
        avg_cadence   REAL,
        avg_speed     REAL,
        max_hr        INTEGER,
        max_power_w   REAL,
        max_speed     REAL,
        total_coins   INTEGER DEFAULT 0,
        total_laps    INTEGER DEFAULT 0,
        route_id      TEXT,
        route_name    TEXT,
        notes         TEXT
      );

      CREATE TABLE IF NOT EXISTS ride_samples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        elapsed_ms INTEGER NOT NULL,
        hr         INTEGER,
        power_w    REAL,
        cadence    REAL,
        speed_kmh  REAL
      );

      CREATE INDEX IF NOT EXISTS idx_samples_ride_elapsed
        ON ride_samples(ride_id, elapsed_ms);

      CREATE TABLE IF NOT EXISTS message_variants (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id   TEXT NOT NULL,
        template  TEXT NOT NULL,
        UNIQUE(type_id, template)
      );

      CREATE INDEX IF NOT EXISTS idx_msg_type
        ON message_variants(type_id);

      -- Training plan active state (supports multiple active plans)
      CREATE TABLE IF NOT EXISTS active_plans (
        plan_id     TEXT PRIMARY KEY,
        start_date  TEXT NOT NULL
      );

      -- Training plan day completions
      CREATE TABLE IF NOT EXISTS plan_completions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id       TEXT NOT NULL,
        day           INTEGER NOT NULL,
        ride_id       INTEGER REFERENCES rides(id) ON DELETE SET NULL,
        completed_at  INTEGER NOT NULL,
        manual        INTEGER NOT NULL DEFAULT 0,
        UNIQUE(plan_id, day)
      );

      -- LLM provider settings (moved out of config.json so plaintext API keys
      -- live only in SQLite). sort_order preserves the original array order so
      -- the "llmIndex" used by the plan/analysis APIs stays stable.
      CREATE TABLE IF NOT EXISTS llm_providers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        key         TEXT NOT NULL DEFAULT '',
        endpoint    TEXT NOT NULL DEFAULT '',
        model       TEXT NOT NULL DEFAULT '',
        enabled     INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0
      );

      -- Training plans (課表本體；原本存 data/plans/*.json，改存 SQLite).
      -- weeks_json 整包 JSON：全 repo 不查 weeks 內部，課表一律整份讀寫。
      CREATE TABLE IF NOT EXISTS plans (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        total_days  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        source      TEXT NOT NULL DEFAULT 'manual',
        weeks_json  TEXT NOT NULL
      );

      -- LLM 訓練分析報告（markdown 內容，供前端瀏覽/刪除歷史）.
      CREATE TABLE IF NOT EXISTS analysis_reports (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at     INTEGER NOT NULL,
        focus          TEXT NOT NULL DEFAULT 'review',
        question       TEXT,
        content        TEXT NOT NULL,
        provider_name  TEXT NOT NULL DEFAULT '',
        provider_model TEXT NOT NULL DEFAULT '',
        ride_ids       TEXT
      );
    `);

    this.runMigrations();
  }

  /**
   * Idempotent column-level migrations for existing databases.
   * `CREATE TABLE IF NOT EXISTS` does not add new columns to a pre-existing
   * table, so additive schema changes go here.
   */
  private runMigrations(): void {
    const cols = this.db.prepare(`PRAGMA table_info(rides)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'sensors')) {
      this.db.exec(`ALTER TABLE rides ADD COLUMN sensors TEXT`);
    }
    if (!cols.some((c) => c.name === 'total_laps')) {
      this.db.exec(`ALTER TABLE rides ADD COLUMN total_laps INTEGER DEFAULT 0`);
    }
    if (!cols.some((c) => c.name === 'zone_sustain_pct')) {
      this.db.exec(`ALTER TABLE rides ADD COLUMN zone_sustain_pct REAL`);
    }
    if (!cols.some((c) => c.name === 'workout_id')) {
      this.db.exec(`ALTER TABLE rides ADD COLUMN workout_id TEXT`);
    }
    if (!cols.some((c) => c.name === 'rpe')) {
      // 騎後自覺強度 RPE 1-5（Strava「你的感受」概念）；追加式遷移。
      this.db.exec(`ALTER TABLE rides ADD COLUMN rpe INTEGER`);
    }

    // analysis_reports.ride_ids — 額外 guard：CREATE TABLE 已含此欄，但若 user
    // 之前已在 Windows 建出舊表（無此欄），CREATE TABLE IF NOT EXISTS 不會補欄，
    // 故在此追加式補上。init() 先建表、才呼叫 runMigrations，表必存在。
    const reportCols = this.db.prepare(`PRAGMA table_info(analysis_reports)`).all() as { name: string }[];
    if (!reportCols.some((c) => c.name === 'ride_ids')) {
      this.db.exec(`ALTER TABLE analysis_reports ADD COLUMN ride_ids TEXT`);
    }
  }

  /**
   * Finalise any ride that still has `ended_at = NULL` at startup. These are
   * "orphans" — recordings that were interrupted by a hard process exit
   * (force-kill, power loss, uncaught exception) before stopRecording could
   * fire. The samples table is intact, so we can rebuild the summary from
   * it. Rides with no samples at all are deleted, since they have no
   * recoverable signal.
   */
  private recoverOrphanRides(): void {
    const orphans = this.db.prepare(
      `SELECT id, started_at FROM rides WHERE ended_at IS NULL`,
    ).all() as { id: number; started_at: number }[];
    if (orphans.length === 0) return;

    for (const ride of orphans) {
      const samples = this.db.prepare(
        `SELECT elapsed_ms, hr, power_w, cadence, speed_kmh
         FROM ride_samples WHERE ride_id = ? ORDER BY elapsed_ms`,
      ).all(ride.id) as {
        elapsed_ms: number;
        hr: number | null;
        power_w: number | null;
        cadence: number | null;
        speed_kmh: number | null;
      }[];

      if (samples.length === 0) {
        this.db.prepare(`DELETE FROM rides WHERE id = ?`).run(ride.id);
        console.log(`[db] dropped empty orphan ride ${ride.id}`);
        continue;
      }

      let hrSum = 0, hrCount = 0, hrMax = 0;
      let pwrSum = 0, pwrCount = 0, pwrMax = 0;
      let cadSum = 0, cadCount = 0;
      let spdSum = 0, spdCount = 0, spdMax = 0;
      let distanceM = 0;
      let lastT = 0;
      let lastSpeed = 0;
      for (const s of samples) {
        if (s.hr != null) {
          hrSum += s.hr; hrCount++;
          if (s.hr > hrMax) hrMax = s.hr;
        }
        if (s.power_w != null) {
          pwrSum += s.power_w; pwrCount++;
          if (s.power_w > pwrMax) pwrMax = s.power_w;
        }
        if (s.cadence != null) {
          cadSum += s.cadence; cadCount++;
        }
        if (s.speed_kmh != null) {
          spdSum += s.speed_kmh; spdCount++;
          if (s.speed_kmh > spdMax) spdMax = s.speed_kmh;
        }
        // Integrate distance using last-known speed across the interval —
        // matches the live recorder's left-Riemann approach so recovered
        // and live-finalised rides are computed the same way.
        if (lastT > 0) {
          const dtH = (s.elapsed_ms - lastT) / 3_600_000;
          distanceM += lastSpeed * dtH * 1000;
        }
        lastT = s.elapsed_ms;
        if (s.speed_kmh != null) lastSpeed = s.speed_kmh;
      }

      const lastElapsedMs = samples[samples.length - 1].elapsed_ms;
      this.endRide(ride.id, {
        endedAt: ride.started_at + lastElapsedMs,
        durationMs: lastElapsedMs,
        distanceM: Math.round(distanceM),
        avgHr: hrCount > 0 ? hrSum / hrCount : undefined,
        maxHr: hrMax > 0 ? hrMax : undefined,
        avgPowerW: pwrCount > 0 ? pwrSum / pwrCount : undefined,
        maxPowerW: pwrMax > 0 ? pwrMax : undefined,
        avgCadence: cadCount > 0 ? cadSum / cadCount : undefined,
        avgSpeed: spdCount > 0 ? spdSum / spdCount : undefined,
        maxSpeed: spdMax > 0 ? spdMax : undefined,
      });
      console.log(
        `[db] recovered orphan ride ${ride.id}: ${(lastElapsedMs / 1000).toFixed(1)}s, ${samples.length} samples`,
      );
    }
  }

  // ── Rides CRUD ──

  createRide(opts: CreateRideOpts): number {
    const stmt = this.db.prepare(`
      INSERT INTO rides (started_at, route_id, route_name, sensors, workout_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const sensorsJson = opts.sensors && opts.sensors.length > 0
      ? JSON.stringify(opts.sensors)
      : null;
    const result = stmt.run(
      opts.startedAt,
      opts.routeId ?? null,
      opts.routeName ?? null,
      sensorsJson,
      opts.workoutId ?? null,
    );
    return result.lastInsertRowid as number;
  }

  endRide(rideId: number, summary: EndRideSummary): void {
    const stmt = this.db.prepare(`
      UPDATE rides SET
        ended_at    = ?,
        duration_ms = ?,
        distance_m  = ?,
        avg_power_w = ?,
        avg_hr      = ?,
        avg_cadence = ?,
        avg_speed   = ?,
        max_hr      = ?,
        max_power_w = ?,
        max_speed   = ?,
        total_coins = ?,
        total_laps  = ?,
        zone_sustain_pct = ?
      WHERE id = ?
    `);
    stmt.run(
      summary.endedAt,
      summary.durationMs,
      summary.distanceM,
      summary.avgPowerW ?? null,
      summary.avgHr ?? null,
      summary.avgCadence ?? null,
      summary.avgSpeed ?? null,
      summary.maxHr ?? null,
      summary.maxPowerW ?? null,
      summary.maxSpeed ?? null,
      summary.totalCoins ?? 0,
      summary.totalLaps ?? 0,
      summary.zoneSustainPct ?? null,
      rideId,
    );
  }

  getRide(id: number): Ride | undefined {
    const row = this.db.prepare('SELECT * FROM rides WHERE id = ?').get(id) as any;
    return row ? this.mapRide(row) : undefined;
  }

  /**
   * 列出騎乘（分頁 + 過濾）。LEFT JOIN plan_completions 把課表連結
   * （planId/planDay）順帶填回每筆 ride，並支援日期區間、模式與 0km/0W 過濾。
   */
  listRides(opts: ListRidesOpts = {}): Ride[] {
    const { limit = 20, offset = 0, routeId, from, to, excludeEmpty, mode } = opts;

    const where: string[] = [];
    const params: unknown[] = [];

    if (routeId) {
      where.push('rides.route_id = ?');
      params.push(routeId);
    }
    if (from != null) {
      where.push('rides.started_at >= ?');
      params.push(from);
    }
    if (to != null) {
      where.push('rides.started_at <= ?');
      params.push(to);
    }
    if (excludeEmpty) {
      where.push('rides.distance_m > 0 AND COALESCE(rides.avg_power_w, 0) > 0');
    }
    if (mode === 'plan') {
      // 課表訓練：workout_id 以 plan: 開頭，或有 plan_completions 連結（舊紀錄）。
      where.push(`(rides.workout_id LIKE 'plan:%' OR pc.ride_id IS NOT NULL)`);
    } else if (mode === 'free') {
      // 自由騎：無 workout_id 且無課表連結。
      where.push('rides.workout_id IS NULL AND pc.ride_id IS NULL');
    } else if (mode) {
      // 指定 workout profile id。
      where.push('rides.workout_id = ?');
      params.push(mode);
    }

    let sql = `
      SELECT rides.*, pc.plan_id AS pc_plan_id, pc.day AS pc_day
      FROM rides
      LEFT JOIN plan_completions pc ON pc.ride_id = rides.id
    `;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    // GROUP BY 避免一筆 ride 對多個課表連結時被複製成多列。
    sql += ' GROUP BY rides.id ORDER BY rides.started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapRide(r));
  }

  deleteRide(id: number): boolean {
    const result = this.db.prepare('DELETE FROM rides WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 更新騎後回饋（部分更新）：rpe（1-5）與 / 或 notes。兩者皆選填，但至少要帶
   * 一個欄位。回傳是否有更新到列（false = 找不到該 ride 或未帶任何欄位）。
   */
  updateRideFeedback(id: number, patch: { rpe?: number; notes?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.rpe !== undefined) {
      sets.push('rpe = ?');
      params.push(patch.rpe);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      params.push(patch.notes);
    }
    if (sets.length === 0) return false;
    params.push(id);
    const result = this.db.prepare(`UPDATE rides SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return result.changes > 0;
  }

  // ── Samples ──

  private _insertSampleStmt: BetterSqlite3.Statement | null = null;

  private get insertSampleStmt(): BetterSqlite3.Statement {
    if (!this._insertSampleStmt) {
      this._insertSampleStmt = this.db.prepare(`
        INSERT INTO ride_samples (ride_id, elapsed_ms, hr, power_w, cadence, speed_kmh)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    }
    return this._insertSampleStmt;
  }

  insertSample(rideId: number, sample: InsertSampleOpts): void {
    this.insertSampleStmt.run(
      rideId,
      sample.elapsedMs,
      sample.hr ?? null,
      sample.powerW ?? null,
      sample.cadence ?? null,
      sample.speedKmh ?? null,
    );
  }

  getComparisonWindow(rideId: number, fromMs: number, toMs: number): ComparisonSample[] {
    const rows = this.db.prepare(`
      SELECT elapsed_ms, hr, power_w, cadence, speed_kmh
      FROM ride_samples
      WHERE ride_id = ? AND elapsed_ms >= ? AND elapsed_ms <= ?
      ORDER BY elapsed_ms
    `).all(rideId, fromMs, toMs) as any[];

    return rows.map((r) => ({
      elapsedMs: r.elapsed_ms,
      hr: r.hr ?? undefined,
      speed: r.speed_kmh ?? undefined,
      cadence: r.cadence ?? undefined,
      power: r.power_w ?? undefined,
    }));
  }

  getSamplesForExport(rideId: number): RideSample[] {
    const rows = this.db.prepare(`
      SELECT elapsed_ms, hr, power_w, cadence, speed_kmh
      FROM ride_samples
      WHERE ride_id = ?
      ORDER BY elapsed_ms
    `).all(rideId) as any[];

    return rows.map((r) => ({
      elapsedMs: r.elapsed_ms,
      hr: r.hr ?? undefined,
      powerW: r.power_w ?? undefined,
      cadence: r.cadence ?? undefined,
      speedKmh: r.speed_kmh ?? undefined,
    }));
  }

  getSampleCount(rideId: number): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM ride_samples WHERE ride_id = ?'
    ).get(rideId) as any;
    return row.cnt;
  }

  /**
   * Best continuous 20-minute average power for a ride (watts), used to
   * estimate FTP after an FTP-test workout (FTP ≈ best20min × 0.95).
   *
   * Samples are event-driven and unevenly spaced, so power is treated as
   * piecewise-constant (carry-forward) and resampled onto a 1-second grid
   * before a rolling 20-minute (1200 s) window is slid across the ride.
   *
   * @returns Best 20-min avg watts, or null if the ride is shorter than
   *          20 minutes or has no usable power samples.
   */
  getBest20MinAvgPower(rideId: number): number | null {
    const WINDOW_SEC = 20 * 60; // 1200
    const samples = this.getSamplesForExport(rideId); // sorted by elapsed_ms
    if (samples.length === 0) return null;

    // Resample power onto a 1 Hz grid via carry-forward (shared helper — the
    // same手法原本內嵌於此，抽到 ride-metrics.resampleTo1Hz 共用，行為不變).
    const { totalSec, power: grid } = resampleTo1Hz(samples);
    if (totalSec < WINDOW_SEC) return null; // not enough ride to hold a window

    // Rolling sum over WINDOW_SEC seconds; track the best average.
    let windowSum = 0;
    for (let t = 0; t < WINDOW_SEC; t++) windowSum += grid[t];
    let best = windowSum;
    for (let t = WINDOW_SEC; t <= totalSec; t++) {
      windowSum += grid[t] - grid[t - WINDOW_SEC];
      if (windowSum > best) best = windowSum;
    }

    const avg = best / WINDOW_SEC;
    return avg > 0 ? Math.round(avg) : null;
  }

  // ── Calendar queries ──

  getRideCountsByDateRange(fromTs: number, toTs: number, excludeEmpty = false): RideDayCount[] {
    const emptyClause = excludeEmpty
      ? ' AND distance_m > 0 AND COALESCE(avg_power_w, 0) > 0'
      : '';
    const rows = this.db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count
      FROM rides
      WHERE started_at >= ? AND started_at < ?${emptyClause}
      GROUP BY date
      ORDER BY date
    `).all(fromTs, toTs) as any[];

    return rows.map((r) => ({
      date: r.date as string,
      count: r.count as number,
    }));
  }

  getRidesByDate(dateStr: string, excludeEmpty = false): Ride[] {
    const emptyClause = excludeEmpty
      ? ' AND distance_m > 0 AND COALESCE(avg_power_w, 0) > 0'
      : '';
    const rows = this.db.prepare(`
      SELECT * FROM rides
      WHERE date(started_at / 1000, 'unixepoch', 'localtime') = ?${emptyClause}
      ORDER BY started_at DESC
    `).all(dateStr) as any[];

    return rows.map((r) => this.mapRide(r));
  }

  // ── PB (Personal Best) ──

  getBestRideForRoute(routeId: string, hrMax: number): { ride: Ride; zoneSustainPct: number } | null {
    // Get the best ride by avg power for this route
    const row = this.db.prepare(`
      SELECT * FROM rides
      WHERE route_id = ? AND avg_power_w IS NOT NULL
      ORDER BY avg_power_w DESC
      LIMIT 1
    `).get(routeId) as any;

    if (!row) return null;

    const ride = this.mapRide(row);

    // Calculate Z2+Z3 sustain from samples
    const samples = this.getSamplesForExport(ride.id);
    let hrTotalTicks = 0;
    let zoneSustainTicks = 0;

    for (const s of samples) {
      if (s.hr == null || s.hr <= 0) continue;
      hrTotalTicks++;
      const zone = getHrZone(s.hr, hrMax);
      if (zone && (zone.zone === 2 || zone.zone === 3)) {
        zoneSustainTicks++;
      }
    }

    const zoneSustainPct = hrTotalTicks > 0
      ? Math.round((zoneSustainTicks / hrTotalTicks) * 1000) / 10
      : 0;

    return { ride, zoneSustainPct };
  }

  // ── Helpers ──

  private mapRide(row: any): Ride {
    let sensors: DetectedSensor[] | undefined;
    if (row.sensors) {
      try {
        const parsed = JSON.parse(row.sensors);
        if (Array.isArray(parsed) && parsed.length > 0) sensors = parsed;
      } catch {
        // Ignore corrupt rows; legacy rides simply have no sensor info.
      }
    }
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      distanceM: row.distance_m ?? 0,
      avgPowerW: row.avg_power_w ?? undefined,
      avgHr: row.avg_hr ?? undefined,
      avgCadence: row.avg_cadence ?? undefined,
      avgSpeed: row.avg_speed ?? undefined,
      maxHr: row.max_hr ?? undefined,
      maxPowerW: row.max_power_w ?? undefined,
      maxSpeed: row.max_speed ?? undefined,
      totalCoins: row.total_coins ?? 0,
      totalLaps: row.total_laps ?? 0,
      zoneSustainPct: row.zone_sustain_pct ?? undefined,
      routeId: row.route_id ?? undefined,
      routeName: row.route_name ?? undefined,
      notes: row.notes ?? undefined,
      rpe: row.rpe ?? undefined,
      sensors,
      workoutId: row.workout_id ?? undefined,
      // planId/planDay 僅 listRides 的 LEFT JOIN 會帶回 pc_* 別名；其餘查詢為 undefined。
      planId: row.pc_plan_id ?? undefined,
      planDay: row.pc_day ?? undefined,
    };
  }

  // ── Message variants ──

  upsertMessageVariants(typeId: string, templates: string[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO message_variants (type_id, template) VALUES (?, ?)',
    );
    const tx = this.db.transaction((items: string[]) => {
      for (const t of items) insert.run(typeId, t);
    });
    tx(templates);
  }

  getRandomVariant(typeId: string): string | null {
    const row = this.db.prepare(
      'SELECT template FROM message_variants WHERE type_id = ? ORDER BY RANDOM() LIMIT 1',
    ).get(typeId) as { template: string } | undefined;
    return row?.template ?? null;
  }

  getVariants(typeId: string): { id: number; template: string }[] {
    return this.db.prepare(
      'SELECT id, template FROM message_variants WHERE type_id = ? ORDER BY id',
    ).all(typeId) as { id: number; template: string }[];
  }

  deleteVariants(typeId: string): number {
    const result = this.db.prepare(
      'DELETE FROM message_variants WHERE type_id = ?',
    ).run(typeId);
    return result.changes;
  }

  getVariantCounts(): { typeId: string; count: number }[] {
    const rows = this.db.prepare(
      'SELECT type_id, COUNT(*) as count FROM message_variants GROUP BY type_id',
    ).all() as { type_id: string; count: number }[];
    return rows.map((r) => ({ typeId: r.type_id, count: r.count }));
  }

  getBatchRandomVariants(): Record<string, string> {
    const result: Record<string, string> = {};
    const types = this.db.prepare(
      'SELECT DISTINCT type_id FROM message_variants',
    ).all() as { type_id: string }[];

    for (const { type_id } of types) {
      const variant = this.getRandomVariant(type_id);
      if (variant) result[type_id] = variant;
    }
    return result;
  }

  // ── Training plan active state ──

  addActivePlan(planId: string, startDate: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO active_plans (plan_id, start_date) VALUES (?, ?)',
    ).run(planId, startDate);
  }

  getActivePlans(): ActivePlanState[] {
    const rows = this.db.prepare('SELECT plan_id, start_date FROM active_plans').all() as any[];
    return rows.map((r) => ({ planId: r.plan_id, startDate: r.start_date }));
  }

  removeActivePlan(planId: string): boolean {
    const result = this.db.prepare('DELETE FROM active_plans WHERE plan_id = ?').run(planId);
    return result.changes > 0;
  }

  // ── Training plan completions ──

  recordCompletion(planId: string, day: number, rideId: number | null, manual: boolean): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO plan_completions (plan_id, day, ride_id, completed_at, manual)
      VALUES (?, ?, ?, ?, ?)
    `).run(planId, day, rideId, Date.now(), manual ? 1 : 0);
  }

  getCompletions(planId: string): PlanDayCompletion[] {
    const rows = this.db.prepare(
      'SELECT plan_id, day, ride_id, completed_at, manual FROM plan_completions WHERE plan_id = ? ORDER BY day',
    ).all(planId) as any[];
    return rows.map((r) => ({
      planId: r.plan_id,
      day: r.day,
      rideId: r.ride_id ?? null,
      completedAt: r.completed_at,
      manual: r.manual === 1,
    }));
  }

  getCompletion(planId: string, day: number): PlanDayCompletion | null {
    const row = this.db.prepare(
      'SELECT plan_id, day, ride_id, completed_at, manual FROM plan_completions WHERE plan_id = ? AND day = ?',
    ).get(planId, day) as any;
    if (!row) return null;
    return {
      planId: row.plan_id,
      day: row.day,
      rideId: row.ride_id ?? null,
      completedAt: row.completed_at,
      manual: row.manual === 1,
    };
  }

  // ── LLM providers ──
  // 整組覆蓋（replace-all）是刻意的：PUT /api/llm-providers 一次帶完整清單，
  // sort_order 直接用陣列 index 重寫，語意最單純、也不會殘留被刪掉的舊列。

  /** 依 sort_order 回傳所有 LLM provider（含明碼 key，僅供後端內部呼叫）。 */
  listLlmProviders(): LlmProvider[] {
    const rows = this.db.prepare(
      'SELECT id, name, key, endpoint, model, enabled FROM llm_providers ORDER BY sort_order',
    ).all() as {
      id: string; name: string; key: string; endpoint: string; model: string; enabled: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      key: r.key,
      endpoint: r.endpoint,
      model: r.model,
      enabled: r.enabled === 1,
    }));
  }

  /** 目前儲存的 provider 數量（搬遷判斷「DB 是否為空」用）。 */
  countLlmProviders(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM llm_providers').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * 以整組陣列覆蓋所有 LLM provider（原子交易）：先清空再依序插入，
   * sort_order = 陣列 index，藉此保留原順序。
   */
  replaceLlmProviders(providers: LlmProvider[]): void {
    const del = this.db.prepare('DELETE FROM llm_providers');
    const ins = this.db.prepare(`
      INSERT INTO llm_providers (id, name, key, endpoint, model, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: LlmProvider[]) => {
      del.run();
      items.forEach((p, i) => {
        ins.run(p.id, p.name, p.key, p.endpoint, p.model, p.enabled ? 1 : 0, i);
      });
    });
    tx(providers);
  }

  // ── Training plans ──
  // 課表本體改存 SQLite（原 PlanStore 的 JSON 檔）；weeks 一律整份讀寫。

  /** 列出所有課表（不含 weeks），依建立時間新到舊排序。 */
  listPlans(): TrainingPlanSummary[] {
    const rows = this.db.prepare(
      `SELECT id, name, description, total_days, created_at, source
       FROM plans ORDER BY created_at DESC`,
    ).all() as {
      id: string; name: string; description: string;
      total_days: number; created_at: number; source: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      totalDays: r.total_days,
      createdAt: r.created_at,
      source: r.source as TrainingPlan['source'],
    }));
  }

  /** 取單一課表（含 weeks）；weeks_json 壞掉回 null。 */
  getPlan(id: string): TrainingPlan | null {
    const row = this.db.prepare(
      `SELECT id, name, description, total_days, created_at, source, weeks_json
       FROM plans WHERE id = ?`,
    ).get(id) as {
      id: string; name: string; description: string; total_days: number;
      created_at: number; source: string; weeks_json: string;
    } | undefined;
    if (!row) return null;
    try {
      const weeks = JSON.parse(row.weeks_json) as TrainingPlan['weeks'];
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        totalDays: row.total_days,
        createdAt: row.created_at,
        source: row.source as TrainingPlan['source'],
        weeks,
      };
    } catch {
      // weeks_json 損毀 → 視為讀不到，回 null。
      return null;
    }
  }

  /** 建立課表。id 沿用 `slugify(name)-YYYYMMDDHHmmss`，createdAt 為現在。 */
  createPlan(plan: Omit<TrainingPlan, 'id' | 'createdAt'>): TrainingPlan {
    const id = `${slugify(plan.name)}-${dayjs().format('YYYYMMDDHHmmss')}`;
    const full: TrainingPlan = { ...plan, id, createdAt: Date.now() };
    this.db.prepare(
      `INSERT INTO plans (id, name, description, total_days, created_at, source, weeks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      full.id,
      full.name,
      full.description,
      full.totalDays,
      full.createdAt,
      full.source,
      JSON.stringify(full.weeks),
    );
    return full;
  }

  /** 刪除課表。回傳是否刪到列。 */
  deletePlan(id: string): boolean {
    const result = this.db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 遷移用：保留原 id / createdAt 插入課表；id 已存在則不動（DB 內容優先）。
   * 回傳是否真的插入（false = 已存在被略過）。
   */
  insertPlanIfAbsent(plan: TrainingPlan): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO plans (id, name, description, total_days, created_at, source, weeks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.name,
      plan.description ?? '',
      plan.totalDays,
      plan.createdAt,
      plan.source ?? 'manual',
      JSON.stringify(plan.weeks),
    );
    return result.changes > 0;
  }

  // ── Analysis reports ──

  /** 建立一份分析報告，回傳自增 id。 */
  createAnalysisReport(report: Omit<AnalysisReport, 'id' | 'createdAt'>): number {
    const result = this.db.prepare(
      `INSERT INTO analysis_reports
        (created_at, focus, question, content, provider_name, provider_model, ride_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      report.focus,
      report.question ?? null,
      report.content,
      report.providerName,
      report.providerModel,
      report.rideIds && report.rideIds.length > 0 ? JSON.stringify(report.rideIds) : null,
    );
    return result.lastInsertRowid as number;
  }

  /** ride_ids 文字欄 → number[]；壞掉回 undefined（容忍舊/損毀資料）。 */
  private parseRideIds(raw: string | null): number[] | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as number[];
    } catch {
      // 忽略損毀列：視為未指定騎乘。
    }
    return undefined;
  }

  /** 列出所有分析報告摘要（不含 content），新到舊排序。 */
  listAnalysisReports(): AnalysisReportSummary[] {
    const rows = this.db.prepare(
      `SELECT id, created_at, focus, question, provider_name, provider_model, ride_ids
       FROM analysis_reports ORDER BY created_at DESC`,
    ).all() as {
      id: number; created_at: number; focus: string; question: string | null;
      provider_name: string; provider_model: string; ride_ids: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      focus: r.focus as AnalysisFocus,
      question: r.question ?? undefined,
      providerName: r.provider_name,
      providerModel: r.provider_model,
      rideIds: this.parseRideIds(r.ride_ids),
    }));
  }

  /** 取單一分析報告（含 content）；不存在回 null。 */
  getAnalysisReport(id: number): AnalysisReport | null {
    const row = this.db.prepare(
      `SELECT id, created_at, focus, question, content, provider_name, provider_model, ride_ids
       FROM analysis_reports WHERE id = ?`,
    ).get(id) as {
      id: number; created_at: number; focus: string; question: string | null;
      content: string; provider_name: string; provider_model: string; ride_ids: string | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      focus: row.focus as AnalysisFocus,
      question: row.question ?? undefined,
      content: row.content,
      providerName: row.provider_name,
      providerModel: row.provider_model,
      rideIds: this.parseRideIds(row.ride_ids),
    };
  }

  /** 刪除分析報告。回傳是否刪到列。 */
  deleteAnalysisReport(id: number): boolean {
    const result = this.db.prepare('DELETE FROM analysis_reports WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
