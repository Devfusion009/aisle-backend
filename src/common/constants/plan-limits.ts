export interface PlanLimits {
  maxUsers: number;
  maxAssistants: number;
  maxDatasets: number;
  maxStorageBytes: number;
  monthlyTokenLimit: number;
}

/**
 * Runtime plan-limits cache, populated by PlansService.refreshPlansCache()
 * from the `subscription_plans` DB table. Empty at boot — the platform admin
 * configures plans via /super-admin/plans, and this map fills as the cache
 * refreshes after each write.
 *
 * Plans are GLOBAL — every tenant on the same plan code resolves to exactly
 * the same limits. There are no per-tenant overrides.
 *
 * NOTE: this is an exported mutable object so synchronous consumers
 * (auth, RBAC checks, quota assertions) can read it without an `await`.
 * Treat it as read-only outside PlansService.
 */
export const PLAN_LIMITS: Record<string, PlanLimits> = {};

/**
 * Last-resort defaults used only when *no* plans are configured yet — keeps
 * the system from crashing during the brief window between install and the
 * platform admin creating their first plan. Once any plan exists in the DB,
 * these values are never consulted again.
 *
 * The numbers are intentionally restrictive (1 user, 0 assistants, etc.) so
 * an unconfigured platform fails closed — no one accidentally provisions
 * resources before billing is set up.
 */
const SAFE_MINIMUM_LIMITS: PlanLimits = {
  maxUsers: 1,
  maxAssistants: 0,
  maxDatasets: 0,
  maxStorageBytes: 0,
  monthlyTokenLimit: 0,
};

/**
 * Returns the limits for a plan code.
 *
 * Resolution order:
 *   1. The plan referenced by `planCode`, if it exists in the cache.
 *   2. Any other plan in the cache (covers the "tenant references a deleted
 *      plan" case so they aren't soft-bricked).
 *   3. SAFE_MINIMUM_LIMITS — only reached when no plans are configured at all.
 *
 * Per-tenant overrides have been intentionally removed: when the platform
 * admin sets Enterprise = 1000 assistants, every Enterprise tenant gets
 * exactly that — no shadowed values from old tenant.settings JSONB blobs.
 */
export function getPlanLimits(planCode: string): PlanLimits {
  return (
    PLAN_LIMITS[planCode] ??
    Object.values(PLAN_LIMITS)[0] ??
    SAFE_MINIMUM_LIMITS
  );
}

/**
 * True iff the platform admin has configured at least one plan. Used to gate
 * tenant signups and to drive the empty state on /super-admin/plans.
 */
export function hasConfiguredPlans(): boolean {
  return Object.keys(PLAN_LIMITS).length > 0;
}
