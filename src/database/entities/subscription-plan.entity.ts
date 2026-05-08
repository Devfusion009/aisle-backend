import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsNumber,
  Min,
  IsBoolean,
  IsOptional,
} from 'class-validator';

const decimalTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? 0 : Number(value)),
};

/**
 * Subscription Plan Entity
 * Represents a pricing/feature tier in the platform.
 *
 * Pricing fields (price/currency/billingPeriod) and limit fields are owned by
 * the platform admin via /super-admin/plans. PlansService keeps the runtime
 * cache in sync — see PlansService.refreshPlansCache().
 */
@Entity('subscription_plans')
export class SubscriptionPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Internal name (e.g. "Starter", "Business") — kept for backward compatibility. */
  @Column({ length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /**
   * Display name shown in the UI (e.g. "Business Pro"). Falls back to `name`
   * at the API layer if not set, so existing rows don't render blank.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string | null;

  /**
   * Internal system code (e.g. "starter", "business"). IMMUTABLE — referenced
   * by tenant.plan; renaming would orphan tenants. Update endpoint rejects
   * code changes.
   */
  @Column({ unique: true, length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code: string;

  // -- Pricing --

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: decimalTransformer })
  @IsNumber()
  @Min(0)
  price: number;

  @Column({ length: 10, default: 'USD' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  currency: string;

  /** 'monthly' | 'yearly' | 'free' (free implies price=0; not enforced in DB). */
  @Column({ length: 20, default: 'monthly' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  billingPeriod: string;

  // -- Limits --

  @Column({ type: 'int', default: 5 })
  @IsNumber()
  @Min(1)
  maxUsers: number;

  @Column({ type: 'int', default: 3 })
  @IsNumber()
  @Min(0)
  maxAssistants: number;

  @Column({ type: 'int', default: 5 })
  @IsNumber()
  @Min(0)
  maxDatasets: number;

  @Column({ type: 'bigint', default: 1073741824 }) // 1 GB
  @IsNumber()
  @Min(0)
  maxStorageBytes: number;

  @Column({ type: 'bigint', default: 1000000 })
  @IsNumber()
  @Min(0)
  monthlyTokenLimit: number;

  // -- Admin / System Flags --

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
