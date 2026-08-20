// How cloud work reads: what a job's state means, and which jobs are one
// conversation.
//
// These rules started inside the Workspaces section that first drew cloud rows.
// They are here because three surfaces now answer from them — that section, the
// project rail, and the thread pane — and a status that reads "Running" on one
// screen and "Waiting" on another is worse than either.

import {
  byNewest,
  isCloudJobRunning,
  type CloudJobWithRoot,
} from "./useCloudJobs";
import type { CloudJob } from "./api";

/** After this long with no machine, a job is not waiting — it is stranded.
 *
 *  Nothing on the board ever expires a queued job, so a task submitted while no
 *  runner was online stays "submitted" forever. Treating that as live work is
 *  what buried today's failure under six queued rows from a month ago. A day is
 *  well past any real queue wait and well short of anything a person would still
 *  call recent. */
const STRANDED_AFTER_MS = 24 * 60 * 60 * 1000;

function ageMs(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : nowMs - at;
}

/** Queued, and long enough ago that no machine is coming for it. */
export function isCloudJobStranded(job: CloudJob, nowMs: number): boolean {
  return job.status === "submitted" && ageMs(job.created_at, nowMs) > STRANDED_AFTER_MS;
}

/** How a status reads to someone who did not write the scheduler. The board's
 *  vocabulary is for machines; these are the same states in the words a person
 *  would use about their own work. */
export function cloudStatusLine(
  job: CloudJob,
  nowMs: number,
): { label: string; tint: string } {
  switch (job.status) {
    case "submitted":
      // "Waiting for a machine" on a month-old row is a lie of tense: nothing is
      // waiting, no machine was ever online to take it. Say which it is.
      return isCloudJobStranded(job, nowMs)
        ? { label: "Never picked up", tint: "var(--color-text-4)" }
        : { label: "Waiting for a machine", tint: "var(--color-amber)" };
    case "claimed":
    case "working":
    case "running":
      return { label: "Running", tint: "var(--color-accent)" };
    case "input-required":
      // The machine stopped and asked. This is the one unfinished state the
      // user can clear themselves, so it says so rather than reading as busy.
      return { label: "Waiting on you", tint: "var(--color-amber)" };
    case "completed":
      return { label: "Finished", tint: "var(--color-text-3)" };
    case "failed":
      return { label: "Failed", tint: "var(--color-red)" };
    case "canceled":
      return { label: "Cancelled", tint: "var(--color-text-4)" };
    case "rejected":
      return { label: "Refused", tint: "var(--color-red)" };
    default:
      return { label: job.status, tint: "var(--color-text-4)" };
  }
}

/** Live work first — that is the part you can still be waiting on — then the
 *  most recent history beneath it. Both groups keep newest-first order.
 *
 *  This is what makes a truncated list safe: whatever is still running is always
 *  among the rows kept, however much history sits behind it.
 *
 *  "Live" excludes stranded rows. Unfinished alone is not enough: a queued job
 *  never expires, so a repo with a month of them would hand the whole visible
 *  list to work nothing is doing and push today's real failure out of sight —
 *  which is the same disappearance this file exists to end, produced by the sort
 *  instead of the fetch. */
export function orderCloudJobs<T extends CloudJob>(jobs: T[], nowMs: number): T[] {
  const live = (j: T) => isCloudJobRunning(j.status) && !isCloudJobStranded(j, nowMs);
  // Each group is dated here rather than inherited from the caller. Demoting a
  // stranded row out of the live group is only half the job: if the group it
  // lands in keeps whatever order it arrived in, a month of queued work still
  // sits on top of today's failure. The guarantee belongs where the decision is.
  return [
    ...jobs.filter(live).sort(byNewest),
    ...jobs.filter((j) => !live(j)).sort(byNewest),
  ];
}

/** The project a row belongs to, in the words the rest of the page uses.
 *
 *  The board answers in `owner/name`, but the owner is the same account on
 *  every row here, so printing it spends a third of the row saying nothing. */
export function projectLabel(repo: string | null | undefined): string | null {
  const full = (repo ?? "").trim();
  if (!full) return null;
  const [, name] = full.split("/");
  return (name || full).trim() || null;
}

// ── Threads ────────────────────────────────────────────────────────────────
//
// A2A groups tasks by `context_id`, and that grouping is the whole of what
// makes cloud work answerable. One send is a task; a reply is a second task
// carrying the same context; the two read as a conversation because they share
// a key, not because anything streamed.

/** Marks a context this app minted for a cloud conversation, as opposed to one
 *  borrowed from a chat session that dispatched the work.
 *
 *  Both live in the same column, and the difference matters on screen: a job
 *  whose context is a chat session can offer a way back to that chat, and one
 *  whose context is a thread of its own must not — that button would open a
 *  conversation that has never existed. A prefix answers it without a lookup. */
export const CLOUD_THREAD_PREFIX = "cloud-";

/** Mint the context id for a new cloud conversation. */
export function newCloudThreadKey(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${CLOUD_THREAD_PREFIX}${rand}`;
}

/** Which conversation a job belongs to.
 *
 *  A job minted before threading existed — or by a CLI that doesn't thread —
 *  has no context. It is not lost and it is not lumped in with every other
 *  contextless job: it is a conversation of one, keyed by itself. */
export function cloudThreadKey(job: CloudJob): string {
  const ctx = (job.context_id ?? "").trim();
  return ctx || job.id;
}

/** The chat session that handed this work over, when a chat did.
 *
 *  `@aura-runner continue this in cloud` sets the context to the chat's own
 *  session id, so the job can be taken back to where it was decided. A thread
 *  this app minted names itself and has no chat behind it.
 *
 *  The prefix alone isn't enough. Replying to a job that predates threading
 *  keys the conversation by that job's own task id, so the reply's context is
 *  a bare uuid that looks exactly like a session id — and offered a way back
 *  to a chat that was never there. `knownTaskIds` is whatever tasks the caller
 *  has in hand; a context found among them is a task, not a chat. */
export function chatSessionThatSent(
  job: CloudJob,
  knownTaskIds?: ReadonlySet<string>,
): string | null {
  const ctx = (job.context_id ?? "").trim();
  if (!ctx || ctx.startsWith(CLOUD_THREAD_PREFIX)) return null;
  if (ctx === job.id) return null;
  if (knownTaskIds?.has(ctx)) return null;
  return ctx;
}

/** One cloud conversation: every job that shares a context, oldest first. */
export type CloudThread = {
  key: string;
  /** The repo whose board these came from. Empty for the account-wide read,
   *  which knows no local checkout. */
  repoRoot: string;
  /** Oldest first — a conversation is read downward, unlike a job list. */
  jobs: CloudJobWithRoot[];
  /** The newest job: what the thread's status and age are taken from. */
  latest: CloudJobWithRoot;
  /** What the user asked for first. A thread is named by how it opened, so its
   *  title doesn't change under them every time they reply. */
  title: string;
  /** The chat this conversation was handed over from, if it was. Decided over
   *  the whole thread rather than one row, because only the thread knows which
   *  of its context ids are its own task ids. */
  chatSession: string | null;
};

/** Gather jobs into conversations, newest conversation first.
 *
 *  Ordering is by the thread's newest job, not its first: a week-old thread you
 *  replied to a minute ago is the most current thing you have. */
export function groupCloudThreads(jobs: CloudJobWithRoot[]): CloudThread[] {
  const byKey = new Map<string, CloudJobWithRoot[]>();
  for (const job of jobs) {
    const key = cloudThreadKey(job);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(job);
    else byKey.set(key, [job]);
  }

  const threads: CloudThread[] = [];
  for (const [key, bucket] of byKey) {
    // Oldest first for reading; newest is then the last element.
    const jobsAsc = [...bucket].sort(byNewest).reverse();
    const first = jobsAsc[0]!;
    const latest = jobsAsc[jobsAsc.length - 1]!;
    // The thread's own task ids, so a reply that keyed itself by the request it
    // answers isn't mistaken for one handed over from a chat. Read oldest
    // first: the handover is what opened the conversation.
    const ownIds = new Set(jobsAsc.map((j) => j.id));
    let chatSession: string | null = null;
    for (const job of jobsAsc) {
      chatSession = chatSessionThatSent(job, ownIds);
      if (chatSession) break;
    }
    threads.push({
      key,
      repoRoot: first.repoRoot,
      jobs: jobsAsc,
      latest,
      title: (first.text ?? "").trim() || "Cloud work",
      chatSession,
    });
  }
  return threads.sort((a, b) => byNewest(a.latest, b.latest));
}

/** Is anything in this conversation still expected to move on its own? */
export function isCloudThreadLive(thread: CloudThread, nowMs: number): boolean {
  return (
    isCloudJobRunning(thread.latest.status) &&
    !isCloudJobStranded(thread.latest, nowMs)
  );
}

/** A finished thread stays in the project rail this long, so work that lands
 *  while you were away is still there when you look — and then leaves, because
 *  a rail that accumulates is a rail nobody reads. */
const RAIL_KEEPS_FINISHED_MS = 6 * 60 * 60 * 1000;

/** The rail has room for a few rows beside your checkouts, not a history. */
const RAIL_MAX = 4;

/** Which conversations a project's rail should show: everything still moving,
 *  plus whatever finished recently enough that you haven't seen it yet. Live
 *  threads always come first, so a cap can never hide running work. */
export function railCloudThreads(
  threads: CloudThread[],
  nowMs: number,
): CloudThread[] {
  const live = threads.filter((t) => isCloudThreadLive(t, nowMs));
  const recent = threads.filter(
    (t) =>
      !isCloudThreadLive(t, nowMs) &&
      // A stranded thread is not "recent news" — nothing happened to it. It
      // stays on the Workspaces page, where the whole list lives.
      !isCloudJobStranded(t.latest, nowMs) &&
      ageMs(t.latest.created_at, nowMs) < RAIL_KEEPS_FINISHED_MS,
  );
  return [...live, ...recent].slice(0, RAIL_MAX);
}
