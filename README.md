# Monitor

**Track numbers on any website. Local-first, private, and free forever.**

Monitor is an open-source Chrome extension for tracking prices, counts, followers, views, percentages, ratings, and other numeric metrics directly from any web page. Click a number on a page, set a check interval, and let Monitor watch it on your device — with no account, no backend, no monitor limits, and zero developer-side data collection.

## Principles

- **Free forever, unlimited monitors:** No paywalls, tiers, or caps on how many numbers you track.
- **Local-first, no backend:** Monitors, check history, and settings stay in `chrome.storage.local` on your device.
- **Zero developer-side data collection:** No analytics, no telemetry, and no tracking pixels.
- **Least-privilege permissions:** Requests no website access at install time; permissions are granted per origin only when you open Monitor on a site.

## Key Features

- **Point-and-click numeric picker:** Hover over any page to resolve prices, currencies, percentages, scaled counts (`1.2K`, `3.4M`), ratings, storage sizes, durations, and localized numbers (`1.234,56`, `1 234`).
- **Self-healing element recovery:** Uses multi-signal `ElementFingerprint` scoring (IDs, test attributes, ARIA, labels, DOM/XPath/CSS paths, shadow-DOM traversal, and scroll recovery) instead of a single brittle CSS selector.
- **Two-stage check pipeline:** Starts with a fast background `fetch()` + offscreen DOM parse and automatically falls back to a minimized live background tab for JS-rendered SPAs and authenticated dashboards.
- **History, charts, and benchmarks:** Tracks 30 days (up to 1,000 entries) of check history per monitor with interactive trend scrubbing and all-time low, high, and average stats.
- **Smart alert conditions:** Trigger alerts on any change, increases, decreases, thresholds (`above` / `below`), or matching text.
- **Flexible alerts:** Built-in desktop notifications and optional synthesized Web Audio cues, plus opt-in Discord, Telegram, and custom HTTP(S) webhook integrations.
- **In-page isolated UI:** Opens as a resizable floating panel inside a closed shadow root with bundled typography and light/dark themes.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- Google Chrome (or a Chromium-based browser)

### Install and Build

```bash
bun install
bun run build
```

Load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `.output/chrome-mv3`

### Development Commands

```bash
bun run dev        # Start WXT dev server with HMR
bun run compile    # Type-check with tsc --noEmit
bun run test       # Run all isolated test suites
bun run build      # Build production bundle into .output/chrome-mv3
bun run zip        # Package production build as a zip archive
```

## Documentation

- [Architecture](docs/architecture.md) — Engine design, fingerprinting, readiness detection, check strategies, storage, and permissions.
- [Privacy Policy](PRIVACY.md) — Local storage keys, retention limits, permissions, and optional alert integrations.
- [Security Policy](SECURITY.md) — Reporting vulnerabilities and security boundaries.
- [Contributing](CONTRIBUTING.md) — Setup, testing rules, and pull request guidelines.
- [Changelog](CHANGELOG.md) — Release history.

## License

[MIT](LICENSE)
