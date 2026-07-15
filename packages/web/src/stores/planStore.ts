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
import { useAgentStream } from '@/composables/useAgentStream';

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<TrainingPlanSummary[]>([]);
  const activePlans = ref<{ plan: TrainingPlan; startDate: string }[]>([]);
  const completions = ref<Map<string, PlanDayCompletion[]>>(new Map());
  // 展開課表卡時一次拉的每日達標等級(day → { grade, pct }),供 day cell 顯示。
  const complianceByPlan = ref<Map<string, Record<number, { grade: string; pct: number }>>>(new Map());

  // 課表生成走 agent SSE 串流；running 直接對外當作 generating（按鈕 loading）。
  const genStream = useAgentStream();

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
      // no-store:排除任何快取層讓列表停在舊狀態的可能。
      const res = await fetch('/api/plans', { cache: 'no-store' });
      if (!res.ok) {
        // 不能靜默吞掉——這裡失敗會讓「課表建立成功但列表不動」無跡可循。
        console.error(`[planStore] GET /api/plans 失敗(HTTP ${res.status})`);
        notifyError(`讀取課表列表失敗(HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      console.debug(`[planStore] fetchPlans → ${(data.plans ?? []).length} 筆`);
      plans.value = data.plans;
    } catch (err) {
      console.error('[planStore] fetchPlans 網路錯誤:', err);
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
    // 走 SSE 串流：genStream 逐幀累積進度事件供 UI 顯示，串流結束後判斷結果。
    await genStream.start('/api/plans/generate', params);

    // 防禦:無論 result 幀有沒有送達都刷新列表——server 端 submit_plan 可能
    // 已成功落庫(log 有 "Plan created")但終局幀在傳輸端丟失;若不刷新,
    // 列表會永久停在舊狀態(fetchPlans 平時只在 onMounted 跑一次)。
    const before = plans.value.length;
    await fetchPlans();

    if (genStream.error.value) {
      notifyError(genStream.error.value);
      throw new Error(genStream.error.value);
    }
    if (!genStream.result.value) {
      // result 幀沒到,但課表可能已建立(列表剛刷新過)。dump 收到的事件序列
      // 供比對後端 [plan-api][sse] log,找出幀在哪一端消失。
      console.warn(
        '[planStore] 課表生成串流結束但沒有 result 幀;收到的事件:',
        genStream.events.value.map((e) => e.phase).join(','),
      );
      if (plans.value.length > before) {
        notifySuccess('已產生訓練課表(結果回傳異常,已自動刷新列表)');
        return;
      }
      const msg = '課表生成未完成';
      notifyError(msg);
      throw new Error(msg);
    }
    notifySuccess('已產生訓練課表');
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

  // 展開課表卡時 fire-and-forget 拉每日達標等級;失敗靜默(不阻擋 UI)。
  async function fetchComplianceSummary(planId: string) {
    try {
      const res = await fetch(`/api/plans/${planId}/compliance-summary`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const next = new Map(complianceByPlan.value);
      next.set(planId, (data.days ?? {}) as Record<number, { grade: string; pct: number }>);
      complianceByPlan.value = next;
    } catch { /* fire-and-forget */ }
  }

  /** 取某日達標等級;無(手動標記或未拉到)回 null。 */
  function getCompliance(planId: string, day: number): { grade: string; pct: number } | null {
    return complianceByPlan.value.get(planId)?.[day] ?? null;
  }

  function isCompleted(planId: string, day: number): boolean {
    const comps = completions.value.get(planId);
    return comps?.some((c) => c.day === day) ?? false;
  }

  function getDateForDay(startDate: string, day: number): string {
    return dayjs(startDate).add(day - 1, 'day').format('YYYY-MM-DD');
  }

  return {
    plans, activePlans, completions, complianceByPlan,
    // generating 對映串流 running；agentEvents 供進度列顯示。
    generating: genStream.running,
    agentEvents: genStream.events,
    todaySessions, todayHasTraining,
    fetchPlans, fetchActivePlans, activatePlan, deactivatePlan,
    recordCompletion, generatePlan, deletePlan, isCompleted, getDateForDay,
    fetchComplianceSummary, getCompliance,
  };
});
