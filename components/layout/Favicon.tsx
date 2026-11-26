import { useState } from 'react';
import { Globe } from 'lucide-react';
import { faviconUrl } from '@/lib/favicon';
import { cn } from '@/lib/utils';

interface FaviconProps {
  url: string;
  size?: number;
  className?: string;
}

/**
 * A site's favicon, sized for inline use next to a monitor's name.
 * Uses Chrome's local favicon cache (instant, offline, zero network
 * requests) and falls back directly to a generic globe glyph if the
 * cache has no entry or cannot load it.
 */
export function Favicon({ url, size = 14, className }: FaviconProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === url;

  let src: string | null = null;
  if (!failed) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        src = faviconUrl(url, size * 2);
      }
    } catch {
      src = null;
    }
  }

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
      key={url}
      src={src}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 rounded-[3px] object-contain', className)}
      style={{ width: size, height: size }}
      onError={() => setFailedUrl(url)}
    />
  );
}
