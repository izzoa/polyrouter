import { useApp } from '../state/context';
import { BASE_URL } from '../data/catalog';
import type { Page } from '../types';
import { PageIcon } from './PageIcon';
import { Icon } from './Icon';

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
  const streaming = (): boolean => state.streamHealth === 'live';
  return (
    <div
      class="rs-topbar rs-wrap"
      style="flex:none;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);background:var(--bg)"
    >
      {/* ONE flex row, not a nested group. The old markup wrapped icon+title in an inner
          flex and baseline-aligned the subtitle against that group — but a flex container
          exports its FIRST item's baseline, and the first item was the icon, which has no
          text baseline, so its bottom edge was used. The subtitle's baseline landed on the
          icon's bottom edge (~3.5px below the title's real baseline) on every page. Flat
          siblings let the title and subtitle share a true text baseline; the icon opts out
          via align-self:center, which also keeps its previous optical position (centered on
          the title's line box). */}
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="display:flex;align-self:center;color:var(--text3)" aria-hidden="true">
          <PageIcon page={state.page} size={17} />
        </span>
        <div style="font:600 16px 'Geist',sans-serif;letter-spacing:-.02em">
          {TITLES[state.page][0]}
        </div>
        {/* margin-left:2px preserves the old 10px title↔subtitle gap over the row's 8px. */}
        <div style="font:400 12px 'Geist',sans-serif;color:var(--text3);margin-left:2px">
          {TITLES[state.page][1]}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        {/* HONEST transport state (phase2-add-dashboard-event-stream): a buffering
            proxy or a dropped stream must be diagnosable, not look like an idle
            instance. Greyscale for the fallback — no second accent hue. */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            padding: '5px 11px',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            'border-radius': '7px',
            font: "500 12px 'Geist',sans-serif",
            color: streaming() ? 'var(--green-text)' : 'var(--text3)',
          }}
          title={
            streaming()
              ? 'Live updates are streaming from the server'
              : 'Streaming unavailable — falling back to periodic polling (the dashboard still updates)'
          }
        >
          {/* Only the live state pulses; the polling fallback is deliberately static. */}
          <span
            aria-hidden="true"
            classList={{ 'live-dot': streaming() }}
            style={{
              width: '6px',
              height: '6px',
              'border-radius': '50%',
              background: streaming() ? 'var(--green)' : 'var(--faint)',
            }}
          />
          {streaming() ? 'Live' : 'Polling'}
        </div>
        <button
          type="button"
          class="endpoint-chip"
          aria-label="Copy endpoint URL"
          onClick={() => app.copy(BASE_URL, 'Endpoint copied')}
        >
          /v1{' '}
          <Icon name="copy" size={12} style="color:var(--faint)" />
        </button>
      </div>
    </div>
  );
}
