/**
 * The dashboard's own field checks, each reporting on the field it concerns
 * (adopt-design-tokens-v2 task 8.2; design.md D20; dashboard-core "Entry controls show help,
 * invalid, read-only and disabled states").
 *
 * Every check a store-backed form runs lives here, keyed by the DOM id of the field it is
 * about. A form's submit runs its fields' checks and stops on any failure; a field's blur runs
 * its own; an edit only clears a message once the value passes, so nothing turns invalid on a
 * keystroke. A failure only the server reports (an `err(e)` message) names no field and stays
 * in its form's `error` slot.
 *
 * A message names the problem and its fix. The ones that existed before keep their wording;
 * a message that covered several fields is split into one per field (design.md D20, "Split
 * messages" — copy additions under Non-Goals' help/invalid exception).
 */
import type { ChannelForm } from '../types';
import type { AppState } from './appState';

/** Every store-backed field that runs a check, by DOM id. */
export const FIELD_IDS = [
  'f-na-name',
  'f-np-name',
  'f-np-baseurl',
  'f-np-firstbyte',
  'f-np-idle',
  'f-ow-paste',
  'f-kp-key',
  'f-kp-region',
  'f-bf-name',
  'f-bf-amount',
  'f-cf-name',
  'f-cf-smtphost',
  'f-cf-smtpport',
  'f-cf-smtpfrom',
  'f-cf-smtpto',
  'f-cf-apprise',
  'f-ua-email',
  'f-ob-pname',
  'f-ob-baseurl',
  'f-rf-value',
  'f-rf-target',
  'f-tf-key',
] as const;
export type FieldId = (typeof FIELD_IDS)[number];

/** The fields that live in a modal, cleared whenever a modal opens or closes. */
export const MODAL_FIELD_IDS: readonly FieldId[] = FIELD_IDS.filter((id) =>
  /^f-(na|np|ow|kp|bf|cf)-/.test(id),
);

/** A comma- or space-separated list, trimmed, empties dropped (the SMTP recipients and the
 * Apprise URLs). */
export function splitList(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A patience field (whole SECONDS as text; blank inherits the instance default). */
export function timeoutProblem(raw: string, label: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return !Number.isInteger(n) || n < 1 || n > 3600
    ? `${label} must be a whole number of seconds between 1 and 3600`
    : null;
}

/** The subscription connect paste: both accepted forms carry the OAuth state, so a bare code
 * gets guidance without a round-trip (the client-side mirror of the backend contract). */
export function pasteProblem(raw: string): string | null {
  const pasted = raw.trim();
  return !/^https?:\/\//i.test(pasted) && !pasted.includes('#')
    ? 'paste the full redirect URL or the code#state string shown after signing in'
    : null;
}

/** Whether a channel edit keeps its stored config: the same kind, with every config field
 * left blank (the config is write-only, invariant 8). */
function channelKeepsConfig(f: ChannelForm): { keep: boolean; kindChanged: boolean } {
  const kindChanged = f.id !== null && f.originalKind !== null && f.kind !== f.originalKind;
  const editing = f.id !== null && !kindChanged;
  if (f.kind === 'smtp') {
    const anyProvided =
      f.smtpHost.trim() !== '' ||
      f.smtpFrom.trim() !== '' ||
      f.smtpUser.trim() !== '' ||
      f.smtpPass !== '' ||
      splitList(f.smtpTo).length > 0;
    return { keep: editing && !anyProvided, kindChanged };
  }
  return { keep: editing && splitList(f.appriseUrls).length === 0, kindChanged };
}

export type SmtpField = 'host' | 'port' | 'from' | 'to';

/** The SMTP config's checks, one per field. Before this change one message ("SMTP needs a
 * host, port, from address, and at least one recipient") covered all four. */
export function smtpProblems(f: ChannelForm): Partial<Record<SmtpField, string>> {
  const { keep, kindChanged } = channelKeepsConfig(f);
  if (keep) return {};
  const lead = kindChanged ? 'Changing the kind to SMTP requires' : 'SMTP needs';
  const port = Number(f.smtpPort);
  const out: Partial<Record<SmtpField, string>> = {};
  if (f.smtpHost.trim() === '') out.host = `${lead} a host`;
  if (!Number.isFinite(port) || port <= 0) out.port = `${lead} a port: a positive number, like 587`;
  if (f.smtpFrom.trim() === '') out.from = `${lead} a from address`;
  if (splitList(f.smtpTo).length === 0) out.to = `${lead} at least one recipient`;
  return out;
}

/** The Apprise config's one check. */
export function appriseProblem(f: ChannelForm): string | null {
  const { keep, kindChanged } = channelKeepsConfig(f);
  if (keep || splitList(f.appriseUrls).length > 0) return null;
  return kindChanged
    ? 'Changing the kind to Apprise requires at least one URL'
    : 'Add at least one Apprise URL';
}

/** The invite email: required, and a well-formed address. The format is the browser's own
 * email check, read from the field's `validity` (the form is `novalidate`, so the browser
 * shows no bubble of its own and the field reports it instead). */
function inviteEmailProblem(value: string): string | null {
  if (value.trim() === '') return 'enter an email to invite';
  const el = typeof document === 'undefined' ? null : document.getElementById('f-ua-email');
  return el instanceof HTMLInputElement && el.validity.typeMismatch ? EMAIL_FORMAT : null;
}

/** After a failed submit, move focus to the first failing field in document order. A submit
 * leaves focus on its button, and the message under a field has no live role of its own, so
 * without this a screen-reader user hears nothing; on the field, its `aria-describedby` message
 * is read with it (dashboard-core "Every check reports on its own field"). A blur never calls
 * this: moving focus back would trap the user in the field they just left. */
export function focusFirstFailing(ids: readonly string[]): void {
  if (typeof document === 'undefined') return;
  const fields = ids
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el instanceof HTMLElement && el.isConnected);
  fields.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  fields[0]?.focus();
}

/** The browser's email-format check, stated on the field (Login, the Users invite). */
export const EMAIL_FORMAT = 'enter a full email address, like name@example.com';

/** The provider modal is on the subscription connect path: a NEW subscription provider while
 * the server lists an enabled preset, and the advanced (classic) form is not chosen
 * (add-subscription-oauth). There the name is optional — a blank name lets the server name the
 * provider (`startOauthConnect` sends `undefined`) — so its check does not apply. One predicate,
 * read by the modal (which fields to show) and by the name's check (whether it applies). */
export function onSubscriptionConnect(s: AppState): boolean {
  return (
    s.np.kind === 'sub' &&
    s.np.editingId === null &&
    !s.ow.advanced &&
    // A listed key preset (add-key-subscription-presets) opens the same path as an OAuth one.
    s.ow.presets.length + s.kp.presets.length > 0
  );
}

/** Each store-backed field's check: its message, or null when the value passes. */
export const FIELD_CHECKS: Record<FieldId, (s: AppState) => string | null> = {
  'f-na-name': (s) => (s.na.name.trim() === '' ? 'Name is required' : null),
  'f-np-name': (s) =>
    !onSubscriptionConnect(s) && s.np.name.trim() === '' ? 'Name is required' : null,
  'f-np-baseurl': (s) => (s.np.baseUrl.trim() === '' ? 'Base URL is required' : null),
  'f-np-firstbyte': (s) => timeoutProblem(s.np.firstByteTimeoutS, 'First-byte patience'),
  'f-np-idle': (s) => timeoutProblem(s.np.idleTimeoutS, 'Idle patience'),
  'f-ow-paste': (s) => pasteProblem(s.ow.pasted),
  'f-kp-key': (s) => (s.kp.key.trim() === '' ? 'Paste your plan key to connect' : null),
  // Required only where the preset lists several regions; a sole region is the choice.
  'f-kp-region': (s) => {
    const preset = s.kp.presets.find((p) => p.id === s.kp.preset);
    return preset !== undefined && preset.regions.length > 1 && s.kp.region === ''
      ? 'Choose a region'
      : null;
  },
  'f-bf-name': (s) => (s.bf.name.trim() === '' ? 'Name is required' : null),
  'f-bf-amount': (s) => {
    const amount = Number(s.bf.amount);
    return !Number.isFinite(amount) || amount <= 0 ? 'Amount must be a positive number' : null;
  },
  'f-cf-name': (s) => (s.cf.name.trim() === '' ? 'Name is required' : null),
  'f-cf-smtphost': (s) => smtpProblems(s.cf).host ?? null,
  'f-cf-smtpport': (s) => smtpProblems(s.cf).port ?? null,
  'f-cf-smtpfrom': (s) => smtpProblems(s.cf).from ?? null,
  'f-cf-smtpto': (s) => smtpProblems(s.cf).to ?? null,
  'f-cf-apprise': (s) => appriseProblem(s.cf),
  'f-ua-email': (s) => inviteEmailProblem(s.ua.inviteEmail),
  'f-ob-pname': (s) => (s.ob.prov.name.trim() === '' ? 'Provider name is required' : null),
  'f-ob-baseurl': (s) => (s.ob.prov.baseUrl.trim() === '' ? 'Base URL is required' : null),
  // One message, "A header value and target tier are required", split per field.
  'f-rf-value': (s) => (s.rf.value.trim() === '' ? 'A header value is required' : null),
  'f-rf-target': (s) => (s.rf.target.trim() === '' ? 'A target tier is required' : null),
  'f-tf-key': (s) => (s.tf.key.trim() === '' ? 'Key is required' : null),
};

/** The channel form's checked fields for its current kind, and the other kind's (whose
 * fields are not rendered, so their messages are dropped on submit). */
export function channelFields(f: ChannelForm): { checked: FieldId[]; hidden: FieldId[] } {
  const smtp: FieldId[] = ['f-cf-smtphost', 'f-cf-smtpport', 'f-cf-smtpfrom', 'f-cf-smtpto'];
  const apprise: FieldId[] = ['f-cf-apprise'];
  return f.kind === 'smtp'
    ? { checked: ['f-cf-name', ...smtp], hidden: apprise }
    : { checked: ['f-cf-name', ...apprise], hidden: smtp };
}
