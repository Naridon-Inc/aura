// Raw xterm.js render of an agent PTY session. Single live xterm —
// users scroll up directly in the terminal while the live session
// keeps running. Agent CLIs run in alt-screen mode which bypasses
// xterm's scrollback by spec; that is an accepted trade-off here.

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { noteAgentTerminalTitle } from "../../lib/agentTerminalTitles";
import { handleClipboardKey, mapKeyEvent } from "../../lib/terminalKeymap";
import { registerFilePathLinks } from "../../lib/terminalLinks";
import { openExternal } from "../../lib/openExternal";
import { getSettings } from "../../lib/settingsStore";
import { playTerminalBell } from "../../lib/terminalBell";
import { Button } from "../ui/button";
import { AgentPausedPane } from "./AgentPausedPane";

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
  /** Which CLI this tab runs, its display name, and the checkout it runs in.
   *  Only the paused pane needs them — it reads the agent's own transcript to
   *  show what the conversation was about before offering to resume it. */
  agentId?: string;
  agentLabel?: string;
  repoRoot?: string;
  /** The agent's OWN session id this tab resumes (Claude's JSONL stem), not
   *  our PTY `sessionId`. */
  resumeSessionId?: string | null;
  /** Called when this view detects the PTY is gone — either dead at
   *  mount (post-restart / post-auto-update stale tab) or exited
   *  mid-session. The parent owns spawn, so it respawns with the same
   *  agent_id + repo_root and swaps tab.sessionId in place; this view
   *  remounts on the new id silently. No banner, no user friction.
   *  When unset, the view falls back to writing "[agent exited]" into
   *  the buffer (legacy behavior). */
  onAutoRespawn?: () => void | Promise<void>;
  /** Restart this agent because the user asked — the "Restart" banner and
   *  the dormant pane's "Start". Separate from `onAutoRespawn` because that
   *  prop doubles as the *silent* relaunch policy: a detached window
   *  deliberately withholds it so a dead agent never comes back on its own,
   *  and that decision used to disable the explicit Restart button too.
   *  Falls back to `onAutoRespawn` when unset, which is what the in-app
   *  surface wants — there, one spawn serves both. */
  onRestart?: () => void | Promise<void>;
  /** Cold/click-to-start. When true and the PTY is dead at mount, the
   *  view shows a "Start agent" affordance instead of silently
   *  respawning — a workspace restore must not relaunch a Claude
   *  process the user didn't ask for. Ignored when the PTY is alive
   *  (the view attaches as normal). Starting clears it upstream
   *  (replaceAgent gives a fresh, non-dormant tab). */
  dormant?: boolean;
  /** Total paused agents in the workspace. When >1 the dormant overlay
   *  offers a "Start all (N)" affordance alongside the single Start. */
  dormantCount?: number;
  /** Resume every paused agent at once. Only wired by the parent when
   *  more than one dormant tab exists. */
  onStartAll?: () => void | Promise<void>;
};

export function AgentTerminalView({
  sessionId,
  agentId,
  agentLabel,
  repoRoot,
  resumeSessionId,
  dormant,
  dormantCount,
  onStartAll,
  onAutoRespawn,
  onRestart,
}: Props) {
  // What an explicit Start/Restart click runs. Only the automatic paths
  // below read `onAutoRespawn` directly.
  const restart = onRestart ?? onAutoRespawn;
  const liveHostRef = useRef<HTMLDivElement>(null);
  const liveTermRef = useRef<XTerm | null>(null);
  // Cold restored tab whose PTY is gone — render the click-to-start
  // overlay instead of auto-respawning. Set only after the alive check
  // confirms the process is actually dead.
  const [showStart, setShowStart] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startingAll, setStartingAll] = useState(false);
  // Mid-session exit (claude `/exit`, quit, crash, or an intentional Stop).
  // Unlike a cold dormant restore — which covers the pane with a
  // click-to-start overlay — the terminal's final output is still worth
  // reading, so we surface a slim "exited · Restart" banner over the bottom
  // edge instead of a full cover. Cleared when the view remounts on a fresh
  // (restarted) sessionId.
  const [exited, setExited] = useState(false);
  // Captured on mount via api.ptyListAlive() so the file-path link
  // provider can resolve relative paths printed by the agent. Stays
  // null if the session can't be located (link clicks still work for
  // absolute paths in that case).
  const repoRootRef = useRef<string | undefined>(undefined);
  // Latched so a mid-session exit only triggers one respawn even if
  // the exit event fires multiple times before we unmount.
  const respawnFiredRef = useRef(false);

  useEffect(() => {
    respawnFiredRef.current = false;
    setShowStart(false);
    setStarting(false);
    setStartingAll(false);
    setExited(false);
  }, [sessionId]);

  useEffect(() => {
    const host = liveHostRef.current;
    if (!host) return;

    // Visual terminal prefs (settingsStore). Scrollback stays at the
    // agent-tuned 50000 regardless — long agent runs need the depth.
    const tprefs = getSettings().terminal;
    const term = new XTerm({
      theme: THEME,
      fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
      // 12.5 is this view's own tuning — half a point up on the shell
      // terminal, to sit closer to chat text. It is a default, though, not
      // a rule: this is a terminal pane, so a size chosen in Settings →
      // Terminal applies here too. Anything else and the one surface people
      // watch all day would be the one that ignored them.
      fontSize: tprefs.font_size ?? 12.5,
      letterSpacing: 0,
      lineHeight: 1.25,
      cursorBlink: tprefs.cursor_blink,
      allowProposedApi: true,
      scrollback: 50000,
    });
    if (tprefs.bell) {
      term.onBell(() => playTerminalBell());
    }
    liveTermRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The addon's default handler is `window.open`, which a Tauri webview
    // silently drops — the link underlines on hover and clicking does
    // nothing, which is exactly what an agent printing a docs/PR URL looks
    // like today. Route it through the opener plugin instead.
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

    // Take the keyboard the moment the terminal is on screen, the same way
    // the plain shell does on tab switch. Without this an agent could put a
    // question on screen — pi's "Trust project folder?", Claude's permission
    // prompts — and every key you pressed went nowhere, because focus was
    // still on whatever button started the session. Nothing looked broken;
    // the agent just sat there waiting while you typed at it.
    try {
      term.focus();
    } catch {
      /* noop */
    }

    // Snapshot the session's repo_root once so the link provider can
    // resolve relative paths against the agent's cwd. Best-effort — if
    // the daemon doesn't know this session yet, link clicks still work
    // for absolute paths.
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

      // Backfill any bytes the PTY produced before this view mounted,
      // then subscribe to the live stream with no awaited work in
      // between. There is no per-byte sequence cursor to dedup an
      // overlap, so we keep replay-before-subscribe (a tiny gap and a
      // possible lost byte) rather than subscribe-first (which would
      // double-write the overlapping tail). The gap is now just the
      // listen() registration — the stale-session probe that used to sit
      // here (two backend round-trips) is moved below the subscription so
      // output streaming while we probe is captured instead of dropped.
      try {
        const tail = await api.agentPtyReplayBytes(sessionId);
        if (!cancelled && tail.length > 0) {
          term.write(new Uint8Array(tail));
        }
      } catch {
        /* unknown session — ignore */
      }

      unlistenData = await listen<number[]>(`agent-pty:${sessionId}`, (e) => {
        if (cancelled) return;
        term.write(new Uint8Array(e.payload));
      });

      // v0.2.29 — Stale-session auto-respawn at mount. After an app
      // restart (or auto-update relaunch) the PTY child may already be
      // dead before we have a chance to subscribe to its exit event,
      // which left the xterm blank with no recovery path. If the
      // parent gave us onAutoRespawn we silently restart the session
      // here — the tab's sessionId gets swapped in place and this
      // component remounts on the new id, no banner. If the parent
      // didn't wire it, we leave the buffer empty (legacy behavior).
      // Runs AFTER the live subscription so any bytes the PTY emits
      // during the isAlive round-trip stream straight in; if we decide
      // to respawn / show the start overlay, unmount tears the listener
      // (and the about-to-be-registered exit listener) down anyway.
      try {
        const alive = await api.agentPtyIsAlive(sessionId);
        if (!cancelled && !alive) {
          // Cold restored tab: the PTY child is gone and the user never
          // asked to resume it (workspace restore re-stamps dormant).
          // Do NOT silently relaunch a Claude process — surface a
          // click-to-start overlay instead. This is the fix for
          // workspaces reopening with a swarm of self-spawned agents.
          if (dormant) {
            setShowStart(true);
            return;
          }
          // Live tab whose PTY died at mount (app restart / auto-update
          // relaunch). Restore in place, no banner (v0.2.29 behavior).
          if (onAutoRespawn && !respawnFiredRef.current) {
            respawnFiredRef.current = true;
            // Fire-and-forget — the parent's replaceAgent will unmount us.
            Promise.resolve(onAutoRespawn()).catch(() => {});
            return;
          }
        }
      } catch {
        /* daemon down — leave the live state alone */
      }

      unlistenExit = await listen(`agent-pty-exit:${sessionId}`, () => {
        if (cancelled) return;
        // The agent process ended — claude `/exit`, gemini quit, a crash,
        // or an intentional Stop. We deliberately do NOT auto-respawn on
        // exit: silently relaunching on every exit is exactly what spun up
        // the "swarm of self-spawning Claude instances" the user hit when
        // closing tabs (each Stop killed the PTY, the exit event fired a
        // fresh spawn, and replaceAgent — finding the tab already gone —
        // opened a brand-new one). Surface the dead state instead: the
        // header flips to "exited" and the pane menu offers an explicit
        // Restart. The mount-time recovery above still seamlessly resumes a
        // PTY that died under a still-live tab (app restart / auto-update).
        term.write("\r\n\x1b[2m[agent exited]\x1b[0m\r\n");
        // Flip the pane into an explicit exited state. The slim Restart
        // banner (see render) replaces the silent frozen buffer the user
        // used to be left staring at — without hiding the final output.
        setExited(true);
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

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
      resizeObs?.disconnect();
      // Session outlives the tab; close happens via the Stop button.
      term.dispose();
      liveTermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // A dropped file/clip becomes input at the agent's prompt. External OS drops
  // (from Finder) are routed by osFileDrop.ts through Tauri's native channel;
  // THIS path handles in-app HTML5 drags — a file dragged out of the Files
  // sidebar, or an image clip from the tray.
  const acceptsDrag = (dt: DataTransfer | null) =>
    !!dt &&
    (dt.types.includes("text/uri-list") ||
      dt.types.includes("text/plain") ||
      dt.types.includes("Files") ||
      dt.types.includes("application/x-aura-clip"));

  const applyDrop = (dt: DataTransfer | null) => {
    if (!dt) return;
    const auraClipRaw = dt.getData("application/x-aura-clip");
    if (auraClipRaw) {
      try {
        const meta = JSON.parse(auraClipRaw) as { id: string; kind: string };
        if (meta.kind === "image" && meta.id) {
          api
            .clipsCopyImageToOs(meta.id)
            .then(() => {
              api.agentPtyWrite(sessionId, [0x16]).catch(() => {});
            })
            .catch(() => {
              const path = (JSON.parse(auraClipRaw) as { path: string }).path;
              const text = /\s/.test(path) ? `"${path}"` : path;
              const bytes = Array.from(new TextEncoder().encode(text + " "));
              api.agentPtyWrite(sessionId, bytes).catch(() => {});
            });
          return;
        }
      } catch {
        /* malformed payload */
      }
    }
    const uri = dt.getData("text/uri-list");
    const plain = dt.getData("text/plain");
    const paths: string[] = [];
    if (uri && uri.length > 0) {
      for (const line of uri.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        paths.push(
          line.startsWith("file://")
            ? decodeURIComponent(line.slice("file://".length))
            : line,
        );
      }
    } else if (plain && plain.length > 0) {
      // The Files sidebar joins a multi-selection with newlines — split so
      // each becomes its own quoted argument rather than one bogus glob.
      for (const line of plain.split(/\r?\n/)) {
        const p = line.trim();
        if (p) paths.push(p);
      }
    } else if (dt.files && dt.files.length > 0) {
      for (const f of Array.from(dt.files) as unknown as { path?: string }[]) {
        if (f.path) paths.push(f.path);
      }
    }
    if (paths.length === 0) return;
    const joined = paths
      .map((p) => (/\s/.test(p) ? `"${p}"` : p))
      .join(" ");
    const bytes = Array.from(new TextEncoder().encode(joined + " "));
    api.agentPtyWrite(sessionId, bytes).catch(() => {});
  };

  const onDragOver = (e: React.DragEvent) => {
    if (acceptsDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!acceptsDrag(e.dataTransfer)) return;
    e.preventDefault();
    applyDrop(e.dataTransfer);
  };

  // In-app HTML5 drags (Files sidebar → terminal) get swallowed by xterm's own
  // viewport drag listeners before React's synthetic onDrop can fire — and if
  // the dragover is never preventDefault'd the browser rejects the drop outright
  // and the drag just snaps back ("disappears"). Bind native CAPTURE-phase
  // listeners on the host: capture runs host→descendant, so we intercept
  // dragover/drop before xterm can, which is what makes the drop actually land.
  useEffect(() => {
    const host = liveHostRef.current;
    if (!host) return;
    const over = (e: DragEvent) => {
      if (!acceptsDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!acceptsDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      applyDrop(e.dataTransfer);
    };
    host.addEventListener("dragover", over, true);
    host.addEventListener("drop", drop, true);
    return () => {
      host.removeEventListener("dragover", over, true);
      host.removeEventListener("drop", drop, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const handleStart = async () => {
    if (!restart || starting || startingAll) return;
    setStarting(true);
    try {
      // Spawns a fresh PTY upstream; replaceAgent swaps tab.sessionId so
      // this view remounts live (dormant cleared) and the overlay drops.
      await restart();
    } catch {
      // Spawn failed — let the user retry rather than stranding the tab.
      setStarting(false);
    }
  };

  const handleStartAll = async () => {
    if (!onStartAll || starting || startingAll) return;
    setStartingAll(true);
    try {
      // Resumes every paused agent; this tab is one of them, so its
      // replaceAgent remounts the view live and the overlay drops.
      await onStartAll();
    } catch {
      setStartingAll(false);
    }
  };

  return (
    <div className="h-full w-full relative">
      <div
        ref={liveHostRef}
        className="absolute inset-0 bg-bg-content"
        data-os-drop="terminal"
        data-agent-session={sessionId}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
      {showStart && (
        <AgentPausedPane
          agentId={agentId}
          agentLabel={agentLabel}
          repoRoot={repoRoot}
          resumeSessionId={resumeSessionId}
          dormantCount={dormantCount}
          starting={starting}
          startingAll={startingAll}
          canStart={Boolean(restart)}
          onStart={handleStart}
          onStartAll={onStartAll ? handleStartAll : undefined}
        />
      )}
      {exited && !showStart && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-line-soft bg-bg-1/95 px-4 py-2.5 backdrop-blur-sm">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--color-text-4)" }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-2">Agent exited</div>
            <div className="truncate text-xs text-text-4">
              The session ended. Aura won't relaunch it automatically.
            </div>
          </div>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={handleStart}
            disabled={starting || !restart}
          >
            {starting ? "Restarting…" : "Restart"}
          </Button>
        </div>
      )}
    </div>
  );
}
