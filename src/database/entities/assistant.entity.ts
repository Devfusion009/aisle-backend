import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import {
  IsEnum,
  IsBoolean,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsNumber,
  IsInt,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Tenant } from './tenant.entity';

/**
 * LLM Model Configuration
 */
export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  OPENROUTER = 'openrouter',
  MISTRAL = 'mistral',
  GEMINI = 'gemini',
}

/**
 * Assistant Entity
 * Represents an AI assistant configured by a tenant.
 * Each assistant can have its own system prompt, model settings, and RAG configuration.
 */
@Entity('assistants')
export class Assistant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** CRITICAL: All queries must filter by tenantId for data isolation */
  @Column('uuid')
  @Index()
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ length: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  description: string;

  /** System prompt that defines the assistant's behavior */
  @Column({ type: 'text' })
  @ValidateIf((o) => !o.isDataset)
  @IsString()
  @IsNotEmpty()
  systemPrompt: string;

  /** LLM provider to use */
  @Column({
    type: 'enum',
    enum: LLMProvider,
    default: LLMProvider.OPENROUTER,
  })
  @IsEnum(LLMProvider)
  provider: LLMProvider;

  /** Model identifier (e.g., 'openai/gpt-4o-mini', 'mistral-small-latest') */
  @Column({ length: 100, default: 'openai/gpt-4o-mini' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string;

  /** Temperature for response generation (0.0 - 2.0) */
  @Column({
    type: 'decimal',
    precision: 3,
    scale: 2,
    default: 0.7,
    // PostgreSQL returns decimal columns as JS strings by default ("0.70"),
    // which breaks class-validator's @IsNumber() when the entity is re-saved.
    // Transform on read so the in-memory value is always a number.
    transformer: {
      to: (value: number) => value,
      from: (value: string | number | null) =>
        value === null || value === undefined ? value : Number(value),
    },
  })
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature: number;

  /** Maximum tokens for response */
  @Column({ default: 2048 })
  @IsInt()
  @Min(1)
  maxTokens: number;

  /** Whether RAG (document retrieval) is enabled for this assistant */
  @Column({ default: true })
  @IsBoolean()
  ragEnabled: boolean;

  /** Number of context chunks to retrieve when RAG is enabled */
  @Column({ default: 8 })
  @IsInt()
  @Min(1)
  ragTopK: number;

  /** When true, this row is a knowledge-base dataset folder, not a chat assistant */
  @Column({ default: false })
  @IsBoolean()
  isDataset: boolean;

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
