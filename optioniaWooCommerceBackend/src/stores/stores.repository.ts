import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantScopedRepository } from '../common/tenancy/tenant-scoped.repository';
import { Store } from './entities/store.entity';

/**
 * Stores, tenant-scoped.
 *
 * `stores` carries `tenant_id` directly, so the predicate is a column comparison
 * rather than a join chain.
 *
 * **This is what makes `/stores/:id` answer 404 rather than 403 for another
 * tenant's store** (ADR-010). The scoping is the repository's, not a `WHERE`
 * a handler remembers to add — a 403 would confirm the store exists, which is
 * exactly what an enumerating caller wants to learn.
 */
@Injectable()
export class StoresRepository extends TenantScopedRepository<Store> {
  constructor(
    @InjectRepository(Store)
    repository: Repository<Store>,
  ) {
    super(repository);
  }
}
