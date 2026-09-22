import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ParentScopedRepository } from '../common/tenancy/parent-scoped.repository';
import { OptionRule } from './entities/option-rule.entity';
import { nextSortOrder } from './option-groups.repository';

/**
 * Rules, scoped through their option set.
 *
 * ⚠️ **One join, not two.** A rule hangs directly off `option_sets`, exactly as a
 * group does — unlike an option (two joins) or a value (three). Copying the wrong
 * sibling's chain would produce a scope that silently never matches, or one that
 * matches too much; the base class applies whatever is declared here to every
 * read, so this list is the whole tenancy guarantee.
 *
 * 🔴 **`targetId` is deliberately not joined and never will be.** It points at a
 * group, an option or a value — three tables — and is not a foreign key by
 * design, so that a rule whose target is deleted survives to be flagged rather
 * than cascading away silently. Scoping therefore runs through `optionSetId`
 * alone, which is sufficient: a rule and everything it can target belong to the
 * same set.
 */
@Injectable()
export class OptionRulesRepository extends ParentScopedRepository<OptionRule> {
  constructor(
    @InjectRepository(OptionRule)
    repository: Repository<OptionRule>,
  ) {
    super(repository, 'r', [{ table: 'option_sets', on: 'optionSetId' }]);
  }

  /** A set's rules, in evaluation order. */
  async listBySet(optionSetId: string): Promise<OptionRule[]> {
    return this.find({ where: { optionSetId }, order: { sortOrder: 'ASC' } });
  }

  /**
   * How many rules a set already holds.
   *
   * Counted rather than derived from `listBySet().length` so the limit check does
   * not load every rule's conditions to decide whether one more may be created —
   * `MAX_CONDITIONS_BYTES` allows 16 KB apiece, so two hundred of them is three
   * megabytes read to answer a question about a number.
   */
  async countBySet(optionSetId: string): Promise<number> {
    return this.count({ where: { optionSetId } });
  }

  async nextSortOrder(optionSetId: string): Promise<number> {
    return nextSortOrder(await this.listBySet(optionSetId));
  }
}
