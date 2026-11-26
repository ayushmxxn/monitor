# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Monitor, please report it privately rather than opening a public GitHub issue.

- **Preferred:** Use GitHub's **Report a vulnerability** feature under the repository's **Security** tab (Private Vulnerability Reporting / Security Advisories).
- **Alternative:** Reach out directly to the maintainer via X ([@ayushmxxn](https://x.com/ayushmxxn)) to request a private channel for details.

Please include:
- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal proof of concept.
- The extension version (`package.json` / `wxt.config.ts`) and browser version affected.

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |

## Security Model

Monitor is designed around a local-first, least-privilege architecture:

- **No backend or telemetry:** All state lives on the user's device; no extension telemetry or remote control endpoints exist.
- **Incremental permissions:** No host permissions are granted at install time. Origin access (`*://*/*` via `optional_host_permissions`) is requested per origin upon user interaction and can be revoked per site at any time.
- **Runtime-only content scripts:** Content scripts (`panel.content.tsx`, `pageAgent.content.ts`) use `registration: 'runtime'` and are injected on demand only into granted origins.
- **DOM isolation:** The in-page panel renders inside a `closed` shadow root (`mode: 'closed'`) with bundled styles and bundled `InterVariable.woff2` loaded from extension resources via `ArrayBuffer`, avoiding host-page DOM/CSS interference.
- **Outbound integration validation:**
  - Discord integration strictly validates `https:` URLs on `discord.com` / `discordapp.com` `/api/webhooks/{id}/{token}` paths and sets `allowed_mentions: { parse: [] }`.
  - Telegram integration validates bot token and chat ID formats and HTML-escapes monitor names, values, and URLs before sending.
  - Custom webhooks accept only `http:` and `https:` URLs.
- **Local credential storage caveat:** Any webhook URLs or Telegram bot tokens entered by the user are stored in Chrome's local extension storage (`chrome.storage.local`), which is unencrypted on disk like other browser profile data.
