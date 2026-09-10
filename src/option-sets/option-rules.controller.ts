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
  CreateOptionRuleDto,
  ReorderOptionRulesDto,
  UpdateOptionRuleDto,
} from './dto/option-rule.dto';
import type { OptionRule } from './entities/option-rule.entity';
import { OptionRulesService } from './option-rules.service';

/**
 * Conditional rule routes, nested under an option set.
 *
 * 🔴 **Nested under the SET, not a group.** A rule's conditions may name options
 * in any group, and its target may be a group, an option or a value anywhere in
 * the set — so a group is the wrong parent for it, and nesting under one would
 * imply a scope the engine does not have.
 *
 * The capability is `OPTION_SETS_EDIT` rather than a new one: a rule is part of
 * an option set's authored content, and someone trusted to price an option is not
 * separately untrusted with the logic that shows it. ⚠️ **Worth restating for
 * rules specifically**, because a rule can carry `set_price` (ADR-049) — but so
 * can the option it targets, through the same capability.
 */
@Controller()
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class OptionRulesController {
  constructor(private readonly service: OptionRulesService) {}

  @Get('option-sets/:id/rules')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async list(@Param('id', ParseUUIDPipe) optionSetId: string): Promise<OptionRule[]> {
    return this.service.listBySet(optionSetId);
  }

  @Post('option-sets/:id/rules')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async create(
    @Param('id', ParseUUIDPipe) optionSetId: string,
    @Body() dto: CreateOptionRuleDto,
  ): Promise<OptionRule> {
    return this.service.create(optionSetId, dto);
  }

  /**
   * Bulk reorder within a set. Editing, not a destructive act.
   *
   * ⚠️ **Order is presentation, not precedence** — M17.2 makes evaluation
   * order-independent. This decides what a merchant reads in the rule list.
   */
  @Post('option-sets/:id/rules/reorder')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async reorder(
    @Param('id', ParseUUIDPipe) optionSetId: string,
    @Body() dto: ReorderOptionRulesDto,
  ): Promise<OptionRule[]> {
    return this.service.reorder(optionSetId, dto.rules);
  }

  @Get('rules/:id')
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<OptionRule> {
    return this.service.findOne(id);
  }

  @Patch('rules/:id')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOptionRuleDto,
  ): Promise<OptionRule> {
    return this.service.update(id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  @ApiErrors(204, 400, 401, 403, 404, 429)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(id);
  }
}
