import { Inject, Injectable, Logger } from '@nestjs/common';
import { IDENTITY_PORT, type AdminInviteRecord, type IdentityPort } from '@polyrouter/shared/server';
import { SystemMailer } from '../producers/system-mailer';
import { loadAuthConfig } from './auth.config';
import { mintInviteToken } from './invite-token';

export interface IssuedInvite {
  invite: AdminInviteRecord;
  /** The one-time link carrying the raw token — returned to the admin ALWAYS
   * (copy-paste fallback), emailed only when server SMTP is configured. */
  link: string;
  emailSent: boolean;
}

/** Invite issuance (user-administration): mint → store hash+prefix only →
 * email via the server-wide SystemMailer when configured; the link is always
 * returned so an unconfigured/failed SMTP never bricks onboarding. The raw
 * token is never persisted or logged. */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  private readonly appUrl: string;

  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    private readonly mailer: SystemMailer,
  ) {
    this.appUrl = loadAuthConfig().auth.BETTER_AUTH_URL.replace(/\/$/, '');
  }

  async issue(email: string, createdBy: string): Promise<IssuedInvite> {
    const minted = mintInviteToken();
    const invite = await this.identity.userAdmin.createInvite({
      email: email.toLowerCase(),
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      createdBy,
      expiresAt: minted.expiresAt,
    });
    // Fragment, not query string: the token never reaches server access logs,
    // proxies, or Referer headers — only the SPA reads it (and scrubs it).
    const link = `${this.appUrl}/accept-invite#token=${minted.token}`;

    let emailSent = false;
    if (this.mailer.configured) {
      try {
        await this.mailer.send(
          invite.email,
          'You have been invited to polyrouter',
          `You've been invited to a polyrouter instance.\n\nAccept the invite and set your password here (link expires in 72 hours):\n${link}\n\nIf you weren't expecting this, ignore this email.`,
        );
        emailSent = true;
      } catch {
        // Sanitized: never the link/token. The admin still gets the copyable link.
        this.logger.warn('invite email failed to send — returning the link for manual delivery');
      }
    }
    return { invite, link, emailSent };
  }
}
