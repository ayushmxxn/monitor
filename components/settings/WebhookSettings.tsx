import { useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buildWebhookPayload, isValidWebhookUrl, postWebhookAlert } from '@/lib/monitors/webhook';
import type { AppSettings } from '@/lib/storage';

interface WebhookSettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void | Promise<unknown>;
  disabled?: boolean;
  idPrefix: string;
}

/**
 * Generic webhook alert settings, shared by the panel and the options
 * page so both stay identical. Toggle + URL + best-effort test POST;
 * delivery itself lives in `lib/monitors/webhook.ts` and is fanned out
 * from the existing `notifyChange` alert path.
 */
export function WebhookSettings({ settings, onChange, disabled, idPrefix }: WebhookSettingsProps) {
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const urlValid = !settings.webhookUrl.trim() || isValidWebhookUrl(settings.webhookUrl);

  async function handleTest() {
    if (!isValidWebhookUrl(settings.webhookUrl) || testState === 'sending') return;
    setTestState('sending');
    const payload = buildWebhookPayload(
      { id: 'test', name: 'Monitor test', url: 'https://example.com' } as Parameters<
        typeof buildWebhookPayload
      >[0],
      'Test value',
      'Previous value',
      'This is a test alert from Monitor.',
      Date.now(),
    );
    const ok = await postWebhookAlert(settings.webhookUrl, payload);
    setTestState(ok ? 'sent' : 'failed');
  }

  return (
    <SettingsSection title="Webhook">
      <SettingRow
        id={`${idPrefix}-webhook-enabled`}
        label="Webhook alerts"
        description="POST monitor alerts as JSON to your URL."
        checked={settings.webhookEnabled}
        disabled={disabled}
        onCheckedChange={(checked) => {
          setTestState('idle');
          void onChange({ ...settings, webhookEnabled: checked });
        }}
      />
      {settings.webhookEnabled && (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <Label htmlFor={`${idPrefix}-webhook-url`} className="text-[13px] font-normal leading-tight">
            Webhook URL
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-webhook-url`}
              type="url"
              inputMode="url"
              placeholder="https://example.com/hooks/monitor"
              value={settings.webhookUrl}
              disabled={disabled}
              onChange={(e) => {
                setTestState('idle');
                void onChange({ ...settings, webhookUrl: e.target.value });
              }}
              className="h-7 text-[12.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={disabled || !isValidWebhookUrl(settings.webhookUrl) || testState === 'sending'}
              onClick={handleTest}
            >
              {testState === 'sending' ? 'Sending…' : 'Test'}
            </Button>
          </div>
          {!urlValid ? (
            <p className="text-[11.5px] leading-snug text-destructive">Enter a valid http(s) URL.</p>
          ) : testState === 'sent' ? (
            <p className="text-[11.5px] leading-snug text-muted-foreground">Test delivered.</p>
          ) : testState === 'failed' ? (
            <p className="text-[11.5px] leading-snug text-destructive">Test failed. Check the URL and try again.</p>
          ) : (
            <p className="text-[11.5px] leading-snug text-muted-foreground">
              Alerts are POSTed as JSON and never block checks.
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
