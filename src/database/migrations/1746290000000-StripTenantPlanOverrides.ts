import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: scrub legacy plan-limit override keys from `tenants.settings`.
 *
 * Background — early code (and seed.ts) wrote per-tenant snapshots like
 *   { maxAssistants: 5, monthlyTokenLimit: 100000 }
 * into the JSONB blob. getPlanLimits() then honoured those overrides,
 * causing tenants to keep stale limits even after the platform admin set
 * their plan tier to richer values (e.g. Enterprise → 1000 assistants but
 * the tenant was still capped at 5).
 *
 * Plans are now strictly global. This migration removes the obsolete keys
 * from every existing row so the data state matches the new contract.
 */
export class StripTenantPlanOverrides1746290000000 implements MigrationInterface {
  name = 'StripTenantPlanOverrides1746290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PG `-` operator on jsonb removes a key; chain it for each obsolete field.
    await queryRunner.query(`
      UPDATE "tenants"
      SET "settings" = "settings"
        - 'maxUsers'
        - 'maxAssistants'
        - 'maxDatasets'
        - 'maxStorageBytes'
        - 'monthlyTokenLimit'
      WHERE "settings" IS NOT NULL
        AND (
          "settings" ? 'maxUsers'
          OR "settings" ? 'maxAssistants'
          OR "settings" ? 'maxDatasets'
          OR "settings" ? 'maxStorageBytes'
          OR "settings" ? 'monthlyTokenLimit'
        )
    `);
  }

  public async down(): Promise<void> {
    // No-op: we don't reconstruct the deleted overrides on rollback.
    // The values lived only in tenant.settings; if a rollback is ever needed
    // the platform admin can re-edit plans or restore from backup.
  }
}
