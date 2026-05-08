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
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Tenant } from './tenant.entity';
import { Assistant } from './assistant.entity';
import { User } from './user.entity';

/**
 * Usage Log Entity
 * Tracks token usage per request for billing and analytics.
 */
@Entity('usage_logs')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'assistantId'])
export class UsageLog {
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

  @Column({ type: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  assistantId: string | null;

  @ManyToOne(() => Assistant, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assistantId' })
  assistant: Assistant | null;

  @Column('uuid')
  @IsUUID('4')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** Conversation ID for reference */
  @Column('uuid', { nullable: true })
  @IsOptional()
  @IsUUID('4')
  conversationId: string | null;

  /** Tokens in the input prompt */
  @Column()
  @IsInt()
  @Min(0)
  tokensInput: number;

  /** Tokens in the output response */
  @Column()
  @IsInt()
  @Min(0)
  tokensOutput: number;

  /** Total tokens (input + output) */
  @Column()
  @IsInt()
  @Min(0)
  tokensTotal: number;

  /** LLM model used */
  @Column({ length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string;

  /** LLM provider used */
  @Column({ length: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string;

  /** Request latency in milliseconds */
  @Column({ type: 'int', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  latencyMs: number | null;

  /** Whether the request was successful */
  @Column({ default: true })
  @IsBoolean()
  success: boolean;

  /** Error message if the request failed */
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
