/**
 * SQLite database layer for ride history and sensor samples.
 * Uses better-sqlite3 (synchronous API).
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Ride, RideSample, RideDayCount, ComparisonSample } from '@littlecycling/shared';
import { getHrZone } from '@littlecycling/shared';

export interface CreateRideOpts {
  startedAt: number;
  routeId?: string;
  routeName?: string;
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
    `);
  }

  // ── Rides CRUD ──

  createRide(opts: CreateRideOpts): number {
    const stmt = this.db.prepare(`
      INSERT INTO rides (started_at, route_id, route_name)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(opts.startedAt, opts.routeId ?? null, opts.routeName ?? null);
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
        total_coins = ?
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
      rideId,
    );
  }

  getRide(id: number): Ride | undefined {
    const row = this.db.prepare('SELECT * FROM rides WHERE id = ?').get(id) as any;
    return row ? this.mapRide(row) : undefined;
  }

  listRides(limit = 20, offset = 0, routeId?: string): Ride[] {
    let sql = 'SELECT * FROM rides';
    const params: unknown[] = [];

    if (routeId) {
      sql += ' WHERE route_id = ?';
      params.push(routeId);
    }

    sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapRide(r));
  }

  deleteRide(id: number): boolean {
    const result = this.db.prepare('DELETE FROM rides WHERE id = ?').run(id);
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

  // ── Calendar queries ──

  getRideCountsByDateRange(fromTs: number, toTs: number): RideDayCount[] {
    const rows = this.db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count
      FROM rides
      WHERE started_at >= ? AND started_at < ?
      GROUP BY date
      ORDER BY date
    `).all(fromTs, toTs) as any[];

    return rows.map((r) => ({
      date: r.date as string,
      count: r.count as number,
    }));
  }

  getRidesByDate(dateStr: string): Ride[] {
    const rows = this.db.prepare(`
      SELECT * FROM rides
      WHERE date(started_at / 1000, 'unixepoch', 'localtime') = ?
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
      routeId: row.route_id ?? undefined,
      routeName: row.route_name ?? undefined,
      notes: row.notes ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
