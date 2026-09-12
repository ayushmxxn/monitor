/**
 * Web Audio synthesizer for tactile UI sound effects, matched to the
 * subtle organic tones on https://bencho.dev/?c=pull&theme=light.
 *
 * Uses native Web Audio oscillators and lowpass biquad filters with zero
 * external audio assets or network requests. Pitch scales with trend
 * line height (`at` parameter).
 */

interface SynthTone {
  hz: number;
  to?: number;
  ms: number;
  gain?: number;
  wave?: OscillatorType;
  cut?: number;
  atk?: number;
  at?: number;
}

const SOUNDS: Record<'drag' | 'click', SynthTone[]> = {
  // Soft, warm droplet tone that modulates in pitch as the cursor scrubs
  // along the trend curve (matches bencho.dev `drag`).
  drag: [{ hz: 174, to: 155, ms: 250, gain: 0.034, wave: 'sine', cut: 640, atk: 28 }],
  // Crisp, tactile click for time range pills and primary actions.
  click: [{ hz: 196, to: 130, ms: 150, gain: 0.07, wave: 'sine', cut: 900 }],
};

let audioCtx: AudioContext | null = null;
const lastPlayedTimes: Record<string, number> = {};

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('pointermove', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

export interface PlaySoundOptions {
  /** Normalized value from 0 (lowest) to 1 (highest) to modulate pitch. */
  at?: number;
  /** Minimum time in ms before this sound effect can be retriggered. */
  gap?: number;
}

/**
 * Checks whether tactile UI audio is enabled (defaults to true).
 */
export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('monitor:sound') !== 'off';
  } catch {
    return true;
  }
}

/**
 * Sets tactile UI audio preference.
 */
export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('monitor:sound', enabled ? 'on' : 'off');
  } catch {
    // Ignore storage errors
  }
}

/**
 * Plays a synthesized UI tone matching bencho.dev interaction sounds.
 */
export function playSound(name: 'drag' | 'click', options?: PlaySoundOptions): void {
  if (!isSoundEnabled()) return;

  if (options?.gap) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - (lastPlayedTimes[name] ?? -Infinity) < options.gap) {
      return;
    }
    lastPlayedTimes[name] = now;
  }

  const ctx = getAudioContext();
  if (!ctx) return;

  const tones = SOUNDS[name];
  if (!tones) return;

  // Scale frequency based on normalized height `at` [0..1]: 0.75x at min up to 1.5x at max.
  const pitchRatio =
    options?.at === undefined
      ? 1
      : 0.75 + Math.min(1, Math.max(0, options.at)) * 0.75;

  try {
    for (const tone of tones) {
      const startTime = ctx.currentTime + (tone.at ?? 0) / 1000;
      const endTime = startTime + tone.ms / 1000;

      const osc = ctx.createOscillator();
      osc.type = tone.wave ?? 'sine';
      osc.frequency.setValueAtTime(tone.hz * pitchRatio, startTime);
      if (tone.to) {
        osc.frequency.exponentialRampToValueAtTime(tone.to * pitchRatio, endTime);
      }

      const gainNode = ctx.createGain();
      const attackSec = Math.min((tone.atk ?? 4) / 1000, (tone.ms / 1000) * 0.6);
      const targetGain = tone.gain ?? 0.05;

      gainNode.gain.setValueAtTime(0.0001, startTime);
      gainNode.gain.exponentialRampToValueAtTime(targetGain, startTime + attackSec);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime);

      let sourceNode: AudioNode = osc;
      if (tone.cut) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = tone.cut;
        osc.connect(filter);
        sourceNode = filter;
      }

      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(endTime + 0.02);
    }
  } catch {
    // Ignore audio rendering errors gracefully
  }
}
