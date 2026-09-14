/**
 * Shadow-host isolation for extension UI injected into arbitrary pages.
 *
 * A shadow boundary blocks selectors but *not* inheritance: `font-family`
 * (and a handful of other typographic properties) flows from the host
 * page straight into the shadow tree unless something sets it. Nothing
 * in our own stylesheet can do that job here — Tailwind's preflight
 * sets the design stack on `html`, which matches nothing inside a
 * shadow tree (and our `:root` → `:host` rewrite only carries custom
 * properties, not that rule), and no component ever sets `font-family`
 * directly. So without an explicit pin, the whole panel renders in
 * whatever the host page uses (Roboto on YouTube, a custom stack on
 * ChatGPT, the browser default on plain pages) instead of the design
 * stack — a host-page CSS collision, not a site-specific bug.
 *
 * The pin has to live in *inline* host styles, not the shadow
 * stylesheet: the layout reset below already puts `all: initial` with
 * `!important` on the host, and no stylesheet rule of any priority can
 * beat inline `!important`. One longhand declaration after the
 * shorthand is enough — the entire shadow tree then inherits the
 * design stack, while every other property keeps the reset behavior
 * exactly as before.
 */

// Design sans stack. Keep in lockstep with `fontFamily.sans` in tailwind.config.ts.
export const DESIGN_FONT_STACK =
  'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
export const SHADOW_HOST_FONT_STACK = DESIGN_FONT_STACK;

/**
 * Pins a shadow host element to zero page footprint (same eight layout declarations
 * the panel always applied). Deliberately omits typographic declarations here:
 * per CSS Cascading & Scoping Level 4, WXT's `:host { all: initial !important; }` in the
 * shadow stylesheet has higher precedence than inline styles on the host element.
 * Typographic isolation is established directly inside the shadow stylesheet on `body`
 * and the panel root container (`.font-sans`).
 */
export function applyShadowHostIsolation(host: HTMLElement): void {
  const hostStyle = host.style;
  hostStyle.setProperty('all', 'initial', 'important');
  hostStyle.setProperty('display', 'block', 'important');
  hostStyle.setProperty('position', 'static', 'important');
  hostStyle.setProperty('width', '0', 'important');
  hostStyle.setProperty('height', '0', 'important');
  hostStyle.setProperty('margin', '0', 'important');
  hostStyle.setProperty('padding', '0', 'important');
  hostStyle.setProperty('overflow', 'visible', 'important');
}
