import { buildResetPasswordSender } from './better-auth';
import type { SystemMailer } from '../producers/system-mailer';

const RESET_URL = 'https://app.test/reset?token=S3CRET-TOKEN-do-not-log';
const DATA = { user: { email: 'user@x.z' }, url: RESET_URL };

function fakeLogger() {
  const warns: string[] = [];
  return { logger: { warn: (m: string) => warns.push(m) }, warns };
}

describe('buildResetPasswordSender (#15b, detached)', () => {
  it('skips + warns when SMTP is unconfigured, never throwing', () => {
    const { logger, warns } = fakeLogger();
    const send = buildResetPasswordSender({ configured: false } as SystemMailer, logger);
    expect(() => send(DATA)).not.toThrow();
    expect(warns.join()).toContain('SMTP not configured');
  });

  it('returns synchronously even when the mailer never resolves (detached)', () => {
    const { logger } = fakeLogger();
    let sendCalled = false;
    const mailer = {
      configured: true,
      send: () => {
        sendCalled = true;
        return new Promise<void>(() => {}); // never resolves
      },
    } as unknown as SystemMailer;
    const send = buildResetPasswordSender(mailer, logger);
    expect(send(DATA)).toBeUndefined(); // returns immediately, does not await
    expect(sendCalled).toBe(true);
  });

  it('swallows a mailer rejection and never logs the token/url', async () => {
    const { logger, warns } = fakeLogger();
    const mailer = {
      configured: true,
      send: () => Promise.reject(new Error('smtp_send_failed')),
    } as unknown as SystemMailer;
    buildResetPasswordSender(mailer, logger)(DATA);
    await new Promise((r) => setImmediate(r)); // let the detached catch run
    expect(warns.join()).toContain('failed to send');
    expect(warns.join()).not.toContain('S3CRET-TOKEN');
    expect(warns.join()).not.toContain(RESET_URL);
  });
});
