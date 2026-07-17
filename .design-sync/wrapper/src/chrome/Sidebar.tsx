import type * as React from 'react';
import { demoFakeOptions, mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';
import type { PageId } from '../types';

export interface SidebarProps extends CommonProps {
  /** Highlighted nav item (default "overview"). Clicking items updates it live. */
  page?: PageId;
  /** Providers-badge count (default 3; 0 hides the badge). */
  providersCount?: number;
  /** Setup-guide progress: 1 = connect an agent, 2 = 2 of 3 done, 3 = all done. */
  setupStep?: 1 | 2 | 3;
}

/** The dashboard's left navigation: logo, nav items (accent-active), setup-guide
 * card, theme toggle and instance footer. Give it `height` (e.g. 560) to pin the
 * footer to the bottom like the real shell. */
export function Sidebar(props: SidebarProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const { page, providersCount, setupStep, ...rest } = p;
    const count = typeof providersCount === 'number' ? providersCount : 3;
    const step = setupStep === 1 || setupStep === 2 || setupStep === 3 ? setupStep : 2;
    const fake = demoFakeOptions() as { providers?: unknown[]; session?: unknown };
    return mountWithApp(el, solid['Sidebar']!, rest, {
      seed: {
        page: page ?? 'overview',
        providers: (fake.providers ?? []).slice(0, Math.max(0, count)),
        session: fake.session,
      },
      init: (store) => {
        store.setState('ob', { done1: step >= 2, done2: step >= 3 });
      },
    });
  });
}
