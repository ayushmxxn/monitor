# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-26

### Added

- Local-first Manifest V3 Chrome extension built with WXT, React, TypeScript, and Tailwind CSS.
- Floating in-page panel rendered in a closed shadow root with bundled `InterVariable.woff2` typography and light/dark theme support.
- Numeric-only interactive on-page element picker (`pageAgent.content.ts` + `pickerTarget.ts`) supporting currencies, percentages, scaled counts, ratings, storage sizes, durations, and localized numbers.
- Adaptive fingerprint-based element recovery engine (`fingerprint.ts` + `locate.ts`) with shadow-DOM traversal, self-healing updates, and scroll-assisted recovery for virtualized lists.
- Two-strategy check pipeline (`fetchStrategy` with offscreen `DOMParser` and `liveTabStrategy` background-tab fallback) with readiness detection, `visibilityPatch` anti-throttling, anti-automation/auth-wall detection, zero-reading confirmation, and structured `DiagnosticCode` reporting.
- History timeline charts, historical benchmarks (low/high/average), 30-day / 1,000-entry local retention, and smart alert conditions (`any`, `increase`, `decrease`, `below`, `above`, `matches`).
- Local desktop notifications, optional Web Audio cues, and opt-in Discord, Telegram, and custom webhook alert channels.
- Incremental per-origin host permissions (`optional_host_permissions`) with a Settings site-access recovery section.
- Open-source launch documentation (`LICENSE`, `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/architecture.md`), isolated full-suite test runner (`scripts/run-tests.ts`), and GitHub Actions CI workflow.

### Changed

- Removed the Google S2 favicon fallback from the UI favicon loader (`lib/favicon.ts` and `components/layout/Favicon.tsx`); site icons now use Chrome's local `_favicon/` cache or fall back directly to a generic globe icon.
- Standardized repository metadata and product descriptions around numeric website tracking.
- Removed unused root `manifest.json` and dead `CreatorCredit` component/asset files.
