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
// In-app HTML5 drags (the clips tray, file-tree reordering, tab dragging) are
// unaffected — `dragDropEnabled` governs only EXTERNAL OS file drops.

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

/** Resolve the `[data-os-drop]` zone (and its PTY id, if any) sitting under a
 *  physical-pixel drop position. Returns `{ zone: null }` when the drop didn't
 *  land on a registered surface — we then no-op rather than guess. */
function zoneAt(position: { x: number; y: number } | undefined): {
  zone: DropZone;
  ptyId: string | null;
} {
  if (!position) return { zone: null, ptyId: null };
  const dpr = window.devicePixelRatio || 1;
  const x = position.x / dpr;
  const y = position.y / dpr;
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const host = el?.closest?.("[data-os-drop]") as HTMLElement | null;
  if (!host) return { zone: null, ptyId: null };
  const kind = host.getAttribute("data-os-drop");
  const ptyId = host.getAttribute("data-pty-id");
  if (kind === "composer") return { zone: "composer", ptyId: null };
  if (kind === "terminal") return { zone: "terminal", ptyId: ptyId || null };
  return { zone: null, ptyId: null };
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
          const { zone } = zoneAt(payload.position);
          window.dispatchEvent(
            new CustomEvent(OS_FILE_DRAG, { detail: { kind: zone } }),
          );
          return;
        }
        if (kind === "leave" || kind === "cancel") {
          window.dispatchEvent(
            new CustomEvent(OS_FILE_DRAG, { detail: { kind: null } }),
          );
          return;
        }
        if (kind !== "drop") return;

        window.dispatchEvent(
          new CustomEvent(OS_FILE_DRAG, { detail: { kind: null } }),
        );
        const paths = Array.isArray(payload.paths) ? payload.paths : [];
        if (paths.length === 0) return;
        const { zone, ptyId } = zoneAt(payload.position);

        if (zone === "terminal" && ptyId) {
          invoke("pty_write", { id: ptyId, data: pathsToPtyBytes(paths) }).catch(
            () => {},
          );
          return;
        }
        if (zone === "composer") {
          window.dispatchEvent(
            new CustomEvent(OS_FILE_DROP_COMPOSER, { detail: { paths } }),
          );
          return;
        }
        // Dropped somewhere with no registered zone — ignore rather than guess.
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
