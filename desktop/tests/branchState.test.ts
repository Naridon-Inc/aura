// The review rail's branch-state vocabulary, held to the claim it makes.
//
//   bun test
//
// `ReviewState.label` is documented as "plain-language label for the bar
// (non-engineer audience)", and the bar rendering it is commented "state dot +
// plain-language label". Six of the eight labels were git: "Merge conflicts",
// "Merged", "Ready to merge", "Behind by 586 commits", "12 commits ahead",
// "Unpublished branch". A doc comment can't notice that. This can.
//
// The rule this enforces is the house one: the ADE audience does not write
// code, so git vocabulary on a surface aimed at them is a defect. The exact
// git fact isn't lost — `branchStateDetail` carries it to the hover, and these
// tests require it to be there.

import { describe, expect, test } from "bun:test";

import {
  branchStateDetail,
  branchStateLabel,
  branchSyncDetail,
  deriveReviewState,
  syncAction,
  type BranchRead,
  type ReviewStateId,
  type ReviewStateInput,
} from "../src/components/rightrail/reviewState";
import { getPrimaryAction } from "../src/components/rightrail/getPrimaryAction";
import { readSrc, stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;

// Comments have to go before any source scan. Several of these files now carry
// a comment naming the exact string they stopped writing — a scan that doesn't
// strip them finds the ghost and reports it as the thing.

const IDS: ReviewStateId[] = [
  "unknown",
  "conflicts",
  "merged",
  "ready",
  "behind",
  "ahead",
  "unpublished",
  "uncommitted",
  "clean",
];

// Words that name a git mechanism rather than a thing that happened to your
// work. `\b` on both ends so "commit" doesn't fire on "committed to" in prose
// and "in" doesn't fire inside "missing".
const JARGON =
  /\b(commit|commits|committed|uncommitted|branch|branches|merge|merged|merging|remote|upstream|push|pushed|pull|pulled|rebase|stash|origin|HEAD|repo|repository|checkout|staged|unstaged|working tree|diff|SHA|ref)\b/i;

function base(over: Partial<ReviewStateInput> = {}): ReviewStateInput {
  return {
    known: true,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    changedCount: 0,
    conflictsCount: 0,
    pr: null,
    canMerge: true,
    ...over,
  };
}

describe("what the rail says", () => {
  test("no state label uses a git word", () => {
    const offenders: string[] = [];
    for (const id of IDS) {
      for (const n of [0, 1, 2, 586]) {
        const label = branchStateLabel(id, n);
        const hit = label.match(JARGON);
        if (hit) offenders.push(`${id}(${n}) → "${label}". "${hit[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every state actually says something", () => {
    for (const id of IDS) {
      const label = branchStateLabel(id, 3);
      expect(label.length).toBeGreaterThan(2);
      expect(label.trim()).toBe(label);
    }
  });

  test("the two counts don't share a noun", () => {
    // `behind` and `ahead` count commits; `uncommitted` counts working-tree
    // files. Calling both "changes" — which is what the rail used to do — put
    // "586 changes" and "15 changes" on one screen meaning different things by
    // a factor of nothing in particular.
    expect(branchStateLabel("behind", 586)).toContain("update");
    expect(branchStateLabel("ahead", 12)).toContain("update");
    expect(branchStateLabel("uncommitted", 15)).toContain("file");
    expect(branchStateLabel("uncommitted", 15)).not.toContain("update");
    expect(branchStateLabel("behind", 586)).not.toContain("file");
  });

  test("counts are pluralised", () => {
    expect(branchStateLabel("behind", 1)).toBe("Missing 1 update from the team");
    expect(branchStateLabel("behind", 2)).toBe("Missing 2 updates from the team");
    expect(branchStateLabel("uncommitted", 1)).toBe("1 changed file");
    expect(branchStateLabel("uncommitted", 9)).toBe("9 changed files");
  });

  test("the uncommitted label never claims the work isn't saved", () => {
    // The files ARE on disk. Telling someone their work isn't saved when it is
    // manufactures the exact panic plain wording exists to prevent.
    for (const n of [0, 1, 40]) {
      expect(branchStateLabel("uncommitted", n).toLowerCase()).not.toContain(
        "not saved",
      );
      expect(branchStateLabel("uncommitted", n).toLowerCase()).not.toContain(
        "unsaved",
      );
    }
  });
});

describe("what the hover says", () => {
  test("every state carries a precise detail", () => {
    for (const id of IDS) {
      const detail = branchStateDetail(id, 7);
      expect(detail.length).toBeGreaterThan(10);
      // Not a copy of the label — if it said the same thing there'd be no
      // reason for the hover to exist.
      expect(detail).not.toBe(branchStateLabel(id, 7));
    }
  });

  test("the detail is where the git fact went", () => {
    // The inverse of the label rule: these are FOR the reader who wants the
    // mechanism, so every one of them names it.
    for (const id of IDS) {
      expect(branchStateDetail(id, 7)).toMatch(JARGON);
    }
  });

  test("the counted states quote the real unit", () => {
    expect(branchStateDetail("behind", 586)).toContain("586 commits");
    expect(branchStateDetail("ahead", 1)).toContain("1 commit");
    expect(branchStateDetail("uncommitted", 15)).toContain("15 files");
  });
});

describe("the ↑n ↓n chip", () => {
  // Two chips draw those arrows — the branch switcher's row and the Git
  // header's sync cluster — and each used to write its own hover for them.
  // A chip whose visible form is an arrow and a number explains itself to
  // nobody, so this hover leads with the meaning and keeps the git fact under
  // it, split by a newline.
  test("meaning first, mechanism second", () => {
    for (const [a, b, up] of [
      [3, 0, true],
      [0, 5, true],
      [3, 5, true],
      [0, 0, true],
      [2, 0, false],
    ] as const) {
      const [first, ...rest] = branchSyncDetail(a, b, up).split("\n");
      expect(first).not.toMatch(JARGON);
      expect(rest.join(" ")).toMatch(JARGON);
    }
  });

  test("no upstream beats the counts", () => {
    // A branch that was never pushed is "ahead" by every commit on it, which
    // is true and useless. What you need told is that nobody else can see it.
    expect(branchSyncDetail(12, 0, false)).toBe(
      `${branchStateLabel("unpublished")}\n${branchStateDetail("unpublished")}`,
    );
  });

  test("both directions are both said", () => {
    const both = branchSyncDetail(3, 5, true);
    expect(both).toContain("3 updates");
    expect(both).toContain("5 updates");
    expect(both).toContain("3 commits");
    expect(both).toContain("5 commits");
  });

  test("in step says so", () => {
    expect(branchSyncDetail(0, 0, true)).toContain(branchStateLabel("clean"));
  });
});

describe("nobody writes their own", () => {
  // `branchStateLabel`'s doc has claimed since it was written that "there is
  // one of each and a third surface can't fork them again". It was false at
  // the time: BranchSwitcherModal and RepoHeaderControls each hand-wrote
  // "${ahead} ahead · ${behind} behind upstream", and the switcher wrote two
  // more besides. A comment can't hold a claim like that. This can.
  //
  // The scan is deliberately narrow, in BOTH directions.
  //
  //  • It looks only at what a person reads: the text of `title`, `hint`,
  //    `label`, `placeholder` and `aria-label`. Git vocabulary is CORRECT in
  //    an agent prompt — `askAura("publish", …, "Publish this branch to the
  //    remote (set its upstream)…")` is addressed to Claude, which knows what
  //    an upstream is. A scan over every string literal flags those, and a
  //    scan that then widens its exception list to shut them up is how a rule
  //    stops meaning anything.
  //  • It does NOT cover JSX text children — "Waiting for upstream task to
  //    complete." sat in one and had to be found by hand. Attributes are what
  //    it holds; it doesn't claim the rest.
  const ATTR = /\b(?:title|hint|label|placeholder|aria-label)\s*=\s*(\{?)/g;
  // A fresh regex per use. A shared global one carries `lastIndex` between an
  // `exec` and the next `matchAll`, so the second scan starts partway through
  // the string and quietly misses the front of it — which is exactly how this
  // test passed against a deliberately reintroduced
  // "${ahead} ahead · ${behind} behind upstream" the first time it was run.
  const literals = (s: string) =>
    s.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g);

  // Just this attribute's own value. A fixed window instead swallows whatever
  // follows — which here meant reading `askAura(…, "Publish this branch to
  // the remote (set its upstream)…")` two lines down and calling it the
  // label's text. Braces balanced for `{…}`, otherwise the single literal.
  function attrValue(src: string, at: RegExpExecArray | RegExpMatchArray): string {
    const start = at.index! + at[0].length;
    if (!at[1]) {
      const m = literals(src.slice(start, start + 400)).next().value;
      return m && m.index! < 2 ? m[0] : "";
    }
    let depth = 1;
    for (let i = start; i < src.length && i < start + 2000; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i);
    }
    return src.slice(start, start + 400);
  }

  test("no attribute hand-writes an ahead/behind string", async () => {
    const offenders: string[] = [];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    for await (const rel of glob.scan({ cwd: SRC })) {
      if (rel.endsWith("rightrail/reviewState.ts")) continue;
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      for (const at of src.matchAll(ATTR)) {
        for (const lit of literals(attrValue(src, at))) {
          // Test the PROSE, not the code: `Shared copy: ${b.upstream}` prints
          // a branch name, it doesn't say the word "upstream" to anybody.
          const text = lit[0].replace(/\$\{[^}]*\}/g, "…");
          if (
            /\bupstream\b/i.test(text) ||
            /ahead[^"'`\n]{0,12}behind/i.test(text) ||
            /behind[^"'`\n]{0,12}ahead/i.test(text)
          ) {
            offenders.push(`${rel} · ${lit[0].slice(0, 70)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("deriveReviewState", () => {
  test("every reachable state carries both a label and a detail", () => {
    const cases: ReviewStateInput[] = [
      base({ conflictsCount: 2 }),
      base({ pr: { number: 1, state: "merged", reviewDecision: null } }),
      base({ pr: { number: 2, state: "open", reviewDecision: null } }),
      // The no-merge-capability fallback writes its own label ("Open · #3") and
      // still has to hand the hover something.
      base({
        pr: { number: 3, state: "open", reviewDecision: null },
        canMerge: false,
      }),
      base({ behind: 4 }),
      base({ ahead: 5 }),
      base({ hasUpstream: false }),
      base({ changedCount: 6 }),
      base(),
    ];
    for (const input of cases) {
      const s = deriveReviewState(input);
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.detail.length).toBeGreaterThan(10);
    }
  });

  test("the labels it hands the bar are the plain ones", () => {
    // The bar renders `state.label` directly, so the rule has to hold through
    // the deriver and not just on the label function.
    for (const input of [
      base({ conflictsCount: 2 }),
      base({ behind: 586 }),
      base({ ahead: 12 }),
      base({ hasUpstream: false }),
      base({ changedCount: 15 }),
      base(),
      base({ pr: { number: 1, state: "merged", reviewDecision: null } }),
      base({ pr: { number: 2, state: "open", reviewDecision: null } }),
    ]) {
      expect(deriveReviewState(input).label).not.toMatch(JARGON);
    }
  });

  test("precedence is unchanged", () => {
    // The words moved; the lifecycle did not.
    expect(deriveReviewState(base({ conflictsCount: 1, behind: 9 })).id).toBe(
      "conflicts",
    );
    expect(
      deriveReviewState(
        base({
          behind: 9,
          pr: { number: 1, state: "merged", reviewDecision: null },
        }),
      ).id,
    ).toBe("merged");
    expect(deriveReviewState(base({ behind: 3, ahead: 3 })).id).toBe("behind");
    expect(deriveReviewState(base({ ahead: 3, changedCount: 4 })).id).toBe(
      "ahead",
    );
    expect(deriveReviewState(base({ hasUpstream: false, ahead: 3 })).id).toBe(
      "unpublished",
    );
    expect(deriveReviewState(base({ changedCount: 4 })).id).toBe("uncommitted");
    expect(deriveReviewState(base()).id).toBe("clean");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Before it looked.
//
// Every surface that draws these states seeded itself with `{ahead: 0,
// behind: 0, has_upstream: false}` and then read it. That is not a neutral
// placeholder — it is a valid, specific answer meaning "this branch exists
// only on your machine". So the review rail's first frame said "Nobody else
// can see this yet" and offered Publish, the Checks rail drew the same row
// with the same button, the commit surface printed an amber "unpublished"
// chip, and the repo header's primary git button read **Publish** — all of it
// about a branch nothing had looked at yet.
//
// It didn't clear when the read failed, either: every one of those `catch`
// blocks kept the seed as "the last-known state", and the producer had no
// error channel to fail through in the first place. `git_ahead_behind`
// returned the struct directly and answered a git that wouldn't run with
// `has_upstream: false`, and a `rev-list` that failed with `(0, 0)` —
// byte-for-byte the "in sync with the upstream" state.

describe("nothing read is not a state of the branch", () => {
  test("an unread rail says so, and offers nothing", () => {
    const s = deriveReviewState(base({ known: false }));
    expect(s.id).toBe("unknown");
    expect(s.primary).toBeNull();
    expect(s.secondary).toBeNull();
  });

  test("the zeroed seed no longer reads as unpublished", () => {
    // The exact shape every surface used to start life with.
    const seed = base({ known: false, ahead: 0, behind: 0, hasUpstream: false });
    expect(deriveReviewState(seed).id).not.toBe("unpublished");
    // …and the arm still fires when we HAVE looked, so what changed is the
    // guard, not the lifecycle.
    expect(deriveReviewState({ ...seed, known: true }).id).toBe("unpublished");
  });

  test("not knowing outranks every state that needs the read", () => {
    for (const over of [
      { conflictsCount: 3 },
      { behind: 9 },
      { ahead: 4 },
      { changedCount: 15 },
      { hasUpstream: false },
      { pr: { number: 1, state: "merged", reviewDecision: null } },
      { pr: { number: 2, state: "open", reviewDecision: null } },
    ] as Partial<ReviewStateInput>[]) {
      expect(deriveReviewState(base({ ...over, known: false })).id).toBe(
        "unknown",
      );
    }
  });

  test("the unknown state never claims anything about the work", () => {
    const s = deriveReviewState(base({ known: false }));
    for (const text of [s.label, s.detail]) {
      const t = text.toLowerCase();
      // The four sentences it must not be mistaken for.
      expect(t).not.toContain("nobody else can see");
      expect(t).not.toContain("up to date");
      expect(t).not.toContain("ready to go");
      expect(t).not.toContain("this work is in");
    }
    // It says who couldn't do what, rather than going quiet.
    expect(s.detail.toLowerCase()).toContain("couldn");
  });

  test("no surface seeds a branch read with a fabricated struct", async () => {
    // The literal that started all of this. A component may hold
    // `AheadBehind | null` and start at null; it may not start at an object.
    const files = [
      "components/rightrail/ReviewStateHeader.tsx",
      "components/rightrail/ChecksPanel.tsx",
    ];
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(await readSrc(rel));
      if (/useState<AheadBehind>\s*\(\s*\{/.test(src)) offenders.push(rel);
      if (!/useState<AheadBehind \| null>\s*\(\s*null\s*\)/.test(src))
        offenders.push(`${rel} (no null-seeded read)`);
    }
    expect(offenders).toEqual([]);
  });

  test("the surfaces pass what they read, not a literal", async () => {
    // `known` is only worth having if the call site computes it. A hard-coded
    // `known: true` restores the whole defect while every unit test above
    // still passes, so pin the argument at each call site.
    for (const [rel, arg] of [
      ["components/rightrail/ReviewStateHeader.tsx", "known: ab !== null,"],
      ["components/rightrail/CommitInput.tsx", "known: aheadRead,"],
    ] as const) {
      const src = stripComments(await readSrc(rel));
      expect(src).toContain(arg);
      expect(src).not.toMatch(/known:\s*(true|false)\b/);
    }
  });
});

describe("the repo header's one git button", () => {
  const LOADING: BranchRead = { status: "loading" };
  const FAILED: BranchRead = { status: "error", message: "not a git repository" };
  const ready = (over: Partial<Extract<BranchRead, { status: "ready" }>> = {}) =>
    ({
      status: "ready",
      ahead: 0,
      behind: 0,
      hasUpstream: true,
      ...over,
    }) as BranchRead;

  test("a read that hasn't happened offers no git command", () => {
    // This is the one that mattered: `pickSyncAction` opened with
    // `if (!ab || !ab.has_upstream) return publish`, and pressing that button
    // ran `git push --set-upstream` on a branch that probably had one.
    const WRITES = ["publish", "push", "pull", "sync"];
    for (const read of [LOADING, FAILED]) {
      const a = syncAction(read);
      expect(WRITES).not.toContain(a.kind);
      expect(a.label).not.toBe("Publish");
    }
  });

  test("waiting is inert; a failure is retryable", () => {
    expect(syncAction(LOADING).idle).toBe(true);
    const failed = syncAction(FAILED);
    expect(failed.idle).toBe(false);
    expect(failed.kind).toBe("retry");
    // The reason git gave, not a shrug.
    expect(failed.hint).toContain("not a git repository");
  });

  test("a real read still picks the real action", () => {
    expect(syncAction(ready({ hasUpstream: false })).kind).toBe("publish");
    expect(syncAction(ready({ ahead: 2, behind: 3 })).kind).toBe("sync");
    expect(syncAction(ready({ ahead: 2 })).kind).toBe("push");
    expect(syncAction(ready({ behind: 3 })).kind).toBe("pull");
    expect(syncAction(ready()).kind).toBe("fetch");
  });

  test("the two unread labels aren't verbs at all", () => {
    // Push / Pull / Sync are the established labels for the action you are
    // choosing, and they stay. What must never happen is a state we haven't
    // read wearing one of them — a button that names a git command is a
    // promise that pressing it is the right thing to do.
    for (const read of [LOADING, FAILED]) {
      expect(syncAction(read).label).not.toMatch(JARGON);
    }
  });

  test("the header holds no second copy of this fold", async () => {
    const src = stripComments(await readSrc("components/git/RepoHeaderControls.tsx"));
    expect(src).not.toContain("function pickSyncAction");
    // It also hard-coded the third argument: a branch with no upstream still
    // reports commits, and the hover explained those arrows by talking about
    // an upstream they were never counted against.
    expect(src).not.toMatch(/branchSyncDetail\([^)]*,\s*true\s*\)/);
  });
});

describe("the commit surface's primary button", () => {
  const input = {
    canCommit: false,
    hasStagedChanges: false,
    isPending: false,
    pushCount: 0,
    pullCount: 0,
    hasUpstream: false,
  };

  test("an unread branch is never 'Publish branch'", () => {
    const a = getPrimaryAction({ ...input, known: false });
    expect(a.action).not.toBe("publish");
    expect(a.disabled).toBe(true);
  });

  test("committing doesn't wait on the read", () => {
    // Staging and a message are local facts; the git read has no bearing on
    // whether you may commit.
    const a = getPrimaryAction({
      ...input,
      canCommit: true,
      hasStagedChanges: true,
      known: false,
    });
    expect(a.action).toBe("commit");
    expect(a.disabled).toBe(false);
  });

  test("a read branch behaves exactly as before", () => {
    expect(getPrimaryAction({ ...input, known: true }).action).toBe("publish");
    expect(
      getPrimaryAction({ ...input, known: true, hasUpstream: true, pushCount: 2 })
        .action,
    ).toBe("push");
  });
});

describe("'up to date' means both halves of what it says", () => {
  test("the hover promises nothing uncommitted", () => {
    expect(branchStateDetail("clean").toLowerCase()).toContain("uncommitted");
  });

  test("the Checks row that draws it actually checks that", async () => {
    // `inSync` was `has_upstream && ahead === 0 && behind === 0` — the working
    // tree wasn't in it. So a branch level with the remote drew a green
    // "Up to date" tick, whose hover said nothing was uncommitted, directly
    // under a row counting fifteen changed files.
    const src = stripComments(await readSrc("components/rightrail/ChecksPanel.tsx"));
    const i = src.indexOf("const inSync");
    expect(i).toBeGreaterThan(-1);
    const expr = src.slice(i, src.indexOf(";", i)).replace(/\s+/g, "");
    expect(expr).toContain("changedCount===0");
    expect(expr).toContain("ab.ahead===0");
    expect(expr).toContain("ab.behind===0");
  });
});

describe("the producer has somewhere to fail", () => {
  // A parser is a claim about what the producer prints; a UI state is a claim
  // about what the producer can return. `git_ahead_behind` returned
  // `AheadBehind` — not `Result` — so three different failures all arrived as
  // confident answers, and no `catch` on this side could have told them apart
  // because there was nothing to catch.
  const rust = async () =>
    stripComments(
      await Bun.file(`${SRC}/../src-tauri/src/cmd_files.rs`).text(),
    );

  const body = async () => {
    const src = await rust();
    const i = src.indexOf("pub async fn git_ahead_behind");
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf("\nfn current_branch", i);
    return src.slice(i, j === -1 ? undefined : j);
  };

  test("it can say it couldn't tell", async () => {
    expect(await body()).toContain("Result<AheadBehind, String>");
  });

  test("a git that won't run is not 'no upstream'", async () => {
    const b = await body();
    // The old line was `.map(|o| o.status.success()).unwrap_or(false)`, which
    // spent a spawn failure as the answer "no upstream".
    expect(b).not.toContain("unwrap_or(false)");
    expect(b).toContain("map_err");
  });

  test("a count it couldn't read is not zero", async () => {
    const b = await body();
    // `.parse().ok().unwrap_or(0)` made an unreadable count into the number
    // that means "in step with the remote".
    expect(b).not.toContain("unwrap_or(0)");
    expect(b).toContain("ok_or_else");
  });

  test("a failed rev-list doesn't resolve to in-sync", async () => {
    const b = await body();
    // The old fallthrough was `_ => (0, 0)` with `has_upstream: true`.
    expect(b.replace(/\s+/g, "")).not.toContain("_=>(0,0)");
    expect(b).toContain("if !counts.status.success()");
  });

  test("a genuine missing upstream is still an answer, not an error", async () => {
    const b = await body();
    const at = b.indexOf("if !probe.status.success()");
    expect(at).toBeGreaterThan(-1);
    const arm = b.slice(at, at + 240).replace(/\s+/g, "");
    expect(arm).toContain("Ok(AheadBehind{");
    expect(arm).toContain("has_upstream:false");
  });
});
