import { useEffect } from "react";
import { CreatorCredit } from "@/components/layout/CreatorCredit";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { Header } from "@/components/layout/Header";
import { ClearAllMonitorsDialog } from "@/components/settings/ClearAllMonitorsDialog";
import {
  SettingActionRow,
  SettingLinkRow,
  SettingRow,
  SettingSelectRow,
} from "@/components/settings/SettingRow";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { WebhookSettings } from "@/components/settings/WebhookSettings";
import { DiscordSettings } from "@/components/settings/DiscordSettings";
import { TelegramSettings } from "@/components/settings/TelegramSettings";
import { SiteAccessSection } from "@/components/settings/SiteAccessSection";
import { Button } from "@/components/ui/button";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useStorage } from "@/hooks/useStorage";
import { APP_NAME, FEEDBACK_URL, getWebStoreUrl } from "@/lib/constants";
import {
  INTERVAL_OPTIONS,
  formatIntervalMinutes,
} from "@/lib/monitors/intervals";
import { clearAllMonitors, setAllMonitorsInterval } from "@/lib/monitors/store";
import { settingsItem } from "@/lib/storage";
import { monitorsItem } from "@/lib/storage/items";

export function App() {
  return (
    <ErrorBoundary scope="options">
      <OptionsContent />
    </ErrorBoundary>
  );
}

function OptionsContent() {
  const [settings, setSettings, isLoading] = useStorage(settingsItem);
  const [monitors] = useStorage(monitorsItem);
  const { appInfo } = useAppInfo();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
  }, [settings.theme]);

  async function handleIntervalChange(minutes: number) {
    const saved = await setSettings({ ...settings, defaultIntervalMinutes: minutes });
    if (!saved) return;
    await setAllMonitorsInterval(minutes);
  }

  return (
    <div
      className={`mx-auto min-h-screen max-w-xl bg-background text-foreground${settings.theme === "dark" ? " dark" : ""}`}
    >
      <Header />

      <main className="flex flex-col gap-5 p-6">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Settings</h1>
          <p className="text-[12.5px] text-muted-foreground">
            Monitor runs entirely on this device, except webhook alerts you explicitly configure.
          </p>
        </div>

        <SettingsSection title="General">
          <SettingRow
            id="notifications"
            label="Notifications"
            description="Show a system notification for future monitor alerts."
            checked={settings.notificationsEnabled}
            disabled={isLoading}
            onCheckedChange={(checked) =>
              setSettings({ ...settings, notificationsEnabled: checked })
            }
          />
          <SettingSelectRow
            id="default-interval"
            label="Check interval"
            value={settings.defaultIntervalMinutes}
            disabled={isLoading}
            options={INTERVAL_OPTIONS.map((minutes) => ({
              value: minutes,
              label: formatIntervalMinutes(minutes),
            }))}
            onValueChange={handleIntervalChange}
          />
          <SettingSelectRow
            id="theme"
            label="Theme"
            description="Choose the appearance used throughout Monitor."
            value={settings.theme}
            disabled={isLoading}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={(theme) => setSettings({ ...settings, theme })}
          />
        </SettingsSection>

        <SiteAccessSection />

        <WebhookSettings
          settings={settings}
          onChange={setSettings}
          disabled={isLoading}
          idPrefix="options"
        />

        <DiscordSettings
          settings={settings}
          onChange={setSettings}
          disabled={isLoading}
          idPrefix="options"
        />

        <TelegramSettings
          settings={settings}
          onChange={setSettings}
          disabled={isLoading}
          idPrefix="options"
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

        <div className="flex items-center justify-between border-t border-border pb-2 pt-4">
          <span className="text-xs text-muted-foreground">
            {APP_NAME} {appInfo ? `v${appInfo.version}` : ""}
          </span>
          <CreatorCredit />
        </div>
      </main>
    </div>
  );
}
