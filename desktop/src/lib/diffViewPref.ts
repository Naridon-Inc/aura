// diffViewPref — the shared, persisted preferences for how diffs render:
// "unified" (calm, inline) or "split" (side-by-side), and whether the current
// side of a working-tree diff can be typed into ("Edit in diff") or is read
// only. Stored in localStorage so they survive reloads, and broadcast so every
// open diff pane flips together the moment one toggle is clicked (no
// prop-drilling, no stale panes). The Trace Changes pane and the working-file
// diff pane both read and write these, so the choice is the same wherever you
// review a change.

export type DiffView = "unified" | "split";

const KEY = "aura.git.diffView";
const EVENT = "aura:diff-view-changed";
const DEFAULT: DiffView = "split";

// Editable diffs. Default ON: a reviewer who spots a typo fixes it where they
// see it, without a trip to the editor. "Read only" is the opt-out.
const EDIT_KEY = "aura.git.editableDiffs";
const EDIT_EVENT = "aura:editable-diffs-changed";
const EDIT_DEFAULT = true;

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

// ── editable diffs ───────────────────────────────────────────────────

/** Only an explicit "0" turns editing off; anything else (unset, unreadable,
 *  a stray value) is the default so the feature never silently disappears. */
function normalizeEditable(raw: string | null): boolean {
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return EDIT_DEFAULT;
}

/** Whether the current side of a working-tree diff can be typed into.
 *  Defaults to true when unset or unreadable. */
export function getEditableDiffs(): boolean {
  try {
    return normalizeEditable(localStorage.getItem(EDIT_KEY));
  } catch {
    return EDIT_DEFAULT;
  }
}

/** Persist the choice and notify every subscriber in this window so all open
 *  diff panes flip at once. A no-op when the value is unchanged. */
export function setEditableDiffs(on: boolean): void {
  if (getEditableDiffs() === on) return;
  try {
    localStorage.setItem(EDIT_KEY, on ? "1" : "0");
  } catch {
    /* storage may be unavailable; still broadcast so in-memory panes follow */
  }
  window.dispatchEvent(new CustomEvent<boolean>(EDIT_EVENT, { detail: on }));
}

/** Subscribe to the editable-diffs choice. Fires on same-window toggles and on
 *  cross-tab edits. Returns an unsubscribe. */
export function subscribeEditableDiffs(onChange: (on: boolean) => void): () => void {
  const onCustom = (e: Event) => {
    const detail = (e as CustomEvent<boolean>).detail;
    onChange(typeof detail === "boolean" ? detail : EDIT_DEFAULT);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === EDIT_KEY) onChange(normalizeEditable(e.newValue));
  };
  window.addEventListener(EDIT_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EDIT_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
