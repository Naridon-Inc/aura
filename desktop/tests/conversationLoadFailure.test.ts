// A conversation that cannot open must say so.
//
//   bun test
//
// `managerStore` fetched each session's snapshot in two places — once on
// attach, once on every 2s watchdog tick — and both wrote the failure to
// `catch {}`. The comments said why: a session created moments ago genuinely
// isn't on disk yet, and the event listener will fill it in. True, and it made
// "still loading" the only state a conversation could ever be in.
//
// So a real chat sat on `Loading conversation… · 420s` while the backend
// answered `read …/manager-sessions/<id>.json: No such file or directory` to
// all 71 attempts. The app was neither slow nor confused; it knew exactly what
// was wrong on the first try and had no way to pass that on. The user's only
// signal was a counter going up.
//
// Two things are pinned here.
//
// 1. THE FAILURE IS KEPT, NOT SWALLOWED. Both fetch paths record it, and both
//    clear it on the next success — a stale error under a loaded session is
//    the same lie pointing the other way.
//
// 2. A COUNT DECIDES, NOT A FLAG. The optimistic reading has to survive: one
//    miss right after `manager_chat_start` is ordinary. Three in a row is a
//    session that isn't coming, and that is when the spinner gives way.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

describe("a conversation that didn't open says so", () => {
  test("both snapshot fetches record the failure instead of dropping it", async () => {
    const src = await readSrc("lib/managerStore.ts");
    // The bare catch is the defect — scoped to `attachSession`, which owns both
    // snapshot fetches. `refreshSummaries` keeps its silent catch on purpose:
    // it polls a LIST, a stale list is a reasonable degrade, and no surface
    // promises otherwise. A single conversation refusing to open is not.
    const attach = src.slice(
      src.indexOf("async function attachSession"),
      src.indexOf("function detachSession"),
    );
    expect(attach).not.toContain("} catch {");
    // Three: attach, the watchdog tick, and the explicit retry.
    expect(src.match(/recordLoadFailure\(sid, e\)/g)).toHaveLength(3);
    // And a success has to erase the error, or a session that recovers keeps
    // rendering a stale reason under a perfectly good transcript.
    expect(src.match(/clearLoadFailure\(sid\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the surface reads the failure and offers a way out", async () => {
    const src = await readSrc("components/manager/ManagerSurface.tsx");
    expect(src).toContain("useManagerLoadError");
    expect(src).toContain("This conversation didn’t open");
    // The raw backend line is shown. It is what told us the dev app was
    // reading a different HOME; a headline alone would have hidden that.
    expect(src).toContain("failure.message");
    // Two ways out, and neither is "wait longer".
    expect(src).toContain("retryManagerSession");
    expect(src).toContain("Try again");
    expect(src).toContain("closeManager(sessionId)");
  });

  test("three misses, not one, before the spinner gives up", async () => {
    const src = await readSrc("components/manager/ManagerSurface.tsx");
    expect(src).toContain("(failure?.failures ?? 0) >= 3");
    // Still loading is still loading: the elapsed counter and its escape hatch
    // stay for the genuinely slow case.
    expect(src).toContain("Loading conversation…");
    expect(src).toContain("elapsed >= 12");
  });

  test("the console is told once, not every two seconds", async () => {
    const src = await readSrc("lib/managerStore.ts");
    expect(src).toContain("if (failures === 1) console.warn");
  });

  test("the watchdog stops asking a session that isn't coming", async () => {
    // Left running it asked 116 times and counting for a file that had been
    // gone since before the tab opened — an IPC round-trip every 2s per dead
    // tab, and a number on screen that grew instead of meaning something.
    const src = await readSrc("lib/managerStore.ts");
    expect(src).toContain("const GIVE_UP_AFTER = 5");
    expect(src).toContain("if ((failed?.failures ?? 0) >= GIVE_UP_AFTER) return;");
    // And a file the backend says isn't there gets no five tries at all — the
    // watchdog stops on the verdict, not on the count.
    expect(src).toContain("if (failed?.gone) return;");
    // Giving up is only honest with a way back: Try again clears the record,
    // which restarts the watchdog as well as re-fetching once.
    const retry = src.slice(src.indexOf("export async function retryManagerSession"));
    expect(retry.slice(0, retry.indexOf("}"))).toContain("clearLoadFailure(sid)");
  });
});

// A conversation whose file is GONE is a different fact from one that failed to
// load, and the app had no way to say it. The screenshot that started this:
// "Aura asked 4 times and got nothing back" over
// `read …/58390e62-….json: No such file or directory` — for a session with no
// `.json` and no `.card` anywhere under `~/.aura`. Nothing was slow. It was
// deleted, and the tab came back on every launch because `switchWorkspace`
// restores `managerTabs` out of the workspace snapshot without ever asking
// whether those sessions still exist. Closing the tab edits the ONE slot you
// are standing in; every other workspace's slot still holds the id.
describe("a conversation whose file is gone stops coming back", () => {
  test("missing-file is a verdict, reached by repetition not on the first miss", async () => {
    const src = await readSrc("lib/managerStore.ts");
    // The optimistic reading still has to survive: `manager_chat_start` hands
    // back an id before the first write lands, so one ENOENT is ordinary.
    expect(src).toContain("const GONE_AFTER = 3");
    expect(src).toContain("function isMissingFile");
    expect(src).toContain("no such file or directory");
    expect(src).toContain("os error 2");
    expect(src).toContain("gone = isMissingFile(message) && failures >= GONE_AFTER");
  });

  test("the verdict erases the id from every saved layout, not just this one", async () => {
    const src = await readSrc("lib/managerStore.ts");
    expect(src).toContain("forgetManagerSessionEverywhere(sid)");
    // Once — on the tick the verdict is reached. Sweeping storage on every
    // later failure would be pointless work under a 2s timer.
    expect(src).toContain("failures === GONE_AFTER");

    const editor = await readSrc("lib/editorStore.ts");
    const sweep = editor.slice(editor.indexOf("export function forgetManagerSessionEverywhere"));
    const body = sweep.slice(0, sweep.indexOf("\n}"));
    // Every workspace slot, or the next switch brings the tab back.
    expect(body).toContain("snapshotSlotKeys()");
    expect(body).toContain("saveSnapshotAt");
    // Three places one id can hide inside a snapshot: the tab strip, the
    // active-tab marker, and a leaf in the split tree.
    expect(body).toContain("t.sessionId !== sessionId");
    expect(body).toContain("activeManagerId");
    expect(body).toContain("treeRemove");
    // Plus the two global slots outside the per-workspace snapshots.
    expect(body).toContain("MANAGER_TABS_KEY");
    expect(body).toContain("aura.orchestrator.session");
  });

  test("the surface says gone, and offers no way to retry a file that isn't there", async () => {
    const src = await readSrc("components/manager/ManagerSurface.tsx");
    expect(src).toContain("This conversation is gone");
    // The distinction the user asked about: not "didn't open", and not a
    // number of attempts. It won't be back next launch either.
    const gone = src.slice(src.indexOf("This conversation is gone"));
    const branch = gone.slice(0, gone.indexOf("Close tab"));
    expect(branch).not.toContain("Try again");
    expect(branch).toContain("Your other conversations aren’t");
  });
});
