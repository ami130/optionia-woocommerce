import * as bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';

import { PlatformStaff } from '../admin/entities/platform-staff.entity';
import { StaffRole } from '../common/database/enums';
import { User } from '../users/entities/user.entity';
import { report } from './seed-context';

/**
 * The first platform administrator.
 *
 * Credentials come from the environment and are **never** hardcoded. A default
 * admin password in seed source is a default admin password in every deployment
 * that forgot to change it — and this account can impersonate any merchant.
 *
 * Skipped silently when the variables are absent, so `db:seed` remains useful
 * for a developer who only wants plans.
 */
const BCRYPT_COST = 12;

export async function seedSuperAdmin(dataSource: DataSource): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    report('super-admin', 0, 0);

    console.log('    skipped — set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one');

    return;
  }

  if (password.length < 12) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be at least 12 characters. This account can ' +
        'impersonate any merchant.',
    );
  }

  const users = dataSource.getRepository(User);
  const staff = dataSource.getRepository(PlatformStaff);

  let user = await users.findOne({ where: { email } });
  let created = 0;

  if (!user) {
    user = await users.save(
      users.create({
        email,
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        // Pre-verified: this account is created by whoever controls the
        // environment, so an email round-trip proves nothing extra.
        emailVerifiedAt: new Date(),
        name: 'Platform Administrator',
        locale: 'en',
      }),
    );
    created += 1;
  }

  const existingStaff = await staff.findOne({ where: { userId: user.id } });

  if (!existingStaff) {
    await staff.save(
      staff.create({
        userId: user.id,
        role: StaffRole.SUPER_ADMIN,
        grantedAt: new Date(),
      }),
    );
  }

  report('super-admin', created, created === 0 ? 1 : 0);
}
