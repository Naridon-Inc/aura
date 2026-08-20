// "All modes are up to date." — said by a check that never ran.
//
//   bun test
//
// `refreshUpdates` caught its own failure and left `updates` at `[]`:
//
//     } catch {
//       // Offline → leave the previous value alone.
//     }
//
// There is no previous value on a first run, so offline meant zero rows, and
// zero rows on the Updates tab printed the all-clear. The tab beside it read
// `Updates (0)` off the same unread array, so both readouts agreed, and both
// were guessing. The same line covered two more states it hadn't earned: the
// Installed tab printed "No modes yet." when the read of your installed modes
// FAILED (that error was rendered nowhere), and the All tab printed it while
// the marketplace was still loading.
//
// Every answer here now has to be earned by a read that came back.

import { describe, expect, test } from "bun:test";

import {
  modesEmptyCopy,
  tabCountLabel,
  type ModesReadState,
  type ModesTab,
} from "../src/lib/modesEmpty";
import { stripComments as code } from "./support/code";

const LANDED = 1_700_000_000_000;

/** Everything read, nothing failed, nothing searched. */
const S = (over: Partial<ModesReadState> = {}): ModesReadState => ({
  tab: "updates",
  query: "",
  installedLoading: false,
  installedLoadedAt: LANDED,
  installedError: null,
  marketplaceLoading: false,
  marketplaceLoadedAt: LANDED,
  marketplaceError: null,
  updatesLoading: false,
  updatesLoadedAt: LANDED,
  updatesError: null,
  ...over,
});

const TABS: ModesTab[] = ["all", "installed", "updates"];

describe("the update check has to have run before it can say all-clear", () => {
  test("a failed check is not an up-to-date verdict", () => {
    const e = modesEmptyCopy(S({ updatesError: "fetch failed: offline" }));
    expect(e.kind).toBe("failed");
    if (e.kind !== "failed") throw new Error("unreachable");
    expect(e.title).toContain("couldn’t check for updates");
    expect(e.message).toContain("offline");
  });

  test("a check that never ran is not an up-to-date verdict", () => {
    // The first-run shape: nothing loading, nothing loaded, nothing failed.
    const e = modesEmptyCopy(S({ updatesLoadedAt: null }));
    expect(e.kind).toBe("waiting");
  });

  test("a check in flight is not an up-to-date verdict", () => {
    expect(modesEmptyCopy(S({ updatesLoading: true })).kind).toBe("waiting");
  });

  test("a completed check with nothing to report says so", () => {
    const e = modesEmptyCopy(S());
    expect(e.kind).toBe("empty");
    if (e.kind !== "empty") throw new Error("unreachable");
    expect(e.title).toBe("All modes are up to date");
  });

  test("the tab beside it stops counting a set nobody read", () => {
    expect(tabCountLabel("Updates", 0, null)).toBe("Updates");
    expect(tabCountLabel("Updates", 0, LANDED)).toBe("Updates (0)");
    expect(tabCountLabel("Installed", 3, LANDED)).toBe("Installed (3)");
  });

  test("the installed list failing also stops the all-clear", () => {
    // The Updates tab is built by intersecting installed modes with the
    // update rows. If the first list never arrived, "up to date" is a claim
    // about a set we don't have.
    expect(modesEmptyCopy(S({ installedError: "EACCES" })).kind).toBe("failed");
    expect(modesEmptyCopy(S({ installedLoadedAt: null })).kind).toBe("waiting");
  });
});

describe("every tab earns what it says", () => {
  test("no tab claims anything while a read it needs is out", () => {
    for (const tab of TABS) {
      expect(modesEmptyCopy(S({ tab, installedLoadedAt: null })).kind).toBe(
        "waiting",
      );
      expect(modesEmptyCopy(S({ tab, installedLoading: true })).kind).toBe(
        "waiting",
      );
    }
    // Only the two tabs made of marketplace data wait on the marketplace.
    expect(modesEmptyCopy(S({ tab: "all", marketplaceLoadedAt: null })).kind).toBe(
      "waiting",
    );
    expect(
      modesEmptyCopy(S({ tab: "installed", marketplaceLoadedAt: null })).kind,
    ).toBe("empty");
  });

  test("a broken read is reported on every tab that depends on it", () => {
    for (const tab of TABS) {
      const e = modesEmptyCopy(S({ tab, installedError: "boom" }));
      expect(e.kind).toBe("failed");
    }
    expect(modesEmptyCopy(S({ tab: "all", marketplaceError: "503" })).kind).toBe(
      "failed",
    );
  });

  test("a search that matched nothing is only said once the list arrived", () => {
    for (const tab of TABS) {
      expect(modesEmptyCopy(S({ tab, query: "zzz" })).kind).toBe("filtered");
      // …but a pending or broken read outranks it. Telling somebody their
      // search matched nothing, when nothing was there to search, is the
      // same defect wearing different words.
      expect(
        modesEmptyCopy(S({ tab, query: "zzz", installedLoadedAt: null })).kind,
      ).toBe("waiting");
      expect(
        modesEmptyCopy(S({ tab, query: "zzz", installedError: "boom" })).kind,
      ).toBe("failed");
    }
  });

  test("each tab's genuinely-empty answer is its own", () => {
    const titles = TABS.map((tab) => {
      const e = modesEmptyCopy(S({ tab }));
      if (e.kind !== "empty") throw new Error(`${tab} should be empty here`);
      return e.title;
    });
    expect(new Set(titles).size).toBe(TABS.length);
    // And none of them is the old catch-all.
    for (const t of titles) expect(t).not.toBe("No modes yet.");
  });

  test("a failure always carries the text of what went wrong", () => {
    for (const tab of TABS) {
      const e = modesEmptyCopy(S({ tab, installedError: "ENOENT: modes dir" }));
      if (e.kind !== "failed") throw new Error("expected failed");
      expect(e.message).toBe("ENOENT: modes dir");
      expect(e.title.length).toBeGreaterThan(0);
    }
  });
});

describe("the dialog draws the answer the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the empty area is the fold, in the app's own primitives", async () => {
    const src = await read("components/marketplace/MarketplaceDialog.tsx");
    expect(src).toContain("modesEmptyCopy({");
    expect(src).toContain('empty.kind === "waiting"');
    expect(src).toContain('empty.kind === "failed"');
    expect(src).toContain('empty.kind === "filtered"');
    expect(src).toContain("<LoadingState");
    expect(src).toContain("<ErrorState");
    expect(src).toContain("onRetry={refreshAll}");
    // Not one hand-written sentence left behind.
    expect(src).not.toContain("All modes are up to date.");
    expect(src).not.toContain("No modes yet.");
    expect(src).not.toContain("No modes match");
    // The "marketplace unavailable" band only appears ALONGSIDE rows. With no
    // rows it used to stack on top of the words "No modes yet." — two answers
    // to one question, one of them wrong. Now the fold speaks instead.
    expect(src.replace(/\s+/g, "")).toContain(
      'store.marketplaceError&&tab!=="installed"&&filtered.length>0&&(',
    );
  });

  test("the fold is fed every signal the store tracks", async () => {
    const src = await read("components/marketplace/MarketplaceDialog.tsx");
    for (const arg of [
      "installedLoading: store.installedLoading",
      "installedLoadedAt: store.installedLoadedAt",
      "installedError: store.installedError",
      "marketplaceLoading: store.marketplaceLoading",
      "marketplaceLoadedAt: store.marketplaceLoadedAt",
      "marketplaceError: store.marketplaceError",
      "updatesLoading: store.updatesLoading",
      "updatesLoadedAt: store.updatesLoadedAt",
      "updatesError: store.updatesError",
    ]) {
      expect(src).toContain(arg);
    }
  });

  test("the tab counts go through the honest label", async () => {
    const src = await read("components/marketplace/MarketplaceDialog.tsx");
    // Whitespace-insensitive: one of these two calls fits on a line and the
    // other doesn't, and which is which is the formatter's business, not this
    // test's. Pin the arguments — that a count is only printed alongside the
    // read that produced it is the whole point.
    const flat = src.replace(/\s+/g, "");
    expect(flat).toContain(
      'tabCountLabel("Installed",store.installed.length,store.installedLoadedAt',
    );
    expect(flat).toContain(
      'tabCountLabel("Updates",store.updates.length,store.updatesLoadedAt',
    );
    expect(src).not.toContain("`Updates (${store.updates.length})`");
    expect(src).not.toContain("`Installed (${store.installed.length})`");
  });

  test("the store records a failed update check instead of swallowing it", async () => {
    const src = await read("lib/modesStore.ts");
    expect(src).toContain("state.updatesError = String(e);");
    expect(src).toContain("state.updatesError = null;");
    expect(src).toContain("state.updatesLoading = true;");
    // The catch that used to be empty.
    expect(src).not.toContain("} catch {\n    // Offline");
  });
});
