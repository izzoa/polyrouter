/**
 * Every check a dashboard form runs reports on the field it concerns (adopt-design-tokens-v2
 * task 8.2; design.md D20; dashboard-core "Entry controls show help, invalid, read-only and
 * disabled states" — "Help text is announced with its field", "An invalid field keeps the
 * value and names the fix", "Validation waits until the user leaves the field", "Every check
 * reports on its own field" and "A pasted sign-in code is cleared, not kept").
 *
 * Data-driven from D20's check table: one row per check, on every form that runs one. Per
 * row the real App is mounted on a fake client and the surface opened, then the walk:
 *
 *   1. a failing value is typed, and no invalid state shows (nothing turns invalid on a
 *      keystroke);
 *   2. the field is left (blur): it carries `aria-invalid="true"`, and its `aria-describedby`
 *      names a `.field-error` node holding the row's message;
 *   3. the value is fixed: the message goes, and the description is the field's help again
 *      (or nothing, for a field without help);
 *   4. the failing value is typed again and the form submitted: the same invalid state, with
 *      the typed value kept — except the subscription paste, which every attempt clears
 *      because it is credential material, so its invalid state shows an empty field.
 *
 * A check moved back to its form-level slot fails step 2, named by surface and field.
 *
 * The second describe renders every D20 surface, at rest and after a failing submit, and holds
 * the ARIA wiring: each `.field-help` / `.field-error` node is named by exactly one field's
 * `aria-describedby`, and every id a field's `aria-describedby` names exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AgentDto, ModelDto, ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { EMAIL_FORMAT } from './state/fieldChecks';
import {
  DEFAULT_LOGIN_CONFIG,
  DEFAULT_SESSION,
  FakeApiClient,
  UNRECORDED_HEALTH,
  type FakeOptions,
} from './test/fakeClient';
import { labelText } from './test/labelText';
import type { Page } from './types';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
const NOW = '2026-11-01T12:00:00.000Z';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

const PROVIDER: ProviderDto = {
  id: 'p1',
  name: 'homelab-vllm',
  kind: 'custom',
  protocol: 'openai_compatible',
  baseUrl: 'https://1.1.1.1/v1',
  status: 'ok',
  maxTokensSpelling: 'auto',
  hasCredential: true,
  oauthPreset: null,
  credentialExpiresAt: null,
  credentialError: null,
  firstByteTimeoutMs: null,
  idleTimeoutMs: null,
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
};
const MODEL: ModelDto = {
  id: 'm1',
  providerId: 'p1',
  externalModelId: 'qwen3-coder',
  displayName: 'Qwen3 Coder',
  contextWindow: 128000,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: false,
  batchEffectivePrice: null,
  lastSyncedAt: NOW,
  unlistedSince: null,
};
const AGENT: AgentDto = {
  id: 'a1',
  name: 'claude-code',
  harness: 'claude_code',
  prefix: 'poly_abcd',
  lastUsedAt: null,
  createdAt: NOW,
};

function baseOptions(): FakeOptions {
  return {
    session: DEFAULT_SESSION,
    agents: [AGENT],
    providers: [PROVIDER],
    models: { p1: [MODEL] },
    tiers: [
      { id: 'tier-default', key: 'default', displayName: null, description: null, createdAt: NOW },
      { id: 'tier-heavy', key: 'heavy', displayName: null, description: null, createdAt: NOW },
    ],
  };
}

// ── Mounting ──────────────────────────────────────────────────────────────────────────────

interface Harness {
  host: HTMLElement;
  store: AppStore;
}

let dispose: (() => void) | undefined;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(page: Page, opts: Partial<FakeOptions> = {}): Promise<Harness> {
  globalThis.history.replaceState(null, '', `/#/${page}`);
  const fake = new FakeApiClient({ ...baseOptions(), ...opts });
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  if (store.state.authView === 'ready') {
    store.go(page);
    await flush();
  }
  return { host, store };
}

// ── Surfaces ──────────────────────────────────────────────────────────────────────────────

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface Surface {
  page: Page;
  opts?: Partial<FakeOptions>;
  /** Reach the state the form lives in. */
  open?: (h: Harness) => Promise<void> | void;
  /** The control that submits it, by its visible label. */
  submit: string;
  /** Where to look for the submit control. */
  scope?: string;
}

const openModal = async (h: Harness, kind: Parameters<AppStore['openModal']>[0]): Promise<void> => {
  h.store.openModal(kind);
  await flush();
};

const SURFACES = {
  'agent modal': {
    page: 'agents',
    open: (h) => openModal(h, 'newAgent'),
    submit: 'Create & mint key',
    scope: '.modal-card',
  },
  'provider modal': {
    page: 'providers',
    open: (h) => openModal(h, 'newProvider'),
    submit: 'Add provider',
    scope: '.modal-card',
  },
  'subscription connect': {
    page: 'providers',
    open: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', 'kind', 'sub');
      h.store.setState('ow', {
        presets: [{ id: 'chatgpt', displayName: 'ChatGPT' }],
        active: {
          preset: 'chatgpt',
          sessionId: 's1',
          authorizeUrl: 'https://auth.example/authorize',
          reauthorizeProviderId: null,
        },
        pasted: '',
      });
      await flush();
    },
    submit: 'Connect',
    scope: '.modal-card',
  },
  'budget modal': {
    page: 'limits',
    open: (h) => openModal(h, 'newLimit'),
    submit: 'Create budget',
    scope: '.modal-card',
  },
  'channel modal (SMTP)': {
    page: 'settings',
    open: (h) => openModal(h, 'channel'),
    submit: 'Add channel',
    scope: '.modal-card',
  },
  'channel modal (Apprise)': {
    page: 'settings',
    open: async (h) => {
      await openModal(h, 'channel');
      h.store.setState('cf', 'kind', 'apprise');
      await flush();
    },
    submit: 'Add channel',
    scope: '.modal-card',
  },
  'users invite': { page: 'users', submit: 'Invite' },
  'sign-in': {
    page: 'overview',
    opts: { session: null, loginConfig: { ...DEFAULT_LOGIN_CONFIG, mode: 'cloud' } },
    submit: 'Sign in',
    // The form's own submit, not the "Sign in" segment above it.
    scope: 'form',
  },
  'setup guide (provider step)': {
    page: 'setup',
    open: async (h) => {
      h.store.obGo(2);
      await flush();
    },
    submit: 'Connect provider & sync models',
  },
  'routing rule form': {
    page: 'routing',
    submit: 'Add',
    scope: '[data-testid="header-rule-form"]',
  },
  'tier form': { page: 'routing', submit: 'Add tier' },
  'model price': {
    page: 'providers',
    open: async (h) => {
      clickLabel(h.host, 'Models');
      await flush();
    },
    submit: 'Save price',
  },
} satisfies Record<string, Surface>;
type SurfaceName = keyof typeof SURFACES;

/** One row of D20's check table. */
interface Row {
  surface: SurfaceName;
  field: string;
  find: (h: Harness) => Field | null;
  bad: string;
  good: string;
  message: string;
  /** The field's help, restored once the value is fixed. */
  help?: string;
  /** The subscription paste: every attempt clears the field. */
  clearedOnSubmit?: true;
}

const byId = (id: string) => (): Field | null => document.getElementById(id) as Field | null;
const byAria =
  (label: string) =>
  (h: Harness): Field | null =>
    h.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

const INVITE_HELP =
  'Links are single-use and expire after 72 hours. The invited address is fixed — the account must sign up with it.';

const ROWS: readonly Row[] = [
  {
    surface: 'agent modal',
    field: 'name',
    find: byId('f-na-name'),
    bad: '  ',
    good: 'bot',
    message: 'Name is required',
  },
  {
    surface: 'provider modal',
    field: 'name',
    find: byId('f-np-name'),
    bad: '',
    good: 'edge-vllm',
    message: 'Name is required',
  },
  {
    surface: 'provider modal',
    field: 'base URL',
    find: byId('f-np-baseurl'),
    bad: ' ',
    good: 'https://2.2.2.2/v1',
    message: 'Base URL is required',
  },
  {
    surface: 'provider modal',
    field: 'first response (s)',
    find: byId('f-np-firstbyte'),
    bad: 'abc',
    good: '30',
    message: 'First-byte patience must be a whole number of seconds between 1 and 3600',
  },
  {
    surface: 'provider modal',
    field: 'between chunks (s)',
    find: byId('f-np-idle'),
    bad: '0',
    good: '60',
    message: 'Idle patience must be a whole number of seconds between 1 and 3600',
  },
  {
    surface: 'subscription connect',
    field: 'redirect URL or code',
    find: byId('f-ow-paste'),
    bad: 'just-a-bare-code',
    good: 'https://localhost/callback?code=abc&state=xyz',
    message: 'paste the full redirect URL or the code#state string shown after signing in',
    clearedOnSubmit: true,
  },
  {
    surface: 'budget modal',
    field: 'name',
    find: byId('f-bf-name'),
    bad: '',
    good: 'Daily cap',
    message: 'Name is required',
  },
  {
    surface: 'budget modal',
    field: 'amount',
    find: byId('f-bf-amount'),
    bad: '0',
    good: '5',
    message: 'Amount must be a positive number',
  },
  {
    surface: 'channel modal (SMTP)',
    field: 'name',
    find: byId('f-cf-name'),
    bad: '',
    good: 'ops',
    message: 'Name is required',
  },
  {
    surface: 'channel modal (SMTP)',
    field: 'host',
    find: byId('f-cf-smtphost'),
    bad: '',
    good: 'smtp.example.com',
    message: 'SMTP needs a host',
  },
  {
    surface: 'channel modal (SMTP)',
    field: 'port',
    find: byId('f-cf-smtpport'),
    bad: 'abc',
    good: '587',
    message: 'SMTP needs a port: a positive number, like 587',
  },
  {
    surface: 'channel modal (SMTP)',
    field: 'from',
    find: byId('f-cf-smtpfrom'),
    bad: '',
    good: 'alerts@my.box',
    message: 'SMTP needs a from address',
  },
  {
    surface: 'channel modal (SMTP)',
    field: 'recipients',
    find: byId('f-cf-smtpto'),
    bad: ' , ',
    good: 'admin@my.box',
    message: 'SMTP needs at least one recipient',
  },
  {
    surface: 'channel modal (Apprise)',
    field: 'Apprise URLs',
    find: byId('f-cf-apprise'),
    bad: ' ',
    good: 'ntfy://homelab/polyrouter',
    message: 'Add at least one Apprise URL',
  },
  {
    surface: 'users invite',
    field: 'email to invite (required)',
    find: byId('f-ua-email'),
    bad: '',
    good: 'carol@example.com',
    message: 'enter an email to invite',
    help: INVITE_HELP,
  },
  {
    surface: 'users invite',
    field: "email to invite (the browser's format check)",
    find: byId('f-ua-email'),
    bad: 'carol-at-example',
    good: 'carol@example.com',
    message: EMAIL_FORMAT,
    help: INVITE_HELP,
  },
  {
    surface: 'sign-in',
    field: "email (the browser's format check)",
    find: byId('f-login-email'),
    bad: 'ada-at-example',
    good: 'ada@example.com',
    message: EMAIL_FORMAT,
  },
  {
    surface: 'setup guide (provider step)',
    field: 'provider name',
    find: byId('f-ob-pname'),
    bad: '',
    good: 'edge-vllm',
    message: 'Provider name is required',
  },
  {
    surface: 'setup guide (provider step)',
    field: 'base URL',
    find: byId('f-ob-baseurl'),
    bad: '',
    good: 'https://2.2.2.2/v1',
    message: 'Base URL is required',
  },
  {
    surface: 'routing rule form',
    field: 'header value',
    find: byId('f-rf-value'),
    bad: '',
    good: 'light',
    message: 'A header value is required',
  },
  {
    surface: 'routing rule form',
    field: 'target tier',
    find: byId('f-rf-target'),
    bad: '',
    good: 'heavy',
    message: 'A target tier is required',
  },
  {
    surface: 'tier form',
    field: 'key',
    find: byId('f-tf-key'),
    bad: '',
    good: 'nightly',
    message: 'Key is required',
  },
  {
    surface: 'model price',
    field: 'input price',
    find: byAria('Input price per 1M tokens (USD)'),
    bad: '-1',
    good: '0.5',
    message: 'Enter the input price as a non-negative number, or mark free.',
  },
  {
    surface: 'model price',
    field: 'output price',
    find: byAria('Output price per 1M tokens (USD)'),
    bad: 'free',
    good: '2',
    message: 'Enter the output price as a non-negative number, or mark free.',
  },
];

// ── Driving a field ───────────────────────────────────────────────────────────────────────

function clickLabel(scope: ParentNode, label: string): void {
  const b = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => labelText(x) === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  b.click();
}

/** Type a value: the field's own edit event (input, or change for a select). */
async function type(el: Field, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
  await flush();
}
async function leave(el: Field): Promise<void> {
  el.dispatchEvent(new FocusEvent('blur'));
  await flush();
}
async function submit(h: Harness, s: Surface): Promise<void> {
  const scope = s.scope === undefined ? h.host : (document.querySelector(s.scope) ?? h.host);
  clickLabel(scope, s.submit);
  await flush();
}

/** The node a field's `aria-describedby` names, or null when it names none. */
function described(el: Field): HTMLElement | null {
  const id = el.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}

async function reach(row: Row): Promise<{ h: Harness; el: Field }> {
  const s: Surface = SURFACES[row.surface];
  const h = await mount(s.page, s.opts);
  await s.open?.(h);
  const el = row.find(h);
  if (el === null) throw new Error(`${row.surface} › ${row.field}: the field is not rendered`);
  return { h, el };
}

// ── The walk ──────────────────────────────────────────────────────────────────────────────

describe("every check reports on its own field (task 8.2, design.md D20's check table)", () => {
  it('walks every form that runs a check (not vacuous)', () => {
    expect(new Set(ROWS.map((r) => r.surface)).size).toBe(Object.keys(SURFACES).length);
    // D20's eleven forms: the agent, provider, subscription connect, budget, channel, invite,
    // sign-in, Setup, routing rule, tier and model price forms.
    const forms = new Set(ROWS.map((r) => r.surface.replace(/ \(.*\)$/, '')));
    expect(forms.size).toBe(11);
  });

  for (const row of ROWS) {
    const at = `${row.surface} › ${row.field}`;
    it(`${at}: "${row.message}"`, async () => {
      const { h, el } = await reach(row);

      // 1. Typing a failing value shows nothing yet.
      await type(el, row.bad);
      expect(el.getAttribute('aria-invalid'), `${at}: invalid on a keystroke`).toBeNull();
      expect(described(el)?.classList.contains('field-error') ?? false, at).toBe(false);

      // 2. Leaving the field runs its check, on the field.
      await leave(el);
      expect(el.getAttribute('aria-invalid'), `${at}: no invalid state on blur`).toBe('true');
      const message = described(el);
      expect(message?.className, `${at}: aria-describedby names no .field-error`).toBe(
        'field-error',
      );
      expect(message?.textContent, `${at}: the message`).toBe(row.message);
      expect(el.value, `${at}: the typed value is kept on blur`).toBe(row.bad);

      // 3. Fixing the value restores the help (or nothing, without help).
      await type(el, row.good);
      await leave(el);
      expect(el.getAttribute('aria-invalid'), `${at}: still invalid once fixed`).toBeNull();
      if (row.help === undefined) {
        expect(el.getAttribute('aria-describedby'), `${at}: describes nothing`).toBeNull();
      } else {
        const help = described(el);
        expect(help?.className, `${at}: the help is not restored`).toBe('field-help');
        expect(help?.textContent, at).toBe(row.help);
      }

      // 4. Submitting with the field failing shows the same state on the field.
      await type(el, row.bad);
      expect(el.getAttribute('aria-invalid'), `${at}: invalid on a keystroke`).toBeNull();
      await submit(h, SURFACES[row.surface]);
      const after = row.find(h);
      expect(after, `${at}: the field is gone after a failing submit`).not.toBeNull();
      expect(after!.getAttribute('aria-invalid'), `${at}: no invalid state on submit`).toBe('true');
      expect(described(after!)?.textContent, `${at}: the message on submit`).toBe(row.message);
      expect(after!.value, `${at}: the value after a failing submit`).toBe(
        row.clearedOnSubmit === true ? '' : row.bad,
      );
      // 5. A failing submit moves focus to the form's first failing field, so its message is
      //    read with it: focus would otherwise stay on the submit button, and the message under
      //    a field has no live role of its own.
      const scope = (SURFACES[row.surface] as Surface).scope;
      const root = scope === undefined ? h.host : (document.querySelector(scope) ?? h.host);
      const firstInvalid = root.querySelector('[aria-invalid="true"]');
      expect(firstInvalid, `${at}: an invalid field after the submit`).not.toBeNull();
      expect(document.activeElement, `${at}: focus is not on the first failing field`).toBe(
        firstInvalid,
      );
    });
  }
});

// ── The ARIA wiring ───────────────────────────────────────────────────────────────────────

/** Every wiring defect on the page: a note no field names (or two fields name), and an id a
 * field names that is not rendered. */
function wiringDefects(where: string): string[] {
  const fields = [...document.querySelectorAll<Field>('input, select, textarea')];
  const named = new Map<string, number>();
  const out: string[] = [];
  for (const el of fields) {
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
      named.set(id, (named.get(id) ?? 0) + 1);
      if (document.getElementById(id) === null) {
        out.push(
          `${where}: #${el.id || el.getAttribute('aria-label') || el.tagName} names #${id}, which is not rendered`,
        );
      }
    }
  }
  for (const note of document.querySelectorAll<HTMLElement>('.field-help, .field-error')) {
    const n = note.id === '' ? 0 : (named.get(note.id) ?? 0);
    if (n !== 1)
      out.push(
        `${where}: .${note.className} "${note.textContent ?? ''}" is named by ${String(n)} fields`,
      );
  }
  return out;
}

describe('help and messages are wired to exactly one field (task 8.2)', () => {
  for (const [name, s] of Object.entries(SURFACES) as [SurfaceName, Surface][]) {
    it(`${name}: at rest and after a failing submit`, async () => {
      const h = await mount(s.page, s.opts);
      await s.open?.(h);
      expect(wiringDefects(`${name} at rest`)).toEqual([]);
      // Empty every checked field this surface has, then submit, so its messages render.
      for (const row of ROWS.filter((r) => r.surface === name)) {
        const el = row.find(h);
        if (el !== null) await type(el, row.bad);
      }
      await submit(h, s);
      const errors = document.querySelectorAll('.field-error').length;
      expect(errors, `${name}: no message rendered`).toBeGreaterThan(0);
      expect(wiringDefects(`${name} after submit`)).toEqual([]);
    });
  }

  it('the invite email is described by its help at rest', async () => {
    const h = await mount('users');
    const el = document.getElementById('f-ua-email') as HTMLInputElement;
    expect(described(el)?.textContent).toBe(INVITE_HELP);
    expect(h.host.querySelector('form')?.hasAttribute('novalidate')).toBe(true);
  });

  it('the sign-in and invite forms are novalidate: the field reports the format, not a bubble', async () => {
    await mount('overview', SURFACES['sign-in'].opts);
    expect(document.getElementById('f-login-email')?.closest('form')?.noValidate).toBe(true);
  });
});

// ── The subscription connect path's optional name ─────────────────────────────────────────

/** On the subscription connect path the provider's name is optional — a blank name lets the
 * server name it — so its "Name is required" check does not apply there, on blur or after the
 * form moves onto the path (add-subscription-oauth; review fix). */
describe('the subscription connect path never marks its optional name invalid', () => {
  const toConnectPath = async (h: Harness): Promise<void> => {
    h.store.setState('np', 'kind', 'sub');
    h.store.setState('ow', { presets: [{ id: 'chatgpt', displayName: 'ChatGPT' }], active: null });
    await flush();
  };

  it('leaving the name empty on the connect path shows no invalid state', async () => {
    const h = await mount('providers');
    await openModal(h, 'newProvider');
    await toConnectPath(h);
    const name = document.getElementById('f-np-name') as HTMLInputElement | null;
    expect(name, 'the optional name field is shown on the connect path').not.toBeNull();
    await type(name!, '');
    await leave(name!);
    expect(name!.getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById('f-np-name-error')).toBeNull();
    expect(h.store.state.fieldErrors['f-np-name']).toBeUndefined();
  });

  it('a "Name is required" from the classic form clears when the form moves onto the path', async () => {
    const h = await mount('providers');
    await openModal(h, 'newProvider');
    const name = document.getElementById('f-np-name') as HTMLInputElement;
    await type(name, '');
    await leave(name);
    expect(name.getAttribute('aria-invalid'), 'the classic form requires a name').toBe('true');
    await toConnectPath(h);
    const after = document.getElementById('f-np-name') as HTMLInputElement;
    expect(after.getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById('f-np-name-error')).toBeNull();
  });
});
