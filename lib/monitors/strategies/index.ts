import { fetchStrategy } from './fetchStrategy';
import { liveTabStrategy } from './liveTabStrategy';
import { STRATEGY_ORDER, baseStrategyOrder } from './strategyOrder';
import type { CheckStrategy } from './types';
import type { MonitorCheckStrategy } from '../types';

export type { CheckStrategy, StrategyOutcome } from './types';
export { isValidOutcome } from './types';
export { STRATEGY_ORDER, baseStrategyOrder } from './strategyOrder';

/**
 * All available strategies, and the default order to try them in
 * (fast/cheap first). To add a new strategy: implement `CheckStrategy`,
 * add it to this record, and add its id to `STRATEGY_ORDER` (in
 * `strategyOrder.ts`). `checker.ts` needs no other changes.
 */
export const STRATEGIES: Record<MonitorCheckStrategy, CheckStrategy> = {
  fetch: fetchStrategy,
  live: liveTabStrategy,
};
