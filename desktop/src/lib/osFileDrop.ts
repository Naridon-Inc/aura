// Global OS-file drop router.
//
// macOS WKWebView does not hand the web layer a usable filesystem *path* for a
// file dragged in from Finder/the desktop — an HTML5 `drop` only ever exposes
// opaque `File` objects (and often not even those). Tauri solves this with a
// native `onDragDropEvent` that carries absolute `paths` + the drop position,
// but that event only fires when `dragDropEnabled: true` in tauri.conf.json.
//
// With the flag on, EVERY external file drop comes through this one listener
// instead of per-element `onDrop` handlers. We hit-test the drop position
// against `[data-os-drop]` zones to decide where it landed:
//   • a terminal  → type the absolute path(s) into that PTY (what a real
//                   terminal does — the agent, e.g. Claude Code, then reads it)
//   • the composer → hand the paths to the chat composer, which reads each
//                    image's bytes and attaches it inline
// In-app drags of Files rows come through here too: see "In-app (HTML5) file
// drags" below, which also lands a row dropped on one of the tree's folders.

import { invoke } from "@tauri-apps/api/core";

/** Dispatched on the chat composer's zone when image/file paths are dropped on
 *  it. The composer listens, reads each path's bytes, and attaches them. */
export const OS_FILE_DROP_COMPOSER = "aura:os-file-drop-composer";
/** Dispatched on `over`/`leave` so a zone can paint a drag highlight, since the
 *  usual HTML5 `dragover` no longer fires for external files. */
export const OS_FILE_DRAG = "aura:os-file-drag";

type DropZone = "composer" | "terminal" | null;

type DragDropPayload = {
  type: "enter" | "over" | "drop" | "leave" | "cancel" | "drag";
  paths?: string[];
  position?: { x: number; y: number };
};

// ── In-app (HTML5) file drags ────────────────────────────────────────────
//
// The Files sidebar drags a real DOM row, so — unlike a Finder drop — these
// DO surface as HTML5 `dragover`/`drop` events. But two things make the naive
// per-target `onDrop` unreliable across the app:
//   1. the drop lands on whichever descendant is under the cursor (an xterm
//      canvas, a hidden textarea, a nested overlay), not the zone div itself;
//   2. WKWebView intermittently sanitises the *standard* `text/*` payload of an
//      in-app drag, so `getData("text/plain")` comes back empty at the target
//      even though it was set at the source — the drag then "disappears".
// So we stash the dragged paths in a module ref at dragstart (the source of
// truth) and route the drop from a single window-level CAPTURE listener that
// hit-tests `[data-os-drop]` zones — the same zones the OS-drop router uses.
//
// A row can also be dropped on one of the Files tree's own folders, which
// moves it there. Under wry that drop never reaches the folder either, so the
// tree marks each folder row with `data-file-move-dir` and the same router
// lands the move from wherever the release is reported: the DOM `drop`, the
// native `drop` and its position, or the `dragend` release point.

/** What the tree does with a drag released on one of its folders. */
export interface InAppFileMove {
  /** Whether the dragged entries can move into this folder. */
  accepts: (dir: string) => boolean;
  /** Move the dragged entries into this folder. */
  into: (dir: string) => void;
  /** The folder the drag is over now, or null, for the tree to highlight. */
  hover: (dir: string | null) => void;
}

const inAppDrag: { active: boolean; paths: string[]; move: InAppFileMove | null } = {
  active: false,
  paths: [],
  move: null,
};

/** The move of the drag that just ended, kept for a moment: under wry the
 *  source's `dragend` can reach the page before the native `drop` that says
 *  where the drag was released. */
let endedMove: { move: InAppFileMove; at: number } | null = null;
const ENDED_MOVE_MS = 1000;

/** Call from a Files-sidebar row's `onDragStart` with the dragged path(s), and
 *  what to do when they are released on one of the tree's folders.
 *  Records the payload so the window-level router can recover it even when
 *  the webview strips the dataTransfer contents mid-drag. */
export function beginInAppFileDrag(paths: string[], move?: InAppFileMove): void {
  inAppDrag.active = true;
  inAppDrag.paths = paths.filter(Boolean);
  inAppDrag.move = move ?? null;
  endedMove = null;
}

/** Call from the same row's `onDragEnd` to clear the in-app drag payload. */
export function endInAppFileDrag(): void {
  const move = inAppDrag.move;
  if (inAppDrag.active && move) {
    move.hover(null);
    endedMove = { move, at: Date.now() };
  }
  inAppDrag.active = false;
  inAppDrag.paths = [];
  inAppDrag.move = null;
}

/** An element and its ancestors, as far as the move hit-test reads them. */
export interface MoveNode {
  dataset?: DOMStringMap;
  parentElement: MoveNode | null;
}

/** The folder a drag released over `node` moves into: the nearest row marked
 *  `data-file-move-dir`, when it takes the drag. Null over anything else, or
 *  over a folder that refuses it (the folder itself, one inside it, or the
 *  one it is already in). */
export function moveDirFrom(node: MoveNode | null, accepts: (dir: string) => boolean): string | null {
  for (let at = node; at; at = at.parentElement) {
    const dir = at.dataset?.fileMoveDir;
    if (dir !== undefined) return accepts(dir) ? dir : null;
  }
  return null;
}

/** The folder the live in-app drag would move into from this element. */
function moveDirAt(el: Element | null): string | null {
  const move = inAppDrag.active ? inAppDrag.move : null;
  return move ? moveDirFrom(el as HTMLElement | null, move.accepts) : null;
}

/** Land a release over `el` on a Files-tree folder, if it is one that takes
 *  the drag. True when the release belongs to the move, so the caller does not
 *  also hand the paths to a terminal or the chat box. `move` defaults to the
 *  live drag's. */
function landMove(el: Element | null, move: InAppFileMove | null = inAppDrag.active ? inAppDrag.move : null): boolean {
  const dir = move ? moveDirFrom(el as HTMLElement | null, move.accepts) : null;
  if (!move || dir === null) return false;
  if (inAppDrag.move === move) endInAppFileDrag();
  endedMove = null;
  move.hover(null);
  if (claimInAppDrop()) move.into(dir);
  return true;
}

// Under wry (`dragDropEnabled`) on macOS an in-app drag can surface on BOTH
// channels — the DOM `drop` (in-app router) AND Tauri's native
// `onDragDropEvent` (OS router) — depending on the OS/webview version. Stamp
// each in-app drop so whichever router fires first wins and the other no-ops,
// instead of writing the path twice. External Finder drops don't go through
// this (they never reach the DOM router).
let lastInAppDropAt = 0;
function claimInAppDrop(): boolean {
  const now = Date.now();
  if (now - lastInAppDropAt < 700) return false; // another router already took it
  lastInAppDropAt = now;
  return true;
}

/** Convert a Tauri drag-drop event position into CSS/client coordinates fit
 *  for `elementFromPoint` / `getBoundingClientRect` comparisons.
 *
 *  The payload is *typed* PhysicalPosition, but only WebView2 actually
 *  reports physical pixels (ScreenToClient). WKWebView (draggingLocation)
 *  and WebKitGTK hand wry view-local LOGICAL points, and tauri-runtime-wry
 *  (2.11) wraps them without scaling — so a devicePixelRatio divide is
 *  correct on Windows only. On a 2x mac display it halves already-logical
 *  coordinates, every hit-test misses its target, and drops silently no-op. */
export function osDropPositionToClient(position: { x: number; y: number }): {
  x: number;
  y: number;
} {
  const isWindows = navigator.userAgent.includes("Windows");
  const scale = isWindows ? window.devicePixelRatio || 1 : 1;
  return { x: position.x / scale, y: position.y / scale };
}

/** Resolve the `[data-os-drop]` zone (and its PTY id, if any) sitting under a
 *  native drop position. Returns `{ zone: null }` when the drop didn't
 *  land on a registered surface — we then no-op rather than guess. */
function zoneAt(position: { x: number; y: number } | undefined): {
  zone: DropZone;
  ptyId: string | null;
  agentSession: string | null;
  composerId: string | null;
} {
  const miss = { zone: null, ptyId: null, agentSession: null, composerId: null } as const;
  if (!position) return miss;
  const { x, y } = osDropPositionToClient(position);
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const host = el?.closest?.("[data-os-drop]") as HTMLElement | null;
  if (!host) return miss;
  const kind = host.getAttribute("data-os-drop");
  const ptyId = host.getAttribute("data-pty-id");
  // Coding-agent terminals (AgentTerminalView) write through a different
  // backend (`agent_pty_write` keyed by session) than the system-shell
  // terminal (`pty_write` keyed by pty id), so they mark themselves with
  // `data-agent-session` instead of `data-pty-id`.
  const agentSession = host.getAttribute("data-agent-session");
  const composerId = host.getAttribute("data-os-drop-id");
  if (kind === "composer") return { zone: "composer", ptyId: null, agentSession: null, composerId };
  if (kind === "terminal")
    return { zone: "terminal", ptyId: ptyId || null, agentSession: agentSession || null, composerId: null };
  return miss;
}

/** The element under a native drag position, if any. */
function elementAtNative(position: { x: number; y: number } | undefined): Element | null {
  if (!position) return null;
  const { x, y } = osDropPositionToClient(position);
  return document.elementFromPoint(x, y);
}

/** Shell-quote a path only when it contains whitespace, matching the existing
 *  terminal drop behaviour, and append a trailing space so the next drop /
 *  keystroke doesn't glue onto it. */
function pathsToPtyBytes(paths: string[]): number[] {
  const text = paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(" ");
  return Array.from(new TextEncoder().encode(text + " "));
}

/** Deliver dropped paths to a resolved zone: type them into the PTY (system
 *  shell → `pty_write`, coding-agent terminal → `agent_pty_write`) or hand
 *  them to the chat composer. The one place the three drop channels (DOM drop,
 *  native `onDragDropEvent`, and the `dragend` fallback) converge. */
function writeInAppDrop(
  zone: DropZone,
  ptyId: string | null,
  agentSession: string | null,
  composerId: string | null,
  paths: string[],
): void {
  if (!zone || paths.length === 0) return;
  if (zone === "terminal" && agentSession) {
    invoke("agent_pty_write", {
      sessionId: agentSession,
      data: pathsToPtyBytes(paths),
    }).catch(() => {});
    return;
  }
  if (zone === "terminal" && ptyId) {
    invoke("pty_write", { id: ptyId, data: pathsToPtyBytes(paths) }).catch(
      () => {},
    );
    return;
  }
  if (zone === "composer") {
    window.dispatchEvent(
      new CustomEvent(OS_FILE_DROP_COMPOSER, {
        detail: { paths, targetId: composerId },
      }),
    );
  }
}

/** Resolve the `[data-os-drop]` zone under a raw client point (used by the
 *  `dragend` fallback, whose event carries the release coordinates). */
function zoneAtPoint(x: number, y: number): {
  zone: DropZone;
  ptyId: string | null;
  agentSession: string | null;
  composerId: string | null;
} {
  const miss = { zone: null, ptyId: null, agentSession: null, composerId: null } as const;
  const at = document.elementFromPoint(x, y) as HTMLElement | null;
  const host = (at?.closest?.("[data-os-drop]") as HTMLElement | null) ?? null;
  if (!host) return miss;
  const kind = host.getAttribute("data-os-drop");
  const ptyId = host.getAttribute("data-pty-id");
  const agentSession = host.getAttribute("data-agent-session");
  const composerId = host.getAttribute("data-os-drop-id");
  if (kind === "composer") return { zone: "composer", ptyId: null, agentSession: null, composerId };
  if (kind === "terminal")
    return { zone: "terminal", ptyId: ptyId || null, agentSession: agentSession || null, composerId: null };
  return miss;
}

/** Resolve the `[data-os-drop]` zone under a DOM drag event. Prefers the
 *  event target's ancestor chain (exact, even when the cursor sits over an
 *  xterm canvas child) and falls back to `elementFromPoint` at the pointer. */
function zoneAtEvent(e: DragEvent): {
  zone: DropZone;
  ptyId: string | null;
  agentSession: string | null;
  composerId: string | null;
} {
  const miss = { zone: null, ptyId: null, agentSession: null, composerId: null } as const;
  const target = e.target as HTMLElement | null;
  let host = (target?.closest?.("[data-os-drop]") as HTMLElement | null) ?? null;
  if (!host) {
    const at = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    host = (at?.closest?.("[data-os-drop]") as HTMLElement | null) ?? null;
  }
  if (!host) return miss;
  const kind = host.getAttribute("data-os-drop");
  const ptyId = host.getAttribute("data-pty-id");
  const agentSession = host.getAttribute("data-agent-session");
  const composerId = host.getAttribute("data-os-drop-id");
  if (kind === "composer") return { zone: "composer", ptyId: null, agentSession: null, composerId };
  if (kind === "terminal")
    return { zone: "terminal", ptyId: ptyId || null, agentSession: agentSession || null, composerId: null };
  return miss;
}

/** Pull absolute paths out of an in-app drag's dataTransfer, falling back to
 *  the module ref when the webview stripped the standard payload mid-drag. */
function extractInAppPaths(dt: DataTransfer | null): string[] {
  const paths: string[] = [];
  const uri = dt?.getData("text/uri-list") ?? "";
  const plain = dt?.getData("text/plain") ?? "";
  if (uri) {
    for (const line of uri.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      paths.push(
        line.startsWith("file://")
          ? decodeURIComponent(line.slice("file://".length))
          : line,
      );
    }
  } else if (plain) {
    for (const line of plain.split(/\r?\n/)) {
      const p = line.trim();
      if (p) paths.push(p);
    }
  }
  if (paths.length === 0 && inAppDrag.paths.length) return inAppDrag.paths.slice();
  return paths;
}

/** True when this drag is a plain file-path drag we own (Files sidebar), and
 *  NOT a clips-tray drag — those carry `application/x-aura-clip` and are routed
 *  by the per-target handlers so image clips keep their OS-clipboard path. */
function isOwnedFileDrag(dt: DataTransfer | null): boolean {
  if (dt && dt.types.includes("application/x-aura-clip")) return false;
  if (inAppDrag.active) return true;
  return (
    !!dt &&
    (dt.types.includes("text/uri-list") || dt.types.includes("text/plain"))
  );
}

/** Install the window-level router for in-app HTML5 file drags (Files sidebar
 *  → terminal / composer). Distinct from the OS-file router: those come through
 *  Tauri's native channel and never surface as DOM events, whereas these are
 *  real HTML5 drags. Runs in the CAPTURE phase so it lands the drop before any
 *  descendant (xterm, textarea) can swallow it, and `stopImmediatePropagation`
 *  keeps the per-target fallback handlers from writing the path a second time.
 *  Works in a plain browser too (no Tauri needed for the DOM events); the
 *  `invoke` writes simply no-op outside a webview. Returns a disposer. */
export function installInAppFileDropRouter(): () => void {
  const onDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!isOwnedFileDrag(dt)) return;
    const dir = moveDirAt(e.target as Element | null);
    inAppDrag.move?.hover(dir);
    if (dir !== null) {
      e.preventDefault();
      if (dt) dt.dropEffect = "move";
      return;
    }
    if (!zoneAtEvent(e).zone) return;
    // Accepting the dragover is what stops the browser rejecting the drop
    // (and animating the row back to the sidebar — the "disappears" bug).
    e.preventDefault();
    if (dt) dt.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!isOwnedFileDrag(dt)) return;
    if (moveDirAt(e.target as Element | null) !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      landMove(e.target as Element | null);
      return;
    }
    const { zone, ptyId, agentSession, composerId } = zoneAtEvent(e);
    if (!zone) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const paths = extractInAppPaths(dt);
    endInAppFileDrag();
    if (paths.length === 0) return;
    if (!claimInAppDrop()) return; // another channel already handled it
    writeInAppDrop(zone, ptyId, agentSession, composerId, paths);
  };
  // Last-resort fallback: `dragend` fires on the SOURCE row even when wry
  // swallowed the actual drop (so neither the DOM `drop` above nor the native
  // channel ran). Its coordinates are the release point — hit-test them and
  // route from the dragstart path ref. `claimInAppDrop` keeps this from
  // double-writing when a real drop already landed. Like a move into a
  // folder, a path lands here only when the drag ended in a drop: a drag
  // cancelled with Escape still reports where the pointer was, and typing the
  // path into the terminal or chat box under it would undo the cancel.
  const onDragEnd = (e: DragEvent) => {
    const dropped = e.dataTransfer?.dropEffect !== "none";
    const released = e.clientX || e.clientY ? document.elementFromPoint(e.clientX, e.clientY) : null;
    if (dropped && released && landMove(released)) return;
    if (dropped && inAppDrag.active && inAppDrag.paths.length && (e.clientX || e.clientY)) {
      const { zone, ptyId, agentSession, composerId } = zoneAtPoint(e.clientX, e.clientY);
      if (zone && claimInAppDrop()) {
        writeInAppDrop(zone, ptyId, agentSession, composerId, inAppDrag.paths.slice());
      }
    }
    endInAppFileDrag();
  };
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", onDragEnd, true);
  return () => {
    window.removeEventListener("dragover", onDragOver, true);
    window.removeEventListener("drop", onDrop, true);
    window.removeEventListener("dragend", onDragEnd, true);
  };
}

/** Install the single global drop router. Returns a disposer. No-ops (and
 *  resolves its disposer to a noop) outside Tauri. */
export function installOsFileDropRouter(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  void (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const off = await getCurrentWebview().onDragDropEvent((evt) => {
        if (disposed) return;
        const payload = evt.payload as unknown as DragDropPayload;
        const kind = payload?.type;

        if (kind === "over" || kind === "enter" || kind === "drag") {
          inAppDrag.move?.hover(moveDirAt(elementAtNative(payload.position)));
          const { zone, composerId } = zoneAt(payload.position);
          window.dispatchEvent(
            new CustomEvent(OS_FILE_DRAG, {
              detail: { kind: zone, targetId: composerId },
            }),
          );
          return;
        }
        if (kind === "leave" || kind === "cancel") {
          inAppDrag.move?.hover(null);
          window.dispatchEvent(
            new CustomEvent(OS_FILE_DRAG, { detail: { kind: null } }),
          );
          return;
        }
        if (kind !== "drop") return;

        window.dispatchEvent(
          new CustomEvent(OS_FILE_DRAG, { detail: { kind: null } }),
        );
        const nativePaths = Array.isArray(payload.paths) ? payload.paths : [];
        // External Finder drops carry real absolute paths. An IN-APP drag
        // (Files-sidebar row) that wry's native handler swallows arrives here
        // with NO paths — and WKWebView suppresses the DOM `drop` for it too,
        // so this native channel is the ONLY one that fires. Recover the
        // dragged paths from the dragstart ref so Files → terminal / composer
        // still lands, and claim the drop so the DOM router (if it also fires)
        // doesn't write it twice.
        // A Files row released on one of the tree's folders moves there,
        // whether or not the row's `dragend` has already cleared the drag.
        if (nativePaths.length === 0) {
          const recent = endedMove && Date.now() - endedMove.at < ENDED_MOVE_MS ? endedMove.move : null;
          const move = inAppDrag.active ? inAppDrag.move : recent;
          if (landMove(elementAtNative(payload.position), move)) return;
        }
        const fromInApp = nativePaths.length === 0 && inAppDrag.active;
        const paths = nativePaths.length ? nativePaths : inAppDrag.paths.slice();
        if (fromInApp) {
          endInAppFileDrag();
          if (!claimInAppDrop()) return;
        }
        if (paths.length === 0) return;
        const { zone, ptyId, agentSession, composerId } = zoneAt(payload.position);
        // Dropped somewhere with no registered zone → writeInAppDrop no-ops,
        // and we ignore it rather than guess.
        writeInAppDrop(zone, ptyId, agentSession, composerId, paths);
      });
      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    } catch {
      // Not in a Tauri webview (pure-browser dev) — nothing to wire.
    }
  })();

  return () => {
    disposed = true;
    if (unlisten) unlisten();
    unlisten = null;
  };
}
