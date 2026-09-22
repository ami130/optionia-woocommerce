import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { JobStatus } from '../../common/database/enums';
import { Store } from '../../stores/entities/store.entity';

/** A catalogue or configuration synchronisation run. */
@Entity('sync_jobs')
@Index('ix_sync_jobs_store_status', ['storeId', 'status'])
export class SyncJob {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', length: 36 })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Column({ type: 'varchar', length: 40 })
  type: string;

  @Column({ type: 'varchar', length: 20, default: JobStatus.QUEUED })
  status: JobStatus;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  finishedAt: Date | null;

  /** Counts and durations — what a reconciliation actually did. */
  @Column({ type: 'json', nullable: true })
  stats: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
