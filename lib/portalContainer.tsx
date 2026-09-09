import { createContext, useContext } from 'react';

/**
 * The DOM node Radix portals (Dialog, etc.) should render into when
 * used inside the panel, instead of Radix's own default target of
 * `document.body`.
 *
 * `document.body` sits outside the panel's closed shadow root, so a
 * portal that lands there escapes two things at once: the app's CSS
 * custom properties (`--popover`, `--border`, etc. are declared on
 * `:host`, not `:root`, so they simply don't exist out there - the
 * portaled content renders unstyled/transparent), and the panel's own
 * fixed-position box, so the portal ends up centered on the whole
 * page instead of within the popup.
 *
 * `null` (the default, and what this resolves to on the monitor detail
 * page, which is a normal top-level document with no shadow root of
 * its own) means "let Radix use its own default portal behavior."
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
