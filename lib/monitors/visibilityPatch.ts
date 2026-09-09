const PATCH_FILE = '/content-scripts/visibilityPatch.js';

function scriptIdFor(host: string): string {
  return `monitor-visibility-patch:${host}`;
}

/**
 * Hosts confirmed (re)registered *during this service-worker lifetime*.
 * A plain module variable is exactly right here, not persisted storage:
 * it needs to start empty on every fresh lifetime - extension reload,
 * extension update, or an ordinary MV3 idle eviction/restart - so the
 * very first live check after any of those unconditionally re-asserts
 * the registration instead of trusting whatever `chrome.scripting`
 * reports.
 *
 * That distinction matters because `getRegisteredContentScripts`
 * reporting an id as present is not proof it will actually fire
 * correctly for *this* lifetime. `persistAcrossSessions: true` keeps
 * the registration surviving a full browser restart, but a same-session
 * extension reload/update can leave a "ghost" entry behind: the id is
 * still listed, yet Chrome recreated the extension's script-injection
 * subsystem underneath it and the registration no longer reliably
 * attaches at `document_start` on new navigations - see history for the
 * concrete failure this caused (a live check's background tab rendering
 * as `document.hidden`/backgrounded because the visibility patch never
 * actually applied, which starves any site that gates rendering on
 * Page Visibility/`requestAnimationFrame` - YouTube's channel header
 * among them - producing a confusing "page loaded but the value never
 * appeared" recovery failure that had nothing to do with the fingerprint
 * or selector at all).
 *
 * The old code's `getRegisteredContentScripts` pre-check short-circuited
 * on exactly that ghost state and skipped re-registering. Now that check
 * still exists as a *fast path within* a lifetime that has already
 * confirmed the registration (so repeated checks against the same host
 * back-to-back don't pay for an unregister/register round-trip every
 * time) - it's just no longer trusted as ground truth on the very first
 * call after a fresh lifetime starts.
 */
const registeredThisLifetime = new Set<string>();

/**
 * Ensures the MAIN-world visibility/rAF patch (see
 * `entrypoints/visibilityPatch.content.ts`) is registered for `url`'s
 * origin, so it applies at `document_start` the moment the live-tab
 * strategy navigates there — well before the page's own scripts run.
 *
 * `chrome.scripting.registerContentScripts` only needs the `scripting`
 * permission (already declared) plus host permission for the matched
 * origin — which the checker already requires before any live check
 * runs (`hasOriginPermission`) — so this needs nothing new from the
 * user. Registration is idempotent and cheap to re-call: once this
 * lifetime has confirmed a host is registered, later calls for the same
 * host just return (see `registeredThisLifetime` above for what changes
 * on a fresh lifetime).
 */
export async function ensureVisibilityPatchRegistered(url: string): Promise<void> {
  let host: string;
  let originPattern: string;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    originPattern = `${parsed.protocol}//${host}/*`;
  } catch {
    return;
  }

  // Already confirmed registered earlier in this same lifetime — cheap
  // fast path, no need to round-trip through `chrome.scripting` again.
  if (registeredThisLifetime.has(host)) return;

  const id = scriptIdFor(host);

  // Unconditionally re-register rather than trusting a prior
  // `getRegisteredContentScripts` report as ground truth (see
  // `registeredThisLifetime` above for why that can be stale after a
  // reload/update). `registerContentScripts` rejects if the id already
  // exists, so any leftover registration from a previous lifetime is
  // removed first — best-effort, since "nothing to unregister" is the
  // common case and throws harmlessly.
  try {
    await browser.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // Nothing registered yet for this host — expected on a cold start.
  }

  try {
    await browser.scripting.registerContentScripts([
      {
        id,
        matches: [originPattern],
        js: [PATCH_FILE],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
      },
    ]);
    registeredThisLifetime.add(host);
  } catch (error) {
    // Registration can race (concurrent checks for the same origin) or
    // fail if the origin permission was revoked between the checker's
    // permission check and here. Either way this is a rendering aid,
    // not a correctness requirement — the live check proceeds without
    // it rather than failing outright. Deliberately not added to
    // `registeredThisLifetime` so the next check tries again instead of
    // wrongly treating this host as covered.
    console.warn('[monitor] Could not register visibility patch for', host, error);
  }
}

/** Removes the patch registration for `host`, e.g. once its origin permission is revoked. */
export async function unregisterVisibilityPatch(host: string): Promise<void> {
  registeredThisLifetime.delete(host);
  try {
    await browser.scripting.unregisterContentScripts({ ids: [scriptIdFor(host)] });
  } catch {
    // Nothing was registered for this host — fine.
  }
}
