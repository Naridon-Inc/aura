// The floating, always-on-top HUD — the surface summoned with ⌘⇧A (or the
// menu-bar icon). It renders inside its own frameless, transparent OS window
// (`hud.rs` builds it; `main.tsx` mounts this when the URL carries `?hud=1`).
//
// Visual model: ONE Apple-glass pill. Collapsed it's a single glance row —
// status · what the agent just said (its brand icon, not its name) · the
// workspace. Hover it or focus the composer and it grows UPWARD into the full
// surface: the you↔agent exchange and a docked composer. The pill is
// content-sized; a ResizeObserver measures it and drives the OS window + native
// frost to match via `hud_resize` (the window grows upward; see `hud.rs`).
//
// It owns no chat state: it listens to `hud:state` the main window publishes and
// sends quick replies back via `hud:send`. The workspace selector pops a NATIVE
// system menu (built in `hud.rs`), fed from backend truth (`lib/hudProjects`):
// distinct projects with live agent counts, each drillable to its worktree
// instances — a native NSMenu floats over fullscreen instead of being clipped to
// the tiny HUD window the way an in-webview dropdown would be.

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AgentIcon } from "../agent/AgentIcon";
import { MarkdownInline } from "../MarkdownView";
import { Pet } from "./Pet";
import { api } from "../../lib/api";
import {
  emitHudRequestFull,
  emitHudRequestHistory,
  emitHudSelectProject,
  emitHudSend,
  HUD_IDLE_STATE,
  type HudMenuKind,
  type HudPresentationMode,
  type HudState,
  type HudStatusKind,
  type HudTurn,
  onHudFullMessage,
  onHudHistory,
  onHudMenuPick,
  onHudSettings,
  onHudState,
  openHudMenu,
  requestHudState,
} from "../../lib/hud";
import { useHudComposer } from "../../lib/hudComposer";
import {
  type HudModel,
  isManagedWorktreeRoot,
  loadHudModel,
  loadInstances,
  prettyLeaf,
  sameRoot,
} from "../../lib/hudProjects";
import { useResolvedTheme } from "../../lib/themeStore";
import "./hud.css";

function basename(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

// Short, plain-language status labels (no engineer jargon — "Ready", not
// "Idle"). The chip stays glanceable; richer phrasing lives in the glance line.
const STATUS_LABEL: Record<HudStatusKind, string> = {
  idle: "Ready",
  thinking: "Thinking…",
  running: "Working…",
  awaiting_input: "Needs you",
  done: "Done",
  error: "Error",
};

// Per-status count buckets shown under the pill — "Needs you" leads (it's what
// you act on). `kind` picks the glyph; the count rolls thinking+running into one
// "Working" bucket so the strip stays short.
const COUNT_ORDER = [
  { key: "awaiting_input", kind: "awaiting_input", label: "Needs you" },
  { key: "working", kind: "running", label: "Working" },
  { key: "done", kind: "done", label: "Done" },
  { key: "error", kind: "error", label: "Error" },
  { key: "idle", kind: "idle", label: "Ready" },
] as const;

type CountKey = (typeof COUNT_ORDER)[number]["key"];

const EMPTY_MODEL: HudModel = { projects: [], activeProjectId: null };

// Transparent gutter around the pill on every side — MUST equal hud.rs
// HUD_GUTTER. It holds the soft drop shadow (so it can't clip at the window
// edge) and is the inset the native frost is laid out to.
const GUTTER = 48;

// The HUD's presentation mode + opacity live in shared localStorage (the
// settingsStore mirror), so the HUD's own heap can read them synchronously at
// mount — no round-trip to the main window before the first paint. These keys
// MUST match settingsStore's `LS.hudMode` / `LS.hudOpacity`.
function readHudModeLS(): HudPresentationMode {
  try {
    const raw = localStorage.getItem("aura.hud.mode");
    return raw === "sidebar" || raw === "minimal" || raw === "ambient"
      ? raw
      : "capsule";
  } catch {
    return "capsule";
  }
}

function readHudOpacityLS(): number {
  try {
    const raw = localStorage.getItem("aura.hud.opacity");
    const n = raw == null ? 1 : Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0.2, n)) : 1;
  } catch {
    return 1;
  }
}

// The desk-pet toggle (settingsStore's `LS.hudPet`). Read synchronously at mount
// so the pet paints with the first frame; kept live via `hud:settings`.
function readHudPetLS(): boolean {
  try {
    return localStorage.getItem("aura.hud.pet") !== "false";
  } catch {
    return true;
  }
}

// Sidebar panel dims (px) live in shared localStorage too; read at mount and
// kept live via `hud:settings`. Clamped to the same ranges Settings enforces.
function readHudNumLS(key: string, fallback: number, lo: number, hi: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? fallback : Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  } catch {
    return fallback;
  }
}

// Sidebar suggestion chips — one-tap quick replies (sent verbatim, threaded
// through the active conversation like any other send).
const SIDEBAR_CHIPS = ["Summarize the changes", "Any risks?", "What's next?"];

// Compact time-taken: "8s", "2m 5s", "1h 3m". Mirrors the Aura-chat footer's
// reply duration (the gap to the prompt it answered).
function fmtDuration(sec: number): string {
  if (sec < 1) return "<1s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const CopyGlyph = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const OpenGlyph = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

// One turn in the sidebar thread. The user side is a plain right-aligned
// bubble; the agent side carries the brand mark + a meta row (time-taken · copy
// · open) — parity with the in-app Aura chat footer.
function SidebarTurn({ turn, onOpen }: { turn: HudTurn; onOpen: () => void }) {
  const copy = useCallback(() => {
    if (turn.text) void navigator.clipboard?.writeText(turn.text).catch(() => {});
  }, [turn.text]);

  // No brand mark on either side — the bubble colour already says who spoke
  // (right/tinted = you, left/white = the agent), so a logo per row is noise.
  if (turn.role === "user") {
    return (
      <div className="hud-sb-turn hud-sb-turn-user">
        <div className="hud-sb-bubble hud-sb-bubble-user">
          <MarkdownInline source={turn.text} className="hud-md" />
        </div>
      </div>
    );
  }
  return (
    <div className="hud-sb-turn hud-sb-turn-agent">
      <div className="hud-sb-bubble hud-sb-bubble-agent">
        <MarkdownInline source={turn.text} className="hud-md" />
        <div className="hud-sb-meta">
          {turn.durationSec != null ? (
            <span className="hud-sb-took" title="Time taken">
              {fmtDuration(turn.durationSec)}
            </span>
          ) : null}
          <button type="button" className="hud-sb-act" onClick={copy} title="Copy this reply">
            {CopyGlyph}
            Copy
          </button>
          <button type="button" className="hud-sb-act" onClick={onOpen} title="Open in project">
            {OpenGlyph}
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

// A small "you" mark for the human side of the exchange — pairs with the agent's
// brand icon so neither side is spelled out in words.
const YOU_MARK = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="8" cy="5.4" r="3.1" />
    <path d="M2.4 14a5.6 5.6 0 0 1 11.2 0z" />
  </svg>
);

export function HudApp() {
  const [state, setState] = useState<HudState>(HUD_IDLE_STATE);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [model, setModel] = useState<HudModel>(EMPTY_MODEL);
  // Presentation mode (shape). Read synchronously from shared localStorage so
  // the very first paint is already in the right shape; kept live by the mount
  // effect + the `hud:settings` subscription below.
  const [mode, setMode] = useState<HudPresentationMode>(readHudModeLS);
  const [petOn, setPetOn] = useState(readHudPetLS);
  // The sidebar panel has a light + a dark skin; follow the app's resolved
  // theme so it matches the rest of the desktop instead of always glaring
  // white. Reads the shared `aura.theme` (same origin) and updates live when
  // the main window flips theme (themeStore listens to the cross-heap storage
  // event). Capsule/Minimal keep their own glass regardless of this.
  const resolvedTheme = useResolvedTheme();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Sidebar panel dims (px) — drive CSS vars; the measured panel then carries
  // its size to the OS window via the existing ResizeObserver → hud_resize.
  const [sidebarW, setSidebarW] = useState(() =>
    readHudNumLS("aura.hud.sidebarWidth", 320, 240, 480),
  );
  const [sidebarH, setSidebarH] = useState(() =>
    readHudNumLS("aura.hud.sidebarHeight", 520, 320, 900),
  );
  const ambient = mode === "ambient";
  // Sidebar collapses to a FAB nub that only EXPANDS on an explicit click (a
  // right-edge dock shouldn't unfold on an accidental hover the way the capsule
  // does). Capsule/minimal keep the hover-to-expand feel.
  const [sideOpen, setSideOpen] = useState(false);
  // The full-response reader popover. `body === null` while the request is in
  // flight (a tiny "Loading…" state); filled when the publisher replies.
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerBody, setReaderBody] = useState<{ user: string; agent: string } | null>(
    null,
  );
  const readerOpenRef = useRef(readerOpen);
  readerOpenRef.current = readerOpen;
  const readerRef = useRef<HTMLDivElement | null>(null);
  // Latest shown conversation key — lets async event handlers drop replies that
  // arrive after the user switched conversations.
  const shownKeyRef = useRef(state.shownKey);
  shownKeyRef.current = state.shownKey;
  // Sidebar thread: the recent turns (oldest → newest). null = not fetched yet.
  const [historyTurns, setHistoryTurns] = useState<HudTurn[] | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composer = useHudComposer();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);

  const activeRoot = state.activeRoot ?? null;
  // Expanded = the user is interacting. Capsule/minimal expand on hover or a
  // focused composer; sidebar expands only on an explicit FAB click (or while
  // the composer holds focus). The workspace switcher is a native system menu,
  // so it needs no expand state of its own.
  // Opening the reader forces the pill expanded so the exchange shows — the
  // full response expands in place of the agent's truncated line. Ambient is an
  // immersive surface — always expanded (it never collapses to a glance).
  const expanded =
    ambient ||
    readerOpen ||
    (mode === "sidebar" ? sideOpen || focused : hovering || focused);

  // The agent's identity for the brand icon — its real id when a coding agent is
  // active, else Aura (the native orchestrator).
  const agentId =
    state.target?.kind === "agent" ? state.target.agentId : "aura-manager";
  const agentLabel =
    state.target?.kind === "agent" ? state.target.agentLabel : "Aura";

  // Subscribe to the main window's snapshots, and ask for one immediately so
  // a freshly-opened HUD isn't blank until the next change.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudState(setState).then((f) => {
      un = f;
    });
    void requestHudState();
    return () => un?.();
  }, []);

  // Re-request whenever the window is shown again (it's hidden, not destroyed,
  // between summons). Don't auto-focus — the HUD opens collapsed; the user
  // hovers or focuses the composer to expand it.
  useEffect(() => {
    const onFocus = () => void requestHudState();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Resolve the project model (distinct projects + live agent counts) from the
  // backend. Cheap; refreshed on mount, when the active project changes, and
  // while the switcher is open.
  const refreshModel = useCallback(() => {
    void loadHudModel(activeRoot).then(setModel);
  }, [activeRoot]);

  useEffect(() => {
    refreshModel();
  }, [refreshModel]);

  // Poll only while expanded and visible, so the workspace label + the counts
  // the menu reads stay live as agents start/finish, without burning cycles on a
  // collapsed bar.
  useEffect(() => {
    if (!expanded) return;
    refreshModel();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshModel();
    }, 5000);
    return () => clearInterval(id);
  }, [expanded, refreshModel]);

  // Drive the OS window + native frost to the pill's measured size (the pill is
  // content-sized — gutters hold the shadow; see hud.rs).
  const applyResize = useCallback(() => {
    const el = pillRef.current;
    if (!el) return;
    const pillH = el.offsetHeight;
    const height = pillH + 2 * GUTTER;
    // Sidebar sizes its window to the measured content width too, so the
    // collapsed FAB shrinks the window to a nub (instead of a half-screen
    // transparent column) and the expanded panel widens it. Capsule/minimal
    // keep their fixed wide bar — pass null so Rust uses the mode default.
    const width =
      modeRef.current === "sidebar" ? el.offsetWidth + 2 * GUTTER : null;
    void invoke("hud_resize", { height, capsule: pillH, width });
  }, []);

  // The pill is content-sized — measure it and resize the window to match
  // whenever it grows/shrinks (collapse ↔ expand, a new glance line, etc.).
  useEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => applyResize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyResize]);

  // Apply the presentation mode: drive the CSS (`data-hud-mode` on <html>) and
  // the native window shape (`hud_set_mode` re-anchors + re-fits the frost),
  // then re-measure — the just-changed CSS shape needs the window refit even if
  // the height happens to match (so a ResizeObserver tick isn't guaranteed).
  useEffect(() => {
    document.documentElement.dataset.hudMode = mode;
    void api.hudSetMode(mode).catch(() => {});
    applyResize();
  }, [mode, applyResize]);

  // Skin the sidebar to light/dark. `data-hud-theme` rides on <html> next to
  // data-hud-mode; hud.css swaps the sidebar palette on it. Other modes ignore
  // it (they carry their own glass).
  useEffect(() => {
    document.documentElement.dataset.hudTheme = resolvedTheme;
  }, [resolvedTheme]);

  // Push the sidebar dims into CSS vars; the panel sizes to them and the
  // ResizeObserver carries the new size to the OS window. (No-op visually
  // unless the sidebar is the active mode, but harmless to keep current.)
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--hud-sidebar-w", `${sidebarW}px`);
    root.style.setProperty("--hud-sidebar-h", `${sidebarH}px`);
    // Persist so a drag-resize (or Settings change) survives the HUD reopening
    // — HudApp reads these back at mount. Shared origin, so Settings sees it too.
    try {
      localStorage.setItem("aura.hud.sidebarWidth", String(sidebarW));
      localStorage.setItem("aura.hud.sidebarHeight", String(sidebarH));
    } catch {
      /* private mode / quota — non-fatal */
    }
    applyResize();
  }, [sidebarW, sidebarH, applyResize]);

  // Apply the saved opacity once at mount (the native window alpha). Live
  // changes arrive via `hud:settings` below.
  useEffect(() => {
    void api.hudSetOpacity(readHudOpacityLS()).catch(() => {});
  }, []);

  // Settings → HUD changed the shape/opacity in the main window: apply live.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudSettings((p) => {
      setMode(p.mode);
      setSidebarW(Math.min(480, Math.max(240, p.sidebarWidth)));
      setSidebarH(Math.min(900, Math.max(320, p.sidebarHeight)));
      void api.hudSetOpacity(p.opacity).catch(() => {});
      if (typeof p.pet === "boolean") setPetOn(p.pet);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // Sidebar lives collapsed as a FAB; an attention event (the agent needs the
  // user) auto-unfolds the panel — the "come find me" the capsule gets for free
  // by always showing its glance.
  useEffect(() => {
    if (mode === "sidebar" && state.status === "awaiting_input") setSideOpen(true);
  }, [mode, state.status]);

  // Full-response reader: open → ask the publisher for the un-summarised text
  // of the shown conversation; fill the popover when the reply lands (guarded
  // so a late reply after close is ignored).
  const openReader = useCallback(() => {
    setReaderOpen(true);
    setReaderBody(null);
    void emitHudRequestFull({ shownKey: state.shownKey ?? "" });
  }, [state.shownKey]);

  const closeReader = useCallback(() => {
    setReaderOpen(false);
    setReaderBody(null);
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudFullMessage((p) => {
      if (!readerOpenRef.current) return;
      setReaderBody({ user: p.user, agent: p.agent });
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // The sidebar panel reads like a chat — a scrollable thread of recent turns,
  // not just the last reply. Ask the publisher for the thread (a round-trip; the
  // steady snapshot is glance-only) whenever the panel is open and the
  // conversation changes or a reply completes. Skipped while streaming (partial)
  // so we don't refetch on every chunk.
  const requestHistory = useCallback(() => {
    void emitHudRequestHistory({ shownKey: state.shownKey ?? "" });
  }, [state.shownKey]);

  useEffect(() => {
    if (mode !== "sidebar" || !expanded) return;
    if (state.lastAgent?.partial) return;
    requestHistory();
  }, [mode, expanded, state.shownKey, state.lastAgent, requestHistory]);

  // Fill the thread when the publisher replies; reset when the conversation
  // changes so a stale thread doesn't flash before the new one lands.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudHistory((p) => {
      // Drop a reply for a conversation we've since navigated away from.
      if ((p.shownKey ?? "") !== (shownKeyRef.current ?? "")) return;
      setHistoryTurns(p.turns);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);
  useEffect(() => {
    setHistoryTurns(null);
  }, [state.shownKey]);

  // Pin the thread to the bottom (newest) as turns land — like a chat log.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyTurns]);

  // While the reader is open, Esc collapses the full response back to the
  // glance. It expands inline in the exchange, so there's no outside-click to
  // dismiss — clicking the composer to reply must keep the response open.
  useEffect(() => {
    if (!readerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture-phase + stop, so the reader is the FIRST rung of the Esc
        // ladder (it closes before the composer's blur/dismiss handler runs).
        e.preventDefault();
        e.stopPropagation();
        closeReader();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [readerOpen, closeReader]);

  const dismiss = useCallback(() => {
    void invoke("hud_hide");
  }, []);

  const send = useCallback(() => {
    const body = text.trim();
    if (!body) return;
    // Fold the toolbar chips (mode / effort / fast / approvals / brain·model)
    // into the send — the publisher routes them through sendAmbientManagerTurn.
    void emitHudSend({ text: body, target: state.target, ...composer.toConfig() });
    setText("");
  }, [text, state.target, composer]);

  // Sidebar quick-actions (the suggestion chips). Same route as `send`, but with
  // a fixed prompt instead of the composer text — so a chip is a one-tap reply.
  const quickSend = useCallback(
    (body: string) => {
      if (!state.canSend) return;
      void emitHudSend({ text: body, target: state.target, ...composer.toConfig() });
    },
    [state.canSend, state.target, composer],
  );

  // Sidebar "Open in project" → ask the main window to focus this
  // conversation's project (same route the workspace switcher uses). Used by
  // each agent turn's "Open" action in the thread.
  const openInProject = useCallback(() => {
    if (state.activeRoot) void emitHudSelectProject({ root: state.activeRoot });
  }, [state.activeRoot]);

  // Drag-to-resize the sidebar panel from its left/bottom edges. Use SCREEN
  // coords (not client) for the delta — the OS window itself grows + re-docks to
  // the right edge as the panel resizes, which would make client coords jump.
  // Pointer capture keeps move/up flowing to the grip past the moving window.
  const resizeDrag = useRef<{
    axis: "w" | "h" | "wh";
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const onGripDown = useCallback(
    (axis: "w" | "h" | "wh") => (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointer events still fire on the element */
      }
      resizeDrag.current = { axis, x: e.screenX, y: e.screenY, w: sidebarW, h: sidebarH };
    },
    [sidebarW, sidebarH],
  );

  const onGripMove = useCallback((e: ReactPointerEvent) => {
    const d = resizeDrag.current;
    if (!d) return;
    // Left edge drags toward screen center (screenX shrinks) → wider.
    if (d.axis === "w" || d.axis === "wh") {
      setSidebarW(Math.min(480, Math.max(240, Math.round(d.w + (d.x - e.screenX)))));
    }
    // Bottom edge drags down (screenY grows) → taller.
    if (d.axis === "h" || d.axis === "wh") {
      setSidebarH(Math.min(900, Math.max(320, Math.round(d.h + (e.screenY - d.y)))));
    }
  }, []);

  const onGripUp = useCallback((e: ReactPointerEvent) => {
    if (!resizeDrag.current) return;
    resizeDrag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
  }, []);

  // Drag the collapsed FAB to reposition the whole HUD window. A small movement
  // threshold tells a tap (→ open the panel) from a drag (→ move the OS window
  // via Tauri's window drag; the Moved handler persists the new spot, and the
  // Rust resize() keeps the FAB's origin instead of re-docking it). No pointer
  // capture: the 4px threshold stays well within the FAB, and once startDragging
  // takes over the OS owns the gesture.
  const fabDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onFabDown = useCallback((e: ReactPointerEvent) => {
    fabDrag.current = { x: e.screenX, y: e.screenY, moved: false };
  }, []);
  const onFabMove = useCallback((e: ReactPointerEvent) => {
    const d = fabDrag.current;
    if (!d || d.moved) return;
    if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 4) {
      d.moved = true;
      void getCurrentWindow().startDragging();
    }
  }, []);
  const onFabClick = useCallback(() => {
    // Swallow the click that ends a drag; a genuine tap opens the panel.
    if (fabDrag.current?.moved) {
      fabDrag.current = null;
      return;
    }
    setSideOpen(true);
  }, []);

  // Pop a composer chip's native menu just below the chip. A pick routes back
  // through `hud:menu-pick` (see menu.rs) → applyPick updates the chip. Native
  // NSMenu (not a Radix dropdown) so the list floats over fullscreen instead of
  // being clipped to the tiny HUD window — same reason as the workspace menu.
  const openChip = useCallback(
    (kind: HudMenuKind) => (e: React.MouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      void openHudMenu(kind, composer.menuItems(kind), rect.left, rect.bottom + 4);
    },
    [composer],
  );

  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudMenuPick((p) => composer.applyPick(p.kind, p.id)).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [composer.applyPick]);

  // Pop the native workspace menu at the trigger. A native NSMenu has no lazy
  // submenu hook, so load every project's instances upfront (cheap: usually 1–3
  // projects), then hand the whole tree to Rust. Selecting a row comes back as a
  // `hud:select-project` event the main window routes (see menu.rs).
  const openWorkspaceMenu = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      const groups = model.projects;
      if (groups.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const lists = await Promise.all(groups.map((p) => loadInstances(p)));
      const projects = groups.map((p, i) => ({
        label: p.label,
        active: p.id === model.activeProjectId,
        running: p.running,
        instances: lists[i].map((inst) => ({
          label: inst.label,
          root: inst.root,
          checked: sameRoot(inst.root, activeRoot),
          running: inst.running,
        })),
      }));
      void invoke("hud_workspace_menu", { projects, x: rect.left, y: rect.top });
    },
    [model, activeRoot],
  );

  // Per-status tallies across the active project's fleet (drives the labels
  // under the pill). thinking+running collapse into "Working".
  const counts = useMemo(() => {
    const c: Record<CountKey, number> = {
      awaiting_input: 0,
      working: 0,
      done: 0,
      error: 0,
      idle: 0,
    };
    for (const a of state.agents) {
      if (a.status === "awaiting_input") c.awaiting_input += 1;
      else if (a.status === "thinking" || a.status === "running") c.working += 1;
      else if (a.status === "done") c.done += 1;
      else if (a.status === "error") c.error += 1;
      else c.idle += 1;
    }
    return c;
  }, [state.agents]);

  // Pop the native fleet menu — agents grouped by state, each clickable to point
  // the glance at it. The pick comes back as `hud:focus-agent` (see menu.rs) and
  // the publisher re-aims the glance. Same NSMenu reasons as the workspace menu.
  const openAgentsMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (state.agents.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const agents = state.agents.map((a) => ({
        key: a.key,
        label: a.label,
        status: a.status,
        checked: a.key === state.shownKey,
      }));
      void invoke("hud_agents_menu", { agents, x: rect.left, y: rect.top });
    },
    [state.agents, state.shownKey],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Esc ladder: blur (collapse) → dismiss the HUD.
        if (focused) inputRef.current?.blur();
        else dismiss();
      }
    },
    [send, dismiss, focused],
  );

  const busy = state.status === "thinking" || state.status === "running";

  // Sidebar's collapsed state is a single FAB nub (not the glance row); every
  // other mode keeps a glanceable collapsed bar.
  const sidebarCollapsed = mode === "sidebar" && !expanded;

  // Expanded sidebar = the light "panel" experience (its own body layout: full
  // markdown reply + action card + chips), distinct from the dark-glass capsule.
  const sidebarPanel = mode === "sidebar" && expanded;

  // Ambient idle: nothing has been said yet — show the greeting instead of an
  // empty exchange (and not while the reader is expanding a past reply).
  const showGreeting =
    ambient && !readerOpen && !state.lastUser && !state.lastAgent;

  // Header label: "<project> · <instance>" when sitting in a worktree copy, so
  // "granada" reads as "a copy of New Git", not a mystery project.
  const activeProject =
    model.projects.find((p) => p.id === model.activeProjectId) ?? null;
  const headerLabel = activeProject
    ? activeRoot && isManagedWorktreeRoot(activeRoot)
      ? `${activeProject.label} · ${prettyLeaf(basename(activeRoot))}`
      : activeProject.label
    : activeRoot
      ? prettyLeaf(basename(activeRoot))
      : "No project";

  // Collapsed glance text: what the agent last said, falling back to the plain
  // status when it hasn't spoken yet. Use `||` (not `??`) so an EMPTY string —
  // a reply that summarised to nothing — still falls back to the status label
  // instead of rendering a blank pill.
  const glanceText = state.lastAgent?.text?.trim() || STATUS_LABEL[state.status];

  const statusBit = (
    <span className="hud-status">
      <StatusGlyph status={state.status} size={13} busy={busy} />
      <span className="hud-status-label">{STATUS_LABEL[state.status]}</span>
    </span>
  );

  // The workspace switcher — a plain pill that pops a NATIVE system menu (built
  // in hud.rs) so the list can float over the pill / fullscreen instead of being
  // clipped to the tiny HUD window.
  const workspace = (
    <button
      type="button"
      className="hud-workspace"
      disabled={model.projects.length === 0}
      title={activeRoot ?? undefined}
      onClick={openWorkspaceMenu}
    >
      <span className="hud-workspace-name">{headerLabel}</span>
      <span className="hud-workspace-caret" aria-hidden>
        ▾
      </span>
    </button>
  );

  return (
    <div className={`hud-root hud-status-${state.status}`}>
      {petOn && !sidebarCollapsed ? <Pet status={state.status} /> : null}
      <div
        ref={pillRef}
        className={`hud-pill${expanded ? " is-expanded" : ""}`}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
      >
        {sidebarCollapsed ? (
          // Sidebar nub: a circular brand FAB. Tap unfolds the panel; drag moves
          // the HUD anywhere; an attention event unfolds it on its own (effect
          // above).
          <button
            type="button"
            className="hud-fab"
            onPointerDown={onFabDown}
            onPointerMove={onFabMove}
            onClick={onFabClick}
            title={glanceText}
            aria-label="Open Aura — drag to move"
          >
            <span className="hud-avatar">
              <AgentIcon agentId={agentId} label={agentLabel} size={20} />
            </span>
            {busy ? <span className="hud-fab-pulse" aria-hidden /> : null}
          </button>
        ) : (
          <>
        {/* Sidebar drag-to-resize edges (left = width, bottom = height,
            bottom-left = both). Outside the drag-region so they resize, not move,
            the window. */}
        {sidebarPanel ? (
          <>
            <div
              className="hud-sb-grip hud-sb-grip-l"
              onPointerDown={onGripDown("w")}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
            />
            <div
              className="hud-sb-grip hud-sb-grip-b"
              onPointerDown={onGripDown("h")}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
            />
            <div
              className="hud-sb-grip hud-sb-grip-bl"
              onPointerDown={onGripDown("wh")}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
            />
          </>
        ) : null}
        {/* Top row. Collapsed it's a clean glance — just the agent's mark + what
            it last said (status + workspace live in the subcaption below the
            pill). Expanded it becomes a header: status (left) · workspace (right),
            with the exchange + composer beneath. It's the drag handle; the
            interactive controls inside still take their own clicks. */}
        <div className="hud-head" data-tauri-drag-region>
          {expanded ? (
            <>
              {statusBit}
              {workspace}
              {mode === "sidebar" ? (
                <button
                  type="button"
                  className="hud-sb-collapse"
                  onClick={() => {
                    setSideOpen(false);
                    closeReader();
                  }}
                  title="Collapse"
                  aria-label="Collapse"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2.5" />
                    <path d="M15 4v16" />
                  </svg>
                </button>
              ) : null}
            </>
          ) : (
            <span className="hud-glance">
              <span className="hud-avatar">
                <AgentIcon agentId={agentId} label={agentLabel} size={15} />
              </span>
              <span className="hud-msg">
                {glanceText}
                {state.lastAgent?.partial ? <span className="hud-caret" /> : null}
              </span>
              {state.lastAgent ? (
                <button
                  type="button"
                  className="hud-expand"
                  onClick={openReader}
                  aria-label="Read full response"
                  title="Read full response"
                >
                  <ExpandGlyph />
                </button>
              ) : null}
            </span>
          )}
        </div>

        {expanded && (
          <>
            {sidebarPanel ? (
              // Sidebar panel: a scrollable chat thread of recent turns (in AND
              // out), each agent reply carrying its time-taken + copy/open — the
              // tall panel has room for more than the last exchange.
              <div className="hud-sb-body" ref={threadRef}>
                {historyTurns && historyTurns.length > 0 ? (
                  historyTurns.map((t, i) => (
                    <SidebarTurn key={`${t.at}-${i}`} turn={t} onOpen={openInProject} />
                  ))
                ) : historyTurns === null ? (
                  <span className="hud-sb-empty">Loading…</span>
                ) : (
                  <span className="hud-sb-empty">No messages yet — ask below.</span>
                )}
              </div>
            ) : showGreeting ? (
              // Ambient idle: a centred sparkle + invitation (Gemini-style), in
              // place of an empty exchange. Once a turn lands, the exchange shows.
              <div className="hud-greeting">
                <AmbientSpark />
                <div className="hud-greeting-text">Where should we start?</div>
              </div>
            ) : (
            <div className="hud-lines">
              <Line
                icon={<span className="hud-avatar hud-avatar-you">{YOU_MARK}</span>}
                text={state.lastUser?.text}
                muted={!state.lastUser}
              />
              {readerOpen ? (
                // The agent's full reply, expanded in place — its truncated
                // line grows into the whole response (scrolls past ~300px; the
                // ResizeObserver grows the window to fit). Collapse via the
                // glyph or Esc.
                <div className="hud-line hud-line-reader" ref={readerRef}>
                  <span className="hud-avatar">
                    <AgentIcon agentId={agentId} label={agentLabel} size={15} />
                  </span>
                  <div className="hud-response">
                    {readerBody === null ? (
                      <span className="hud-response-loading">Loading…</span>
                    ) : readerBody.agent ? (
                      <MarkdownInline source={readerBody.agent} className="hud-md" />
                    ) : (
                      <span className="hud-response-loading">
                        {state.lastAgent?.text || "—"}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="hud-expand is-open"
                    onClick={closeReader}
                    aria-label="Collapse response"
                    title="Collapse (Esc)"
                  >
                    <ExpandGlyph />
                  </button>
                </div>
              ) : (
                <Line
                  icon={
                    <span className="hud-avatar">
                      <AgentIcon agentId={agentId} label={agentLabel} size={15} />
                    </span>
                  }
                  text={state.lastAgent?.text}
                  muted={!state.lastAgent}
                  partial={state.lastAgent?.partial}
                  onExpand={state.lastAgent ? openReader : undefined}
                />
              )}
            </div>
            )}

            {/* Sidebar suggestion chips — one-tap quick replies, just above the
                composer (a scroll-free row, like the mock). */}
            {sidebarPanel && state.canSend ? (
              <div className="hud-sb-chips">
                {SIDEBAR_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="hud-sb-chip"
                    onClick={() => quickSend(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}

            {/* Composer card — the input sits on top, the controls dock along
                its bottom edge (chips left, send right) so the whole thing reads
                as one surface, ManagerComposer-style. Each chip pops a native
                menu; full parity with the in-app composer. */}
            <div className="hud-compose">
              <textarea
                ref={inputRef}
                className="hud-input"
                rows={1}
                value={text}
                placeholder="Ask anything…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                disabled={!state.canSend}
              />
              <div className="hud-compose-dock">
                <div className="hud-toolbar">
                  <button
                    type="button"
                    className="hud-chip"
                    onClick={openChip("mode")}
                    title="Mode"
                  >
                    {composer.labels.mode}
                    <span className="hud-chip-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                  <button
                    type="button"
                    className="hud-chip"
                    onClick={openChip("brain")}
                    title="Model"
                  >
                    {composer.labels.model}
                    <span className="hud-chip-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                  <button
                    type="button"
                    className="hud-chip"
                    onClick={openChip("effort")}
                    title="Reasoning effort"
                  >
                    {composer.labels.effort}
                    <span className="hud-chip-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`hud-chip hud-chip-toggle${composer.state.fast ? " is-on" : ""}`}
                    onClick={composer.toggleFast}
                    title="Fast mode"
                    aria-pressed={composer.state.fast}
                  >
                    Fast
                  </button>
                  <button
                    type="button"
                    className="hud-chip"
                    onClick={openChip("approval")}
                    title="Approvals"
                  >
                    {composer.labels.approval}
                    <span className="hud-chip-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                </div>
                <button
                  className="hud-send"
                  onClick={send}
                  disabled={!state.canSend || text.trim().length === 0}
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  ↑
                </button>
              </div>
            </div>
          </>
        )}

          </>
        )}
      </div>

      {/* Collapsed-only subcaption: small labels centered below the pill, outside
          the glass (a Siri-style subtitle). With a fleet of agents it becomes a
          clickable per-state tally that pops the native switcher; solo, it's just
          this conversation's status. Workspace always trails on the right. */}
      {!expanded && mode !== "sidebar" && (
        <div className="hud-subcaption">
          {state.agents.length > 1 ? (
            <button
              type="button"
              className="hud-counts"
              onClick={openAgentsMenu}
              title="Switch agent"
            >
              {COUNT_ORDER.filter((g) => counts[g.key] > 0).map((g) => (
                <span key={g.key} className={`hud-count hud-count-${g.key}`}>
                  <StatusGlyph status={g.kind} size={10} busy={g.key === "working"} />
                  <span className="hud-count-n">{counts[g.key]}</span>
                  <span className="hud-count-label">{g.label}</span>
                </span>
              ))}
              <span className="hud-count-caret" aria-hidden>
                ▾
              </span>
            </button>
          ) : (
            <span className="hud-status">
              <StatusGlyph status={state.status} size={11} busy={busy} />
              <span className="hud-status-label">{STATUS_LABEL[state.status]}</span>
            </span>
          )}
          <span className="hud-subcaption-sep">·</span>
          <span className="hud-subcaption-ws">{headerLabel}</span>
        </div>
      )}
    </div>
  );
}

/** Status as a task-board-style state glyph (a pie/ring that fills with
 *  progress), not a flat colored dot — it inherits the per-status tone via
 *  currentColor. idle = dashed "backlog" ring, thinking/running = a filling
 *  amber pie (pulses), needs-you = a near-full blue pie, done = a solid disc,
 *  error = a ring with an exclamation. */
function StatusGlyph({
  status,
  size = 13,
  busy,
}: {
  status: HudStatusKind;
  size?: number;
  busy?: boolean;
}) {
  const ring = (
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.4"
      strokeWidth="1.6"
    />
  );
  const pie = (f: number) => {
    const a = f * 2 * Math.PI;
    const x = (8 + 6 * Math.sin(a)).toFixed(2);
    const y = (8 - 6 * Math.cos(a)).toFixed(2);
    const large = f > 0.5 ? 1 : 0;
    return <path d={`M8 8 L8 2 A6 6 0 ${large} 1 ${x} ${y} Z`} fill="currentColor" />;
  };

  let inner: React.ReactNode;
  switch (status) {
    case "idle":
      inner = (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="1.6"
          strokeDasharray="2.1 2.1"
        />
      );
      break;
    case "thinking":
      inner = (
        <>
          {ring}
          {pie(0.3)}
        </>
      );
      break;
    case "running":
      inner = (
        <>
          {ring}
          {pie(0.6)}
        </>
      );
      break;
    case "awaiting_input":
      inner = (
        <>
          {ring}
          {pie(0.78)}
        </>
      );
      break;
    case "done":
      inner = <circle cx="8" cy="8" r="6.4" fill="currentColor" />;
      break;
    case "error":
      inner = (
        <>
          {ring}
          <rect x="7.2" y="4.3" width="1.6" height="4.6" rx="0.8" fill="currentColor" />
          <rect x="7.2" y="10.2" width="1.6" height="1.7" rx="0.8" fill="currentColor" />
        </>
      );
      break;
    default:
      inner = ring;
  }

  return (
    <svg
      className={`hud-status-glyph${busy ? " is-busy" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
    >
      {inner}
    </svg>
  );
}

/** One line of the exchange — a brand/you icon + the message (truncated). When
 *  `onExpand` is set, a trailing expand glyph opens the full-response reader. */
function Line({
  icon,
  text,
  muted,
  partial,
  onExpand,
}: {
  icon: React.ReactNode;
  text?: string;
  muted?: boolean;
  partial?: boolean;
  onExpand?: () => void;
}) {
  return (
    <div className={`hud-line${muted ? " hud-line-muted" : ""}`}>
      {icon}
      <span className="hud-msg">
        {text?.trim() || "—"}
        {partial ? <span className="hud-caret" /> : null}
      </span>
      {onExpand ? (
        <button
          type="button"
          className="hud-expand"
          onClick={onExpand}
          aria-label="Read full response"
          title="Read full response"
        >
          <ExpandGlyph />
        </button>
      ) : null}
    </div>
  );
}

/** A small diagonal expand glyph for the "read full response" affordance. */
function ExpandGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9.5 3H13v3.5" />
      <path d="M13 3 8.5 7.5" />
      <path d="M6.5 13H3V9.5" />
      <path d="M3 13l4.5-4.5" />
    </svg>
  );
}

// The ambient greeting's centrepiece — a four-point spark (the Aura/Gemini
// star) with a soft brand-accent gradient + glow. Decorative.
function AmbientSpark() {
  return (
    <svg
      className="hud-spark"
      width="46"
      height="46"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
    >
      <defs>
        <radialGradient id="hudSparkFill" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stopColor="#7cf2d2" />
          <stop offset="55%" stopColor="#4dc1a4" />
          <stop offset="100%" stopColor="#36a98e" />
        </radialGradient>
      </defs>
      <path
        d="M24 3c1.6 9.3 5.4 13.1 18 21-12.6 7.9-16.4 11.7-18 21-1.6-9.3-5.4-13.1-18-21 12.6-7.9 16.4-11.7 18-21Z"
        fill="url(#hudSparkFill)"
      />
    </svg>
  );
}
