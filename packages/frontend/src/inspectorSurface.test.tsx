/** The inspector's surface helper (add-docked-inspector D5, task 1.4).
 *
 * `useInspectorSurface` exists for the same reason `useModalSurface` does: the attributes a
 * surface claims and the layer it registers must not be able to disagree. The inspector is
 * the one surface whose modality changes while it stays open (crossing the dock threshold),
 * so the property has to hold ACROSS a kind change in place, on one element and one
 * registration. These flip `docked` both ways and read the element and the registry after
 * every flip.
 */
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unregisteredModalSurfaces, useInspectorSurface } from './a11y';
import { createAppStore, type AppStore } from './state/appState';
import { FakeApiClient } from './test/fakeClient';

afterEach(() => {
  document.body.innerHTML = '';
});

function Probe(props: { store: AppStore; docked: () => boolean; onDismiss: () => void }) {
  const surface = useInspectorSurface(props.store, {
    docked: props.docked,
    onDismiss: props.onDismiss,
  });
  return (
    <div
      class="drawer"
      id="inspector-drawer"
      data-modal={surface.modal() ? 'yes' : 'no'}
      {...surface.props}
      ref={surface.props['ref'] as (n: HTMLElement) => void}
    >
      <button type="button">inside</button>
    </div>
  );
}

function mount(docked: boolean) {
  const store = createAppStore(new FakeApiClient());
  const [isDocked, setDocked] = createSignal(docked);
  const onDismiss = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => <Probe store={store} docked={isDocked} onDismiss={onDismiss} />,
    host,
  );
  const el = (): HTMLElement => {
    const found = host.querySelector<HTMLElement>('#inspector-drawer');
    if (!found) throw new Error('inspector root not rendered');
    return found;
  };
  return { store, setDocked, onDismiss, host, el, dispose };
}

/** The attributes and the registration, read together. */
function read(h: ReturnType<typeof mount>) {
  const el = h.el();
  const layers = h.store.state.layers;
  return {
    role: el.getAttribute('role'),
    ariaModal: el.getAttribute('aria-modal'),
    label: el.getAttribute('aria-label'),
    tabindex: el.getAttribute('tabindex'),
    scrimDriver: el.getAttribute('data-modal'),
    kinds: layers.map((l) => l.kind),
    roots: layers.map((l) => l.root()),
    tokens: layers.map((l) => l.token),
  };
}

const MODAL = {
  role: 'dialog',
  ariaModal: 'true',
  label: 'Request inspector',
  tabindex: '-1',
  scrimDriver: 'yes',
  kinds: ['dialog'],
};
const DOCKED = {
  role: 'complementary',
  ariaModal: null,
  label: 'Request inspector',
  tabindex: '-1',
  scrimDriver: 'no',
  kinds: ['docked'],
};

describe('useInspectorSurface: attributes and registry kind change together, on one element', () => {
  it('flips docked → modal → docked with one registration of the same element', () => {
    const h = mount(true);
    try {
      const root = h.el();
      const first = read(h);
      expect(first).toMatchObject(DOCKED);
      expect(first.roots).toEqual([root]);
      expect(unregisteredModalSurfaces(h.host, h.store.state.layers)).toEqual([]);

      h.setDocked(false);
      const modal = read(h);
      expect(modal).toMatchObject(MODAL);
      expect(h.el(), 'the root was replaced rather than restyled').toBe(root);
      expect(modal.roots).toEqual([root]);
      expect(modal.tokens, 'the crossing re-registered the layer').toEqual(first.tokens);
      expect(unregisteredModalSurfaces(h.host, h.store.state.layers)).toEqual([]);

      h.setDocked(true);
      const back = read(h);
      expect(back).toMatchObject(DOCKED);
      expect(h.el()).toBe(root);
      expect(back.tokens).toEqual(first.tokens);
      expect(unregisteredModalSurfaces(h.host, h.store.state.layers)).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it('flips modal → docked → modal the same way', () => {
    const h = mount(false);
    try {
      const root = h.el();
      const first = read(h);
      expect(first).toMatchObject(MODAL);
      h.setDocked(true);
      expect(read(h)).toMatchObject({ ...DOCKED, roots: [root], tokens: first.tokens });
      h.setDocked(false);
      expect(read(h)).toMatchObject({ ...MODAL, roots: [root], tokens: first.tokens });
    } finally {
      h.dispose();
    }
  });

  it('takes focus on open only as a dialog, and unregisters on unmount', () => {
    const page = document.createElement('button');
    document.body.appendChild(page);
    page.focus();
    const docked = mount(true);
    expect(document.activeElement, 'the docked panel took focus on open').toBe(page);
    docked.dispose();
    expect(docked.store.state.layers).toEqual([]);

    const modal = mount(false);
    try {
      expect(document.activeElement).toBe(modal.el());
    } finally {
      modal.dispose();
    }
    expect(modal.store.state.layers).toEqual([]);
  });
});
