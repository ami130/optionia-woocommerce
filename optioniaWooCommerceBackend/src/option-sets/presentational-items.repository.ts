import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ParentScopedRepository } from '../common/tenancy/parent-scoped.repository';
import { PresentationalItem } from './entities/presentational-item.entity';
import { nextSortOrder } from './option-groups.repository';

/**
 * Presentational items, scoped exactly as options are.
 *
 * The same two joins: an item reaches a tenant only through
 * `option_groups → option_sets`. Declared here and applied by the base class to
 * every read, so a heading cannot leak across tenants any more than an option
 * can — the isolation is not a property of being "just decoration".
 */
@Injectable()
export class PresentationalItemsRepository extends ParentScopedRepository<PresentationalItem> {
  constructor(
    @InjectRepository(PresentationalItem)
    repository: Repository<PresentationalItem>,
  ) {
    super(repository, 'pi', [
      { table: 'option_groups', on: 'optionGroupId' },
      { table: 'option_sets', on: 'optionSetId' },
    ]);
  }

  /** A group's items, in display order. */
  async listByGroup(optionGroupId: string): Promise<PresentationalItem[]> {
    return this.find({ where: { optionGroupId }, order: { sortOrder: 'ASC' } });
  }

  async nextSortOrder(optionGroupId: string): Promise<number> {
    return nextSortOrder(await this.listByGroup(optionGroupId));
  }
}
