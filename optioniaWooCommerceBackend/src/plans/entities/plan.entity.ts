import { Column, Entity, Index } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { moneyTransformer } from '../../common/money/money.transformer';

/**
 * A subscription plan.
 *
 * Global, not tenant-scoped: every tenant reads the same rows. One of three
 * tables deliberately outside tenant scoping, excluded by name in the scoped
 * repository rather than by omission.
 */
@Entity('plans')
export class Plan extends BaseEntity {
  /** Stable identifier used in code and URLs. Never renamed. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'bigint', transformer: moneyTransformer })
  priceMonthlyMinor: number;

  @Column({ type: 'bigint', transformer: moneyTransformer })
  priceYearlyMinor: number;

  @Column({ type: 'char', length: 3, default: 'USD' })
  currency: string;

  /**
   * Enforceable limits, keyed by metric.
   *
   * JSON because the metric set grows — option sets, assigned products,
   * storage, stores, seats — and a column per metric means a migration every
   * time one is added.
   *
   * Every value must be **measurable in code**. A limit that cannot be measured
   * cannot be sold, so each key here has a corresponding counter in
   * `usage_records`.
   */
  @Column({ type: 'json' })
  limits: Record<string, number | null>;

  /** Capability flags. Null limits mean unlimited; absent features mean off. */
  @Column({ type: 'json' })
  features: Record<string, boolean>;

  /** Whether the plan appears on the public pricing page. */
  @Column({ type: 'boolean', default: true })
  isPublic: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;
}
