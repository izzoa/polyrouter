import type * as React from 'react';
import { useSolidMount, type CommonProps } from '../mount';
import { mountPage } from './page';

export interface LoginProps extends CommonProps {
  /** OAuth buttons to offer (default github + google; [] for email/password only). */
  oauthProviders?: string[];
}

/** The full auth gate: centered sign-in/sign-up card with email/password and
 * optional OAuth buttons (try height 640). */
export function Login(props: LoginProps): React.ReactElement {
  return useSolidMount(props, (el, p) => {
    const { oauthProviders, ...rest } = p;
    return mountPage(el, 'Login', rest, {
      authView: 'gate',
      loginConfig: {
        mode: 'selfhosted',
        emailPassword: true,
        oauthProviders: Array.isArray(oauthProviders) ? oauthProviders : ['github', 'google'],
      },
    });
  });
}
