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
import { IsEnum, IsUUID } from 'class-validator';
import { Tenant } from './tenant.entity';
import { Message } from './message.entity';
import { User } from './user.entity';

export enum VoteType {
  UP = 'up',
  DOWN = 'down',
}

/**
 * MessageVote Entity
 * Stores user feedback (thumbs up/down) on assistant messages.
 * One vote per user per message.
 */
@Entity('message_votes')
@Index(['tenantId', 'messageId'])
@Unique(['messageId', 'userId'])
export class MessageVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column('uuid')
  @IsUUID('4')
  messageId: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'messageId' })
  message: Message;

  @Column('uuid')
  @IsUUID('4')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: VoteType })
  @IsEnum(VoteType)
  vote: VoteType;

  @CreateDateColumn()
  createdAt: Date;
}
