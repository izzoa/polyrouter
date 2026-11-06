/**
 * Corners nest and the switch stays a capsule (dashboard-core "Corners use four locked
 * radii", scenario "Nested corners step down"; adopt-design-tokens-v2 task 3.4, design.md D7).
 *
 * The real `styles.css` is loaded and the real components are mounted, so these read the
 * radii the stylesheet and the inline styles actually compute together:
 * - the switch's track takes the 10px surface radius and stays an exact capsule at both of
 *   its sizes — its radius is at least half its height, so the two corners of each end meet;
 * - the segmented track's 6px corner holds its options across a 2px inset, and an option's
 *   radius is the outer one minus that inset: 6 − 2 = 4px.
 *
 * happy-dom does no layout, but radii, paddings and inline sizes are computed values.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Segmented } from './components/Segmented';
import { Toggle } from './components/Toggle';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

let sheet: HTMLStyleElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
});

const px = (v: string): number => parseFloat(v);

function mount(node: () => JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(node, host);
  return host;
}

describe('the switch track is a 10px capsule at both sizes (D7)', () => {
  for (const size of ['sm', 'md'] as const) {
    it(`${size}: the radius is the surface radius and at least half the track's height`, () => {
      const host = mount(() => (
        <Toggle on={false} size={size} label={`${size} switch`} onToggle={() => undefined} />
      ));
      const track = host.querySelector<HTMLElement>('[role="switch"]');
      expect(track).not.toBeNull();
      const cs = getComputedStyle(track!);
      expect(cs.borderTopLeftRadius, 'the switch track takes the 10px surface radius').toBe('10px');
      const height = px(cs.height);
      expect(height, 'the track declares its drawn height').toBeGreaterThan(0);
      // A capsule: the end corners meet. CSS clamps a radius larger than half the side, so
      // any radius ≥ h / 2 draws the same semicircular ends; one smaller leaves a flat.
      expect(
        px(cs.borderTopLeftRadius),
        `${size} track ${String(height)}px tall`,
      ).toBeGreaterThanOrEqual(height / 2);
      // The knob is the one circle inside it (D7: dots, knobs and nodes only).
      const knob = host.querySelector<HTMLElement>('.toggle-knob');
      expect(getComputedStyle(knob!).borderTopLeftRadius).toBe('50%');
      // Nested corners step down (adopt-design-tokens-v2 task 5.1 sizes): the knob is inset
      // 2px, so on the 20px track its 16px circle is an 8px radius, the track's 10 − 2. The
      // small track nests the same way (18 − 2 × 2 = a 14px knob).
      const k = getComputedStyle(knob!);
      expect(px(k.top), 'the knob is inset 2px').toBe(2);
      expect(px(k.height), `${size} knob fills the track less its insets`).toBe(height - 2 * 2);
      if (size === 'md') expect(px(k.width) / 2, 'md knob radius').toBe(10 - 2);
    });
  }
});

describe('nested corners step down by the gap between them (Nested Radius Rule)', () => {
  it('the segmented track (6px, 2px inset) holds 4px options', () => {
    const host = mount(() => (
      <Segmented
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        value="a"
        onChange={() => undefined}
      />
    ));
    const track = host.querySelector<HTMLElement>('.seg-track');
    expect(track, 'Segmented draws its track with the shared class').not.toBeNull();
    const t = getComputedStyle(track!);
    const outer = px(t.borderTopLeftRadius);
    const inset = px(t.paddingTop);
    expect(outer, 'the track is a 6px control').toBe(6);
    expect(inset, "the track's inset is the 2px control inset").toBe(2);
    for (const option of host.querySelectorAll<HTMLElement>('button')) {
      expect(px(getComputedStyle(option).borderTopLeftRadius), option.textContent ?? '').toBe(
        outer - inset,
      );
    }
  });
});
