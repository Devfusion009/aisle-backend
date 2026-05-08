import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Tenant } from './tenant.entity';

/**
 * ApiKey Entity
 * Tenant-scoped API keys for external integrations (WhatsApp bots, webhooks, etc.)
 */
@Entity('api_keys')
@Index(['tenantId'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** CRITICAL: All queries must filter by tenantId */
  @Column('uuid')
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /** Human-readable name, e.g. "WhatsApp Bot" */
  @Column({ length: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  /** Optional description */
  @Column({ length: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description: string;

  /** SHA-256 hash of the full key (never stored in plain text) */
  @Column({ length: 64, unique: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  keyHash: string;

  /** First 20 chars of the key for display, e.g. "vrs_live_ab12cd34ef" */
  @Column({ length: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  keyPrefix: string;

  /** LLM provider, e.g. 'openai', 'anthropic' */
  @Column({ length: 50, default: 'openai' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string;

  /** Model identifier, e.g. 'gpt-4o-mini' */
  @Column({ length: 100, default: 'gpt-4o-mini' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string;

  /** Optional system prompt for the bot */
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  systemPrompt: string | null;

  /** Assistant UUIDs whose knowledge base this key can RAG against */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  authorizedAssistantIds: string[];

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @Column({ nullable: true })
  lastUsedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
