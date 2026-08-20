// Two definite claims picked by a ternary on a value that is null for more
// reasons than the ternary knows about.
//
//   bun test
//
// OpLogDialog is the "what Aura did" list — the window you open when an agent
// has just done something and you want it taken back. The list has a proper
// loading state and a proper empty state. The footer under it, and the button
// beside it, had neither: `target` is null while the read is in flight, null
// again if it throws, and null when the list was genuinely read and holds
// nothing reversible. One ternary, three meanings, and the sentence it printed
// for all of them was:
//
//     Nothing in this list can be reversed.
//
// CostUsagePane's empty state decides whether to tell you to sign in. It asked
// the billing payload — and `catch { setBilling(null) }` covers every failure
// there is, so a signed-in reader whose spend call timed out was told to sign
// in. The comment directly above it says that doing exactly that makes a reader
// "reasonably conclude the page is broken".
//
// Both now ask the question they are actually answering, and both have a third
// arm for "we couldn't find out".

import { describe, expect, test } from "bun:test";

import { undoCopy } from "../src/components/dialogs/OpLogDialog";
import { spendFootnote } from "../src/components/workpanes/CostUsagePane";
import { pagesRailState, type PagesRead } from "../src/components/pages/PagesSidebar";
import { changesReadout } from "../src/components/rightrail/ChangesPanel";
import { stripComments as code } from "./support/code";

type UndoState = Parameters<typeof undoCopy>[0];

const S = (over: Partial<UndoState> = {}): UndoState => ({
  loading: false,
  failed: false,
  hasTarget: true,
  selected: false,
  busy: false,
  ...over,
});

describe("the undo footer doesn't rule out undo before it has read the list", () => {
  test("while the list is loading it says it is loading", () => {
    const c = undoCopy(S({ loading: true, hasTarget: false }));
    // Name this state's own copy. Asserting only what it must avoid passes just
    // as happily when it falls through to the failed-read arm — which would be
    // telling the user a read failed that is still running.
    expect(c.footnote).toBe("Reading what Aura has done…");
    expect(c.title).toContain("Still reading");
    expect(c.footnote).not.toContain("Nothing in this list can be reversed");
  });

  test("a read that threw says so, rather than reporting nothing to undo", () => {
    const c = undoCopy(S({ failed: true, hasTarget: false }));
    expect(c.footnote).toContain("read this list just now");
    expect(c.footnote).toContain("Reopen this window");
    expect(c.footnote).not.toContain("Nothing in this list can be reversed");
    expect(c.title).toContain("read this list just now");
  });

  test("the three empty-handed states are three different states", () => {
    const loading = undoCopy(S({ loading: true, hasTarget: false }));
    const failed = undoCopy(S({ failed: true, hasTarget: false }));
    const empty = undoCopy(S({ hasTarget: false }));
    const notes = [loading.footnote, failed.footnote, empty.footnote];
    expect(new Set(notes).size).toBe(3);
    expect(new Set([loading.title, failed.title, empty.title]).size).toBe(3);
  });

  test("a list that was read and holds nothing reversible still says so", () => {
    const c = undoCopy(S({ hasTarget: false }));
    expect(c.footnote).toBe("Nothing in this list can be reversed.");
    expect(c.label).toBe("Nothing to undo");
    expect(c.title).toBe("Nothing here can be undone");
  });

  test("with a target, picking a row changes what the button promises", () => {
    const auto = undoCopy(S());
    const picked = undoCopy(S({ selected: true }));
    expect(auto.footnote).toBe("Undoes the most recent step that can be reversed.");
    expect(auto.label).toBe("Undo the last step");
    expect(picked.footnote).toBe("The step you picked will be undone.");
    expect(picked.label).toBe("Undo this step");
    // The row's own name beats a generic hover, so this arm hands the title back
    // to the caller rather than inventing one.
    expect(auto.title).toBe("");
  });

  test("only a list that was read and came back empty may rule undo out", () => {
    // 32 combinations. The claim is allowed in exactly one region of them.
    for (const loading of [false, true])
      for (const failed of [false, true])
        for (const hasTarget of [false, true])
          for (const selected of [false, true])
            for (const busy of [false, true]) {
              const c = undoCopy({ loading, failed, hasTarget, selected, busy });
              const read = !loading && !failed;
              expect(c.footnote.includes("Nothing in this list can be reversed")).toBe(
                read && !hasTarget,
              );
              expect(c.label === "Nothing to undo").toBe(read && !hasTarget && !busy);
              // Whatever else it says, a press in flight is always visible.
              if (busy) expect(c.label).toBe("undoing…");
            }
  });
});

describe("the spend page asks whether you're signed in, not whether spend arrived", () => {
  test("signed in and nothing spent says exactly that", () => {
    const t = spendFootnote(true);
    expect(t).toContain("connected to Aura Cloud");
    expect(t).not.toContain("Sign in");
  });

  test("signed out is the only state that asks you to sign in", () => {
    expect(spendFootnote(false)).toContain("Sign in to Aura Cloud");
  });

  test("a failed check admits it rather than guessing", () => {
    const t = spendFootnote(null);
    // Positively: this state has its own sentence.
    expect(t).toContain("check your Aura Cloud connection");
    expect(t).toContain("Reopen this tab");
    // And it is neither of the two confident answers.
    expect(t).not.toContain("Sign in to Aura Cloud");
    expect(t).not.toContain("connected to Aura Cloud —");
  });

  test("all three answers are different sentences", () => {
    const all = [spendFootnote(true), spendFootnote(false), spendFootnote(null)];
    expect(new Set(all).size).toBe(3);
    expect(all.every((s) => s.trim().length > 0)).toBe(true);
  });
});

describe("the Pages rail knows the difference between none and not-yet", () => {
  const R = (over: Partial<Parameters<typeof pagesRailState>[0]> = {}) =>
    pagesRailState({
      hasProject: true,
      read: "done",
      hasRows: false,
      filtering: false,
      ...over,
    });

  test("the first frame of a visit is not a verdict", () => {
    expect(R({ read: "pending" })).toBe("loading");
  });

  test("a read that threw is its own state", () => {
    // The catch here was a comment whose excuse — "NotesWorkpane will mirror
    // once it mounts" — names the exact case this read exists to cover when it
    // hasn't. So nothing was coming to correct the wrong answer.
    expect(R({ read: "failed" })).toBe("failed");
  });

  test("rows beat the read state, because the mirror can arrive first", () => {
    expect(R({ read: "pending", hasRows: true })).toBe("list");
    expect(R({ read: "failed", hasRows: true })).toBe("list");
  });

  test("no project is not an empty project", () => {
    expect(R({ hasProject: false })).toBe("no-project");
    expect(R({ hasProject: false, read: "pending" })).toBe("no-project");
  });

  test("a filter that matches nothing is not a project with nothing", () => {
    expect(R({ filtering: true })).toBe("no-match");
    expect(R({})).toBe("empty");
  });

  test("only a finished read of a real project with nothing in it says so", () => {
    const READS: PagesRead[] = ["pending", "failed", "done"];
    for (const hasProject of [false, true])
      for (const read of READS)
        for (const hasRows of [false, true])
          for (const filtering of [false, true]) {
            const got = pagesRailState({ hasProject, read, hasRows, filtering });
            expect(got === "empty").toBe(
              hasProject && read === "done" && !hasRows && !filtering,
            );
            // …and every combination lands somewhere. A state machine that
            // returns undefined for a corner renders nothing at all, which
            // reads as an empty rail — the same lie by another route.
            expect(typeof got).toBe("string");
          }
  });

  test("the six answers are six different answers", () => {
    const seen = new Set([
      R({ hasProject: false }),
      R({ hasRows: true }),
      R({ read: "pending" }),
      R({ read: "failed" }),
      R({ filtering: true }),
      R({}),
    ]);
    expect(seen.size).toBe(6);
  });
});

describe("Source Control doesn't report a clean tree it never saw", () => {
  const C = (over: Partial<Parameters<typeof changesReadout>[0]> = {}) =>
    changesReadout({
      loading: false,
      failed: false,
      total: 0,
      liveActive: false,
      ...over,
    });

  const CLEAN = "No changes yet. Every file matches your last save";

  test("a git read that failed with nothing on screen says so", () => {
    const r = C({ failed: true });
    expect(r.tone).toBe("failed");
    expect(r.headerNote).toBe("couldn’t read");
    expect(r.body).toContain("couldn’t ask git");
    // The reassurance somebody checks before closing the lid. Not on a guess.
    expect(r.body).not.toContain(CLEAN);
    // …and it says the work is safe, because the failure is in the reading.
    expect(r.body).toContain("Nothing has been lost");
  });

  test("a failed refresh with rows keeps the rows and drops the certainty", () => {
    const r = C({ failed: true, total: 4 });
    expect(r.tone).toBe("failed");
    expect(r.headerNote).toBe("may be out of date");
    // Body null → the file list renders. The last good list is still the best
    // thing we have; replacing it with an error would hide real work.
    expect(r.body).toBeNull();
  });

  test("the first poll of a project is not a verdict", () => {
    const r = C({ loading: true });
    expect(r.tone).toBe("waiting");
    expect(r.headerNote).toBe("reading…");
    expect(r.body).toBe("Looking at what you’ve changed…");
    expect(r.body).not.toContain(CLEAN);
  });

  test("a read that finished and found nothing still reassures you", () => {
    const r = C();
    expect(r.tone).toBe("known");
    expect(r.headerNote).toBe("no changes");
    expect(r.body).toBe(CLEAN);
  });

  test("live sync changes what an empty tree means", () => {
    expect(C({ liveActive: true }).body).toBe("Your changes are in sync");
    expect(C({ liveActive: true }).tone).toBe("known");
  });

  test("with changes the header hands its counts back to the caller", () => {
    const r = C({ total: 7 });
    expect(r.headerNote).toBeNull();
    expect(r.body).toBeNull();
    expect(r.tone).toBe("known");
  });

  test("the five readouts are five different readouts", () => {
    const seen = new Set(
      [
        C({ failed: true }),
        C({ failed: true, total: 4 }),
        C({ loading: true }),
        C(),
        C({ liveActive: true }),
        C({ total: 7 }),
      ].map((r) => `${r.tone}|${r.headerNote}|${r.body}`),
    );
    expect(seen.size).toBe(6);
  });

  test("only a finished, successful read of an empty tree may call it clean", () => {
    // 24 combinations. The clean sentence is allowed in exactly one region.
    for (const loading of [false, true])
      for (const failed of [false, true])
        for (const total of [0, 3])
          for (const liveActive of [false, true]) {
            const r = changesReadout({ loading, failed, total, liveActive });
            const clean = !loading && !failed && total === 0;
            expect(r.body === CLEAN).toBe(clean && !liveActive);
            expect(r.body === "Your changes are in sync").toBe(clean && liveActive);
            // A failed read never presents itself as a settled answer, whether
            // or not it has rows left over to show.
            expect(r.tone === "failed").toBe(failed);
            expect(["known", "waiting", "failed"]).toContain(r.tone);
          }
  });
});


test("deletesNothingItShouldnt: the comment stripper keeps the code", () => {
  const src = [
    "// the clubbed bucket of machine churn (.aura/** snapshots, build output)",
    "const KEEP_ME = 1;",
    "/** a doc comment */",
    "const AND_ME = 2;",
  ].join("\n");
  const out = code(src);
  expect(out).toContain("KEEP_ME");
  expect(out).toContain("AND_ME");
  expect(out).not.toContain("clubbed bucket");
  expect(out).not.toContain("a doc comment");
});

async function read(rel: string): Promise<string> {
  return code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());
}

describe("both surfaces render the state their readouts computed", () => {
  test("the dialog's footer and button both come from undoCopy", async () => {
    const src = await read("components/dialogs/OpLogDialog.tsx");
    // Exactly one copy of the sentence, inside the function that owns it. A
    // second one in the JSX is how the three-arm ternary comes back.
    expect(src.split("Nothing in this list can be reversed").length - 1).toBe(1);
    expect(src).toContain("{copy.footnote}");
    expect(src).toContain("{copy.label}");
    // The failure arm is only reachable if the call site passes the error
    // through. Hardcode `failed: false` and the failed-read copy is dead.
    expect(src).toContain("failed: err !== null && ops.length === 0");
    expect(src).toContain("loading,");
  });

  test("the spend footnote reads the auth check, not the billing payload", async () => {
    const src = await read("components/workpanes/CostUsagePane.tsx");
    expect(src).toContain("footnote={spendFootnote(signedIn)}");
    // One copy of the sign-in prompt, inside spendFootnote.
    expect(src.split("Sign in to Aura Cloud").length - 1).toBe(1);
    // `signedIn` has to be fed by the auth API — reading it off `billing` is
    // the defect wearing a new variable name.
    expect(src).toContain("api.cloudAuthStatus()");
    expect(src).toContain("setSignedIn(st?.connected === true)");
  });

  test("the Pages rail draws all five bodies, and every read has a failure arm", async () => {
    const src = await read("components/pages/PagesSidebar.tsx");
    expect(src).toContain("pagesRailState({");
    for (const arm of ["loading", "failed", "no-project", "no-match", "empty"]) {
      expect(src).toContain(`body === "${arm}"`);
    }
    // The reassuring sentence exists once, in the arm that earned it.
    expect(src.split("No pages yet").length - 1).toBe(1);
    // Positive invariant rather than a ban: every notesList read must set a
    // failed state, so a new read can't quietly reintroduce the swallow.
    const reads = src.split("api\n      .notesList(").length - 1;
    expect(reads).toBeGreaterThan(0);
    expect(src.split('setRead("failed")').length - 1).toBe(reads);
    // The live mirror is a completed read too — without this the rail stays on
    // the spinner under real rows if notesList is slower than the workpane.
    const i = src.indexOf("function onMirror");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 600)).toContain('setRead("done")');
    // And the mount has to hand the rail the state it tracks. A correct state
    // machine fed a constant is a dead state machine: `read={"done"}` at the
    // call site puts "No pages yet" back on the first frame with every test
    // above still green. Pin the arguments, not only the function.
    expect(src).toContain("read={read}");
    expect(src).toContain("hasProject={!!repoRoot}");
    expect(src).toContain("onRetry={reloadSummaries}");
  });

  test("the Source Control panel reads the error its own hook computes", async () => {
    const src = await read("components/rightrail/ChangesPanel.tsx");
    // The whole defect in one line: `useGitChanges` has always returned an
    // `error`, and this file never mentioned it. Pin the argument, not just
    // the function — `failed: false` here is a correct readout fed a constant,
    // and puts "every file matches your last save" back over a broken git.
    expect(src).toContain("changes.error !== null");
    expect(src).toContain("failed: changes.error !== null");
    expect(src).toContain("loading: changes.loading");
    expect(src).toContain("total: totalChanged");
    expect(src).toContain("liveActive,");
    // One copy of the reassurance, inside the arm that earned it.
    expect(src.split("Every file matches your last save").length - 1).toBe(1);
    // All three tones are drawn, and the failed one offers a way back.
    expect(src).toContain('readout.tone === "waiting"');
    expect(src).toContain('readout.tone === "failed"');
    expect(src).toContain("onRetry={() => void refreshAll()}");
    // The header's own note comes from the readout, falling through to the
    // caller's counts only when the readout has nothing to correct.
    expect(src).toContain("{readout.headerNote ??");
    expect(src.split('"no changes"').length - 1).toBe(1);
  });

  test("the sign-in check is part of what `loading` waits for", async () => {
    // The whole reason null can mean "the check failed" and not "the check
    // hasn't run" is that the empty state only renders once loading clears,
    // and loading clears only after every task settles. Drop authTask from
    // that list and the honest third arm becomes a lie during the first frame.
    const src = await read("components/workpanes/CostUsagePane.tsx");
    expect(src).toContain("const tasks: Promise<void>[] = [authTask]");
    expect(src).toContain("await Promise.allSettled(tasks)");
    // …and the no-project path, which returns before the fan-out, waits too.
    expect(src).toContain("await authTask");
  });
});

describe("starting new work here won't run checkout -b on a tree it couldn't read", () => {
  // The composer's "In this folder" path is `git checkout -b` and nothing
  // else, which git refuses to do over uncommitted work. The guard above it
  // exists so the user gets that in words — "commit them first, or turn on
  // Separate copy" — instead of a raw command failure. `catch(() => ({}))`
  // answered "the tree is clean" for every way the status read can fail, and
  // walked straight past the guard into the command it exists to prevent.

  const REL = "components/workspace/WorkspaceCreateComposer.tsx";

  test("a failed status read is not a clean tree", async () => {
    const src = code(await read(REL));
    expect(src).toContain("api.gitStatus(repoRoot).catch(() => null)");
    expect(src.replace(/\s+/g, "")).not.toContain("gitStatus(repoRoot).catch(()=>({}))");
  });

  test("it stops, and says which of the two things it couldn't do", async () => {
    const src = code(await read(REL));
    const at = src.indexOf("if (dirty === null)");
    expect(at).toBeGreaterThan(-1);
    // The bail comes before the branch is created, not after.
    expect(at).toBeLessThan(src.indexOf("api.gitCreateBranch(repoRoot, branch)"));
    const block = src.slice(at, at + 700);
    expect(block).toContain("Couldn\u2019t check");
    // …and it points at the way out, the same as the dirty-tree message does.
    expect(block).toContain("Separate copy");
    expect(block).toContain("return;");
  });

  test("the two messages are different sentences", async () => {
    // One says "you have uncommitted changes", the other says "I don't know
    // whether you do". Collapsing them back into one would put the app back
    // to guessing on the user's behalf.
    const src = code(await read(REL));
    expect(src).toContain("This folder has changes you haven\u2019t committed yet");
    expect(src).toContain("it isn\u2019t safe to start the new work here");
  });
});
