// The words somebody decides on, and the two ways they could be wrong.
//
// A person deciding whether to lend a machine their key arrives with a wrong
// picture — usually "my key gets copied there" — and the copy has to correct it
// without replacing it with a comfortable one. Both halves are load-bearing:
// drop the withholding and nobody turns it on; drop the granting and somebody
// turns it on for a machine they should not have.
//
// So the assertions here are about MEANING, not about strings. Each one names a
// fact a person needs, and fails if the copy stops carrying it.

import { describe, expect, test } from "bun:test";

import type { Machine } from "../api";
import { agentLending, agentLendingBadge } from "./agentForward";
import { placeHere, placeOfMachine } from "./contract";

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1:/srv/alpha",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "mine",
    repo_path: "/srv/alpha",
    project_root: null,
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

const said = (lines: string[]) => lines.join(" ").toLowerCase();

describe("what a machine is being lent", () => {
  test("a box nobody opted in is off, and says what off means", () => {
    // The default IS the feature. A row from before this existed carries no
    // decision, and no decision must never read as consent.
    const place = placeOfMachine(box());
    expect(place.identity.forward_agent).toBe(false);

    const lending = agentLending(place);
    expect(lending.offered).toBe(true);
    expect(lending.on).toBe(false);
    expect(lending.state).toContain("its own key");
    expect(lending.state.toLowerCase()).toContain("nothing of yours");
  });

  test("the machine can USE the key — the fact people skip", () => {
    const lending = agentLending(placeOfMachine(box()));
    const grants = said(lending.grants);
    // Three facts, and the copy is wrong if it loses any of them: it is bounded
    // by the connection, it is anything running there rather than Aura, and it
    // reaches further than the one server you had in mind.
    expect(grants).toContain("connected");
    expect(grants).toContain("anything running there");
    expect(grants).toContain("any other server");
    // Named, because "the box" is not a thing anybody can point at.
    expect(grants).toContain("aura-runner");
    // And it names the login it would run as, which is the thing a member on a
    // shared box has to think about.
    expect(grants).toContain("as ubuntu");
  });

  test("the machine never HAS the key — the fear people arrive with", () => {
    const withholds = said(agentLending(placeOfMachine(box())).withholds);
    expect(withholds).toContain("never sent");
    expect(withholds).toContain("never written down");
    // It ends, and something ends it without being asked.
    expect(withholds).toContain("connection closes");
    expect(withholds).toContain("last session");
  });

  test("nothing in the copy asks a person to know what an agent is", () => {
    // The audience is people who write software with an agent, not people who
    // administer ssh. "Forward my SSH agent" is the name of the mechanism and
    // has no business on screen.
    const lending = agentLending(placeOfMachine(box()));
    const all = said([
      lending.state,
      lending.action,
      ...lending.grants,
      ...lending.withholds,
    ]);
    for (const jargon of [
      "ssh agent",
      "ssh-agent",
      "forwardagent",
      "forwarding",
      "socket",
      "ssh_auth_sock",
      "-a ",
    ]) {
      expect(all).not.toContain(jargon);
    }
  });

  test("a box that was opted in says so, and offers the way back", () => {
    const lending = agentLending(
      placeOfMachine(box({ forward_agent: true })),
    );
    expect(lending.on).toBe(true);
    expect(lending.state).toContain("can use your key");
    expect(lending.action.toLowerCase()).toContain("stop");
    expect(agentLendingBadge(placeOfMachine(box({ forward_agent: true })))).toBe(
      "Using your key",
    );
  });

  test("a box that is not lending carries no badge at all", () => {
    // The absence is the truthful default. A row saying "not lending your key"
    // on every machine you own is noise, and noise is how the one that IS
    // lending stops standing out.
    expect(agentLendingBadge(placeOfMachine(box()))).toBeNull();
  });
});

describe("both place-modes", () => {
  test("this laptop is not offered a decision it cannot act on", () => {
    const lending = agentLending(placeHere("/Users/mo/aura"));
    expect(lending.offered).toBe(false);
    expect(lending.on).toBe(false);
    // And says why, rather than showing a control that would do nothing.
    expect(lending.state.toLowerCase()).toContain("already runs with your key");
    expect(agentLendingBadge(placeHere("/Users/mo/aura"))).toBeNull();
  });

  test("a box you brought, one you share and one Aura runs are asked the same", () => {
    // The governing rule of this programme, in the surface that renders it: the
    // decision may not exist for one way of getting a machine and not another.
    const kinds = ["mine", "shared", "managed"];
    const answers = kinds.map((box_kind) =>
      agentLending(placeOfMachine(box({ box_kind }))),
    );
    for (const a of answers) {
      expect(a.offered).toBe(true);
      expect(a.grants).toHaveLength(answers[0].grants.length);
      expect(a.withholds).toEqual(answers[0].withholds);
      expect(a.action).toBe(answers[0].action);
    }
  });

  test("a place with no name still reads as a sentence", () => {
    const lending = agentLending(placeOfMachine(box({ name: "   " })));
    expect(lending.state).not.toContain("undefined");
    expect(lending.action).toContain("that computer");
  });

  test("a place with no login named drops the phrase rather than the sentence", () => {
    const grants = said(agentLending(placeOfMachine(box({ user: "" }))).grants);
    expect(grants).not.toContain("as  ");
    expect(grants).toContain("anything running there can ask");
  });
});
