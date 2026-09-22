import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
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

  /**
   * Make one value the option's only default, in a single statement.
   *
   * **Read-then-write cannot express this.** Listing the siblings and clearing
   * each one races: two concurrent creates each read a list that does not yet
   * contain the other's row, then clear everything they *can* see — and the
   * result is an option with **no** default at all, which is worse than the two
   * defaults the rule exists to prevent. Verified by probe: four concurrent
   * creates with `isDefault` left zero.
   *
   * One `UPDATE … WHERE optionId = ? AND id <> ?` has no window: whichever
   * transaction commits last has cleared every row the others inserted.
   *
   * Scoped by hand because this bypasses the scoped read in order to be atomic,
   * so the ownership of `optionId` is verified by the caller and the predicate
   * is restated here. Covered by its own isolation test.
   */
  async makeSoleDefault(optionId: string, keepId: string): Promise<void> {
    await this.unsafeUnscopedRepository
      .createQueryBuilder()
      .update()
      .set({ isDefault: () => 'CASE WHEN id = :keepId THEN TRUE ELSE FALSE END' } as never)
      .where('optionId = :optionId', { optionId })
      .andWhere('deletedAt = :liveSentinel', { liveSentinel: LIVE_SENTINEL_SQL })
      .setParameter('keepId', keepId)
      .execute();
  }
}
