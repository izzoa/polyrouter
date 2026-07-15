import { createTransport } from 'nodemailer';
import { assertNetworkHostSafe, SsrfError } from '@polyrouter/shared/server';
import type { NotifyRuntime } from '../notify.config';
import type { SmtpConfig } from '../channel-config';

/**
 * Deliver over SMTP (#15a). SSRF-validated **at connect time** and pinned to the
 * validated IP (SNI preserved) so a rebind cannot redirect the socket. Throws
 * only sanitized codes — no host/recipient/error text reaches the caller/logs.
 */
export async function deliverSmtp(
  config: SmtpConfig,
  rendered: { title: string; body: string },
  rt: NotifyRuntime,
  timeoutMs: number,
): Promise<void> {
  let ip: string;
  try {
    ({ ip } = await assertNetworkHostSafe(config.host, config.port, {
      mode: rt.mode,
      allowedEndpoints: rt.allowedEndpoints,
    }));
  } catch (err) {
    // cause is retained for local debugging only; callers/log lines use .message (the code).
    throw new Error(err instanceof SsrfError ? 'smtp_host_blocked' : 'smtp_unresolvable', {
      cause: err,
    });
  }
  const transport = createTransport({
    host: ip, // pinned validated IP
    port: config.port,
    secure: config.secure === 'tls',
    requireTLS: config.secure === 'starttls',
    ignoreTLS: config.secure === 'none',
    tls: { servername: config.host }, // validate the cert against the real host
    ...(config.user !== undefined ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: [...config.to],
      subject: rendered.title,
      text: rendered.body,
    });
  } catch {
    throw new Error('smtp_send_failed');
  } finally {
    transport.close();
  }
}
