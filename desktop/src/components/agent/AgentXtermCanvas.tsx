// An agent PTY drawn by xterm.js in the page.
//
// One live xterm — users scroll up directly in the terminal while the session
// keeps running. Agent CLIs run in alt-screen mode, which bypasses xterm's
// scrollback by spec; that is an accepted trade-off here.
//
// This is the fallback engine. `<AgentNativeCanvas>` renders the same session
// on the GPU and is the default on macOS and Linux, because this one is the
// one that lags under what an agent actually produces: full-screen TUI
// repaints, thousands of lines a second. Everything in here is specific to
// xterm — the keymap bridge, the link providers, the bell, the OSC title hook
// — which is why the session-level concerns (is the process alive, did it
// exit) live in `useAgentPtyLifecycle` instead of in this file.

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api } from "../../lib/api";
import { noteAgentTerminalTitle } from "../../lib/agentTerminalTitles";
import { handleClipboardKey, mapKeyEvent } from "../../lib/terminalKeymap";
import { registerFilePathLinks } from "../../lib/terminalLinks";
import { openExternal } from "../../lib/openExternal";
import { defaultTerminalFontSize, getSettings } from "../../lib/settingsStore";
import { playTerminalBell } from "../../lib/terminalBell";
import { decodePtyChunk, type PtyChunk } from "../../lib/ptyPayload";
import { xtermThemeFromTokens } from "../../lib/terminalAppearance";
import { onThemePersist } from "../../lib/themeStore";
import { acceptsAgentDrag, applyAgentDrop } from "./agentDrop";

const THEME = {
  background: "#0a0a0a",
  foreground: "#e8e8e8",
  cursor: "#e8e8e8",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#1f1f1f",
  black: "#0a0a0a",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#f0883e",
  blue: "#58a6ff",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#e8e8e8",
  brightBlack: "#3a3a3a",
  brightRed: "#ff8a8a",
  brightGreen: "#9eef9e",
  brightYellow: "#ffaa66",
  brightBlue: "#7ab7ff",
  brightMagenta: "#daa3eb",
  brightCyan: "#7fd3da",
  brightWhite: "#ffffff",
};

type Props = {
  sessionId: string;
};

export function AgentXtermCanvas({ sessionId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Captured on mount via api.ptyListAlive() so the file-path link provider can
  // resolve relative paths printed by the agent. Stays undefined if the session
  // can't be located (absolute paths still resolve).
  const repoRootRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Visual terminal prefs (settingsStore). Scrollback stays at the
    // agent-tuned 50000 regardless — long agent runs need the depth.
    const tprefs = getSettings().terminal;
    const term = new XTerm({
      // `THEME` is the floor, the `--term-*` tokens are the opinion. Spreading
      // in that order means a theme pack that defines some slots and not others
      // gets its own colors where it has them and these where it does not,
      // instead of the all-or-nothing swap a straight replacement would be.
      theme: { ...THEME, ...xtermThemeFromTokens() },
      fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
      // A size chosen in Settings → Terminal applies here too: this is a
      // terminal pane, and anything else would make the one surface people
      // watch all day the one that ignored them.
      //
      // The unset default is the renderer's, not this view's. It used to be
      // 12.5 — half a point up on the shell terminal, to sit closer to chat
      // text — but this pane's own wgpu sibling, `AgentNativeCanvas`, draws
      // the shared default instead, so the half point only showed up as the
      // text changing size when the agent view fell back to xterm. Getting
      // the lift back means a per-pane appearance on the native side, which
      // is a larger change than agreeing with what is on screen today.
      fontSize: tprefs.font_size ?? defaultTerminalFontSize(),
      letterSpacing: 0,
      lineHeight: 1.25,
      cursorBlink: tprefs.cursor_blink,
      allowProposedApi: true,
      scrollback: 50000,
    });
    if (tprefs.bell) {
      term.onBell(() => playTerminalBell());
    }
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The addon's default handler is `window.open`, which a Tauri webview
    // silently drops — the link underlines on hover and clicking does nothing,
    // which is exactly what an agent printing a docs/PR URL looks like today.
    // Route it through the opener plugin instead.
    term.loadAddon(new WebLinksAddon((_e, uri) => void openExternal(uri)));
    registerFilePathLinks(term, () => repoRootRef.current);

    // What the agent calls itself, forwarded to the tab strip.
    //
    // Claude Code sets the terminal title on startup and rewrites it as the
    // session gets a subject; xterm parses OSC 0/2 already and hands us the
    // string. We were dropping it on the floor, which is why every agent tab
    // read "Claude Code" no matter what the agent was doing in it.
    //
    // The listener is not disposed by hand: it is bound to this terminal, and
    // `term.dispose()` in this effect's cleanup takes it with it. What is NOT
    // forgotten on cleanup is the title itself — this view unmounts every time
    // you switch tabs, and dropping the title there would snap the pill back to
    // "Claude Code" on the way past. The tab's own close does that instead
    // (`clearAgentTerminalTitle`, in editorStore's `closeAgent`).
    term.onTitleChange((title) => noteAgentTerminalTitle(sessionId, title));

    term.open(host);
    fit.fit();

    // Take the keyboard the moment the terminal is on screen, the same way the
    // plain shell does on tab switch. Without this an agent could put a
    // question on screen — pi's "Trust project folder?", Claude's permission
    // prompts — and every key you pressed went nowhere, because focus was still
    // on whatever button started the session. Nothing looked broken; the agent
    // just sat there waiting while you typed at it.
    try {
      term.focus();
    } catch {
      /* noop */
    }

    // Snapshot the session's repo_root once so the link provider can resolve
    // relative paths against the agent's cwd. Best-effort — if the daemon
    // doesn't know this session yet, link clicks still work for absolute paths.
    (async () => {
      try {
        const live = await api.ptyListAlive();
        const ours = live.find((s) => s.session_id === sessionId);
        if (ours?.repo_root) repoRootRef.current = ours.repo_root;
      } catch {
        /* daemon down — relative paths just won't resolve */
      }
    })();

    term.attachCustomKeyEventHandler((e) => {
      if (
        handleClipboardKey(e, {
          getSelection: () => term.getSelection(),
          writeBytes: (bytes) => {
            api.agentPtyWrite(sessionId, bytes).catch(() => {});
          },
        })
      ) {
        e.preventDefault();
        return false;
      }
      const bytes = mapKeyEvent(e);
      if (!bytes) return true;
      api.agentPtyWrite(sessionId, Array.from(bytes)).catch(() => {});
      e.preventDefault();
      return false;
    });

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let resizeObs: ResizeObserver | null = null;
    let cancelled = false;

    (async () => {
      api.agentPtyResize(sessionId, term.cols, term.rows).catch(() => {});

      // Backfill any bytes the PTY produced before this view mounted, then
      // subscribe to the live stream with no awaited work in between. There is
      // no per-byte sequence cursor to dedup an overlap, so we keep
      // replay-before-subscribe (a tiny gap and a possible lost byte) rather
      // than subscribe-first (which would double-write the overlapping tail).
      // Nothing may be awaited between these two calls — the session probe
      // that used to sit here cost bytes, and now runs in
      // `useAgentPtyLifecycle` where it consumes nothing.
      try {
        const tail = await api.agentPtyReplayBytes(sessionId);
        if (!cancelled && tail.length > 0) {
          term.write(new Uint8Array(tail));
        }
      } catch {
        /* unknown session — ignore */
      }

      unlistenData = await listen<PtyChunk>(`agent-pty:${sessionId}`, (e) => {
        if (cancelled) return;
        term.write(decodePtyChunk(e.payload));
      });

      // The pane's exited *state* belongs to the view; this marker is just the
      // buffer's own record of where the output stopped, so the final screen
      // reads as finished rather than merely frozen.
      unlistenExit = await listen(`agent-pty-exit:${sessionId}`, () => {
        if (cancelled) return;
        term.write("\r\n\x1b[2m[agent exited]\x1b[0m\r\n");
      });

      term.onData((data) => {
        const bytes = Array.from(new TextEncoder().encode(data));
        api.agentPtyWrite(sessionId, bytes).catch(() => {});
      });

      resizeObs = new ResizeObserver(() => {
        try {
          fit.fit();
          api.agentPtyResize(sessionId, term.cols, term.rows).catch(() => {});
        } catch {
          /* element may be detached mid-resize */
        }
      });
      resizeObs.observe(host);
    })();

    // Recolor in place when the theme changes. The subscription lives in this
    // effect because this effect owns `term` — hoisting a ref just to reach it
    // from outside would widen the file for nothing, and the terminal must not
    // outlive its own listener. Re-reads the tokens on each fire rather than
    // closing over a value, so it always paints the theme that is now active.
    const unsubscribeTheme = onThemePersist(() => {
      requestAnimationFrame(() => {
        try {
          term.options.theme = { ...THEME, ...xtermThemeFromTokens() };
        } catch {
          /* terminal disposed between the fire and the frame */
        }
      });
    });

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
      resizeObs?.disconnect();
      unsubscribeTheme();
      // Session outlives the tab; close happens via the Stop button.
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // In-app HTML5 drags (Files sidebar → terminal) get swallowed by xterm's own
  // viewport drag listeners before React's synthetic onDrop can fire — and if
  // the dragover is never preventDefault'd the browser rejects the drop
  // outright and the drag just snaps back ("disappears"). Bind native
  // CAPTURE-phase listeners on the host: capture runs host→descendant, so we
  // intercept dragover/drop before xterm can, which is what makes the drop
  // actually land. The native canvas needs none of this, which is why it sits
  // here and not in the shared drop module.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const over = (e: DragEvent) => {
      if (!acceptsAgentDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!acceptsAgentDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      applyAgentDrop(sessionId, e.dataTransfer);
    };
    host.addEventListener("dragover", over, true);
    host.addEventListener("drop", drop, true);
    return () => {
      host.removeEventListener("dragover", over, true);
      host.removeEventListener("drop", drop, true);
    };
  }, [sessionId]);

  return <div ref={hostRef} className="absolute inset-0 bg-bg-content" />;
}
