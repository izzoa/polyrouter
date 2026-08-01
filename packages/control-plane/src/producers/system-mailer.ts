import { Inject, Injectable } from '@nestjs/common';
import { deliverSmtp } from '../notifications/delivery/smtp.adapter';
import type { SmtpConfig } from '../notifications/channel-config';
import { PRODUCERS_CONFIG, type ProducersConfig } from './producers.config';
import { loadAuthConfig } from '../auth/auth.config';
import {
  defaultRenderContext,
  normalizeOrigin,
  renderBrandedEmail,
  validateAction,
} from '../notifications/render';

const SEND_TIMEOUT_MS = 15_000;

/** System-level transactional mailer (#15b) — used for auth's password-reset,
 * which has no user-configured channel. Sends via #15a's SSRF-guarded,
 * connect-time IP-pinned `deliverSmtp` using the server-wide `SMTP_*` defaults;
 * only fixed sanitized codes are thrown (no host/recipient/token). */
@Injectable()
export class SystemMailer {
  constructor(@Inject(PRODUCERS_CONFIG) private readonly cfg: ProducersConfig) {}

  /** True when server-wide SMTP is configured (host + from). */
  get configured(): boolean {
    return this.cfg.systemSmtp !== undefined;
  }

  /**
   * Send a system email. Throws a sanitized code on SMTP/SSRF failure; callers
   * detach this (never on a request's critical path).
   *
   * `text` is delivered VERBATIM — including any URL the caller embedded in it
   * — because the two callers lay their links out differently (reset inline in
   * a sentence, invite on its own line between paragraphs) and a text-only
   * recipient must keep seeing exactly today's mail. `action` is SEPARATE
   * metadata used only for the branded HTML anchor, and only after
   * `validateAction` accepts it; a rejected or absent action simply renders no
   * anchor (add-branded-notifications).
   */
  async send(args: {
    to: string;
    subject: string;
    text: string;
    action?: string;
    /** Button text; defaults to `Open <instance>`. */
    actionLabel?: string;
    /** Footer line; defaults to the notification-channel wording, which is
     * FALSE for transactional mail — these callers pass their own. */
    footerNote?: string;
  }): Promise<void> {
    const { to, subject, text, action, actionLabel, footerNote } = args;
    const smtp = this.cfg.systemSmtp;
    if (smtp === undefined) throw new Error('smtp_not_configured');
    const config: SmtpConfig = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user !== undefined ? { user: smtp.user } : {}),
      ...(smtp.pass !== undefined ? { pass: smtp.pass } : {}),
      from: smtp.from,
      to: [to],
    };
    // The RenderContext is built here rather than threaded from the queue:
    // transactional mail is outside the notification fan-out path entirely.
    const ctx = defaultRenderContext(normalizeOrigin(loadAuthConfig().auth.BETTER_AUTH_URL));
    const validated = validateAction(action, ctx.origin);
    let html: string | undefined;
    try {
      // `body` is the caller's text verbatim; renderBrandedEmail appends the
      // action only to ITS own text output, which we discard here — the text
      // part must stay byte-identical to what the caller wrote.
      html = renderBrandedEmail(
        {
          subject,
          body: text,
          action: validated,
          ...(actionLabel !== undefined ? { actionLabel } : {}),
          ...(footerNote !== undefined ? { footerNote } : {}),
        },
        ctx,
      ).html;
    } catch {
      html = undefined; // presentation never blocks a transactional send
    }
    await deliverSmtp(
      config,
      { title: subject, body: text, ...(html !== undefined ? { html } : {}) },
      { mode: this.cfg.mode, allowedEndpoints: this.cfg.allowedEndpoints },
      SEND_TIMEOUT_MS,
    );
  }
}
