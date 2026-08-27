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
