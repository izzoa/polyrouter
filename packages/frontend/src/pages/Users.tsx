import { For, onMount, Show } from 'solid-js';
import type { AdminInviteDto, AdminUserDto } from '../data/api';
import { FROM_DIALOG } from '../state/appState';
import { useApp } from '../state/context';
import { StackedLabel } from '../components/StackedLabel';
import { pageTitle } from '../components/Topbar';
import { createBusyMap } from '../components/busy';
import { FieldNote, useFields } from '../components/Field';

/** Admin-only user administration (user-administration): registration mode,
 * invite issuing (link shown once + optional email), pending invites, and the
 * user list with role/disable/delete. The API refuses anything that would
 * leave the instance without an enabled admin; errors surface inline. */
export function Users() {
  const app = useApp();
  const f = useFields();
  const { state, setState } = app;
  // Each of these starts a request and stays on screen while it runs (D14), keyed by the
  // row (or the registration mode) so only the pressed button goes busy.
  const registering = createBusyMap();
  const revoking = createBusyMap();
  const roling = createBusyMap();
  const enabling = createBusyMap();

  onMount(() => void app.loadUserAdmin());

  /** The registration settings have not arrived yet. Until they do the card claims nothing
   * about SMTP and neither mode can be pressed; after a failed load the page's alert line
   * reports the failure and the card still claims nothing. */
  const regLoading = (): boolean => state.ua.reg === null && state.ua.loading;

  const inviteStatus = (i: AdminInviteDto): 'pending' | 'accepted' | 'expired' => {
    if (i.consumedAt !== null) return 'accepted';
    if (new Date(i.expiresAt).getTime() < Date.now()) return 'expired';
    return 'pending';
  };

  /** Where focus lands when a commit removed the row whose trigger opened it (D8): the page
   * title. Deleting or disabling one's OWN account ends the session instead; the store
   * closes the dialog before the reboot, focus follows the sign-in gate, and no Users-page
   * fallback is offered. */
  const fallbackFor = (u: AdminUserDto): (() => HTMLElement | null) =>
    u.id === state.session?.userId ? () => null : pageTitle;

  /** Delete and Disable ask first, in the shared destructive confirmation
   * (adopt-red-destructive-actions D6 / D7). */
  const removeUser = (u: AdminUserDto): void => {
    app.confirmDestructive({
      title: `Delete ${u.email}?`,
      body: 'Their agents, providers and request history go with them. This cannot be undone.',
      commitLabel: 'Delete user',
      busyLabel: 'Deleting…',
      run: () => app.uaDeleteUser(u.id, FROM_DIALOG),
      fallbackFocus: fallbackFor(u),
    });
  };
  /** The disable sentences state the forward-looking guarantee: sessions and agent keys are
   * cached across instances and in-flight requests finish, so "immediately" and "now" would
   * overpromise (D7). */
  const disableUser = (u: AdminUserDto): void => {
    const self = u.id === state.session?.userId;
    app.confirmDestructive({
      title: self ? 'Disable your own account?' : `Disable ${u.email}?`,
      body: self
        ? 'You will be signed out.'
        : 'They will be signed out, and new requests with their agent keys will be refused.',
      commitLabel: self ? 'Disable my account' : 'Disable user',
      busyLabel: 'Disabling…',
      run: () => app.uaSetDisabled(u.id, true, FROM_DIALOG),
      fallbackFocus: fallbackFor(u),
    });
  };

  /** One neutral static chip for both roles: the word carries the role. Admin used to take
   * the Selected state's wash and Deep Ink, which reads as "this row is selected" and spends
   * indigo as decoration (DESIGN.md Indigo Budget; adopt-design-tokens-v2 task 16.6). */
  const roleChip = (u: AdminUserDto) => (
    <span
      class="chip"
      style={{ font: "500 0.6875rem/1rem 'Geist',sans-serif", color: 'var(--text2)' }}
    >
      {u.role === 'admin' ? 'Admin' : 'Member'}
    </span>
  );

  return (
    <div class="rs-page" style="display:flex;flex-direction:column;gap:24px;max-width:1200px">
      <Show when={state.ua.error}>
        <div role="alert" class="t-caption" style="color:var(--red-text)">
          {state.ua.error}
        </div>
      </Show>

      <div class="rs-grid-2" style="display:grid;gap:16px;align-items:start">
        {/* Registration mode */}
        <div class="panel card" aria-busy={regLoading() ? true : undefined}>
          <div class="section-title" style="color:var(--text);margin-bottom:8px">
            Registration
          </div>
          <div class="t-dense" style="color:var(--text3);margin-bottom:8px">
            The first account became the admin, then sign-up closed. Reopen it here, or keep it
            invite-only.
          </div>
          {/* Plain toggle buttons (aria-pressed), not a composite radiogroup —
              no roving-tabindex obligations, Tab reaches each one. The chosen mode takes the
              Selected state from `.btn-ghost[aria-pressed='true']` (adopt-design-tokens-v2
              D8), not an inline fill, which would outrank its hover and press. */}
          <div
            role="group"
            aria-label="Registration mode"
            style="display:flex;gap:8px;margin-bottom:8px"
          >
            <For
              each={
                [
                  ['invite_only', 'Invite only'],
                  ['open', 'Open sign-up'],
                ] as ['open' | 'invite_only', string][]
              }
            >
              {([mode, label]) => (
                <button
                  type="button"
                  aria-pressed={state.ua.reg?.mode === mode}
                  class="btn-ghost"
                  disabled={registering.busy(mode) || regLoading()}
                  aria-busy={registering.busy(mode) ? true : undefined}
                  onClick={() => {
                    if (state.ua.reg?.mode !== mode)
                      void registering.run(mode, () => app.uaSetRegistration(mode));
                  }}
                >
                  <StackedLabel alt={registering.busy(mode)} rest={label} altLabel="Saving…" />
                </button>
              )}
            </For>
          </div>
          <div class="t-caption" style="color:var(--text3)">
            {/* The SMTP sentence is a claim about loaded settings: while they load it is a
                neutral placeholder, and after a failed load it is absent. */}
            <Show
              when={state.ua.reg}
              keyed
              fallback={
                <Show when={regLoading()}>
                  <span class="ar-skel ar-skel-short" aria-hidden="true" />
                </Show>
              }
            >
              {(reg) => (
                <Show
                  when={reg.smtpConfigured}
                  fallback={
                    <>
                      SMTP isn’t configured — invite links must be copied and delivered by hand. Add
                      an SMTP channel under Settings to email them.
                    </>
                  }
                >
                  SMTP is configured — new invites are emailed automatically.
                </Show>
              )}
            </Show>
          </div>
        </div>

        {/* Invite someone */}
        <div class="panel card">
          <div class="section-title" style="color:var(--text);margin-bottom:8px">
            Invite someone
          </div>
          {/* `novalidate`: the browser's own email check reports on the field, through its
              invalid state, instead of as a bubble (task 8.2, design.md D20). The note on the
              address is the field's help, and its message replaces it while invalid. */}
          <form
            novalidate
            style="display:flex;align-items:flex-start;gap:8px"
            onSubmit={(e) => {
              e.preventDefault();
              void app.uaCreateInvite();
            }}
          >
            <div style="flex:1;min-width:0">
              <input
                type="email"
                class="input"
                id="f-ua-email"
                placeholder="teammate@example.com"
                aria-label="Email to invite"
                value={state.ua.inviteEmail}
                aria-invalid={f.invalid('f-ua-email')}
                aria-describedby={f.describedBy('f-ua-email', true)}
                onBlur={() => f.check('f-ua-email')}
                onInput={(e) => {
                  setState('ua', 'inviteEmail', e.currentTarget.value);
                  f.edit('f-ua-email');
                }}
              />
              <FieldNote
                for="f-ua-email"
                error={f.error('f-ua-email')}
                help="Links are single-use and expire after 72 hours. The invited address is fixed — the account must sign up with it."
              />
            </div>
            <button
              type="submit"
              class="btn-primary"
              disabled={state.ua.inviteBusy}
              aria-busy={state.ua.inviteBusy ? true : undefined}
            >
              <StackedLabel alt={state.ua.inviteBusy} rest="Invite" altLabel="Inviting…" />
            </button>
          </form>
          <Show when={state.ua.issued}>
            {(issued) => (
              <div style="margin-top:8px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
                <div class="t-label" style="color:var(--text);margin-bottom:4px">
                  Invite for {issued().email}
                  <span style="font-weight:400;color:var(--text3)">
                    {' '}
                    — {issued().emailSent ? 'emailed, and here’s the link:' : 'copy this link:'}
                  </span>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <code
                    class="t-caption mono"
                    style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)"
                    title={issued().link}
                  >
                    {issued().link}
                  </code>
                  <button
                    type="button"
                    class="btn-ghost"
                    onClick={() => app.copy(issued().link, 'Invite link copied')}
                  >
                    Copy
                  </button>
                </div>
                <div class="t-caption" style="color:var(--text3);margin-top:4px">
                  Shown once — a new invite is needed if it’s lost.
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>

      {/* Invites */}
      <Show when={state.ua.invites.length > 0}>
        <div class="panel card rs-table-panel rs-table-users" style="padding:0">
          <div class="section-title" style="color:var(--text);padding:12px 16px 8px">
            Invites
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr>
                <th>Email</th>
                <th>Token</th>
                <th>Expires</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              <For each={state.ua.invites}>
                {(i) => (
                  <tr class="t-dense" style="border-top:1px solid var(--border2)">
                    <td class="rs-id-cell" style="color:var(--text)">
                      <span class="rs-cell-label">Email</span>
                      {/* An identifier: cut with an end ellipsis, full text kept (task 9.2). */}
                      <span class="cell-id" title={i.email}>
                        {i.email}
                      </span>
                    </td>
                    <td class="t-caption mono" style="color:var(--text3)">
                      <span class="rs-cell-label">Token</span>
                      {i.tokenPrefix}…
                    </td>
                    <td style="color:var(--text3)">
                      <span class="rs-cell-label">Expires</span>
                      {new Date(i.expiresAt).toLocaleString()}
                    </td>
                    <td>
                      <span class="rs-cell-label">Status</span>
                      <span
                        style={{
                          font: "500 0.6875rem/1rem 'Geist',sans-serif",
                          color:
                            inviteStatus(i) === 'accepted'
                              ? 'var(--green-text)'
                              : inviteStatus(i) === 'expired'
                                ? 'var(--text3)'
                                : 'var(--text2)',
                        }}
                      >
                        {inviteStatus(i)}
                      </span>
                    </td>
                    <td style="text-align:right">
                      <span class="rs-cell-label">Actions</span>
                      <Show when={inviteStatus(i) === 'pending'}>
                        <button
                          type="button"
                          class="btn-ghost"
                          disabled={revoking.busy(i.id)}
                          aria-busy={revoking.busy(i.id) ? true : undefined}
                          onClick={() => void revoking.run(i.id, () => app.uaRevokeInvite(i.id))}
                        >
                          <StackedLabel
                            alt={revoking.busy(i.id)}
                            rest="Revoke"
                            altLabel="Revoking…"
                          />
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Users */}
      <div class="panel card rs-table-panel rs-table-users" style="padding:0">
        <div class="section-title" style="color:var(--text);padding:12px 16px 8px">
          Users
        </div>
        <Show
          when={!state.ua.loading || state.ua.users.length > 0}
          fallback={
            <div class="t-body" style="padding:0 16px 12px;color:var(--text3)">
              Loading users…
            </div>
          }
        >
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              <For each={state.ua.users}>
                {(u) => (
                  <tr class="t-dense" style="border-top:1px solid var(--border2)">
                    <td class="rs-id-cell">
                      <span class="rs-cell-label">User</span>
                      {/* One line at table width: the name, then the email — an identifier, cut
                          with an end ellipsis and keeping its full text and title (task 9.2). */}
                      <span class="rs-user-line">
                        {/* Disabled rows mute via the AA-safe muted token, never
                            opacity (which sinks text below 4.5:1). */}
                        <span
                          style={{
                            color: u.disabled ? 'var(--text3)' : 'var(--text)',
                            'font-weight': '500',
                          }}
                        >
                          {u.name}
                        </span>
                        {/* The separator only makes sense while name and email share a
                            line. In the stacked record the email wraps onto its own line,
                            where a leading "·" reads as a stray bullet. */}
                        <span class="rs-inline-sep" style="color:var(--text3)">
                          ·
                        </span>
                        <span class="cell-id" style="color:var(--text3)" title={u.email}>
                          {u.email}
                        </span>
                        <Show when={u.id === state.session?.userId}>
                          <span style="color:var(--text3)">(you)</span>
                        </Show>
                      </span>
                    </td>
                    <td>
                      <span class="rs-cell-label">Role</span>
                      {roleChip(u)}
                    </td>
                    <td style="color:var(--text3)">
                      <span class="rs-cell-label">Joined</span>
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <span class="rs-cell-label">Status</span>
                      {/* Disabled is an off state, normal configuration, so it is Ink 2 rather
                          than a severity colour (DESIGN.md "Paused / off"); the red fill also
                          read 3.91:1 as small text. */}
                      <span
                        style={{
                          font: "500 0.6875rem/1rem 'Geist',sans-serif",
                          color: u.disabled ? 'var(--text2)' : 'var(--green-text)',
                        }}
                      >
                        {u.disabled ? 'disabled' : 'active'}
                      </span>
                    </td>
                    <td>
                      <span class="rs-cell-label">Actions</span>
                      {/* One line at table width, so the identifier column, not the actions,
                          gives way (task 9.2); wraps when a phone's stacked record cannot hold
                          all three: a button's label never wraps (the height family), the row
                          does. In a class, so the stacked query can restate it. */}
                      <div class="rs-user-actions">
                        <button
                          type="button"
                          class="btn-ghost"
                          disabled={roling.busy(u.id)}
                          aria-busy={roling.busy(u.id) ? true : undefined}
                          onClick={() =>
                            void roling.run(u.id, () =>
                              app.uaSetRole(u.id, u.role === 'admin' ? null : 'admin'),
                            )
                          }
                        >
                          <StackedLabel
                            alt={roling.busy(u.id)}
                            rest={u.role === 'admin' ? 'Demote' : 'Make admin'}
                            altLabel="Saving…"
                          />
                        </button>
                        {/* Enable starts its request at once (busy) and is recoverable, so it
                            is a neutral ghost; Disable first asks, so it is a destructive
                            trigger and its confirmation's commit owns the wait. */}
                        <button
                          type="button"
                          class={u.disabled ? 'btn-ghost' : 'btn-ghost btn-ghost--destructive'}
                          disabled={enabling.busy(u.id)}
                          aria-busy={enabling.busy(u.id) ? true : undefined}
                          onClick={() =>
                            u.disabled
                              ? void enabling.run(u.id, () => app.uaSetDisabled(u.id, false))
                              : disableUser(u)
                          }
                        >
                          <StackedLabel
                            alt={enabling.busy(u.id)}
                            rest={u.disabled ? 'Enable' : 'Disable'}
                            altLabel="Enabling…"
                          />
                        </button>
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--destructive"
                          onClick={() => removeUser(u)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
