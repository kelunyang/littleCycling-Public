/**
 * FIT file parser — extracts route points from Garmin FIT binary files.
 * Used server-side only (FIT is binary, requires fit-file-parser library).
 */

import FitParser from 'fit-file-parser';
import type { RoutePoint } from '@littlecycling/shared';

/**
 * Parse a FIT binary buffer into route points.
 * Throws if the file contains no GPS data (e.g. indoor trainer recording).
 */
export async function parseFitRoute(buffer: Buffer): Promise<RoutePoint[]> {
  const parser = new FitParser({
    force: true,
    speedUnit: 'km/h',
    lengthUnit: 'km',
  });

  const data = await parser.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  const records = data.records ?? [];

  const points: RoutePoint[] = [];
  for (const rec of records) {
    if (rec.position_lat == null || rec.position_long == null) continue;

    points.push({
      lat: rec.position_lat,
      lon: rec.position_long,
      ele: rec.altitude ?? 0,
      tsEpoch: rec.timestamp ? new Date(rec.timestamp as string).getTime() : undefined,
    });
  }

  if (points.length === 0) {
    throw new Error('此 FIT 檔案不含路線資訊（無 GPS 座標），無法匯入為路線');
  }

  return points;
}
