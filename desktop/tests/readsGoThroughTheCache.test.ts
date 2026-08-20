// A read with a cache in front of it has to go through the cache.
//
// Every module in lib/*Cache.ts exists because several surfaces ask the backend
// the same question at the same instant and none of them knows the others are
// there. Each was written after somebody measured the duplication — three
// pollers on one 6-second timer, twelve board heal-passes racing over the same
// files, a per-commit report shelled once per file that mentions it.
//
// None of that survives one surface calling the raw command. The cache keeps
// working for the callers that use it and the duplicate read comes back for
// everyone, which is exactly the state this app was in: gitStateCache's own
// header named the three components it was for, and all three were still
// calling `api.gitAheadBehind` directly.
//
// So the rule is enforced here rather than remembered. A caller that genuinely
// has to reach past a cache is fine — but it has to be listed below with the
// reason, because every one of these exceptions is a real distinction and the
// next person to add one should have to write down which.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Command → the cache module that owns it. Keep in step with lib/*Cache.ts. */
const GUARDED: Record<string, string> = {
  gitAheadBehind: "gitStateCache",
  gitDiffStats: "gitStateCache",
  tasksList: "tasksCache",
  taskStatesList: "tasksCache",
  taskLabelsList: "tasksCache",
  tasksCyclesList: "tasksCache",
  tasksModulesList: "tasksCache",
  managerList: "managerCache",
  loopReadyView: "loopCache",
  auraChangeNote: "changeNoteCache",
  prCommentsList: "prCommentsCache",
  claudeListSessions: "sessionsCache",
  claudeLoadSession: "sessionDataCache",
  managerLoadTranscript: "sessionDataCache",
  listDir: "dirListCache",
  teamLoad: "teamCache",
  cloudBillingUsageByMember: "billingCache",
};

/** Callers allowed to reach past the cache, and why. A `reason` is not a
 *  formality: each of these is a case where a shared answer would be wrong, not
 *  merely slower. */
const ALLOWED: Array<{ file: string; fn: string; reason: string }> = [
  {
    file: "src/components/rightrail/CommitInput.tsx",
    fn: "gitAheadBehind",
    reason:
      "reads back the branch it just committed to. A shared answer from a second ago predates the commit the user is watching for",
  },
  {
    file: "src/components/TasksBoard.tsx",
    fn: "taskLabelsList",
    reason:
      "re-reads the catalog after a write that can mint a label; a read already in flight when that write landed doesn't have it",
  },
  {
    file: "src/App.tsx",
    fn: "gitDiffStats",
    reason:
      "passes `sinceBase`, which asks a different question about the same repo. The cache keys on the repo alone and would answer the wrong one",
  },
  {
    file: "src/components/agent/AgentSurface.tsx",
    fn: "claudeLoadSession",
    reason:
      "replays a transcript that is still being written; a remembered read would be missing everything since",
  },
  {
    file: "src/components/agent/ResumeDialog.tsx",
    fn: "claudeLoadSession",
    reason:
      "same. Resuming a session twice in one window must replay what it says now, not what it said the first time",
  },
];

/** Files that ARE the cache (or the api surface underneath it). */
function exempt(rel: string): boolean {
  return (
    rel === "src/lib/api.ts" ||
    /^src\/lib\/[A-Za-z]*[Cc]ache\.ts$/.test(rel) ||
    rel.startsWith("src/lib/sharedRead")
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("a read with a cache in front of it goes through the cache", () => {
  // `api\s*\.\s*fn` and not `api.fn`: the house style breaks a promise chain
  // across lines (`api\n  .tasksList(root)`), and a pattern that only catches
  // the one-line form silently passes the exact call it exists to catch.
  const pattern = new RegExp(
    `\\bapi\\s*\\.\\s*(${Object.keys(GUARDED).join("|")})\\s*\\(`,
    "g",
  );

  const bypasses = walk(SRC).flatMap((full) => {
    const rel = "src" + full.slice(SRC.length);
    if (exempt(rel)) return [];
    const body = readFileSync(full, "utf8");
    return [...body.matchAll(pattern)].map((m) => ({
      file: rel,
      fn: m[1] as string,
      line: body.slice(0, m.index).split("\n").length,
    }));
  });

  test("no surface calls a guarded command directly", () => {
    const unlisted = bypasses.filter(
      (b) => !ALLOWED.some((a) => a.file === b.file && a.fn === b.fn),
    );
    // Name the cache in the failure: whoever trips this is one import away from
    // fixing it, and the message is where they'll look.
    expect(
      unlisted.map(
        (b) => `${b.file}:${b.line} calls api.${b.fn}. Use lib/${GUARDED[b.fn]}`,
      ),
    ).toEqual([]);
  });

  test("every listed exception is still a real call", () => {
    // An exception that no longer matches anything is worse than none: it reads
    // as a rule with a hole in it, and the next bypass at that path inherits a
    // reason somebody wrote for different code.
    const stale = ALLOWED.filter(
      (a) => !bypasses.some((b) => b.file === a.file && b.fn === a.fn),
    );
    expect(stale.map((a) => `${a.file} no longer calls api.${a.fn}`)).toEqual([]);
  });

  test("every exception says why", () => {
    for (const a of ALLOWED) expect(a.reason.length).toBeGreaterThan(30);
  });
});
