/**
 * Training plan CRUD — manages saved plans as JSON files in data/plans/.
 * Follows the same pattern as RouteStore.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import type { TrainingPlan, TrainingPlanSummary } from '@littlecycling/shared';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export class PlanStore {
  constructor(private plansDir: string) {
    mkdirSync(plansDir, { recursive: true });
  }

  /** List all plans (without weeks data) sorted by createdAt desc. */
  list(): TrainingPlanSummary[] {
    const files = readdirSync(this.plansDir).filter(f => f.endsWith('.json'));
    const summaries: TrainingPlanSummary[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.plansDir, file), 'utf-8');
        const plan = JSON.parse(raw) as TrainingPlan;
        const { weeks: _, ...summary } = plan;
        summaries.push(summary);
      } catch {
        // Skip malformed files
      }
    }

    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get a single plan by id (with full weeks data). */
  get(id: string): TrainingPlan | null {
    const filePath = join(this.plansDir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as TrainingPlan;
    } catch {
      return null;
    }
  }

  /** Create a new plan. Returns the saved plan with generated id and createdAt. */
  create(plan: Omit<TrainingPlan, 'id' | 'createdAt'>): TrainingPlan {
    const id = `${slugify(plan.name)}-${dayjs().format('YYYYMMDDHHmmss')}`;
    const full: TrainingPlan = {
      ...plan,
      id,
      createdAt: Date.now(),
    };
    writeFileSync(
      join(this.plansDir, `${id}.json`),
      JSON.stringify(full, null, 2) + '\n',
      'utf-8',
    );
    return full;
  }

  /** Delete a plan. Returns true if deleted, false if not found. */
  delete(id: string): boolean {
    const filePath = join(this.plansDir, `${id}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }
}
