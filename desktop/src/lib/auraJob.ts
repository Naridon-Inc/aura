// Background work Aura does for you — without hijacking the conversation
// you're in.
//
// Every actionable row in the review rail (Safety check, Prove, Commit and
// push, Draft the pull request, Create PR…) hands its work to Aura. It used to
// do that by writing a synthetic user turn into the project's AMBIENT chat —
// the very session the user might be mid-conversation in — and then yanking the
// rail onto it. Clicking "Create PR" while you were talking to Aura about
// something else spliced a paragraph of PR instructions into your thread and
// pulled the view away from what you were reading. Create PR was worse still:
// when an agent was running for the repo it injected the prompt straight into
// that agent's live terminal, interrupting a run mid-flight.
//
// A job instead runs in its OWN session: minted fresh, dispatched into with
// `background: true` (so nothing repoints the ambient pointer or fires the
// focus event), polled to completion, and announced with a toast that offers to
// open it. Your conversation is untouched; the work still happens somewhere you
// can read it.
//
// The store is module-level rather than component state on purpose — the
// Checks rail and the header's Create PR button both drive the same job ids, so
// a PR job started from one shows its live state in the other, and the state
// survives the rail being unmounted while the work runs.

import { useCallback, useSyncExternalStore } from "react";
import { placeForNewWork } from "./ambientSession";
import { api } from "./api";
import { openManagerSession } from "./editorStore";
import { sendAmbientManagerTurn } from "./managerTurn";
import { toast } from "./toast";

export type AuraJobStatus =
  | "running"
  /** The brain finished the turn. */
  | "done"
  /** We never got the work started (session wouldn't mint, dispatch threw). */
  | "failed"
  /** Still running after DETACH_AFTER_MS — we stopped watching, it didn't stop
   *  working. Said plainly rather than reported as "done", which would be a
   *  lie about work that's still in flight. */
  | "detached";

export type AuraJob = {
  /** Caller-chosen id, unique per repo — the row/button it belongs to
   *  ("review", "prove", "create-pr"). Re-firing a live id is a no-op. */
  id: string;
  repoRoot: string;
  /** Plain-language name of the work, for the toast and the row. */
  title: string;
  /** The session the work runs in. "" until the session is minted. */
  sessionId: string;
  status: AuraJobStatus;
  startedAt: number;
};

/** Give up watching (not working) after this long. Real jobs settle in
 *  seconds-to-minutes; this only stops a wedged session polling forever. */
const DETACH_AFTER_MS = 30 * 60_000;
const POLL_MS = 1200;
/** How long a settled job lingers in the store so its row can flash "Done ✓"
 *  before falling back to its default label. */
const LINGER_MS = 6000;

export function jobKey(repoRoot: string, id: string): string {
  return `${repoRoot}\u0000${id}`;
}

// One frozen snapshot object, replaced (never mutated) on every change, so
// `useSyncExternalStore` sees a stable reference between updates.
let jobs: Record<string, AuraJob> = {};
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function put(job: AuraJob): void {
  jobs = { ...jobs, [jobKey(job.repoRoot, job.id)]: job };
  emit();
}

function drop(repoRoot: string, id: string): void {
  const key = jobKey(repoRoot, id);
  if (!(key in jobs)) return;
  const next = { ...jobs };
  delete next[key];
  jobs = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Look up this repo's jobs by row id. `useAuraJobs(root)("review")` is null
 *  when nothing is running (or lingering) for that row. */
export function useAuraJobs(repoRoot: string): (id: string) => AuraJob | null {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => jobs,
    () => jobs,
  );
  return useCallback(
    (id: string) => snapshot[jobKey(repoRoot, id)] ?? null,
    [snapshot, repoRoot],
  );
}

export function getAuraJob(repoRoot: string, id: string): AuraJob | null {
  return jobs[jobKey(repoRoot, id)] ?? null;
}

function settle(job: AuraJob, status: AuraJobStatus): void {
  put({ ...job, status });
  if (status === "done" || status === "detached") {
    // The work touched the repo (commits, a push, a new PR) — tell the surfaces
    // that read git + the PR list to refresh, so the result appears on its own
    // rather than waiting for the user to click something.
    window.dispatchEvent(new Event("aura:git-changed"));
  }
  const sid = job.sessionId;
  toast.show({
    id: `aura-job-${jobKey(job.repoRoot, job.id)}`,
    tone: status === "done" ? "success" : status === "failed" ? "danger" : "info",
    title:
      status === "done"
        ? `${job.title}. Done`
        : status === "failed"
          ? `${job.title}. Couldn't start`
          : `${job.title}. Still running`,
    message:
      status === "done"
        ? "Aura finished this in the background."
        : status === "failed"
          ? "Aura couldn't start this. Try again, or ask in chat."
          : "This is taking a while. Open it to see where it's up to.",
    durationMs: status === "done" ? 8000 : null,
    actions: sid
      ? [{ label: "See what Aura did", onClick: () => openManagerSession(sid, job.title) }]
      : undefined,
  });
  window.setTimeout(() => {
    const current = getAuraJob(job.repoRoot, job.id);
    if (current && current.status !== "running") drop(job.repoRoot, job.id);
  }, LINGER_MS);
}

// Watch the job's session until the brain stops working. Mirrors the live
// signal ManagerSurface uses (session status OR any running task), with a short
// grace before the first observed "running" so we don't call a CLI-backed brain
// finished while it's still spinning up.
function watch(job: AuraJob): void {
  let sawRunning = false;
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    void api
      .managerStatus(job.sessionId)
      .then((s) => {
        const busy =
          s.status === "running" || s.tasks.some((t) => t.status === "running");
        if (busy) sawRunning = true;
        const elapsed = Date.now() - startedAt;
        const terminal =
          (s.status === "completed" || s.status === "cancelled") && !busy;
        if (terminal || (!busy && (sawRunning || elapsed > 6_000))) {
          window.clearInterval(timer);
          settle(job, "done");
        } else if (elapsed > DETACH_AFTER_MS) {
          window.clearInterval(timer);
          settle(job, "detached");
        }
      })
      .catch(() => {
        // Session gone — nothing left to watch. Treat as finished rather than
        // spinning forever on a session that no longer exists.
        window.clearInterval(timer);
        settle(job, "done");
      });
  }, POLL_MS);
}

/**
 * Run `text` as a background job for `repoRoot` and return the job.
 *
 * The session is minted here (seeded with the prompt, so the job is
 * identifiable in Sessions) and the turn is dispatched into that exact session
 * with `background: true`. Nothing touches `aura.ambient.<root>` and no focus
 * event fires, so an open chat keeps its thread and the rail stays where the
 * user left it.
 *
 * Firing an id that's already running returns the live job untouched — a second
 * click on "Review" shouldn't start a second review.
 */
export function startAuraJob(input: {
  repoRoot: string;
  id: string;
  title: string;
  text: string;
}): AuraJob {
  const { repoRoot, id, title, text } = input;
  const live = getAuraJob(repoRoot, id);
  if (live && live.status === "running") return live;

  const job: AuraJob = {
    id,
    repoRoot,
    title,
    sessionId: "",
    status: "running",
    startedAt: Date.now(),
  };
  put(job);

  void (async () => {
    try {
      // A job runs where the work it is about lives. Fired from a machine's
      // workspace, a review reviews the code on that machine; fired here, the
      // code here. The turn is told the same place the session was made with,
      // so the two can't disagree.
      const place = placeForNewWork(repoRoot);
      const sessionId = await api.managerChatStart(repoRoot, text, place);
      const started = { ...job, sessionId };
      put(started);
      await sendAmbientManagerTurn(repoRoot, text, {
        sessionId,
        machineId: place,
        background: true,
      });
      watch(started);
    } catch (e) {
      console.error("[aura-job] failed to start:", e);
      settle(getAuraJob(repoRoot, id) ?? job, "failed");
    }
  })();

  return job;
}
