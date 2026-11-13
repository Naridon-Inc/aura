import { beforeEach, describe, expect, test } from "bun:test";

import {
  count,
  defaultSelection,
  dismissPromo,
  groupItems,
  projectRoom,
  promoCopy,
  promoDismissed,
  promoSource,
  selectedKeys,
  tally,
  type ImportItem,
  type ImportSource,
} from "./importSources";
import { RECENTS_MAX } from "./recentProjects";

const item = (key: string, kind: ImportItem["kind"], state: ImportItem["state"] = "ready", when: number | null = null): ImportItem => ({
  key,
  kind,
  title: key,
  detail: "",
  when,
  state,
  reason: state === "ready" ? null : "why",
  root: null,
});

const source = (id: string, over: Partial<ImportSource> = {}): ImportSource => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  installed: true,
  found: true,
  imported: 0,
  ...over,
});

describe("grouping a scan", () => {
  test("kinds come in a fixed order and empty kinds are left out", () => {
    const groups = groupItems([item("c1", "chat"), item("mcp:a", "mcp"), item("r1", "repo")]);
    expect(groups.map((g) => g.label)).toEqual(["Projects", "Chats", "MCP servers"]);
  });

  test("ready items lead, newest first, then done, then unavailable", () => {
    const [chats] = groupItems([
      item("gone", "chat", "unavailable", 9),
      item("old", "chat", "ready", 1),
      item("had", "chat", "done", 8),
      item("new", "chat", "ready", 5),
    ]);
    expect(chats.items.map((i) => i.key)).toEqual(["new", "old", "had", "gone"]);
    expect(chats.ready).toBe(2);
  });
});

describe("what gets sent", () => {
  const items = [item("a", "repo"), item("b", "chat", "done"), item("c", "chat", "unavailable"), item("d", "chat")];

  test("everything ready is ticked to begin with", () => {
    expect([...defaultSelection(items)].sort()).toEqual(["a", "d"]);
  });

  test("only ready keys that are ticked are sent, in scan order", () => {
    expect(selectedKeys(items, new Set(["d", "b", "c", "a"]))).toEqual(["a", "d"]);
    expect(selectedKeys(items, new Set())).toEqual([]);
  });
});

describe("project list room", () => {
  test("is what is left under the cap, never negative", () => {
    expect(projectRoom([])).toBe(RECENTS_MAX);
    expect(projectRoom(["/a", "/b"])).toBe(RECENTS_MAX - 2);
    expect(projectRoom(Array.from({ length: RECENTS_MAX + 3 }, (_, i) => `/p${i}`))).toBe(0);
  });
});

describe("outcomes", () => {
  test("tally counts each status", () => {
    const o = (status: "imported" | "skipped" | "failed") => ({ key: status, kind: "chat" as const, title: "", status, reason: null, auraRef: null });
    expect(tally([o("imported"), o("imported"), o("failed"), o("skipped")])).toEqual({ imported: 2, skipped: 1, failed: 1 });
  });

  test("count says one or many", () => {
    expect(count(1, "chat")).toBe("1 chat");
    expect(count(3, "chat")).toBe("3 chats");
    expect(count(2, "MCP server")).toBe("2 MCP servers");
  });
});

describe("the promo", () => {
  test("offers an app whose data is here and nothing came over from", () => {
    const pick = promoSource([source("conductor", { imported: 4 }), source("cursor"), source("zed", { found: false })], () => false);
    expect(pick?.id).toBe("cursor");
  });

  test("an installed app comes before one only its data outlived", () => {
    const pick = promoSource([source("void", { installed: false }), source("zed")], () => false);
    expect(pick?.id).toBe("zed");
  });

  test("a dismissed app is never offered again; with nothing left, no promo", () => {
    const dismissed = new Set(["cursor"]);
    expect(promoSource([source("cursor")], (id) => dismissed.has(id))).toBeNull();
    expect(promoSource([], () => false)).toBeNull();
  });

  test("after an import the app is no longer offered", () => {
    expect(promoSource([source("conductor", { imported: 1 })], () => false)).toBeNull();
  });

  test("names the app and says nothing there changes", () => {
    const copy = promoCopy({ id: "conductor", name: "Conductor" });
    expect(copy.title).toBe("Coming from Conductor?");
    expect(copy.message).toContain("workspaces and chats");
    expect(copy.message).toContain("nothing there changes");
    expect(promoCopy({ id: "cursor", name: "Cursor" }).message).toContain("projects and chats");
  });
});

describe("promo dismissal is remembered per app", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  test("dismissing one app leaves the others", () => {
    expect(promoDismissed("cursor")).toBe(false);
    dismissPromo("cursor");
    expect(promoDismissed("cursor")).toBe(true);
    expect(promoDismissed("zed")).toBe(false);
  });

  test("storage that throws counts as dismissed, so it never nags", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(promoDismissed("cursor")).toBe(true);
    expect(() => dismissPromo("cursor")).not.toThrow();
  });
});
