// Two phases, two networks — as the surface that shows them sees it.
//
// The claim under test is not "the types line up". It is that somebody looking
// at this panel can tell the three states apart that actually happen: a run
// held to its list, a run whose project list was thrown away because the seal
// broke, and a machine that cannot hold a wall at all. The middle one is the
// dangerous one — it works, with less than the project asked for — and shown as
// either "fine" or "failed" it is read wrong both ways.
//
// The other half is wording. Every sentence here is also spelled in Rust, in
// `aura-egress`, and the whole point of the feature is that the CLI and the app
// describe one run identically. So the assertions are on the exact strings,
// which is what makes a drift between the two halves fail a test rather than
// produce two reports somebody has to reconcile by eye.

import { describe, expect, test } from "bun:test";

import type { AgentPhase, Allowed, Attempt, EgressReport } from "./egress";
import {
  clean,
  egressHeadline,
  egressTone,
  endpointLabel,
  listed,
  permissions,
  phaseSentence,
  reasonWord,
  refusals,
  reportHeadline,
  tries,
} from "./egress";

function allow(host: string, port: number, reason: Allowed["reason"]): Allowed {
  return { endpoint: { host, port }, reason };
}

/** The floor every `claude` run gets, whatever else it declared. */
const FLOOR: Allowed[] = [
  allow("api.anthropic.com", 443, "model"),
  allow("console.anthropic.com", 443, "model"),
];

function plan(over: Partial<AgentPhase> = {}): AgentPhase {
  const allowed = over.allowed ?? FLOOR;
  return {
    phase: "agent",
    allowed,
    summary: allowed.map((a) => `${a.endpoint.host}:${a.endpoint.port}`).join(", "),
    declared_honoured: true,
    holdable: true,
    wall: "seatbelt",
    note: "The agent phase can reach two machines.",
    ...over,
  };
}

function attempt(host: string, tries: number, port = 443): Attempt {
  return { host, port, tries, first: 100, last: 100 + tries };
}

function report(over: Partial<EgressReport> = {}): EgressReport {
  return { run: "aura-agent-p-k3f9", allowed: FLOOR, refused: [], ...over };
}

describe("what the agent phase may reach", () => {
  test("a held run says how much it can reach and nothing alarming", () => {
    const p = plan();
    expect(egressTone(p)).toBe("held");
    expect(egressHeadline(p)).toBe("The agent phase can reach 2 machines.");
    // One is one, not "1 machines". This line is read by people deciding
    // whether to trust the thing, and a report that reads like a machine wrote
    // it is a report that gets skimmed.
    expect(egressHeadline(plan({ allowed: [FLOOR[0]] }))).toBe(
      "The agent phase can reach 1 machine.",
    );
  });

  test("a broken seal is its own state, not a failure and not fine", () => {
    // The spec was edited after it was signed, so the project's own
    // `[env.network]` entries are dropped and only the floor is honoured. The
    // run WORKS — with less than the project asked for. That is exactly the
    // case that gets misread if there are only two tones.
    const p = plan({ declared_honoured: false });
    expect(egressTone(p)).toBe("unsealed");
    expect(egressHeadline(p)).toContain("this project's own list is being ignored");
    // And it is still confined, which the headline must not obscure.
    expect(egressHeadline(p)).toContain("The agent phase can reach 2 machines");
  });

  test("a machine that cannot hold a wall says so instead of implying one", () => {
    // The failure that matters most. A place with no sandbox-exec and no nft
    // runs the agent with the whole network, and a panel that showed the
    // allowlist anyway would be describing a wall that is not there.
    const p = plan({ holdable: false, wall: "" });
    expect(egressTone(p)).toBe("open");
    expect(egressHeadline(p)).toBe("This machine can't hold an agent to an allowlist.");
    expect(egressHeadline(p)).not.toContain("can reach");
  });

  test("what somebody chose is read before what they could not have refused", () => {
    // The model API being on the list is not news. The host this project asked
    // for is the row worth auditing, so it goes first — and the order is total,
    // so two runs of the same project produce the same list and a diff between
    // them is a real change rather than hash order.
    const p = plan({
      allowed: [
        ...FLOOR,
        allow("github.com", 443, "remote"),
        allow("registry.npmjs.org", 443, "declared"),
        allow("crates.io", 443, "declared"),
      ],
    });
    expect(listed(p).map((a) => a.endpoint.host)).toEqual([
      "crates.io",
      "registry.npmjs.org",
      "github.com",
      "api.anthropic.com",
      "console.anthropic.com",
    ]);
    // Sorting must not lose or invent rows.
    expect(listed(p)).toHaveLength(p.allowed.length);
  });

  test("a port is never hidden, because it is half of the permission", () => {
    // The same host on 22 and on 443 are two different permissions. A surface
    // that elides the common one is showing a list somebody can sign off on
    // without having read it.
    expect(endpointLabel({ host: "github.com", port: 443 })).toBe("github.com:443");
    expect(endpointLabel({ host: "github.com", port: 22 })).toBe("github.com:22");
  });

  test("why a row is on the list is said in words, not a category", () => {
    // "you asked for this" and "the agent cannot start without this" are
    // different decisions, and only one of them is the project's.
    expect(reasonWord("declared")).toBe("this project asked for it");
    expect(reasonWord("model")).toBe(
      "the agent cannot answer without its own model",
    );
    expect(reasonWord("remote")).toBe("this is where the code came from");
  });

  test("the two phases are described as the two different things they are", () => {
    expect(phaseSentence("setup")).toContain("has the network");
    expect(phaseSentence("agent")).toContain("only what this project declared");
    expect(phaseSentence("setup")).not.toEqual(phaseSentence("agent"));
  });
});

describe("what a finished run wanted", () => {
  test("a run that stayed inside its list says so and stops", () => {
    const r = report();
    expect(clean(r)).toBe(true);
    expect(tries(r)).toBe(0);
    expect(reportHeadline(r)).toBe(
      "The agent phase stayed inside its allowlist (2 machines).",
    );
    expect(refusals(r)).toEqual([]);
  });

  test("one refusal names the machine rather than counting it", () => {
    // "1 refusal" is a number. `webhook.site` is a decision somebody has to
    // make, and it is the whole reason this is reported at all.
    const r = report({ refused: [attempt("webhook.site", 4)] });
    expect(clean(r)).toBe(false);
    expect(tries(r)).toBe(4);
    expect(reportHeadline(r)).toBe(
      "The allowlist stopped this run reaching webhook.site.",
    );
    expect(refusals(r)).toEqual(["wanted webhook.site:443 4 times"]);
  });

  test("once is 'once', because a report that reads like a log gets skimmed", () => {
    expect(refusals(report({ refused: [attempt("evil.example.com", 1)] }))).toEqual([
      "wanted evil.example.com:443 once",
    ]);
  });

  test("several machines are counted rather than listed in the headline", () => {
    const r = report({
      refused: [attempt("a.example.com", 9), attempt("b.example.com", 2)],
    });
    expect(reportHeadline(r)).toBe(
      "The allowlist stopped this run reaching 2 machines.",
    );
    // The rows themselves are still there, most-wanted first as the backend
    // ordered them — the headline is a summary, not a substitute.
    expect(refusals(r)).toEqual([
      "wanted a.example.com:443 9 times",
      "wanted b.example.com:443 2 times",
    ]);
    expect(tries(r)).toBe(11);
  });

  test("what was allowed is shown next to what was not", () => {
    // The useful question in front of a blocked host is "compared to what": a
    // run that had its model and its remote and wanted a third thing anyway is
    // a different story from one that was allowed nothing.
    const r = report({
      allowed: [allow("api.anthropic.com", 443, "model")],
      refused: [attempt("169.254.169.254", 3)],
    });
    expect(permissions(r)).toEqual([
      "api.anthropic.com:443 — the agent cannot answer without its own model",
    ]);
  });

  test("a run allowed nothing and refused nothing says the true thing", () => {
    // An agent nobody has a floor row for gets an empty list rather than an
    // open one — refused-and-written-down beats a guessed hostname. The report
    // must not congratulate that run for staying inside a list it never had.
    const r = report({ allowed: [], refused: [] });
    expect(reportHeadline(r)).toBe(
      "The agent phase reached nothing, and was allowed nothing.",
    );
  });
});
