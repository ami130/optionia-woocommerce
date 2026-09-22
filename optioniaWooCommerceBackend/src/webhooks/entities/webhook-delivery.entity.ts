import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { DeliveryStatus, WebhookDirection } from '../../common/database/enums';
import { Store } from '../../stores/entities/store.entity';

/**
 * A webhook attempt, inbound or outbound.
 *
 * `BIGINT AUTO_INCREMENT` rather than UUIDv7: never externally addressable, high
 * volume, and 8 bytes beats 36 across millions of rows. The enumeration concern
 * that drives UUIDs on tenant-scoped tables does not apply to something no
 * client can request by id.
 */
@Entity('webhook_deliveries')
@Index('ix_webhook_retry', ['status', 'nextRetryAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', length: 36, nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'storeId' })
  store: Store | null;

  @Column({ type: 'varchar', length: 10 })
  direction: WebhookDirection;

  @Column({ type: 'varchar', length: 64 })
  event: string;

  @Column({ type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** Indexed with `status`: the retry worker scans exactly this pair. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  nextRetryAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
