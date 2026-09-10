import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

/** Request shapes for the connection handshake (M8.1, M8.2). */

/**
 * base64url, the alphabet PKCE and every token here use.
 *
 * Anchored at both ends so a value with a newline or a `?` cannot pass — these
 * strings end up in URLs and in `WHERE` clauses.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class InitiateDto {
  /**
   * The site starting the handshake.
   *
   * **`https://` only.** A credential returned over `http://` crosses the
   * network in plaintext, and the whole handshake exists to deliver one. Refused
   * at validation rather than later, so the failure names the cause.
   */
  @IsString()
  @MaxLength(255)
  @Matches(/^https:\/\/[^\s]+$/, {
    message: 'site_url must be an absolute https:// URL',
  })
  @ApiProperty({ type: String })
  site_url: string;

  /**
   * Where the approved code is delivered.
   *
   * Its origin must equal `site_url`'s — checked in the service, because
   * comparing two fields is beyond what a per-field decorator can express.
   * Accepting an arbitrary callback would let an attacker start a handshake for
   * someone else's shop and have the code delivered to a host they control.
   */
  @IsString()
  @MaxLength(500)
  @Matches(/^https:\/\/[^\s]+$/, {
    message: 'callback must be an absolute https:// URL',
  })
  @ApiProperty({ type: String })
  callback: string;

  /**
   * Where the cloud pushes "new configuration is available" (M9.4).
   *
   * A **different** URL from `callback`, and the distinction matters: `callback`
   * is a browser redirect to a WordPress admin screen, so a server posting there
   * reaches a login page rather than the plugin. This is the plugin's own REST
   * route, which authenticates by signature instead of by session.
   *
   * Optional, so a plugin build predating the route still connects. A store
   * without one falls back to the fifteen-minute conditional pull (M9.3) —
   * behind by minutes, not broken.
   *
   * Its origin must equal `site_url`'s, checked in the service alongside
   * `callback`'s, for the same reason: without it an attacker could start a
   * handshake for someone else's shop and have pushes delivered to a host they
   * control.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https:\/\/[^\s]+$/, {
    message: 'push_url must be an absolute https:// URL',
  })
  @ApiPropertyOptional({ type: String })
  push_url?: string;

  /**
   * The plugin's CSRF value, opaque to the cloud.
   *
   * Stored only as a SHA-256 hash and echoed through `authorize_url`. The lower
   * bound is 43 characters — 256 bits of base64url — because a shorter value is
   * guessable and this is the only thing tying a callback to the request that
   * started it.
   */
  @IsString()
  @Length(43, 128)
  @Matches(BASE64URL, { message: 'state must be URL-safe' })
  @ApiProperty({ type: String })
  state: string;

  /**
   * The PKCE challenge: `base64url(SHA-256(verifier))`.
   *
   * **Exactly 43 characters**, because that is the length of one SHA-256 digest
   * in base64url and nothing else is a valid S256 challenge. A range here would
   * accept a `plain` challenge, which is the downgrade S256 exists to prevent.
   */
  @IsString()
  @Length(43, 43)
  @Matches(BASE64URL, { message: 'challenge must be base64url' })
  @ApiProperty({ type: String })
  challenge: string;

  /** Telemetry: which plugin build started this handshake. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  plugin_version?: string;
}

export class AuthorizeDto {
  /** The request id carried by `authorize_url`. */
  @IsUUID()
  @ApiProperty({ type: String })
  request: string;

  /**
   * The `state` the dashboard read from `authorize_url`.
   *
   * Verified against the stored hash. The cloud cannot reconstruct the plaintext
   * — it holds only the digest — so this is both the CSRF check and the only
   * source for the `state` the final redirect must carry back.
   */
  @IsString()
  @Length(43, 128)
  @Matches(BASE64URL, { message: 'state must be URL-safe' })
  @ApiProperty({ type: String })
  state: string;
}

/**
 * Read a pending connection request, so the merchant can see what they approve.
 *
 * ## Why the same two fields as `AuthorizeDto`, and why a POST
 *
 * 🔴 **This cannot be tenant-scoped.** `tenantId` is written at `authorize`, not
 * at `initiate`, so a pending request belongs to *no tenant yet* — and a read
 * keyed on the id alone would be a **UUID-guessable oracle returning merchants'
 * site URLs** to any signed-in user.
 *
 * The `state` is the credential that closes it: 43-128 base64url, stored only as
 * a hash, compared in constant time. Requiring it means holding the id is not
 * enough — a caller must hold the secret the plugin generated.
 *
 * And that is why this is a **POST rather than a GET**: a secret in a query
 * string lands in browser history, `Referer` headers and server logs. The verb
 * describes the credential, not the effect; nothing is written.
 */
export class DescribeRequestDto {
  /** The request id carried by `authorize_url`. */
  @IsUUID()
  @ApiProperty({ type: String })
  request: string;

  /** The `state` from `authorize_url`. Verified against the stored hash. */
  @IsString()
  @Length(43, 128)
  @Matches(BASE64URL, { message: 'state must be URL-safe' })
  @ApiProperty({ type: String })
  state: string;
}

export class ExchangeDto {
  /**
   * The authorization code from the callback.
   *
   * Range rather than a fixed length: the cloud mints 43 characters today, and a
   * bound that assumed exactly that would break the moment the format changed —
   * on software that cannot be redeployed (M7.7).
   */
  @IsString()
  @Length(43, 128)
  @Matches(BASE64URL, { message: 'code must be URL-safe' })
  @ApiProperty({ type: String })
  code: string;

  /**
   * The PKCE verifier, whose SHA-256 must equal the stored challenge.
   *
   * The plugin generated this at `initiate` and kept it locally; only its digest
   * ever crossed the network. That is what stops an intercepted code being
   * redeemed by whoever intercepted it.
   */
  @IsString()
  @Length(43, 128)
  @Matches(BASE64URL, { message: 'verifier must be URL-safe' })
  @ApiProperty({ type: String })
  verifier: string;

  /**
   * The site redeeming the code, which must be the one that requested it.
   *
   * Compared **after normalisation**, not byte for byte: `initiate` stored a
   * normalised URL and WordPress reports `home_url( '/' )` with a trailing
   * slash, so a literal comparison would refuse every honest exchange.
   */
  @IsString()
  @MaxLength(255)
  @Matches(/^https:\/\/[^\s]+$/, {
    message: 'site_url must be an absolute https:// URL',
  })
  @ApiProperty({ type: String })
  site_url: string;
}

export class RotateCredentialDto {
  /**
   * Why the credential was rotated.
   *
   * Optional — a scheduled rotation has no story to tell, and requiring one
   * would train merchants to type "rotation". Recorded on the audit entry;
   * `store_credentials` has no column for it and does not need one.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  reason?: string;
}
