import { renderEvent, type EventType, type NotificationEvent } from './notification.types';
import {
  defaultRenderContext,
  deepLink,
  escapeHtml,
  normalizeOrigin,
  renderBrandedEmail,
  renderNotificationChat,
  renderNotificationEmail,
  severityFor,
  validateAction,
  type RenderContext,
} from './render';

const ORIGIN = 'https://poly.example.com';
const ctx: RenderContext = { origin: ORIGIN, instanceName: 'polyrouter' };
const noLinkCtx: RenderContext = { origin: null, instanceName: 'polyrouter' };

const EVENTS: EventType[] = [
  'test',
  'provider_down',
  'request_failures_spike',
  'budget_alert',
  'budget_block',
  'weekly_spend_summary',
];

const ev = (type: EventType, fields: Record<string, string | number | boolean> = {}): NotificationEvent => ({
  type,
  scope: { ownerUserId: 'u1' },
  fields,
});

/** Fields that exercise every multi-sentence body branch, so the byte-identity
 * assertion covers the appended estimate/basis clauses too. */
const richFields: Partial<Record<EventType, Record<string, string | number | boolean>>> = {
  budget_alert: {
    limitName: 'Prod cap',
    spent: '$9.10',
    threshold: '$9.00',
    spendEstimated: 'true',
    meteringBasis: 'notional',
  },
  budget_block: { limitName: 'Prod cap', spendEstimated: 'unknown', meteringBasis: 'notional' },
  weekly_spend_summary: { total: '$12.00', estimatedSpend: '$3.00' },
  provider_down: { providerName: 'OpenRouter' },
  request_failures_spike: { count: 12 },
  test: { channelName: 'Ops' },
};

describe('normalizeOrigin', () => {
  it('accepts http/https and reduces to the origin', () => {
    expect(normalizeOrigin('https://poly.example.com/dash?x=1#/costs')).toBe(ORIGIN);
    expect(normalizeOrigin('http://poly.example.com:3001')).toBe('http://poly.example.com:3001');
  });

  it('rejects hostile schemes and embedded credentials', () => {
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('ftp://poly.example.com')).toBeNull();
    expect(normalizeOrigin('https://user:pass@poly.example.com')).toBeNull();
  });

  it('suppresses LITERAL loopback only — including bracketed IPv6', () => {
    for (const raw of [
      'http://127.0.0.1:3001',
      'http://127.0.0.5:3001',
      'http://localhost:3001',
      'http://[::1]:3001', // Node keeps the brackets on hostname (codex r4)
    ]) {
      expect(normalizeOrigin(raw)).toBeNull();
    }
  });

  it('KEEPS a LAN address — correct for a self-hosted instance’s recipients', () => {
    expect(normalizeOrigin('http://192.168.1.10:3001')).toBe('http://192.168.1.10:3001');
    expect(normalizeOrigin('http://poly.local:3001')).toBe('http://poly.local:3001');
  });

  it('never throws on garbage, and treats unset as no origin', () => {
    for (const raw of ['', '   ', 'not a url', '://', undefined, null]) {
      expect(normalizeOrigin(raw as string)).toBeNull();
    }
  });
});

describe('deepLink', () => {
  it('maps each event type to its exact page URL', () => {
    expect(deepLink('provider_down', ORIGIN)).toBe(`${ORIGIN}/#/providers`);
    expect(deepLink('budget_alert', ORIGIN)).toBe(`${ORIGIN}/#/limits`);
    expect(deepLink('budget_block', ORIGIN)).toBe(`${ORIGIN}/#/limits`);
    expect(deepLink('weekly_spend_summary', ORIGIN)).toBe(`${ORIGIN}/#/costs`);
    expect(deepLink('request_failures_spike', ORIGIN)).toBe(`${ORIGIN}/#/requests`);
    expect(deepLink('test', ORIGIN)).toBe(`${ORIGIN}/#/settings`);
  });

  it('is null without an origin, and for an unknown event type', () => {
    expect(deepLink('provider_down', null)).toBeNull();
    expect(deepLink('not_an_event', ORIGIN)).toBeNull();
  });
});

describe('validateAction', () => {
  it('PRESERVES path, query, and fragment — the token is the payload', () => {
    const invite = `${ORIGIN}/accept-invite#token=s3cret`;
    expect(validateAction(invite, ORIGIN)).toBe(invite);
    const reset = `${ORIGIN}/reset?token=abc&x=1`;
    expect(validateAction(reset, ORIGIN)).toBe(reset);
  });

  it('rejects hostile scheme, credentials, and cross-origin', () => {
    expect(validateAction('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(validateAction(`https://user:pass@poly.example.com/x`, ORIGIN)).toBeNull();
    expect(validateAction('https://evil.example.com/accept-invite#token=s', ORIGIN)).toBeNull();
  });

  it('is null when there is no trusted origin to compare against', () => {
    expect(validateAction(`${ORIGIN}/x`, null)).toBeNull();
  });
});

describe('severityFor', () => {
  it('maps the known types', () => {
    expect(severityFor('provider_down')).toBe('failure');
    expect(severityFor('budget_block')).toBe('failure');
    expect(severityFor('budget_alert')).toBe('warning');
    expect(severityFor('request_failures_spike')).toBe('warning');
    expect(severityFor('weekly_spend_summary')).toBe('info');
    expect(severityFor('test')).toBe('info');
  });

  it('is TOTAL over arbitrary strings — an unknown type degrades to info', () => {
    expect(severityFor('who_knows')).toBe('info');
    expect(severityFor('')).toBe('info');
  });
});

describe('renderNotificationEmail', () => {
  it('text part equals the WHOLE legacy body verbatim, per event type', () => {
    for (const type of EVENTS) {
      const e = ev(type, richFields[type] ?? {});
      const legacy = renderEvent(e);
      // No link available → byte-identical to today.
      const plain = renderNotificationEmail(e, noLinkCtx);
      expect(plain.subject).toBe(legacy.title);
      expect(plain.text).toBe(legacy.body);
      // With a link → the same body, then a blank line and the URL. Nothing else.
      const linked = renderNotificationEmail(e, ctx);
      expect(linked.text).toBe(`${legacy.body}\n\n${deepLink(type, ORIGIN)!}`);
    }
  });

  it('covers the multi-sentence bodies explicitly (estimate + basis clauses)', () => {
    const e = ev('budget_alert', richFields.budget_alert);
    const legacy = renderEvent(e);
    expect(legacy.body).toContain('estimate-priced'); // multi-sentence by construction
    expect(legacy.body).toContain('subscription usage');
    expect(renderNotificationEmail(e, noLinkCtx).text).toBe(legacy.body);
  });

  it('HTML references no external resource, and at most one anchor', () => {
    for (const type of EVENTS) {
      const { html } = renderNotificationEmail(ev(type, richFields[type] ?? {}), ctx);
      // Attribute allowlist, not a substring scan: a regex for "http" would
      // miss protocol-relative and url(...) forms entirely.
      expect(html).not.toMatch(/\ssrc\s*=/i);
      expect(html).not.toMatch(/\ssrcset\s*=/i);
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/url\s*\(/i);
      expect(html).not.toMatch(/\bcid:/i);
      expect(html).not.toMatch(/@font-face/i);
      expect(html).not.toMatch(/<form\b|\saction\s*=/i);
      expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
      expect(html).not.toMatch(/<img\b|<image\b|<iframe\b|<script\b/i);
      const anchors = html.match(/<a\s/gi) ?? [];
      expect(anchors.length).toBe(1);
      expect(html).toContain(`href="${deepLink(type, ORIGIN)!}"`);
    }
  });

  it('omits the anchor entirely when no origin is usable', () => {
    const { html } = renderNotificationEmail(ev('provider_down', { providerName: 'X' }), noLinkCtx);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/href=/i);
  });
});

describe('escaping', () => {
  const hostile = `<script>alert("x")&'`;

  it('escapes hostile values in every dynamic slot, text unchanged', () => {
    const e = ev('provider_down', { providerName: hostile });
    const legacy = renderEvent(e);
    const out = renderNotificationEmail(e, ctx);
    // Text keeps them raw (inert there), exactly as before this change.
    expect(out.text).toBe(`${legacy.body}\n\n${deepLink('provider_down', ORIGIN)!}`);
    expect(out.text).toContain(hostile);
    // HTML: no live markup, no attribute break.
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&quot;');
    expect(out.html).toContain('&#39;');
  });

  it('escapes the footer instance identity and the subject too', () => {
    const hostileCtx: RenderContext = { origin: ORIGIN, instanceName: hostile };
    const { html } = renderBrandedEmail({ subject: hostile, body: hostile, action: null }, hostileCtx);
    expect(html).not.toContain('<script>');
    expect((html.match(/&lt;script&gt;/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('escapes an action URL in attribute position', () => {
    const tricky = `${ORIGIN}/x?a=1&b=2`;
    const { html } = renderBrandedEmail({ subject: 's', body: 'b', action: tricky }, ctx);
    expect(html).toContain('href="https://poly.example.com/x?a=1&amp;b=2"');
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });
});

describe('the action is inline, never duplicated', () => {
  const link = `${ORIGIN}/reset-password?token=abc`;

  it('strips the URL from the HTML body and carries it on the button instead', () => {
    const body = `Reset your password: ${link}`;
    const { text, html } = renderBrandedEmail(
      { subject: 'Reset', body, action: link, actionLabel: 'Reset password' },
      ctx,
    );
    // The raw URL is not printed as VISIBLE TEXT — a full token URL written out
    // and linked to itself is noise that wraps badly. It lives in the href only.
    const visible = html.replace(/href="[^"]*"/g, 'href=""');
    expect(visible).not.toContain('reset-password?token=abc');
    expect(html).toContain('Reset your password:');
    // Exactly one anchor: the button, carrying the real destination.
    expect((html.match(/<a\s/gi) ?? []).length).toBe(1);
    expect(html).toContain(`href="${escapeHtml(link)}"`);
    expect(html).toContain('Reset password</a>');
    expect(html).toContain('display:inline-block'); // a button, not a text link
    // The TEXT part is the caller's wording VERBATIM — a text-only recipient
    // still gets a URL they can copy, exactly once.
    expect(text).toBe(body);
    expect((text.match(/reset-password/g) ?? []).length).toBe(1);
  });

  it('the footer explains the ACTUAL reason, not a false subscription claim', () => {
    // Default (channel-delivered events) keeps the subscription wording…
    const evt = renderNotificationEmail(ev('provider_down', { providerName: 'X' }), ctx);
    expect(evt.html).toContain('notification channel on this instance is subscribed');
    // …but transactional mail is NOT sent because anything is subscribed.
    const { html } = renderBrandedEmail(
      { subject: 'Invite', body: 'b', action: link, footerNote: 'Sent because an administrator invited you.' },
      ctx,
    );
    expect(html).toContain('Sent because an administrator invited you.');
    expect(html).not.toContain('subscribed to this event');
  });

  it('renders blank-line-separated paragraphs instead of one run-on line', () => {
    const body = `First para.\n\nSecond para:\n${link}\n\nThird para.`;
    const { html } = renderBrandedEmail({ subject: 's', body, action: link }, ctx);
    expect((html.match(/margin-bottom:10px/g) ?? []).length).toBe(3);
    expect(html).toContain('First para.');
    expect(html).toContain('Third para.');
    expect(html).not.toContain('EXAMPLE');
  });

  it('a body WITHOUT the URL keeps the button — the link IS the point there', () => {
    const { text, html } = renderBrandedEmail(
      { subject: 'Provider unavailable', body: 'The circuit breaker is open.', action: `${ORIGIN}/#/providers` },
      ctx,
    );
    expect((html.match(/<a\s/gi) ?? []).length).toBe(1);
    expect(html).toContain('Open polyrouter');
    // A real filled button, not an underlined text link.
    expect(html).toContain('display:inline-block');
    expect(html).toContain('border-radius:8px');
    expect(html).toContain('text-decoration:none');
    expect(text).toBe(`The circuit breaker is open.\n\n${ORIGIN}/#/providers`);
  });

  it('escapes a hostile action even while linkifying in place', () => {
    const nasty = `${ORIGIN}/x?a=1&b=2`;
    const { html } = renderBrandedEmail(
      { subject: 's', body: `Go here: ${nasty}`, action: nasty },
      ctx,
    );
    expect(html).toContain('href="https://poly.example.com/x?a=1&amp;b=2"');
    expect(html).not.toContain('a=1&b=2"'); // raw ampersand never emitted
  });
});

describe('renderNotificationChat', () => {
  it('carries severity, explicit format, and the link on its own line', () => {
    const e = ev('provider_down', { providerName: 'OpenRouter' });
    const legacy = renderEvent(e);
    const out = renderNotificationChat(e, ctx);
    expect(out).toMatchObject({ title: legacy.title, type: 'failure', format: 'text' });
    expect(out.body).toBe(`${legacy.body}\n${ORIGIN}/#/providers`);
  });

  it('body is byte-identical to today when no link is available', () => {
    for (const type of EVENTS) {
      const e = ev(type, richFields[type] ?? {});
      expect(renderNotificationChat(e, noLinkCtx).body).toBe(renderEvent(e).body);
    }
  });
});

describe('defaultRenderContext', () => {
  it('names the product and carries the origin through', () => {
    expect(defaultRenderContext(ORIGIN)).toEqual({ origin: ORIGIN, instanceName: 'polyrouter' });
    expect(defaultRenderContext(null).origin).toBeNull();
  });
});
