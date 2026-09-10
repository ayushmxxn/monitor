import { isValidWebhookUrl, postWebhookAlert, type WebhookAlertPayload } from './webhook';
import { isValidDiscordWebhookUrl, postDiscordAlert, type DiscordWebhookPayload } from './discord';

export interface TestDeliveryInput {
  kind: 'generic' | 'discord';
  url: string;
  payload: WebhookAlertPayload | DiscordWebhookPayload;
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
    if (!isValidWebhookUrl(input.url)) return false;
    return await postWebhookAlert(input.url, input.payload as WebhookAlertPayload);
  } catch {
    return false;
  }
}
