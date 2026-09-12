import { sendMessage } from '@/lib/messaging';
import type { PickResult } from '@/entrypoints/pageAgent.content';
import { pickOnTab, isTransientFrameError } from './pageAgentClient';

/**
 * Runs the interactive picker on `tabId`. The picker (in
 * `entrypoints/pageAgent.content.ts`) handles everything itself once
 * it starts — hover preview, click-to-save, even writing the finished
 * monitor to storage — so this just has to kick it off, wait for it to
 * settle, and tell the tab it's over; there's no follow-up tab or
 * hand-off payload to manage.
 *
 * This still lives in the background worker rather than the panel
 * that triggers it because the pick can take an arbitrarily long time
 * (the user has to go find and click the right element on the page),
 * and only the background worker's lifetime is independent of whatever
 * UI kicked it off. See ProtocolMap.startElementPicker for the message
 * that kicks this off.
 */
export async function runPickerFlow(tabId: number): Promise<void> {
  let result: PickResult | null = null;
  try {
    result = await pickOnTab(tabId);
  } catch (error) {
    if (!isTransientFrameError(error)) {
      console.warn('[background] Element picker failed:', error);
    }
  }

  // Always tell the tab the session is over, success or not, so the
  // panel's "Add" trigger can reset instead of staying disabled until
  // its own failsafe timeout. Best-effort: if the tab navigated away
  // or closed mid-pick, there's no panel left to hear this and the
  // send will reject - nothing to do about that, since there's
  // nothing left to reset.
  try {
    await sendMessage(
      'elementPickerFinished',
      {
        saved: result?.saved ?? false,
        monitorName: result?.monitorName ?? null,
        monitorId: result?.monitorId ?? null,
      },
      tabId,
    );
  } catch {
    // No listener in that tab anymore - ignore.
  }
}
