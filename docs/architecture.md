# Architecture

Monitor is a Manifest V3 Chrome extension built with [WXT](https://wxt.dev/), React, TypeScript, and Tailwind CSS. All state and scheduling run locally on the user's device with no backend.

## Repository Layout

```text
entrypoints/
  background.ts                Service worker: message handlers, scheduler alarm,
                               action-click permission prompt & panel toggle,
                               notification click handler.
  panel.content.tsx            On-demand content script (registration: 'runtime').
                               Mounts the floating panel inside a closed shadow root
                               with bundled CSS (?inline) and bundled Inter font.
  pageAgent.content.ts         On-demand content script (registration: 'runtime').
                               Exposes `window.__monitorPageAgent` (`pick`, `locate`)
                               with numeric picker overlay and readiness-aware recovery.
  visibilityPatch.content.ts   Dynamically registered MAIN-world script per granted origin.
                               Prevents background-tab rAF/visibility throttling and tracks
                               in-flight fetch/XHR counts for readiness detection.
  offscreen/                   Unlisted offscreen DOM-parser document (service workers
                               have no DOMParser).
  options/                     Extension options page (preferences, alert channels,
                               per-origin site access recovery, clear all monitors).

components/
  ui/                          Design-system primitives (Button, Card, Dialog, Input,
                               Select, Switch, Badge, ConfettiBurst, NumberPopIn, ...).
  layout/                      Header, EmptyState, ErrorBoundary, Favicon, InlineNotice,
                               SocialLinks, ConnectionStatus.
  monitors/                    MonitorList, MonitorCard, MonitorDetail, HistoryChart,
                               MonitorStatusBadge, SemanticValueBadge, DeleteMonitorDialog.
  panel/                       Panel shell (drag-to-resize, source filter) and PanelSettings.
  settings/                    SettingsSection, SettingRow, DiscordSettings,
                               TelegramSettings, WebhookSettings, SiteAccessSection,
                               ClearAllMonitorsDialog.

lib/
  storage/                     Versioned `wxt/utils/storage` items (`local:` and `session:`).
  messaging/                   Typed background <-> UI <-> offscreen `@webext-core/messaging`
                               protocol and timeout helper.
  permissions/                 Incremental per-origin `chrome.permissions` helpers.
  ui/                          Shadow-host isolation, bundled Inter font loader, Web Audio
                               interaction tone synthesizer (`lib/ui/sound.ts`).
  monitors/
    types.ts                   Monitor, MonitorCheck, AlertCondition, retention constants.
    pickerTarget.ts            Numeric-only hover target resolution and disambiguation.
    semanticValue.ts           Pattern-based classification + localized number parsing.
    fingerprint.ts             ElementFingerprint model, shadow-DOM traversal, candidate scoring.
    locate.ts                  Fingerprint recovery, visible text extraction, value settling.
    readiness.ts               DOM-quiet MutationObserver + network-idle + loading indicators.
    scrollRecovery.ts          Bounded scroll-assisted recovery for virtualized/feed items.
    antiAutomation.ts          Detects challenge/CAPTCHA interstitials and login walls.
    diagnostics.ts             Structured DiagnosticCode taxonomy and explanations.
    pageAgentClient.ts         Background-side script injection and invocation shim.
    checker.ts                 Per-monitor deduplication, strategy cascade, zero confirmation,
                               self-healing persistence, and periodic re-evaluation.
    scheduler.ts               Single 1-minute `chrome.alarms` tick + check-all deduplication.
    store.ts                   Per-key serialized CRUD, 30-day / 1,000-entry history retention.
    alertCondition.ts          Alert trigger evaluation (any, increase, decrease, below, above, matches).
    changeSummary.ts           Delta and percentage formatting for UI and alert channels.
    notify.ts                  Local notification + concurrent Discord/Telegram/webhook fan-out.
    discord.ts                 Discord webhook validation and single-embed formatter.
    telegram.ts                Telegram Bot API validation and HTML-escaped formatter.
    webhook.ts                 Generic HTTP(S) JSON webhook validation and poster.
    offscreenManager.ts        On-demand offscreen document lifecycle management.
    strategies/
      types.ts                 CheckStrategy interface.
      strategyOrder.ts         Default strategy cascade order (`['fetch', 'live']`).
      fetchStrategy.ts         Default: `fetch()` + offscreen DOMParser + locate pipeline.
      liveTabStrategy.ts       Fallback: shared minimized background window + safety-net alarm.
      liveTabNavigation.ts     Background tab navigation and load waiting.
      index.ts                 STRATEGIES registry.
  errors.ts                    AppError and Result<T, E> utilities.
  favicon.ts                   Chrome `_favicon/` local cache URL builder.
  constants.ts                 Shared app constants and external links.

hooks/                         React hooks for storage, monitors, monitor history,
                               page access, checking state, check stages, and app info.
scripts/
  run-tests.ts                 Isolated subprocess runner for all `test/*.test.{ts,tsx}` files.
test/                          Regression, pipeline, UI, and integration unit tests.
```

## Numeric-Only Element Picking

Monitor is built specifically to track numeric values (prices, follower counts, view counts, percentages, ratings, storage metrics, durations, and plain/localized numbers) rather than arbitrary text.

During interactive picking (`entrypoints/pageAgent.content.ts` + `lib/monitors/pickerTarget.ts`):

- `resolvePickerTargetAtPoint()` inspects the text node/caret under the cursor (piercing open shadow roots) and a bounded neighborhood of shallow descendants and ancestors.
- `findNumericCandidates()` and `detectSemanticValue()` extract and classify numeric tokens (`currency`, `revenue`, `percentage`, `followers`, `views`, `stars`, `storage`, `duration`, `count`, `number`).
- Non-numeric elements (`semanticValue.type === 'text'` or `normalized === null`) are rejected (`null`) so users cannot accidentally monitor arbitrary prose or labels.
- When multiple distinct numbers exist in the same element with similar scores, the picker flags the target as ambiguous and lets the user disambiguate or point closer to the intended number.

## Element Identity: Fingerprints, Not Selectors

A monitor does not rely on a single brittle CSS selector. Instead, it stores an `ElementFingerprint` containing:

- Element ID (excluding framework-generated noise such as UUIDs or Radix IDs)
- Test-ID attributes, ARIA label/role, and curated `data-*` / `aria-*` attributes
- Filtered stable CSS classes, nearby label text, and nearest heading/landmark text
- DOM path, XPath, and CSS selector (with `>>>` shadow-boundary notation where applicable)
- Sibling position, depth, viewport-relative position, text shape classification, and a local `TextAnchor`

On each check, `locateElement()` in `lib/monitors/locate.ts` first attempts the saved selector and XPath fast path. If neither resolves, `gatherCandidates()` (`collectDeep`) traverses light DOM and open shadow roots to build a bounded candidate pool and scores each candidate against every fingerprint signal. A match is accepted only if it clears `RECOVERY_ACCEPT_THRESHOLD` (55); below that, the check fails with `SELECTOR_RECOVERY_LOW_CONFIDENCE` instead of grabbing the wrong element. Successful relocations update the stored fingerprint in place (self-healing).

## Page Readiness and Anti-Throttling

Instead of fixed post-load sleeps, `waitForPageReady()` (`lib/monitors/readiness.ts`) combines:

- `document.readyState`
- A `MutationObserver` DOM-quiet window
- A `PerformanceObserver` resource-completion heuristic plus an authoritative in-flight `fetch`/`XHR` counter maintained by the `MAIN`-world `visibilityPatch.content.ts`
- Detection of common loading indicators (skeletons, spinners, `aria-busy`, `role="progressbar"`)

Locate attempts run inside an exponential-backoff retry loop within a bounded budget, and `resolveSettledValue()` performs a short confirmation re-read before accepting a reading.

## Check Pipeline and Strategy Cascade

Each monitor persists the strategy that last succeeded (`checkStrategy: 'fetch' | 'live' | null`):

1. **Permission check:** `runCheck()` (`lib/monitors/checker.ts`) verifies per-origin permission via `hasOriginPermission()`. If revoked, it immediately records `PERMISSION_DENIED` without running strategies. If the permissions API itself errors, it records `UNKNOWN` so the monitor remains retryable.
2. **Strategy cascade:** Tries the persisted strategy first (`fetch` by default, then `live`). If the first strategy fails, the checker cascades through remaining strategies within the same check cycle.
   - `fetchStrategy`: performs `fetch(checkUrl, { credentials: 'include' })` and parses HTML in the offscreen document (`entrypoints/offscreen/main.ts`).
   - `liveTabStrategy`: opens/reuses a single shared minimized background window (`session:liveCheckWindow`) queued via `runQueued()`, injects `pageAgent.content.ts`, waits for readiness, and extracts the settled value. A 1-minute `chrome.alarms` safety net (`live-check-window-safety-net`) cleans up orphaned windows if the service worker is evicted mid-check.
3. **Reliability safeguards:**
   - **Zero-reading confirmation:** A monitor's first-ever reading of `0` is re-read once before committing (`zeroFirstCheck` / `zeroGuard`).
   - **Stale check guard:** In-flight checks re-check monitor state before committing so a deleted or disabled monitor cannot be resurrected or overwritten.
   - **Continuous re-evaluation:** Diagnostics in `FORCE_REPROBE_CODES`, repeated low-confidence relocations (`REPROBE_AFTER_LOW_CONFIDENCE_STREAK = 2`), or every `PERIODIC_REPROBE_INTERVAL_CHECKS` (40) checks reset `checkStrategy` to `null` so the cascade re-evaluates.

## Diagnostics

Every check produces a `DiagnosticCode` (`OK`, `OK_RECOVERED`, `PERMISSION_DENIED`, `AUTH_REQUIRED`, `NETWORK_ERROR`, `PAGE_LOAD_TIMEOUT`, `PAGE_NOT_READY`, `ANTI_AUTOMATION_DETECTED`, `ELEMENT_NOT_FOUND`, `SELECTOR_RECOVERY_LOW_CONFIDENCE`, `EXTRACTION_EMPTY`, `NEEDS_REPICK`, `ACCESS_CHANGED`, `TAB_CLOSED`, `UNKNOWN`) with a human-readable explanation surfaced in `MonitorCard` and `MonitorDetail`.

## Permissions and UI Isolation

- **Permissions:** `wxt.config.ts` declares `optional_host_permissions: ['*://*/*']` and zero upfront `host_permissions`. Both `panel.content.tsx` and `pageAgent.content.ts` use `registration: 'runtime'` with no `matches` array. Clicking the toolbar icon triggers `requestOriginPermission(tab.url)` inside the user gesture and injects or toggles the panel.
- **Shadow-DOM Panel:** `panel.content.tsx` mounts inside a `closed` shadow root (`mode: 'closed'`), promotes the host to the browser top layer via the Popover API (`popover="manual"`), inlines compiled Tailwind CSS (`?inline`, rewriting `:root` to `:host`), and loads bundled `InterVariable.woff2` via `fetch(browser.runtime.getURL(...))` + `new FontFace(name, arrayBuffer)` for immunity against strict host-page CSPs.

## Storage and Retention

All persistent state uses `chrome.storage.local` (never `chrome.storage.sync`) through versioned `wxt/utils/storage` items in `lib/storage/items.ts`:

- `local:monitors` (v3): Monitor list and current snapshots.
- `local:history:<monitorId>` (v2): Retained for 30 days (`HISTORY_RETENTION_MS`) and capped at 1,000 entries (`MAX_HISTORY_ENTRIES`), with unchanged readings sampled hourly (`UNCHANGED_SAMPLE_INTERVAL_MS`).
- `local:settings` (v6): Interval, theme, notification/sound toggles, and optional Discord/Telegram/webhook settings.
- `local:panelWidth` (v1): Saved panel width.
- `session:liveCheckWindow`: Ephemeral background check window handle.

Writes in `lib/monitors/store.ts` are serialized per key via `serializeByKey` to prevent lost-update races across concurrent checks.

## Case Studies Covered by Regression Tests

Two production failure modes are documented in detail and covered by `test/pipeline.test.ts`:

1. **Shadow-DOM element recycling (e.g. Reddit):** `gatherCandidates()` (`collectDeep`) recurses into open shadow roots, and `locateElement()` returns `null` below `RECOVERY_ACCEPT_THRESHOLD` instead of returning a low-confidence candidate.
2. **Background-tab throttling & in-flight fetches (e.g. Umami):** `visibilityPatch.content.ts` prevents background-tab `requestAnimationFrame` / `document.hidden` throttling and tracks live in-flight `fetch`/`XHR` requests so `readiness.ts` and `resolveSettledValue()` wait for active API calls before reading.
