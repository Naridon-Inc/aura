// sharedFlagPref — one on/off preference every open pane reads together:
// stored in localStorage so it survives reloads, and broadcast so flipping it
// in one pane flips it in all of them at once (and in other windows, through
// the native `storage` event). The diff panes' whitespace and line-wrap
// toggles are two of these.

export type SharedFlagPref = {
  /** The stored value, or the default when unset or unreadable. */
  get: () => boolean;
  /** Store the value and tell every subscriber. A no-op when unchanged. */
  set: (on: boolean) => void;
  /** Hear every change, same window or another one. Returns an unsubscribe. */
  subscribe: (onChange: (on: boolean) => void) => () => void;
};

export function sharedFlagPref(key: string, event: string, fallback = false): SharedFlagPref {
  const normalize = (raw: string | null) => (raw === "1" ? true : raw === "0" ? false : fallback);

  const get = () => {
    try {
      return normalize(localStorage.getItem(key));
    } catch {
      return fallback;
    }
  };

  const set = (on: boolean) => {
    if (get() === on) return;
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* storage may be unavailable; still broadcast so in-memory panes follow */
    }
    window.dispatchEvent(new CustomEvent<boolean>(event, { detail: on }));
  };

  const subscribe = (onChange: (on: boolean) => void) => {
    const onCustom = (e: Event) => onChange(Boolean((e as CustomEvent<boolean>).detail));
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) onChange(normalize(e.newValue));
    };
    window.addEventListener(event, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(event, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  };

  return { get, set, subscribe };
}
