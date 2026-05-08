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
import { IsOptional, IsUUID } from 'class-validator';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';
import { Assistant } from './assistant.entity';

/**
 * UserDatasetAccess Entity
 * Junction table controlling which high-priority users can access which datasets.
 */
@Entity('user_dataset_access')
@Unique(['userId', 'datasetId'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'datasetId'])
export class UserDatasetAccess {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @IsUUID('4')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('uuid')
  @IsUUID('4')
  datasetId: string;

  @ManyToOne(() => Assistant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'datasetId' })
  dataset: Assistant;

  @Column('uuid')
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column('uuid', { nullable: true })
  @IsOptional()
  @IsUUID('4')
  grantedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'grantedBy' })
  grantedByUser: User;

  @CreateDateColumn()
  createdAt: Date;
}
