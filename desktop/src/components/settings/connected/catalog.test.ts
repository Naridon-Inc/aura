// Run with: bun test src/components/settings/connected/catalog.test.ts
//
// The rule this file exists to hold: a service appears in exactly one of the
// two lists, never both and never neither. Settings previously showed six
// cards whether or not any of them were connected, so "what am I actually
// signed in to?" took reading the whole pane. The pane now shows only the
// inventory and the store only the remainder — which is only true as long as
// the split stays a partition.

import { describe, expect, it } from "bun:test";

import {
  CATALOG,
  groupAvailable,
  isConnected,
  isReady,
  splitServices,
  type ServiceFacts,
} from "./catalog";

const NOTHING: ServiceFacts = {
  keyLast4: {},
  activeProvider: null,
  trackers: [],
};

const ids = (xs: Array<{ entry: { id: string } }>) => xs.map((x) => x.entry.id);

describe("the catalogue is a catalogue", () => {
  it("has no duplicate ids", () => {
    const seen = CATALOG.map((e) => e.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("gives every service a sentence a non-engineer can read", () => {
    for (const e of CATALOG) {
      expect(e.blurb.length).toBeGreaterThan(20);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
});

describe("connected and available are a partition", () => {
  it("puts everything in exactly one list when nothing is connected", () => {
    const { connected, available } = splitServices(NOTHING);
    expect(connected).toEqual([]);
    expect(ids(available)).toEqual(CATALOG.map((e) => e.id));
  });

  it("moves a service across as soon as it is connected, and only it", () => {
    const facts: ServiceFacts = {
      ...NOTHING,
      keyLast4: { anthropic: "b4a1" },
    };
    const { connected, available } = splitServices(facts);
    expect(ids(connected)).toEqual(["anthropic"]);
    expect(ids(available)).not.toContain("anthropic");
    expect(ids(connected).length + ids(available).length).toBe(CATALOG.length);
  });

  it("holds for a mixed state", () => {
    const facts: ServiceFacts = {
      keyLast4: { anthropic: "b4a1", gemini: "99zz" },
      activeProvider: "gemini",
      trackers: [
        { kind: "jira", connected: true, configured: true, identity: { display_name: "Ash" } },
        { kind: "linear", connected: false, configured: false },
      ],
    };
    const { connected, available } = splitServices(facts);
    expect(ids(connected).sort()).toEqual(["anthropic", "gemini", "jira"]);
    expect(ids(available).sort()).toEqual(["beads", "linear", "mercury", "openai"]);
  });
});

describe("what a connected row says about itself", () => {
  it("shows a key by its last four and never more", () => {
    const { connected } = splitServices({
      ...NOTHING,
      keyLast4: { openai: "0f3d" },
    });
    expect(connected[0]!.detail).toBe("Key ending 0f3d");
  });

  it("names the account behind a tracker", () => {
    const { connected } = splitServices({
      ...NOTHING,
      trackers: [
        {
          kind: "linear",
          connected: true,
          configured: true,
          identity: { display_name: null, email: "mo@touchstage.example" },
        },
      ],
    });
    expect(connected[0]!.detail).toBe("mo@touchstage.example");
  });

  it("marks the one provider the app is actually asking", () => {
    const { connected } = splitServices({
      keyLast4: { anthropic: "aaaa", openai: "bbbb" },
      activeProvider: "openai",
      trackers: [],
    });
    expect(connected.find((c) => c.entry.id === "openai")!.active).toBe(true);
    expect(connected.find((c) => c.entry.id === "anthropic")!.active).toBe(false);
  });
});

describe("a tracker with no app on this machine", () => {
  const facts: ServiceFacts = {
    ...NOTHING,
    trackers: [{ kind: "jira", connected: false, configured: false }],
  };

  it("is listed, so the reader learns it exists", () => {
    expect(ids(splitServices(facts).available)).toContain("jira");
  });

  it("is marked not-ready, so the store can say why instead of offering a button that fails", () => {
    const jira = CATALOG.find((e) => e.id === "jira")!;
    expect(isReady(facts, jira)).toBe(false);
    expect(isConnected(facts, jira)).toBe(false);
  });

  it("counts as ready once the machine has its id and secret", () => {
    const jira = CATALOG.find((e) => e.id === "jira")!;
    expect(
      isReady({ ...NOTHING, trackers: [{ kind: "jira", connected: false, configured: true }] }, jira),
    ).toBe(true);
  });

  it("treats a tracker the server never mentioned as not connected", () => {
    // `integrations_list` returning nothing is not "everything is connected".
    const linear = CATALOG.find((e) => e.id === "linear")!;
    expect(isConnected(NOTHING, linear)).toBe(false);
  });
});

describe("an import is never a connection", () => {
  it("keeps Beads in the store no matter what else is true", () => {
    const facts: ServiceFacts = {
      keyLast4: { anthropic: "aaaa", openai: "bbbb", gemini: "cccc", mercury: "dddd" },
      activeProvider: "anthropic",
      trackers: [
        { kind: "jira", connected: true, configured: true },
        { kind: "linear", connected: true, configured: true },
      ],
    };
    const { connected, available } = splitServices(facts);
    expect(ids(connected)).not.toContain("beads");
    expect(ids(available)).toEqual(["beads"]);
  });
});

describe("the store's headings", () => {
  it("drops a heading with nothing under it", () => {
    const { available } = splitServices({
      ...NOTHING,
      keyLast4: { anthropic: "a", openai: "b", gemini: "c", mercury: "d" },
    });
    const groups = groupAvailable(available);
    expect(groups.map((g) => g.category)).toEqual(["tracker", "import"]);
  });

  it("keeps catalogue order, so the store reads the same every time", () => {
    const groups = groupAvailable(splitServices(NOTHING).available);
    expect(groups.map((g) => g.category)).toEqual(["model", "tracker", "import"]);
    expect(ids(groups[0]!.items)).toEqual(["anthropic", "openai", "gemini", "mercury"]);
  });
});
