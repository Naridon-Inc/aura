// How many xterm terminals may hold a WebGL context at once.
//
// Every xterm terminal used to keep its WebGL renderer for as long as its tab
// existed — including while it sat detached in the persistent session map,
// painting nothing, because a workspace you switched away from keeps its
// terminals alive so switching back is instant. A webview holds about sixteen
// live WebGL contexts and then starts throwing the oldest away. With a few
// workspaces open that limit was reached, and each loss ran the terminal's
// restore path, which made a new context, which pushed another terminal's
// context out: a cascade of rebuilds exactly when the most was open.
//
// The budget keeps the holders in least-recently-shown order and caps them
// below the webview's limit. A terminal shown when the budget is full takes
// the context of the one shown longest ago, which drops back to xterm's DOM
// renderer — it keeps every line of its buffer, and gets WebGL back the next
// time it is the one on screen.

export type WebglHolder = {
  /** Load a WebGL renderer. False when this webview cannot make one. */
  attachGl(): boolean;
  /** Dispose the WebGL renderer; the terminal falls back to the DOM one. */
  dropGl(): void;
};

export type WebglBudget<H extends WebglHolder> = {
  /** This holder is on screen: give it a context, evicting the holder shown
   *  longest ago if the budget is full. */
  acquire(holder: H): void;
  /** This holder is gone for good, or gave its context back. */
  release(holder: H): void;
  /** The webview took this holder's context away on its own. Forget it
   *  without disposing — the holder's loss handler already did. */
  lost(holder: H): void;
  holders(): readonly H[];
};

/** Below the ~16 a webview allows, with room for the other canvases the app
 *  draws with (charts, previews) so the browser never has to choose. */
export const DEFAULT_WEBGL_BUDGET = 8;

export function createWebglBudget<H extends WebglHolder>(max = DEFAULT_WEBGL_BUDGET): WebglBudget<H> {
  const lru: H[] = [];
  const drop = (holder: H) => {
    const i = lru.indexOf(holder);
    if (i >= 0) lru.splice(i, 1);
    return i >= 0;
  };
  return {
    acquire(holder) {
      if (drop(holder)) {
        lru.push(holder);
        return;
      }
      while (lru.length >= Math.max(1, max)) {
        const oldest = lru.shift();
        oldest?.dropGl();
      }
      if (holder.attachGl()) lru.push(holder);
    },
    release(holder) {
      if (drop(holder)) holder.dropGl();
    },
    lost(holder) {
      drop(holder);
    },
    holders: () => lru,
  };
}
