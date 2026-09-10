import { EmptyState } from '@/components/layout/EmptyState';
import { MonitorCard } from './MonitorCard';
import type { Monitor } from '@/lib/monitors/types';

interface MonitorListProps {
  monitors: Monitor[];
  onDelete: (id: string) => Promise<boolean>;
  onOpen: (id: string) => void;
  emptyAction?: React.ReactNode;
}

/** The panel's home screen: monitors as a two-column bento grid rather than a list, so every value is visible without scrolling through rows of text. */
export function MonitorList({ monitors, onDelete, onOpen, emptyAction }: MonitorListProps) {
  if (monitors.length === 0) {
    return (
      <EmptyState
        icon={
          // `browser.runtime.getURL`, not a bare "/icon/128.png" - this
          // renders inside the panel's content-script shadow root,
          // injected onto an arbitrary page, so a root-relative path
          // would resolve against *that page's* origin (a broken
          // image) rather than the extension's.
          <img
            src={browser.runtime.getURL('/icon/128.png')}
            alt=""
            className="h-11 w-11"
          />
        }
        title="No monitors yet"
        description="Add a monitor to start watching a value on any website. Everything stays on this device."
        action={emptyAction}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {monitors.map((monitor, index) => (
        <div
          key={monitor.id}
          // `min-w-0` overrides the grid item's default automatic
          // minimum width, which is otherwise based on its content's
          // min-content size. MonitorCard's value uses `truncate`
          // (white-space: nowrap + ellipsis), and nowrap text's
          // min-content is its full, unwrapped width - without this,
          // a long value (e.g. "340k subscribers") forces this grid
          // item wider than its column to fit that full width, so the
          // card overflows the panel instead of the text inside it
          // ellipsizing. This is what actually lets `truncate` take
          // effect rather than just clipping.
          className="animate-enter-up min-w-0"
          style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
        >
          <MonitorCard monitor={monitor} onDelete={onDelete} onOpen={onOpen} />
        </div>
      ))}
    </div>
  );
}
