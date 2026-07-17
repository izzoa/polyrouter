import type * as React from 'react';
import { demoFakeOptions, mountWithApp, solid } from '../../solid/design-kit.mjs';
import { useSolidMount, type CommonProps } from '../mount';

export type ModalKindId = 'newAgent' | 'keyReveal' | 'newProvider' | 'newLimit' | 'channel';

export interface ModalsProps extends CommonProps {
  /** Which dialog to show open (default "newAgent"):
   * newAgent = name + platform form; keyReveal = shown-once key + snippet;
   * newProvider = provider kind picker + credentials; newLimit = budget form;
   * channel = notification-channel form (SMTP/Apprise). */
  kind?: ModalKindId;
}

/** The dashboard's modal layer, opened to one dialog. Renders a fixed
 * backdrop + centered card; forms are the app's real interactive ones. */
export function Modals(props: ModalsProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const kind = typeof p['kind'] === 'string' ? p['kind'] : 'newAgent';
    const fake = demoFakeOptions() as Record<string, unknown>;
    return mountWithApp(
      el,
      solid['Modals']!,
      {},
      {
        fake,
        seed: { modal: kind, agents: fake['agents'], channels: fake['channels'] },
        init: (store) => {
          if (kind === 'keyReveal') {
            store.setState('kr', {
              title: 'Key minted — openclaw',
              key: 'poly_a1b2c3d4e5f67890abcdef1234567890',
              snippet:
                'export OPENAI_BASE_URL="http://127.0.0.1:3000/v1"\nexport OPENAI_API_KEY="poly_a1b2c3d4e5f67890abcdef1234567890"',
              harness: 'openai_sdk',
            });
          }
        },
      },
    );
  });
}
