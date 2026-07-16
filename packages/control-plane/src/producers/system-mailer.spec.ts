import { SystemMailer } from './system-mailer';
import type { ProducersConfig } from './producers.config';
import { deliverSmtp } from '../notifications/delivery/smtp.adapter';

jest.mock('../notifications/delivery/smtp.adapter', () => ({
  deliverSmtp: jest.fn().mockResolvedValue(undefined),
}));
const deliverSmtpMock = deliverSmtp as jest.MockedFunction<typeof deliverSmtp>;

function cfg(systemSmtp: ProducersConfig['systemSmtp']): ProducersConfig {
  return {
    mode: 'selfhosted',
    allowedEndpoints: [],
    systemSmtp,
    failureThreshold: 20,
    failureWindowMs: 900_000,
    weeklyEnabled: false,
    weeklyCron: '0 8 * * 1',
  };
}

describe('SystemMailer', () => {
  beforeEach(() => deliverSmtpMock.mockClear());

  it('is not configured without a systemSmtp', () => {
    expect(new SystemMailer(cfg(undefined)).configured).toBe(false);
  });

  it('sends via deliverSmtp with a config built from the server-wide SMTP settings', async () => {
    const mailer = new SystemMailer(
      cfg({
        host: 'mail.example.com',
        port: 587,
        secure: 'starttls',
        user: 'u',
        pass: 'p',
        from: 'a@b.c',
      }),
    );
    expect(mailer.configured).toBe(true);
    await mailer.send('to@x.z', 'Subj', 'Body');
    expect(deliverSmtpMock).toHaveBeenCalledTimes(1);
    const [config, rendered, rt] = deliverSmtpMock.mock.calls[0]!;
    expect(config).toMatchObject({ host: 'mail.example.com', from: 'a@b.c', to: ['to@x.z'] });
    expect(rendered).toEqual({ title: 'Subj', body: 'Body' });
    expect(rt).toEqual({ mode: 'selfhosted', allowedEndpoints: [] });
  });

  it('throws a sanitized code when unconfigured (never reaches SMTP)', async () => {
    await expect(new SystemMailer(cfg(undefined)).send('to@x.z', 's', 'b')).rejects.toThrow(
      'smtp_not_configured',
    );
    expect(deliverSmtpMock).not.toHaveBeenCalled();
  });
});
