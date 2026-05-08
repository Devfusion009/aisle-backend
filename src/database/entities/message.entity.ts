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
  IsEnum,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Tenant } from './tenant.entity';
import { Conversation } from './conversation.entity';

/**
 * Message Role
 */
export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
}

/**
 * Message Entity
 * Represents a single message in a conversation.
 */
@Entity('messages')
@Index(['tenantId', 'conversationId'])
export class Message {
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

  @Column('uuid')
  @IsUUID('4')
  conversationId: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({
    type: 'enum',
    enum: MessageRole,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @Column({ type: 'text' })
  @IsString()
  @IsNotEmpty()
  content: string;

  /** Tokens used for this message (input for user, output for assistant) */
  @Column({ default: 0 })
  @IsInt()
  @Min(0)
  tokensUsed: number;

  /** Context chunks used for RAG (stored as JSON for reference) */
  @Column({ type: 'jsonb', nullable: true })
  contextChunks: ContextChunk[];

  /** Model used for generating this response (for assistant messages) */
  @Column({ length: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model: string;

  /**
   * Image attachments uploaded with a user message. Stored as inline
   * data-URLs so the chat history can re-render them after a reload without
   * any S3 round-trip. Null for assistant/system messages and for plain
   * text user turns.
   */
  @Column({ type: 'jsonb', nullable: true })
  attachments: MessageAttachment[] | null;

  @CreateDateColumn()
  createdAt: Date;
}

/**
 * RAG context chunk reference
 */
export interface ContextChunk {
  documentId: string;
  chunkId: string;
  content: string;
  score: number;
}

/**
 * A single image attachment persisted alongside a user message.
 * `dataUrl` is a full `data:image/...;base64,...` string so the frontend can
 * drop it straight into an `<img>` tag.
 *
 * `ocrText` captures whatever the OCR chain extracted at the time the
 * message was sent. It is what we re-inject into the prompt when the Redis
 * session expires and we have to rebuild context from the DB. Without this
 * field, images silently lose their context after one hour.
 */
export interface MessageAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
  ocrText?: string;
}
