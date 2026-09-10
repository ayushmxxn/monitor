import { Button } from '@/components/ui/button';
import { SettingRow, SettingSelectRow, SettingLinkRow, SettingActionRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { WebhookSettings } from '@/components/settings/WebhookSettings';
import { DiscordSettings } from '@/components/settings/DiscordSettings';
import { TelegramSettings } from '@/components/settings/TelegramSettings';
import { ClearAllMonitorsDialog } from '@/components/settings/ClearAllMonitorsDialog';
import { useStorage } from '@/hooks/useStorage';
import { settingsItem, monitorsItem } from '@/lib/storage/items';
import { clearAllMonitors, setAllMonitorsInterval } from '@/lib/monitors/store';
import { INTERVAL_OPTIONS, formatIntervalMinutes } from '@/lib/monitors/intervals';
import { FEEDBACK_URL, getWebStoreUrl } from '@/lib/constants';

/**
 * Settings, rendered in place inside the panel rather than opening the
 * options page in a new tab. The app name/version now lives in the
 * panel's persistent footer (see Panel.tsx) instead of repeating it
 * here too.
 */
export function PanelSettings() {
  const [settings, setSettings, isSettingsLoading] = useStorage(settingsItem);
  const [monitors] = useStorage(monitorsItem);

  async function handleIntervalChange(minutes: number) {
    const saved = await setSettings({ ...settings, defaultIntervalMinutes: minutes });
    if (!saved) return;
    await setAllMonitorsInterval(minutes);
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="General">
        <SettingRow
          id="panel-notifications"
          label="Notifications"
          description="Show a system notification for future monitor alerts."
          checked={settings.notificationsEnabled}
          disabled={isSettingsLoading}
          onCheckedChange={(checked) => setSettings({ ...settings, notificationsEnabled: checked })}
        />
        <SettingSelectRow
          id="panel-default-interval"
          label="Check interval"
          value={settings.defaultIntervalMinutes}
          disabled={isSettingsLoading}
          options={INTERVAL_OPTIONS.map((minutes) => ({
            value: minutes,
            label: formatIntervalMinutes(minutes),
          }))}
          onValueChange={handleIntervalChange}
        />
        <SettingSelectRow
          id="panel-theme"
          label="Theme"
          description="Choose the appearance used throughout Monitor."
          value={settings.theme}
          disabled={isSettingsLoading}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onValueChange={(theme) => setSettings({ ...settings, theme })}
        />
      </SettingsSection>

      <WebhookSettings
        settings={settings}
        onChange={setSettings}
        disabled={isSettingsLoading}
        idPrefix="panel"
      />

      <DiscordSettings
        settings={settings}
        onChange={setSettings}
        disabled={isSettingsLoading}
        idPrefix="panel"
      />

      <TelegramSettings
        settings={settings}
        onChange={setSettings}
        disabled={isSettingsLoading}
        idPrefix="panel"
      />

      <SettingsSection title="Data">
        <SettingActionRow
          label="Clear all monitors"
          description="Permanently removes every monitor and its check history."
          action={
            <ClearAllMonitorsDialog
              monitorCount={monitors.length}
              onConfirm={() => clearAllMonitors()}
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-destructive/25 text-xs text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  disabled={monitors.length === 0}
                >
                  Clear all
                </Button>
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Feedback">
        <SettingLinkRow label="Send feedback" href={FEEDBACK_URL} />
        <SettingLinkRow label="Rate Monitor" href={getWebStoreUrl()} />
      </SettingsSection>
    </div>
  );
}
