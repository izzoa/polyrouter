/** A control's visible label: its text without the stacked label a reader cannot see.
 *
 * A busy-capable control renders its rest and busy labels in one grid cell and hides the
 * inactive one (`StackedLabel`, `data-shown="false"`; adopt-design-tokens-v2 D14), so its
 * `textContent` holds both — `Save budgetSaving…`. A test that finds a control by the label a
 * user sees reads it through this. Text with no stacked label is returned as it is. */
export function labelText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[data-shown="false"]')) hidden.remove();
  return (clone.textContent ?? '').trim();
}
