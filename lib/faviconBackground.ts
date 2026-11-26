import type { ResolvedFaviconResult } from '@/lib/messaging';
import { serializeByKey } from '@/lib/monitors/concurrency';
import { hasOriginPermission } from '@/lib/permissions';
import { faviconsItem, type CachedFaviconEntry } from '@/lib/storage/items';
import { encodeArrayBufferToBase64 } from '@/lib/ui/font';

const FAVICON_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAVICON_NEGATIVE_TTL_MS = 60 * 1000;
const MAX_CACHED_FAVICONS = 64;
const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 150_000;
const DIRECT_FETCH_TIMEOUT_MS = 5_000;
const PLACEHOLDER_PROBE_URL = 'https://favicon-miss.monitor.invalid/';

export function faviconUrl(pageUrl: string, size = 32): string {
  const url = new URL(`chrome-extension://${browser.runtime.id}/_favicon/`);
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const placeholderBytesBySize = new Map<number, Uint8Array | null>();
const memoryOriginCache = new Map<string, CachedFaviconEntry>();
const negativeOriginCache = new Map<string, number>();
const inFlightResolutions = new Map<string, Promise<ResolvedFaviconResult>>();
const storageWriteQueues = new Map<string, Promise<unknown>>();

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function fetchChromeFaviconBytes(pageUrl: string, size: number): Promise<Uint8Array | null> {
  try {
    const response = await fetch(faviconUrl(pageUrl, size));
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function getChromePlaceholderBytes(size: number): Promise<Uint8Array | null> {
  if (placeholderBytesBySize.has(size)) {
    return placeholderBytesBySize.get(size) ?? null;
  }
  const bytes = await fetchChromeFaviconBytes(PLACEHOLDER_PROBE_URL, size);
  placeholderBytesBySize.set(size, bytes);
  return bytes;
}

async function resolveFromChromeCache(parsed: URL, size: number): Promise<string | null> {
  const placeholder = await getChromePlaceholderBytes(size);
  if (!placeholder) return null;

  const candidates = [parsed.href];
  const rootUrl = `${parsed.origin}/`;
  if (parsed.href !== rootUrl) {
    candidates.push(rootUrl);
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(faviconUrl(candidate, size));
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) continue;
      const bytes = new Uint8Array(buffer);
      if (bytesEqual(bytes, placeholder)) continue;
      const mime = inferImageMime(response.headers?.get('content-type') ?? null, candidate, bytes) ?? 'image/png';
      return `data:${mime};base64,${encodeArrayBufferToBase64(buffer)}`;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function getAttr(tag: string, name: string): string | null {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const match = regex.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/**
 * Extracts same-origin favicon candidates from HTML `<link>` tags,
 * prioritized before falling back to `${origin}/favicon.ico`.
 */
export function extractSameOriginFaviconCandidates(html: string, baseUrl: string): string[] {
  const base = normalizeHttpPageUrl(baseUrl);
  if (!base) return [];

  const prioritized: Array<{ url: string; priority: number }> = [];
  const seen = new Set<string>();
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of linkTags) {
    const rel = (getAttr(tag, 'rel') ?? '').toLowerCase();
    const href = getAttr(tag, 'href')?.trim();
    if (!href || !rel) continue;

    const tokens = rel.split(/\s+/);
    const isIcon = tokens.includes('icon') || rel === 'shortcut icon' || rel === 'apple-touch-icon' || rel === 'fluid-icon';
    if (!isIcon || tokens.includes('mask-icon')) continue;

    try {
      const resolved = new URL(href, base.href);
      if (resolved.origin !== base.origin) continue;
      if (seen.has(resolved.href)) continue;
      seen.add(resolved.href);

      let priority = 3;
      if (tokens.includes('icon')) priority = 1;
      else if (rel.includes('shortcut')) priority = 2;
      prioritized.push({ url: resolved.href, priority });
    } catch {
      // Ignore malformed href
    }
  }

  prioritized.sort((a, b) => a.priority - b.priority);
  const candidates = prioritized.map((item) => item.url);

  const rootIco = `${base.origin}/favicon.ico`;
  if (!seen.has(rootIco)) {
    candidates.push(rootIco);
  }
  return candidates;
}

function inferImageMime(contentType: string | null, iconUrl: string, bytes: Uint8Array): string | null {
  const normalizedType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ALLOWED_IMAGE_MIMES.has(normalizedType)) {
    return normalizedType;
  }
  if (
    normalizedType &&
    normalizedType !== 'application/octet-stream' &&
    normalizedType !== 'binary/octet-stream'
  ) {
    return null;
  }

  if (bytes.byteLength >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  }

  const lowerUrl = iconUrl.toLowerCase();
  if (lowerUrl.endsWith('.ico')) return 'image/x-icon';
  if (lowerUrl.endsWith('.png')) return 'image/png';
  if (lowerUrl.endsWith('.svg')) return 'image/svg+xml';
  return null;
}

function isSameOriginResponse(response: Response, expectedOrigin: string): boolean {
  if (!response.url) return true;
  try {
    return new URL(response.url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const rawLength = response.headers?.get?.('content-length');
  const contentLength = rawLength ? Number(rawLength) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;
    return new Uint8Array(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: accept },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function tryFetchIconDataUrl(iconUrl: string, expectedOrigin: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(iconUrl, 'image/*,*/*;q=0.8');
    if (!response.ok || !isSameOriginResponse(response, expectedOrigin)) {
      await response.body?.cancel?.().catch(() => {});
      return null;
    }
    const bytes = await readBoundedBytes(response, MAX_FAVICON_BYTES);
    if (!bytes) return null;
    const mime = inferImageMime(response.headers?.get('content-type') ?? null, iconUrl, bytes);
    if (!mime) return null;
    return `data:${mime};base64,${encodeArrayBufferToBase64(bytes.buffer as ArrayBuffer)}`;
  } catch {
    return null;
  }
}

async function fetchSiteFaviconDirectly(parsed: URL): Promise<string | null> {
  const permission = await hasOriginPermission(parsed.href);
  if (!permission.ok || !permission.value) {
    return null;
  }

  const directRootIco = await tryFetchIconDataUrl(`${parsed.origin}/favicon.ico`, parsed.origin);
  if (directRootIco) {
    return directRootIco;
  }

  for (const pageCandidate of [parsed.href, `${parsed.origin}/`]) {
    try {
      const response = await fetchWithTimeout(pageCandidate, 'text/html,application/xhtml+xml');
      if (!response.ok || !isSameOriginResponse(response, parsed.origin)) {
        await response.body?.cancel?.().catch(() => {});
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !contentType.toLowerCase().includes('html')) {
        await response.body?.cancel?.().catch(() => {});
        continue;
      }
      const html = (await response.text()).slice(0, MAX_HTML_BYTES);
      const iconUrls = extractSameOriginFaviconCandidates(html, response.url || pageCandidate);
      for (const iconUrl of iconUrls) {
        if (iconUrl === `${parsed.origin}/favicon.ico`) continue;
        const dataUrl = await tryFetchIconDataUrl(iconUrl, parsed.origin);
        if (dataUrl) return dataUrl;
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

async function readCachedFavicon(origin: string): Promise<string | null> {
  const now = Date.now();
  const mem = memoryOriginCache.get(origin);
  if (mem && now - mem.cachedAt < FAVICON_CACHE_TTL_MS) {
    return mem.dataUrl;
  }

  try {
    const all = await faviconsItem.getValue();
    const entry = all?.[origin];
    if (entry && typeof entry.dataUrl === 'string' && now - entry.cachedAt < FAVICON_CACHE_TTL_MS) {
      memoryOriginCache.set(origin, entry);
      return entry.dataUrl;
    }
  } catch {
    // Ignore storage read error
  }
  return null;
}

async function writeCachedFavicon(origin: string, dataUrl: string): Promise<void> {
  const entry: CachedFaviconEntry = { dataUrl, cachedAt: Date.now() };
  memoryOriginCache.set(origin, entry);

  await serializeByKey(storageWriteQueues, 'favicons', async () => {
    try {
      const current = (await faviconsItem.getValue()) ?? {};
      const now = Date.now();
      const pruned = Object.entries(current)
        .filter(([key, val]) => key !== origin && val && now - val.cachedAt < FAVICON_CACHE_TTL_MS)
        .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
        .slice(0, MAX_CACHED_FAVICONS - 1);

      const next: Record<string, CachedFaviconEntry> = Object.fromEntries(pruned);
      next[origin] = entry;
      await faviconsItem.setValue(next);
    } catch {
      // Best-effort cache write
    }
  });
}

/**
 * Background-side favicon resolution. Uses Chrome's local `_favicon/`
 * cache when it holds a real site icon, otherwise checks the local
 * extension cache or fetches the website's own icon directly (when
 * origin permission is granted) and caches it locally.
 */
export async function resolveSiteFaviconInBackground(
  pageUrl: string,
  size = 32,
): Promise<ResolvedFaviconResult> {
  const parsed = normalizeHttpPageUrl(pageUrl);
  if (!parsed) {
    return { kind: 'none', src: null };
  }

  const key = parsed.origin;
  const existing = inFlightResolutions.get(key);
  if (existing) {
    return existing;
  }

  const task = (async (): Promise<ResolvedFaviconResult> => {
    const chromeCachedDataUrl = await resolveFromChromeCache(parsed, size);
    if (chromeCachedDataUrl) {
      return { kind: 'data', src: chromeCachedDataUrl };
    }

    const stored = await readCachedFavicon(parsed.origin);
    if (stored) {
      return { kind: 'data', src: stored };
    }

    const negUntil = negativeOriginCache.get(parsed.origin);
    if (negUntil && Date.now() < negUntil) {
      return { kind: 'none', src: null };
    }

    const fetched = await fetchSiteFaviconDirectly(parsed);
    if (fetched) {
      negativeOriginCache.delete(parsed.origin);
      await writeCachedFavicon(parsed.origin, fetched);
      return { kind: 'data', src: fetched };
    }

    negativeOriginCache.set(parsed.origin, Date.now() + FAVICON_NEGATIVE_TTL_MS);
    return { kind: 'none', src: null };
  })().finally(() => {
    inFlightResolutions.delete(key);
  });

  inFlightResolutions.set(key, task);
  return task;
}

export function resetBackgroundFaviconCacheForTesting(): void {
  placeholderBytesBySize.clear();
  memoryOriginCache.clear();
  negativeOriginCache.clear();
  inFlightResolutions.clear();
}
