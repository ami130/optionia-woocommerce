import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ApiBearerAuth } from '@nestjs/swagger';

import { ApiErrors } from '../common/openapi/api-errors.decorator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import {
  CreatePresentationalItemDto,
  ReorderPresentationalItemsDto,
  UpdatePresentationalItemDto,
} from './dto/presentational-item.dto';
import type { PresentationalItem } from './entities/presentational-item.entity';
import { PresentationalItemsService } from './presentational-items.service';

/**
 * Presentational item routes, nested under a group exactly as options are.
 *
 * 🔴 **The routes W2 found missing.** The table, entity, cascade handling and
 * both serialization paths shipped in Phase 5; nothing could create a row. These
 * eight routes are the inlet and the outlet.
 *
 * The capability is `OPTION_SETS_EDIT` rather than a new one: an item is part of
 * an option set's authored content, and someone trusted to add a price-bearing
 * option is not separately untrusted with a heading above it.
 */
@Controller()
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class PresentationalItemsController {
  constructor(private readonly service: PresentationalItemsService) {}

  @Get('groups/:id/items')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async list(@Param('id', ParseUUIDPipe) groupId: string): Promise<PresentationalItem[]> {
    return this.service.listByGroup(groupId);
  }

  @Post('groups/:id/items')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async create(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() dto: CreatePresentationalItemDto,
  ): Promise<PresentationalItem> {
    return this.service.create(groupId, dto);
  }

  /** Bulk reorder within a group. Editing, not a destructive act. */
  @Post('groups/:id/items/reorder')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async reorder(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() dto: ReorderPresentationalItemsDto,
  ): Promise<PresentationalItem[]> {
    return this.service.reorder(groupId, dto.items);
  }

  @Get('items/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PresentationalItem> {
    return this.service.findOne(id);
  }

  @Patch('items/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePresentationalItemDto,
  ): Promise<PresentationalItem> {
    return this.service.update(id, dto);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(204, 400, 401, 403, 404, 429)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(id);
  }
}
