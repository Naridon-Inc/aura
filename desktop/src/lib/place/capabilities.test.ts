// What a place can run, and the one rule the fold was not allowed to lose.
//
// `offerableAgents(null)` and `offerableAgents({agents: []})` both look like
// "an empty answer" and mean opposite things: the second is the place telling
// us about itself, the first is us failing to get an answer at all. Collapsing
// them shows an empty picker to somebody whose box is merely slow, and the only
// thing they can conclude from it is that their machine is broken.

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import type { PlaceCapabilities } from "./contract";
import { placeHere, placeOfMachine } from "./contract";

function caps(over: Partial<PlaceCapabilities> = {}): PlaceCapabilities {
  return { agents: [], git: true, tmux: true, aura: false, ...over };
}

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "mine",
    repo_path: "/home/ubuntu/aura-src",
    project_root: null,
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

// Every place the capabilities call was pointed at, in order asked.
const asked: Array<{ root: string | null; machineId: string | null }> = [];
let answer: PlaceCapabilities | Error = caps({ agents: ["claude"] });

mock.module("../api", () => ({
  api: {
    placeCapabilities: async (
      place: { root: string | null; machineId: string | null },
      bins: string[],
    ) => {
      asked.push(place);
      if (answer instanceof Error) throw answer;
      return { ...answer, agents: answer.agents.filter((a) => bins.includes(a)) };
    },
  },
}));

const {
  AGENT_CANDIDATES,
  AGENT_CANDIDATE_BINS,
  askCapabilities,
  offerableAgents,
  resolveSelectedAgent,
} = await import("./capabilities");

describe("offerableAgents", () => {
  test("not yet asked → offer everything (don't blank the picker)", () => {
    expect(offerableAgents(null)).toEqual(AGENT_CANDIDATES);
  });

  test("offers only what the place reported, in canonical order", () => {
    const out = offerableAgents(caps({ agents: ["gemini", "claude"] }));
    expect(out.map((a) => a.id)).toEqual(["claude", "gemini"]);
  });

  test("a place with none installed offers nothing", () => {
    expect(offerableAgents(caps({ agents: [] }))).toEqual([]);
  });

  test("an unknown binary the place reports is ignored, not offered", () => {
    // The probe only returns names from the set we asked, but be defensive.
    expect(offerableAgents(caps({ agents: ["ghost"] }))).toEqual([]);
  });
});

describe("unreachable is not empty", () => {
  test("unknown and none-installed are different answers", () => {
    const unknown = offerableAgents(null);
    const none = offerableAgents(caps({ agents: [] }));
    expect(unknown.length).toBe(AGENT_CANDIDATES.length);
    expect(none.length).toBe(0);
    expect(unknown).not.toEqual(none);
  });

  test("a fresh place has not been asked, so it is unknown — not empty", () => {
    // `placeOfMachine` reads the machine BOOK, which holds an address and has
    // never asked the box anything. Defaulting that to "no agents" would blank
    // every picker for the first beat of every box.
    const p = placeOfMachine(box());
    expect(p.capabilities).toBe(null);
    expect(offerableAgents(p.capabilities)).toEqual(AGENT_CANDIDATES);
  });

  test("a place that answered with nothing stays empty", () => {
    const p = placeOfMachine(box(), caps({ agents: [] }));
    expect(offerableAgents(p.capabilities)).toEqual([]);
  });

  test("an unreachable place throws — it does not answer 'none'", async () => {
    // This is the half of the rule that lives in the call rather than the
    // picker. If it resolved to an empty capabilities instead of throwing, no
    // caller could tell the two apart no matter how carefully it was written.
    answer = new Error("ssh: connect to host 10.0.0.1 port 22: Connection refused");
    await expect(askCapabilities(placeOfMachine(box()))).rejects.toThrow(
      "Connection refused",
    );
    answer = caps({ agents: ["claude"] });
  });

  test("the caught throw lands as null, and the full set comes back", async () => {
    // The shape every caller has to get right. Holding `[]` here instead is the
    // whole bug, and it looks identical on the day you write it — the box is
    // up, the probe succeeds, nobody sees it.
    answer = new Error("Permission denied (publickey)");
    let held: PlaceCapabilities | null = caps({ agents: ["claude"] });
    try {
      held = await askCapabilities(placeOfMachine(box()));
    } catch {
      held = null;
    }
    answer = caps({ agents: ["claude"] });
    expect(held).toBe(null);
    expect(offerableAgents(held)).toEqual(AGENT_CANDIDATES);
  });
});

describe("resolveSelectedAgent", () => {
  test("keeps the current pick when it's still installed", () => {
    const offer = offerableAgents(caps({ agents: ["claude", "gemini"] }));
    expect(resolveSelectedAgent("gemini", offer)).toBe("gemini");
  });

  test("falls to the first offered (canonical order) when the pick is gone", () => {
    // The filtered set keeps AGENT_CANDIDATES order, so codex leads gemini.
    const offer = offerableAgents(caps({ agents: ["gemini", "codex"] }));
    expect(resolveSelectedAgent("claude", offer)).toBe("codex");
  });

  test("empty offer set resolves to no selection", () => {
    expect(resolveSelectedAgent("claude", [])).toBe("");
  });
});

// The governing rule of this programme, at the seam this module owns: no
// feature may land in one place-mode only. A capabilities call that could only
// be spelled for a box would be exactly that — and that is what the old
// `boxAgents(machineId, bins)` was, by its signature alone.
describe("one call, both place-modes", () => {
  test("a box and this laptop are asked the same way", async () => {
    asked.length = 0;
    const remote = placeOfMachine(box({ project_root: "/Users/me/aura" }));
    const local = placeHere("/Users/me/aura");

    expect((await askCapabilities(remote, ["claude"])).agents).toEqual(["claude"]);
    expect((await askCapabilities(local, ["claude"])).agents).toEqual(["claude"]);

    // Same function, same arguments, one field apart — and that field is the
    // only thing that differs between the two ways of having a place.
    expect(asked).toEqual([
      { root: "/Users/me/aura", machineId: "ubuntu@10.0.0.1" },
      { root: "/Users/me/aura", machineId: null },
    ]);
  });

  test("the whole candidate set is asked about by default", async () => {
    asked.length = 0;
    answer = caps({ agents: AGENT_CANDIDATE_BINS });
    const out = await askCapabilities(placeHere("/Users/me/aura"));
    // Not a subset chosen per place-mode: one set, asked everywhere, so a box
    // and this laptop can be compared on the same question.
    expect(out.agents).toEqual(AGENT_CANDIDATE_BINS);
    answer = caps({ agents: ["claude"] });
  });

  test("capabilities are more than the agent list", async () => {
    // The old call handed back `.agents` and dropped git/tmux/aura from the
    // same probe that found them, so a surface that needed to know "this place
    // has no tmux, it cannot hold a session" had to go and ask again.
    answer = caps({ agents: ["claude"], git: true, tmux: false, aura: true });
    const out = await askCapabilities(placeOfMachine(box()));
    expect(out).toEqual({
      agents: ["claude"],
      git: true,
      tmux: false,
      aura: true,
    });
    answer = caps({ agents: ["claude"] });
  });
});
