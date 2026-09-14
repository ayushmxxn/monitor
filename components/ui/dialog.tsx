import * as React from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';

/**
 * Minimal from-scratch dialog/modal - no Radix. Keeps the same
 * compound-component shape (`Dialog` / `DialogTrigger asChild` /
 * `DialogContent` / `DialogClose asChild`) the rest of the app already
 * uses, so callers like DeleteMonitorDialog didn't need to change at
 * all, just the ~2kb implementation underneath them.
 */
interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}
const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Dialog>`);
  return ctx;
}

export function Dialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <DialogContext.Provider value={{ open, setOpen }}>{children}</DialogContext.Provider>;
}

interface AsChildProps {
  asChild?: boolean;
  children: React.ReactElement;
}

/** Clones the child and wires up an onClick, standing in for Radix's `Slot`. */
function attachClick(
  child: React.ReactElement,
  handler: (event: React.MouseEvent) => void,
): React.ReactElement {
  const childProps = child.props as { onClick?: (event: React.MouseEvent) => void };
  return React.cloneElement(child, {
    onClick: (event: React.MouseEvent) => {
      childProps.onClick?.(event);
      handler(event);
    },
  } as Partial<unknown>);
}

export function DialogTrigger({ children }: AsChildProps) {
  const { setOpen } = useDialogContext('DialogTrigger');
  return attachClick(children, () => setOpen(true));
}

export function DialogClose({ children }: AsChildProps) {
  const { setOpen } = useDialogContext('DialogClose');
  return attachClick(children, () => setOpen(false));
}

export function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { open, setOpen } = useDialogContext('DialogContent');
  const container = usePortalContainer();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const inPanel = container !== null;

  // Esc to close, and focus the dialog itself the moment it mounts so
  // keyboard/screen-reader focus doesn't stay stranded on whatever was
  // behind it.
  React.useEffect(() => {
    if (!open) return;
    contentRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  // Never leak portaled modals into the host page's document.body when running in content scripts.
  // In extension pages (like options.html), document.body is safe. In host pages with <monitor-panel>,
  // require a container inside the shadow DOM.
  const fallback = typeof document !== 'undefined'
    ? (document.querySelector('monitor-panel') ? null : document.body)
    : null;
  const target = container ?? fallback;
  if (!target) return null;

  return createPortal(
    <div className={cn(inPanel ? 'absolute' : 'fixed', 'inset-0 z-50 font-sans')}>
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className="absolute inset-0 animate-in bg-foreground/40 fade-in-0 duration-150"
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          inPanel ? 'absolute' : 'fixed',
          'left-1/2 top-1/2 z-50 w-[calc(100%-2.5rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/[0.06] dark:border-border bg-popover p-4 text-popover-foreground shadow-2xl font-sans',
          'origin-center animate-dialog-scale-in focus:outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>,
    target,
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-2.5 flex flex-col gap-1', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-[13px] font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-[11.5px] leading-relaxed text-muted-foreground', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-3.5 flex justify-end gap-2', className)} {...props} />;
}
