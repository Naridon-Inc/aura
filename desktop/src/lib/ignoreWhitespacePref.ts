// ignoreWhitespacePref — one shared, persisted toggle for whether diffs hide
// whitespace-only changes. Mirrors diffViewPref: stored in localStorage so it
// survives reloads, and broadcast so every open diff pane flips together the
// moment one toggle is clicked. When ON, Monaco's `ignoreTrimWhitespace` is set
// true so a re-indent or trailing-space churn stops showing as a real change —
// exactly the noise reviewers want gone when reading a large diff.

const KEY = "aura.git.ignoreWhitespace";
const EVENT = "aura:ignore-whitespace-changed";
const DEFAULT = false;

function normalize(raw: string | null): boolean {
  return raw === "1" ? true : raw === "0" ? false : DEFAULT;
}

/** Read the current preference. Defaults to `false` (show whitespace changes)
 *  when unset or unreadable. */
export function getIgnoreWhitespace(): boolean {
  try {
    return normalize(localStorage.getItem(KEY));
  } catch {
    return DEFAULT;
  }
}

/** Persist the preference and notify every subscriber in this window so all
 *  open diff panes re-read it at once. A no-op when the value is unchanged. */
export function setIgnoreWhitespace(on: boolean): void {
  if (getIgnoreWhitespace() === on) return;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage may be unavailable; still broadcast so in-memory panes follow */
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: on }));
}

/** Subscribe to preference changes. Fires on same-window toggles (via the
 *  custom event) and on cross-tab edits (via the native `storage` event).
 *  Returns an unsubscribe. */
export function subscribeIgnoreWhitespace(onChange: (on: boolean) => void): () => void {
  const onCustom = (e: Event) => {
    onChange(Boolean((e as CustomEvent<boolean>).detail));
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
