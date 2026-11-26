# Privacy Policy

Monitor is an open-source, local-first Chrome extension for tracking numbers on websites. There is no account system, no developer-operated backend, and zero developer-side data collection, analytics, or telemetry.

## Summary

- **No developer-side collection:** Monitor does not send your monitored URLs, extracted numbers, browsing history, or settings to the developer.
- **Local-only persistence:** Monitors, check history, and settings are stored locally on your device using `chrome.storage.local` (never `chrome.storage.sync`).
- **Local-only website favicons:** Site icons in the extension UI use Chrome's local `_favicon/` cache first, or fetch the website's own icon directly from the granted origin and cache it locally (never Google's favicon API or any third-party service), falling back to a built-in generic icon only as a last resort.
- **Opt-in third-party alerts:** Discord, Telegram, and custom webhook integrations are off by default and only transmit data when you explicitly configure and enable them.

## Local Storage

Monitor stores the following data locally on your device:

| Storage Key | Area | Contents |
| --- | --- | --- |
| `local:monitors` | `chrome.storage.local` | Saved monitors: name, page URL, element fingerprint, extraction mode/attribute, check interval, enabled state, alert condition, last extracted value and semantic metadata, check strategy, status, diagnostic state, and aggregate stats (`low`, `high`, `sum`, `count`). |
| `local:history:<monitorId>` | `chrome.storage.local` | Check history entries for each monitor: extracted value, previous value, semantic metadata, timestamp, change flag, diagnostic/error details, recovery confidence, and strategy used. |
| `local:settings` | `chrome.storage.local` | Preferences (`defaultIntervalMinutes`, `theme`, `notificationsEnabled`, `soundEnabled`) and optional alert channel configuration (`webhookEnabled`, `webhookUrl`, `discordEnabled`, `discordWebhookUrl`, `telegramEnabled`, `telegramBotToken`, `telegramChatId`). |
| `local:panelWidth` | `chrome.storage.local` | Resized width of the in-page panel. |
| `local:favicons` | `chrome.storage.local` | Locally cached website favicons (data URLs keyed by origin, capped at 64 entries with a 7-day TTL) used when Chrome's `_favicon/` cache has no entry. |
| `session:liveCheckWindow` | `chrome.storage.session` | Temporary window and tab IDs of the minimized background window used while a live-tab check is running. Cleared when the check finishes or when the browser restarts. |
| `monitor:sound` | `localStorage` | UI audio toggle state (`on` or `off`) for synthesized Web Audio interaction sounds. |

> [!NOTE]
> Chrome stores `chrome.storage.local` data unencrypted on your local browser profile. This includes any Discord webhook URL, Telegram bot token, Telegram chat ID, or custom webhook URL you save in Settings.

## Data Retention and Deletion

- **Check history retention:** History entries for each monitor are kept for **30 days** and capped at **1,000 entries** per monitor. Repeated unchanged readings are sampled at most once per hour, while value changes, errors, and recoveries are recorded immediately.
- **Deleting monitors:** Deleting an individual monitor removes both the monitor record and its `local:history:<monitorId>` entry.
- **Clearing all data:** Using **Clear all monitors** in Settings deletes all monitors and their check histories.
- **Uninstalling:** Removing the extension from Chrome deletes all extension storage managed by Chrome.

## Permissions

Monitor declares the minimum permissions required to operate and requests no website host permissions at install time:

| Permission | Why It Is Needed |
| --- | --- |
| `storage` | Store monitors, check history, and user settings locally on the device. |
| `activeTab` | Allow the in-page panel and element picker to run in the active tab when you click the extension toolbar icon. |
| `scripting` | Inject the on-demand panel UI, element picker/locator, and per-origin `MAIN`-world visibility helper onto websites you grant access to. |
| `alarms` | Schedule periodic monitor checks (`monitor-tick`) and clean up orphaned live-check windows (`live-check-window-safety-net`). |
| `notifications` | Show local desktop notifications when a monitored value changes (if enabled) or when clicking the icon on an unsupported browser page. |
| `offscreen` | Parse fetched HTML in an unlisted offscreen document (`DOMParser`) because Manifest V3 service workers cannot parse HTML directly. |
| `favicon` | Read site favicons from Chrome's local `_favicon/` cache without making external network requests. |
| `optional_host_permissions: ["*://*/*"]` | Request persistent access one origin at a time only when you open Monitor on a site or click **Grant access** in Settings. You can revoke per-site access anytime in Chrome's extension settings. |

## Network Requests

### Monitored Websites

- Scheduled and manual checks communicate directly from your browser to the specific URLs you added monitors for.
- Background `fetch()` checks use `credentials: 'include'`, and fallback live-tab checks open the URL in a minimized background browser window using your existing browser session so authenticated pages can be checked without sharing credentials with any third party.

### Optional Alert Integrations (Off by Default)

Monitor never sends alert payloads anywhere unless you explicitly enable and configure one of the following channels in Settings:

- **Discord (`discordEnabled`):** Sends an HTTPS `POST` request to your configured `discord.com` or `discordapp.com` webhook URL when a matching change occurs (or when you click **Test**). The embed payload contains the monitor name, source URL, previous and new values, numeric delta/percentage, timestamp, and a `footer.icon_url` pointing to `https://www.google.com/s2/favicons?domain=<hostname>&sz=64` so Discord's image proxy can render the site's favicon in the embed footer.
- **Telegram (`telegramEnabled`):** Sends an HTTPS `POST` request directly to `https://api.telegram.org/bot<token>/sendMessage` with your configured chat ID and an HTML-formatted message containing the monitor name, previous and new values, numeric delta/percentage, and a clickable domain link.
- **Custom Webhook (`webhookEnabled`):** Sends an `HTTP(S) POST` JSON payload (`event`, `monitorId`, `monitorName`, `url`, `previousValue`, `currentValue`, `message`, `checkedAt`) to your configured endpoint URL.

### External Links

Settings contains optional links you can click manually (feedback form on Tally, Chrome Web Store listing, X, and Discord). Monitor never fetches or contacts these URLs in the background.
