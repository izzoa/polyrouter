/**
 * add-branded-notifications: pin the MIME contract at the RAW message level,
 * against a real nodemailer (no mock) using its stream transport — so this
 * proves what a recipient's client actually receives, not what we passed in.
 *
 * Deliberately separate from `smtp.adapter.spec.ts`, which mocks nodemailer
 * wholesale for the SSRF/pinning assertions and therefore cannot see a message.
 */
import { createTransport } from 'nodemailer';

/** Build the raw RFC822 message nodemailer would put on the wire. */
async function rawMessage(mail: {
  subject: string;
  text: string;
  html?: string;
}): Promise<string> {
  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = (await transport.sendMail({
    from: 'ops@example.test',
    to: 'alerts@example.test',
    ...mail,
  })) as unknown as { message: Buffer };
  return info.message.toString('utf8');
}

describe('SMTP MIME contract', () => {
  it('text + html produces multipart/alternative carrying BOTH parts', async () => {
    const raw = await rawMessage({
      subject: 'polyrouter — provider unavailable: OpenRouter',
      text: 'The circuit breaker for OpenRouter is open after repeated failures.',
      html: '<table><tr><td>The circuit breaker for OpenRouter is open.</td></tr></table>',
    });
    expect(raw).toMatch(/Content-Type:\s*multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type:\s*text\/plain/i);
    expect(raw).toMatch(/Content-Type:\s*text\/html/i);
    // Both bodies are actually present, not merely declared.
    expect(raw).toContain('is open after repeated failures.');
    expect(raw).toContain('<table>');
  });

  it('text alone stays a single text/plain part — no multipart, unchanged from before', async () => {
    const raw = await rawMessage({
      subject: 'polyrouter — weekly spend summary',
      text: 'Known spend this week: $12.00.',
    });
    expect(raw).not.toMatch(/multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type:\s*text\/plain/i);
    expect(raw).toContain('Known spend this week: $12.00.');
  });

  /**
   * PRE-EXISTING hardening, pinned rather than introduced (codex r2): subjects
   * interpolate user-controlled names, so a CRLF in one must not be able to
   * inject a header. nodemailer folds it into a single Subject; this test makes
   * that stay true.
   */
  it('a CRLF-bearing subject folds into ONE header and injects nothing', async () => {
    const raw = await rawMessage({
      subject: 'polyrouter — budget alert: Prod\r\nBcc: attacker@evil.test',
      text: 'body',
    });
    expect(raw).not.toMatch(/^Bcc:/im);
    expect((raw.match(/^Subject:/gim) ?? []).length).toBe(1);
  });
});
