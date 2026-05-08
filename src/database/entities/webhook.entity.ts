import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { IsBoolean, IsString, IsNotEmpty, IsUUID, IsUrl, MaxLength } from 'class-validator';
import { Tenant } from './tenant.entity';

@Entity('webhooks')
@Index(['tenantId'])
export class Webhook {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column('uuid')
  @IsUUID('4')
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'tenantId' }) tenant: Tenant;

  @Column({ length: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Column({ length: 1000 })
  @IsUrl()
  @MaxLength(1000)
  url: string;

  @Column({ type: 'jsonb', default: () => "'[]'" }) events: string[];

  @Column({ default: true })
  @IsBoolean()
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true }) lastFiredAt: Date | null;

  @CreateDateColumn() createdAt: Date;
}
