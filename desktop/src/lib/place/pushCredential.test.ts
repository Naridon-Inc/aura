// Whose credential a push spends, and the one thing the screen may not round
// off.
//
// A shared box credential is not an error — it works, and on most boxes it is
// the only credential there is. It is also somebody else's, and a commit made
// with it carries their name. So "we found one" and "we found yours" are two
// different sentences, and a surface that renders both the same way has put the
// original bug back with extra steps.

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import { placeHere, placeOfMachine } from "./contract";
import type { GitCredential, PushPlan } from "./pushCredential";

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

function cred(over: Partial<GitCredential> = {}): GitCredential {
  return {
    source: "member-store",
    label: "mo's own credential on aura-runner",
    helper: "store --file=/home/mo/.git-credentials",
    detail: "/home/mo/.git-credentials, readable only by mo",
    host: "github.com",
    shared: false,
    last_resort: false,
    ...over,
  };
}

function plan(over: Partial<PushPlan> = {}): PushPlan {
  return {
    member: "mo",
    remote: "https://github.com/Uniskool/naridon.git",
    host: "github.com",
    place: "aura-runner",
    credential: cred(),
    gap: null,
    considered: [],
    ...over,
  };
}

/** The shared credential `provision.sh` leaves on every box: it answers, it is
 *  everybody's, and it is only reached because nothing else did. */
function sharedPlan(): PushPlan {
  return plan({
    credential: cred({
      source: "place-default",
      label: "the shared credential on aura-runner — everyone here pushes as this",
      shared: true,
      last_resort: true,
    }),
    considered: [
      {
        source: "member-store",
        held: false,
        why: "mo has no account of their own on aura-runner yet.",
        last_resort: false,
      },
      {
        source: "place-default",
        held: true,
        why: "the shared credential on aura-runner — everyone here pushes as this",
        last_resort: true,
      },
    ],
  });
}

// Every place the call was pointed at, in the order asked.
const asked: Array<{
  place: { root: string | null; machineId: string | null };
  remote: string;
  member?: string;
}> = [];
let answer: PushPlan | Error = plan();

mock.module("../api", () => ({
  api: {
    placePushCredential: async (
      place: { root: string | null; machineId: string | null },
      remote: string,
      member?: string,
    ) => {
      asked.push({ place, remote, member });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
}));

const {
  askPushCredential,
  credentialSentence,
  credentialTone,
  gapSentence,
  whyNotMine,
} = await import("./pushCredential");

describe("credentialTone", () => {
  test("a member's own credential is not a warning", () => {
    expect(credentialTone(plan())).toBe("own");
  });

  test("the shared box credential is — it works, under somebody else's name", () => {
    // The whole point. It resolved, nothing failed, and the screen still has to
    // say something.
    expect(credentialTone(sharedPlan())).toBe("shared");
  });

  test("no credential at all is neutral, not an alarm", () => {
    expect(
      credentialTone(
        plan({ credential: null, gap: { gap: "pushes_with_an_ssh_key", host: "github.com" } }),
      ),
    ).toBe("none");
  });
});

describe("credentialSentence", () => {
  test("a member's own is stated plainly", () => {
    expect(credentialSentence(plan())).toBe(
      "Pushes with mo's own credential on aura-runner.",
    );
  });

  test("a shared one names the consequence, not just the credential", () => {
    // "the shared credential on aura-runner" tells nobody anything. What a
    // person needs is what it does to their commits.
    const said = credentialSentence(sharedPlan());
    expect(said).toContain("everyone here pushes as this");
    expect(said).toContain("not under mo");
  });

  test("an ssh remote is explained rather than reported as missing", () => {
    const said = credentialSentence(
      plan({ credential: null, gap: { gap: "pushes_with_an_ssh_key", host: "github.com" } }),
    );
    expect(said).toContain("over ssh");
    expect(said).not.toContain("nothing");
  });

  test("a place holding none says which place and which host", () => {
    const said = credentialSentence(
      plan({
        credential: null,
        gap: { gap: "none_held", host: "github.com", tried: ["member-store", "place-default"] },
      }),
    );
    expect(said).toContain("aura-runner");
    expect(said).toContain("github.com");
  });

  test("every gap has a sentence — none falls through to empty", () => {
    const gaps: PushPlan["gap"][] = [
      { gap: "no_member" },
      { gap: "not_a_remote", remote: "rm -rf /" },
      { gap: "pushes_with_an_ssh_key", host: "github.com" },
      { gap: "none_held", host: "github.com", tried: ["member-store"] },
    ];
    for (const gap of gaps) {
      expect(gapSentence(plan({ credential: null, gap })).length).toBeGreaterThan(10);
    }
  });
});

describe("whyNotMine", () => {
  test("the reasons a member's own wasn't used are the instructions for having one", () => {
    expect(whyNotMine(sharedPlan())).toEqual([
      "mo has no account of their own on aura-runner yet.",
    ]);
  });

  test("the source that did answer is not listed as a reason it didn't", () => {
    expect(whyNotMine(sharedPlan())).not.toContain(
      "the shared credential on aura-runner — everyone here pushes as this",
    );
  });
});

describe("askPushCredential", () => {
  test("a box is asked by id, this laptop by root — one call, both modes", async () => {
    asked.length = 0;
    answer = plan();
    await askPushCredential(placeOfMachine(box()), "https://github.com/a/b.git");
    await askPushCredential(placeHere("/Users/mo/aura"), "https://github.com/a/b.git");
    expect(asked.map((a) => a.place)).toEqual([
      { root: null, machineId: "ubuntu@10.0.0.1" },
      { root: "/Users/mo/aura", machineId: null },
    ]);
  });

  test("a named member is passed through, so an answer is about a person", async () => {
    asked.length = 0;
    await askPushCredential(placeOfMachine(box()), "https://github.com/a/b.git", "mo");
    expect(asked[0]?.member).toBe("mo");
  });

  test("an unreachable place throws rather than resolving to a guess", async () => {
    // The distinction `capabilities` keeps too: a place that didn't answer has
    // not told us it has no credential. Inventing one here would put a sentence
    // about somebody's identity on screen that nothing checked.
    answer = new Error("ssh: connect to host 10.0.0.1: Operation timed out");
    await expect(
      askPushCredential(placeOfMachine(box()), "https://github.com/a/b.git"),
    ).rejects.toThrow("timed out");
    answer = plan();
  });
});
