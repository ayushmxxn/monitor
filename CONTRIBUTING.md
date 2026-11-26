# Contributing to Monitor

Thank you for your interest in contributing to Monitor.

## Project Principles

All contributions must align with Monitor's core principles:

- **Free and open source:** No paywalls, license checks, or artificial monitor limits.
- **Local-first, no backend:** Everything stays on the user's device (`chrome.storage.local`, never `chrome.storage.sync`).
- **Zero telemetry:** Never add analytics, crash reporting, tracking pixels, or silent external network requests.
- **Least privilege:** Keep host permissions incremental and per-origin (`optional_host_permissions`), never broad upfront `<all_urls>` grants.
- **Numbers first:** Monitor tracks numeric values on web pages (prices, counts, percentages, ratings, metrics), not arbitrary prose.

## Prerequisites

- [Bun](https://bun.sh/) (package manager, test runner, and runtime)
- Google Chrome (for loading the extension manually and running `test/browserFontRegression.test.ts`)

## Setup

```bash
bun install
```

`postinstall` runs `wxt prepare` automatically to generate `.wxt/` TypeScript configuration.

## Development Workflow

```bash
bun run dev        # Start WXT dev server with HMR
bun run compile    # Type-check with tsc --noEmit
bun run test       # Run the full isolated test suite
bun run build      # Build production extension into .output/chrome-mv3
bun run zip        # Package production build as a zip archive
```

To test the extension in Chrome:

1. Run `bun run build` (or `bun run dev`).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select `.output/chrome-mv3` (or `.output/chrome-mv3-dev` for dev).

## Testing Guidelines

Tests live in `test/` and run via `bun scripts/run-tests.ts`, which executes each `*.test.ts` / `*.test.tsx` file in its own `bun` subprocess with `./test/mockBrowser.ts` preloaded. Keeping each test file in a separate process prevents `mock.module`, `jsdom` globals, and storage state from leaking between suites.

Before opening a pull request, verify that all of the following pass cleanly:

```bash
bun run compile
bun run test
bun run build
```

## Pull Request Guidelines

- Keep changes focused and minimal; avoid unrelated refactoring.
- Match existing TypeScript, React, and Tailwind conventions.
- Add or update tests in `test/` for bug fixes and new behavior.
- Update documentation (`README.md`, `docs/architecture.md`, `PRIVACY.md`) if permissions, storage keys, or network behavior change.
- Never commit secrets, `.env` files, or build artifacts (`.output/`, `.wxt/`, `*.zip`).
