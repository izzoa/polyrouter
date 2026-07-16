import { Inject, Injectable } from '@nestjs/common';
import { deliverSmtp } from '../notifications/delivery/smtp.adapter';
import type { SmtpConfig } from '../notifications/channel-config';
import { PRODUCERS_CONFIG, type ProducersConfig } from './producers.config';

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

  /** Send a plain-text system email. Throws a sanitized code on SMTP/SSRF
   * failure; callers detach this (never on a request's critical path). */
  async send(to: string, subject: string, text: string): Promise<void> {
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
    await deliverSmtp(
      config,
      { title: subject, body: text },
      { mode: this.cfg.mode, allowedEndpoints: this.cfg.allowedEndpoints },
      SEND_TIMEOUT_MS,
    );
  }
}
