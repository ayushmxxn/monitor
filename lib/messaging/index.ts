import { defineExtensionMessaging } from '@webext-core/messaging';
import { isExtensionContextInvalidated } from '@/lib/errors';
import { EXTENSION_INVALIDATED_EVENT } from '@/hooks/useExtensionInvalidated';
import type { ProtocolMap } from './protocol';

export type {
  ProtocolMap,
  AppInfo,
  BundledFontPayload,
  ExtensionInstallType,
  ParseHtmlInput,
  ParseHtmlResult,
  ResolvedFaviconResult,
} from './protocol';
export type { Diagnostic, DiagnosticCode } from '@/lib/monitors/diagnostics';

/**
 * Typed messaging layer.
 *
 * `sendMessage` is used from the panel, options page, or content scripts
 * to talk to the background worker (and vice versa). `onMessage` is used
 * in the background worker to register handlers. Both are fully typed
 * against `ProtocolMap`, so a typo'd message name or wrong payload is a
 * compile error, not a runtime one.
 *
 * `sendMessage` has no built-in timeout: message duration varies wildly
 * across this protocol (a `ping` should resolve in milliseconds, a
 * `checkMonitorNow` can legitimately take 20+ seconds if it falls back
 * to the live-tab strategy). Callers that need a timeout apply one
 * themselves via `withTimeout` below, sized to what they're calling.
 */
const messenger = defineExtensionMessaging<ProtocolMap>();

export const onMessage: typeof messenger.onMessage = ((type: any, handler: any) => {
  try {
    const unregister = messenger.onMessage(type, handler);
    return () => {
      try {
        unregister();
      } catch {
        // Ignored if chrome.runtime is already invalidated or undefined
      }
    };
  } catch {
    return () => {};
  }
}) as typeof messenger.onMessage;

let idSeq = Math.floor(Math.random() * 10000);
function getNextId(): number {
  return idSeq++;
}

/**
 * Enhanced sendMessage that properly handles chrome.runtime.lastError for both
 * runtime and tab messaging.
 *
 * In @webext-core/messaging, chrome.tabs.sendMessage omits checking chrome.runtime.lastError,
 * causing Chrome to emit "Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist."
 * to the console whenever messaging a tab that does not have an active listener.
 * Furthermore, when an extension context is invalidated during development, this wrapper catches
 * the failure and notifies the page via EXTENSION_INVALIDATED_EVENT so stale calls cease immediately.
 */
export const sendMessage: typeof messenger.sendMessage = (async (
  type: string,
  data?: unknown,
  ...args: [arg?: number | { tabId: number; frameId?: number }]
) => {
  const arg = args[0];

  if (arg != null) {
    const options = typeof arg === 'number' ? { tabId: arg } : arg;
    const message = {
      id: getNextId(),
      type,
      data,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        options.tabId,
        message,
        options.frameId != null ? { frameId: options.frameId } : undefined,
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          if (response?.err) {
            reject(new Error(response.err.message || 'Messaging error'));
            return;
          }
          resolve(response?.res !== undefined ? response.res : response);
        },
      );
    });
  }

  try {
    return await (messenger.sendMessage as (t: string, d?: unknown) => Promise<unknown>)(type, data);
  } catch (error) {
    if (typeof window !== 'undefined' && isExtensionContextInvalidated(error)) {
      window.dispatchEvent(new CustomEvent(EXTENSION_INVALIDATED_EVENT));
    }
    throw error;
  }
}) as typeof messenger.sendMessage;

/** Races a promise against a timeout, rejecting with a clear message if it's too slow. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('The background worker did not respond in time.')),
        timeoutMs,
      );
    }),
  ]);
}
