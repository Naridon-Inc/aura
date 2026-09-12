// The plan and the guard are the ones the buttons actually use.
//
//   bun test ./tests/resumeIsWired.test.ts
//
// AURA-1366. Both halves are tested next door on plain data. What that cannot
// catch is the version where a careful library sits beside a button that still
// spawns the agent itself — correct words in a file nobody calls, and the same
// blank-agent resume as before. Every surface that starts an agent from a past
// run has to go through the one guarded launch, and the session detail has to
// take its verb and its warning from the plan rather than composing its own.

import { describe, expect, it } from "bun:test";

import { readSrc, stripComments } from "./support/code";

describe("the session detail asks what would happen before it says it", () => {
  it("takes the destination and the words from the plan", async () => {
    const src = stripComments(await readSrc("components/workpanes/SessionActions.tsx"));

    expect(src).toContain("resumePlan({");
    // The verb changes with the plan: a continuation and a fresh start are
    // different acts and must not share a button label.
    expect(src).toContain("{plan.verb}");
    expect(src).toContain("plan.headline");
    expect(src).toContain("plan.carries");
    expect(src).toContain("plan.warning");
  });

  it("no longer works out the spawn folder itself", async () => {
    const src = stripComments(await readSrc("components/workpanes/SessionActions.tsx"));

    // The two local derivations this replaced. Their bug was not arithmetic:
    // they could not tell a reachable conversation from an unreachable one.
    expect(src).not.toContain("spawnRoot");
    expect(src).not.toContain("divergentRoot");
    expect(src).not.toContain("agentPtyOpen");
  });

  it("is given which agent ran and which folder, so it can name them", async () => {
    const src = await readSrc("components/workpanes/SessionDetailPane.tsx");
    const section = src.slice(src.indexOf("<SessionActions"), src.indexOf("onDismiss={onBack}"));

    expect(section).toContain("agentId={row.agent_id}");
    expect(section).toContain("worktree={row.worktree ?? null}");
  });
});

describe("every surface that resumes goes through the one guard", () => {
  it("holds for the launcher rows as well as the detail button", async () => {
    const launcher = stripComments(await readSrc("components/launcher/earlierSessions.tsx"));
    const detail = stripComments(await readSrc("components/workpanes/SessionActions.tsx"));

    expect(launcher).toContain("startResume({");
    expect(detail).toContain("startResume({");
    // Neither spawns the agent on its own any more — that is what let two
    // surfaces open one conversation twice.
    expect(launcher).not.toContain("api.agentPtyOpen");
    expect(detail).not.toContain("api.agentPtyOpen");
  });

  it("reports a launch that failed instead of leaving the button mid-sentence", async () => {
    const detail = stripComments(await readSrc("components/workpanes/SessionActions.tsx"));
    const launcher = stripComments(await readSrc("components/launcher/earlierSessions.tsx"));

    expect(detail).toContain("if (!started.ok)");
    expect(detail).toContain("setBusy(null)");
    expect(launcher).toContain("if (!started.ok)");
    expect(launcher).toContain("toast.danger");
  });
});
