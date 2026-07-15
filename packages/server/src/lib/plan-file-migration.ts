/**
 * 一次性遷移：把 data/plans/*.json 的舊課表搬進 SQLite。
 *
 * 課表本體原本存成 JSON 檔（PlanStore），現改存 `plans` 表。啟動時掃描
 * plansDir，逐檔 sanity check 後 insertPlanIfAbsent，再把來源檔改名為
 * `<id>.json.migrated`（保留備份、天然冪等；重啟不會重掃）。
 *
 * 目的地 DB 內容優先：即使 id 已存在（被 INSERT OR IGNORE 略過），仍會把
 * 檔案改名收尾，避免下次啟動重覆處理。壞檔（缺 id/name/weeks）warn 後跳過、
 * 保持原檔不動，方便人工檢查。
 */

import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { TrainingPlan } from '@littlecycling/shared';
import type { RideDatabase } from './database.js';

/** 掃描 plansDir 的 *.json 遷移進 db。回傳成功搬進 DB 的課表數。 */
export function migratePlanFilesToDb(db: RideDatabase, plansDir: string): number {
  let files: string[];
  try {
    files = readdirSync(plansDir).filter((f) => f.endsWith('.json'));
  } catch {
    // plansDir 不存在（乾淨安裝）→ 無事可做。
    return 0;
  }

  let migrated = 0;
  for (const file of files) {
    const filePath = join(plansDir, file);
    let plan: TrainingPlan;
    try {
      plan = JSON.parse(readFileSync(filePath, 'utf-8')) as TrainingPlan;
    } catch {
      console.warn(`[migrate] 略過無法解析的課表檔：${file}`);
      continue;
    }

    // sanity check：缺必要欄位視為壞檔，保留原檔不動。
    if (!plan.id || !plan.name || !Array.isArray(plan.weeks)) {
      console.warn(`[migrate] 略過格式不符的課表檔（缺 id/name/weeks）：${file}`);
      continue;
    }

    const inserted = db.insertPlanIfAbsent(plan);
    if (inserted) migrated++;

    // 不論是否真的插入（id 已存在則 DB 版本優先），一律改名收尾，天然冪等。
    try {
      renameSync(filePath, `${filePath}.migrated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[migrate] 課表 ${plan.id} 已入庫但改名失敗（${file}）：${msg}`);
    }
  }

  return migrated;
}
