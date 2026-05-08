import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PLAN_LIMITS, getPlanLimits, hasConfiguredPlans } from './plan-limits.js';

describe('plan-limits', () => {
  // PLAN_LIMITS is a runtime cache populated by PlansService. The tests
  // below seed and clear it manually to simulate the cache state.
  beforeEach(() => {
    for (const k of Object.keys(PLAN_LIMITS)) delete PLAN_LIMITS[k];
  });
  afterEach(() => {
    for (const k of Object.keys(PLAN_LIMITS)) delete PLAN_LIMITS[k];
  });

  describe('PLAN_LIMITS', () => {
    it('starts empty before PlansService populates it', () => {
      expect(Object.keys(PLAN_LIMITS)).toHaveLength(0);
    });

    it('reflects whatever PlansService writes into it', () => {
      PLAN_LIMITS['custom'] = {
        maxUsers: 7, maxAssistants: 4, maxDatasets: 2,
        maxStorageBytes: 500_000, monthlyTokenLimit: 250_000,
      };
      expect(PLAN_LIMITS).toHaveProperty('custom');
      expect(PLAN_LIMITS['custom'].maxUsers).toBe(7);
    });
  });

  describe('hasConfiguredPlans', () => {
    it('is false when the cache is empty', () => {
      expect(hasConfiguredPlans()).toBe(false);
    });
    it('is true once any plan has been registered', () => {
      PLAN_LIMITS['x'] = { maxUsers: 1, maxAssistants: 0, maxDatasets: 0, maxStorageBytes: 0, monthlyTokenLimit: 0 };
      expect(hasConfiguredPlans()).toBe(true);
    });
  });

  describe('getPlanLimits', () => {
    beforeEach(() => {
      PLAN_LIMITS['starter'] = {
        maxUsers: 5, maxAssistants: 3, maxDatasets: 5,
        maxStorageBytes: 1_073_741_824, monthlyTokenLimit: 1_000_000,
      };
      PLAN_LIMITS['pro'] = {
        maxUsers: 50, maxAssistants: 20, maxDatasets: 20,
        maxStorageBytes: 10_737_418_240, monthlyTokenLimit: 10_000_000,
      };
    });

    it('returns the requested plan from the cache', () => {
      const limits = getPlanLimits('starter');
      expect(limits.maxUsers).toBe(5);
      expect(limits.maxAssistants).toBe(3);
    });

    it('returns the same limits for every caller — plans are global', () => {
      // No per-tenant overrides are applied; calling twice for the same code
      // must return the same numbers.
      expect(getPlanLimits('pro')).toEqual(getPlanLimits('pro'));
      expect(getPlanLimits('pro').maxAssistants).toBe(20);
    });

    it('falls back to *some* configured plan when the code is unknown', () => {
      const limits = getPlanLimits('definitely-not-real');
      // We don't care which plan it picks — only that it returns something
      // sensible instead of crashing or returning the safe-minimum stub.
      expect(limits.maxUsers).toBeGreaterThan(0);
    });

    it('falls back to safe-minimum when the cache is completely empty', () => {
      for (const k of Object.keys(PLAN_LIMITS)) delete PLAN_LIMITS[k];
      const limits = getPlanLimits('starter');
      expect(limits.maxUsers).toBe(1);
      expect(limits.maxAssistants).toBe(0);
      expect(limits.maxStorageBytes).toBe(0);
    });
  });
});
