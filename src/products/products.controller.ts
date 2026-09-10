import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { PaginatedResult } from '../common/http/api-response.types';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { DEFAULT_PRODUCT_PAGE_SIZE, ListProductsDto } from './dto/list-products.dto';
import { ProductsService, type ProductSummary } from './products.service';

/**
 * The merchant's catalogue, for the assignment picker (M13.6).
 *
 * Read-only by design — see `ProductsService`. `products:view` rather than
 * `products:assign`: browsing a catalogue is not assigning to it, and a `viewer`
 * who can see option sets but not the products they attach to cannot answer the
 * question their role exists to answer.
 */
@Controller('products')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  /**
   * A page of one store's catalogue.
   *
   * `storeId` is required. A tenant may have several stores, and merging their
   * catalogues would present two products with the same name on two storefronts
   * as though they were interchangeable.
   */
  @Get()
  @RequireCapability(Capability.PRODUCTS_VIEW)
  @ApiErrors(200, 400, 401, 403, 429)
  async list(@Query() query: ListProductsDto): Promise<PaginatedResult<ProductSummary>> {
    const page = await this.service.list(query);

    return new PaginatedResult(page.items, {
      cursor: page.cursor,
      hasMore: page.hasMore,
      limit: page.limit ?? DEFAULT_PRODUCT_PAGE_SIZE,
    });
  }
}
