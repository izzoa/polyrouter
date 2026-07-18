import { useApp } from '../state/context';
import { BASE_URL } from '../data/catalog';
import type { Page } from '../types';

const TITLES: Record<Page, [string, string]> = {
  overview: ['Overview', 'last 24 hours'],
  requests: ['Requests', 'every routed call, with its why'],
  costs: ['Costs', 'where the money goes'],
  agents: ['Agents', 'things that call the router'],
  providers: ['Providers', 'where requests get served'],
  routing: ['Routing', 'tiers, fallbacks & auto layers'],
  limits: ['Limits', 'budgets that alert or block'],
  settings: ['Settings', 'instance & notifications'],
  users: ['Users', 'who can sign in, and how'],
  setup: ['Setup guide', 'three steps to your first routed request'],
};

export function Topbar() {
  const app = useApp();
  const { state } = app;
  return (
    <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 26px;border-bottom:1px solid var(--border);background:var(--bg)">
      <div style="display:flex;align-items:baseline;gap:10px">
        <div style="font:600 16px 'Geist',sans-serif;letter-spacing:-.02em">
          {TITLES[state.page][0]}
        </div>
        <div style="font:400 12px 'Geist',sans-serif;color:var(--text3)">
          {TITLES[state.page][1]}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="display:flex;align-items:center;gap:6px;padding:5px 11px;background:var(--panel);border:1px solid var(--border);border-radius:7px;font:500 12px 'Geist',sans-serif;color:var(--green)">
          <span
            aria-hidden="true"
            style="width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite"
          />
          Live
        </div>
        <button
          type="button"
          class="endpoint-chip"
          aria-label="Copy endpoint URL"
          onClick={() => app.copy(BASE_URL, 'Endpoint copied')}
        >
          /v1{' '}
          <span aria-hidden="true" style="color:var(--faint)">
            ⧉
          </span>
        </button>
      </div>
    </div>
  );
}
