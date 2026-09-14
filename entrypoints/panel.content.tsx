import { createRoot, type Root } from 'react-dom/client';
import { Panel, type PanelHandle } from '@/components/panel/Panel';
import { applyShadowHostIsolation } from '@/lib/ui/shadowHost';
import { onMessage } from '@/lib/messaging';
import { EXTENSION_INVALIDATED_EVENT } from '@/hooks/useExtensionInvalidated';
// `?inline` bundles the compiled CSS as a plain string at build time
// instead of relying on WXT's `cssInjectionMode: 'ui'`, which loads
// styles with a runtime `fetch()` to the extension's own
// `chrome-extension://` origin. That fetch is made from the page's own
// context (the isolated world runs alongside the page, not as the
// extension), so a page with a strict CSP - or just bad luck with the
// per-session dynamic resource URL - can silently fail it, leaving the
// panel fully unstyled. Inlining removes that runtime dependency
// entirely: the CSS ships inside panel.js and is always there.
import panelCssRaw from '@/styles/globals.css?inline';

/**
 * Injects the monitor panel onto the current page as an isolated,
 * fixed-position overlay - not `chrome.sidePanel`, so it looks and
 * behaves identically everywhere the extension runs and can float over
 * page content instead of claiming a slice of the browser's own window.
 *
 * Not auto-registered (`registration: 'runtime'`): this only runs when
 * the toolbar icon is clicked (see entrypoints/background.ts), using
 * the `activeTab` grant from that click, consistent with the rest of
 * the extension's incremental-permission model (see lib/permissions
 * and pageAgent.content.ts).
 *
 * This script is only ever injected ONCE per tab (see
 * `registerActionClick` in entrypoints/background.ts, which messages an
 * already-injected panel to toggle it rather than re-running this
 * file). That matters: WXT gives every content script a
 * `ContentScriptContext`, and its constructor automatically invalidates
 * - and tears down - any older running instance of the *same* content
 * script the moment a new one starts, before this `main()` even runs.
 * Re-running this file on a tab that already has a panel would silently
 * unmount and remove that panel out from under a stale reference, which
 * is exactly the "second click does nothing" bug this structure avoids.
 */
export default defineContentScript({
  registration: 'runtime',
  world: 'ISOLATED',
  runAt: 'document_idle',
  // This content script supplies its own CSS via the `css` option
  // below (see the `?inline` import above) rather than WXT's
  // fetch-based `'ui'` mode - 'manual' just tells WXT not to try to
  // manage CSS injection for this entrypoint itself.
  cssInjectionMode: 'manual',

  async main(ctx) {
    let handle: PanelHandle | null = null;

    document.querySelectorAll('monitor-panel').forEach((el) => el.remove());

    const ui = await createShadowRootUi(ctx, {
      name: 'monitor-panel',
      // 'inline': skip WXT's automatic fixed/full-viewport positioning
      // entirely. The panel does its own `position: fixed` (see
      // Panel.tsx) sized to just its own width, not the whole
      // viewport - anything outside it should keep behaving like the
      // page never had an extension on it (clicks pass through, no
      // stray full-screen hit target).
      position: 'inline',
      // 'closed': the host page's own scripts can't reach into the
      // panel's DOM via `element.shadowRoot` - only this content
      // script (which keeps its own reference) can.
      mode: 'closed',
      isolateEvents: true,
      // `:root` doesn't mean anything inside a shadow tree (it only
      // ever matches the real document's root element), so our design
      // tokens - defined as `:root { --background: ...; }` etc in
      // globals.css - have to be rewritten to `:host` to actually take
      // effect here. This is the same rewrite WXT's own `'ui'` CSS
      // loader does internally; it's just manual now that the fetch it
      // normally does is bypassed.
      css: panelCssRaw.replaceAll(':root', ':host'),
      onMount: (container, _shadow, shadowHost): Root => {
        const root = createRoot(container);
        root.render(
          <Panel
            ref={(instance) => {
              handle = instance;
            }}
            shadowHost={shadowHost}
            shadowContainer={container}
          />,
        );
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();

    // WXT's `position: 'inline'` deliberately skips its own fixed/
    // full-viewport host styling (see the option below) so the panel's
    // own `position: fixed` in Panel.tsx is the only thing controlling
    // its layout. But that also means the shadow host itself - a plain
    // custom element sitting at the end of the page's real `<body>` -
    // is left with no explicit size or layout behavior of its own,
    // and just inherits whatever the host page's CSS decides for an
    // unrecognized element. Most sites default that to zero-size
    // `display: inline`, which is invisible - but a site with a flex or
    // grid `<body>`, or a broad reset (`* { display: block }` and
    // similar), can stretch or blockify it into a real, visible box.
    // Since our actual UI lives entirely inside the shadow root and is
    // already `position: fixed` (removed from normal flow on its own),
    // the host element itself should never take up any page space -
    // pin that down explicitly instead of leaving it to chance. This
    // mirrors what WXT applies automatically for its 'overlay'/'modal'
    // positions; 'inline' just doesn't get it for free. The exact
    // declarations (plus the design font pin) live in
    // lib/ui/shadowHost.ts so they are unit-testable - see
    // test/fontIsolation.test.ts.
    applyShadowHostIsolation(ui.shadowHost);

    // Promote the shadow host into the browser's top layer via the
    // Popover API, instead of leaving it as an ordinary node at the
    // end of <body>.
    //
    // Why: Panel.tsx positions itself with `position: fixed`, which is
    // normally viewport-relative - but that guarantee quietly breaks
    // if ANY ancestor, anywhere above it in the page (including <body>
    // or <html> itself), has a `transform`, `filter`, `perspective`,
    // `backdrop-filter`, `will-change`, or `contain` value set. When
    // that happens the browser repoints "fixed" at that ancestor's box
    // instead of the real viewport - and Shadow DOM does nothing to
    // stop it, since containing-block resolution walks the flat/
    // composed tree straight through shadow boundaries. Sites that use
    // any of those properties on a top-level wrapper for scroll
    // effects, GPU-accelerated layers, or dark-mode filters (YouTube
    // and Umami's dashboard both do) end up rendering this panel
    // flush against the wrong edge, at the wrong size, with corners
    // clipped - exactly the "looks fine everywhere except here" bug
    // this fixes.
    //
    // `popover="manual"` sidesteps the whole problem: top-layer
    // elements are rendered as if they were a sibling of the document
    // itself, which resets the containing-block search for every fixed-
    // position descendant back to the true viewport, regardless of what
    // the page does above them. 'manual' (rather than 'auto') is what
    // makes this safe to use for a persistent panel: unlike 'auto'
    // popovers, it never light-dismisses on Escape or an outside click
    // and never traps focus or blocks interaction with the rest of the
    // page - open/closed is still governed entirely by Panel.tsx's own
    // `isOpen` state and its slide transform, exactly as before. This
    // is the same mechanism browsers ship for tooltips/menus that must
    // render correctly regardless of an arbitrary ancestor's CSS - see
    // https://developer.mozilla.org/en-US/docs/Web/API/Popover_API.
    //
    // Feature-detected rather than assumed: the fixed/inset styles set
    // above already make the panel correctly positioned on the (now
    // rare) browser without Popover API support - just not immune to
    // this one class of ancestor-CSS interference.
    const host = ui.shadowHost;
    if (typeof host.showPopover === 'function') {
      host.setAttribute('popover', 'manual');
      try {
        host.showPopover();
      } catch {
        // Already shown, or the page did something unusual to the
        // element before this ran - the plain fixed/inset positioning
        // above still works, just without top-layer immunity.
      }
    }

    // Toggling now happens via a message from the background worker
    // (see registerActionClick in entrypoints/background.ts) instead of
    // a `window` flag checked at the top of this file - a `window`
    // check can't help on repeat clicks because, as above, WXT tears
    // this instance down before a second injection's `main()` would
    // ever get a chance to read it. Listening for a message instead
    // means the background worker only re-injects this file when
    // there's truly nothing listening yet (fresh tab, or one that
    // navigated and lost its content scripts).
    const unregister = onMessage('togglePanel', () => {
      handle?.toggle();
      return { handled: true };
    });
    ctx.onInvalidated(() => {
      try {
        unregister();
      } catch {
        // Stale or invalidated context on unmount - ignore.
      }
      // Tell the still-mounted React tree so it can show a clear
      // "reload this page" banner instead of the panel silently
      // failing every future action with a raw Chrome error string.
      // Plain DOM event because this is the one thing guaranteed to
      // still work post-invalidation - nothing here touches chrome.*.
      window.dispatchEvent(new CustomEvent(EXTENSION_INVALIDATED_EVENT));
    });
  },
});
