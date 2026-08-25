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
import { CreateOptionValueDto, UpdateOptionValueDto } from './dto/option-value.dto';
import type { OptionValue } from './entities/option-value.entity';
import { OptionValuesService } from './option-values.service';

/**
 * Value routes nested under an option (M7.2).
 *
 * Values reach a tenant through three joins — option → group → set — which is
 * the depth at which a hand-written scope becomes a matter of remembering.
 */
@Controller()
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionValuesController {
  constructor(private readonly service: OptionValuesService) {}

  @Get('options/:id/values')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async list(@Param('id', ParseUUIDPipe) optionId: string): Promise<OptionValue[]> {
    return this.service.listByOption(optionId);
  }

  @Post('options/:id/values')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async create(
    @Param('id', ParseUUIDPipe) optionId: string,
    @Body() dto: CreateOptionValueDto,
  ): Promise<OptionValue> {
    return this.service.create(optionId, dto);
  }

  @Get('values/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<OptionValue> {
    return this.service.findOne(id);
  }

  @Patch('values/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionValueDto,
  ): Promise<OptionValue> {
    return this.service.update(id, dto);
  }

  @Delete('values/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }
}
