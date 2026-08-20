// Whose key an agent run spends, and the one thing the screen may not round off.
//
// The org key is not an error and not a bug — on a team that pays centrally it is
// the right answer, and on most boxes today it is the only key there is. It is
// also somebody else's money, and a run that spends it produces a bill nobody
// can attribute afterwards. So "we found a key" and "we found yours" are two
// different sentences, and a surface that renders them the same way has put the
// original problem back with a resolver in front of it.

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import { placeHere, placeOfMachine } from "./contract";
import type { AgentKey, KeyPlan } from "./agentKey";

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "shared",
    repo_path: "/home/ubuntu/aura-src",
    project_root: null,
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

function key(over: Partial<AgentKey> = {}): AgentKey {
  return {
    source: "member-key",
    label: "mo's own Anthropic key on aura-runner",
    detail: "/home/mo/.config/aura/agent.env, readable only by mo",
    engine: "claude",
    provider: "Anthropic",
    var: "ANTHROPIC_API_KEY",
    load: { load: "env_file", path: "/home/mo/.config/aura/agent.env" },
    spender: "mo",
    shared: false,
    last_resort: false,
    ...over,
  };
}

function plan(over: Partial<KeyPlan> = {}): KeyPlan {
  return {
    member: "mo",
    engine: "claude",
    provider: "Anthropic",
    var: "ANTHROPIC_API_KEY",
    place: "aura-runner",
    key: key(),
    gap: null,
    considered: [],
    ...over,
  };
}

/** The org key every member has been spending: it answers, it is everybody's,
 *  and it is only reached because nothing of the member's did. */
function orgPlan(): KeyPlan {
  return plan({
    key: key({
      source: "org-key",
      label: "Naridon's shared Anthropic key — every member's runs spend it",
      detail: "held in Naridon's settings as anthropic_api_key (sk-a••••wxyz), not on this place",
      load: { load: "injected" },
      spender: "Naridon",
      shared: true,
      last_resort: true,
    }),
    considered: [
      {
        source: "member-login",
        held: false,
        why: "mo hasn't signed claude in on aura-runner — one `claude setup-token` there and this run is on their own account.",
        last_resort: false,
      },
      {
        source: "member-key",
        held: false,
        why: "mo holds no Anthropic key of their own here.",
        last_resort: false,
      },
      {
        source: "org-key",
        held: true,
        why: "Naridon's shared Anthropic key — every member's runs spend it",
        last_resort: true,
      },
    ],
  });
}

// Every place the call was pointed at, in the order asked.
const asked: Array<{
  place: { root: string | null; machineId: string | null };
  engine: string;
  member?: string;
}> = [];
let answer: KeyPlan | Error = plan();

mock.module("../api", () => ({
  api: {
    placeAgentKey: async (
      place: { root: string | null; machineId: string | null },
      engine: string,
      member?: string,
    ) => {
      asked.push({ place, engine, member });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
}));

const {
  askAgentKey,
  howToRunOnMyOwn,
  keyGapSentence,
  keySentence,
  keyTone,
  whyNotMyKey,
} = await import("./agentKey");

describe("keyTone", () => {
  test("a member's own key is not a warning", () => {
    expect(keyTone(plan())).toBe("own");
  });

  test("the org's key is — it works, on somebody else's bill", () => {
    // The whole point. It resolved, nothing failed, and the screen still has to
    // say something.
    expect(keyTone(orgPlan())).toBe("shared");
  });

  test("the box's own key is the same warning, one level down", () => {
    expect(
      keyTone(
        plan({
          key: key({
            source: "place-key",
            label: "the Anthropic key on aura-runner — everyone here runs on this one",
            spender: "whoever pays for aura-runner",
            shared: true,
            last_resort: true,
          }),
        }),
      ),
    ).toBe("shared");
  });

  test("no key at all is neutral, not an alarm", () => {
    expect(
      keyTone(
        plan({ key: null, gap: { gap: "none_held", engine: "claude", tried: ["member-key"] } }),
      ),
    ).toBe("none");
  });
});

describe("keySentence", () => {
  test("a member's own is stated plainly", () => {
    expect(keySentence(plan())).toBe("Runs on mo's own Anthropic key on aura-runner.");
  });

  test("a shared one names whose money it is, not just which key", () => {
    // "Naridon's shared Anthropic key" tells nobody what it costs them. What a
    // person needs is that this run is not theirs.
    const said = keySentence(orgPlan());
    expect(said).toContain("every member's runs spend it");
    expect(said).toContain("lands on Naridon");
    expect(said).toContain("not on mo");
  });

  test("an engine Aura can't speak for is explained rather than reported as broken", () => {
    // The run still happens. Saying "no key" would be a lie about a session
    // that is about to start perfectly well.
    const said = keySentence(
      plan({
        engine: "kimi",
        key: null,
        gap: { gap: "unknown_engine", engine: "kimi", known: "claude, codex, gemini" },
      }),
    );
    expect(said).toContain("spends whatever aura-runner already holds");
    expect(said).toContain("claude, codex, gemini");
  });

  test("a place holding nothing says which place and which engine", () => {
    const said = keySentence(
      plan({
        key: null,
        gap: { gap: "none_held", engine: "claude", tried: ["member-key", "org-key"] },
      }),
    );
    expect(said).toContain("aura-runner");
    expect(said).toContain("claude");
  });

  test("every gap has a sentence — none falls through to empty", () => {
    const gaps: KeyPlan["gap"][] = [
      { gap: "no_member" },
      { gap: "unknown_engine", engine: "kimi", known: "claude" },
      { gap: "none_held", engine: "claude", tried: ["member-key"] },
    ];
    for (const gap of gaps) {
      expect(keyGapSentence(plan({ key: null, gap })).length).toBeGreaterThan(10);
    }
  });
});

describe("whyNotMyKey", () => {
  test("the reasons a member's own wasn't used are the instructions for having one", () => {
    expect(whyNotMyKey(orgPlan())).toEqual([
      "mo hasn't signed claude in on aura-runner — one `claude setup-token` there and this run is on their own account.",
      "mo holds no Anthropic key of their own here.",
    ]);
  });

  test("the source that did answer is not listed as a reason it didn't", () => {
    expect(whyNotMyKey(orgPlan())).not.toContain(
      "Naridon's shared Anthropic key — every member's runs spend it",
    );
  });
});

describe("howToRunOnMyOwn", () => {
  test("a run on somebody else's key comes with the one thing that fixes it", () => {
    const how = howToRunOnMyOwn(orgPlan());
    expect(how).toContain("Sign claude in as yourself on aura-runner");
    expect(how).toContain("ANTHROPIC_API_KEY");
  });

  test("a member already on their own key is told nothing", () => {
    // A surface that suggested a fix here would be telling somebody their
    // correct setup is wrong.
    expect(howToRunOnMyOwn(plan())).toBe("");
  });

  test("a place holding nothing still gets the instructions", () => {
    expect(
      howToRunOnMyOwn(
        plan({ key: null, gap: { gap: "none_held", engine: "claude", tried: [] } }),
      ).length,
    ).toBeGreaterThan(10);
  });
});

describe("askAgentKey", () => {
  test("a box is asked by id, this laptop by root — one call, both modes", async () => {
    asked.length = 0;
    answer = plan();
    await askAgentKey(placeOfMachine(box()), "claude");
    await askAgentKey(placeHere("/Users/mo/aura"), "claude");
    expect(asked.map((a) => a.place)).toEqual([
      { root: null, machineId: "ubuntu@10.0.0.1" },
      { root: "/Users/mo/aura", machineId: null },
    ]);
  });

  test("the engine is part of the ask, because a credential is per engine", async () => {
    asked.length = 0;
    await askAgentKey(placeOfMachine(box()), "gemini", "mo");
    expect(asked[0]?.engine).toBe("gemini");
    expect(asked[0]?.member).toBe("mo");
  });

  test("an unreachable place throws rather than resolving to a guess", async () => {
    // The distinction `capabilities` keeps too: a place that didn't answer has
    // not told us whose key it holds. Inventing one here would put a sentence
    // about somebody's money on screen that nothing checked.
    answer = new Error("ssh: connect to host 10.0.0.1: Operation timed out");
    await expect(askAgentKey(placeOfMachine(box()), "claude")).rejects.toThrow("timed out");
    answer = plan();
  });

  test("nothing a plan can carry is key material", () => {
    // Not a test of a string — a test of the TYPE. The plan holds a variable's
    // name and a path; there is no field for a value, so no surface can leak one.
    const held = JSON.stringify(plan({ key: key({ load: { load: "already_in_env" } }) }));
    expect(held).toContain("ANTHROPIC_API_KEY");
    expect(held).not.toContain("sk-ant");
  });
});
