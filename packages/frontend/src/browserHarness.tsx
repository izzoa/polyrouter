/** Browser-test fixture seam (phase1-responsive-dashboard-layout, task 8.2).
 *
 * Mounts the REAL `App` against the existing `FakeApiClient`, so the responsive browser
 * suite needs no Postgres, no Redis and no running backend — and, more importantly, gets
 * byte-identical data on every run. A suite that asserts layout cannot tolerate rows that
 * change between runs.
 *
 * Deliberately NOT part of the shipped app: this module is referenced only by
 * `browser-harness.html`, which the production build excludes (see `vite.config.ts`).
 *
 * Content is adversarial on purpose (task 8.3). Overflow is the whole subject of this
 * change, so the fixture carries the longest realistic values a self-hoster would see —
 * a 26-character model id, a 50-character enterprise email, a long provider label —
 * rather than the short placeholders that would make every assertion pass trivially.
 */
import { render } from 'solid-js/web';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';
import type { AdminInviteDto, AgentDto } from './data/api';
import './styles.css';

const params = new URLSearchParams(globalThis.location.search);
const role = params.get('role') === 'member' ? 'member' : 'admin';

const LONG_MODEL = 'claude-sonnet-4-5-20250929';
const LONG_PROVIDER = 'anthropic-production-eu-west-1';
const LONG_EMAIL = 'alexandra.hartmann@enterprise-customer.example.com';

const AGENTS: AgentDto[] = [
  {
    id: 'a1',
    name: 'claude-code-production-worker',
    harness: 'claude-code',
    prefix: 'poly_a1b2c3d4',
    lastUsedAt: '2026-08-06T11:58:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'a2',
    name: 'nightly-batch',
    harness: 'custom',
    prefix: 'poly_e5f6g7h8',
    lastUsedAt: null,
    createdAt: '2026-08-02T09:00:00.000Z',
  },
];

const ADMIN_USERS = [
  {
    id: 'u1',
    email: LONG_EMAIL,
    name: 'Alexandra Hartmann',
    role: 'admin',
    disabled: false,
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'u2',
    email: 'sam@example.com',
    name: 'Sam',
    role: 'member',
    disabled: true,
    createdAt: '2026-08-03T09:00:00.000Z',
  },
];

const INVITES: AdminInviteDto[] = [
  {
    id: 'i1',
    email: LONG_EMAIL,
    tokenPrefix: 'poly_inv_9f3a2b',
    createdAt: '2026-08-05T09:00:00.000Z',
    expiresAt: '2026-08-12T09:00:00.000Z',
    consumedAt: null,
  },
];

const client = new FakeApiClient({
  agents: AGENTS,
  adminUsers: ADMIN_USERS,
  adminInvites: INVITES,
});
if (client.session) client.session = { ...client.session, role, email: LONG_EMAIL };
// Keep the fake's own well-formed rows and lengthen only what drives overflow: a long
// model id and provider label are the realistic worst case for the requests table.
client.requestRows = client.requestRows.map((r) => ({
  ...r,
  modelLabel: LONG_MODEL,
  providerLabel: LONG_PROVIDER,
}));

const store = createAppStore(client);
const host = document.getElementById('root');
if (!host) throw new Error('harness root missing');

// `live={false}` — no polling and no event stream. A layout suite must not race a timer.
render(
  () => (
    <AppProvider store={store}>
      <App live={false} />
    </AppProvider>
  ),
  host,
);

// Signals readiness to Playwright. Waits for FONTS, not just a paint: Geist's metrics
// decide every height and wrap point in this suite, and measuring against the fallback
// face silently produces different numbers.
void document.fonts.ready.then(() => {
  document.documentElement.dataset['harnessReady'] = 'true';
});
