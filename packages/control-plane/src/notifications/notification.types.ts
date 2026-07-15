import { createHash } from 'node:crypto';

/** The event types the notification service fans out (#15a). `budget_*` producers
 * are #16; `provider_down`/`request_failures_spike`/`weekly_spend_summary` are
 * #15b — the types + subscription plumbing live here so those changes just call
 * `emit`. Only `test` is produced in #15a (via test-send). */
export type EventType =
  | 'budget_alert'
  | 'budget_block'
  | 'provider_down'
  | 'request_failures_spike'
  | 'weekly_spend_summary'
  | 'test';

export const EVENT_TYPES: readonly EventType[] = [
  'budget_alert',
  'budget_block',
  'provider_down',
  'request_failures_spike',
  'weekly_spend_summary',
  'test',
];

/** Scope identifies the owner (whose channels receive it) + optional
 * discriminators. `lifecycleId` (a budget period, a provider incident, a summary
 * week) distinguishes distinct lifecycles so dedup doesn't merge them. */
export interface EventScope {
  readonly ownerUserId: string;
  readonly providerId?: string;
  readonly agentId?: string;
  readonly limitId?: string;
  readonly lifecycleId?: string;
}

/**
 * A structured event. `fields` is **non-secret operator-facing display metadata**
 * (a producer contract — no URLs, tokens, or raw errors); the worker renders the
 * human title/body from it. Never carries a credential.
 */
export interface NotificationEvent {
  readonly type: EventType;
  readonly scope: EventScope;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

/** Canonical, collision-safe scope serialization for dedup. */
export function scopeKey(event: NotificationEvent): string {
  const s = event.scope;
  return [
    event.type,
    s.ownerUserId,
    s.providerId ?? '',
    s.agentId ?? '',
    s.limitId ?? '',
    s.lifecycleId ?? '',
  ].join('|');
}

/** Opaque dedup id (no `:` — BullMQ reserves it) from the scope key. */
export function dedupId(event: NotificationEvent): string {
  return `dd${createHash('sha256').update(scopeKey(event)).digest('hex').slice(0, 32)}`;
}

/** Opaque per-channel delivery id, bucketed to the fan-out timestamp so a
 * retry crossing a window boundary can't mint fresh ids. */
export function deliveryId(
  event: NotificationEvent,
  channelId: string,
  windowBucket: number,
): string {
  return `dl${createHash('sha256')
    .update(`${scopeKey(event)}|${channelId}|${windowBucket}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/** Anti-spam window per type (ms). 0 = no dedup (test). Producers set
 * `lifecycleId` so a *new* lifecycle is not suppressed by the previous window. */
const WINDOW_MS: Record<EventType, number> = {
  test: 0,
  provider_down: 3_600_000,
  request_failures_spike: 900_000,
  weekly_spend_summary: 6 * 86_400_000,
  budget_alert: 3_600_000,
  budget_block: 3_600_000,
};
export function windowMs(type: EventType): number {
  return WINDOW_MS[type];
}

/** Render the human title/body from the structured fields (in the worker). */
export function renderEvent(event: NotificationEvent): { title: string; body: string } {
  const f = event.fields;
  switch (event.type) {
    case 'test':
      return {
        title: 'polyrouter — test notification',
        body: `This is a test notification from your "${f['channelName'] ?? 'channel'}" channel.`,
      };
    case 'provider_down':
      return {
        title: `polyrouter — provider unavailable: ${f['providerName'] ?? 'a provider'}`,
        body: `The circuit breaker for ${f['providerName'] ?? 'a provider'} is open after repeated failures.`,
      };
    case 'request_failures_spike':
      return {
        title: 'polyrouter — request failure spike',
        body: `${f['count'] ?? 'Several'} failed requests in the recent window.`,
      };
    case 'budget_alert':
      return {
        title: `polyrouter — budget alert: ${f['limitName'] ?? 'a budget'}`,
        body: `Spend ${f['spent'] ?? '?'} crossed the alert threshold ${f['threshold'] ?? '?'}.`,
      };
    case 'budget_block':
      return {
        title: `polyrouter — budget block: ${f['limitName'] ?? 'a budget'}`,
        body: `The budget ${f['limitName'] ?? ''} is blocking new requests until the window resets.`,
      };
    case 'weekly_spend_summary':
      return {
        title: 'polyrouter — weekly spend summary',
        body: `Total spend this week: ${f['total'] ?? '0'}.`,
      };
  }
}
