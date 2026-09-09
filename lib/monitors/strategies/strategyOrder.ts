import type { ElementFingerprint } from '../fingerprint';
import type { MonitorCheckStrategy } from '../types';

/**
 * Default order to try strategies in (fast/cheap first). See
 * `baseStrategyOrder` below for the one case this gets overridden.
 */
export const STRATEGY_ORDER: MonitorCheckStrategy[] = ['fetch', 'live'];

/**
 * The cascade order to use for a monitor that has no persisted strategy
 * yet (or is being force-reprobed) - see `checker.ts`'s `orderedStrategies`,
 * which puts a persisted strategy ahead of whatever this returns.
 *
 * Normally that's just `STRATEGY_ORDER` (fetch first: cheap, and right
 * the overwhelming majority of the time). But when the fingerprint's
 * item has a genuine permalink (`itemAnchor.isPermalink`), both `fetch`
 * and `live` resolve to the *same* stable item URL rather than the
 * monitor's original page (see `resolveCheckUrl`) - and that item came
 * from a feed virtualized/client-rendered enough to need an item anchor
 * in the first place, so its own permalink page is very likely rendered
 * the same way. A raw-HTML `fetch` of a client-rendered page is
 * essentially always empty, so trying it first just burns its timeout
 * before falling back to `live` anyway. Trying `live` directly instead
 * skips that wasted round-trip; `fetch` remains available as the
 * fallback for the (rarer) case where the item page turns out to be
 * server-rendered after all.
 *
 * Deliberately kept in its own module rather than alongside the
 * `STRATEGIES` implementation record in `index.ts` - `fetchStrategy.ts`
 * and `liveTabStrategy.ts` both pull in extension-runtime-only
 * dependencies (`@webext-core/messaging`, `wxt/utils/storage`) that
 * only work inside an actual browser extension, which would make this
 * pure ordering logic untestable outside one too if it lived alongside
 * them.
 */
export function baseStrategyOrder(fingerprint: Pick<ElementFingerprint, 'itemAnchor'>): MonitorCheckStrategy[] {
  if (!fingerprint.itemAnchor?.isPermalink) return STRATEGY_ORDER;
  return ['live', ...STRATEGY_ORDER.filter((id) => id !== 'live')];
}
