import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { OptionSetsRepository } from './option-sets.repository';

/**
 * Advancing the set a child belongs to.
 *
 * ## Why one service rather than a method on each
 *
 * A group, option or value is **part of** its option set, so editing one *is*
 * editing the set: its `rowVersion` must advance, or two people editing
 * different parts of one set would never see a conflict — the silent overwrite
 * M7.4b exists to prevent, arriving one level down where nobody looked.
 *
 * That was implemented four times across three services, each walking the tree
 * upward with its own queries. One concept in four shapes, and the value-level
 * version cost **two extra reads on every value mutation** — a `findById` for
 * the option and another for the group, purely to learn an id the database can
 * resolve in one join.
 */
@Injectable()
export class ParentSetService {
  constructor(
    private readonly sets: OptionSetsRepository,
    private readonly dataSource: DataSource,
  ) {}

  /** The set itself. */
  async touchSet(optionSetId: string): Promise<void> {
    await this.sets.applyChange(optionSetId, {});
  }

  /** The set a group belongs to. Its id is already on the group. */
  async touchForGroup(optionSetId: string): Promise<void> {
    await this.touchSet(optionSetId);
  }

  /**
   * The set an option belongs to, in one query rather than a walk.
   *
   * Deleted parents are included deliberately: a cascade marks the group and the
   * option in the same transaction, and the set still needs its version bumped
   * for the edit that caused it.
   */
  async touchForOption(optionGroupId: string): Promise<void> {
    const [row] = await this.dataSource.query(
      `SELECT optionSetId FROM option_groups WHERE id = ? LIMIT 1`,
      [optionGroupId],
    );

    if (row) {
      await this.touchSet(row.optionSetId as string);
    }
  }

  /**
   * The set a value belongs to, in one query rather than two round trips.
   *
   * `option_values → options → option_groups` is a two-join lookup the database
   * does in a single statement.
   */
  async touchForValue(optionId: string): Promise<void> {
    const [row] = await this.dataSource.query(
      `SELECT g.optionSetId AS optionSetId
         FROM options o
         JOIN option_groups g ON g.id = o.optionGroupId
        WHERE o.id = ? LIMIT 1`,
      [optionId],
    );

    if (row) {
      await this.touchSet(row.optionSetId as string);
    }
  }
}
