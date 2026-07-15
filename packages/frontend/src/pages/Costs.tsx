import { BarRows } from '../components/BarRows';
import {
  SEED_COST_BY_AGENT_30D,
  SEED_COST_BY_MODEL_30D,
  SEED_COST_BY_PROVIDER_30D,
  SEED_MONTH_COST_SUMMARY,
} from '../data/seed';

export function Costs() {
  const s = SEED_MONTH_COST_SUMMARY;
  const saved = (s.listPrice - s.spend).toFixed(2);
  return (
    <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px;max-width:1200px">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div class="panel card">
          <div class="stat-label">Spend this month</div>
          <div class="stat-value">${s.spend.toFixed(2)}</div>
          <div class="stat-sub">
            vs ${s.listPrice.toFixed(2)} at list price —{' '}
            <span style="color:var(--green)">saved ${saved}</span>
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Free vs paid</div>
          <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:14px 0 8px">
            <div style={{ width: `${String(s.splitPct.free)}%`, background: 'var(--green)' }} />
            <div
              style={{ width: `${String(s.splitPct.subscription)}%`, background: 'var(--faint)' }}
            />
            <div style="flex:1;background:var(--accent)" />
          </div>
          <div style="display:flex;gap:12px;font:400 11px 'Geist',sans-serif;color:var(--text3)">
            <span>
              <span style="color:var(--green)">■</span> {s.splitPct.free}% local/free
            </span>
            <span>
              <span style="color:var(--faint)">■</span> {s.splitPct.subscription}% subscription
            </span>
            <span>
              <span style="color:var(--accent)">■</span> {s.splitPct.api}% API
            </span>
          </div>
        </div>
        <div class="panel card">
          <div class="stat-label">Cost integrity</div>
          <div style="font:400 12px 'Geist',sans-serif;color:var(--text2);line-height:1.55">
            Every request stores its{' '}
            <span class="mono" style="font-size:11px">
              price snapshot
            </span>{' '}
            — catalog updates never rewrite history.{' '}
            <span style="color:var(--text3)">
              {s.estimatedFlagged} requests flagged ~estimated.
            </span>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="panel card">
          <div class="section-title" style="margin-bottom:14px">
            Spend by model · 30d
          </div>
          <BarRows data={SEED_COST_BY_MODEL_30D} />
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="panel card">
            <div class="section-title" style="margin-bottom:14px">
              By provider · 30d
            </div>
            <BarRows data={SEED_COST_BY_PROVIDER_30D} />
          </div>
          <div class="panel card">
            <div class="section-title" style="margin-bottom:14px">
              By agent · 30d
            </div>
            <BarRows data={SEED_COST_BY_AGENT_30D} />
          </div>
        </div>
      </div>
    </div>
  );
}
