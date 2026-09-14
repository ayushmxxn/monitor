import { Button } from '@/components/ui/button';
import { SettingRow, SettingSelectRow, SettingLinkRow, SettingActionRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SocialLinks } from '@/components/layout/SocialLinks';
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
    <div className="flex flex-col gap-5 pb-4">
      <SettingsSection title="General">
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
          label="Appearance"
          value={settings.theme}
          disabled={isSettingsLoading}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onValueChange={(theme) => setSettings({ ...settings, theme })}
        />
      </SettingsSection>

      <SettingsSection title="Notifications & Alerts">
        <SettingRow
          id="panel-notifications"
          label="System notifications"
          checked={settings.notificationsEnabled}
          disabled={isSettingsLoading}
          onCheckedChange={(checked) => setSettings({ ...settings, notificationsEnabled: checked })}
        />
        <SettingRow
          id="panel-sound"
          label="Sound"
          checked={settings.soundEnabled}
          disabled={isSettingsLoading}
          onCheckedChange={(checked) => setSettings({ ...settings, soundEnabled: checked })}
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
        <WebhookSettings
          settings={settings}
          onChange={setSettings}
          disabled={isSettingsLoading}
          idPrefix="panel"
        />
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingActionRow
          label="Clear all monitors"
          description="Delete all monitors and historical checks."
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

      <SettingsSection title="About & Feedback">
        <SettingLinkRow label="Send feedback" href={FEEDBACK_URL} />
        <SettingLinkRow label="Rate Monitor" href={getWebStoreUrl()} />
        <SettingActionRow label="Socials" action={<SocialLinks />} />
      </SettingsSection>
    </div>
  );
}
