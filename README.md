# Monitor

A local-first Chrome extension for monitoring any value on any website.
No backend, no account, no data leaving your device.

Built around an adaptive fingerprint-based element-recovery engine so
monitors keep working across React/Next.js/Vue/Angular SPAs, frequent
DOM churn, infinite scroll/lazy loading, and authenticated dashboards —
not just static pages with a stable selector.

## Stack

WXT · React · TypeScript · Tailwind CSS · hand-rolled UI primitives (no component library)

## Getting started

```bash
bun install
bun run dev        # dev build with HMR, loads into Chrome
bun run compile    # type-check
bun run build      # production build -> .output/
bun run zip        # production build, zipped for distribution
```

## Architecture

```
entrypoints/
  background.ts        Service worker. Message handlers + alarm-driven scheduler.
  pageAgent.content.ts    On-demand content script (registration: 'runtime' — never
                           auto-injected; only via chrome.scripting into an origin the
                           user has already granted). Bundles the interactive picker and
                           the readiness-aware locate/extract pipeline as real imports,
                           exposed on `window.__monitorPageAgent` for a thin invocation
                           shim to call.
  offscreen/               Unlisted DOM-parser page (service workers have no DOMParser).
  popup/                    Toolbar popup UI - add/list/toggle/delete monitors.
  options/                    Full settings page - preferences + site access management.
  monitor/                      Full-page monitor detail: stats, diagnostics, history.
components/
  ui/                        Design-system primitives (Button, Card, Switch, Dialog, ...).
  layout/                     App-level building blocks (Header, EmptyState, ErrorBoundary, InlineNotice).
  monitors/                    Monitor list/card/status badge/history timeline, add-monitor flow, delete dialog.
  settings/                     PermissionsPanel - view/grant/revoke per-site access.
lib/
  storage/                        Typed, versioned wxt storage items + Result-based API.
  messaging/                       Typed background <-> UI <-> offscreen message protocol.
  permissions/                      Incremental per-origin host permission requests.
  theme.ts                           Follows the OS color scheme automatically.
  format.ts                           Relative/absolute timestamp formatting.
  monitors/
    types.ts                             Monitor / MonitorCheck domain types.
    fingerprint.ts                        Element fingerprint model + candidate scoring
                                            (id, test-ids, ARIA, classes, curated attrs,
                                            nearby label text, landmark text, DOM path,
                                            XPath, CSS selector, sibling/depth position,
                                            viewport-relative position, text shape).
    readiness.ts                          MutationObserver DOM-quiet detection +
                                            PerformanceObserver network-idle heuristic +
                                            loading-indicator awareness + exponential
                                            backoff retry helper. Replaces fixed delays.
    antiAutomation.ts                     Detects bot-verification/challenge pages and
                                            login walls (detection only).
    diagnostics.ts                        Structured DiagnosticCode taxonomy + explanations.
    locate.ts                             Combines fingerprint recovery + extraction +
                                            anti-automation/auth-wall detection into one
                                            diagnosable operation; shared by both strategies.
    pageAgentClient.ts                    Background-side injection + invocation of the
                                            content script, with error -> diagnostic mapping.
    intervals.ts                          Shared interval options + formatting.
    store.ts                               CRUD over storage (list, history, cap at 50 entries).
    pickerFlow.ts                           Orchestrates the interactive pick + fingerprint
                                              handoff to the add-monitor tab.
    client.ts                                sendMessage wrapper for on-demand checks.
    checker.ts                                Strategy cascade, self-healing fingerprint
                                                persistence, and continuous re-evaluation
                                                (forces a fresh strategy cascade after
                                                diagnostics that imply drift, a streak of
                                                low-confidence relocations, or periodically
                                                on a schedule even when nothing looks wrong).
    scheduler.ts                                Single repeating alarm; finds and checks due monitors.
    notify.ts                                    System notification on a changed value.
    strategies/
      types.ts                                       CheckStrategy interface - the extensibility point.
      fetchStrategy.ts                                 Default: fetch() + offscreen DOMParser + fingerprint recovery.
      liveTabStrategy.ts                                Fallback: background tab + readiness wait + page agent.
      index.ts                                           STRATEGIES map + STRATEGY_ORDER - register new ones here.
  errors.ts                 AppError / Result<T, E> used across every layer.
  utils.ts                   cn() classname helper.
  constants.ts                 Shared constants.
hooks/
  useStorage.ts                 Reactive subscription to a storage item.
  useMonitors.ts                  Reactive monitor list + CRUD actions (popup).
  useMonitor.ts                     Reactive single monitor by id (detail page).
  useMonitorHistory.ts               Reactive check history for one monitor.
  useOriginPermissions.ts              Per-origin grant status, live via permissions.onAdded/onRemoved.
  useAppInfo.ts                         Background connectivity + app info.
```

### Element identity: fingerprints, not selectors

A monitor doesn't store a single CSS selector. It stores an
`ElementFingerprint` — id (filtered for framework-generated noise like
`radix-:r4:` or a UUID), test-id attributes, ARIA label/role, curated
`data-*`/`aria-*` attributes, filtered stable classes, nearby label
text, the nearest heading/landmark text, a DOM-path/XPath/CSS-selector
trio, sibling position, depth, viewport-relative position, and a
*shape* classification of the text (numeric/currency/date/etc — never
the exact text, since that's the thing that's expected to change).

On every check, `locateElement()` first tries the captured selector and
XPath (the fast path — correct the overwhelming majority of the time).
If neither resolves, it gathers a bounded pool of plausible candidates
(prioritizing test-id/aria/class-based queries before falling back to a
capped tag scan) and scores each one against every fingerprint signal
with independent weights. The highest-scoring candidate is accepted
only above a confidence threshold; below that, the check fails with a
`SELECTOR_RECOVERY_LOW_CONFIDENCE` diagnostic rather than silently
grabbing the wrong element. A successful relocation updates the
fingerprint in place (self-healing) so the next check starts from the
element's current position.

### Page readiness

Instead of a fixed post-load delay, `waitForPageReady()` combines
`document.readyState`, a `MutationObserver`-based DOM-quiet window, a
`PerformanceObserver`-based network-idle heuristic (no debugger
permission required), and awareness of common loading-indicator
patterns (skeletons, spinners, `aria-busy`, `role="progressbar"`).
Signals combine leniently — a sustained quiet window is enough, since
some pages (tickers, chat widgets, ads) never go fully idle. Locate
attempts run inside an exponential-backoff retry loop with a total time
budget, so a slow-hydrating SPA gets several chances to settle instead
of one fixed wait.

### How a check runs

Each monitor remembers which strategy last worked (`checkStrategy: 'fetch' | 'live' | null`).
Every scheduled check first confirms its host permission is still granted (skips straight to
an actionable `PERMISSION_DENIED` diagnostic if not), then tries the persisted strategy. If it
fails, the checker immediately cascades through the remaining strategies within the same
check — the user gets a value that cycle rather than waiting for the next interval. The
strategy is **not** trusted forever: it's dropped back to "unknown" (forcing a fresh cascade)
whenever a diagnostic implies the page's rendering characteristics may have changed (an
anti-automation challenge, the element going missing outright, the page never settling), after
two consecutive low-confidence relocations, or periodically on a schedule regardless — the
pipeline keeps re-evaluating itself rather than assuming yesterday's answer still holds.

Adding a third strategy later means implementing `CheckStrategy` in
`lib/monitors/strategies/` and adding it to `STRATEGIES` + `STRATEGY_ORDER` -
`checker.ts` and the UI need no changes.

### Diagnostics

Every check outcome — success, recovery, or failure — carries a
`DiagnosticCode` (`PERMISSION_DENIED`, `AUTH_REQUIRED`, `PAGE_NOT_READY`,
`ANTI_AUTOMATION_DETECTED`, `ELEMENT_NOT_FOUND`,
`SELECTOR_RECOVERY_LOW_CONFIDENCE`, `EXTRACTION_EMPTY`, `TAB_CLOSED`,
`OK_RECOVERED`, ...) with a human-readable explanation, instead of a
generic error string. The monitor detail page shows the current
strategy, element confidence, last outcome, and when the element was
last relocated.

### Permissions

The manifest requests no host permissions upfront (`optional_host_permissions: ["*://*/*"]`
declared, nothing granted, and the on-demand content script deliberately has no `matches`
field so WXT never adds a broad `host_permissions` entry either). `activeTab` lets the popup's
element picker run in the current tab on click. A monitor's specific origin is only requested
when the user clicks "Save monitor" for it - each grant is legible and tied to something the
user just did, and that same per-origin grant is what `chrome.scripting.executeScript` relies
on for background-tab checks (the "live" strategy). The options page's "Site access" panel
lists every origin in use, whether access is currently granted, and lets the user grant or
revoke it directly - it also reacts live if access is changed from `chrome://extensions`
while the page is open.

### Two production bugs and their actual root causes

Worth documenting because both looked like they might be "selector needs a tweak" issues and turned out to be pipeline bugs:

**Wrong element recovered on shadow-DOM sites (e.g. Reddit).** Two compounding bugs:
`locateElement()` computed its confidence threshold check correctly but then returned the
best candidate element regardless of whether it actually cleared the threshold - so a
30/100-confidence match was returned exactly like a 90/100 one, and callers that only check
"is there an element" had no way to tell the difference. Separately, `gatherCandidates()`
used plain `querySelectorAll`/`getElementsByTagName`, which never look inside a shadow root -
on a page built from web components (Reddit's `shreddit-post`, most design-system component
libraries), that means an entire subtree can be invisible to recovery, including the exact
element being relocated. Together: when a shadow-DOM element's exact selector broke (list
virtualization recycling the node), recovery scanned an incomplete, shadow-blind candidate
pool, found nothing good, and returned its best bad guess anyway. Both are fixed -
`locateElement` now returns `null` below threshold, and candidate gathering (`collectDeep`)
recurses into open shadow roots.

**Correct element, wrong value (e.g. Umami).** The live-tab strategy opens its check tab with
`active: false` so a scheduled check never steals focus - but Chrome throttles/pauses
`requestAnimationFrame` and reports `document.hidden` for backgrounded tabs, which can stall
count-up animations or visibility-gated rendering on their pre-animation placeholder value
indefinitely. On top of that, the network-idle heuristic was purely completion-based
(`PerformanceObserver` 'resource' entries fire on load completion, never on load *start*), so
a page whose only outstanding work was one slow, still-pending `fetch()` looked exactly as
"quiet" as a genuinely idle one - nothing had *finished* loading recently, which is not the
same thing as nothing being in flight. Both are fixed by a dynamically-registered MAIN-world
patch (`entrypoints/visibilityPatch.content.ts`, registered per-origin via
`chrome.scripting.registerContentScripts` - no new permissions needed) that neutralizes the
throttling and maintains a live in-flight request count that `readiness.ts` treats as an
authoritative network-quiet gate. `resolveSettledValue()` (in `lib/monitors/locate.ts`) adds a
second layer of defense: any found value gets one short confirmation re-read before being
trusted, in case something outside fetch/XHR (a `setTimeout`-driven update, for instance)
changes it right after readiness declares victory.

Both are covered by `test/pipeline.test.ts` (`bun run test`) against real jsdom DOM behavior, not
mocks of this codebase's own functions - it reconstructs the shadow-DOM recycling scenario and
the slow-pending-fetch scenario and asserts on the actual extracted values.



- **Panel** - the everyday view: add a monitor, see status at a glance, toggle/delete.
- **Monitor detail** (opened inline in the panel, never a new tab) - full history timeline,
  a diagnostics panel (strategy, confidence, last outcome, last relocation), an interval
  editor, a "Check now" action, and a permission-revoked banner with one-click re-grant.
- **Options** - notification/startup preferences plus the permissions panel.
