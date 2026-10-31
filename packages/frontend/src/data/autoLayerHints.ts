import type { AutoLayers } from './api';

/** The auto-layer switch rows and their availability hints
 * (redesign-auto-routing-pipeline D7) — moved out of the Routing page so every
 * hint branch is unit-testable. Pure; the copy is unchanged from the page. */

export interface LayerRow {
  id: 'structural' | 'cascade' | 'semantic';
  name: string;
  tag: string;
  desc: string;
  on: boolean;
  available: boolean;
  /** The amber line shown when `!available` — names the env that enables it. */
  unavailableHint: string;
  /** The auto-layers view has not loaded yet: `on`/`available` hold unloaded
   * defaults that say nothing about the instance and `unavailableHint` is empty,
   * so a switch never renders as "off instance-wide" before the view arrives. A
   * consumer checks this FIRST (see `layerSwitchState`). */
  loading: boolean;
}

/** What one layer switch should present: the loading state wins over every
 * other, and the unavailable hint applies only once the view says so. */
export type LayerSwitchState =
  { kind: 'loading' } | { kind: 'unavailable'; hint: string } | { kind: 'on' } | { kind: 'off' };

export function layerSwitchState(row: LayerRow): LayerSwitchState {
  if (row.loading) return { kind: 'loading' };
  if (!row.available) return { kind: 'unavailable', hint: row.unavailableHint };
  return { kind: row.on ? 'on' : 'off' };
}

/** Which half of the semantic WORKLOAD source is missing (add-semantic-workloads
 * D5) — the flag, the model, the workload centroids, or the tenant's toggle —
 * named from the auto-layers view; empty when it is effective. */
export function semanticWorkloadMissingHalf(al: AutoLayers | null): string {
  if (al === null) return 'semantic module state unknown';
  if (al.semanticWorkload === true) return '';
  if (!(al.semanticFlagEnabled ?? false)) return 'add semantic to ROUTING_AUTO_LAYERS';
  if (!(al.semanticClassifierReady ?? false))
    // The model half is a conjunction: with the embedder loaded the bundle is
    // fine and the centroids are not, so naming the path would send an
    // operator after something already correct (fix-semantic-boot-embed-budget).
    return (al.semanticEmbedderReady ?? false)
      ? 'the band centroids did not build under this model (see the boot log)'
      : 'no ready model (SEMANTIC_MODEL_PATH / the -semantic image)';
  if (!(al.semanticWorkloadAvailable ?? false))
    return 'the workload anchors did not build under this model (see the boot log)';
  if (!al.semantic) return 'the semantic layer is toggled off for this tenant';
  return 'not effective';
}

/**
 * The unavailable-L2 hint names EXACTLY the missing capability half(s)
 * (fix-image-healthcheck-and-l2-hint) — never a half that is already
 * satisfied. The model-half copy must stay true when `SEMANTIC_MODEL_PATH`
 * is set but the bundle failed to yield a ready classifier (broken bundle,
 * degenerate centroids), so it directs to verify, never claims "unset".
 * Absent fields (older API) degrade to the both-halves hint.
 */
export function semanticUnavailableHint(al: AutoLayers | null): string {
  const flag = al?.semanticFlagEnabled ?? false;
  const ready = al?.semanticClassifierReady ?? false;
  // The model half splits (fix-semantic-boot-embed-budget): with the embedder
  // LOADED, the bundle and the path are already satisfied and the centroids
  // are what failed. Naming the env var there is the same failure as naming a
  // satisfied ROUTING_AUTO_LAYERS — it costs an operator the real diagnosis.
  const embedder = al?.semanticEmbedderReady ?? false;
  if (ready && !flag)
    return 'off instance-wide — model loaded; add semantic to ROUTING_AUTO_LAYERS';
  if (!ready && embedder)
    return flag
      ? 'off instance-wide — model loaded, but its centroids did not build; see the boot log (the model path is fine)'
      : 'off instance-wide — model loaded, but its centroids did not build; see the boot log, and add semantic to ROUTING_AUTO_LAYERS';
  if (flag && !ready)
    return 'off instance-wide — no ready model; check SEMANTIC_MODEL_PATH + boot logs, or run the -semantic image';
  return 'off instance-wide — optional module; needs SEMANTIC_MODEL_PATH (or the -semantic image) + semantic in ROUTING_AUTO_LAYERS';
}

/** The three auto-layer switches in proxy order of their layers (L1, L2, L3). */
export function structuralLayers(al: AutoLayers | null): LayerRow[] {
  const loading = al === null;
  // No hint before the view loads: "off instance-wide" would be a claim about an
  // instance nothing has been heard from yet.
  const hint = (text: string): string => (loading ? '' : text);
  return [
    {
      id: 'structural',
      name: 'L1 · Structural',
      tag: '<1ms, local',
      desc: 'Language-neutral features; system prompts fingerprinted & subtracted.',
      on: al?.structural ?? false,
      available: al?.structuralAvailable ?? false,
      unavailableHint: hint('off instance-wide (ROUTING_AUTO_LAYERS)'),
      loading,
    },
    {
      id: 'semantic',
      name: 'L2 · Semantic',
      tag: 'local embed',
      desc: "Embedding classifier over the ambiguous slice — routes what structural can't read; also detects research / writing workloads (one shared embed).",
      on: al?.semantic ?? false,
      available: al?.semanticAvailable ?? false,
      unavailableHint: hint(semanticUnavailableHint(al)),
      loading,
    },
    {
      id: 'cascade',
      name: 'L3 · Cascade',
      tag: 'cheap-first',
      desc: 'Ambiguous requests try the cheap model, escalate on a failed quality check.',
      on: al?.cascade ?? false,
      available: al?.cascadeAvailable ?? false,
      unavailableHint: hint('off instance-wide (ROUTING_AUTO_LAYERS)'),
      loading,
    },
  ];
}
