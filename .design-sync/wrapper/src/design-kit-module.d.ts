/** Ambient types for the stage-1 compiled Solid lib (solid/design-kit.mjs —
 * built by `vite build`, gitignored). Kept deliberately loose: the adapters'
 * PUBLIC props interfaces are the precise contract the design agent sees; the
 * Solid side is an internal mounting surface. */
declare module '*design-kit.mjs' {
  export type Disposer = () => void;
  export type SolidComponent = (props: Record<string, unknown>) => unknown;

  /** The app's real compiled Solid components/pages, keyed by name. */
  export const solid: Record<string, SolidComponent>;

  export interface AppMountOptions {
    /** Constructor options for the app's own FakeApiClient (demo data). */
    fake?: Record<string, unknown>;
    /** Top-level AppState patch applied via store.setState before render. */
    seed?: Record<string, unknown>;
    /** Escape hatch for nested seeds (runs after `seed`). */
    init?: (store: { state: Record<string, unknown>; setState: (...args: unknown[]) => void }) => void;
  }

  export function mountPlain(
    el: HTMLElement,
    comp: SolidComponent,
    props: Record<string, unknown>,
  ): Disposer;
  export function mountWithApp(
    el: HTMLElement,
    comp: SolidComponent,
    props: Record<string, unknown>,
    opts?: AppMountOptions,
  ): Disposer;

  export function demoFakeOptions(): Record<string, unknown>;
  export const demoProviders: Record<string, unknown>[];
  export const demoAgents: Record<string, unknown>[];
  export const demoModels: Record<string, Record<string, unknown>[]>;
  export const demoTiers: Record<string, unknown>[];
  export const demoTierEntries: Record<string, Record<string, unknown>[]>;
  export const demoRules: Record<string, unknown>[];
  export const demoBudgets: Record<string, unknown>[];
  export const demoChannels: Record<string, unknown>[];
  export const demoSpend: { n: string; v: number; fv?: number; free?: boolean }[];
  export function demoSummary(): Record<string, unknown>;
  export function demoTimeseries(): Record<string, unknown>[];
  export function demoChartData(): [number[], number[]];
  export function demoRequestRows(n?: number): Record<string, unknown>[];
}
