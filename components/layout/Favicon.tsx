import { useState } from 'react';
import { Globe } from 'lucide-react';
import { faviconUrl, fallbackFaviconUrl } from '@/lib/favicon';
import { cn } from '@/lib/utils';

interface FaviconProps {
  url: string;
  size?: number;
  className?: string;
}

/**
 * A site's favicon, sized for inline use next to a monitor's name.
 * Tries Chrome's local favicon cache first (instant, works offline),
 * then a public favicon lookup by domain (covers pages the local
 * cache has no entry for), and only falls back to a generic globe
 * glyph if both fail - a new site, a `file://` page, or a host page
 * whose CSP blocks the second request.
 */
export function Favicon({ url, size = 14, className }: FaviconProps) {
  const [source, setSource] = useState<'primary' | 'fallback' | 'failed'>('primary');

  if (source === 'failed') {
    return (
      <Globe
        className={cn('shrink-0 text-muted-foreground', className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  const src =
    source === 'primary' ? faviconUrl(url, size * 2) : fallbackFaviconUrl(url, size * 2);

  // No parseable domain to fall back to - straight to the glyph.
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
      key={`${url}-${source}`}
      src={src}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 rounded-[3px] object-contain', className)}
      style={{ width: size, height: size }}
      onError={() => setSource((current) => (current === 'primary' ? 'fallback' : 'failed'))}
    />
  );
}
