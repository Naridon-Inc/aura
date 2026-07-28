// Suppress the OS webview's native right-click menu (the WKWebView "Reload",
// "Back", "Inspect Element" items) so the desktop app never visibly betrays
// that it's a webview — right-clicking chrome should feel like a native app,
// not a web page.
//
// Two carve-outs keep real functionality intact:
//   1. Editable targets (input / textarea / contenteditable, incl. xterm's
//      helper textarea and Monaco's input) keep the native menu so Cut / Copy /
//      Paste / spellcheck still work. The native menu over an editable field
//      shows text-editing items, NOT Reload / Inspect, so nothing leaks.
//   2. In-app custom context menus (symbol rewind, pane actions, tab menus) call
//      their own `preventDefault()` in React handlers; this listener runs AFTER
//      them and never stops their menus from opening — it only cancels the
//      browser default when nothing else claimed the event.
//
// Installed once at boot from main.tsx (both the main window and popouts).

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

export function installContextMenuGuard(): void {
  window.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    // Allow the native menu on editable surfaces so text editing keeps its
    // Cut/Copy/Paste; suppress it everywhere else.
    if (target?.closest(EDITABLE_SELECTOR)) return;
    e.preventDefault();
  });
  // NOTE: bubble phase, NOT capture. Radix's ContextMenu (used by the tab
  // strip's right-click menu) wires its trigger through `composeEventHandlers`,
  // which SKIPS opening the menu when `event.defaultPrevented` is already true.
  // A capture-phase guard preventDefaults before Radix's bubble-phase handler
  // runs, so the tab menu silently never opened. Running in the bubble phase
  // means element-level React handlers (Radix, and every hand-rolled custom
  // menu) see `defaultPrevented === false` and open normally; the native
  // webview menu is still cancelled because its default action is deferred
  // until after the full event dispatch completes.
}
