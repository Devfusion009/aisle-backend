import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: add pricing + display metadata to subscription_plans so the
 * platform admin can edit prices/limits at runtime via /super-admin/plans.
 * Existing rows get sensible defaults (price=0, currency=USD, monthly).
 */
export class AddPlanPricingFields1746230000000 implements MigrationInterface {
  name = 'AddPlanPricingFields1746230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscription_plans"
        ADD COLUMN IF NOT EXISTS "displayName" varchar(100) NULL,
        ADD COLUMN IF NOT EXISTS "price" numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "currency" varchar(10) NOT NULL DEFAULT 'USD',
        ADD COLUMN IF NOT EXISTS "billingPeriod" varchar(20) NOT NULL DEFAULT 'monthly'
    `);

    // Backfill display name from `name` so existing rows render in the UI.
    await queryRunner.query(`
      UPDATE "subscription_plans"
        SET "displayName" = "name"
        WHERE "displayName" IS NULL
    `);

    // Seed reasonable starting prices on the three default tiers if they
    // exist and still have the migration default (0). The platform admin
    // can change these at any time from the UI.
    await queryRunner.query(`
      UPDATE "subscription_plans"
        SET "price" = 49, "billingPeriod" = 'monthly'
        WHERE "code" = 'business' AND "price" = 0
    `);
    await queryRunner.query(`
      UPDATE "subscription_plans"
        SET "price" = 199, "billingPeriod" = 'monthly'
        WHERE "code" = 'enterprise' AND "price" = 0
    `);
    await queryRunner.query(`
      UPDATE "subscription_plans"
        SET "billingPeriod" = 'free'
        WHERE "code" = 'starter' AND "price" = 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscription_plans"
        DROP COLUMN IF EXISTS "billingPeriod",
        DROP COLUMN IF EXISTS "currency",
        DROP COLUMN IF EXISTS "price",
        DROP COLUMN IF EXISTS "displayName"
    `);
  }
}
