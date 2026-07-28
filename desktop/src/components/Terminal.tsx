// xterm.js pane wired to a portable-pty session in the Rust backend.
// Lifecycle: open a PTY on first mount for a given `instanceId`, fit to
// host size, pipe keystrokes out via pty_write, fold incoming bytes back
// in via the per-session `pty:<id>` event. ResizeObserver keeps cols/rows
// in sync with the element box.
//
// **Persistence across tab switches**: when the React component
// unmounts (user switches to another tab), we do *not* dispose the
// xterm Terminal or close the PTY. Instead the session (term + pty +
// listeners) is stashed in a module-level Map keyed by `instanceId`. On
// the next mount with the same id we re-attach the xterm element to the
// new host div, re-fit, and continue. This preserves shell state,
// scrollback, and any running command. `releaseTerminalSession(id)`
// disposes everything — call it from the store when a terminal tab is
// permanently closed.
//
// xterm.css is imported once globally in main.tsx — bringing it in here
// would re-inject every mount. The engine is tuned for VSCode parity: its
// exact default integrated-terminal theme + font metrics (see THEME and the
// XTerm options in createSession), a WebGL renderer, and unicode-11 width
// handling — so this reads as the terminal people already know from VSCode.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  registerShellIntegration,
  type ShellIntegration,
} from "../lib/terminalShellIntegration";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { handleClipboardKey, mapKeyEvent } from "../lib/terminalKeymap";
import { api } from "../lib/api";
import { registerFilePathLinks } from "../lib/terminalLinks";
import { getSettings } from "../lib/settingsStore";
import { playTerminalBell } from "../lib/terminalBell";
import { isNativeTerminalEnabled } from "../lib/nativeTerminalStore";
import { NativeTerminal } from "./NativeTerminal";
export { releaseNativeTerminalSession } from "./NativeTerminal";

type TerminalProps = {
  cwd?: string;
  shell?: string;
  /** Stable id used both as the React effect key and the session key.
   *  Required for the per-tab terminals so the same xterm + PTY survives
   *  tab switches. The bottom-pane singleton omits this and gets a
   *  one-shot ephemeral session. */
  instanceId?: string;
  /** Optional shell command sent to the PTY ~250ms after open so the
   *  shell's prompt is ready to receive it. Trailing newline is
   *  appended if missing — the shell echoes the line as if the user
   *  typed it. Used by the Aura Manager terminal so the user lands on
   *  an aura command instead of a blank prompt. */
  bootCommand?: string;
  /** Terminal profile id (see `cmd_terminal_profiles`). The backend
   *  resolves it to a shell + workspace-identity env. Falls through to
   *  `shell` / `$SHELL` when absent. */
  profile?: string;
  /** Workspace root — feeds the profile env resolution and scrollback
   *  keying. Falls back to `cwd` when omitted. */
  repoRoot?: string;
  /** Live daemon session id to re-subscribe to instead of spawning a
   *  fresh child (set after a restart when `ptyListAlivePlain()` reports
   *  the session is still alive). The backend re-tees its scrollback ring
   *  on reconnect, so the screen backfills automatically. */
  reconnectId?: string | null;
  /** Cold-restore key. When the process truly exited (daemon off, or the
   *  child died), the serialized scrollback saved under this key is
   *  replayed as inert history above a fresh prompt. Defaults to
   *  `instanceId`. */
  scrollbackKey?: string | null;
  /** Fired once after `pty_open` resolves, with the backend pty id. When
   *  the daemon hosts the shell this id is the live session id to pass
   *  back as `reconnectId` on the next launch; in-process it's a fresh
   *  uuid that simply won't match a survivor, so persisting it is safe
   *  either way. The panel stores it on the tab as `daemonSessionId`. */
  onOpened?: (ptyId: string, reconnected: boolean) => void;
  /** Optional background override for the xterm canvas + host. Set ONLY by a
   *  terminal that lives inside a split pane, so a split terminal reads as a
   *  distinct surface from the editor panes beside it. Omitted everywhere
   *  else (bottom panel, single-pane) so those keep the exact VSCode
   *  `#1e1e1e` parity. A hex string like `#1a1a1f`. */
  bgTint?: string;
};

// VSCode's default integrated-terminal palette. The 16 ANSI colors are the
// exact values from VSCode's terminalColorRegistry; background/foreground/
// cursor/selection are the Dark+ (Dark Modern) theme values. Kept verbatim so
// the terminal matches VSCode pixel-for-pixel rather than Aura's black tokens.
const VSCODE_TERMINAL_BG = "#1e1e1e";
const THEME = {
  background: VSCODE_TERMINAL_BG,
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: VSCODE_TERMINAL_BG,
  selectionBackground: "#264f78",
  selectionInactiveBackground: "#3a3d41",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

type PersistentSession = {
  term: XTerm;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  /** OSC 133 parser + command decorations (VSCode-style gutter marks). */
  shellIntegration: ShellIntegration;
  ptyId: string;
  unlistenData: UnlistenFn;
  unlistenExit: UnlistenFn;
  /** Where this terminal's cold-restore scrollback is keyed on disk
   *  (`repoRoot` + termId). Held so the 30s timer + teardown can flush a
   *  snapshot without re-threading props. */
  saveRepoRoot: string;
  saveTermId: string;
  /** Periodic scrollback-snapshot timer; cleared on release. */
  saveTimer: number | null;
};

const sessions = new Map<string, PersistentSession>();
// Pending boots — multiple effect runs can race for the same instanceId
// during fast tab toggles. The first run owns the PTY init; later runs
// await the same promise and reuse the result.
const pendingBoots = new Map<string, Promise<PersistentSession | null>>();
// Ids whose tab was permanently closed WHILE their PTY was still booting.
// releaseTerminalSession() can't tear down a session that isn't in the map
// yet, so it records the id here; the resolving createSession() sees the mark
// and disposes itself instead of orphaning a live PTY + 30s timer that nothing
// will ever reattach to or release.
const releasedDuringBoot = new Set<string>();

// Final cold-restore guarantee: on a clean window close (quit, reload,
// relaunch) flush every live terminal's scrollback synchronously so the
// next launch can replay it. The 30s timer + blur cover crashes; this
// covers the ordinary "quit with terminals open" path that is the whole
// point of "they stay there even when things restart".
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const s of sessions.values()) flushScrollback(s);
  });
}

/** Dispose the xterm + close the PTY for a given session id. Call from
 *  the editor store when a terminal tab is permanently removed (not just
 *  switched away from). Safe to call with an unknown id. */
export function releaseTerminalSession(instanceId: string): void {
  // Boot still in flight — the session isn't in the map yet. Flag it so the
  // resolving createSession() disposes the freshly-built session instead of
  // storing it (otherwise the PTY, xterm, and 30s scrollback timer leak with
  // no tab left to reattach or release them).
  if (!sessions.has(instanceId) && pendingBoots.has(instanceId)) {
    releasedDuringBoot.add(instanceId);
    return;
  }
  const s = sessions.get(instanceId);
  if (!s) return;
  sessions.delete(instanceId);
  // One last cold-restore snapshot before the buffer is gone — covers
  // an explicit close where the user wants the history back next launch.
  flushScrollback(s);
  if (s.saveTimer !== null) {
    clearInterval(s.saveTimer);
    s.saveTimer = null;
  }
  try {
    s.unlistenData();
  } catch {
    /* noop */
  }
  try {
    s.unlistenExit();
  } catch {
    /* noop */
  }
  invoke("pty_close", { id: s.ptyId }).catch(() => {});
  try {
    s.shellIntegration.dispose();
  } catch {
    /* noop */
  }
  try {
    s.term.dispose();
  } catch {
    /* noop */
  }
}

/** Serialize the live buffer and hand it to the backend for gzip + cold
 *  storage. Fire-and-forget; a failed write must never disrupt the
 *  terminal. The SerializeAddon dump is capped backend-side (2 MiB), and
 *  we cap line count here so an enormous scrollback doesn't stall the
 *  main thread. */
function flushScrollback(s: PersistentSession): void {
  if (!s.saveRepoRoot) return;
  let text = "";
  try {
    text = s.serialize.serialize({ scrollback: 1000 });
  } catch {
    return;
  }
  if (!text) return;
  api.ptyScrollbackSave(s.saveRepoRoot, s.saveTermId, text).catch(() => {});
}

/** Flush a mounted terminal's scrollback on demand (e.g. before the app
 *  relaunches, or when the tab loses focus). No-op for unknown ids. */
export function snapshotTerminalScrollback(instanceId: string): void {
  const s = sessions.get(instanceId);
  if (s) flushScrollback(s);
}

/** Read recent plain-text output from a terminal for chat context.
 *
 * xterm-backed sessions expose their full live scrollback in-process. Native
 * GPU terminals own the grid in Rust, so they use a small command that reads
 * the same grid currently being rendered. Unknown/closed ids resolve to an
 * empty string; asking for terminal context must never block a chat send. */
export async function readTerminalContext(
  instanceId: string,
  maxLines = 200,
): Promise<string> {
  const lineLimit = Math.max(1, Math.min(maxLines, 1000));
  const s = sessions.get(instanceId);
  let text = "";

  if (s) {
    const buffer = s.term.buffer.active;
    const start = Math.max(0, buffer.length - lineLimit);
    const logicalLines: string[] = [];
    for (let i = start; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const value = line.translateToString(true);
      if (line.isWrapped && logicalLines.length > 0) {
        logicalLines[logicalLines.length - 1] += value;
      } else {
        logicalLines.push(value);
      }
    }
    text = logicalLines.join("\n").trimEnd();
  } else {
    text = await invoke<string>("native_term_context", {
      termId: instanceId,
      maxLines: lineLimit,
    }).catch(() => "");
    text = text.trimEnd();
  }

  // Keep a single mention from overwhelming the model context window. Retain
  // the newest output because it contains the command result/prompt the user
  // is most likely referring to.
  const maxChars = 32_000;
  if (text.length > maxChars) {
    return `[earlier terminal output omitted]\n${text.slice(-maxChars)}`;
  }
  return text;
}

/** Clear the visible buffer + scrollback for a live terminal (the `...`
 *  menu's "Clear Terminal"). No-op if the session isn't mounted. */
export function clearTerminalSession(instanceId: string): void {
  sessions.get(instanceId)?.term.clear();
}

/** Current selection text for a live terminal, or "" when nothing is
 *  selected / the session isn't mounted. */
export function terminalSelection(instanceId: string): string {
  return sessions.get(instanceId)?.term.getSelection() ?? "";
}

/** Copy the current selection to the system clipboard. Returns false
 *  when there's nothing selected. */
export function copyTerminalSelection(instanceId: string): boolean {
  const text = terminalSelection(instanceId);
  if (!text) return false;
  void navigator.clipboard?.writeText(text);
  return true;
}

/** Select the whole buffer (the `...` menu's "Select All"). */
export function selectAllTerminal(instanceId: string): void {
  sessions.get(instanceId)?.term.selectAll();
}

/** Paste clipboard text into a live terminal by writing it to the PTY,
 *  exactly as if the user had pressed ⌘V over the shell. */
export async function pasteIntoTerminal(instanceId: string): Promise<void> {
  const s = sessions.get(instanceId);
  if (!s) return;
  const text = await navigator.clipboard?.readText().catch(() => "");
  if (text) invoke("pty_write", { id: s.ptyId, data: text }).catch(() => {});
}

/** Find-in-terminal options shared by the find widget. `caseSensitive`,
 *  `wholeWord`, and `regex` map straight onto the SearchAddon's
 *  ISearchOptions; decorations give the highlight + active-match colors
 *  pulled from our design tokens. */
export type TerminalFindOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
};

// VSCode's find colors: other matches use the translucent findMatchHighlight,
// the active match the solid findMatch, both marked on the overview ruler.
const FIND_DECORATIONS = {
  matchBackground: "#ea5c0055",
  matchBorder: "#ea5c00",
  matchOverviewRuler: "#d18616",
  activeMatchBackground: "#515c6a",
  activeMatchBorder: "#f9a825",
  activeMatchColorOverviewRuler: "#d18616",
};

/** Search forward from the current selection. Returns false when the
 *  session isn't mounted or the term is empty. */
export function terminalFindNext(
  instanceId: string,
  query: string,
  opts: TerminalFindOptions = {},
): boolean {
  const s = sessions.get(instanceId);
  if (!s || !query) {
    s?.search.clearDecorations();
    return false;
  }
  return s.search.findNext(query, { ...opts, decorations: FIND_DECORATIONS });
}

/** Search backward from the current selection. */
export function terminalFindPrevious(
  instanceId: string,
  query: string,
  opts: TerminalFindOptions = {},
): boolean {
  const s = sessions.get(instanceId);
  if (!s || !query) {
    s?.search.clearDecorations();
    return false;
  }
  return s.search.findPrevious(query, { ...opts, decorations: FIND_DECORATIONS });
}

/** Drop all find highlights (Esc closes the widget). */
export function clearTerminalFind(instanceId: string): void {
  sessions.get(instanceId)?.search.clearDecorations();
}

/** Subscribe to live match-count updates for the find widget's
 *  "N of M" readout. Returns an unsubscribe fn; no-op for unknown ids. */
export function onTerminalFindResults(
  instanceId: string,
  cb: (result: { resultIndex: number; resultCount: number }) => void,
): () => void {
  const s = sessions.get(instanceId);
  if (!s) return () => {};
  const disposable = s.search.onDidChangeResults(cb);
  return () => {
    try {
      disposable.dispose();
    } catch {
      /* noop */
    }
  };
}

/** Public entry point. Delegates to the native GPU terminal when the
 *  `NATIVE_TERMINAL` flag is on, otherwise runs the classic xterm.js engine.
 *  The choice is captured per mount, so a given pane keeps one engine for its
 *  lifetime. */
export function Terminal(props: TerminalProps) {
  // Native GPU (wgpu) is the default engine on macOS/Linux; resolved once per
  // mount so a pane keeps one engine for its lifetime.
  const preferNative = useMemo(() => isNativeTerminalEnabled(), []);
  // Flips true when the native surface / PTY can't initialise on this machine —
  // we then drop this pane to the xterm fallback so the user still gets a shell
  // rather than staring at a blank transparent hole.
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const onNativeUnavailable = useCallback(() => setNativeUnavailable(true), []);

  if (preferNative && !nativeUnavailable) {
    return (
      <NativeTerminal
        cwd={props.cwd}
        repoRoot={props.repoRoot}
        instanceId={props.instanceId}
        bootCommand={props.bootCommand}
        onOpened={props.onOpened}
        onUnavailable={onNativeUnavailable}
      />
    );
  }
  return <XtermTerminal {...props} />;
}

function XtermTerminal({
  cwd,
  shell,
  instanceId,
  bootCommand,
  profile,
  repoRoot,
  reconnectId,
  scrollbackKey,
  onOpened,
  bgTint,
}: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // ptyId for the active session — surfaced to onDrop without going
  // through the persistence map on every drag.
  const ptyIdRef = useRef<string | null>(null);
  // Latest cwd, captured by the link provider so re-resolves use the
  // current working directory even after the user `cd`'s mid-session.
  const cwdRef = useRef<string | undefined>(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const hostEl: HTMLDivElement = host;
    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;
    // An xterm that opened into the host but whose PTY failed to spawn:
    // kept visible (showing the error) instead of disposed, so the user
    // doesn't stare at a blank pane. Disposed here on unmount/re-run.
    let failedTerm: XTerm | null = null;

    function attach(session: PersistentSession) {
      if (cancelled) return;
      // Re-parent xterm into the new host. xterm's root element is
      // session.term.element; appending it moves it from its prior
      // parent (or no parent if this is first mount).
      if (session.term.element && session.term.element.parentNode !== hostEl) {
        hostEl.appendChild(session.term.element);
      }
      try {
        session.fit.fit();
      } catch {
        /* element may not be measurable yet on first paint */
      }
      // Re-sync PTY geometry with the (possibly different) host size.
      invoke("pty_resize", {
        id: session.ptyId,
        cols: session.term.cols,
        rows: session.term.rows,
      }).catch(() => {});
      ptyIdRef.current = session.ptyId;
      // Stamp the live PTY id onto the host element so the global OS-file-drop
      // router (osFileDrop.ts) can type a dropped path into THIS terminal —
      // hit-testing finds the host via `[data-os-drop]`, then reads this id.
      hostEl.setAttribute("data-pty-id", session.ptyId);

      // Fresh observer per mount — old one was disconnected on
      // detach. Keeps xterm fit-to-host as the window resizes while
      // this tab is active.
      resizeObs = new ResizeObserver(() => {
        try {
          session.fit.fit();
          invoke("pty_resize", {
            id: session.ptyId,
            cols: session.term.cols,
            rows: session.term.rows,
          }).catch(() => {});
        } catch {
          /* detached mid-resize */
        }
      });
      resizeObs.observe(hostEl);

      // Pull focus back so keystrokes go to xterm immediately on
      // tab switch — otherwise the user has to click first.
      try {
        session.term.focus();
      } catch {
        /* noop */
      }
    }

    async function createSession(): Promise<PersistentSession | null> {
      // Terminal prefs apply to new terminal tabs (settingsStore →
      // ~/.aura/settings.toml). Read once at construction; not reactive.
      const tprefs = getSettings().terminal;
      // VSCode splits its default terminal font size by platform (its editor
      // default: 12 on macOS, 14 elsewhere) and uses Menlo on mac.
      const isMac =
        typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
      const term = new XTerm({
        // A split-pane terminal overrides just the background (+ its cursor
        // accent so the block cursor's inner fill still matches) to read as a
        // distinct surface; every other terminal keeps THEME verbatim for
        // exact VSCode parity.
        theme: bgTint
          ? { ...THEME, background: bgTint, cursorAccent: bgTint }
          : THEME,
        // Exact VSCode defaults — Menlo on mac, platform monospace elsewhere.
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        fontSize: isMac ? 12 : 14,
        fontWeight: "normal",
        fontWeightBold: "bold",
        letterSpacing: 0,
        lineHeight: 1.0,
        cursorStyle: "block",
        cursorInactiveStyle: "outline",
        cursorBlink: tprefs.cursor_blink,
        // VSCode enforces a 4.5:1 minimum contrast so dim ANSI colors stay
        // readable — a defining part of how its terminal looks.
        minimumContrastRatio: 4.5,
        drawBoldTextInBrightColors: true,
        // Fast-scroll (Alt+wheel) sensitivity — VSCode's default is 5. The
        // modifier itself is already Alt in xterm.
        fastScrollSensitivity: 5,
        scrollSensitivity: 1,
        macOptionIsMeta: false,
        macOptionClickForcesSelection: false,
        rescaleOverlappingGlyphs: true,
        allowProposedApi: true,
        scrollback: tprefs.scrollback,
      });
      if (tprefs.bell) {
        term.onBell(() => playTerminalBell());
      }
      const fit = new FitAddon();
      const serialize = new SerializeAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(serialize);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon());
      // Unicode 11 width tables — VSCode loads this so wide glyphs/emoji take
      // the right cell count (allowProposedApi is required for it).
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      // VSCode-parity: file paths in terminal output become clickable.
      // Helper resolves relative paths against the latest cwd captured
      // by cwdRef and dispatches `aura:scroll-to-line` for the matched
      // line number.
      registerFilePathLinks(term, () => cwdRef.current);

      term.open(hostEl);
      // GPU (WebGL) renderer — VSCode's default and far faster than xterm's
      // DOM renderer. The DOM renderer is the fallback, and it's the prime
      // suspect for sluggish redraws on Intel/older GPUs. Crucially, WebGL
      // contexts on dual-GPU Intel Macs get *lost* on a GPU switch or under
      // memory pressure; the old code disposed the addon on loss and then ran
      // on the slow DOM renderer for the REST of the session. Now we reload a
      // fresh WebGL addon after a loss (a few bounded retries) so GPU
      // rendering is restored instead of degrading permanently — which is what
      // made redraw-heavy CLIs (Claude Code, vim, htop) feel laggy.
      let webglRetries = 0;
      const loadWebgl = () => {
        // Bail if the terminal was disposed (unmount) before a retry fired.
        if (term.element == null) return;
        let addon: WebglAddon;
        try {
          addon = new WebglAddon();
        } catch {
          return; /* no WebGL2 in this webview — DOM renderer stays */
        }
        addon.onContextLoss(() => {
          try {
            addon.dispose();
          } catch {
            /* already gone */
          }
          // Transient loss — try to restore GPU rendering rather than living
          // on the DOM renderer forever. Bounded so a webview that genuinely
          // can't hold a context settles on DOM instead of thrashing.
          if (webglRetries < 3) {
            webglRetries += 1;
            window.setTimeout(loadWebgl, 500);
          }
        });
        try {
          term.loadAddon(addon);
        } catch {
          /* late context-creation failure — DOM renderer stays */
        }
      };
      loadWebgl();
      // VSCode-style shell-integration command decorations. Parses the OSC 133
      // marks the backend already injects and renders a pass/fail dot per
      // command in the gutter + overview ruler. Must run after open().
      const shellIntegration = registerShellIntegration(term);
      try {
        fit.fit();
      } catch {
        /* host may be 0×0 briefly */
      }

      const saveRepoRoot = repoRoot ?? cwd ?? "";
      const saveTermId = scrollbackKey ?? instanceId ?? "";

      let ptyId: string;
      let reconnected = false;
      try {
        const handle = await invoke<{ id: string; reconnected?: boolean }>("pty_open", {
          cwd,
          cols: term.cols,
          rows: term.rows,
          shell,
          profile,
          repoRoot: repoRoot ?? cwd,
          label: null,
          shellIntegration: null,
          reconnectId: reconnectId ?? null,
        });
        ptyId = handle.id;
        reconnected = handle.reconnected ?? false;
      } catch (err) {
        if (cancelled) {
          // Tab was already torn down — nothing to show; just clean up.
          term.dispose();
          return null;
        }
        // Surface the failure in-pane. A silent dispose leaves a blank
        // black rectangle the user reads as a frozen terminal. Plain
        // meaning first; the raw reason is dimmed below for whoever wants
        // the mechanism.
        const reason =
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : String(err);
        term.write("\r\n\x1b[31m⚠ Couldn't start this terminal.\x1b[0m\r\n");
        term.write(
          "\x1b[2mThe shell it tried to run may be missing or misnamed. Open Settings → Terminal, pick a different shell, then open a new terminal.\x1b[0m\r\n",
        );
        if (reason && reason.trim()) {
          term.write(`\x1b[2m${reason.replace(/[\r\n]+/g, " ").slice(0, 300)}\x1b[0m\r\n`);
        }
        failedTerm = term;
        return null;
      }
      // Report the backend id up so the tab can persist it as
      // `daemonSessionId` for next-launch reconnect.
      onOpened?.(ptyId, reconnected);

      // Cold restore — only when we did NOT reconnect to a live daemon
      // session (a reconnect re-tees the backend ring, so the screen
      // backfills on its own and replaying cold history would double it).
      // Write the saved scrollback as inert text above a dim marker, then
      // the fresh shell's prompt prints below it.
      if (!reconnected && saveRepoRoot && saveTermId) {
        try {
          const hist = await api.ptyScrollbackLoad(saveRepoRoot, saveTermId);
          if (hist) {
            term.write(hist);
            term.write("\r\n\x1b[2m── session restored ──\x1b[0m\r\n");
          }
        } catch {
          /* cold restore is best-effort */
        }
      }

      const unlistenData = await listen<number[]>(`pty:${ptyId}`, (e) => {
        term.write(new Uint8Array(e.payload));
      });
      const unlistenExit = await listen(`pty-exit:${ptyId}`, () => {
        term.write("\r\n\x1b[2m── this terminal has closed ──\x1b[0m\r\n");
      });

      // Keystrokes → PTY. Bound once; the closure captures the stable
      // ptyId, so it survives unmount/remount.
      term.onData((data) => {
        const bytes = Array.from(new TextEncoder().encode(data));
        invoke("pty_write", { id: ptyId, data: bytes }).catch(() => {});
      });

      // macOS-style key shortcuts. Same as onData, the handler captures
      // ptyId stably.
      term.attachCustomKeyEventHandler((e) => {
        if (
          handleClipboardKey(e, {
            getSelection: () => term.getSelection(),
            writeBytes: (bytes) => {
              invoke("pty_write", { id: ptyId, data: bytes }).catch(() => {});
            },
          })
        ) {
          e.preventDefault();
          return false;
        }
        const bytes = mapKeyEvent(e);
        if (!bytes) return true;
        invoke("pty_write", { id: ptyId, data: Array.from(bytes) }).catch(() => {});
        e.preventDefault();
        return false;
      });

      const session: PersistentSession = {
        term,
        fit,
        serialize,
        search,
        shellIntegration,
        ptyId,
        unlistenData,
        unlistenExit,
        saveRepoRoot,
        saveTermId,
        saveTimer: null,
      };

      // Periodic cold-restore snapshot so an abrupt quit (crash, force
      // kill) still leaves recent history to replay. Persistent tabs
      // only — the ephemeral singleton has nowhere to restore into. A
      // blur snapshot covers the common case of switching away from the
      // terminal right before the window closes.
      if (instanceId && saveRepoRoot && saveTermId) {
        session.saveTimer = window.setInterval(() => flushScrollback(session), 30_000);
        term.textarea?.addEventListener("blur", () => flushScrollback(session));
      }

      if (instanceId) {
        // The tab was closed while we booted — don't store or keep this
        // session alive; tear it down like an ephemeral one (releaseEphemeral
        // also clears the scrollback timer set just above).
        if (releasedDuringBoot.has(instanceId)) {
          releasedDuringBoot.delete(instanceId);
          releaseEphemeral(session);
          return null;
        }
        sessions.set(instanceId, session);
      }

      if (bootCommand && bootCommand.trim().length > 0) {
        const line = bootCommand.endsWith("\n") ? bootCommand : `${bootCommand}\n`;
        setTimeout(() => {
          const bytes = Array.from(new TextEncoder().encode(line));
          invoke("pty_write", { id: ptyId, data: bytes }).catch(() => {});
        }, 250);
      }

      return session;
    }

    if (instanceId) {
      const existing = sessions.get(instanceId);
      if (existing) {
        attach(existing);
      } else {
        // Coalesce concurrent first-mounts for the same id.
        let promise = pendingBoots.get(instanceId);
        if (!promise) {
          promise = createSession().finally(() => {
            pendingBoots.delete(instanceId);
          });
          pendingBoots.set(instanceId, promise);
        }
        void promise.then((session) => {
          // This mount was torn down before the boot resolved — don't attach
          // to a detached host. A live remount registered its own .then on the
          // same shared promise and will attach instead.
          if (cancelled) return;
          if (session) attach(session);
        });
      }
    } else {
      // Singleton / no-id path: ephemeral session, disposed on unmount
      // like the original behavior.
      void createSession().then((session) => {
        if (!session) return;
        if (cancelled) {
          releaseEphemeral(session);
          return;
        }
        attach(session);
      });
    }

    return () => {
      cancelled = true;
      resizeObs?.disconnect();
      // A failed-boot term is owned by this effect alone (never stored in
      // `sessions`) — dispose it so it doesn't leak when the pane unmounts
      // or a dep change re-runs the boot.
      if (failedTerm) {
        try {
          failedTerm.dispose();
        } catch {
          /* already disposed */
        }
        failedTerm = null;
      }
      if (!instanceId) {
        // Ephemeral path — full teardown.
        const ptyId = ptyIdRef.current;
        if (ptyId) {
          invoke("pty_close", { id: ptyId }).catch(() => {});
        }
        ptyIdRef.current = null;
        return;
      }
      // Persistent path — detach DOM but keep xterm + PTY alive in the
      // sessions map. The next mount with the same id reattaches.
      const sess = sessions.get(instanceId);
      if (sess && sess.term.element && sess.term.element.parentNode === hostEl) {
        hostEl.removeChild(sess.term.element);
      }
      ptyIdRef.current = null;
    };
    // `reconnectId` / `scrollbackKey` / `onOpened` are read only during the
    // one-time session create — re-running on them would steal focus on
    // every parent render (the re-attach path re-fits + re-focuses). They
    // are stable per tab in practice, so excluding them is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, cwd, shell, bootCommand, profile, repoRoot]);

  // Drop handler: same shape as AgentTerminalView. xterm renders to a
  // canvas, so the canvas swallows the drop unless we intercept here
  // and write the dropped path bytes into the PTY ourselves.
  const onDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("text/uri-list") ||
      e.dataTransfer.types.includes("text/plain") ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // Aura tray drag: image clips go through the OS clipboard so a
    // follow-up Ctrl+V (which we send for them) is treated as an
    // image paste by anything reading clipboard contents (e.g. an
    // editor open in the shell pane). Non-image clips fall through
    // to path-typing.
    const auraClipRaw = e.dataTransfer.getData("application/x-aura-clip");
    if (auraClipRaw) {
      try {
        const meta = JSON.parse(auraClipRaw) as { id: string; kind: string };
        if (meta.kind === "image" && meta.id) {
          const ptyForDrop = ptyIdRef.current;
          if (!ptyForDrop) return;
          api
            .clipsCopyImageToOs(meta.id)
            .then(() => {
              invoke("pty_write", { id: ptyForDrop, data: [0x16] }).catch(() => {});
            })
            .catch(() => {
              const path = (JSON.parse(auraClipRaw) as { path: string }).path;
              const text = /\s/.test(path) ? `"${path}"` : path;
              const bytes = Array.from(new TextEncoder().encode(text + " "));
              invoke("pty_write", { id: ptyForDrop, data: bytes }).catch(() => {});
            });
          return;
        }
      } catch {
        /* malformed — fall through */
      }
    }
    const uri = e.dataTransfer.getData("text/uri-list");
    const plain = e.dataTransfer.getData("text/plain");
    let path = "";
    if (uri && uri.length > 0) {
      const line = uri.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
      if (line) {
        path = line.startsWith("file://")
          ? decodeURIComponent(line.slice("file://".length))
          : line;
      }
    } else if (plain && plain.length > 0) {
      path = plain;
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const f = e.dataTransfer.files[0] as unknown as { path?: string };
      if (f.path) path = f.path;
    }
    if (!path) return;
    const needsQuotes = /\s/.test(path);
    const text = needsQuotes ? `"${path}"` : path;
    const ptyForDrop = ptyIdRef.current;
    if (!ptyForDrop) return;
    const bytes = Array.from(new TextEncoder().encode(text + " "));
    invoke("pty_write", { id: ptyForDrop, data: bytes }).catch(() => {});
  };

  return (
    <div
      ref={hostRef}
      data-os-drop="terminal"
      className="h-full w-full"
      style={{ backgroundColor: bgTint ?? VSCODE_TERMINAL_BG }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  );
}

function releaseEphemeral(session: PersistentSession): void {
  // Clear the periodic scrollback flush if one was armed (a persistent
  // session torn down mid-boot sets it before we decide to dispose).
  if (session.saveTimer !== null) {
    clearInterval(session.saveTimer);
    session.saveTimer = null;
  }
  try {
    session.unlistenData();
  } catch {
    /* noop */
  }
  try {
    session.unlistenExit();
  } catch {
    /* noop */
  }
  invoke("pty_close", { id: session.ptyId }).catch(() => {});
  try {
    session.shellIntegration.dispose();
  } catch {
    /* noop */
  }
  try {
    session.term.dispose();
  } catch {
    /* noop */
  }
}
