import { sendMessage, withTimeout, type ResolvedFaviconResult } from '@/lib/messaging';

const MESSAGE_TIMEOUT_MS = 6_000;
const SAFE_IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i;

const clientResolvedCache = new Map<string, ResolvedFaviconResult>();
const clientInFlight = new Map<string, Promise<ResolvedFaviconResult | null>>();

export function isSafeFaviconDataUrl(src: unknown): src is string {
  return typeof src === 'string' && SAFE_IMAGE_DATA_URL_RE.test(src);
}

function normalizeHttpPageUrl(pageUrl: string): URL | null {
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
  } catch {
    // Invalid URL
  }
  return null;
}

export function getCachedSiteFavicon(pageUrl: string): ResolvedFaviconResult | null {
  const parsed = normalizeHttpPageUrl(pageUrl);
  if (!parsed) return { kind: 'none', src: null };
  return clientResolvedCache.get(parsed.origin) ?? null;
}

/**
 * Content-script / UI helper that requests background favicon resolution
 * with in-memory deduplication and caching. Returns `null` if background
 * messaging is unavailable (e.g. non-background test environments).
 */
export async function resolveSiteFavicon(
  pageUrl: string,
  size = 32,
): Promise<ResolvedFaviconResult | null> {
  const parsed = normalizeHttpPageUrl(pageUrl);
  if (!parsed) return { kind: 'none', src: null };

  const key = parsed.origin;
  const cached = clientResolvedCache.get(key);
  if (cached) return cached;

  const pending = clientInFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<ResolvedFaviconResult | null> => {
    try {
      const result = await withTimeout(
        sendMessage('resolveFavicon', { url: parsed.href, size }),
        MESSAGE_TIMEOUT_MS,
      );
      if (result?.kind === 'data' && isSafeFaviconDataUrl(result.src)) {
        const safe: ResolvedFaviconResult = { kind: 'data', src: result.src };
        clientResolvedCache.set(key, safe);
        return safe;
      }
      if (result?.kind === 'none') {
        return { kind: 'none', src: null };
      }
      return null;
    } catch {
      return null;
    } finally {
      clientInFlight.delete(key);
    }
  })();

  clientInFlight.set(key, task);
  return task;
}

export function resetFaviconCacheForTesting(): void {
  clientResolvedCache.clear();
  clientInFlight.clear();
}
