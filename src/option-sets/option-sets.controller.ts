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
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { PaginatedResult } from '../common/http/api-response.types';
import {
  CreateOptionSetDto,
  DuplicateOptionSetDto,
  ListOptionSetsDto,
  UpdateOptionSetDto,
} from './dto/option-set.dto';
import type { OptionSet } from './entities/option-set.entity';
import { OptionSetsService } from './option-sets.service';

/**
 * Option set CRUD (M7.1).
 *
 * Every route is tenant-scoped at the **data layer**, not by a predicate a
 * handler remembers to add — `/option-sets/:id` names no tenant, so the scoping
 * is entirely the repository's job.
 *
 * `editor` can create and edit but not delete or publish: editing is safe, and
 * the destructive acts are ownership decisions. That split is the permission
 * matrix's, not this controller's, and it is declared per route so
 * `CapabilityGuard` can enforce it.
 */
@Controller('option-sets')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionSetsController {
  constructor(private readonly service: OptionSetsService) {}

  @Get()
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async list(@Query() query: ListOptionSetsDto): Promise<PaginatedResult<OptionSet>> {
    const page = await this.service.list(query);

    return new PaginatedResult(page.items, {
      cursor: page.cursor,
      hasMore: page.hasMore,
      limit: query.limit ?? 50,
    });
  }

  @Get(':id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<OptionSet> {
    return this.service.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async create(@Body() dto: CreateOptionSetDto): Promise<OptionSet> {
    return this.service.create(dto.name, dto.storeId);
  }

  @Patch(':id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionSetDto,
  ): Promise<OptionSet> {
    return this.service.update(id, { name: dto.name });
  }

  /**
   * Soft delete.
   *
   * 204 rather than the deleted body: there is nothing useful to return, and a
   * body invites a client to render something that no longer exists.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateOptionSetDto,
  ): Promise<OptionSet> {
    return this.service.duplicate(id, dto.name);
  }
}
