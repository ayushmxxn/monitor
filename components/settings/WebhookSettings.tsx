import { useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildWebhookPayload, isValidWebhookUrl, testWebhookDelivery } from '@/lib/monitors/webhook';
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
    const ok = await testWebhookDelivery(settings.webhookUrl, payload);
    setTestState(ok ? 'sent' : 'failed');
  }

  return (
    <div>
      <SettingRow
        id={`${idPrefix}-webhook-enabled`}
        label="Custom webhook"
        checked={settings.webhookEnabled}
        disabled={disabled}
        onCheckedChange={(checked) => {
          setTestState('idle');
          void onChange({ ...settings, webhookEnabled: checked });
        }}
      />
      {settings.webhookEnabled && (
        <div className="flex flex-col gap-2 border-t border-border/50 bg-muted/20 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-webhook-url`}
              type="url"
              inputMode="url"
              placeholder="Webhook URL (https://...)"
              value={settings.webhookUrl}
              disabled={disabled}
              onChange={(e) => {
                setTestState('idle');
                void onChange({ ...settings, webhookUrl: e.target.value });
              }}
              className="h-7 bg-background text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2.5 text-xs font-normal"
              disabled={disabled || !isValidWebhookUrl(settings.webhookUrl) || testState === 'sending'}
              onClick={handleTest}
            >
              {testState === 'sending' ? 'Sending…' : testState === 'sent' ? 'Sent ✓' : 'Test'}
            </Button>
          </div>
          {!urlValid ? (
            <p className="text-[11px] text-destructive">Enter a valid http(s) URL.</p>
          ) : testState === 'sent' ? (
            <p className="text-[11px] text-muted-foreground">Test alert delivered successfully.</p>
          ) : testState === 'failed' ? (
            <p className="text-[11px] text-destructive">Delivery failed. Check the endpoint URL.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
