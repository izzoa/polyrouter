import { Index, Show, type JSX } from 'solid-js';

/** One figure of a readout strip: its label, the figure, and the sub-line that states the
 * figure's qualification — a state, a comparison or a caveat. */
export interface ReadoutCell {
  /** A stable name for the cell (`data-readout`), for tests and lookups. */
  id: string;
  label: JSX.Element;
  figure: JSX.Element;
  /** The qualification, at Caption size. Absent renders an empty line. */
  sub?: JSX.Element;
}

/** The focal cell: a cell whose figure may be followed by a qualifier. */
export interface ReadoutFocalCell extends ReadoutCell {
  /** Words that qualify the figure itself, such as a partly priced sum's `· 4 unpriced`
   * (adopt-figure-states D11). They follow the figure on its line, OUTSIDE the Display role,
   * so the Display figure's text is the amount alone. Absent renders nothing. */
  qualifier?: JSX.Element;
}

export interface ReadoutStripProps {
  /** The view's ONE focal figure, set at Display size. A single cell, not a list, so a second
   * Display figure cannot be expressed (dashboard-analytics "Overview and Costs state their
   * headline figures in one readout strip"; design.md D5). */
  focal: ReadoutFocalCell;
  /** Every other figure, at Title size, each with its label on the same line. */
  cells: readonly ReadoutCell[];
  /** Makes the panel a script-only focus target (`tabindex="-1"`) and hands it back: where a
   * load failure's Retry leaves focus, since the Retry unmounts as its load starts and the
   * panel stays through the failure and the retry (adopt-figure-states D5). */
  focusTarget?: (panel: HTMLDivElement) => void;
}

/**
 * How a page states its headline figures (DESIGN.md Readout strip; adopt-design-tokens-v2
 * task 12.1): ONE panel divided into cells by Soft Hairline rules, replacing a row of identical
 * number tiles. The focal cell holds the view's one Display figure in plain Ink; the others hold
 * Title figures. No accent fill and no icon: the focal figure's prominence comes from its size,
 * never from colour. Below `narrow` the cells stack, focal first.
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
        <div class="readout-sub t-caption">{props.focal.sub}</div>
      </div>
      {/* By position, not by object: the page rebuilds the cell list on every poll, and a
          keyed list would replace each cell's nodes when its figure changes. */}
      <Index each={props.cells}>
        {(cell) => (
          <div class="readout-cell card" data-readout={cell().id}>
            <div class="readout-head">
              <div class="readout-label t-dense">{cell().label}</div>
              <div class="readout-figure t-title">{cell().figure}</div>
            </div>
            <Show when={cell().sub !== undefined}>
              <div class="readout-sub t-caption">{cell().sub}</div>
            </Show>
          </div>
        )}
      </Index>
    </div>
  );
}
