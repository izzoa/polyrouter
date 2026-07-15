import type { Linter } from 'eslint';

export declare function boundaryRulesFor(
  packageKey: 'shared' | 'data-plane' | 'control-plane' | 'frontend',
): Linter.RulesRecord;

export declare const boundaryConfigs: Linter.Config[];

declare const _default: Linter.Config[];
export default _default;
