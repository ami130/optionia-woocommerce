import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ParentScopedRepository } from '../common/tenancy/parent-scoped.repository';
import { OptionValue } from './entities/option-value.entity';
import { nextSortOrder } from './option-groups.repository';

/**
 * Values, scoped through option → group → option set.
 *
 * Three joins. The depth is why this is a declared chain rather than a predicate
 * each query writes: by the third level, a hand-written scope is a matter of
 * remembering, and remembering is what AC5 exists to remove.
 */
@Injectable()
export class OptionValuesRepository extends ParentScopedRepository<OptionValue> {
  constructor(
    @InjectRepository(OptionValue)
    repository: Repository<OptionValue>,
  ) {
    super(repository, 'v', [
      { table: 'options', on: 'optionId' },
      { table: 'option_groups', on: 'optionGroupId' },
      { table: 'option_sets', on: 'optionSetId' },
    ]);
  }

  /** An option's values, in display order. */
  async listByOption(optionId: string): Promise<OptionValue[]> {
    return this.find({ where: { optionId }, order: { sortOrder: 'ASC' } });
  }

  async nextSortOrder(optionId: string): Promise<number> {
    return nextSortOrder(await this.listByOption(optionId));
  }

  /** Whether a value key is taken on an option. See `OptionsRepository.keyExists`. */
  async valueKeyExists(optionId: string, valueKey: string): Promise<boolean> {
    return this.exists({ optionId, valueKey } as never);
  }
}
