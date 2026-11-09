/**
 * The busy-action table (adopt-design-tokens-v2 task 4.4, design.md D14 "Which buttons are
 * busy"; dashboard-core "A new request-starting button cannot skip the busy state").
 *
 * One row per request a component starts — every call a TSX file discards with `void`,
 * which is the codebase's idiom for a fire-and-forget request (the type-checked lint rules
 * force it). Each is classed, so a new request-starting button cannot ship without a
 * decision:
 *
 * - `busy`: natively disabled while its request is in flight, `aria-busy`, with a progressive
 *   label stacked over its rest label so it keeps its width (StackedLabel). A glyph-only
 *   control (`×`) carries its progressive label in its accessible name instead.
 * - `switch`: a `Toggle` — D3's busy state (`aria-disabled`, focus kept), never native
 *   `disabled`.
 * - `drawer`: a control inside a tuning drawer. Native `disabled` drops focus, and the
 *   drawer's controls must keep it (dashboard-config), so none takes the busy state.
 * - `destructive`: a destructive trigger whose call only opens its confirmation, the shared
 *   ConfirmDialog (adopt-red-destructive-actions D6). The trigger is not busy, because the
 *   confirmation's commit is: that commit's launch is the `busy` row
 *   `components/ConfirmDialog.tsx settle` (dashboard-core "A card action shows that it is
 *   working").
 * - `leaves-page`: sign-in, sign-up, sign-out and OAuth navigate away.
 * - `unmounts`: the click removes the button itself (a failure notice's Retry clears the
 *   failure as its load restarts; a confirmation's commit closes the dialog first).
 * - `dialog`: the click opens a dialog that carries the wait (the reconnect dialog shows its
 *   own in-flight state over the page). See notes/flags.md F3.
 * - `not-a-button`: an effect, a mount load, a select or radio change, or a background
 *   write the click only queues (an optimistic reorder).
 *
 * Keys: `<file under src> <call>`, with `#n` (the nth such call in the file, in source
 * order) when a file makes the same call more than once. `<call>` is `app.<action>` for a
 * store action, or the local function for a local call (`load`, `clear`, `props.onSave`).
 * `busyActions.test.ts` derives every key from the source and fails on one without a row;
 * `busyActions.view.test.tsx` walks every `busy` and `unmounts` row in the rendered app.
 *
 * Lives in `src/test/`, not in a `.test.ts` file, so both suites can import it without one
 * registering the other's tests.
 */
export type BusyClass =
  | 'busy'
  | 'switch'
  | 'drawer'
  | 'destructive'
  | 'leaves-page'
  | 'unmounts'
  | 'dialog'
  | 'not-a-button';

export interface BusyRow {
  key: string;
  cls: BusyClass;
  /** What the control is, and why it takes this class. */
  why: string;
  /** For a `busy` row: the label shown while the request is in flight. */
  busyLabel?: string;
  /** For a `busy` row whose button another component renders: that component's file. */
  labelIn?: string;
}

export const BUSY_ACTIONS: readonly BusyRow[] = [
  // App shell
  { key: 'App.tsx app.bootstrap', cls: 'not-a-button', why: 'the boot load, on mount' },
  {
    key: 'App.tsx app.retry',
    cls: 'unmounts',
    why: '"Couldn’t reach the server" Retry: the retry re-enters the loading view',
  },
  { key: 'components/UserMenu.tsx app.signOut', cls: 'leaves-page', why: 'Log out' },

  // Body capture (Settings)
  {
    key: 'components/BodyCaptureCard.tsx app.setBodyCaptureMode#1',
    cls: 'not-a-button',
    why: 'a capture-mode radio change',
  },
  {
    key: 'components/BodyCaptureCard.tsx app.setBodyCaptureRetention#1',
    cls: 'not-a-button',
    why: 'the retention select change (keep forever, after its native consent prompt)',
  },
  {
    key: 'components/BodyCaptureCard.tsx app.setBodyCaptureRetention#2',
    cls: 'not-a-button',
    why: 'the retention select change',
  },
  {
    key: 'components/BodyCaptureCard.tsx app.setAgentBodyOverride',
    cls: 'not-a-button',
    why: 'a per-agent override select change',
  },
  {
    key: 'components/BodyCaptureCard.tsx app.setBodyCaptureMode#2',
    cls: 'unmounts',
    why: 'the consent dialog’s Capture bodies: it closes the dialog, then saves',
  },

  // The shared destructive confirmation (adopt-red-destructive-actions D6)
  {
    // One launch for the commit and the secondary action, both busy on the dialog's one busy
    // flag. The dialog renders each request's own progressive label, so the label is checked
    // at a call site that opens it: an agent's Delete (`Delete agent`, then `Deleting…`).
    key: 'components/ConfirmDialog.tsx settle',
    cls: 'busy',
    busyLabel: 'Deleting…',
    labelIn: 'pages/Agents.tsx',
    why: 'the shared destructive confirmation’s commit (and its secondary action), one launch',
  },

  // Request inspector
  {
    key: 'components/Inspector.tsx app.loadSelectedBodies',
    cls: 'unmounts',
    why: 'Show bodies: the payload section swaps it for its Loading line at once',
  },

  // Modals
  {
    key: 'components/OauthSteps.tsx app.completeOauthConnect',
    cls: 'busy',
    busyLabel: 'Connecting…',
    why: 'the subscription sign-in Connect (the paste-back step, shared by a connect and a reconnect)',
  },
  {
    key: 'components/SubscriptionPicker.tsx app.connectKeyPreset',
    cls: 'busy',
    busyLabel: 'Connecting…',
    why: 'the picker footer’s Connect <plan> for a key preset (redesign-subscription-picker): it stays until the connect settles',
  },
  {
    key: 'components/Modals.tsx app.createAgent',
    cls: 'busy',
    busyLabel: 'Minting…',
    why: 'the agent modal’s Create & mint key',
  },
  {
    key: 'components/Modals.tsx app.startOauthReauthorize#1',
    cls: 'unmounts',
    why: 'the reconnect failure’s Try again: the retry clears the failure it sits in',
  },
  {
    key: 'components/Modals.tsx app.startOauthReauthorize#2',
    cls: 'unmounts',
    why: 'the provider editor’s Reconnect: the modal switches to the reconnect view at once',
  },
  {
    key: 'components/SubscriptionPicker.tsx app.startOauthConnect#1',
    cls: 'busy',
    busyLabel: 'Connecting…',
    why: 'the identity step’s Continue to sign-in (allow-preset-client-identity): it stays until the sign-in starts',
  },
  {
    key: 'components/SubscriptionPicker.tsx app.startOauthConnect#2',
    cls: 'busy',
    busyLabel: 'Connecting…',
    why: 'the picker footer’s Sign in for an OAuth plan that declares no identity: it stays until the sign-in starts',
  },
  {
    key: 'components/Modals.tsx app.addProvider',
    cls: 'busy',
    busyLabel: 'Adding…',
    why: 'the provider modal’s Add provider (Saving… when editing)',
  },
  {
    key: 'components/Modals.tsx app.saveBudget',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'the budget modal’s Create / Save budget',
  },
  {
    key: 'components/Modals.tsx app.saveChannel',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'the channel modal’s Add / Save channel',
  },

  // Accept invite, Login
  {
    key: 'pages/AcceptInvite.tsx app.acceptInvite',
    cls: 'leaves-page',
    why: 'accepting signs the user in and reboots the app on their session',
  },
  { key: 'pages/Login.tsx app.signUp', cls: 'leaves-page', why: 'Create account' },
  { key: 'pages/Login.tsx app.signIn', cls: 'leaves-page', why: 'Sign in' },
  { key: 'pages/Login.tsx app.oauth', cls: 'leaves-page', why: 'Continue with <provider>' },

  // Agents
  { key: 'pages/Agents.tsx app.loadAgentStats#1', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Agents.tsx app.loadAgentStats#2',
    cls: 'unmounts',
    why: 'the activity failure notice’s Retry: the load clears the failure it sits in',
  },
  {
    key: 'pages/Agents.tsx app.rotateKey',
    cls: 'busy',
    busyLabel: 'Rotating…',
    why: 'Rotate key, per agent',
  },

  // Batches
  { key: 'pages/Batches.tsx load', cls: 'not-a-button', why: 'the page’s mount load' },

  // Costs, Overview, Limits
  { key: 'pages/Costs.tsx app.loadCosts#1', cls: 'not-a-button', why: 'the range effect' },
  {
    key: 'pages/Costs.tsx app.loadCosts#2',
    cls: 'unmounts',
    why: 'the failure notice’s Retry: the load clears the failure it sits in',
  },
  { key: 'pages/Overview.tsx app.loadOverview#1', cls: 'not-a-button', why: 'the range effect' },
  { key: 'pages/Overview.tsx app.loadAgentStrip#1', cls: 'not-a-button', why: 'the range effect' },
  {
    key: 'pages/Overview.tsx app.loadAgentStrip#2',
    cls: 'unmounts',
    why: 'the agent strip’s failure notice’s Retry: the load clears the failure it sits in',
  },
  {
    key: 'pages/Overview.tsx app.loadOverview#2',
    cls: 'unmounts',
    why: 'the failure notice’s Retry: the load clears the failure it sits in',
  },
  { key: 'pages/Limits.tsx app.loadLimits', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Limits.tsx app.requestAggregateRefresh',
    cls: 'busy',
    busyLabel: 'Retrying…',
    labelIn: 'components/BudgetProgress.tsx',
    why: 'a budget card’s Retry progress (BudgetProgress): over stale progress it stays while the progress reloads, so it is busy; with no progress it hides while loading',
  },

  // Providers
  {
    key: 'pages/Providers.tsx props.onSave#1',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'Save price, marked free (ModelPriceEditor; the card passes app.setModelPrice)',
  },
  {
    key: 'pages/Providers.tsx props.onSave#2',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'Save price, with both prices (the same button as #1)',
  },
  {
    key: 'pages/Providers.tsx app.loadModels',
    cls: 'not-a-button',
    why: 'the Models disclosure opens the list, and the list reports its own read. See F3',
  },
  {
    key: 'pages/Providers.tsx app.startOauthReauthorize',
    cls: 'dialog',
    why: 'a card’s Reconnect opens the reconnect dialog, which shows the wait. See F3',
  },
  {
    key: 'pages/Providers.tsx app.testProviderById',
    cls: 'busy',
    busyLabel: 'Testing…',
    why: 'Test, on a provider card',
  },
  {
    key: 'pages/Providers.tsx app.syncProvider',
    cls: 'busy',
    busyLabel: 'Syncing…',
    why: 'Sync models, on a provider card',
  },
  {
    key: 'pages/Providers.tsx app.resumeProviderPlan',
    cls: 'busy',
    busyLabel: 'Resuming…',
    why: 'Resume now, on a plan-paused provider card (classify-plan-quota-errors). A risk-control pause asks first: the consent dialog’s commit drives this same busy state, and is walked in planCooldown.view.test.tsx',
  },
  {
    key: 'pages/Providers.tsx app.refreshPlanUsage',
    cls: 'busy',
    busyLabel: 'Refreshing…',
    why: 'Refresh usage, on a key-plan provider card (add-subscription-quota-display). After a read the button stays disabled for the shared cooldown and says when it returns, so its scenario walks the refused path, which leaves it at rest; the success path is walked in Providers.planUsageRefresh.view.test.tsx',
  },
  {
    key: 'pages/Providers.tsx app.removeUnlistedModel#1',
    cls: 'destructive',
    why: 'Remove on an unlisted model: the store counts its impact, then opens the shared confirmation, whose commit is busy',
  },
  {
    key: 'pages/Providers.tsx app.removeUnlistedModel#2',
    cls: 'destructive',
    why: 'Remove on an unlisted batch twin: the store counts its impact, then opens the shared confirmation, whose commit is busy',
  },
  { key: 'pages/Providers.tsx app.loadProviders#1', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Providers.tsx app.loadKeyPresets',
    cls: 'not-a-button',
    why: 'the mount load of the offered key presets, which name each card’s terms risk',
  },
  {
    key: 'pages/Providers.tsx app.loadProviders#2',
    cls: 'not-a-button',
    why: 'the reload when the tab becomes visible',
  },

  // Requests
  { key: 'pages/Requests.tsx app.loadRequests#1', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Requests.tsx app.loadRequests#2',
    cls: 'unmounts',
    why: 'the failure notice’s Retry: the load clears the failure it sits in',
  },
  {
    key: 'pages/Requests.tsx app.loadRequests#3',
    cls: 'unmounts',
    why: 'the new-rows pill: a reset load drops the pill as it starts',
  },
  {
    key: 'pages/Requests.tsx app.loadRequests#4',
    cls: 'busy',
    busyLabel: 'Loading…',
    why: 'Load more',
  },

  // Routing
  {
    key: 'pages/Routing.tsx app.retryRulesReconcile',
    cls: 'busy',
    busyLabel: 'Retrying…',
    why: 'the Targets unverified notice’s Retry: the notice stays until a reconcile commits',
  },
  {
    key: 'pages/Routing.tsx app.setBandTarget',
    cls: 'not-a-button',
    why: 'a Targets cell picker’s change (a select)',
  },
  {
    key: 'pages/Routing.tsx app.setWorkloadTarget',
    cls: 'not-a-button',
    why: 'a Targets cell picker’s change (a select)',
  },
  {
    key: 'pages/Routing.tsx clear',
    cls: 'busy',
    busyLabel: 'Clearing…',
    why: 'a Targets cell’s Clear',
  },
  {
    key: 'pages/Routing.tsx cleanUp',
    cls: 'busy',
    busyLabel: 'cleaning up…',
    why: 'a Targets cell’s clean up (shadowed duplicates)',
  },
  {
    key: 'pages/Routing.tsx app.loadCalHistory#1',
    cls: 'not-a-button',
    why: 'the calibration drawer’s mount load',
  },
  {
    key: 'pages/Routing.tsx app.setCalibration',
    cls: 'switch',
    why: 'the Self-calibration switch',
  },
  {
    key: 'pages/Routing.tsx app.revertCalibration',
    cls: 'drawer',
    why: 'Revert to bundled, in the calibration drawer',
  },
  {
    key: 'pages/Routing.tsx app.revertAgentCalibration',
    cls: 'drawer',
    why: 'an agent’s Revert, in the calibration drawer',
  },
  {
    key: 'pages/Routing.tsx app.loadCalHistory#2',
    cls: 'drawer',
    why: 'the calibration history Retry, in the drawer',
  },
  {
    key: 'pages/Routing.tsx app.loadSemanticLearning#1',
    cls: 'not-a-button',
    why: 'the learning drawer’s mount load',
  },
  {
    key: 'pages/Routing.tsx app.setSemanticLearning',
    cls: 'switch',
    why: 'the Semantic learning switch',
  },
  {
    key: 'pages/Routing.tsx app.loadSemanticLearning#2',
    cls: 'drawer',
    why: 'the learning status Retry, in the drawer',
  },
  {
    key: 'pages/Routing.tsx app.revertSemanticLearning',
    cls: 'drawer',
    why: 'Confirm revert, in the learning drawer (it removes itself)',
  },
  {
    key: 'pages/Routing.tsx app.retryAutoPerf',
    cls: 'unmounts',
    why: 'the Pipeline failure notice’s Retry: the retry clears the failure it sits in',
  },
  { key: 'pages/Routing.tsx app.toggleAutoLayer', cls: 'switch', why: 'a Layers cell switch' },
  {
    key: 'pages/Routing.tsx app.commitTierOrder',
    cls: 'not-a-button',
    why: 'the ↑ / ↓ reorder applies at once; the write it queues is coalesced. See F3',
  },
  {
    key: 'pages/Routing.tsx app.deleteTier',
    cls: 'busy',
    busyLabel: 'Deleting…',
    why: 'a tier’s Delete (re-creatable configuration, not destructive)',
  },
  {
    key: 'pages/Routing.tsx app.deleteRule',
    cls: 'busy',
    busyLabel: 'Deleting rule',
    why: 'a header rule’s × glyph: the progressive label is its accessible name',
  },
  {
    key: 'pages/Routing.tsx app.createRule',
    cls: 'busy',
    busyLabel: 'Adding…',
    why: 'the header-rule form’s Add',
  },
  { key: 'pages/Routing.tsx app.loadRouting#1', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Routing.tsx app.loadAutoPerf',
    cls: 'not-a-button',
    why: 'the Auto routing tab’s first-show load',
  },
  {
    key: 'pages/Routing.tsx app.loadRouting#2',
    cls: 'unmounts',
    why: 'the routing failure notice’s Retry: the load clears the failure it sits in',
  },
  {
    key: 'pages/Routing.tsx app.createTier',
    cls: 'busy',
    busyLabel: 'Adding…',
    why: 'Add tier',
  },

  // Settings
  { key: 'pages/Settings.tsx app.loadChannels', cls: 'not-a-button', why: 'the mount load' },
  { key: 'pages/Settings.tsx app.loadBodyCapture', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Settings.tsx app.loadPricingStatus#1',
    cls: 'not-a-button',
    why: 'the mount load',
  },
  {
    key: 'pages/Settings.tsx app.toggleChannelEnabled',
    cls: 'switch',
    why: 'a channel’s enabled switch',
  },
  {
    key: 'pages/Settings.tsx app.testChannelById',
    cls: 'busy',
    busyLabel: 'Sending…',
    why: 'a channel’s Send test',
  },
  {
    key: 'pages/Settings.tsx app.runPricingRefresh',
    cls: 'busy',
    busyLabel: 'Refreshing…',
    why: 'the pricing catalog’s Refresh now',
  },
  {
    key: 'pages/Settings.tsx app.loadPricingStatus#2',
    cls: 'busy',
    busyLabel: 'Retrying…',
    why: 'the pricing status Retry: the failure stays until the read settles',
  },

  // Setup guide
  {
    key: 'pages/Setup.tsx app.obCreateAgent',
    cls: 'busy',
    busyLabel: 'Minting…',
    why: 'step 1’s Create agent & mint key',
  },
  {
    key: 'pages/Setup.tsx app.obConnectProvider',
    cls: 'busy',
    busyLabel: 'Connecting & syncing…',
    why: 'step 2’s Connect provider & sync models',
  },
  {
    key: 'pages/Setup.tsx app.obVerify',
    cls: 'busy',
    busyLabel: 'Sending…',
    why: 'step 3’s Send test request',
  },

  // Users
  { key: 'pages/Users.tsx app.loadUserAdmin', cls: 'not-a-button', why: 'the mount load' },
  {
    key: 'pages/Users.tsx app.uaSetRegistration',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'Invite only / Open sign-up',
  },
  {
    key: 'pages/Users.tsx app.uaCreateInvite',
    cls: 'busy',
    busyLabel: 'Inviting…',
    why: 'the invite form’s Invite',
  },
  {
    key: 'pages/Users.tsx app.uaRevokeInvite',
    cls: 'busy',
    busyLabel: 'Revoking…',
    why: 'an invitation’s Revoke (recoverable, not destructive)',
  },
  {
    key: 'pages/Users.tsx app.uaSetRole',
    cls: 'busy',
    busyLabel: 'Saving…',
    why: 'Make admin / Demote',
  },
  {
    key: 'pages/Users.tsx app.uaSetDisabled',
    cls: 'busy',
    busyLabel: 'Enabling…',
    why: 'Enable (Disable, the same button’s other state, opens the shared confirmation)',
  },
];
