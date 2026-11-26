import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import {
  getCachedSiteFavicon,
  isSafeFaviconDataUrl,
  resolveSiteFavicon,
} from '@/lib/favicon';
import type { ResolvedFaviconResult } from '@/lib/messaging';
import { cn } from '@/lib/utils';

interface FaviconProps {
  url: string;
  size?: number;
  className?: string;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A site's favicon, sized for inline use next to a monitor's name.
 * Resolves via the background worker (Chrome's local `_favicon/` cache
 * first, then direct same-origin retrieval cached locally) so content
 * scripts render a safe data URL without triggering cross-frame
 * `chrome-extension://` load warnings, using a generic globe glyph
 * only as a last resort.
 */
export function Favicon({ url, size = 14, className }: FaviconProps) {
  const validHttp = isHttpUrl(url);
  const cached = validHttp ? getCachedSiteFavicon(url) : null;
  const [resolved, setResolved] = useState<(ResolvedFaviconResult & { forUrl: string }) | null>(() =>
    cached ? { forUrl: url, ...cached } : null,
  );
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!validHttp) return;
    const hit = getCachedSiteFavicon(url);
    if (hit) {
      setResolved({ forUrl: url, ...hit });
      return;
    }
    let cancelled = false;
    void resolveSiteFavicon(url, Math.max(32, size * 2)).then((result) => {
      if (!cancelled && result) {
        setResolved({ forUrl: url, ...result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url, size, validHttp]);

  const active = resolved?.forUrl === url ? resolved : cached;
  const src =
    validHttp &&
    active &&
    active.kind === 'data' &&
    isSafeFaviconDataUrl(active.src) &&
    failedSrc !== active.src
      ? active.src
      : null;

  if (!src) {
    return (
      <Globe
        className={cn('shrink-0 text-muted-foreground', className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <img
      key={`${url}-${src}`}
      src={src}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 rounded-[3px] object-contain', className)}
      style={{ width: size, height: size }}
      onError={() => setFailedSrc(src)}
    />
  );
}
