import { useEffect, useMemo, useState } from 'react';
import { SettingActionRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/button';
import { useStorage } from '@/hooks/useStorage';
import { sendMessage } from '@/lib/messaging';
import { requestOriginPermission } from '@/lib/permissions';
import { monitorsItem } from '@/lib/storage/items';

/**
 * Site access recovery, rendered in the options page. Lists the distinct
 * monitored origins the extension currently cannot check, each with a
 * "Grant access" button that calls the existing `requestOriginPermission`
 * directly: an options-page click is a genuine user gesture, which is
 * exactly what `chrome.permissions.request()` needs (a panel content
 * script or the background worker cannot ask). Only the specific
 * origin is ever requested, never a broad pattern. After a grant the
 * statuses are re-checked so the UI reflects recovery immediately.
 */
export function SiteAccessSection({ standalone = true }: { standalone?: boolean } = {}) {
  const [monitors] = useStorage(monitorsItem);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState(false);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const origins = useMemo(() => {
    const seen = new Map<string, string>();
    for (const monitor of monitors) {
      try {
        const url = new URL(monitor.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (!seen.has(url.origin)) seen.set(url.origin, `${url.origin}/`);
      } catch {
        // Unparseable monitor URL - nothing grantable; skip it.
      }
    }
    return [...seen];
  }, [monitors]);
  const originsKey = origins.map(([origin]) => origin).join(',');

  useEffect(() => {
    if (origins.length === 0) return;
    let cancelled = false;
    setChecked(false);
    async function refresh() {
      try {
        const result = await sendMessage('checkOriginPermissions', origins.map(([, url]) => url));
        if (!cancelled) {
          const next: Record<string, boolean> = {};
          for (const [origin, url] of origins) next[origin] = result[url] ?? false;
          setGranted(next);
        }
      } catch {
        if (!cancelled) setGranted({});
      } finally {
        if (!cancelled) setChecked(true);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [originsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGrant(origin: string, url: string) {
    if (pendingOrigin) return;
    setPendingOrigin(origin);
    setError(null);
    try {
      // Called synchronously from this click handler (awaited, but the
      // request itself is issued in the gesture) so the native prompt
      // is allowed - same function the toolbar flow uses.
      const result = await requestOriginPermission(url);
      if (result.ok && result.value) {
        const refreshed = await sendMessage('checkOriginPermissions', origins.map(([, u]) => u)).catch(
          () => null,
        );
        if (refreshed) {
          const next: Record<string, boolean> = {};
          for (const [o, u] of origins) next[o] = refreshed[u] ?? (o === origin ? true : false);
          setGranted(next);
        } else {
          setGranted((prev) => ({ ...prev, [origin]: true }));
        }
      } else if (result.ok) {
        setError(`Access to ${origin} was not granted. You can try again.`);
      } else {
        setError(result.error.toDisplayMessage());
      }
    } finally {
      setPendingOrigin(null);
    }
  }

  const revoked = checked ? origins.filter(([origin]) => granted[origin] === false) : [];

  const inner = (
    <>
      {origins.length === 0 ? (
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <span className="text-[13px] text-foreground">Site permissions</span>
          <span className="text-xs text-muted-foreground">Granted per site</span>
        </div>
      ) : !checked ? (
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <span className="text-[13px] text-foreground">Site permissions</span>
          <span className="text-xs text-muted-foreground">Checking…</span>
        </div>
      ) : revoked.length === 0 ? (
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <span className="text-[13px] text-foreground">Site permissions</span>
          <span className="text-xs text-muted-foreground">All active ({origins.length})</span>
        </div>
      ) : (
        revoked.map(([origin, url]) => (
          <SettingActionRow
            key={origin}
            label={new URL(origin).hostname}
            description="Checks are paused until access is granted again."
            action={
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs font-normal"
                aria-label={`Grant access to ${new URL(origin).hostname}`}
                disabled={pendingOrigin !== null}
                onClick={() => handleGrant(origin, url)}
              >
                {pendingOrigin === origin ? 'Requesting…' : 'Grant access'}
              </Button>
            }
          />
        ))
      )}
      {error && (
        <p role="alert" className="border-t border-border/50 px-3.5 py-2 text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}
    </>
  );

  if (!standalone) {
    return inner;
  }

  return (
    <SettingsSection title="Site access">
      {inner}
    </SettingsSection>
  );
}
