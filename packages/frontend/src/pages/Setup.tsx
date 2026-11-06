import { For, Show } from 'solid-js';
import { HarnessSelect } from '../components/Modals';
import { PROVIDER_KINDS } from '../state/appState';
import { useApp } from '../state/context';
import { Icon } from '../components/Icon';
import { StackedLabel } from '../components/StackedLabel';
import { Notice } from '../components/Notice';
import { FieldNote, useFields } from '../components/Field';

export function Setup() {
  const app = useApp();
  const f = useFields();
  const { state, setState } = app;
  const ob = () => state.ob;
  const steps = () =>
    (
      [
        ['Agent', 1],
        ['Provider', 2],
        ['Routing', 3],
      ] as const
    ).map(([label, n]) => {
      const done = (n === 1 && ob().done1) || (n === 2 && ob().done2);
      const active = ob().step === n;
      return { n, label, i: n - 1, done, active };
    });

  return (
    <div class="rs-setup-page">
      <div style="width:680px;max-width:100%;display:flex;flex-direction:column;gap:24px">
        <div class="rs-wrap" style="display:flex;align-items:center;gap:0">
          <For each={steps()}>
            {(s) => (
              <div
                style={{ display: 'flex', 'align-items': 'center', flex: s.i < 2 ? '1' : 'none' }}
              >
                <button
                  type="button"
                  aria-current={s.active ? 'step' : undefined}
                  style="display:flex;align-items:center;gap:8px;cursor:pointer"
                  onClick={() => app.obGo(s.n)}
                >
                  {/* The step marker (styles.css `.step-marker`). The current step takes the
                      Selected state on it through `aria-current="step"` (adopt-design-tokens-v2
                      D8): the wash, a deep-indigo edge and numeral, in place of an accent fill.
                      A done step stays green, and an idle step neutral. */}
                  <span
                    aria-hidden="true"
                    classList={{ 'step-marker': true, 'step-marker--done': s.done }}
                  >
                    {s.done ? <Icon name="check" size={12} /> : String(s.n)}
                  </span>
                  <span
                    style={{
                      font: "500 0.75rem/1rem 'Geist',sans-serif",
                      color: s.active ? 'var(--text)' : 'var(--text3)',
                    }}
                  >
                    {s.label}
                    {/* The badge above is aria-hidden, so without this the completed state is
                        carried by a green ring alone — colour only. */}
                    <Show when={s.done}>
                      <span class="sr-only"> (completed)</span>
                    </Show>
                  </span>
                </button>
                <Show when={s.i < 2}>
                  <div style="flex:1;height:1px;background:var(--border);margin:0 12px" />
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* Step 1 — mint an agent key */}
        <Show when={ob().step === 1}>
          <div
            class="panel"
            style="border-radius:10px;padding:24px;display:flex;flex-direction:column;gap:16px"
          >
            <div>
              <div class="t-title" style="letter-spacing:-.01em">
                Connect an agent
              </div>
              <div class="t-body" style="color:var(--text3);margin-top:4px">
                An agent is anything that calls the router — a coding harness, a script, an app. It
                gets its own key so you can track and limit it.
              </div>
            </div>
            <div class="rs-grid-2" style="display:grid;gap:12px">
              <div>
                <label class="field-label" for="f-ob-name" style="display:block">
                  Agent name
                </label>
                <input
                  class="input"
                  id="f-ob-name"
                  value={ob().name}
                  placeholder="my-agent"
                  onInput={(e) => setState('ob', 'name', e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="field-label" for="f-ob-harness" style="display:block">
                  Platform
                </label>
                <HarnessSelect
                  id="f-ob-harness"
                  value={ob().harness}
                  onChange={(h) => setState('ob', 'harness', h)}
                />
              </div>
            </div>
            <Show when={ob().error1}>
              <div class="t-caption" style="color:var(--red-text)">
                {ob().error1}
              </div>
            </Show>
            <Show when={!ob().key}>
              <button
                type="button"
                class="btn-primary"
                style="align-self:flex-start"
                disabled={ob().busy1}
                aria-busy={ob().busy1 ? true : undefined}
                onClick={() => void app.obCreateAgent()}
              >
                <StackedLabel alt={ob().busy1} rest="Create agent & mint key" altLabel="Minting…" />
              </button>
            </Show>
            <Show when={ob().key}>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--amber-bg);border-radius:6px">
                  <span class="mono t-label" style="color:var(--text);word-break:break-all">
                    {ob().key}
                  </span>
                  <button
                    type="button"
                    class="link-accent t-label"
                    style="margin-left:auto;flex:none"
                    onClick={() => app.copy(ob().key, 'Key copied')}
                  >
                    Copy
                  </button>
                </div>
                <div class="t-caption" style="color:var(--amber-text)">
                  Shown once — we store only a hash.
                </div>
                <div class="snippet-box">{ob().snippet}</div>
                <button
                  type="button"
                  class="btn-primary"
                  style="align-self:flex-start"
                  onClick={() => app.obGo(2)}
                >
                  Next: connect a provider <Icon name="arrowRight" size={12} />
                </button>
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 2 — connect a provider, sync, assign the first model to `default` */}
        <Show when={ob().step === 2}>
          <div
            class="panel"
            style="border-radius:10px;padding:24px;display:flex;flex-direction:column;gap:16px"
          >
            <div>
              <div class="t-title" style="letter-spacing:-.01em">
                Connect a provider
              </div>
              <div class="t-body" style="color:var(--text3);margin-top:4px">
                Bring what you already pay for. polyrouter never marks up tokens — you pay providers
                directly. We’ll sync its models and assign the first to your{' '}
                <span class="mono" style="font-size:0.75rem">
                  default
                </span>{' '}
                tier.
              </div>
            </div>
            <div>
              <label class="field-label" for="f-ob-pname" style="display:block">
                Name
              </label>
              <input
                class="input"
                id="f-ob-pname"
                value={ob().prov.name}
                placeholder="e.g. OpenAI, mylab-endpoint"
                aria-invalid={f.invalid('f-ob-pname')}
                aria-describedby={f.describedBy('f-ob-pname')}
                onBlur={() => f.check('f-ob-pname')}
                onInput={(e) => {
                  setState('ob', 'prov', 'name', e.currentTarget.value);
                  f.edit('f-ob-pname');
                }}
              />
              <FieldNote for="f-ob-pname" error={f.error('f-ob-pname')} />
            </div>
            <div class="rs-grid-2" style="display:grid;gap:8px">
              <For each={PROVIDER_KINDS}>
                {(k) => (
                  <button
                    type="button"
                    class="kind-card"
                    aria-pressed={ob().prov.kind === k.id}
                    style="padding:12px 16px;display:flex;flex-direction:column;gap:4px"
                    onClick={() => setState('ob', 'prov', 'kind', k.id)}
                  >
                    <span
                      class="kind-card-name"
                      style="font:500 0.8125rem/1.25rem 'Geist',sans-serif"
                    >
                      {k.name}
                    </span>
                    <span class="t-caption" style="color:var(--text3)">
                      {k.desc}
                    </span>
                  </button>
                )}
              </For>
            </div>
            <div class="rs-grid-2" style="display:grid;gap:8px">
              <div>
                <label class="field-label" for="f-ob-protocol" style="display:block">
                  Protocol
                </label>
                <select
                  class="select"
                  id="f-ob-protocol"
                  value={ob().prov.protocol}
                  onChange={(e) =>
                    setState(
                      'ob',
                      'prov',
                      'protocol',
                      e.currentTarget.value as 'openai_compatible' | 'anthropic_compatible',
                    )
                  }
                >
                  <option value="openai_compatible">OpenAI-compatible</option>
                  <option value="anthropic_compatible">Anthropic-compatible</option>
                </select>
              </div>
              <div>
                <label class="field-label" for="f-ob-baseurl" style="display:block">
                  Base URL
                </label>
                <input
                  class="input input--mono"
                  id="f-ob-baseurl"
                  value={ob().prov.baseUrl}
                  placeholder={
                    ob().prov.kind === 'local'
                      ? 'http://127.0.0.1:11434/v1'
                      : 'https://api.provider.com/v1'
                  }
                  aria-invalid={f.invalid('f-ob-baseurl')}
                  aria-describedby={f.describedBy('f-ob-baseurl')}
                  onBlur={() => f.check('f-ob-baseurl')}
                  onInput={(e) => {
                    setState('ob', 'prov', 'baseUrl', e.currentTarget.value);
                    f.edit('f-ob-baseurl');
                  }}
                />
                <FieldNote for="f-ob-baseurl" error={f.error('f-ob-baseurl')} />
              </div>
            </div>
            <div>
              <label class="field-label" for="f-ob-credential" style="display:block">
                Credential{ob().prov.kind === 'local' ? ' (optional)' : ''}
              </label>
              <input
                class="input input--mono"
                id="f-ob-credential"
                type="password"
                value={ob().prov.credential}
                placeholder="sk-…"
                onInput={(e) => setState('ob', 'prov', 'credential', e.currentTarget.value)}
              />
            </div>
            <Show when={ob().error2}>
              <div class="t-caption" style="color:var(--red-text)">
                {ob().error2}
              </div>
            </Show>
            <Show when={!ob().done2}>
              <button
                type="button"
                class="btn-primary"
                style="align-self:flex-start"
                disabled={ob().busy2}
                aria-busy={ob().busy2 ? true : undefined}
                onClick={() => void app.obConnectProvider()}
              >
                <StackedLabel
                  alt={ob().busy2}
                  rest="Connect provider & sync models"
                  altLabel="Connecting & syncing…"
                />
              </button>
            </Show>
            <Show when={ob().done2}>
              <div
                class="t-dense"
                style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--green-bg);border-radius:6px;color:var(--text2)"
              >
                <span
                  aria-hidden="true"
                  style="width:7px;height:7px;border-radius:50%;background:var(--green)"
                />
                Synced —{' '}
                <span class="mono" style="font-size:0.75rem">
                  {ob().assignedModel}
                </span>{' '}
                assigned to the default tier.
              </div>
              <button
                type="button"
                class="btn-primary"
                style="align-self:flex-start"
                onClick={() => app.obGo(3)}
              >
                Next: verify <Icon name="arrowRight" size={12} />
              </button>
            </Show>
          </div>
        </Show>

        {/* Step 3 — verify a real `auto` completion through the proxy */}
        <Show when={ob().step === 3}>
          <div
            class="panel"
            style="border-radius:10px;padding:24px;display:flex;flex-direction:column;gap:16px"
          >
            <div>
              <div class="t-title" style="letter-spacing:-.01em">
                Verify routing
              </div>
              <div class="t-body" style="color:var(--text3);margin-top:4px">
                We’ll send a real{' '}
                <span class="mono" style="font-size:0.75rem">
                  model: "auto"
                </span>{' '}
                request through your new key and show the response — the end-to-end proof.
              </div>
            </div>
            {/* Failure (D15): an alert, with no action — the step's own button retries. */}
            <Show when={ob().error3}>
              {(error) => (
                <Notice tone="failure" title="Test failed">
                  {error()}
                </Notice>
              )}
            </Show>
            <Show when={ob().verifyReply}>
              <div style="display:flex;flex-direction:column;gap:8px;background:var(--green-bg);border-radius:6px;padding:12px">
                <div style="font:500 0.6875rem/1rem 'Geist',sans-serif;color:var(--green-text)">
                  Routed{ob().verifyModel ? ` to ${ob().verifyModel ?? ''}` : ''}
                </div>
                <div class="t-body" style="color:var(--text);white-space:pre-wrap">
                  {ob().verifyReply}
                </div>
              </div>
            </Show>
            <div style="display:flex;gap:8px">
              <button
                type="button"
                class="btn-cancel"
                disabled={ob().busy3}
                aria-busy={ob().busy3 ? true : undefined}
                onClick={() => void app.obVerify()}
              >
                <StackedLabel
                  alt={ob().busy3}
                  rest={ob().verifyReply || ob().error3 ? 'Send again' : 'Send test request'}
                  altLabel="Sending…"
                />
              </button>
              <button type="button" class="btn-primary" onClick={() => app.obFinish()}>
                Open dashboard
              </button>
            </div>
            {/* A sentence holding a link: `.prose` underlines it at rest (task 11.3). */}
            <div class="t-caption prose" style="color:var(--text3)">
              Tune tiers, fallback order and auto-layers any time under{' '}
              <button type="button" class="link-accent" onClick={() => app.go('routing')}>
                Routing
              </button>
              .
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
