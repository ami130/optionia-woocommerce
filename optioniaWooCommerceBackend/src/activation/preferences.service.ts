import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserPreference } from './entities/user-preference.entity';

/** What the dashboard reads back. Wire shape, not the row. */
export interface DashboardPreferences {
  /** ISO timestamp, or null when the checklist has never been dismissed. */
  checklistDismissedAt: string | null;
}

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreference)
    private readonly preferences: Repository<UserPreference>,
  ) {}

  /**
   * One person's preferences, defaulted rather than created on read.
   *
   * 📌 **A missing row is a valid answer, not a reason to write one.** Every
   * merchant who has never dismissed anything would otherwise get a row written
   * on their first dashboard visit — a write on a read path, and a table that
   * grows with sign-ups rather than with decisions.
   */
  async forUser(userId: string): Promise<DashboardPreferences> {
    const row = await this.preferences.findOne({ where: { userId } });

    return {
      checklistDismissedAt: row?.checklistDismissedAt?.toISOString() ?? null,
    };
  }

  /**
   * Dismiss or restore the setup checklist.
   *
   * ## Why upsert rather than find-then-save
   *
   * 🔴 **Two dashboard tabs are one merchant.** A find-then-save races with
   * itself across tabs and, with `uq_user_preferences_user` in place, the loser
   * gets a duplicate-key error rather than the dismissal they asked for. The
   * unique index makes `ON DUPLICATE KEY UPDATE` correct by construction.
   *
   * ⚠️ **Restoring is the same call with `null`**, not a second endpoint. The
   * dashboard offers "show the checklist again", and a separate route would be
   * a second way to write one column.
   */
  async setChecklistDismissed(userId: string, dismissed: boolean): Promise<DashboardPreferences> {
    const at = dismissed ? new Date() : null;

    /*
     * 🔴 **`id` is generated here because the query builder bypasses the hook.**
     *
     * `BaseEntity` assigns a UUIDv7 in `@BeforeInsert`, which TypeORM runs for
     * `save()` and **not** for `createQueryBuilder().insert()` — the same trap
     * `publish.service.ts` documents. Without this the upsert failed with
     * `Field 'id' doesn't have a default value`, as a 500 on every dismissal.
     *
     * Found by probing the route, not by a type error: the builder's `.values()`
     * accepts a partial entity, so omitting the primary key compiles cleanly.
     *
     * 📌 The id is **only used when the row is new** — on the duplicate-key path
     * MySQL keeps the existing row and updates the one named column, so this
     * does not churn the primary key of a row that already exists.
     */
    await this.preferences
      .createQueryBuilder()
      .insert()
      .into(UserPreference)
      .values({ id: uuidv7(), userId, checklistDismissedAt: at })
      .orUpdate(['checklistDismissedAt'], ['userId'])
      .execute();

    return { checklistDismissedAt: at?.toISOString() ?? null };
  }
}
