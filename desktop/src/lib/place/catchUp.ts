// Catching up on a session you walked away from — the rules, without the DOM.
//
// A session on a machine keeps running when this laptop closes; that is the
// whole reason the work lives in tmux. But a terminal attached to it shows the
// screen from the moment you sat down, and nothing of the hour before. So when
// a session tab is opened after long enough away, the scrollback is read off
// the machine (`api.placeSessionCapture`) and shown above the terminal until
// the person says they've seen it.
//
// "Long enough" and "seen it" are the two decisions here, and they are pure so
// they can be tested without a machine, a clock, or a browser: the store is
// anything with `getItem`/`setItem` (localStorage in the app, a Map in tests),
// and `now` is always passed in.

/** How long away before a session is worth catching up on. Shorter than this
 *  and the terminal's own screen still holds what happened. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** The subset of `Storage` these rules use. */
export type SeenStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Where "when did I last look at this session" is remembered — per machine
 *  and per session, so two boxes holding sessions of the same name never
 *  share a marker. */
export function seenKey(machineId: string, session: string): string {
  return `aura.place.seen.${machineId}.${session}`;
}

/** The last time this session was looked at, in ms, or null if never — or if
 *  the store can't be read, which a private window or a browser set to block
 *  site data will do, and which must read as "never" rather than crash. */
export function readSeen(
  store: SeenStore,
  machineId: string,
  session: string,
): number | null {
  try {
    const raw = store.getItem(seenKey(machineId, session));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Remember that this session was looked at, now. Best-effort: a store that
 *  refuses the write costs the strip showing once more next time, nothing
 *  worse. */
export function markSeen(
  store: SeenStore,
  machineId: string,
  session: string,
  now: number,
): void {
  try {
    store.setItem(seenKey(machineId, session), String(Math.floor(now)));
  } catch {
    // Nowhere to write it; see above.
  }
}

/** Has enough time passed since the last look for the scrollback to hold
 *  something the terminal won't? Never looked means yes. */
export function isStale(
  seenAt: number | null,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  if (seenAt === null) return true;
  return now - seenAt >= staleAfterMs;
}

/** The whole decision: should opening this session tab fetch its scrollback? */
export function shouldCatchUp(
  store: SeenStore,
  machineId: string,
  session: string,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  return isStale(readSeen(store, machineId, session), now, staleAfterMs);
}

/** A capture ends with however many blank lines the pane had below its last
 *  output — a whole screen of them, usually. Drop those, and only those: blank
 *  lines *between* output are the program's own paragraph breaks. */
export function trimTrailingBlank(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end).join("\n");
}

/** How many lines a trimmed capture holds — what the strip's header counts. */
export function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** "away 2h" / "away 35m" / "away 3d" — how long since the last look, for the
 *  strip's header. Null (never looked) says so in words. */
export function awayLabel(seenAt: number | null, now: number): string {
  if (seenAt === null) return "first look";
  const ms = Math.max(0, now - seenAt);
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `away ${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `away ${h}h`;
  return `away ${Math.floor(h / 24)}d`;
}
