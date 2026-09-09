/**
 * Message protocol.
 *
 * `@webext-core/messaging` derives fully-typed `sendMessage`/`onMessage`
 * functions from this single interface, so every message name, its
 * payload, and its return type are checked at compile time on both ends
 * of the wire (background <-> panel <-> options <-> content scripts).
 *
 * Add one entry per message. Keep payloads small and serializable -
 * anything crossing an extension messaging boundary is JSON-serialized.
 */
import type { ElementFingerprint } from '@/lib/monitors/fingerprint';
import type { Diagnostic } from '@/lib/monitors/diagnostics';
import type { SemanticValue } from '@/lib/monitors/semanticValue';

export interface ProtocolMap {
  /** Liveness check. Used by the UI to confirm the background worker is running. */
  ping(): 'pong';

  /** Basic runtime info, useful for a "diagnostics" or "about" panel. */
  getAppInfo(): AppInfo;

  /**
   * Parses raw HTML and locates/extracts a value using an element
   * fingerprint (exact match or scored recovery). Handled by the
   * offscreen document, which is the only extension context with a DOM
   * (`DOMParser`/`document`) - MV3 service workers have neither.
   */
  parseHtml(input: ParseHtmlInput): ParseHtmlResult;

  /** Runs an immediate check for one monitor, bypassing the schedule. */
  checkMonitorNow(monitorId: string): { ok: boolean; error: string | null };

  /** Checks every enabled monitor immediately, ignoring each one's individual schedule. Used by the "refresh all" action. */
  checkAllMonitorsNow(): { ok: boolean; error: string | null };

  /**
   * Starts the element picker on the current active tab and returns
   * immediately once it's running - it does NOT wait for the user to
   * hover or click anything. That wait happens entirely in the
   * background worker (see entrypoints/background.ts), since it can
   * take an arbitrarily long time and the background worker is the one
   * context guaranteed to still be alive whenever the pick actually
   * finishes. The picker itself (entrypoints/pageAgent.content.ts)
   * saves the monitor directly the moment a valid value is clicked -
   * there's no further hand-off once picking starts.
   */
  startElementPicker(): { started: boolean; error: string | null };

  /**
   * Broadcast from the background worker to the tab that a picker
   * session was started on, once that session has fully ended -
   * saved, cancelled with Escape, or failed. `startElementPicker`
   * only confirms the picker *started*, not how it ended, and the
   * pick can take an arbitrarily long time - so this is the only way
   * the panel's "Add" trigger finds out it's safe to start another
   * one. See `lib/monitors/pickerFlow.ts`.
   */
  elementPickerFinished(result: { saved: boolean; monitorName: string | null }): void;

  /** Opens the extension's options page. The panel runs inside a content script, which has no `chrome.tabs` access, so opening a real tab has to be delegated to the background worker. */
  openOptionsPage(): { ok: boolean };

  /**
   * Sent from the background worker to a tab's already-injected panel
   * content script to flip it open/closed. The background worker tries
   * this first on every toolbar-icon click; only if it rejects (no
   * listener - meaning the panel was never injected on this tab, or its
   * previous instance was torn down by a navigation) does it fall back
   * to `scripting.executeScript`. This is what makes repeat clicks a
   * plain toggle instead of re-running the content script file, which
   * would otherwise invalidate and tear down the panel that's already
   * there (see entrypoints/panel.content.tsx).
   */
  togglePanel(): { handled: boolean };

  /**
   * Batch permission check for a set of URLs, keyed by the URL passed
   * in. The panel is a content script, which has no `chrome.permissions`
   * access at all (not even read-only checks), so this has to be
   * relayed through the background worker.
   */
  checkOriginPermissions(urls: string[]): Record<string, boolean>;
}

export interface ParseHtmlInput {
  html: string;
  fingerprint: ElementFingerprint;
  extractMode: 'text' | 'attribute';
  attributeName: string | null;
}

export interface ParseHtmlResult {
  value: string | null;
  diagnostic: Diagnostic;
  updatedFingerprint: ElementFingerprint | null;
  confidence: number;
  method: string;
  semanticValue: SemanticValue | null;
}

export type ExtensionInstallType =
  | 'development'
  | 'normal'
  | 'sideload'
  | 'other'
  | 'admin'
  | 'unknown';

export interface AppInfo {
  version: string;
  name: string;
  installType: ExtensionInstallType;
}
