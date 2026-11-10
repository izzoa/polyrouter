import { Index, Show, type JSX } from 'solid-js';

/** One figure of a readout strip: its label, the figure, and the qualification that states
 * a state, a comparison or a caveat. Beside the focal cell it is one row: label, figure,
 * qualification (redesign-readout-strip D1). */
export interface ReadoutCell {
  /** A stable name for the cell or row (`data-readout`), for tests and lookups. */
  id: string;
  label: JSX.Element;
  figure: JSX.Element;
  /** The qualification, at Caption size. Absent leaves its slot empty. */
  sub?: JSX.Element;
}

/** The focal cell: a cell whose figure may be followed by a qualifier and a secondary line. */
export interface ReadoutFocalCell extends ReadoutCell {
  /** Words that qualify the figure itself, such as a partly priced sum's `· 4 unpriced`
   * (adopt-figure-states D11). They follow the figure on its line, OUTSIDE the Display role,
   * so the Display figure's text is the amount alone. Absent renders nothing. */
  qualifier?: JSX.Element;
  /** A distinctly marked secondary figure under the figure line, at Body size in Ink 2, such
   * as Overview's `$3.12 served on subscription, at API rates · excluded from spend`
   * (redesign-readout-strip D2). Absent renders nothing, not an empty line. */
  secondary?: JSX.Element;
}

export interface ReadoutStripProps {
  /** The view's ONE focal figure, set at Display size. A single cell, not a list, so a second
   * Display figure cannot be expressed (dashboard-analytics "Overview and Costs state their
   * headline figures in one readout strip"; design.md D5). */
  focal: ReadoutFocalCell;
  /** Every other figure, at Title size: one row each beside the focal cell. */
  cells: readonly ReadoutCell[];
  /** Makes the panel a script-only focus target (`tabindex="-1"`) and hands it back: where a
   * load failure's Retry leaves focus, since the Retry unmounts as its load starts and the
   * panel stays through the failure and the retry (adopt-figure-states D5). */
  focusTarget?: (panel: HTMLDivElement) => void;
}

/**
 * How a page states its headline figures (DESIGN.md Readout strip; adopt-design-tokens-v2
 * task 12.1, redesign-readout-strip D1): ONE panel. The focal cell holds the view's one Display
 * figure in plain Ink; every other figure is a row beside it (label, Title figure,
 * qualification) in one rows column, ruled from the focal cell and from each other by the Soft
 * Hairline. The rows column is one grid and each row a subgrid of it, so the figures start at
 * one column; the rows divide whichever side is taller, so the two sides end level. With no
 * rows there is no column and no rule. No accent fill and no icon: the focal figure's
 * prominence comes from its size, never from colour. Below `narrow` the rows stack under the
 * focal cell.
 *
 * This is the only component that may set the Display role: `styles.typeScale.test.ts` holds
 * the class to this file, named once.
 */
export function ReadoutStrip(props: ReadoutStripProps): JSX.Element {
  return (
    <div
      ref={(el) => props.focusTarget?.(el)}
      class="panel rs-readout"
      tabindex={props.focusTarget === undefined ? undefined : -1}
      data-readout-strip
    >
      <div class="readout-cell readout-cell--focal card" data-readout={props.focal.id}>
        <div class="readout-label t-dense">{props.focal.label}</div>
        <div class="readout-line">
          <div class="readout-figure t-display">{props.focal.figure}</div>
          <Show when={props.focal.qualifier !== undefined}>
            <div class="readout-qualifier t-caption">{props.focal.qualifier}</div>
          </Show>
        </div>
        <Show when={props.focal.secondary !== undefined}>
          <div class="readout-secondary t-body">{props.focal.secondary}</div>
        </Show>
        <div class="readout-sub t-caption">{props.focal.sub}</div>
      </div>
      <Show when={props.cells.length > 0}>
        <div class="readout-rows" data-readout-rows>
          {/* By position, not by object: the page rebuilds the cell list on every poll, and a
              keyed list would replace each row's nodes when its figure changes. */}
          <Index each={props.cells}>
            {(cell) => (
              <div class="readout-row" data-readout={cell().id}>
                <div class="readout-label t-dense">{cell().label}</div>
                <div class="readout-figure t-title">{cell().figure}</div>
                <div class="readout-sub t-caption">{cell().sub}</div>
              </div>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}
