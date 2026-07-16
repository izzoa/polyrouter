import { Module } from '@nestjs/common';
import { PRODUCERS_CONFIG, resolveProducersConfig } from './producers.config';
import { SystemMailer } from './system-mailer';
import './producers.config';

/** The system mailer only (#15b) — server-wide SMTP config + `SystemMailer`,
 * with NONE of the notification/BullMQ/scheduler weight. `AuthModule` imports
 * this for the password-reset email so the auth plane doesn't pull in the
 * notification runtime (which would demand `NOTIFY_CREDENTIALS_SECRET` at boot). */
@Module({
  providers: [{ provide: PRODUCERS_CONFIG, useFactory: resolveProducersConfig }, SystemMailer],
  exports: [SystemMailer, PRODUCERS_CONFIG],
})
export class MailerModule {}
