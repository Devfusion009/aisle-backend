import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import {
  IsEnum,
  IsBoolean,
  IsString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';

/**
 * Tenant Entity
 * Represents an organization (company) using the platform.
 * This is the root of the multi-tenancy hierarchy.
 *
 * NOTE: `plan` has no DB default. Tenant-creation code must always assign
 * a plan code explicitly (typically via PlansService.getDefaultPlanCodeForNewTenant).
 * This forces the platform admin to configure plans before any tenant can
 * be created, instead of silently bucketing everyone into a magic "starter".
 */
@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Column({ unique: true, length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  slug: string;

  @Column({ length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  plan: string;

  @Column({ type: 'jsonb', nullable: true })
  settings: TenantSettings;

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/**
 * Tenant settings stored as JSONB.
 *
 * Plan-related limits used to live here (per-tenant overrides), but plans are
 * now strictly global — the values come from the subscription_plans table
 * via PLAN_LIMITS. Only true per-tenant configuration belongs here.
 */
export interface TenantSettings {
  /** Enabled LLM providers */
  allowedProviders?: string[];

  /** Custom branding */
  branding?: {
    primaryColor?: string;
    logoUrl?: string;
  };

  /** Third-party integration config */
  integrations?: {
    slack?: {
      webhookUrl: string;
    };
  };
}
