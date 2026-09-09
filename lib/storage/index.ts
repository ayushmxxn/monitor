import { tryCatch, type Result } from '@/lib/errors';
import type { AppSettings } from './schema';
import { settingsItem } from './items';

export type { AppSettings, Theme } from './schema';
export { DEFAULT_SETTINGS } from './schema';
export { settingsItem } from './items';

/**
 * Storage layer public API.
 *
 * UI code should generally prefer the `useStorage` hook (for live,
 * reactive values). Use these functions directly from non-React contexts
 * like the background worker, or when a one-off read/write is needed.
 */

export function getSettings(): Promise<Result<AppSettings>> {
  return tryCatch(() => settingsItem.getValue(), 'STORAGE_READ_FAILED');
}

export function setSettings(value: AppSettings): Promise<Result<void>> {
  return tryCatch(() => settingsItem.setValue(value), 'STORAGE_WRITE_FAILED');
}

export function updateSettings(
  patch: Partial<AppSettings>,
): Promise<Result<AppSettings>> {
  return tryCatch(async () => {
    const current = await settingsItem.getValue();
    const next = { ...current, ...patch };
    await settingsItem.setValue(next);
    return next;
  }, 'STORAGE_WRITE_FAILED');
}
