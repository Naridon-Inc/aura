// Tailwind v3 → v4 bridge for @medusajs/ui.
//
// The app is Tailwind v4 (CSS-first `@theme` in src/styles.css), but
// @medusajs/ui ships its styling as a classic v3 *preset* — its whole
// token universe (`bg-ui-bg-base`, `shadow-elevation-flyout`, the `ui-*`
// scale) plus the `--bg-base` / `--fg-base` CSS variables are registered
// by plugins inside `@medusajs/ui-preset`. v4 loads this legacy config
// through the `@config "../tailwind.config.cjs"` directive in styles.css,
// runs the preset's plugins, and generates Medusa's utilities so its real
// components render correctly.
//
// IMPORTANT: once `@config` is present, v4 scans THESE globs instead of its
// automatic detection — so `content` must cover our own source as well as
// Medusa's dist, or the app's own utilities stop generating.
//
// Medusa scopes its dark tokens under `.dark`, which is the same class our
// index.html boot script + App.tsx already stamp on <html>, so dark mode
// lights up with no extra wiring.
const medusaPreset = require("@medusajs/ui-preset");

module.exports = {
  presets: [medusaPreset.default || medusaPreset],
  darkMode: ["class", ".dark"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@medusajs/ui/dist/**/*.{js,mjs}",
  ],
};
