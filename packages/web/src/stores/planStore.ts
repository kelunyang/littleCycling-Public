import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import dayjs from 'dayjs';
import type {
  TrainingPlan,
  TrainingPlanSummary,
  ActivePlanState,
  PlanDayCompletion,
  PlanSession,
} from '@littlecycling/shared';
import { getCurrentPlanDay, getSessionByDay } from '@littlecycling/shared';
import { notifyError, notifySuccess } from '@/utils/notify';

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<TrainingPlanSummary[]>([]);
  const activePlans = ref<{ plan: TrainingPlan; startDate: string }[]>([]);
  const completions = ref<Map<string, PlanDayCompletion[]>>(new Map());
  const generating = ref(false);

  // ── Computed ──

  /** All active plan sessions for today. */
  const todaySessions = computed(() => {
    const result: { plan: TrainingPlan; session: PlanSession; day: number; startDate: string }[] = [];
    for (const { plan, startDate } of activePlans.value) {
      const day = getCurrentPlanDay(startDate);
      if (day < 1 || day > plan.totalDays) continue;
      const session = getSessionByDay(plan, day);
      if (session) result.push({ plan, session, day, startDate });
    }
    return result;
  });

  const todayHasTraining = computed(() =>
    todaySessions.value.some((s) => s.session.type === 'training'),
  );

  // ── Actions ──

  async function fetchPlans() {
    try {
      const res = await fetch('/api/plans');
      if (!res.ok) return;
      const data = await res.json();
      plans.value = data.plans;
    } catch {
      notifyError('Failed to load training plans');
    }
  }

  async function fetchActivePlans() {
    try {
      const res = await fetch('/api/plans/active');
      if (!res.ok) return;
      const data = await res.json();
      const states: ActivePlanState[] = data.activePlans;

      const loaded: { plan: TrainingPlan; startDate: string }[] = [];
      for (const s of states) {
        const planRes = await fetch(`/api/plans/${s.planId}`);
        if (!planRes.ok) continue;
        const plan = (await planRes.json()) as TrainingPlan;
        loaded.push({ plan, startDate: s.startDate });

        // Also fetch completions
        const compRes = await fetch(`/api/plans/${s.planId}/completions`);
        if (compRes.ok) {
          const compData = await compRes.json();
          completions.value.set(s.planId, compData.completions);
        }
      }
      activePlans.value = loaded;
    } catch {
      notifyError('Failed to load active plans');
    }
  }

  async function activatePlan(planId: string, startDate: string) {
    try {
      const res = await fetch('/api/plans/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, startDate }),
      });
      if (!res.ok) throw new Error('Failed to activate plan');
      await fetchActivePlans();
      notifySuccess('Plan activated');
    } catch (err: any) {
      notifyError(err.message);
    }
  }

  async function deactivatePlan(planId: string) {
    try {
      const res = await fetch(`/api/plans/active/${planId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to deactivate plan');
      activePlans.value = activePlans.value.filter((p) => p.plan.id !== planId);
      notifySuccess('Plan deactivated');
    } catch (err: any) {
      notifyError(err.message);
    }
  }

  async function recordCompletion(planId: string, day: number, rideId?: number, manual?: boolean) {
    try {
      const res = await fetch(`/api/plans/${planId}/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day, rideId: rideId ?? null, manual: manual ?? false }),
      });
      if (!res.ok) throw new Error('Failed to record completion');

      // Update local completions
      const compRes = await fetch(`/api/plans/${planId}/completions`);
      if (compRes.ok) {
        const data = await compRes.json();
        completions.value.set(planId, data.completions);
      }
    } catch (err: any) {
      notifyError(err.message);
    }
  }

  async function generatePlan(params: {
    llmIndex: number;
    weeks?: number;
    sessionsPerWeek?: number;
    minutesPerSession?: number;
    goal?: string;
    notes?: string;
    userPrompt?: string;
  }) {
    generating.value = true;
    try {
      const res = await fetch('/api/plans/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Generation failed (${res.status})`);
      }
      await fetchPlans();
      notifySuccess('Training plan generated');
    } catch (err: any) {
      notifyError(err.message);
      throw err;
    } finally {
      generating.value = false;
    }
  }

  async function deletePlan(id: string) {
    try {
      const res = await fetch(`/api/plans/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete plan');
      plans.value = plans.value.filter((p) => p.id !== id);
      activePlans.value = activePlans.value.filter((p) => p.plan.id !== id);
      completions.value.delete(id);
      notifySuccess('Plan deleted');
    } catch (err: any) {
      notifyError(err.message);
    }
  }

  function isCompleted(planId: string, day: number): boolean {
    const comps = completions.value.get(planId);
    return comps?.some((c) => c.day === day) ?? false;
  }

  function getDateForDay(startDate: string, day: number): string {
    return dayjs(startDate).add(day - 1, 'day').format('YYYY-MM-DD');
  }

  return {
    plans, activePlans, completions, generating,
    todaySessions, todayHasTraining,
    fetchPlans, fetchActivePlans, activatePlan, deactivatePlan,
    recordCompletion, generatePlan, deletePlan, isCompleted, getDateForDay,
  };
});
