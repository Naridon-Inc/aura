import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { HudApp } from "./components/hud/HudApp";
import { PopoutRoot } from "./components/PopoutRoot";
import { readPopoutParams } from "./lib/popout";
import { sidebarGlassEnabled } from "./lib/sidebarGlass";
import { installContextMenuGuard } from "./lib/suppressContextMenu";
import { installErrorReporting } from "./lib/track";
import { TooltipProvider } from "./components/ui/tooltip";
import { AskHost } from "./components/ui/ask";
import "./styles.css";
import "katex/dist/katex.min.css";
import "@xterm/xterm/css/xterm.css";

// Kill the native webview right-click menu (Reload / Inspect Element) so the
// app never reads as a web page. Runs for the main window and every popout.
installContextMenuGuard();

// Count uncaught errors and rejected promises. Until this, a webview crash
// left no trace off the machine at all — a whole surface could be broken in
// the field and look perfectly healthy from here. Shape only: where it came
// from and the error's class, never its message, which routinely carries
// paths and prompts.
installErrorReporting();

// Spun-off popout windows (lib/popout.ts) load this same entry with a
// `?popout=…` query string. Single-surface popouts render one focused surface
// (e.g. a floating portrait Tasks board) via PopoutRoot. A `workspace` popout
// is different: it's a WHOLE second ADE window onto a PLACE, so it boots the
// full App standing there instead of PopoutRoot.
//
// Two overrides, because a place is two things at once. `bootRootOverride` pins
// the local checkout whose board, transcript and intent log the work is filed
// under — the same thing it has always meant, and empty for a machine this
// laptop has no copy of. `bootPlaceOverride` says WHICH COMPUTER, so popping out
// a remote workspace opens a window that comes up standing in that machine
// rather than in the local copy of the same repo.
const popout = readPopoutParams();
const workspacePopout = popout?.kind === "workspace" ? popout : null;

// The always-on-top floating HUD (hud.rs creates its window with `?hud=1`).
// It's a self-contained surface — no App, no popout router — that listens to
// the `hud:state` the main window publishes and sends quick replies back.
const isHud = new URLSearchParams(window.location.search).get("hud") === "1";

if (isHud) {
  // The HUD floats over the desktop in a frameless, transparent OS window
  // (its frosted look comes from a native NSVisualEffectView behind the web
  // content). `styles.css` — imported app-wide just below — paints an opaque
  // body, which would otherwise show as a hard black box around the bar. Force
  // the page surfaces clear here; inline styles beat the global stylesheet.
  for (const el of [
    document.documentElement,
    document.body,
    document.getElementById("root"),
  ]) {
    if (el instanceof HTMLElement) el.style.background = "transparent";
  }
}

// macOS vibrancy: only the real `main` window is created transparent with a
// native NSVisualEffectView behind it (hud.rs::apply_main_window_vibrancy).
// Flag <html> so styles.css can punch the ADE shell wrappers transparent — the
// translucent sidebar then reads as live desktop-blur glass while content
// panes keep solid backgrounds. Scoped to the main ADE window on macOS: the
// HUD and popouts are their own (non-frosted) windows, so they must NOT get
// the class. Absent the class the shell keeps its opaque bg and looks exactly
// as before. Gated on the user's Sidebar-glass preference (Settings ›
// Experimental) so the frost can be traded for a plain solid background; the
// key is read synchronously here to avoid a first-frame flash.
if (
  !isHud &&
  !popout &&
  navigator.userAgent.includes("Mac") &&
  sidebarGlassEnabled()
) {
  document.documentElement.classList.add("vibrancy");
}

// Intentionally NOT wrapped in React.StrictMode — StrictMode double-fires
// every effect and render in dev. Combined with CodeMirror's expensive
// EditorView construction and our 10-pane review panel, the doubled work
// makes the app feel sluggish in `tauri dev`. Re-enable once we audit
// every effect for idempotence.
//
// TooltipProvider must wrap the whole tree because Phase A (PresetsBar)
// and Phase B (right-rail Changes panel) use Radix Tooltip primitives.
// `delayDuration={250}` matches the snappier tooltip cadence that feels
// right alongside hover-to-reveal row actions.
// AppErrorBoundary is the OUTERMOST wrapper on purpose: if a render crash or a
// bad theme would otherwise blank the window, it catches it and shows a calm,
// theme-independent "here's what happened" recovery screen instead.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppErrorBoundary>
    <TooltipProvider delayDuration={250}>
      {isHud ? (
        <HudApp />
      ) : workspacePopout ? (
        <App
          bootRootOverride={workspacePopout.root || undefined}
          bootPlaceOverride={workspacePopout.place}
        />
      ) : popout ? (
        <PopoutRoot params={popout} />
      ) : (
        <App />
      )}
      {/* Every question the app asks — confirm, prompt, notice — draws here,
          in the app's own dialog surface. Mounted at the root rather than
          inside <App/> so a HUD or popout window asks the same way instead of
          falling back to the operating system's grey sheet. */}
      <AskHost />
    </TooltipProvider>
  </AppErrorBoundary>,
);
