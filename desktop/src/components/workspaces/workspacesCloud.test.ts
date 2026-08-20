import { describe, expect, test } from "bun:test";

import {
  chatSessionThatSent,
  cloudStatusLine,
  cloudThreadKey,
  groupCloudThreads,
  isCloudJobStranded,
  newCloudThreadKey,
  orderCloudJobs,
  projectLabel,
  railCloudThreads,
} from "../../lib/cloudJobs";
import { isCloudJobRunning, type CloudJobWithRoot } from "../../lib/useCloudJobs";

// The bug these guard: work sent to the cloud is the only work in the app with
// no copy on this disk, so every list that starts from the filesystem misses
// it. Pressing "Send to cloud" minted a real task on the board and then showed
// the user nothing, on any screen. These pin the rules that section follows.

/** A fixed clock. The section's rules depend on how old a row is, and a test
 *  that read the real time would change verdict as the fixtures aged. */
const NOW = Date.parse("2026-08-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const job = (over: Partial<CloudJobWithRoot> = {}): CloudJobWithRoot => ({
  id: "j1",
  status: "submitted",
  agent: "claude",
  branch: null,
  text: "Add the retry backoff",
  error_message: null,
  commit_sha: null,
  created_at: hoursAgo(1),
  context_id: null,
  repo: null,
  result: null,
  repoRoot: "/repos/alpha",
  ...over,
});

describe("what the cloud section shows", () => {
  test("unfinished work is never pushed off the end by history", () => {
    // The list is capped. If history sorted ahead of live work, a busy repo
    // would truncate away the one row the user is actually waiting on.
    const jobs = [
      job({ id: "old1", status: "completed" }),
      job({ id: "old2", status: "failed" }),
      job({ id: "old3", status: "canceled" }),
      job({ id: "live", status: "working" }),
    ];
    expect(orderCloudJobs(jobs, NOW)[0]!.id).toBe("live");
  });

  test("ordering is stable inside each group, so newest-first survives", () => {
    const jobs = [
      job({ id: "a", status: "working" }),
      job({ id: "b", status: "completed" }),
      job({ id: "c", status: "submitted" }),
      job({ id: "d", status: "failed" }),
    ];
    expect(orderCloudJobs(jobs, NOW).map((j) => j.id)).toEqual(["a", "c", "b", "d"]);
  });

  test("a queued job is not described as running", () => {
    // `submitted` means nobody has picked it up. Calling that "Running" is the
    // exact lie that makes a job with no machine behind it look healthy.
    expect(cloudStatusLine(job({ status: "submitted" }), NOW).label).toBe(
      "Waiting for a machine",
    );
    expect(cloudStatusLine(job({ status: "working" }), NOW).label).toBe("Running");
  });

  test("a failure is red and a finish is not", () => {
    expect(cloudStatusLine(job({ status: "failed" }), NOW).tint).toBe("var(--color-red)");
    expect(cloudStatusLine(job({ status: "completed" }), NOW).tint).not.toBe(
      "var(--color-red)",
    );
  });

  test("an unknown status is shown, not swallowed", () => {
    // The board can grow a state this build has never heard of. Printing it
    // verbatim is worse-looking and far better than rendering a blank cell.
    expect(cloudStatusLine(job({ status: "quarantined" }), NOW).label).toBe("quarantined");
  });

  test("a month of queued work does not bury today's failure", () => {
    // Straight from a real screenshot: six rows reading "Waiting for a machine ·
    // 1mo" filled the whole section while the job the user sent an hour ago —
    // the one that actually failed, with the reason on it — sat below the cut.
    // Unfinished-first is right; treating a job nothing ever claimed as
    // unfinished is what turned the sort into the same disappearing act.
    const stale = Array.from({ length: 8 }, (_, i) =>
      job({ id: `stale${i}`, status: "submitted", created_at: hoursAgo(24 * 30) }),
    );
    const mine = job({
      id: "mine",
      status: "failed",
      created_at: hoursAgo(1),
      error_message: "agent 'claude' exited 1: Not logged in · Please run /login",
    });
    const ordered = orderCloudJobs([...stale, mine], NOW);
    expect(ordered[0]!.id).toBe("mine");
    // And a genuinely fresh queued job still outranks it.
    const fresh = job({ id: "fresh", status: "submitted", created_at: hoursAgo(1) });
    expect(orderCloudJobs([...stale, mine, fresh], NOW)[0]!.id).toBe("fresh");
  });

  test("a queued job nothing ever claimed stops claiming to be waiting", () => {
    const fresh = job({ status: "submitted", created_at: hoursAgo(2) });
    const stranded = job({ status: "submitted", created_at: hoursAgo(24 * 30) });
    expect(isCloudJobStranded(fresh, NOW)).toBe(false);
    expect(isCloudJobStranded(stranded, NOW)).toBe(true);
    expect(cloudStatusLine(fresh, NOW).label).toBe("Waiting for a machine");
    expect(cloudStatusLine(stranded, NOW).label).toBe("Never picked up");
    // Only queued work can strand. A month-old finished job is just history.
    expect(
      isCloudJobStranded(job({ status: "completed", created_at: hoursAgo(24 * 30) }), NOW),
    ).toBe(false);
  });

  test("the running set matches the one the badge view uses", () => {
    // These two live in different languages (Rust `is_in_flight`, TS
    // `isCloudJobRunning`). If they drift, a job pulses on a worktree row while
    // this section files it under history.
    for (const live of ["submitted", "working", "claimed", "running"]) {
      expect(isCloudJobRunning(live)).toBe(true);
    }
    for (const done of ["completed", "failed", "canceled", "rejected"]) {
      expect(isCloudJobRunning(done)).toBe(false);
    }
  });
});

describe("what a cloud job carries", () => {
  test("a job sent from the composer has no branch and is still a real row", () => {
    // The whole defect in one assertion: this shape is what the composer mints,
    // and it is exactly what the branch-keyed badge feed drops.
    const composed = job();
    expect(composed.branch).toBeNull();
    expect(cloudStatusLine(composed, NOW).label).toBe("Waiting for a machine");
    expect(composed.text).toBe("Add the retry backoff");
  });

  test("a failed job keeps the runner's reason", () => {
    const dead = job({
      status: "failed",
      error_message: "agent 'claude' exited 1: Not logged in · Please run /login",
    });
    expect(dead.error_message).toContain("Not logged in");
    expect(isCloudJobRunning(dead.status)).toBe(false);
  });

  test("a job says which repo's board it came from", () => {
    // The board is scoped per repo, so a list spanning several has to carry
    // the root back or the rows are unattributable once they sit together —
    // and the section sits under an "In all projects" label.
    const jobs = [
      job({ id: "a", repoRoot: "/repos/alpha" }),
      job({ id: "b", repoRoot: "/repos/beta" }),
    ];
    expect(new Set(jobs.map((j) => j.repoRoot)).size).toBe(2);
    // Ordering must not lose the tag.
    expect(orderCloudJobs(jobs, NOW).map((j) => j.repoRoot)).toEqual([
      "/repos/alpha",
      "/repos/beta",
    ]);
  });

  test("a row names its project the way the rest of the page does", () => {
    // The board answers `owner/name`, and the owner is the same account on
    // every row here — printing it would spend a third of the row saying
    // nothing anyone is reading it for.
    expect(projectLabel("MHASK/aura-sovereign")).toBe("aura-sovereign");
    // A row the all-projects read couldn't attribute says nothing rather than
    // an empty label where a project name belongs.
    expect(projectLabel(null)).toBeNull();
    expect(projectLabel("   ")).toBeNull();
    // A name with no owner is still a name.
    expect(projectLabel("aura-sovereign")).toBe("aura-sovereign");
  });

  test("a reply and the request it answers are one conversation", () => {
    // This is the whole of what makes cloud work answerable: a reply is a
    // second task carrying the first one's context. If grouping missed that,
    // every reply would open its own thread and the conversation would be a
    // pile of unrelated rows again — the exact thing the user saw.
    const threads = groupCloudThreads([
      job({ id: "b", context_id: "cloud-x", text: "and add a test", created_at: hoursAgo(1) }),
      job({ id: "a", context_id: "cloud-x", text: "Add the retry backoff", created_at: hoursAgo(2) }),
    ]);
    expect(threads).toHaveLength(1);
    // Read downward: oldest first, unlike every job LIST in the app.
    expect(threads[0]!.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    // Named by how it opened, so replying doesn't rename the thread.
    expect(threads[0]!.title).toBe("Add the retry backoff");
    // Status and age come from the newest turn.
    expect(threads[0]!.latest.id).toBe("b");
  });

  test("a job with no context is a conversation of one, not a bucket", () => {
    // Jobs minted before threading — and any minted by a CLI that doesn't
    // thread — share a null context. Keying on that value directly would
    // gather every unrelated one into a single bogus conversation.
    const threads = groupCloudThreads([
      job({ id: "a", context_id: null }),
      job({ id: "b", context_id: null }),
    ]);
    expect(threads).toHaveLength(2);
    expect(cloudThreadKey(job({ id: "a", context_id: null }))).toBe("a");
    expect(cloudThreadKey(job({ id: "a", context_id: " cloud-x " }))).toBe("cloud-x");
  });

  test("the newest conversation leads, by its newest turn", () => {
    // A week-old thread you replied to a minute ago is the most current thing
    // you have. Ordering by a thread's FIRST message would bury it.
    const threads = groupCloudThreads([
      job({ id: "old-1", context_id: "cloud-old", created_at: hoursAgo(100) }),
      job({ id: "old-2", context_id: "cloud-old", created_at: hoursAgo(0.1) }),
      job({ id: "new-1", context_id: "cloud-new", created_at: hoursAgo(2) }),
    ]);
    expect(threads.map((t) => t.key)).toEqual(["cloud-old", "cloud-new"]);
  });

  test("only a chat-borne job offers a way back to a chat", () => {
    // `@aura-runner continue this in cloud` sets the context to the chat's own
    // session id. A thread the app minted names itself — offering "open the
    // chat that sent it" there would open a conversation that never existed.
    expect(chatSessionThatSent(job({ context_id: "sess-42" }))).toBe("sess-42");
    expect(chatSessionThatSent(job({ context_id: "cloud-abc" }))).toBeNull();
    expect(chatSessionThatSent(job({ context_id: null }))).toBeNull();
  });

  test("replying to a job that predates threading is not a chat handover", () => {
    // A job sent before threading existed has no context, so the conversation
    // is keyed by that job's own task id — and the reply's context is then a
    // bare uuid indistinguishable, by shape, from a chat session id. It offered
    // "open the chat that sent it" on a thread no chat had ever touched. The
    // thread knows better than the row: the id is one of its own.
    const request = job({ id: "task-1", context_id: null });
    const reply = job({ id: "task-2", context_id: "task-1" });

    expect(chatSessionThatSent(reply)).toBe("task-1"); // row alone can't tell
    expect(chatSessionThatSent(reply, new Set(["task-1", "task-2"]))).toBeNull();

    const [thread] = groupCloudThreads([request, reply]);
    expect(thread!.jobs).toHaveLength(2);
    expect(thread!.chatSession).toBeNull();

    // A real handover still keeps its way back, reply or no reply.
    const handed = groupCloudThreads([
      job({ id: "task-3", context_id: "sess-42" }),
      job({ id: "task-4", context_id: "sess-42" }),
    ]);
    expect(handed[0]!.chatSession).toBe("sess-42");
  });

  test("the rail keeps running work and only recent history", () => {
    // The rail sits under a project's copies and has room for a few rows. A
    // cap that dropped live work would recreate the disappearance this whole
    // feature exists to end, so live threads are always kept first.
    const threads = groupCloudThreads([
      job({ id: "r1", context_id: "c1", status: "working", created_at: hoursAgo(1) }),
      job({ id: "r2", context_id: "c2", status: "working", created_at: hoursAgo(2) }),
      job({ id: "r3", context_id: "c3", status: "working", created_at: hoursAgo(3) }),
      job({ id: "r4", context_id: "c4", status: "working", created_at: hoursAgo(4) }),
      job({ id: "d1", context_id: "c5", status: "completed", created_at: hoursAgo(1) }),
    ]);
    const rail = railCloudThreads(threads, NOW);
    expect(rail.map((t) => t.key)).toEqual(["c1", "c2", "c3", "c4"]);

    // Finished work stays a while — you have to be able to see what landed
    // while you were away — and then leaves, because a rail that accumulates
    // is a rail nobody reads.
    const fresh = groupCloudThreads([
      job({ id: "d1", context_id: "c1", status: "completed", created_at: hoursAgo(1) }),
      job({ id: "d2", context_id: "c2", status: "completed", created_at: hoursAgo(9) }),
    ]);
    expect(railCloudThreads(fresh, NOW).map((t) => t.key)).toEqual(["c1"]);

    // A month-old queued job is not "still going" — nothing is coming for it,
    // so it must not hold a rail slot against work that is.
    const stranded = groupCloudThreads([
      job({ id: "s1", context_id: "c1", status: "submitted", created_at: hoursAgo(30 * 24) }),
    ]);
    expect(railCloudThreads(stranded, NOW)).toEqual([]);
  });

  test("a minted thread key is unmistakable and unique", () => {
    const a = newCloudThreadKey();
    const b = newCloudThreadKey();
    expect(a.startsWith("cloud-")).toBe(true);
    expect(a).not.toBe(b);
    // Round-trips through the two rules that read it.
    expect(chatSessionThatSent(job({ context_id: a }))).toBeNull();
    expect(cloudThreadKey(job({ context_id: a }))).toBe(a);
  });

  test("a repo root with a space in it is still one root", () => {
    // This repo's own checkout lives under "New Git". Anything that packs roots
    // into a single key has to use a separator a path cannot contain — a space
    // would split this root in half and poll two directories that don't exist.
    const root = "/Users/me/Documents/New Git";
    expect(root.split("\u0000")).toEqual([root]);
    expect([root, "/repos/beta"].join("\u0000").split("\u0000")).toEqual([
      root,
      "/repos/beta",
    ]);
  });
});
