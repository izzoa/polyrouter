import { For, onMount, Show } from 'solid-js';
import type { AdminInviteDto, AdminUserDto } from '../data/api';
import { useApp } from '../state/context';

/** Admin-only user administration (user-administration): registration mode,
 * invite issuing (link shown once + optional email), pending invites, and the
 * user list with role/disable/delete. The API refuses anything that would
 * leave the instance without an enabled admin; errors surface inline. */
export function Users() {
  const app = useApp();
  const { state, setState } = app;

  onMount(() => void app.loadUserAdmin());

  const inviteStatus = (i: AdminInviteDto): 'pending' | 'accepted' | 'expired' => {
    if (i.consumedAt !== null) return 'accepted';
    if (new Date(i.expiresAt).getTime() < Date.now()) return 'expired';
    return 'pending';
  };

  const removeUser = (u: AdminUserDto): void => {
    if (
      globalThis.confirm(
        `Delete ${u.email}? Their agents, providers and request history go with them. This cannot be undone.`,
      )
    ) {
      void app.uaDeleteUser(u.id);
    }
  };
  const disableUser = (u: AdminUserDto): void => {
    const self = u.id === state.session?.userId;
    if (
      globalThis.confirm(
        self
          ? 'Disable your own account? You will be signed out immediately.'
          : `Disable ${u.email}? Their sessions end now and their agent keys stop working.`,
      )
    ) {
      void app.uaSetDisabled(u.id, true);
    }
  };

  const roleChip = (u: AdminUserDto) => (
    <span
      style={{
        padding: '2px 9px',
        'border-radius': '10px',
        font: "500 10.5px 'Geist',sans-serif",
        background: u.role === 'admin' ? 'var(--accent-bg)' : 'var(--chip)',
        color: u.role === 'admin' ? 'var(--accent-deep)' : 'var(--text2)',
      }}
    >
      {u.role === 'admin' ? 'Admin' : 'Member'}
    </span>
  );

  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <Show when={state.ua.error}>
        <div role="alert" style="font:400 11.5px 'Geist',sans-serif;color:var(--red)">
          {state.ua.error}
        </div>
      </Show>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
        {/* Registration mode */}
        <div class="panel card">
          <div class="section-title" style="color:var(--text);margin-bottom:6px">
            Registration
          </div>
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text3);line-height:1.5;margin-bottom:10px">
            The first account became the admin, then sign-up closed. Reopen it here, or keep it
            invite-only.
          </div>
          {/* Plain toggle buttons (aria-pressed), not a composite radiogroup —
              no roving-tabindex obligations, Tab reaches each one. */}
          <div role="group" aria-label="Registration mode" style="display:flex;gap:6px;margin-bottom:8px">
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
                  style={{
                    background: state.ua.reg?.mode === mode ? 'var(--accent-bg)' : undefined,
                    color: state.ua.reg?.mode === mode ? 'var(--accent-deep)' : undefined,
                  }}
                  onClick={() => {
                    if (state.ua.reg?.mode !== mode) void app.uaSetRegistration(mode);
                  }}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5">
            <Show
              when={state.ua.reg?.smtpConfigured}
              fallback={
                <>
                  SMTP isn’t configured — invite links must be copied and delivered by hand. Add an
                  SMTP channel under Settings to email them.
                </>
              }
            >
              SMTP is configured — new invites are emailed automatically.
            </Show>
          </div>
        </div>

        {/* Invite someone */}
        <div class="panel card">
          <div class="section-title" style="color:var(--text);margin-bottom:6px">
            Invite someone
          </div>
          <form
            style="display:flex;gap:6px"
            onSubmit={(e) => {
              e.preventDefault();
              void app.uaCreateInvite();
            }}
          >
            <input
              type="email"
              placeholder="teammate@example.com"
              aria-label="Email to invite"
              value={state.ua.inviteEmail}
              onInput={(e) => setState('ua', 'inviteEmail', e.currentTarget.value)}
              style="flex:1;min-width:0"
            />
            <button type="submit" class="btn-primary" disabled={state.ua.inviteBusy}>
              {state.ua.inviteBusy ? 'Inviting…' : 'Invite'}
            </button>
          </form>
          <div style="font:400 11px 'Geist',sans-serif;color:var(--text3);line-height:1.5;margin-top:8px">
            Links are single-use and expire after 72 hours. The invited address is fixed — the
            account must sign up with it.
          </div>
          <Show when={state.ua.issued}>
            {(issued) => (
              <div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
                <div style="font:500 11.5px 'Geist',sans-serif;color:var(--text);margin-bottom:4px">
                  Invite for {issued().email}
                  <span style="font-weight:400;color:var(--text3)">
                    {' '}
                    — {issued().emailSent ? 'emailed, and here’s the link:' : 'copy this link:'}
                  </span>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <code
                    style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11px 'Geist Mono',monospace;color:var(--text2)"
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
                <div style="font:400 10.5px 'Geist',sans-serif;color:var(--text3);margin-top:4px">
                  Shown once — a new invite is needed if it’s lost.
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>

      {/* Invites */}
      <Show when={state.ua.invites.length > 0}>
        <div class="panel card" style="padding:0">
          <div class="section-title" style="color:var(--text);padding:14px 16px 8px">
            Invites
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="text-align:left;font:500 10.5px 'Geist',sans-serif;color:var(--text3)">
                <th style="padding:6px 16px;font-weight:500">Email</th>
                <th style="padding:6px 8px;font-weight:500">Token</th>
                <th style="padding:6px 8px;font-weight:500">Expires</th>
                <th style="padding:6px 8px;font-weight:500">Status</th>
                <th style="padding:6px 16px" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              <For each={state.ua.invites}>
                {(i) => (
                  <tr style="border-top:1px solid var(--border2);font:400 12px 'Geist',sans-serif">
                    <td style="padding:8px 16px;color:var(--text)">{i.email}</td>
                    <td style="padding:8px 8px;font:400 11px 'Geist Mono',monospace;color:var(--text3)">
                      {i.tokenPrefix}…
                    </td>
                    <td style="padding:8px 8px;color:var(--text3)">
                      {new Date(i.expiresAt).toLocaleString()}
                    </td>
                    <td style="padding:8px 8px">
                      <span
                        style={{
                          font: "500 10.5px 'Geist',sans-serif",
                          color:
                            inviteStatus(i) === 'accepted'
                              ? 'var(--green)'
                              : inviteStatus(i) === 'expired'
                                ? 'var(--text3)'
                                : 'var(--text2)',
                        }}
                      >
                        {inviteStatus(i)}
                      </span>
                    </td>
                    <td style="padding:8px 16px;text-align:right">
                      <Show when={inviteStatus(i) === 'pending'}>
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--amber"
                          onClick={() => void app.uaRevokeInvite(i.id)}
                        >
                          Revoke
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
      <div class="panel card" style="padding:0">
        <div class="section-title" style="color:var(--text);padding:14px 16px 8px">
          Users
        </div>
        <Show
          when={!state.ua.loading || state.ua.users.length > 0}
          fallback={
            <div style="padding:0 16px 14px;font:400 12.5px 'Geist',sans-serif;color:var(--text3)">
              Loading users…
            </div>
          }
        >
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="text-align:left;font:500 10.5px 'Geist',sans-serif;color:var(--text3)">
                <th style="padding:6px 16px;font-weight:500">User</th>
                <th style="padding:6px 8px;font-weight:500">Role</th>
                <th style="padding:6px 8px;font-weight:500">Joined</th>
                <th style="padding:6px 8px;font-weight:500">Status</th>
                <th style="padding:6px 16px" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              <For each={state.ua.users}>
                {(u) => (
                  <tr style="border-top:1px solid var(--border2);font:400 12px 'Geist',sans-serif">
                    <td style="padding:8px 16px">
                      {/* Disabled rows mute via the AA-safe muted token, never
                          opacity (which sinks text below 4.5:1). */}
                      <span
                        style={{
                          color: u.disabled ? 'var(--text3)' : 'var(--text)',
                          'font-weight': '500',
                        }}
                      >
                        {u.name}
                      </span>{' '}
                      <span style="color:var(--text3)">
                        · {u.email}
                        {u.id === state.session?.userId ? ' (you)' : ''}
                      </span>
                    </td>
                    <td style="padding:8px 8px">{roleChip(u)}</td>
                    <td style="padding:8px 8px;color:var(--text3)">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td style="padding:8px 8px">
                      <span
                        style={{
                          font: "500 10.5px 'Geist',sans-serif",
                          color: u.disabled ? 'var(--red)' : 'var(--green)',
                        }}
                      >
                        {u.disabled ? 'disabled' : 'active'}
                      </span>
                    </td>
                    <td style="padding:8px 16px">
                      <div style="display:flex;gap:6px;justify-content:flex-end">
                        <button
                          type="button"
                          class="btn-ghost"
                          onClick={() =>
                            void app.uaSetRole(u.id, u.role === 'admin' ? null : 'admin')
                          }
                        >
                          {u.role === 'admin' ? 'Demote' : 'Make admin'}
                        </button>
                        <button
                          type="button"
                          class="btn-ghost"
                          onClick={() =>
                            u.disabled ? void app.uaSetDisabled(u.id, false) : disableUser(u)
                          }
                        >
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button
                          type="button"
                          class="btn-ghost btn-ghost--amber"
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
