import { useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildDiscordPayload, isValidDiscordWebhookUrl, testWebhookDelivery } from '@/lib/monitors/discord';
import type { AppSettings } from '@/lib/storage';

interface DiscordSettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void | Promise<unknown>;
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
      'Previous value',
      'Test value',
      {
        hasChange: true,
        isNumeric: true,
        previousValue: 'Previous value',
        currentValue: 'Test value',
        absoluteDelta: null,
        formattedDelta: '+$1.00',
        percentageDelta: 10,
        formattedPercentage: '+10.0%',
        direction: 'increase',
        summaryText: '',
        fullText: '',
      },
      Date.now(),
    );
    const ok = await testWebhookDelivery(settings.discordWebhookUrl, payload);
    setTestState(ok ? 'sent' : 'failed');
  }

  return (
    <div>
      <SettingRow
        id={`${idPrefix}-discord-enabled`}
        label="Discord"
        checked={settings.discordEnabled}
        disabled={disabled}
        onCheckedChange={(checked) => {
          setTestState('idle');
          void onChange({ ...settings, discordEnabled: checked });
        }}
      />
      {settings.discordEnabled && (
        <div className="flex flex-col gap-2 border-t border-border/50 bg-muted/20 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-discord-url`}
              type="url"
              inputMode="url"
              placeholder="Webhook URL (https://discord.com/api/...)"
              value={settings.discordWebhookUrl}
              disabled={disabled}
              onChange={(e) => {
                setTestState('idle');
                void onChange({ ...settings, discordWebhookUrl: e.target.value });
              }}
              className="h-7 bg-background text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2.5 text-xs font-normal"
              disabled={disabled || !isValidDiscordWebhookUrl(settings.discordWebhookUrl) || testState === 'sending'}
              onClick={handleTest}
            >
              {testState === 'sending' ? 'Sending…' : testState === 'sent' ? 'Sent ✓' : 'Test'}
            </Button>
          </div>
          {!urlValid ? (
            <p className="text-[11px] text-destructive">Enter a valid Discord webhook URL.</p>
          ) : testState === 'sent' ? (
            <p className="text-[11px] text-muted-foreground">Test alert delivered to channel.</p>
          ) : testState === 'failed' ? (
            <p className="text-[11px] text-destructive">Delivery failed. Check the webhook URL.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
