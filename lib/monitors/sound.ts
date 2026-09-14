import { play } from 'cuelume';
import { sendMessage } from '@/lib/messaging';

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

/**
 * Plays a Cuelume interaction cue.
 *
 * - Synthesizes live Web Audio when called in a window/DOM context (content script, panel, options).
 * - Relays to the active focused tab via messaging when called from the background worker.
 * - Fails safely with zero disruption to monitor checking if audio is unavailable.
 */
export function playCue(cue: MonitorCue, volume = CUE_VOLUME): void {
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
