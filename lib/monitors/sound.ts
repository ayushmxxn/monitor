import { play } from 'cuelume';
import { sendMessage } from '@/lib/messaging';
import { settingsItem } from '@/lib/storage/items';

/** Subtle volume for interaction cues (0.3–0.4 range). */
export const CUE_VOLUME = 0.35;
export const SPARKLE_VOLUME = CUE_VOLUME;
export const ERROR_VOLUME = CUE_VOLUME;

export type MonitorCue = 'sparkle' | 'error';

/** Optional listener for unit test verification. */
type CueListener = (sound: MonitorCue, volume: number) => void;
let testListener: CueListener | null = null;

export function setCueListenerForTesting(listener: CueListener | null): void {
  testListener = listener;
}

let cachedSoundEnabled = true;

/**
 * Synchronizes the in-memory sound preference cache with persistent storage.
 */
export async function syncSoundSetting(): Promise<boolean> {
  try {
    const settings = await settingsItem.getValue();
    if (settings && typeof settings.soundEnabled === 'boolean') {
      cachedSoundEnabled = settings.soundEnabled;
    }
  } catch {
    // Best-effort cache synchronization
  }
  return cachedSoundEnabled;
}

// Initial best-effort synchronization
void syncSoundSetting();

// Keep cache synchronized on live changes across processes
try {
  settingsItem.watch((newSettings) => {
    if (newSettings && typeof newSettings.soundEnabled === 'boolean') {
      cachedSoundEnabled = newSettings.soundEnabled;
    }
  });
} catch {
  // Safe fallback if watching is not supported in the active environment
}

export function isSoundEnabled(): boolean {
  return cachedSoundEnabled;
}

export function setSoundEnabledForTesting(enabled: boolean | null): void {
  cachedSoundEnabled = enabled ?? true;
}

/**
 * Plays a Cuelume interaction cue.
 *
 * - Suppressed completely if global sound setting is disabled.
 * - Synthesizes live Web Audio when called in a window/DOM context (content script, panel, options).
 * - Relays to the active focused tab via messaging when called from the background worker.
 * - Fails safely with zero disruption to monitor checking if audio is unavailable.
 */
export function playCue(cue: MonitorCue, volume = CUE_VOLUME): void {
  if (!cachedSoundEnabled) {
    return;
  }

  if (testListener) {
    testListener(cue, volume);
  }

  // 1. Direct playback if Web Audio / window is available
  try {
    play(cue, { volume });
  } catch {
    // Audio synthesis failure should never fail a check
  }

  // 2. In Chrome background service worker, broadcast to the active tab to synthesize audio
  if (typeof window === 'undefined' && typeof chrome !== 'undefined' && chrome.tabs?.query) {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const targetTab = tabs?.[0];
        if (targetTab?.id) {
          sendMessage('playCue', { cue, volume }, targetTab.id).catch(() => {});
        }
      });
    } catch {
      // Best-effort messaging
    }
  }
}

export function playSparkleCue(): void {
  playCue('sparkle', SPARKLE_VOLUME);
}

export function playErrorCue(): void {
  playCue('error', ERROR_VOLUME);
}
