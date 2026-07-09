// diffViewPref — one shared, persisted preference for how diffs render:
// "unified" (calm, inline) or "split" (side-by-side). Stored in localStorage so
// it survives reloads, and broadcast so every open diff pane flips together the
// moment one toggle is clicked (no prop-drilling, no stale panes). The Trace
// Changes pane and the working-file diff pane both read and write this, so the
// choice is the same wherever you review a change.

export type DiffView = "unified" | "split";

const KEY = "aura.git.diffView";
const EVENT = "aura:diff-view-changed";
const DEFAULT: DiffView = "split";

function normalize(raw: string | null): DiffView {
  return raw === "unified" || raw === "split" ? raw : DEFAULT;
}

/** Read the current preference. Defaults to "split" when unset or unreadable
 *  (a private-mode localStorage throw degrades to the default, never crashes). */
export function getDiffView(): DiffView {
  try {
    return normalize(localStorage.getItem(KEY));
  } catch {
    return DEFAULT;
  }
}

/** Persist the preference and notify every subscriber in this window so all
 *  open diff panes re-read it at once. A no-op when the value is unchanged. */
export function setDiffView(view: DiffView): void {
  if (getDiffView() === view) return;
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* storage may be unavailable; still broadcast so in-memory panes follow */
  }
  window.dispatchEvent(new CustomEvent<DiffView>(EVENT, { detail: view }));
}

/** Subscribe to preference changes. Fires on same-window toggles (via the
 *  custom event) and on cross-tab edits (via the native `storage` event).
 *  Returns an unsubscribe. */
export function subscribeDiffView(onChange: (view: DiffView) => void): () => void {
  const onCustom = (e: Event) => {
    const detail = (e as CustomEvent<DiffView>).detail;
    onChange(normalize(detail ?? null));
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange(normalize(e.newValue));
  };
  window.addEventListener(EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
