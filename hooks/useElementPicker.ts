import { useCallback, useEffect, useState } from 'react';
import { onMessage, sendMessage } from '@/lib/messaging';

export type ElementPickerState = 'idle' | 'starting' | 'waiting';

export interface UseElementPickerResult {
  state: ElementPickerState;
  error: string | null;
  start: () => Promise<void>;
}

/**
 * Starts the element picker via the background worker and gets out of
 * the way. The picker's "wait for a click" step and the follow-up
 * "configure and save" step both happen outside the panel on
 * purpose - the pick itself can take an arbitrarily long time, so
 * nothing here can wait for that click. See `lib/monitors/pickerFlow.ts`.
 *
 * Lifted out of a single component so the panel can drive both a
 * compact trigger button (in the header) and a status notice
 * (in the body) off one shared state.
 *
 * `onFinished`, if given, fires once with the same `{ saved,
 * monitorName }` payload the background worker broadcasts - Panel.tsx
 * uses this to reopen itself the moment a pick is actually saved, so
 * the panel closing to get out of the way during picking doesn't leave
 * the user staring at a page with no confirmation anything happened.
 */
export function useElementPicker(
  onFinished?: (result: {
    saved: boolean;
    monitorName: string | null;
    monitorId?: string | null;
  }) => void,
): UseElementPickerResult {
  const [state, setState] = useState<ElementPickerState>('idle');
  const [error, setError] = useState<string | null>(null);

  // The background worker broadcasts this the moment a picker session
  // it started has fully ended - saved, cancelled with Escape, or
  // failed - which is what actually lets "Add" be clicked again on
  // the same page without a reload. See pickerFlow.ts.
  useEffect(() => {
    return onMessage('elementPickerFinished', ({ data }) => {
      setState('idle');
      setError(null);
      onFinished?.(data);
    });
  }, [onFinished]);

  // Safety net only, not the primary reset path above: if the
  // background worker were ever killed/restarted mid-pick and the
  // broadcast above never arrives, don't leave the button disabled
  // forever. Generous timeout since finding and hovering the right
  // value on a busy page can genuinely take a while - this is just a
  // safety net, not meant to fire during normal use.
  useEffect(() => {
    if (state !== 'waiting') return;
    const timeout = setTimeout(() => setState('idle'), 60_000);
    return () => clearTimeout(timeout);
  }, [state]);

  const start = useCallback(async () => {
    setError(null);
    setState('starting');
    try {
      const result = await sendMessage('startElementPicker', undefined);
      if (!result.started) {
        setError(result.error ?? 'Could not start the picker.');
        setState('idle');
        return;
      }
      setState('waiting');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the picker.');
      setState('idle');
    }
  }, []);

  return { state, error, start };
}
