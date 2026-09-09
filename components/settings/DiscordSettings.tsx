import { useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buildDiscordPayload, isValidDiscordWebhookUrl, postDiscordAlert } from '@/lib/monitors/discord';
import type { AppSettings } from '@/lib/storage';

interface DiscordSettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void | Promise<void>;
  disabled?: boolean;
  idPrefix: string;
}

/**
 * Discord channel alert settings, mirroring `WebhookSettings` so both
 * surfaces stay identical. Toggle + webhook URL + best-effort test
 * POST; delivery itself lives in `lib/monitors/discord.ts` and is
 * fanned out from the existing `notifyChange` alert path.
 */
export function DiscordSettings({ settings, onChange, disabled, idPrefix }: DiscordSettingsProps) {
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const urlValid = !settings.discordWebhookUrl.trim() || isValidDiscordWebhookUrl(settings.discordWebhookUrl);

  async function handleTest() {
    if (!isValidDiscordWebhookUrl(settings.discordWebhookUrl) || testState === 'sending') return;
    setTestState('sending');
    const payload = buildDiscordPayload(
      { id: 'test', name: 'Monitor test', url: 'https://example.com' } as Parameters<
        typeof buildDiscordPayload
      >[0],
      'This is a test alert from Monitor.',
    );
    const ok = await postDiscordAlert(settings.discordWebhookUrl, payload);
    setTestState(ok ? 'sent' : 'failed');
  }

  return (
    <SettingsSection title="Discord">
      <SettingRow
        id={`${idPrefix}-discord-enabled`}
        label="Discord alerts"
        description="Send monitor alerts to a Discord channel."
        checked={settings.discordEnabled}
        disabled={disabled}
        onCheckedChange={(checked) => {
          setTestState('idle');
          void onChange({ ...settings, discordEnabled: checked });
        }}
      />
      {settings.discordEnabled && (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <Label htmlFor={`${idPrefix}-discord-url`} className="text-[13px] font-normal leading-tight">
            Webhook URL
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-discord-url`}
              type="url"
              inputMode="url"
              placeholder="https://discord.com/api/webhooks/…"
              value={settings.discordWebhookUrl}
              disabled={disabled}
              onChange={(e) => {
                setTestState('idle');
                void onChange({ ...settings, discordWebhookUrl: e.target.value });
              }}
              className="h-7 text-[12.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={disabled || !isValidDiscordWebhookUrl(settings.discordWebhookUrl) || testState === 'sending'}
              onClick={handleTest}
            >
              {testState === 'sending' ? 'Sending…' : 'Test'}
            </Button>
          </div>
          {!urlValid ? (
            <p className="text-[11.5px] leading-snug text-destructive">Enter a valid Discord webhook URL.</p>
          ) : testState === 'sent' ? (
            <p className="text-[11.5px] leading-snug text-muted-foreground">Test delivered.</p>
          ) : testState === 'failed' ? (
            <p className="text-[11.5px] leading-snug text-destructive">Test failed. Check the URL and try again.</p>
          ) : (
            <p className="text-[11.5px] leading-snug text-muted-foreground">
              Alerts are sent as channel messages and never block checks.
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
