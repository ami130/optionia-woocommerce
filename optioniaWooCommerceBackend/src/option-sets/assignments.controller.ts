import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  AssignmentsService,
  type AssignmentView,
  type AssignmentTarget,
  type AssignmentWriteResult,
  type BulkUnassignResult,
  type TargetPreview,
} from './assignments.service';
import {
  ASSIGNABLE_TARGET_TYPES,
  AssignTargetsDto,
  UnassignTargetsDto,
} from './dto/assign-product.dto';
import { AssignmentTargetType } from '../common/database/enums';

/**
 * Which products an option set applies to (M13.6).
 *
 * The write half of the picker; `GET /products` is the read half. This is the
 * first place in the product that creates a `MANUAL` assignment — until now the
 * only source was `demo.seed.ts`, which is why Phase 10's renderer had nothing
 * real to resolve.
 */
@Controller('option-sets/:id/assignments')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class AssignmentsController {
  constructor(private readonly service: AssignmentsService) {}

  /**
   * A set's live assignments.
   *
   * `option_sets:view` rather than `products:assign`: reading which products a
   * set applies to is part of reading the set.
   */
  @Get()
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 401, 403, 404, 429)
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<AssignmentView[]> {
    return this.service.list(id);
  }

  /**
   * Assign the set to one or more targets.
   *
   * `200`, not `201`: the call is idempotent, so a repeat assigns nothing new
   * and creating a resource is not what happened. The response carries the
   * resulting assignment list and the new `configVersion`, so the dashboard can
   * show a merchant which revision their storefront needs to reach.
   *
   * ## Two request shapes, one of them deprecated
   *
   * `{ targets: [{ targetType, targetRef }] }` is the shape M19.1' adds, and the
   * only one that can reach a category, tag, attribute or price band.
   *
   * `{ externalProductIds: [...] }` is what shipped in M13.6 and still works,
   * read as `PRODUCT` targets. ⚠️ **Keeping it is not politeness.** A deployed
   * dashboard sends it, and the plugin's assignment resolution is the one path
   * where a rejected write is invisible to the merchant until an option stops
   * rendering. The old shape is removed when the dashboard no longer sends it,
   * not before.
   */
  @Post()
  @HttpCode(200)
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTargetsDto,
  ): Promise<AssignmentWriteResult> {
    return this.service.assign(id, this.readTargets(dto));
  }

  /**
   * The request's targets, whichever shape carried them.
   *
   * 🔴 **This normalisation cannot live in the DTO, and that was proved rather
   * than assumed.** `class-transformer` fixes an instance's properties from the
   * keys the *source object* has, so on a legacy body — which has no `targets`
   * key — a `@Transform` on `targets` never runs, and one on
   * `externalProductIds` that writes the sibling key runs after the property
   * list is settled. Both were tried; both left `targets` undefined and the
   * request rejected as "targets should not be empty", naming a field the
   * caller never sent. Here the whole validated body is in hand.
   *
   * The explicit shape wins when both arrive: it can express targets the legacy
   * field cannot, so preferring the narrower one would silently drop a category
   * the caller asked for.
   */
  private readTargets(dto: AssignTargetsDto): AssignmentTarget[] {
    if (dto.targets !== undefined) {
      return dto.targets;
    }

    /*
     * `??` only for exhaustiveness: `@ValidateIf` has already rejected a body
     * that carries neither field, so one of the two is always present here.
     */
    return (dto.externalProductIds ?? []).map((externalId) => ({
      targetType: AssignmentTargetType.PRODUCT,
      targetRef: externalId,
    }));
  }

  /**
   * How many products a target would apply to, before applying it (M19.5).
   *
   * 🔴 **A literal path, declared BEFORE `:targetRef`.** Nest matches routes in
   * declaration order, so a `@Get('preview')` placed after a `@Get(':ref')`
   * would never run — the parameterised route would claim the word "preview" as
   * a reference. Order here is behaviour, not tidiness.
   *
   * A `GET` because it changes nothing; the target travels as query parameters
   * for the same reason.
   */
  @Get('preview')
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('targetType') targetType: string | undefined,
    @Query('targetRef') targetRef: string | undefined,
  ): Promise<TargetPreview> {
    if (targetRef === undefined || targetRef === '') {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, 'A targetRef is required.');
    }

    return this.service.previewTarget(id, {
      targetType: this.readTargetType(targetType),
      targetRef,
    });
  }

  /**
   * Unassign many targets at once (M19.5).
   *
   * 🔴 **`POST .../unassign`, and the existing `DELETE /:targetRef` is
   * untouched.** That URL is what the shipped dashboard calls; changing it
   * would 404 every deployed client, which is the same reasoning that put
   * `targetType` in a query string rather than a second path segment.
   *
   * ⚠️ **Not a `DELETE` carrying a body.** RFC 9110 leaves a body on DELETE
   * undefined, and intermediaries and some fetch stacks drop it — a bulk
   * removal that silently removed nothing would look exactly like one that
   * worked.
   *
   * 📌 **A stale selection is not an error**, so this answers `200` with a
   * `removed` count rather than the single unassign's `404`. See
   * `AssignmentsService.unassignMany()`.
   */
  @Post('unassign')
  @HttpCode(200)
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async unassignMany(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnassignTargetsDto,
  ): Promise<BulkUnassignResult> {
    return this.service.unassignMany(id, dto.targets);
  }

  /**
   * Unassign one target.
   *
   * The reference is WooCommerce's — a product id, a category slug — so it is
   * **not** a UUID and must not be parsed as one; `ParseUUIDPipe` here would
   * reject every real reference.
   *
   * 🔴 **The type is a query parameter, not a second path segment.** `DELETE
   * /assignments/:ref` is the URL the shipped dashboard calls, and adding a
   * segment would 404 every one of those calls. `?targetType=` defaults to
   * `product`, so the existing URL keeps meaning exactly what it meant, while a
   * category assignment is removable at `?targetType=category`.
   *
   * ⚠️ **An unknown `targetType` is a 400, never a silent fallback to
   * `product`.** Coercing it would delete the wrong row whenever a category and
   * a product share a reference — and `targetRef` is unique only within a type,
   * so that collision is ordinary, not exotic.
   */
  @Delete(':targetRef')
  @HttpCode(200)
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async unassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetRef') targetRef: string,
    @Query('targetType') targetType?: string,
  ): Promise<AssignmentWriteResult> {
    return this.service.unassign(id, {
      targetType: this.readTargetType(targetType),
      targetRef,
    });
  }

  /**
   * A `targetType` query parameter, defaulted and checked.
   *
   * Absent means `product`: that is what every URL written before M19.1' meant,
   * and it is the only reading that keeps those URLs correct.
   */
  private readTargetType(raw: string | undefined): AssignmentTargetType {
    if (raw === undefined || raw === '') {
      return AssignmentTargetType.PRODUCT;
    }

    const known = (ASSIGNABLE_TARGET_TYPES as readonly string[]).includes(raw);

    if (!known) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Unknown assignment target type.',
      );
    }

    return raw as AssignmentTargetType;
  }
}
