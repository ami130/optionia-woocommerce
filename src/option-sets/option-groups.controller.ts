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

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import {
  CreateOptionGroupDto,
  DuplicateOptionGroupDto,
  ReorderGroupsDto,
  UpdateOptionGroupDto,
} from './dto/option-group.dto';
import type { OptionGroup } from './entities/option-group.entity';
import { OptionGroupsService } from './option-groups.service';

/**
 * Group routes nested under an option set (M7.2).
 *
 * Creating and listing are nested because a group has no meaning without its
 * set; editing and deleting are addressed by id alone, because a group id is
 * already unique and requiring the parent in the path would let a client pair a
 * real group with the wrong set.
 *
 * Neither path names a tenant. Scoping is entirely the parent-scoped
 * repository's join — which is why it was built before any of these endpoints.
 */
@Controller()
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionGroupsController {
  constructor(private readonly service: OptionGroupsService) {}

  @Get('option-sets/:id/groups')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async list(
    @Param('id', ParseUUIDPipe) optionSetId: string,
  ): Promise<OptionGroup[]> {
    return this.service.listBySet(optionSetId);
  }

  @Post('option-sets/:id/groups')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async create(
    @Param('id', ParseUUIDPipe) optionSetId: string,
    @Body() dto: CreateOptionGroupDto,
  ): Promise<OptionGroup> {
    return this.service.create(optionSetId, dto);
  }

  @Get('groups/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<OptionGroup> {
    return this.service.findOne(id);
  }

  @Patch('groups/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionGroupDto,
  ): Promise<OptionGroup> {
    return this.service.update(id, dto);
  }

  /** 204: a deleted group has no representation to return. */
  @Delete('groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Post('groups/:id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateOptionGroupDto,
  ): Promise<OptionGroup> {
    return this.service.duplicate(id, dto.label);
  }

  /**
   * Bulk reorder. Editing rather than a distinct capability: rearranging is a
   * normal authoring act, not a destructive one.
   */
  @Post('option-sets/:id/reorder')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async reorder(
    @Param('id', ParseUUIDPipe) optionSetId: string,
    @Body() dto: ReorderGroupsDto,
  ): Promise<OptionGroup[]> {
    return this.service.reorder(optionSetId, dto.groups);
  }
}
