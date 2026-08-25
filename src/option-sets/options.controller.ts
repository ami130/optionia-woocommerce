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
import { CreateOptionDto, DuplicateOptionDto, UpdateOptionDto } from './dto/option.dto';
import type { Option } from './entities/option.entity';
import { OptionsService } from './options.service';

/**
 * Option routes nested under a group (M7.2), and the type registry's first
 * caller at the API boundary (M7.3).
 */
@Controller()
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionsController {
  constructor(private readonly service: OptionsService) {}

  @Get('groups/:id/options')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async list(@Param('id', ParseUUIDPipe) groupId: string): Promise<Option[]> {
    return this.service.listByGroup(groupId);
  }

  @Post('groups/:id/options')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async create(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateOptionDto,
  ): Promise<Option> {
    return this.service.create(groupId, dto);
  }

  @Get('options/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Option> {
    return this.service.findOne(id);
  }

  @Patch('options/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionDto,
  ): Promise<Option> {
    return this.service.update(id, dto);
  }

  @Delete('options/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Post('options/:id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateOptionDto,
  ): Promise<Option> {
    return this.service.duplicate(id, dto.key);
  }
}
