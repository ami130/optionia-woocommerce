import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ParentScopedRepository } from '../common/tenancy/parent-scoped.repository';
import { Option } from './entities/option.entity';
import { nextSortOrder } from './option-groups.repository';

/**
 * Options, scoped through their group and that group's option set.
 *
 * Two joins rather than one: `options` reaches a tenant only via
 * `option_groups → option_sets`. The chain is declared once here and applied by
 * the base class to every read.
 */
@Injectable()
export class OptionsRepository extends ParentScopedRepository<Option> {
  constructor(
    @InjectRepository(Option)
    repository: Repository<Option>,
  ) {
    super(repository, 'o', [
      { table: 'option_groups', on: 'optionGroupId' },
      { table: 'option_sets', on: 'optionSetId' },
    ]);
  }

  /** A group's options, in display order. */
  async listByGroup(optionGroupId: string): Promise<Option[]> {
    return this.find({ where: { optionGroupId }, order: { sortOrder: 'ASC' } });
  }

  async nextSortOrder(optionGroupId: string): Promise<number> {
    return nextSortOrder(await this.listByGroup(optionGroupId));
  }

  /**
   * Whether a key is already taken in a group.
   *
   * `uq_options_group_key` is `(optionGroupId, key, deletedAt)`, so the database
   * is the real arbiter and a soft-deleted row frees its key for reuse. This
   * check exists to turn that collision into a precise field error instead of a
   * driver error surfacing as a 500 — the constraint stays the guarantee.
   */
  async keyExists(optionGroupId: string, key: string): Promise<boolean> {
    return this.exists({ optionGroupId, key } as never);
  }
}
