import { Module } from '@nestjs/common';

import { ConfigVersionService } from './config-version.service';

/**
 * The one place a store's content revision advances (M9.4b).
 *
 * Shared rather than owned by a domain, and deliberately so. Publishing lives
 * in `option-sets`, delivery in `config-delivery`, and the remaining triggers
 * M9.4b enumerates land in billing and store settings — different phases,
 * different modules, one rule. Putting the rule in either domain would make the
 * other import it, and `config-delivery` already imports `option-sets` for the
 * document builder: the cycle is not hypothetical, it appeared the moment this
 * was tried.
 *
 * The service has no dependencies of its own — it writes through the caller's
 * transaction — so a module holding nothing else is the honest shape.
 */
@Module({
  providers: [ConfigVersionService],
  exports: [ConfigVersionService],
})
export class ConfigVersionModule {}
