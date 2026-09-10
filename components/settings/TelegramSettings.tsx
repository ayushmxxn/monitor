import { useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildTelegramMessage,
  isValidTelegramBotToken,
  isValidTelegramChatId,
  testTelegramDelivery,
} from '@/lib/monitors/telegram';
import type { AppSettings } from '@/lib/storage';

interface TelegramSettingsProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void | Promise<unknown>;
  disabled?: boolean;
  idPrefix: string;
}

/**
 * Telegram bot alert settings, mirroring `WebhookSettings`/
 * `DiscordSettings` so all surfaces stay identical. Toggle + bot token
 * (masked) + chat ID + best-effort test POST; delivery itself lives in
 * `lib/monitors/telegram.ts` and is fanned out from the existing
 * `notifyChange` alert path.
 */
export function TelegramSettings({ settings, onChange, disabled, idPrefix }: TelegramSettingsProps) {
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const tokenValid = !settings.telegramBotToken.trim() || isValidTelegramBotToken(settings.telegramBotToken);
  const chatIdValid = !settings.telegramChatId.trim() || isValidTelegramChatId(settings.telegramChatId);
  const canTest =
    isValidTelegramBotToken(settings.telegramBotToken) && isValidTelegramChatId(settings.telegramChatId);

  async function handleTest() {
    if (!canTest || testState === 'sending') return;
    setTestState('sending');
    const text = buildTelegramMessage(
      { id: 'test', name: 'Monitor test', url: 'https://example.com' } as Parameters<
        typeof buildTelegramMessage
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
    );
    const ok = await testTelegramDelivery(settings.telegramBotToken, settings.telegramChatId, text);
    setTestState(ok ? 'sent' : 'failed');
  }

  return (
    <SettingsSection title="Telegram">
      <SettingRow
        id={`${idPrefix}-telegram-enabled`}
        label="Telegram alerts"
        description="Send monitor alerts to a Telegram chat via your bot."
        checked={settings.telegramEnabled}
        disabled={disabled}
        onCheckedChange={(checked) => {
          setTestState('idle');
          void onChange({ ...settings, telegramEnabled: checked });
        }}
      />
      {settings.telegramEnabled && (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <Label htmlFor={`${idPrefix}-telegram-token`} className="text-[13px] font-normal leading-tight">
            Bot token
          </Label>
          <Input
            id={`${idPrefix}-telegram-token`}
            type="password"
            autoComplete="off"
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            value={settings.telegramBotToken}
            disabled={disabled}
            onChange={(e) => {
              setTestState('idle');
              void onChange({ ...settings, telegramBotToken: e.target.value });
            }}
            className="h-7 text-[12.5px]"
          />
          {!tokenValid && (
            <p className="text-[11.5px] leading-snug text-destructive">Enter a valid bot token.</p>
          )}
          <Label htmlFor={`${idPrefix}-telegram-chat`} className="text-[13px] font-normal leading-tight">
            Chat ID
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-telegram-chat`}
              type="text"
              inputMode="numeric"
              placeholder="-1001234567890"
              value={settings.telegramChatId}
              disabled={disabled}
              onChange={(e) => {
                setTestState('idle');
                void onChange({ ...settings, telegramChatId: e.target.value });
              }}
              className="h-7 text-[12.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={disabled || !canTest || testState === 'sending'}
              onClick={handleTest}
            >
              {testState === 'sending' ? 'Sending…' : 'Test'}
            </Button>
          </div>
          {!chatIdValid ? (
            <p className="text-[11.5px] leading-snug text-destructive">Enter a valid chat ID.</p>
          ) : testState === 'sent' ? (
            <p className="text-[11.5px] leading-snug text-muted-foreground">Test delivered.</p>
          ) : testState === 'failed' ? (
            <p className="text-[11.5px] leading-snug text-destructive">Test failed. Check the credentials and try again.</p>
          ) : (
            <p className="text-[11.5px] leading-snug text-muted-foreground">
              Alerts are sent as bot messages and never block checks.
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
