// Subscribing to a native event costs a cross-process hop. Do it once.
//
// Tauri v2 on macOS routes every `invoke` — including `plugin:event|listen`
// and `plugin:event|unlisten` — through a `fetch` to a custom scheme
// handler, which is a hop out to the app process and back. `listen()` is
// therefore not free bookkeeping; it is the same transport a keystroke uses.
//
// Measured in the running app, idle, nothing on screen moving:
//
//     plugin:event|listen      628 calls in 15s
//     plugin:event|unlisten    533 calls in 15s
//     everything else          283 calls in 15s
//
// 80% of all IPC was subscribe/unsubscribe churn, and a single call site
// accounted for 363 + 359 of it: `useAppActions` registered 32 menu
// listeners in an effect keyed on `dispatch`, and `dispatch` closes over the
// editor store, so it changed identity on nearly every render. Each render
// paid 64 hops to end up subscribed to exactly the same 32 events.
//
// A keystroke's write and the echo coming back share that queue. This is
// what "the terminal is slow to show what I type" was.
//
// The rule these tests hold: WHAT you listen for is static, so it belongs in
// a dependency-free effect; the HANDLER may change every render, so it is
// read through a ref at call time.

import { describe, expect, it } from "bun:test";

import { readSrc, stripComments } from "./support/code";

/** The `useEffect(() => { … }, [deps])` that owns the menu listeners, and
 *  the dependency array it closes with. Found by the listen call itself so
 *  the test keeps pointing at the right effect as the file moves. */
async function menuEffect(): Promise<{ body: string; deps: string }> {
  const src = stripComments(await readSrc("lib/keymap.ts"));
  const call = src.indexOf("listen(`menu:");
  expect(call).toBeGreaterThan(-1);
  const open = src.lastIndexOf("useEffect(", call);
  expect(open).toBeGreaterThan(-1);
  const close = src.indexOf("}, [", call);
  expect(close).toBeGreaterThan(-1);
  const endOfDeps = src.indexOf(");", close);
  return {
    body: src.slice(open, close),
    deps: src.slice(close + 3, endOfDeps).trim(),
  };
}

describe("the menu listeners are registered once", () => {
  it("the effect has no dependencies", async () => {
    const { deps } = await menuEffect();
    // Anything in here re-runs the effect, and re-running it means
    // unsubscribing and resubscribing 32 events over IPC. `dispatch` in
    // particular changes on nearly every render.
    expect(deps).toBe("[]");
  });

  it("the handler is read through a ref, not captured", async () => {
    const { body } = await menuEffect();
    // An empty dependency array with `dispatch` captured directly would
    // trade a performance bug for a correctness one: the menu would keep
    // firing the very first render's handler forever. The ref is what makes
    // the empty array safe.
    expect(body).toContain("dispatchRef.current(id)");
    expect(body).not.toMatch(/[^.]\bdispatch\(/);
  });

  it("the ref is kept current on every render", async () => {
    const src = stripComments(await readSrc("lib/keymap.ts"));
    expect(src).toContain("dispatchRef.current = dispatch");
  });

  it("the id list lives outside the effect", async () => {
    const { body } = await menuEffect();
    const src = stripComments(await readSrc("lib/keymap.ts"));
    // A list rebuilt inside the effect is a list that looks like a reason to
    // re-subscribe. Hoisting it makes the constancy visible at the top.
    expect(src).toMatch(/^const MENU_ACTION_IDS/m);
    expect(body).toContain("MENU_ACTION_IDS.map(");
    expect(body).not.toContain("const ids");
  });
});

describe("the menu still routes everything it used to", () => {
  it("every id is listed once", async () => {
    const src = stripComments(await readSrc("lib/keymap.ts"));
    const block = src.slice(
      src.indexOf("const MENU_ACTION_IDS"),
      src.indexOf("];", src.indexOf("const MENU_ACTION_IDS")),
    );
    const ids = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(25);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the actions people actually reach for", async () => {
    const src = stripComments(await readSrc("lib/keymap.ts"));
    const block = src.slice(
      src.indexOf("const MENU_ACTION_IDS"),
      src.indexOf("];", src.indexOf("const MENU_ACTION_IDS")),
    );
    // A regression that silently emptied the list would leave every test
    // above passing and every menu item dead.
    for (const id of ["palette", "settings", "save", "close_tab", "open_aura"]) {
      expect(block).toContain(`"${id}"`);
    }
  });

  it("does not claim the update item, which UpdateBanner owns", async () => {
    const src = stripComments(await readSrc("lib/keymap.ts"));
    // Two listeners on `menu:check_for_updates` would run the update flow
    // twice from one click.
    expect(src).not.toContain('"check_for_updates"');
  });
});
