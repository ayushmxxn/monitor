/** App-wide constants. Keep this the single source of truth for magic values. */

export const APP_NAME = 'Monitor';

/** Storage key prefixes, namespaced to avoid collisions as features grow. */
export const STORAGE_KEYS = {
  settings: 'local:settings',
} as const;

/** Timeout for a single background <-> UI message round trip. */
export const MESSAGE_TIMEOUT_MS = 5_000;

/** External feedback form, linked from Settings. */
export const FEEDBACK_URL = 'https://tally.so/r/0Qq7GN';

/** Creator credit, shown in the settings footer. */
export const CREATOR_HANDLE = '@ayushmxxn';
export const CREATOR_PORTFOLIO_URL = 'https://ayushmxxn.com/';
export const CREATOR_TWITTER_URL = 'https://x.com/ayushmxxn';
/** Creator Discord server, linked from the settings footer social row. */
export const CREATOR_DISCORD_URL = 'https://discord.com/invite/kzk6uWey3g';

/**
 * This extension's own Chrome Web Store listing, linked from Settings
 * for the user to leave a rating. Built from the running extension's
 * own id rather than hardcoded so it always points at wherever this
 * exact build is actually listed (and stays correct across dev/prod
 * ids) instead of drifting from a copy-pasted constant.
 */
export function getWebStoreUrl(): string {
  return `https://chromewebstore.google.com/detail/${browser.runtime.id}`;
}
