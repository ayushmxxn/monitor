import { tryCatch, type Result } from '@/lib/errors';
import { unregisterVisibilityPatch } from '@/lib/monitors/visibilityPatch';

/**
 * Incremental host permissions.
 *
 * The manifest declares a broad optional host permission pattern but
 * requests nothing upfront. A site's access is only ever requested for
 * that site's own origin, never broadly, and only at the moment the
 * user opens the panel on it - see `registerActionClick` in
 * entrypoints/background.ts for why it happens there rather than when
 * a monitor is actually created: `chrome.permissions.request()` only
 * works from inside a genuine user gesture, and the toolbar icon click
 * that opens the panel is the only such gesture in this flow. This
 * keeps the install-time permission prompt empty and each grant
 * legible ("this site, because you opened Monitor on it").
 */

function originPatternFor(url: string): string {
  const { protocol, host } = new URL(url);
  return `${protocol}//${host}/*`;
}

export function hasOriginPermission(url: string): Promise<Result<boolean>> {
  return tryCatch(() =>
    browser.permissions.contains({ origins: [originPatternFor(url)] }),
  );
}

/** Prompts the user (via the browser's native permission dialog) for access to `url`'s origin. */
export function requestOriginPermission(url: string): Promise<Result<boolean>> {
  return tryCatch(() =>
    browser.permissions.request({ origins: [originPatternFor(url)] }),
  );
}

export async function removeOriginPermission(url: string): Promise<Result<boolean>> {
  const result = await tryCatch(() =>
    browser.permissions.remove({ origins: [originPatternFor(url)] }),
  );
  // Anything registered scoped to this origin (the rAF/visibility patch
  // used by the live-tab strategy) must go with the permission that
  // justified it — otherwise a dynamically-registered content script
  // would keep running on a site the user just told the extension not
  // to touch anymore.
  if (result.ok && result.value) {
    await unregisterVisibilityPatch(new URL(url).host);
  }
  return result;
}
