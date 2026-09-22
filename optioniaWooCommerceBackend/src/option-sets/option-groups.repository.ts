import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ParentScopedRepository } from '../common/tenancy/parent-scoped.repository';
import { OptionGroup } from './entities/option-group.entity';

/**
 * Groups, scoped through their option set.
 *
 * `option_groups` carries no `tenant_id` — it reaches a tenant through
 * `option_sets`, so every read joins rather than compares a column. That join is
 * the base class's job and cannot be forgotten here.
 */
@Injectable()
export class OptionGroupsRepository extends ParentScopedRepository<OptionGroup> {
  constructor(
    @InjectRepository(OptionGroup)
    repository: Repository<OptionGroup>,
  ) {
    super(repository, 'g', [{ table: 'option_sets', on: 'optionSetId' }]);
  }

  /** A set's groups, in display order. */
  async listBySet(optionSetId: string): Promise<OptionGroup[]> {
    return this.find({ where: { optionSetId }, order: { sortOrder: 'ASC' } });
  }

  /**
   * The next sort order in a set.
   *
   * M7.2: a create is "appended at the end of its parent's ordering". Gap-tolerant
   * steps leave room to move one sibling between two others without renumbering
   * the rest — which is the whole point of the reorder endpoint being one write.
   */
  async nextSortOrder(optionSetId: string): Promise<number> {
    return nextSortOrder(await this.listBySet(optionSetId));
  }
}

/**
 * The step after the last sibling, or the first slot when there are none.
 *
 * Shared by all three levels: the ordering rule is M7.2's and identical at every
 * level, so it is written once rather than three times with a chance of drifting.
 */
export function nextSortOrder(siblings: ReadonlyArray<{ sortOrder: number }>): number {
  const highest = siblings.reduce((max, sibling) => Math.max(max, sibling.sortOrder), 0);

  return highest + SORT_ORDER_STEP;
}

/** Gap between siblings, so one move is one write. */
export const SORT_ORDER_STEP = 10;
