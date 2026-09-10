import { isValidWebhookUrl, postWebhookAlert, type WebhookAlertPayload } from './webhook';
import { isValidDiscordWebhookUrl, postDiscordAlert, type DiscordWebhookPayload } from './discord';
import {
  isValidTelegramBotToken,
  isValidTelegramChatId,
  sendTelegramAlert,
} from './telegram';

export interface TestDeliveryInput {
  kind: 'generic' | 'discord' | 'telegram';
  url: string;
  payload: WebhookAlertPayload | DiscordWebhookPayload | string;
  botToken?: string;
  chatId?: string;
}

/**
 * Delivers one test alert from the background worker - the same context
 * real alerts post from. Test buttons must not POST from the panel
 * content script: that fetch runs under the page's origin and CSP, so
 * strict pages (dashboards especially) block it and a valid URL reports
 * "failed". Never throws: every failure path resolves to `false`.
 */
export async function deliverTestAlert(input: TestDeliveryInput): Promise<boolean> {
  try {
    if (input.kind === 'discord') {
      if (!isValidDiscordWebhookUrl(input.url)) return false;
      return await postDiscordAlert(input.url, input.payload as DiscordWebhookPayload);
    }
    if (input.kind === 'telegram') {
      if (
        !isValidTelegramBotToken(input.botToken ?? '') ||
        !isValidTelegramChatId(input.chatId ?? '') ||
        typeof input.payload !== 'string'
      ) {
        return false;
      }
      return await sendTelegramAlert(input.botToken as string, input.chatId as string, input.payload);
    }
    if (!isValidWebhookUrl(input.url)) return false;
    return await postWebhookAlert(input.url, input.payload as WebhookAlertPayload);
  } catch {
    return false;
  }
}
