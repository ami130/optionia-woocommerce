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
import type { PurgeResult } from './hard-delete.service';
import { OptionSetsService } from './option-sets.service';
import type { AuthoringOptionSet, PublishedOptionSet } from './serialization/projections';

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

  /**
   * Permanent deletion (M7.2, "Delete (hard)").
   *
   * A distinct path rather than a flag on `DELETE`, because the two operations
   * have different preconditions and different consequences — and a query
   * parameter that silently turns a reversible action into an irreversible one
   * is the kind of API that produces a support ticket nobody can undo.
   *
   * Returns what was removed rather than 204: a merchant confirming an
   * irreversible act deserves to see its scope.
   */
  @Delete(':id/permanent')
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  async purge(@Param('id', ParseUUIDPipe) id: string): Promise<PurgeResult> {
    return this.service.purge(id);
  }

  /**
   * The whole set, in the dashboard's shape (M7.2b).
   *
   * Separate from `GET /option-sets/:id`, which returns the set alone: a list
   * row does not need the tree, and loading it for one would make the list
   * quadratically more expensive as merchants build.
   */
  @Get(':id/detail')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOneDetailed(@Param('id', ParseUUIDPipe) id: string): Promise<AuthoringOptionSet> {
    return this.service.findOneDetailed(id);
  }

  /**
   * What a storefront would receive if this set were published now.
   *
   * Built by the same serializer as the config document, so a preview cannot
   * show something a storefront would not.
   */
  @Get(':id/preview')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOnePublished(@Param('id', ParseUUIDPipe) id: string): Promise<PublishedOptionSet> {
    return this.service.findOnePublished(id);
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
