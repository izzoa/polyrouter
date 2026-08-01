/**
 * Notification presentation (add-branded-notifications). PURE — no config
 * reads, no I/O, no clock: everything arrives through `RenderContext`, so the
 * whole surface is unit-testable and the delivery path can guard it wholesale.
 *
 * Two rules shape this module:
 *
 * 1. `renderEvent` is NOT modified. These renderers build ON it, so the plain
 *    text a recipient sees can never drift from the HTML, and the chat path
 *    keeps its existing wording byte-for-byte.
 * 2. Nothing here throws. Rendering happens inside `deliver()`, where a throw
 *    is retried and can end as a FAILED delivery — so a prettier message must
 *    never be able to convert a working notification into a lost one
 *    (invariant 11). `normalizeOrigin`/`validateAction` return null instead of
 *    letting `new URL()` throw.
 */
import { APP_NAME } from '@polyrouter/shared';
import { renderEvent, type EventType, type NotificationEvent } from './notification.types';

/** Injected presentation context — the ONE place configuration enters. */
export interface RenderContext {
  /** The instance's own origin, already normalized, or null when it is unset,
   * invalid, or loopback (a `127.0.0.1` link is useless in an inbox). */
  readonly origin: string | null;
  /** Footer identity. Defaults to the product name; injected so a future
   * per-instance label needs no renderer change. */
  readonly instanceName: string;
}

/** Apprise severity. `info` is the safe floor — an unrecognized type must
 * degrade, never fail a send. */
export type ChatSeverity = 'info' | 'success' | 'warning' | 'failure';

const SEVERITY: Record<EventType, ChatSeverity> = {
  provider_down: 'failure',
  budget_block: 'failure',
  budget_alert: 'warning',
  request_failures_spike: 'warning',
  weekly_spend_summary: 'info',
  test: 'info',
};

/** TOTAL over arbitrary strings — unlike the message body, a map lookup can
 * promise this, so it does (the body cannot: `renderEvent` is an exhaustive
 * switch with no runtime default, so an unknown type has no legacy text). */
export function severityFor(type: string): ChatSeverity {
  return SEVERITY[type as EventType] ?? 'info';
}

/** Which page each event's link targets. Type alone decides it — page-level
 * targets need no record id, and three event types carry none. */
const LINK_PAGE: Record<EventType, string> = {
  provider_down: 'providers',
  budget_alert: 'limits',
  budget_block: 'limits',
  weekly_spend_summary: 'costs',
  request_failures_spike: 'requests',
  test: 'settings',
};

/** Hosts whose links are worthless in a recipient's inbox. Private/RFC1918 and
 * `.local` are deliberately ABSENT: for a self-hosted instance those are
 * frequently the correct address for the LAN recipients being notified. */
function isLoopbackHost(hostname: string): boolean {
  // Node keeps the brackets on an IPv6 URL host (`[::1]`) — strip before
  // comparing, or the `::1` suppression silently misses (codex r4).
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * The trusted instance origin, or null. The configured value is validated only
 * as a generic URL upstream, which admits `javascript:`, `ftp:`, and
 * `user:pass@host` — none of which may become an `href` in a mail client.
 */
export function normalizeOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null; // never throws: this runs on the delivery path
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (isLoopbackHost(u.hostname)) return null;
  return u.origin;
}

/** A page-level deep link for an event type, or null when there is no usable
 * origin. Emits exactly `<origin>/#/<page>` — the fragment form the dashboard
 * router consumes; a path-style `/providers` would be inert against it. */
export function deepLink(eventType: string, origin: string | null): string | null {
  if (origin === null) return null;
  const page = LINK_PAGE[eventType as EventType];
  return page === undefined ? null : `${origin}/#/${page}`;
}

/**
 * Validate a caller-supplied action URL before it becomes an anchor. Unlike
 * `normalizeOrigin` this PRESERVES path, query, and fragment — the invite's
 * `#token=` and the reset's query ARE the payload; reducing to an origin would
 * strip exactly what makes those mails work.
 */
export function validateAction(raw: string | undefined | null, origin: string | null): string | null {
  if (!raw || origin === null) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.origin !== origin) return null; // same-instance only
  return u.href;
}

/** Escape for HTML text and double-quoted attribute contexts alike. */
export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BrandedEmail {
  readonly subject: string;
  readonly body: string;
  /** Already validated by the caller; null renders no anchor. */
  readonly action: string | null;
  /** Button text. Defaults to `Open <instance>`; the transactional mails name
   * their actual action instead, which is what a recipient is looking for. */
  readonly actionLabel?: string;
  /** Footer line. Defaults to the notification-channel explanation, which is
   * TRUE only for channel-delivered events — an invite or password reset is
   * not sent because anything is "subscribed", so those pass their own. */
  readonly footerNote?: string;
}

function actionLabel(mail: BrandedEmail, ctx: RenderContext): string {
  return mail.actionLabel ?? `Open ${ctx.instanceName}`;
}

function footerNote(mail: BrandedEmail, ctx: RenderContext): string {
  return (
    mail.footerNote ??
    `Sent by ${ctx.instanceName}. You are receiving this because a notification ` +
      `channel on this instance is subscribed to this event.`
  );
}

/**
 * The shared layout. ASSET-FREE by hard rule — a styled text wordmark and no
 * image, CID, web font, or external stylesheet — because a self-hosted
 * instance is frequently not publicly reachable, image blocking is the client
 * default, and remote assets would create an outbound-fetch surface. Tables +
 * inlined CSS because Outlook is not a CSS-grid engine; a system font stack
 * because the locked Geist cannot load in mail.
 */
export function renderBrandedEmail(mail: BrandedEmail, ctx: RenderContext): { text: string; html: string } {
  // The transactional callers write their link inline in the prose. That is
  // right for the TEXT part — a text-only recipient needs a URL they can copy
  // — but in HTML a full token URL printed out AND linked to itself is noise
  // that wraps badly. So the HTML strips the URL from the body and lets the
  // button carry it; the text part keeps the caller's wording verbatim.
  const bodyHasAction = mail.action !== null && mail.body.includes(mail.action);
  const text =
    mail.action === null || bodyHasAction ? mail.body : `${mail.body}\n\n${mail.action}`;
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const accent = '#4F5DFF';
  const htmlBody = (bodyHasAction && mail.action !== null
    ? mail.body.split(mail.action).join('')
    : mail.body)
    .replace(/[ \t]+$/gm, '') // trailing space left where the URL was
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Blank-line-separated paragraphs render as paragraphs; without this the
  // multi-paragraph transactional bodies collapse into one run-on line, since
  // HTML folds newlines.
  const paragraphs = htmlBody
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<div style="font:400 14px ${font};color:#374151;line-height:1.6;margin-bottom:10px">` +
        `${escapeHtml(p).replace(/\n/g, '<br>')}</div>`,
    )
    .join('');
  // EVERY email with an action gets the button — it is the call to action in a
  // notification and the whole point of a transactional mail.
  const action =
    mail.action === null
      ? ''
      : `<tr><td style="padding:10px 28px 4px 28px">` +
        `<a href="${escapeHtml(mail.action)}" style="display:inline-block;padding:9px 16px;` +
        `background:${accent};color:#ffffff;font:500 13px ${font};text-decoration:none;border-radius:8px">` +
        `${escapeHtml(actionLabel(mail, ctx))}</a></td></tr>`;
  const html =
    `<!--[if mso]><style>body{font-family:Arial,sans-serif}</style><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:#f6f7f9;padding:24px 0"><tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px">` +
    `<tr><td style="padding:20px 28px 0 28px">` +
    `<span style="font:600 15px ${font};color:${accent};letter-spacing:-0.01em">` +
    `${escapeHtml(ctx.instanceName)}</span></td></tr>` +
    `<tr><td style="padding:14px 28px 0 28px">` +
    `<div style="font:600 16px ${font};color:#111827;line-height:1.4">${escapeHtml(mail.subject)}</div></td></tr>` +
    `<tr><td style="padding:10px 28px 0 28px">${paragraphs}</td></tr>` +
    action +
    `<tr><td style="padding:22px 28px 20px 28px">` +
    `<div style="font:400 11.5px ${font};color:#9ca3af;line-height:1.5">` +
    `${escapeHtml(footerNote(mail, ctx))}</div></td></tr>` +
    `</table></td></tr></table>`;
  return { text, html };
}

/** Event → branded email. Subject and the WHOLE body come from `renderEvent`,
 * so the text part equals today's body exactly (plus the link line). */
export function renderNotificationEmail(
  event: NotificationEvent,
  ctx: RenderContext,
): { subject: string; text: string; html: string } {
  const { title, body } = renderEvent(event);
  const { text, html } = renderBrandedEmail(
    { subject: title, body, action: deepLink(event.type, ctx.origin) },
    ctx,
  );
  return { subject: title, text, html };
}

export interface RenderedChat {
  readonly title: string;
  readonly body: string;
  readonly type: ChatSeverity;
  readonly format: 'text';
}

/** Event → chat payload. The RENDERER owns presentation: severity and the link
 * line are resolved here, and the adapter emits what it is given — so exactly
 * one severity map exists and no transport is rendered twice. */
export function renderNotificationChat(event: NotificationEvent, ctx: RenderContext): RenderedChat {
  const { title, body } = renderEvent(event);
  const link = deepLink(event.type, ctx.origin);
  return {
    title,
    body: link === null ? body : `${body}\n${link}`,
    type: severityFor(event.type),
    // Explicit rather than implicit: pins today's default so a future Apprise
    // version cannot change it underneath us. Markdown is deferred — Apprise
    // converts across 100+ targets with uneven support, and a bare URL is
    // autolinked by every chat target anyway.
    format: 'text',
  };
}

/** The default context when no origin is configured (links omitted). */
export function defaultRenderContext(origin: string | null): RenderContext {
  return { origin, instanceName: APP_NAME };
}
