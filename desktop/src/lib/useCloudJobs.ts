// Live view of the work this repo has handed to the cloud.
//
// A cloud workspace is the one kind of work with no copy on this disk: no
// worktree, no branch, nothing for the roster to draw a row from. Everything
// else in the app answers "what is running" by looking at the filesystem, so
// cloud work was minted on the board and then visible on no screen — the
// composer closed and nothing appeared anywhere, which is exactly how it read.
//
// This is where those jobs live. It polls `cloudJobsList` (which, unlike the
// badge feed, keeps branchless and finished rows) and refreshes immediately on
// `aura:cloud-task-created` so a job you just sent is on screen before the next
// tick — the send and the row appearing must feel like one action.
//
// One poller per repo root, shared by every subscriber, so two surfaces reading
// the same repo cost one request.

import { useEffect, useState } from "react";

import { api, type CloudJob } from "./api";
import { onOrgChanged } from "./cloudOrgs";

/** Cloud state changes at human speed and every read is a network round-trip,
 *  so this is deliberately slow. The event below is what makes it feel live. */
const REFRESH_MS = 20_000;

/** Statuses that mean the work has not finished. Kept in step with the Rust
 *  `is_in_flight` — the two are read together by anything that separates "still
 *  going" from "history". */
const IN_FLIGHT = new Set(["submitted", "working", "claimed", "running"]);

export function isCloudJobRunning(status: string): boolean {
  return IN_FLIGHT.has(status);
}

/** The entry key that means "every repo this account has sent work to", read in
 *  one request off the board rather than by fanning out over open projects. It
 *  is not a path, and cannot collide with one. */
const EVERY_REPO = "*";

type Entry = {
  /** The repo this entry polls, or `EVERY_REPO` for the account-wide read. */
  repoRoot: string;
  jobs: CloudJob[];
  /** Null until the first read resolves — the difference between "no cloud work"
   *  and "we haven't looked yet", which are very different empty states. */
  loaded: boolean;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
};

const entries = new Map<string, Entry>();

function ensure(repoRoot: string): Entry {
  const found = entries.get(repoRoot);
  if (found) return found;
  const entry: Entry = {
    repoRoot,
    jobs: [],
    loaded: false,
    subs: new Set(),
    timer: null,
    reading: false,
  };
  entries.set(repoRoot, entry);
  return entry;
}

function emit(entry: Entry) {
  for (const fn of entry.subs) fn();
}

async function read(entry: Entry) {
  if (entry.reading) return;
  entry.reading = true;
  try {
    const jobs =
      entry.repoRoot === EVERY_REPO
        ? await api.cloudJobsAll()
        : await api.cloudJobsList(entry.repoRoot);
    entry.jobs = jobs;
    entry.loaded = true;
    emit(entry);
  } catch {
    // Signed out, offline, or the board is unreachable. The command already
    // resolves to `[]` for the expected cases, so reaching here means something
    // unexpected — keep the last good list rather than blanking the surface,
    // but mark it read so the empty state stops claiming to be loading.
    if (!entry.loaded) {
      entry.loaded = true;
      emit(entry);
    }
  } finally {
    entry.reading = false;
  }
}

function schedule(entry: Entry) {
  if (entry.subs.size === 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void read(entry).then(() => schedule(entry));
  }, REFRESH_MS);
}

/** Force a re-read now, for every subscriber of this repo. Called when we know
 *  the board changed rather than waiting to discover it. */
export function refreshCloudJobs(repoRoot: string) {
  const entry = entries.get(repoRoot);
  if (entry) void read(entry);
}

/** A job plus which repo's board it came from. The board is scoped per repo, so
 *  a list spanning several has to carry that back or the rows are unattributable
 *  once they sit together. */
export type CloudJobWithRoot = CloudJob & { repoRoot: string };

/** NUL joins the roots into one effect key because it is the one byte a path
 *  cannot contain, so no two different root lists can collapse to the same key.
 *  Written as an escape, never typed literally — a raw NUL in source makes git
 *  treat the file as binary and an editor that strips control characters would
 *  silently change the key. */
const ROOT_SEP = "\u0000";

/** Newest first, and rows with no timestamp last rather than first — an absent
 *  date is not "just now", and sorting it to the top would put an unknown above
 *  work the user can date.
 *
 *  Exported because the section sorts too, and an ordering rule that lives in
 *  two places drifts. Whoever sorts, sorts the same way. */
export function byNewest(a: CloudJob, b: CloudJob): number {
  const at = a.created_at ? Date.parse(a.created_at) : NaN;
  const bt = b.created_at ? Date.parse(b.created_at) : NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

function newestFirst(jobs: CloudJobWithRoot[]): CloudJobWithRoot[] {
  return [...jobs].sort(byNewest);
}

/** Recent cloud jobs, newest first, each tagged with the repo it came from.
 *
 *  `roots` narrows the read to those repos. `null` means every repo this account
 *  has sent work to, answered by the board in one request — which is what the
 *  fleet page wants when its scope is all projects, because a job belongs to the
 *  account that sent it, not to whichever projects are open today. Fanning out
 *  over the open roster instead would silently lose work sent from a project
 *  since closed, which is the same disappearance one level up. Rows from that
 *  read carry no root, so they simply go unattributed rather than mislabelled. */
export function useCloudJobs(roots: string[] | null): {
  jobs: CloudJobWithRoot[];
  loaded: boolean;
} {
  const [, force] = useState(0);
  const key = (roots ?? [EVERY_REPO]).join(ROOT_SEP);

  useEffect(() => {
    const list = key ? key.split(ROOT_SEP) : [];
    if (!list.length) return;
    const fn = () => force((n) => n + 1);
    const mine = list.map(ensure);

    // A job you just sent has to appear now, not on the next slow tick.
    const onCreated = (e: Event) => {
      const detail = (e as CustomEvent<{ repoRoot?: string }>).detail;
      for (const entry of mine) {
        if (!detail?.repoRoot || detail.repoRoot === entry.repoRoot)
          void read(entry);
      }
    };
    window.addEventListener("aura:cloud-task-created", onCreated);

    // Switching org narrows the board to that org's projects, and the rows we
    // are holding are the previous one's. Re-read every entry, not just the
    // named repo: nothing about the org is per-repo.
    const offOrg = onOrgChanged(() => {
      for (const entry of mine) void read(entry);
    });

    for (const entry of mine) {
      entry.subs.add(fn);
      void read(entry).then(() => {
        if (entry.subs.size > 0 && !entry.timer) schedule(entry);
      });
    }

    return () => {
      window.removeEventListener("aura:cloud-task-created", onCreated);
      offOrg();
      for (const entry of mine) {
        entry.subs.delete(fn);
        if (entry.subs.size === 0 && entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      }
    };
  }, [key]);

  const list = key ? key.split(ROOT_SEP) : [];
  if (!list.length) return { jobs: [], loaded: true };

  const jobs: CloudJobWithRoot[] = [];
  // Loaded only once every repo has answered. One repo still in flight while
  // the others are empty would otherwise render a confident "nothing in the
  // cloud" over work that is about to appear.
  let loaded = true;
  for (const root of list) {
    const entry = entries.get(root);
    if (!entry?.loaded) loaded = false;
    // The account-wide read knows no local root, so its rows carry none rather
    // than borrowing a project they may not belong to.
    const tag = root === EVERY_REPO ? "" : root;
    for (const job of entry?.jobs ?? []) jobs.push({ ...job, repoRoot: tag });
  }
  return { jobs: newestFirst(jobs), loaded };
}
