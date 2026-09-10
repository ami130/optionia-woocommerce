import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { StoreProduct } from './entities/store-product.entity';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * The merchant's catalogue (M13.6, Phase 13 Stage 0).
 *
 * Its own module rather than a controller under `stores/`: a catalogue is a
 * mirror of an external system with its own sync lifecycle
 * ([M19](../../developePlan.md)), which is a different reason to change from
 * connection, heartbeat and ownership.
 *
 * The repository is exported because assignment validation needs its ownership
 * check (finding **A3**) — reaching into another module's data through its own
 * repository is how two places come to disagree about what scoping means.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StoreProduct]), AuthModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}
