// The "update this pull request" action — one job id, one hint, no promise of
// upkeep nobody performs.
//
// Three surfaces offer the action: the review rail's header (ChecksPanel), the
// repo header (CreatePrButton), and an open PR tab (PRDetailPane). Every time
// this has gone wrong it has gone wrong by one of them quietly disagreeing with
// the other two:
//
//   • The job id forked. On a bare `"update-pr"`, updating #400 from a tab made
//     the rail spin "Updating…" over #422 — one id, two pull requests.
//   • The hover forked. Three surfaces, three sentences for one `updatePrPrompt`
//     run, one of which said "reconciles".
//   • The empty state promised something none of them do. "Once a PR is open,
//     Aura keeps its title and description written for you as work lands" — a
//     claim of unattended upkeep over an action with three onClick callers and
//     no scheduler.
//
// Lives in tests/ rather than src/ for the same reason the other two do: the
// repo carries no Bun types, and `bun run typecheck` (which is also
// `bun run build`) only includes src.

import { expect, test, describe } from "bun:test";
import {
  updatePrJobId,
  updatePrPrompt,
  UPDATE_PR_HINT,
} from "../src/lib/worktreeActions";
import { stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;

// Comments first, always. Several files here carry a comment naming the exact
// string they stopped using, and a scan that reads comments finds the epitaph
// and reports the corpse as alive.

async function* sources(): AsyncGenerator<[string, string]> {
  for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
    yield [rel, stripComments(await Bun.file(`${SRC}/${rel}`).text())];
  }
}

describe("the job id is scoped to one pull request", () => {
  test("different PRs never share an id", () => {
    expect(updatePrJobId(400)).not.toBe(updatePrJobId(422));
  });

  test("the same PR always gets the same id", () => {
    expect(updatePrJobId(400)).toBe(updatePrJobId(400));
  });

  test("the id carries the number, so a stuck job is identifiable", () => {
    expect(updatePrJobId(400)).toContain("400");
  });

  // The regression itself: a bare "update-pr" anywhere in src is the shape of
  // the bug. There is no legitimate use — every surface has a PR number in hand
  // by the time it can offer the action, and the one place that didn't
  // (ChecksPanel's `pr ? updatePrJobId(pr.number) : "update-pr"`) was an
  // unreachable fallback sitting in plain sight for the next person to copy.
  test("no file hard-codes an unscoped update-pr id", async () => {
    const offenders: string[] = [];
    for await (const [rel, src] of sources()) {
      for (const m of src.matchAll(/["'`]update-pr["'`]/g)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("one hint for one action", () => {
  test("it says the trigger is a press", () => {
    expect(UPDATE_PR_HINT).toMatch(/until you press it/i);
  });

  test("it says what changes, not what runs", () => {
    expect(UPDATE_PR_HINT).toMatch(/title and description/i);
    // "reconcile" is a word about the machinery. So is "diff", "AST", "job".
    expect(UPDATE_PR_HINT).not.toMatch(/\breconcil|\bdiff\b|\bAST\b|\bjob\b/i);
  });

  // Each surface used to write its own. Any file that renders the action must
  // reach for the shared one — a hand-written hover here is how the three
  // drifted the first time.
  test("no surface hand-writes its own", async () => {
    const offenders: string[] = [];
    for await (const [rel, src] of sources()) {
      if (rel === "lib/worktreeActions.ts") continue;
      if (!src.includes("updatePrPrompt")) continue;
      // The tell: a title/tooltip literal in a file that dispatches the update.
      for (const m of src.matchAll(
        /(?:title=|TooltipContent[^>]*>)\s*\{?\s*["'`]([^"'`]{20,})/g,
      )) {
        if (/rewrit|re-review|reconcil|title \+ description/i.test(m[1]!)) {
          offenders.push(`${rel} · ${m[1]!.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("nothing claims the PR keeps itself written", () => {
  // The prompt is the whole of what the action does, and it is only ever handed
  // to an agent by a click handler. If a scheduler is ever added, this test
  // fails and the copy below has to be revisited — which is the point.
  test("the prompt has no caller outside an event handler", async () => {
    const callers: string[] = [];
    for await (const [rel, src] of sources()) {
      if (rel === "lib/worktreeActions.ts") continue;
      if (!src.includes("updatePrPrompt(")) continue;
      callers.push(rel);
      // A timer or an effect that reaches for it is the automation this copy
      // used to promise. Effects here are for subscriptions, not dispatch.
      expect(src).not.toMatch(
        /setInterval\([\s\S]{0,400}?updatePrPrompt\(|updatePrPrompt\([\s\S]{0,200}?\)[\s\S]{0,200}?setInterval/,
      );
    }
    expect(callers.length).toBeGreaterThan(0);
  });

  test("no copy promises unattended upkeep of a PR", async () => {
    const offenders: string[] = [];
    // "as work lands", "keeps it written", "stays up to date" — said about a
    // pull request, all three are the same false claim.
    const PROMISE =
      /\b(?:keeps?|kept|stays?|maintains?)\b[^.\n]{0,40}\b(?:written|up to date|current|in sync)\b|\bas work lands\b|\bautomatically\b[^.\n]{0,30}\bas you (?:work|commit|push)\b/i;
    for await (const [rel, src] of sources()) {
      if (!/\bPR\b|pull request/i.test(src)) continue;
      for (const line of src.split("\n")) {
        if (PROMISE.test(line) && /\bPR\b|pull request|description/i.test(line)) {
          offenders.push(`${rel} · ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // What the prompt actually instructs has to match what the copy says it does,
  // or the honest sentence is honest about the wrong thing.
  test("the prompt does rewrite the title and description", () => {
    const p = updatePrPrompt("feat/x", 400);
    expect(p).toMatch(/title/i);
    expect(p).toMatch(/description/i);
    expect(p).toContain("400");
    expect(p).toContain("feat/x");
  });
});
