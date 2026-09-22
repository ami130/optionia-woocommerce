import type { MailKind } from '../common/database/enums';

/**
 * The mail boundary.
 *
 * Every message leaves through this interface, so the transport is swappable
 * without touching a single flow — the same reasoning M22.2 applies to billing
 * providers. Today it is SMTP; the production provider is still open (D4), and
 * that decision must not reach into the auth code.
 */

/** A message ready to send. Addresses and subject are already resolved. */
export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;

  /**
   * Template key, e.g. `verify-email`. Recorded on the delivery row so support
   * can answer "which message do you mean?" without reading the body.
   */
  readonly template: string;

  /**
   * What this message is for, which decides whether an unsubscribe silences it.
   *
   * 🔴 **Required, deliberately.** A default would have to be one of the two, and
   * either choice is wrong somewhere: defaulting to transactional lets a nudge
   * ignore an unsubscribe, and defaulting to lifecycle lets an unsubscribe
   * silence a password reset. Making every caller say costs one line and removes
   * both failures — the compiler names anyone who forgets.
   */
  readonly kind: MailKind;

  /** Both nullable: verification mail predates the tenant it belongs to. */
  readonly tenantId?: string | null;
  readonly userId?: string | null;
}

export interface SendResult {
  /** False when the address is suppressed — not an error, a deliberate refusal. */
  readonly sent: boolean;

  /** The provider's identifier, when there is one. Empty under SMTP. */
  readonly providerMessageId: string;

  /** Why it was not sent, for the delivery row. */
  readonly reason?: string;
}

/**
 * A transport. Implementations do exactly one thing: put bytes on the wire.
 *
 * They deliberately know nothing about suppression, delivery records or
 * retries — `MailService` owns that, so those rules cannot differ between
 * transports. A transport that decided for itself whether to send would make
 * "we never mail a suppressed address" a property of the transport rather than
 * of the system.
 */
export interface MailTransportDriver {
  readonly name: string;
  send(mail: OutgoingMail, from: string): Promise<{ providerMessageId: string }>;
}

/** Thrown when a transport fails. Carries the transport for the delivery row. */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly transport: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}
