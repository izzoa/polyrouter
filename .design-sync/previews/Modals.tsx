import * as React from 'react';
import { Modals } from '@polyrouter/design-kit';

/** Shown-once key reveal after minting an agent key: the poly_ key in an amber
 * "shown once" box with Copy, the HMAC-only note, and the ready-to-paste
 * connection snippet (base URL + key). The dashboard's real modal layer. */
export const KeyReveal = () => <Modals kind="keyReveal" />;

/** New agent: name + platform (harness) form that mints a key on submit. */
export const NewAgent = () => <Modals kind="newAgent" />;

/** Add provider: the kind picker (API key / subscription / custom / local),
 * protocol + base URL and credential — with the SSRF + at-rest-encryption note. */
export const NewProvider = () => <Modals kind="newProvider" />;

/** New budget: scope, amount, window and the alert-vs-block threshold, plus the
 * seeded notify channels (Ops email, ntfy push) to fan alerts out to. */
export const NewLimit = () => <Modals kind="newLimit" />;

/** Notification channel: SMTP/Apprise kind, the subscribed-events checklist and
 * the SMTP transport fields — targets SSRF-checked, config encrypted at rest. */
export const Channel = () => <Modals kind="channel" />;
