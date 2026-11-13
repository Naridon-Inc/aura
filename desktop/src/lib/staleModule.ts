// A screen the app loads on demand can come back as "Importing a module script
// failed." That is not a bug in the screen: the file it asked for no longer
// exists under that name. In `tauri dev` it happens when the dev server
// re-prepares its libraries mid-session and gives them new names, so a window
// opened earlier asks for the old ones. In a shipped build it happens when the
// files under the page changed (an update landed while a window stayed open).
//
// Either way a reload fetches the current names and the screen draws. This
// file decides when that reload is the answer; AppErrorBoundary does it.

/** The wording each engine uses when an on-demand module can't be fetched. */
const STALE_MODULE = [
  /importing a module script failed/i, // WebKit (the app's webview)
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /unable to preload css/i, // a lazy screen's stylesheet, same cause
];

/** True when `message` is the browser saying an on-demand module is gone. */
export function isStaleModuleError(message: string): boolean {
  return STALE_MODULE.some((re) => re.test(message));
}

/** Where the last automatic reload is remembered, per window. */
export const STALE_RELOAD_KEY = "aura.staleModule.reloadedAt";

/** One automatic reload per this window: a second failure this soon means a
 *  reload doesn't cure it, and the person should see what happened. */
export const STALE_RELOAD_WINDOW_MS = 30_000;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Reload for a stale module unless this window already did so in the last
 *  half minute. Returns true when a reload was started. */
export function reloadForStaleModule(
  store: Store | null,
  now: number,
  reload: () => void,
): boolean {
  let last = 0;
  try {
    last = Number(store?.getItem(STALE_RELOAD_KEY) ?? 0) || 0;
  } catch {
    // Storage blocked: allow the one reload, there is nothing to loop on.
  }
  if (last > 0 && now - last < STALE_RELOAD_WINDOW_MS) return false;
  try {
    store?.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    /* best-effort */
  }
  reload();
  return true;
}
