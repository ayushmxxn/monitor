import { TRACKING_QUERY_PARAMS, type ElementFingerprint } from './fingerprint';

/**
 * Picks the URL a check should actually load.
 *
 * `monitor.url` is the page the value was originally picked on - for a
 * dynamic/virtualized feed (a home timeline, an infinite-scroll list)
 * that's the *feed*, not the item. Re-fetching or re-navigating to the
 * feed on every check asks the generic recovery scan to rediscover one
 * specific item inside a page that reorders, recycles, and virtualizes
 * its DOM on every load - the item may not even be mounted yet (still
 * covered by a loading placeholder) or may never scroll into range
 * within the check's time budget. See `ItemAnchor` in `fingerprint.ts`.
 *
 * `findItemAnchor` already captures, at pick time, a permalink-shaped
 * `<a href>` found inside the item's own root (its own detail page) -
 * that's a strictly more reliable place to look for the value than the
 * feed ever is, since it's the one page guaranteed to render *this*
 * item as primary content rather than as one of many virtualized rows.
 * When that signal is present, checks resolve straight to it instead of
 * the feed page; the same generic fingerprint/recovery pipeline
 * (`locateAndExtract`) then finds the metric inside that page exactly
 * as it would on any other page, so no per-site handling is needed.
 *
 * `itemAnchor.href` also has a weaker fallback case (a table/dashboard
 * row's own detail link, kept when no permalink-shaped link exists) -
 * that fallback is deliberately *not* used here. `itemAnchor.isPermalink`
 * (set by `findItemAnchor` at capture time) is what distinguishes the
 * two: only a genuine permalink match is trustworthy enough to redirect
 * an entire check to a different URL. A dashboard row's own detail page
 * isn't guaranteed to render the watched cell at all - unlike a feed
 * item's own permalink, which by definition renders that item as its
 * primary content.
 *
 * Falls back to `monitor.url` whenever there's no item anchor, the href
 * isn't a genuine permalink, or it doesn't parse - the existing generic
 * resolver (recovery scan against the monitor's own page) remains the
 * path for every monitor that isn't a feed item with its own stable
 * URL, exactly as before this existed.
 */
export function resolveCheckUrl(monitor: { url: string; fingerprint: ElementFingerprint }): string {
  const anchor = monitor.fingerprint.itemAnchor;
  if (!anchor?.href || !anchor.isPermalink) return monitor.url;

  try {
    return new URL(anchor.href, monitor.url).toString();
  } catch {
    return monitor.url;
  }
}

/**
 * The URL persisted on a new monitor and shown to the user as its
 * source - deliberately a *different* question from `resolveCheckUrl`
 * above, even though both start from the same `itemAnchor`.
 *
 * Without this, a monitor created by picking a value out of a feed
 * (a video's view count on the home timeline, a post's like count on
 * a subreddit listing) would persist `pageUrl` - the feed itself - as
 * its "source", even though `resolveCheckUrl` already knows to check
 * the item's own permalink instead. The two would quietly disagree:
 * every check correctly loads the exact video/post, but the URL shown
 * in the UI, opened by the domain badge, and used for the origin
 * permission check is the feed's. This resolves them to the same
 * answer up front, at creation time, using the identical permalink
 * signal `resolveCheckUrl` trusts (`itemAnchor.isPermalink`) - a
 * dashboard row's own weaker, non-permalink detail link is excluded
 * here for the same reason it's excluded there (see `resolveCheckUrl`'s
 * doc comment).
 *
 * Falls back to `pageUrl` itself whenever there's no such anchor -
 * the normal case for anything that isn't a feed selection, where
 * `pageUrl` already *is* the exact page the value lives on (a video's
 * own watch page, a dashboard, a GitHub issue).
 *
 * Either way, the result is run through `stripTrackingParams` before
 * being returned - tracking/session noise doesn't belong in a URL a
 * user is meant to read, bookmark, or open, regardless of whether it
 * came from a permalink or the page itself.
 */
export function resolveSourceUrl(
  pageUrl: string,
  itemAnchor: ElementFingerprint['itemAnchor'],
): string {
  let raw = pageUrl;
  if (itemAnchor?.href && itemAnchor.isPermalink) {
    try {
      raw = new URL(itemAnchor.href, pageUrl).toString();
    } catch {
      raw = pageUrl;
    }
  }
  return stripTrackingParams(raw);
}

/**
 * Generic canonical page identity: same origin + same path + same
 * non-tracking query params (see `TRACKING_QUERY_PARAMS`), ignoring
 * hash. Deliberately site-agnostic: sites that put the content id in
 * the query (e.g. `/watch?v=…`) keep it because `v` is not a tracking
 * param, while `si`/`t`/UTM noise is ignored either way.
 *
 * Used only to decide whether a landmark (heading) change happened on
 * the *same* page (a title edit — penalize, don't clamp) versus a
 * *different* page (an SPA navigation — keep the severe clamp).
 * Unparseable input returns `false` (strict) so a bad URL never
 * silently disables cross-page protection.
 */
export function isSameCanonicalCheckUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
  } catch {
    return false;
  }
  try {
    ub = new URL(b);
  } catch {
    return false;
  }
  if (ua.origin !== ub.origin) return false;
  if (ua.pathname !== ub.pathname) return false;
  const pa = new URLSearchParams(ua.search);
  const pb = new URLSearchParams(ub.search);
  for (const key of Array.from(pa.keys())) {
    if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) pa.delete(key);
  }
  for (const key of Array.from(pb.keys())) {
    if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) pb.delete(key);
  }
  pa.sort();
  pb.sort();
  return pa.toString() === pb.toString();
}

/**
 * Removes only the query parameters known to be cross-site tracking/
 * session noise (see `TRACKING_QUERY_PARAMS` - the same list
 * `permalinkIdentity` uses to compare two permalinks for equality),
 * leaving every other parameter untouched. Deliberately not a blanket
 * "drop the query string": some sites put the actual content id in
 * the query rather than the path (YouTube's `/watch?v=…`), and
 * stripping that would turn an exact source URL into a broken or
 * wrong one.
 *
 * Malformed/unparseable input is returned unchanged rather than
 * thrown away - a URL this function can't improve is still better
 * kept as-is than dropped.
 */
export function stripTrackingParams(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  for (const key of Array.from(url.searchParams.keys())) {
    if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}
