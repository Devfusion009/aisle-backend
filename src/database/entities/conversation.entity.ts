import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
} from 'typeorm';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Tenant } from './tenant.entity';
import { Assistant } from './assistant.entity';
import { User } from './user.entity';
import { Message } from './message.entity';

/**
 * Conversation Entity
 * Represents a chat conversation between a user and an assistant.
 */
@Entity('conversations')
@Index(['tenantId', 'assistantId'])
@Index(['tenantId', 'userId'])
export class Conversation {
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

  @Column({ length: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title: string;

  /** Summary of the conversation for context */
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  summary: string;

  /** Total tokens used in this conversation */
  @Column({ default: 0 })
  @IsInt()
  @Min(0)
  totalTokensUsed: number;

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @Column({ default: false })
  @IsBoolean()
  isPinned: boolean;

  @Column({ default: false })
  @IsBoolean()
  isArchived: boolean;

  /** Soft-delete flag: user "deleted" the chat — hidden from sidebar but preserved for admin */
  @Column({ default: false })
  @IsBoolean()
  isDeletedByUser: boolean;

  /** Public share token — set when the user enables sharing. Null = not shared. */
  @Column({ type: 'uuid', nullable: true, unique: true })
  @IsOptional()
  @IsUUID('4')
  shareToken: string | null;

  /** Whether this conversation is publicly viewable via shareToken */
  @Column({ default: false })
  @IsBoolean()
  isShared: boolean;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  @CreateDateColumn()
  createdAt: Date;
}
