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
import { CreateOptionDto, DuplicateOptionDto, UpdateOptionDto } from './dto/option.dto';
import type { Option } from './entities/option.entity';
import { OptionsService } from './options.service';

/**
 * Option routes nested under a group (M7.2), and the type registry's first
 * caller at the API boundary (M7.3).
 */
@Controller()
/**
 * Declares the realm in the generated spec (AC8).
 *
 * The guard chain below enforces it; this makes the spec say so, and a
 * generated client send the right token. Without it every operation reads
 * as public — the schemes were defined and referenced by nothing.
 */
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionsController {
  constructor(private readonly service: OptionsService) {}

  @Get('groups/:id/options')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async list(@Param('id', ParseUUIDPipe) groupId: string): Promise<Option[]> {
    return this.service.listByGroup(groupId);
  }

  @Post('groups/:id/options')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async create(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateOptionDto,
  ): Promise<Option> {
    return this.service.create(groupId, dto);
  }

  @Get('options/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Option> {
    return this.service.findOne(id);
  }

  @Patch('options/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(200, 400, 401, 403, 404, 409, 429)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionDto,
  ): Promise<Option> {
    return this.service.update(id, dto);
  }

  @Delete('options/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  @ApiErrors(201, 400, 401, 403, 404, 409, 429)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Post('options/:id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateOptionDto,
  ): Promise<Option> {
    return this.service.duplicate(id, dto.key);
  }
}
