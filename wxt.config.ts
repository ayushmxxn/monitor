import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  hooks: {
    // WXT 0.21 tightened the generated .wxt/tsconfig.json defaults
    // (notably noUncheckedIndexedAccess and verbatimModuleSyntax).
    // Reverting to the WXT 0.20 settings here keeps `tsc --noEmit`
    // behavior unchanged across the wxt upgrade rather than requiring
    // a pass over existing code to satisfy the new strictness -
    // see https://wxt.dev/guide/resources/upgrading.html#wxttsconfigjson-compiler-option-changes
    'prepare:tsconfig': (_, { tsconfig }) => {
      const co = tsconfig.compilerOptions as Record<string, unknown>;
      delete co.lib;
      co.module = 'ESNext';
      delete co.moduleDetection;
      delete co.allowImportingTsExtensions;
      delete co.verbatimModuleSyntax;
      co.esModuleInterop = true;
      co.forceConsistentCasingInFileNames = true;
      co.resolveJsonModule = true;
      delete co.noFallthroughCasesInSwitch;
      delete co.noUncheckedIndexedAccess;
      delete co.noImplicitOverride;
    },
    'server:created': (_, server) => {
      const origReloadContentScript = server.reloadContentScript.bind(server);
      const origReloadExtension = server.reloadExtension.bind(server);
      const origReloadPage = server.reloadPage.bind(server);

      let isBackgroundInitializing = false;
      let sourceChangeTimestamp = 0;
      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      let lastReloadTime = 0;

      // Track genuine source file modification events from the watcher
      server.watcher.on('all', () => {
        sourceChangeTimestamp = Date.now();
      });

      // Intercept background-initialized registration on WebSocket
      const origWsOn = server.ws.on.bind(server.ws);
      server.ws.on = ((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'wxt:background-initialized') {
          return origWsOn(event, (...args: unknown[]) => {
            isBackgroundInitializing = true;
            try {
              return cb(...args);
            } finally {
              isBackgroundInitializing = false;
            }
          });
        }
        return origWsOn(event, cb);
      }) as typeof server.ws.on;

      const triggerDebouncedReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        const now = Date.now();
        const minDelay = 150;
        const cooldownRemaining = Math.max(0, 1000 - (now - lastReloadTime));
        const delay = Math.max(minDelay, cooldownRemaining);

        reloadTimer = setTimeout(() => {
          lastReloadTime = Date.now();
          sourceChangeTimestamp = 0;
          origReloadExtension();
        }, delay);
      };

      server.reloadPage = (path) => {
        sourceChangeTimestamp = 0;
        origReloadPage(path);
      };

      server.reloadExtension = () => {
        sourceChangeTimestamp = 0;
        origReloadExtension();
      };

      server.reloadContentScript = (payload) => {
        origReloadContentScript(payload);

        // Never reload the extension when triggered by background connection/initialization
        if (isBackgroundInitializing) return;

        const stack = new Error().stack ?? '';
        if (stack.includes('background-initialized')) return;

        // Only reload if this was preceded by a genuine source file change
        const hasRecentSourceChange = Date.now() - sourceChangeTimestamp < 5000;
        if (hasRecentSourceChange) {
          triggerDebouncedReload();
        }
      };
    },
  },
  manifest: {
    name: 'Monitor',
    description:
      'Monitor any value on any website. Local-first, private, no account required. Adaptive fingerprint-based element recovery for reliable monitoring across modern SPAs.',
    version: '0.1.0',
    // No popup, side panel, or other declarative UI entrypoint - the
    // extension's UI is a panel injected into the page itself (see
    // entrypoints/panel.content.tsx), so `action` has to be declared
    // explicitly here to get a toolbar icon whose click we can handle
    // ourselves in entrypoints/background.ts.
    action: {
      default_title: 'Monitor',
    },
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'alarms',
      'notifications',
      'offscreen',
      'favicon',
    ],
    // No host permission is granted upfront. `activeTab` lets the element
    // picker run in the current tab when the user clicks "New monitor"
    // (a user gesture). Persistent per-site access for background
    // checks is requested separately, one origin at a time, only when a
    // monitor is actually saved for that site - see lib/permissions.
    optional_host_permissions: ['*://*/*'],
    // The panel (entrypoints/panel.content.tsx) is a content script
    // injected into the host page - image `src`s it renders resolve
    // as page-context requests, not extension ones, so any bundled
    // image it references (the empty-state app icon, the settings
    // footer's credit avatar) has to be explicitly exposed here or
    // the browser blocks the load. Icons are used at multiple sizes
    // across the panel/options/notifications, so the whole folder is
    // listed rather than each size individually.
    web_accessible_resources: [
      {
        resources: ['icon/*.png', 'credit-avatar.webp'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    build: {
      // Vite's default modulepreload injects <link rel="modulepreload"
      // crossorigin> tags. There's no latency to hide for extension
      // pages (everything is bundled locally), and the `crossorigin`
      // attribute on a chrome-extension:// URL trips Chrome's
      // "cross-world extension resource mismatch" console warning.
      modulePreload: false,
    },
  }),
});
