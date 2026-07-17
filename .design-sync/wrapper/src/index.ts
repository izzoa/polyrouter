/** @polyrouter/design-kit — React adapters over polyrouter's real SolidJS
 * dashboard. Components mount the app's compiled Solid code; nothing is
 * reimplemented. Styling comes from the dashboard's own stylesheet
 * (single accent #4F5DFF, Geist type, light+dark via [data-theme]). */

// controls
export { Toggle, type ToggleProps } from './controls/Toggle';
export { RangeSelector, type RangeSelectorProps } from './controls/RangeSelector';
export { HarnessSelect, type HarnessSelectProps } from './controls/HarnessSelect';

// charts
export { Chart, type ChartProps } from './charts/Chart';
export { BarRows, type BarRowsProps } from './charts/BarRows';

// chrome
export { Sidebar, type SidebarProps } from './chrome/Sidebar';
export { Topbar, type TopbarProps } from './chrome/Topbar';
export { Toast, type ToastProps } from './chrome/Toast';

// data
export { RequestTableHead, type RequestTableHeadProps } from './data/RequestTableHead';
export { RequestRows, type RequestRowsProps } from './data/RequestRows';
export { Inspector, type InspectorProps } from './data/Inspector';

// overlays
export { Modals, type ModalsProps, type ModalKindId } from './overlays/Modals';

// pages
export { Overview, type OverviewProps } from './pages/Overview';
export { Requests, type RequestsProps } from './pages/Requests';
export { Costs, type CostsProps } from './pages/Costs';
export { Agents, type AgentsProps } from './pages/Agents';
export { Providers, type ProvidersProps } from './pages/Providers';
export { Routing, type RoutingProps } from './pages/Routing';
export { Limits, type LimitsProps } from './pages/Limits';
export { Settings, type SettingsProps } from './pages/Settings';
export { Setup, type SetupProps } from './pages/Setup';
export { Login, type LoginProps } from './pages/Login';

// shared prop vocabulary + demo corpus
export type { PageId, HarnessId, SpendBarDatum, RequestRowData } from './types';
export type { CommonProps } from './mount';
export * from './demo';
