/** Shared navigation for the Routing page's tabs and the Auto routing tab's stage
 * details (redesign-auto-routing-pipeline).
 *
 * Every helper THROWS when what it reaches for is not on screen. A suite that silently
 * stayed on Tiers & headers, or read a collapsed stage, would assert against content
 * that is not rendered — and an absence assertion would then pass for the wrong reason.
 */

/** Long enough for the Auto routing tab's first show to start (and the fake to settle)
 * the aggregation fetch, and for a stage's blocks to fetch on first mount. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

export type RoutingTab = 'Tiers & headers' | 'Auto routing';

/** Switch the Routing page to a tab. Scoped to the tab control's own group, so it can
 * never hit `RangeSelector`, which uses the same `Segmented` control. */
export async function openTab(host: HTMLElement, label: RoutingTab): Promise<void> {
  const seg = [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="routing-sections"] .rs-seg'),
  ].find((b) => b.textContent?.trim() === label);
  if (!seg) throw new Error(`Routing tab "${label}" is not offered`);
  seg.click();
  await settle();
}

export function openAutoTab(host: HTMLElement): Promise<void> {
  return openTab(host, 'Auto routing');
}

/** The five stages with a detail — every stage except Confident band. */
export const EXPANDABLE_STAGES = [
  'Classify',
  'Workload claim',
  'Semantic',
  'Cascade',
  'Default',
] as const;
export type StageName = (typeof EXPANDABLE_STAGES)[number];

/** A stage's expander: a real button, named for its stage. */
export function stageExpander(host: HTMLElement, name: StageName): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(`button[aria-label="${name} details"]`);
  if (!btn) throw new Error(`Stage "${name}" has no expander — is the Auto routing tab open?`);
  return btn;
}

/** Open a stage's detail (a no-op when it is already open) and return it. */
export async function expandStage(host: HTMLElement, name: StageName): Promise<HTMLElement> {
  const btn = stageExpander(host, name);
  if (btn.getAttribute('aria-expanded') !== 'true') {
    btn.click();
    await settle();
  }
  const id = btn.getAttribute('aria-controls');
  const detail = id === null ? null : host.querySelector<HTMLElement>(`[id="${id}"]`);
  if (!detail) throw new Error(`Stage "${name}" did not open its detail`);
  return detail;
}

/** Open every stage's detail. */
export async function expandAllStages(host: HTMLElement): Promise<void> {
  for (const name of EXPANDABLE_STAGES) await expandStage(host, name);
}

/* ── The Targets matrix (redesign-auto-routing-pipeline D9) ─────────────────────── */

export type TargetsRowId = 'any' | 'code' | 'vision' | 'structured' | 'research' | 'writing';
export type TargetsColumn = 'claim' | 'strong' | 'cheap';

/** The Targets matrix. Throws when it is not rendered (the Auto routing tab is closed, or
 * the structural capability is absent) — use a plain query to assert its absence. */
export function targetsMatrix(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('[data-testid="targets-matrix"]');
  if (!el) throw new Error('the Targets matrix is not rendered — is the Auto routing tab open?');
  return el;
}

/** One matrix row: "Any request" (`any`) or a workload class. */
export function targetsRow(host: HTMLElement, id: TargetsRowId): HTMLElement {
  const el = targetsMatrix(host).querySelector<HTMLElement>(
    `[data-testid="targets-row"][data-row="${id}"]`,
  );
  if (!el) throw new Error(`the Targets matrix has no "${id}" row`);
  return el;
}

/** One target cell, by row and column. */
export function targetsCell(
  host: HTMLElement,
  id: TargetsRowId,
  column: TargetsColumn,
): HTMLElement {
  const el = targetsRow(host, id).querySelector<HTMLElement>(
    `[data-testid="targets-cell"][data-column="${column}"]`,
  );
  if (!el) throw new Error(`the "${id}" row has no ${column} cell`);
  return el;
}

/** A cell's picker by its cell-scoped accessible name, e.g. "Cheap target for code" or
 * "Strong target for any request". */
export function targetPicker(host: HTMLElement, label: string): HTMLSelectElement {
  const el = targetsMatrix(host).querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!el) throw new Error(`no picker named "${label}" in the Targets matrix`);
  return el;
}

/** A button inside `root` by its visible text (Clear, clean up). */
export function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );
}

/* ── The tuning drawers (split-auto-routing-readout-setup D8) ─────────────────────── */

export type TuningName = 'calibration' | 'learning';

/** A Layers cell's tuning entry. Throws when it is not offered (the tab is closed, or the
 * card's own precondition does not hold) — use a plain query to assert its absence. */
export function tuningEntry(host: HTMLElement, name: TuningName): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(
    `[data-testid="tuning-entry"][data-tuning="${name}"]`,
  );
  if (!el) throw new Error(`no ${name} tuning entry — is the Auto routing tab open?`);
  return el;
}

/** The open tuning drawer, or null. */
export function tuningDrawerOrNull(host: HTMLElement, name: TuningName): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="tuning-drawer"][data-tuning="${name}"]`);
}

/** Open a tuning drawer from its entry (a no-op when it is already open) and return it. */
export async function openTuning(host: HTMLElement, name: TuningName): Promise<HTMLElement> {
  const entry = tuningEntry(host, name);
  if (entry.getAttribute('aria-expanded') !== 'true') {
    // A real activation focuses the control first (keyboard, or a pointer in most
    // browsers); `click()` alone does not, and the drawer returns focus to its invoker.
    entry.focus();
    entry.click();
    await settle();
  }
  const drawer = tuningDrawerOrNull(host, name);
  if (!drawer) throw new Error(`the ${name} tuning drawer did not open`);
  return drawer;
}

/* ── Pipeline rows (split-auto-routing-readout-setup D2) ─────────────────────────────── */

/** A row cell's visible text, whitespace-squashed, WITHOUT its field labels — the "Status
 * now" / "Requests, 7d" labels are real text for assistive tech (shown on a phone) and
 * would otherwise prefix every figure. */
export function cellText(el: Element | null | undefined): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  for (const label of clone.querySelectorAll('.ar-fieldlabel')) label.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}
