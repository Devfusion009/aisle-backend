import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { IsUUID } from 'class-validator';
import { Tenant } from './tenant.entity';
import { Assistant } from './assistant.entity';

/**
 * AssistantDataset Entity
 * Junction table linking assistants to dataset folders for RAG.
 */
@Entity('assistant_datasets')
@Unique(['assistantId', 'datasetId'])
export class AssistantDataset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  @IsUUID('4')
  assistantId: string;

  @ManyToOne(() => Assistant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assistantId' })
  assistant: Assistant;

  @Column('uuid')
  @IsUUID('4')
  datasetId: string;

  @ManyToOne(() => Assistant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'datasetId' })
  dataset: Assistant;

  @Column('uuid')
  @Index()
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @CreateDateColumn()
  createdAt: Date;
}
