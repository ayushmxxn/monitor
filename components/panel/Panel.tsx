import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Globe,
  Link2,
  Loader2,
  MousePointerClick,
  RefreshCw,
  RotateCw,
  Settings2,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/layout/EmptyState';
import { Favicon } from '@/components/layout/Favicon';
import { MonitorList } from '@/components/monitors/MonitorList';
import { MonitorListSkeleton } from '@/components/monitors/MonitorListSkeleton';
import { MonitorDetail } from '@/components/monitors/MonitorDetail';
import { InlineNotice } from '@/components/layout/InlineNotice';
import { CreatorCredit } from '@/components/layout/CreatorCredit';
import { PanelSettings } from '@/components/panel/PanelSettings';
import { useMonitors } from '@/hooks/useMonitors';
import { useElementPicker } from '@/hooks/useElementPicker';
import { useStorage } from '@/hooks/useStorage';
import { usePageAccess } from '@/hooks/usePageAccess';
import { useExtensionInvalidated } from '@/hooks/useExtensionInvalidated';
import { useAppInfo } from '@/hooks/useAppInfo';
import { checkAllMonitorsNow } from '@/lib/monitors/client';
import { panelWidthItem, settingsItem } from '@/lib/storage/items';
import { PortalContainerContext } from '@/lib/portalContainer';
import { ConfettiBurst, type ConfettiBurstHandle } from '@/components/ui/ConfettiBurst';
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/lib/constants';

export interface PanelHandle {
  toggle: () => void;
}

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The panel injected onto the page by entrypoints/panel.content.tsx.
 * Deliberately NOT chrome.sidePanel - this is a plain fixed-position
 * element inside our own shadow root, so it works the same way in every
 * Chromium/Firefox build and can overlay page content instead of
 * claiming a slice of the browser's own window chrome.
 *
 * Visibility is a local `isOpen` boolean, not a mount/unmount - the
 * content script only ever creates one of these per page load and
 * flips this flag via the imperative handle from then on (see
 * `window.__monitorPanel` in panel.content.tsx), so reopening the panel
 * is a CSS transform, not a remount, re-fetch, or animation restart.
 */
export interface PanelProps {
  /**
   * The shadow host element created by `createShadowRootUi` (see
   * entrypoints/panel.content.tsx). Passed down so `PanelContent` can
   * tell a click landing inside the panel apart from one landing
   * anywhere else on the page - see the click-outside handling below
   * for why a plain DOM `contains()` check on an in-shadow-root node
   * doesn't work for that.
   */
  shadowHost: HTMLElement;
  /**
   * The root container inside the shadow root (the shadow body).
   * Provided so portaled elements (like dialogs) have a guaranteed target
   * inside the shadow tree immediately on mount.
   */
  shadowContainer?: HTMLElement;
}

export const Panel = forwardRef<PanelHandle, PanelProps>(function Panel(
  { shadowHost, shadowContainer },
  ref,
) {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    document.documentElement.dataset.monitorPanelOpen = String(isOpen);
    return () => {
      delete document.documentElement.dataset.monitorPanelOpen;
    };
  }, [isOpen]);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => setIsOpen((open) => !open),
    }),
    [],
  );

  const handleClose = useCallback(() => setIsOpen(false), []);
  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <ErrorBoundary scope="panel">
      <PanelContent
        isOpen={isOpen}
        onClose={handleClose}
        onOpen={handleOpen}
        shadowHost={shadowHost}
        shadowContainer={shadowContainer}
      />
    </ErrorBoundary>
  );
});

export function getMonitorHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function deriveSources(monitors: { url: string }[]): string[] {
  const hostnames = new Set<string>();
  for (const monitor of monitors) {
    const host = getMonitorHostname(monitor.url);
    if (host) hostnames.add(host);
  }
  return Array.from(hostnames).sort((a, b) => a.localeCompare(b));
}

export function filterMonitorsBySource<T extends { url: string }>(
  monitors: T[],
  source: string,
): T[] {
  if (source === 'all') return monitors;
  return monitors.filter((m) => getMonitorHostname(m.url) === source);
}

interface SourceFilterDropdownProps {
  sources: string[];
  selectedSource: string;
  onSelect: (source: string) => void;
  monitors: { url: string }[];
  containerEl: HTMLElement | null;
}

const SourceFilterDropdown = memo(function SourceFilterDropdown({
  sources,
  selectedSource,
  onSelect,
  monitors,
  containerEl,
}: SourceFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(e: Event) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }

    const target = containerEl ?? document;
    target.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      target.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, containerEl]);

  const allOptionValues = useMemo(() => {
    if (selectedSource !== 'all' && !sources.includes(selectedSource)) {
      return [...sources, selectedSource];
    }
    return sources;
  }, [sources, selectedSource]);

  const selectedSourceUrl = useMemo(() => {
    if (selectedSource === 'all') return '';
    const match = monitors.find((m) => getMonitorHostname(m.url) === selectedSource);
    return match ? match.url : `https://${selectedSource}`;
  }, [monitors, selectedSource]);

  return (
    <div ref={dropdownRef} className="relative flex items-center shrink-0 text-left">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Filter by source"
        disabled={sources.length === 0 && selectedSource === 'all'}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
          isOpen && 'bg-muted/40 text-foreground',
        )}
      >
        {selectedSource === 'all' ? (
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <Favicon url={selectedSourceUrl} size={12} className="shrink-0" />
        )}
        <span className="max-w-[120px] truncate">
          {selectedSource === 'all' ? 'All' : selectedSource}
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 text-muted-foreground transition-transform duration-150',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label="Source filter options"
          className="absolute bottom-full right-0 z-50 mb-1.5 min-w-[140px] max-w-[220px] rounded-md border border-border bg-popover p-1 shadow-lg animate-enter-up"
        >
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            <button
              type="button"
              role="option"
              aria-selected={selectedSource === 'all'}
              onClick={() => {
                onSelect('all');
                setIsOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors',
                selectedSource === 'all'
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">All</span>
              {selectedSource === 'all' && (
                <Check className="h-3 w-3 shrink-0 text-foreground" />
              )}
            </button>

            {allOptionValues.map((source) => {
              const match = monitors.find((m) => getMonitorHostname(m.url) === source);
              const sourceUrl = match ? match.url : `https://${source}`;

              return (
                <button
                  key={source}
                  type="button"
                  role="option"
                  aria-selected={selectedSource === source}
                  onClick={() => {
                    onSelect(source);
                    setIsOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors',
                    selectedSource === source
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Favicon url={sourceUrl} size={13} className="shrink-0" />
                  <span className="flex-1 truncate">{source}</span>
                  {selectedSource === source && (
                    <Check className="h-3 w-3 shrink-0 text-foreground" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

type PanelView = 'monitors' | 'settings' | 'detail';

function PanelContent({
  isOpen,
  onClose,
  onOpen,
  shadowHost,
  shadowContainer,
}: {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  shadowHost: HTMLElement;
  shadowContainer?: HTMLElement;
}) {
  const { monitors, isLoading, error, remove } = useMonitors();
  const isInvalidated = useExtensionInvalidated();
  const { appInfo } = useAppInfo();
  const [settings] = useStorage(settingsItem);
  // Reopens the panel - with the same slide-in transform used for
  // every other open/close here, so it's one consistent animation, not
  // a special case - the instant a pick is actually saved. The panel
  // closed itself to get out of the way the moment picking started
  // (see handleStartPicker below); without this, saving would leave
  // the user looking at a bare page with no on-screen confirmation
  // that anything happened until they went and reopened it themselves.
  const confettiRef = useRef<ConfettiBurstHandle | null>(null);
  const pendingFirstCheckIdsRef = useRef<Set<string>>(new Set());

  const handlePickerFinished = useCallback(
    (result?: { saved: boolean; monitorName: string | null; monitorId?: string | null }) => {
      onOpen();
      if (result?.saved) {
        if (result.monitorId) {
          const currentMonitor = monitors.find((m) => m.id === result.monitorId);
          if (currentMonitor && currentMonitor.lastValue !== null && currentMonitor.lastStatus !== 'error') {
            confettiRef.current?.burst();
          } else {
            pendingFirstCheckIdsRef.current.add(result.monitorId);
          }
        }
      }
    },
    [onOpen, monitors],
  );
  const picker = useElementPicker(handlePickerFinished);

  // Confetti trigger: ONLY when a newly created monitor successfully completes
  // its first check and the actual value becomes visible.
  useEffect(() => {
    if (isLoading || pendingFirstCheckIdsRef.current.size === 0) return;

    for (const monitor of monitors) {
      if (pendingFirstCheckIdsRef.current.has(monitor.id)) {
        if (monitor.lastValue !== null && monitor.lastStatus !== 'error') {
          pendingFirstCheckIdsRef.current.delete(monitor.id);
          confettiRef.current?.burst();
        } else if (monitor.lastStatus === 'error') {
          pendingFirstCheckIdsRef.current.delete(monitor.id);
        }
      }
    }
  }, [monitors, isLoading]);
  const { state: pageAccess, retry: retryPageAccess } = usePageAccess();
  const [view, setView] = useState<PanelView>('monitors');
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>('all');
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const sources = useMemo(() => deriveSources(monitors), [monitors]);
  const filteredMonitors = useMemo(
    () => filterMonitorsBySource(monitors, selectedSource),
    [monitors, selectedSource],
  );

  const selectedMonitor = selectedMonitorId
    ? (monitors.find((m) => m.id === selectedMonitorId) ?? null)
    : null;

  const openDetail = useCallback((id: string) => {
    setSelectedMonitorId(id);
    setView('detail');
  }, []);

  const backToList = useCallback(() => {
    setView('monitors');
    setSelectedMonitorId(null);
  }, []);

  // Persisted width (survives reloads/new tabs) vs. live width (updated
  // every pointer-move during a drag). Keeping these separate means a
  // resize never writes to storage more than once, on release - writing
  // on every pixel of movement would spam `chrome.storage` and add
  // jitter to the drag itself.
  const [storedWidth, setStoredWidth] = useStorage(panelWidthItem);
  const [liveWidth, setLiveWidth] = useState(storedWidth);
  const isDragging = useRef(false);

  // The panel's own root node - `position: fixed` and sized to the
  // popup, not the viewport, so it's already a valid containing block
  // for `position: absolute` descendants. Handed out via context so
  // any Dialog rendered under this tree portals its content in here
  // instead of onto `document.body` (see lib/portalContainer.tsx). A
  // state setter, not a plain ref, because the provider below needs a
  // render to actually pick up the node once it exists.
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isDragging.current) setLiveWidth(storedWidth);
  }, [storedWidth]);

  // Closes the panel on a click anywhere outside it - but not while
  // the user is actively picking an element on the page (the panel
  // already closes itself for that, see handleStartPicker below, so
  // this mainly guards against re-closing-what's-already-closed) or
  // mid-resize-drag, where the pointer is deliberately outside the
  // panel's own box while still interacting with it.
  //
  // Listens on `pointerdown` (not `click`) so this reacts before
  // whatever the host page does with the same click, and reads
  // `event.composedPath()` rather than checking `panelEl.contains(...)`
  // against `event.target`: the panel lives in a `mode: 'closed'`
  // shadow root (see panel.content.tsx), so a listener outside that
  // root - which this one, on `document`, necessarily is - only ever
  // sees `event.target` retargeted to the shadow host itself, never
  // the actual node inside. `composedPath()` has the same closed-root
  // limit, but it still includes the host, so checking for that is
  // enough to tell "inside the panel" apart from "elsewhere on the
  // page" without needing to see any deeper than that.
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (picker.state !== 'idle') return;
      if (isDragging.current) return;
      const path = event.composedPath();
      if (path.includes(shadowHost)) return;
      onClose();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, onClose, picker.state, shadowHost]);

  async function handleRefreshAll() {
    if (isInvalidated) return;
    setIsRefreshingAll(true);
    setRefreshError(null);
    const result = await checkAllMonitorsNow();
    if (!result.ok) setRefreshError(result.error.toDisplayMessage());
    setIsRefreshingAll(false);
  }

  // Picker mode plays out directly on the page - highlighting and a
  // hover tooltip near the cursor - so the panel has to get off the
  // page the instant picker mode starts, not just once a pick lands.
  // Closing (rather than unmounting) keeps this a plain CSS transform,
  // consistent with every other open/close in the panel.
  function handleStartPicker() {
    onClose();
    void picker.start();
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    isDragging.current = true;
    const startX = event.clientX;
    const startWidth = liveWidth;
    // These reach outside the shadow root on purpose, onto the real
    // page - the drag needs a cursor/selection lock across the whole
    // viewport, not just the ~2px handle the pointer started on.
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    function widthAt(clientX: number): number {
      // Dragging left (toward the page) grows the panel; the handle
      // sits on its left edge, so moving away from the right edge
      // increases distance-from-right, i.e. width.
      return clamp(startWidth + (startX - clientX), MIN_WIDTH, MAX_WIDTH);
    }

    function onMove(moveEvent: PointerEvent) {
      setLiveWidth(widthAt(moveEvent.clientX));
    }

    function onUp(upEvent: PointerEvent) {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      void setStoredWidth(widthAt(upEvent.clientX));
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  return (
    <PortalContainerContext.Provider value={panelEl ?? shadowContainer ?? null}>
    <div
      ref={setPanelEl}
      style={{
        width: liveWidth,
        fontSize: '16px',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        colorScheme: settings.theme === 'dark' ? 'dark' : 'light',
      }}
      className={cn(
        'pointer-events-auto fixed top-5 bottom-5 right-5 z-[2147483647] flex overflow-hidden rounded-xl font-sans',
        // No `border-l`: the resize handle already renders its own
        // hairline on the left edge (see the separator below), so a
        // full `border` here would double it up as two adjacent lines.
        'border-y border-r border-black/[0.08] dark:border-white/[0.08] bg-background text-foreground',
        'shadow-[0_1px_1px_rgba(0,0,0,0.03),0_12px_28px_-8px_rgba(0,0,0,0.22),0_32px_64px_-24px_rgba(0,0,0,0.28)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_16px_36px_-6px_rgba(0,0,0,0.7),0_32px_64px_-16px_rgba(0,0,0,0.85)]',
        'transition-transform duration-200',
        !isOpen && 'translate-x-[calc(100%+20px)]',
        isDragging.current && 'transition-none',
        settings.theme === 'dark' && 'dark',
      )}
    >
      <ConfettiBurst ref={confettiRef} />
      {/* Resize handle - a hit target along the panel's left edge, kept fully inside the rounded box so it doesn't get clipped. The hairline itself is transparent until hovered so the panel reads as a clean, borderless edge at rest - it only reveals itself as an affordance once the cursor is actually there to use it. */}
      <div
        onPointerDown={handleResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize touch-none transition-colors hover:bg-foreground/10"
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-foreground/25" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3 py-0">
          {view === 'settings' ? (
            <div className="flex min-w-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Back to monitors"
                onClick={() => setView('monitors')}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-[13px] font-semibold tracking-tight">Settings</span>
            </div>
          ) : view === 'detail' ? (
            <div className="flex min-w-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label="Back to monitors"
                onClick={backToList}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="truncate text-[13px] font-semibold tracking-tight">
                {selectedMonitor?.name ?? 'Monitor'}
              </span>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Open settings"
              onClick={() => setView('settings')}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          )}

          <div className="flex items-center gap-1">
            {view === 'monitors' && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Refresh all monitors"
                  onClick={handleRefreshAll}
                  disabled={isRefreshingAll || monitors.length === 0 || isInvalidated}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isRefreshingAll && 'animate-spin')} />
                </Button>
                <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
                <Button
                  size="sm"
                  className="h-7 min-w-[72px] gap-1.5 px-3.5 text-xs"
                  onClick={handleStartPicker}
                  disabled={picker.state !== 'idle' || pageAccess !== 'granted' || isInvalidated}
                >
                  {picker.state === 'starting' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : picker.state === 'waiting' ? (
                    <MousePointerClick className="h-3.5 w-3.5" />
                  ) : null}
                  Add
                </Button>
              </>
            )}
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          {isInvalidated ? (
            // Every other view here relies on chrome.runtime/chrome.storage,
            // which will keep failing the same way until the page reloads -
            // so this replaces the whole body rather than sitting alongside
            // content that would just look broken (empty lists, spinners
            // that never resolve) underneath it.
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <RotateCw className="h-6 w-6 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Monitor was updated</p>
                <p className="max-w-[30ch] text-xs text-muted-foreground">
                  This page needs a refresh to reconnect. Your monitors and their data are safe.
                </p>
              </div>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          ) : view === 'settings' ? (
            <PanelSettings />
          ) : view === 'detail' && selectedMonitorId ? (
            <MonitorDetail monitorId={selectedMonitorId} onDeleted={backToList} />
          ) : (
            <>
              {pageAccess === 'denied' && (
                <InlineNotice tone="info">
                  Monitor doesn't have access to this site yet. Close the panel and click the toolbar
                  icon to grant it, then try Add.
                </InlineNotice>
              )}
              {pageAccess === 'error' && (
                <InlineNotice
                  tone="error"
                  action={
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={retryPageAccess}>
                      Retry
                    </Button>
                  }
                >
                  Couldn't confirm access to this site — the background worker may still be starting.
                </InlineNotice>
              )}
              {picker.state === 'waiting' && (
                <InlineNotice tone="info">
                  Hover a value on the page and click it to save — press Esc to cancel.
                </InlineNotice>
              )}
              {picker.error && <InlineNotice tone="error">{picker.error}</InlineNotice>}
              {refreshError && <InlineNotice tone="error">{refreshError}</InlineNotice>}
              {error && <InlineNotice tone="error">{error.toDisplayMessage()}</InlineNotice>}

              {isLoading ? (
                <MonitorListSkeleton />
              ) : filteredMonitors.length === 0 && monitors.length > 0 ? (
                <EmptyState
                  icon={<Globe className="h-4 w-4 text-muted-foreground" />}
                  title="No monitors found"
                  description={`No monitors matching "${selectedSource}".`}
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setSelectedSource('all')}
                    >
                      Show all monitors
                    </Button>
                  }
                />
              ) : (
                <MonitorList
                  monitors={filteredMonitors}
                  onDelete={remove}
                  onOpen={openDetail}
                  emptyAction={
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleStartPicker}
                      disabled={picker.state !== 'idle' || pageAccess !== 'granted'}
                    >
                      New monitor
                    </Button>
                  }
                />
              )}
            </>
          )}
        </main>

        <footer className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border px-3.5">
          {view === 'detail' && selectedMonitor?.url ? (
            <a
              href={selectedMonitor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[11px] leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Favicon url={selectedMonitor.url} size={11} />
              <span className="truncate">
                {getMonitorHostname(selectedMonitor.url) ?? selectedMonitor.url}
              </span>
              <Link2 className="h-3 w-3 shrink-0 opacity-60" />
            </a>
          ) : (
            <span className="flex min-w-0 items-center truncate text-[11px] leading-none text-muted-foreground">
              {view === 'settings'
                ? `${APP_NAME}${appInfo ? ` v${appInfo.version}` : ''}`
                : view === 'detail'
                  ? 'Monitor detail'
                  : isLoading
                    ? 'Loading…'
                    : `${filteredMonitors.length} monitor${filteredMonitors.length === 1 ? '' : 's'}`}
            </span>
          )}
          {view === 'settings' && <CreatorCredit />}
          {view === 'monitors' && !isLoading && (
            <SourceFilterDropdown
              sources={sources}
              selectedSource={selectedSource}
              onSelect={setSelectedSource}
              monitors={monitors}
              containerEl={panelEl}
            />
          )}
        </footer>
      </div>
    </div>
    </PortalContainerContext.Provider>
  );
}
