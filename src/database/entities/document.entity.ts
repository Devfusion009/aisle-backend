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
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { User } from './user.entity';
import { Tenant } from './tenant.entity';
import { Assistant } from './assistant.entity';

/**
 * Document processing status
 */
export enum DocumentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Document Entity
 * Represents an uploaded document in the knowledge base.
 */
@Entity('documents')
@Index(['tenantId', 'assistantId'])
export class Document {
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

  /** Assistant this document belongs to (legacy/optional) */
  @Column({ type: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  assistantId: string | null;

  @ManyToOne(() => Assistant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assistantId' })
  assistant: Assistant | null;

  /** Original filename */
  @Column({ length: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** S3/MinIO object key */
  @Column({ length: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  s3Key: string;

  /** MIME type */
  @Column({ length: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  mimeType: string;

  /** File size in bytes */
  @Column({ type: 'bigint' })
  @IsInt()
  @Min(0)
  fileSize: number;

  /** Document version for updates */
  @Column({ default: 1 })
  @IsInt()
  @Min(1)
  version: number;

  /** Processing status */
  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  @IsEnum(DocumentStatus)
  status: DocumentStatus;

  /** Error message if processing failed */
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  errorMessage: string;

  /** Number of chunks generated */
  @Column({ default: 0 })
  @IsInt()
  @Min(0)
  chunkCount: number;

  /** Extracted text character count */
  @Column({ default: 0 })
  @IsInt()
  @Min(0)
  characterCount: number;

  /** UUID of the user who uploaded this document */
  @Column({ type: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  uploadedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploadedBy' })
  uploader: User | null;

  /** Display name of the uploader at time of upload (denormalized for fast display) */
  @Column({ type: 'varchar', length: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  uploadedByName: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
