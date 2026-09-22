import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/guards/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { requireTenantId } from '../common/context/request-context';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  ConnectService,
  type AuthorizeResult,
  type DescribeRequestResult,
  type ExchangeResult,
  type InitiateResult,
} from './connect.service';
import {
  AuthorizeDto,
  DescribeRequestDto,
  ExchangeDto,
  InitiateDto,
} from './dto/connect.dto';

/**
 * The connection handshake (M8.2).
 *
 * Two realms in one controller, which is unusual here and deliberate: `initiate`
 * is called by a plugin holding no credential, `authorize` by a merchant signed
 * in to the dashboard. They are the same flow and belong together; the guards
 * differ per route rather than per controller so neither inherits the other's.
 */
@Controller('connect')
export class ConnectController {
  constructor(private readonly service: ConnectService) {}

  /**
   * Begin a connection. **Unauthenticated by necessity** — no credential exists
   * yet, and issuing one is what the handshake is for.
   *
   * Its only defence is the rate limit, so that limit is the security control
   * rather than a courtesy: 10 per hour per site URL. A merchant retries a
   * failed connection a handful of times; a script enumerating shops does not.
   */
  @Post('initiate')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 429)
  async initiate(@Body() dto: InitiateDto): Promise<InitiateResult> {
    return this.service.initiate(dto);
  }

  /**
   * Approve connecting a site to the caller's tenant.
   *
   * `stores:connect` rather than an authoring capability: attaching a workspace
   * to a storefront is an ownership act, and an editor who can build options
   * should not be able to bind the tenant to a site they control. Owner and
   * admin hold it (M6.5).
   */
  /**
   * Redeem a code for a store credential, server-to-server.
   *
   * `@Public()` for the same reason as `initiate`: the plugin still holds no
   * credential — obtaining one is the point of the call. The PKCE verifier is
   * what authenticates it, and the rate limit bounds the rest.
   *
   * 20 per hour per site: a plugin redeems once per connection and retries a
   * failed exchange a few times. It keys on `site_url` through the same tracker
   * `initiate` uses, since the field is in the body.
   */
  @Post('exchange')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 429)
  async exchange(@Body() dto: ExchangeDto): Promise<ExchangeResult> {
    return this.service.exchange(dto);
  }

  /**
   * What a pending request is asking for (M13.3).
   *
   * The approval screen calls this before showing anything: it is what lets the
   * prompt name the **site** being connected rather than asking a merchant to
   * consent to an unnamed one.
   *
   * ## Guarded like `authorize`, and holding `state` besides
   *
   * Same guards and the same capability — reading which site is asking to
   * connect is part of connecting one. But the guards are not what protects it:
   * a pending request has **no tenant yet** (`tenantId` is written at
   * `authorize`), so tenant scoping cannot apply, and the `state` is the
   * credential that stops any signed-in user walking request ids.
   *
   * ## Rate limit
   *
   * 60 an hour, twice `authorize`'s: a merchant may reload the approval screen,
   * and each render is one call. Still far below anything useful for guessing,
   * where the search space is a UUID **and** a 43-character secret.
   */
  @Post('requests/describe')
  @UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
  @ApiBearerAuth('tenant')
  @RequireCapability(Capability.STORES_CONNECT)
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async describe(@Body() dto: DescribeRequestDto): Promise<DescribeRequestResult> {
    return this.service.describe(dto);
  }

  @Post('authorize')
  @UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
  @ApiBearerAuth('tenant')
  @RequireCapability(Capability.STORES_CONNECT)
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 429)
  async authorize(@Body() dto: AuthorizeDto): Promise<AuthorizeResult> {
    // Read from the context rather than the body: a tenant a caller could name
    // is a tenant a caller could choose.
    return this.service.authorize(dto, requireTenantId());
  }
}
