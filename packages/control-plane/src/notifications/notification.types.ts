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
  /** Optional per-event channel allow-list (#16 §5 `notify_channel_ids`): when
   * present, fan-out targets only these channel ids (intersected with the owner's
   * enabled + subscribed channels). Absent ⇒ all subscribed channels, as before. */
  readonly channelIds?: readonly string[];
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

/** Whether a channel receives this event: enabled, subscribed to the type, and —
 * when the event carries a per-event allow-list (#16 per-budget targeting) — in
 * that set. An absent allow-list means all subscribed channels (as before). */
export function channelMatchesEvent(
  channel: { readonly id: string; readonly enabled: boolean; readonly eventsSubscribed: string },
  event: NotificationEvent,
): boolean {
  if (!channel.enabled) return false;
  if (!channel.eventsSubscribed.split(',').includes(event.type)) return false;
  if (event.channelIds !== undefined && !event.channelIds.includes(channel.id)) return false;
  return true;
}

/** Render the human title/body from the structured fields (in the worker). */
/** Spend-provenance sentence (add-native-price-fallback): 'true' = includes
 * estimates; 'unknown' = the lookup failed — say so rather than implying exact. */
function estimateNote(v: unknown): string {
  if (v === 'true') return ' The metered spend includes estimate-priced components (native-family rates).';
  if (v === 'unknown') return ' Price provenance was unavailable for this notice.';
  return '';
}

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
        // Estimate provenance (add-native-price-fallback): never present
        // estimate-priced spend as exact. Metering itself is identical.
        body: `Spend ${f['spent'] ?? '?'} crossed the alert threshold ${f['threshold'] ?? '?'}.${estimateNote(f['spendEstimated'])}`,
      };
    case 'budget_block':
      return {
        title: `polyrouter — budget block: ${f['limitName'] ?? 'a budget'}`,
        body: `The budget ${f['limitName'] ?? ''} is blocking new requests until the window resets.${estimateNote(f['spendEstimated'])}`,
      };
    case 'weekly_spend_summary':
      return {
        // "Known spend": unknown-price rows count as 0, so an all-unknown owner
        // isn't shown a misleading total (#15b).
        title: 'polyrouter — weekly spend summary',
        body: `Known spend this week: ${f['total'] ?? '0'}.${f['estimatedSpend'] !== undefined ? ` Includes ${f['estimatedSpend']} priced by estimate (native-family or provider-listed rates).` : ''}`,
      };
  }
}
