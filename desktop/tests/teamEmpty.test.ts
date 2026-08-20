// The team feed's empty state, which is the screen most people meet first.
//
//   bun test
//
// It opened with "You're all set" and said that in three different
// situations, only one of which was true. It said it while the sign-in check
// was still in flight, and if the answer came back "signed out" the truth was
// the opposite of what had been on screen: your activity never leaves this
// computer until you sign in. With no project open the check never ran at all
// — `load()` returns early before the settings probe — so the reassurance was
// not a flash, it was permanent.
//
// The state machine had five cases. The copy named three and let the rest
// fall through to the reassuring default. These tests hold the fold total:
// every state answers for itself, and no two states answer the same way.

import { describe, expect, test } from "bun:test";

import {
  TEAM_SYNC_STATES,
  deriveTeamSyncState,
  teamEmptyCopy,
  type TeamSyncState,
} from "../src/lib/teamFeedState";
import { stripComments as code } from "./support/code";

const D = (over: Partial<Parameters<typeof deriveTeamSyncState>[0]> = {}) =>
  deriveTeamSyncState({
    hasProject: true,
    signedIn: true,
    syncEnabled: true,
    distinctDevelopers: 0,
    ...over,
  });

describe("why the team feed is empty", () => {
  test("no project open is its own answer, not a pending read", () => {
    // The bug's home: with no repoRoot the settings probe never runs, so
    // `signedIn` stays null forever. Reading that as "checking" would spin
    // for good; reading it as "all set" is what shipped.
    expect(D({ hasProject: false, signedIn: null, syncEnabled: null })).toBe(
      "no_project",
    );
    // And it outranks everything — there is nothing to be signed out OF.
    expect(D({ hasProject: false, signedIn: false })).toBe("no_project");
    expect(D({ hasProject: false, distinctDevelopers: 9 })).toBe("no_project");
  });

  test("a read that hasn't landed is checking, on either signal", () => {
    expect(D({ signedIn: null })).toBe("checking");
    expect(D({ syncEnabled: null })).toBe("checking");
    expect(D({ signedIn: null, syncEnabled: null })).toBe("checking");
  });

  test("not-yet-read is never mistaken for signed out", () => {
    expect(D({ signedIn: null })).not.toBe("signed_out");
    expect(D({ signedIn: false })).toBe("signed_out");
  });

  test("the rest of the ladder is unchanged", () => {
    expect(D({ signedIn: false, syncEnabled: false })).toBe("signed_out");
    expect(D({ syncEnabled: false })).toBe("sync_off");
    expect(D({ distinctDevelopers: 0 })).toBe("waiting");
    expect(D({ distinctDevelopers: 1 })).toBe("waiting");
    expect(D({ distinctDevelopers: 2 })).toBe("working");
  });

  test("every state the machine can return is a state it declares", () => {
    const reachable = new Set<TeamSyncState>([
      D({ hasProject: false }),
      D({ signedIn: null }),
      D({ signedIn: false }),
      D({ syncEnabled: false }),
      D({ distinctDevelopers: 1 }),
      D({ distinctDevelopers: 2 }),
    ]);
    expect(reachable.size).toBe(TEAM_SYNC_STATES.length);
    for (const s of reachable) expect(TEAM_SYNC_STATES).toContain(s);
  });
});

describe("what the empty feed is allowed to say", () => {
  test("no state falls through to a reassurance", () => {
    for (const state of TEAM_SYNC_STATES) {
      const c = teamEmptyCopy(state);
      const text = `${c.title} ${c.body}`;
      expect(text).not.toContain("all set");
      expect(text).not.toContain("You're set");
      expect(text).not.toContain("Nothing to do");
    }
  });

  test("every state answers, and none answers the same as another", () => {
    // The defect, stated positively: a fold over N states that names fewer
    // than N is a fold with a silent default. Distinct answers are the only
    // proof that no state is riding on another's copy.
    const bodies = TEAM_SYNC_STATES.map((s) => teamEmptyCopy(s).body);
    expect(new Set(bodies).size).toBe(TEAM_SYNC_STATES.length);
    const titles = TEAM_SYNC_STATES.map((s) => teamEmptyCopy(s).title);
    // Only `checking` has no title — it renders as the block loader.
    expect(titles.filter((t) => t === "").length).toBe(1);
    expect(new Set(titles).size).toBe(TEAM_SYNC_STATES.length);
  });

  test("a pending read renders as waiting, and nothing else does", () => {
    expect(teamEmptyCopy("checking").tone).toBe("waiting");
    for (const s of TEAM_SYNC_STATES) {
      if (s === "checking") continue;
      expect(teamEmptyCopy(s).tone).toBe("known");
    }
    // A loader has no headline to be wrong with, and offers no action.
    expect(teamEmptyCopy("checking").title).toBe("");
    expect(teamEmptyCopy("checking").cta).toBe(null);
  });

  test("each state names its own cause in words a non-engineer reads", () => {
    expect(teamEmptyCopy("no_project").body).toContain("Open a project");
    expect(teamEmptyCopy("signed_out").body).toContain(
      "stays on this computer only",
    );
    expect(teamEmptyCopy("sync_off").body).toContain("live sync");
    expect(teamEmptyCopy("waiting").body).toContain("teammates");
    for (const s of TEAM_SYNC_STATES) {
      const c = teamEmptyCopy(s);
      // No engine words on a screen aimed at people who don't have them.
      for (const jargon of ["AST", "repoRoot", "null", "ledger", "JSON"]) {
        expect(`${c.title} ${c.body}`).not.toContain(jargon);
      }
    }
  });

  test("an action is offered exactly where one would help", () => {
    expect(teamEmptyCopy("signed_out").cta).toBe("signin");
    expect(teamEmptyCopy("sync_off").cta).toBe("sync");
    for (const s of ["no_project", "checking", "waiting", "working"] as const) {
      // Nothing to press when pressing wouldn't change the answer.
      expect(teamEmptyCopy(s).cta).toBe(null);
    }
  });
});

describe("the feed renders the state it derived", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the empty state's words all come from the fold", async () => {
    const src = await read("components/workpanes/TeamActivityFeed.tsx");
    expect(src).toContain("teamEmptyCopy(state)");
    expect(src).toContain("{copy.title}");
    expect(src).toContain("{copy.body}");
    // Not one hand-written headline left to drift.
    expect(src).not.toContain("all set");
    expect(src).not.toContain("let title =");
    expect(src).not.toContain("let body =");
  });

  test("a pending read draws the block loader, not a verdict", async () => {
    const src = await read("components/workpanes/TeamActivityFeed.tsx");
    expect(src).toContain('copy.tone === "waiting"');
    expect(src).toContain("<LoadingState label={copy.body} />");
  });

  test("the derive call is told whether a project is even open", async () => {
    const src = await read("components/workpanes/TeamActivityFeed.tsx");
    // Pin the ARGUMENT. A correct state machine fed `hasProject: true` from a
    // pane with no project is the original bug with extra steps.
    expect(src).toContain("hasProject: !!repoRoot");
    expect(src).toContain("signedIn,");
    expect(src).toContain("syncEnabled,");
    expect(src).toContain("distinctDevelopers,");
  });
});
