/**
 * Storage schema.
 *
 * Every shape persisted to `chrome.storage` is defined here. Keeping the
 * schema in one file makes it easy to see the extension's full local
 * state at a glance and to reason about migrations as fields are added.
 */

export const SETTINGS_SCHEMA_VERSION = 4;

export type Theme = 'light' | 'dark';

export interface AppSettings {
  schemaVersion: number;
  /** Whether the extension may show system notifications for future checks. */
  notificationsEnabled: boolean;
  /**
   * How often, in minutes, every monitor is checked. A single global
   * value rather than a per-monitor setting - simpler to reason about
   * and to change. Changing it updates every existing monitor's
   * schedule immediately (see `setAllMonitorsInterval` in
   * `lib/monitors/store.ts`).
   */
  defaultIntervalMinutes: number;
  /** The extension's UI color scheme, chosen explicitly by the user. */
  theme: Theme;
  /**
   * Whether monitor alerts are also POSTed as JSON to a user-configured
   * generic webhook URL. Independent of `notificationsEnabled` - either,
   * both, or neither may be on. Defaults to off so nothing ever leaves
   * the device unless the user explicitly opts in.
   */
  webhookEnabled: boolean;
  /** Destination URL for webhook alert POSTs. Only used when `webhookEnabled` is true. */
  webhookUrl: string;
  /**
   * Whether monitor alerts are also sent to a user-configured Discord
   * channel webhook. Independent of `notificationsEnabled` and
   * `webhookEnabled`. Defaults to off so nothing ever leaves the device
   * unless the user explicitly opts in.
   */
  discordEnabled: boolean;
  /** Discord channel webhook URL. Only used when `discordEnabled` is true. */
  discordWebhookUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  notificationsEnabled: true,
  defaultIntervalMinutes: 30,
  theme: 'light',
  webhookEnabled: false,
  webhookUrl: '',
  discordEnabled: false,
  discordWebhookUrl: '',
};
