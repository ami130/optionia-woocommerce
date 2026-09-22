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
import { TestRulesDto } from './dto/test-rules.dto';
import type { OptionRule } from './entities/option-rule.entity';
import { OptionRulesService } from './option-rules.service';
import { RuleTesterService, type RuleTestResult } from './rule-tester.service';

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
  constructor(
    private readonly service: OptionRulesService,
    private readonly tester: RuleTesterService,
  ) {}

  /**
   * "What would a customer see, given these answers?" (M17.6, ADR-053).
   *
   * 🔴 **`OPTION_SETS_VIEW`, not `EDIT`.** Evaluating rules changes nothing —
   * nothing is stored, nothing is charged — so a viewer may test what an editor
   * authored. Guarding it as a write would refuse the person most likely to be
   * checking whether a configuration behaves.
   *
   * ⚠️ **It reads the merchant's DRAFT.** A rule being tested has usually not
   * been published, and a tester that could not see it would answer a question
   * nobody asked. Deliberately the opposite of the config document, which is
   * built from published snapshots so it cannot ship unpublished edits.
   *
   * ⚠️ **`POST` for a read**, because the answers map can carry operands far past
   * what a query string should hold. ADR-053 records the trade.
   */
  @Post('option-sets/:id/rules/test')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async test(
    @Param('id', ParseUUIDPipe) optionSetId: string,
    @Body() dto: TestRulesDto,
  ): Promise<RuleTestResult> {
    return this.tester.test(optionSetId, dto.answers);
  }

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
