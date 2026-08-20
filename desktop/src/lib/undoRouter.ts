// Where ⌘Z goes.
//
// macOS runs an NSMenu key equivalent *before* the key ever reaches the
// webview. The Edit menu used to carry the predefined Undo/Redo items, whose
// `undo:` / `redo:` selectors go to WKWebView's own undo manager — and that
// manager knows nothing about Monaco's model or ProseMirror's transaction
// history. So ⌘Z was consumed by the menu and then quietly did nothing in the
// file editor and in Pages, which is exactly what people reported.
//
// The menu now carries our own `edit_undo` / `edit_redo` items and this module
// decides whose undo it is. Editors register themselves and answer one
// question — "do you have focus right now?" — and the first one that says yes
// gets the operation. Nothing focused that we know about falls through to the
// browser's own per-field undo stack, which is what a plain <input> wants.

export type UndoTarget = {
  /** True when this editor currently owns keyboard focus. */
  hasFocus: () => boolean;
  undo: () => void;
  redo: () => void;
};

const targets = new Set<UndoTarget>();

/** Register an editor as an undo destination. Returns the unregister fn —
 *  call it on unmount, or a torn-down editor keeps claiming ⌘Z. */
export function registerUndoTarget(target: UndoTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/** Run undo/redo on whatever is focused. Returns false when nothing here
 *  could handle it, so the caller can leave the event alone rather than
 *  swallowing a key that some other surface may want. */
export function routeEditUndo(kind: "undo" | "redo"): boolean {
  for (const target of targets) {
    let focused = false;
    try {
      focused = target.hasFocus();
    } catch {
      // A half-disposed editor can throw here; treat it as not focused
      // rather than letting one stale registration break the whole route.
      focused = false;
    }
    if (!focused) continue;
    if (kind === "undo") target.undo();
    else target.redo();
    return true;
  }
  return routeNativeField(kind);
}

/** Plain <input>, <textarea> and contenteditable. WKWebView keeps a real undo
 *  stack for these; `execCommand` is the only way to drive it now that the
 *  native menu item no longer does. */
function routeNativeField(kind: "undo" | "redo"): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && !el.isContentEditable) return false;
  // xterm parks focus on a hidden helper textarea, which qualifies above. A
  // terminal has no undo — running one on that textarea would do nothing
  // visible while claiming the key from whoever else might want it.
  if (el.closest(".xterm")) return false;
  try {
    return document.execCommand(kind);
  } catch {
    return false;
  }
}
