import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/**
 * Converts every `rem` value in the compiled CSS to a fixed `px`
 * value (at Tailwind's default 1rem = 16px).
 *
 * Why: the panel is injected into arbitrary host pages via a closed
 * shadow root (see entrypoints/panel.content.tsx). Shadow DOM isolates
 * almost all CSS, but `rem` is the one unit that's defined relative to
 * the *document's* root `<html>` element, not the shadow tree - so it
 * ignores shadow boundaries entirely. Sites that set their own
 * `html { font-size: ... }` for responsive scaling (YouTube and a lot
 * of analytics/dashboard UIs, Umami included, commonly do this) rescale
 * every `rem`-based Tailwind utility in the panel - spacing, radius,
 * type size, borders - even though everything else about the panel is
 * properly isolated.
 *
 * Baking every `rem` down to its px equivalent at build time removes
 * that dependency completely: the panel renders at the same fixed size
 * everywhere, regardless of what the host page does to its own root
 * font-size. This runs for every stylesheet the build produces (panel
 * and options page alike) - harmless for the options page, which is a
 * normal extension page with its own untouched 16px root font-size, so
 * the output is numerically identical there either way.
 */
const REM_PX_RATIO = 16;

const remToPx = () => ({
  postcssPlugin: 'rem-to-px',
  Declaration(decl) {
    if (!decl.value.includes('rem')) return;
    decl.value = decl.value.replace(/(-?[0-9]*\.?[0-9]+)rem/g, (_match, num) => {
      const px = parseFloat(num) * REM_PX_RATIO;
      // Trim trailing floating-point noise (e.g. 10.000000000000002px).
      return `${Math.round(px * 1000) / 1000}px`;
    });
  },
});
remToPx.postcss = true;

export default {
  plugins: [tailwindcss, autoprefixer, remToPx],
};
