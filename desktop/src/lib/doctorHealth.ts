// Project health, turned from a structured probe report into plain-language
// items and one honest headline.
//
// The headline used to be computed like this:
//
//     const attention = items.filter((i) => i.severity === "attention").length;
//     attention > 0 ? "A couple of things to set up"
//                   : "Your project's in good shape"
//
// …where `items` came from a fold that read four of the report's ten fields.
// The engine counts SEVEN separate sources into `issues_found`: stuck
// sessions, orphaned backups, missing hooks, a signing probe that failed OR
// returned a status nobody recognises, entries only on this computer, entries
// only in the cloud, and a learning ledger waiting on a sign-in that hasn't
// happened. The dialog's amber arm read two of those. `shadow`,
// `cloud_rotation`, `plugins_loaded` and `issues_found` itself were never read
// at all — so a diverged record chain, or a signing probe that came back with
// an unrecognised status, produced a green "Your project's in good shape" and
// the words "Nothing needs your attention", with the engine's own count of
// real problems sitting unread in the same object.
//
// Two things fix that, and the second is the one that lasts:
//
//  1. Every field of the report is answered for below — including the ones
//     whose honest answer is "nothing worth saying".
//  2. Each item carries `counts`: how many of `issues_found` it accounts for.
//     If the items don't add up to the engine's own total, the headline is
//     NOT allowed to go green. A probe added upstream, or a status arm nobody
//     anticipated, shows up as a number this screen admits it can't explain
//     rather than disappearing into a reassurance.

import type { DoctorReport } from "./api";

export type Severity = "ok" | "attention" | "info";

export type HealthItem = {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** Optional compact rows revealed behind a "Show details" disclosure. */
  rows?: string[];
  /** How many of the engine's `issues_found` this item accounts for. Purely
   *  informational and healthy items are 0. Kept per-item rather than derived
   *  from severity because two of the engine's issue sources (old sessions,
   *  orphaned backups) are deliberately shown as harmless tidy-ups. */
  counts: number;
};

/** Same rule the engine uses: a signing key that simply hasn't been minted yet
 *  is informational — Aura writes one the first time it needs it. Everything
 *  else, including a status this build doesn't recognise, is a problem. */
const SIGNING_FINE = new Set(["ok", "missing"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function probeStatus(v: unknown): string {
  return str((v as { status?: unknown } | null | undefined)?.status);
}

function arrayLen(v: unknown, key: string): number {
  const a = (v as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(a) ? a.length : 0;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Turn the structured report into plain-language items. Order: things that
// need a look first, then what's healthy, then harmless tidy-ups last. Jargon
// (sessions, snapshots, hooks, signing keys, rotation chains, worktrees) is
// translated into what a non-engineer actually cares about.
export function buildHealthItems(r: DoctorReport): HealthItem[] {
  const attention: HealthItem[] = [];
  const healthy: HealthItem[] = [];
  const tidy: HealthItem[] = [];

  // Capture — is Aura watching this project's commits? The one genuine
  // "set this up" item, with a real place to fix it.
  if (r.hooks_installed) {
    healthy.push({
      key: "capture",
      severity: "ok",
      title: "Aura is watching your changes",
      detail: "Every commit gets recorded and checked automatically.",
      counts: 0,
    });
  } else {
    attention.push({
      key: "capture",
      severity: "attention",
      title: "Aura isn't watching this project yet",
      // "as you work" — no. The line directly above this one gets it right:
      // it's every COMMIT. Capture is a set of git hooks, so the off-state
      // description and the on-state description of one feature disagreed
      // about when it runs, four lines apart.
      detail:
        "Turn on Capture and Aura records each commit here, with the reason behind it. Settings → Capture.",
      counts: 1,
    });
  }

  // Signing — can Aura prove who made each change?
  const signStatus = probeStatus(r.signing);
  if (signStatus === "ok") {
    healthy.push({
      key: "signing",
      severity: "ok",
      title: "Your changes are signed",
      detail: "Aura signs each change so it can prove who made it.",
      counts: 0,
    });
  } else if (signStatus === "unreadable" || signStatus === "no_path") {
    attention.push({
      key: "signing",
      severity: "attention",
      title: "Aura can't read your signing key",
      detail: "Your changes can't be signed until the key file is back in place.",
      counts: 1,
    });
  } else if (!SIGNING_FINE.has(signStatus)) {
    // Anything else — including the probe coming back with no status at all,
    // which is what an outright failure looks like from here. The engine counts
    // this as a problem; this screen used to say nothing whatsoever about it.
    attention.push({
      key: "signing",
      severity: "attention",
      title: "Aura can't tell whether your changes are signed",
      detail:
        "The check came back with an answer Aura doesn't recognise, so it can't promise your changes carry proof of who made them. Try again, and if it keeps happening the signing key may need re-creating.",
      rows: [str((r.signing as { error?: unknown })?.error) || `status: ${signStatus || "(none)"}`],
      counts: 1,
    });
  }
  // "missing" stays quiet on purpose: Aura mints a key the first time it
  // needs one, and the engine doesn't count it either.

  // The signed record, here vs the cloud. Drift isn't corruption — it means
  // one side has entries the other hasn't seen — but the engine counts each
  // direction as a problem, and this screen never mentioned it at all.
  const rotStatus = probeStatus(r.cloud_rotation);
  const localOnly = arrayLen(r.cloud_rotation, "local_only");
  const cloudOnly = arrayLen(r.cloud_rotation, "cloud_only");
  if (rotStatus === "ok" && (localOnly > 0 || cloudOnly > 0)) {
    const parts: string[] = [];
    if (localOnly > 0)
      parts.push(
        `${localOnly} ${plural(localOnly, "entry is", "entries are")} only on this computer`,
      );
    if (cloudOnly > 0)
      parts.push(
        `${cloudOnly} ${plural(cloudOnly, "entry is", "entries are")} only in the cloud`,
      );
    attention.push({
      key: "record-drift",
      severity: "attention",
      title: "Your record of changes doesn't match the cloud copy",
      detail: `${parts.join(", and ")}. Sign in and sync so the same history is in both places.`,
      counts: (localOnly > 0 ? 1 : 0) + (cloudOnly > 0 ? 1 : 0),
    });
  } else if (rotStatus === "error") {
    attention.push({
      key: "record-drift",
      severity: "attention",
      title: "Aura couldn't compare your record with the cloud",
      detail:
        "The check didn't complete, so Aura can't tell you whether this computer and the cloud hold the same history.",
      rows: [str((r.cloud_rotation as { error?: unknown })?.error) || "the check reported an error"],
      counts: 1,
    });
  } else if (rotStatus !== "ok" && rotStatus !== "skipped") {
    // Unrecognised — same treatment as a failure, because that is what it is
    // from here. ("skipped" is the not-signed-in case; nothing to compare.)
    attention.push({
      key: "record-drift",
      severity: "attention",
      title: "Aura couldn't compare your record with the cloud",
      detail:
        "The check came back with an answer Aura doesn't recognise, so it can't confirm this computer and the cloud hold the same history.",
      rows: [`status: ${rotStatus || "(none)"}`],
      counts: 1,
    });
  }

  // Old sessions — the big one. Harmless leftover bookkeeping, NOT a problem,
  // even though the engine counts each one.
  const stuck = r.stuck_sessions ?? [];
  if (stuck.length > 0) {
    tidy.push({
      key: "sessions",
      severity: "info",
      title: `${stuck.length} old session${stuck.length === 1 ? "" : "s"} left open`,
      detail:
        "Leftover bookkeeping from past AI runs. They don't affect your code and are safe to ignore.",
      rows: stuck.map(
        (s) =>
          `${s.agent_id || "agent"} · ${s.files_touched} file${s.files_touched === 1 ? "" : "s"} · ${s.reason}`,
      ),
      counts: stuck.length,
    });
  }

  // Backups (snapshots) — Aura keeps one before each AI edit so you can undo.
  if (r.snapshots.orphaned > 0) {
    tidy.push({
      key: "backups-orphan",
      severity: "info",
      title: `${r.snapshots.orphaned} backup${r.snapshots.orphaned === 1 ? "" : "s"} point to files that are gone`,
      detail: "Leftover backups. Safe to clear, they don't affect anything.",
      counts: r.snapshots.orphaned,
    });
  } else if (r.snapshots.oversized) {
    tidy.push({
      key: "backups-large",
      severity: "info",
      title: `You've saved a lot of backups (${r.snapshots.total})`,
      detail:
        "Each one is a copy of a file saved before it was edited, so you can put it back. Nothing's wrong, just a lot of history piling up.",
      counts: 0,
    });
  } else if (r.snapshots.total > 0) {
    healthy.push({
      key: "backups-ok",
      severity: "ok",
      title: "Your undo history is healthy",
      // Was "Aura can roll any AI edit back", which reads a count as a
      // guarantee of coverage. A backup is one saved copy of one file; an edit
      // to a file that was never snapshotted has nothing to go back to, and
      // agent_mutation_guard.rs:298 returns exactly that — "no snapshot found
      // for <path>". Say what the number is, not what you'd like it to imply.
      detail: `${r.snapshots.total} saved cop${r.snapshots.total === 1 ? "y" : "ies"} of files, each one Aura can put back the way it was.`,
      counts: 0,
    });
  }
  // Zero backups is the honest state of a project nothing has edited yet — no
  // row, because there is nothing to report either way.

  // Restore points — the checkpoint branch. Worth confirming when it's there;
  // its absence is the normal state of a project Aura hasn't checkpointed yet,
  // so it earns no row and the engine counts nothing for it.
  if (r.shadow.exists && r.shadow.checkpoints > 0) {
    healthy.push({
      key: "restore-points",
      severity: "ok",
      title: `${r.shadow.checkpoints} restore point${r.shadow.checkpoints === 1 ? "" : "s"} saved`,
      detail:
        "Points in this project's history Aura can put a file, or the whole project, back to.",
      counts: 0,
    });
  }

  // Leftover replay workspaces — left behind when a replay run was stopped.
  const orphans = r.replay_orphans ?? [];
  if (orphans.length > 0) {
    tidy.push({
      key: "replay-orphans",
      severity: "info",
      title: `${orphans.length} leftover workspace${orphans.length === 1 ? "" : "s"} from interrupted runs`,
      detail: "Safe to clear. Left behind when a replay was stopped early.",
      rows: orphans.map((o) => `${o.branch} · ${o.path}`),
      counts: 0,
    });
  }

  // Learning data. Two states worth saying out loud: waiting to sync, and a
  // ledger that's there but unreadable — the second was silent before, and a
  // file Aura can't read is exactly the thing a health screen exists for.
  if (r.skill_ledger.present && !r.skill_ledger.readable) {
    attention.push({
      key: "skill-unreadable",
      severity: "attention",
      title: "Aura can't read what it's learned about your project",
      detail:
        "The file is there but Aura can't make sense of it, so suggestions won't improve from your past work until it's rebuilt.",
      counts: 0,
    });
  } else if (r.skill_ledger.present && r.skill_ledger.dirty > 0) {
    tidy.push({
      key: "skill-sync",
      severity: "info",
      title: "Some learning data is waiting to sync",
      detail: "It'll upload the next time you're signed in to Aura.",
      // The engine counts this ONLY when there's no cloud sign-in to flush to,
      // and it doesn't tell us which case this was. Claiming it either way
      // would be a guess; the reconciliation below absorbs the difference and
      // keeps the headline honest without one.
      counts: 0,
    });
  }

  // `plugins_loaded` is a count of extensions Aura found. Zero is the normal
  // state, a positive number is nobody's business on a health screen, and the
  // engine counts nothing for it — so it earns no row. Named here on purpose:
  // every field of the report is answered for, including the ones whose honest
  // answer is "nothing worth saying".
  void r.plugins_loaded;

  return [...attention, ...healthy, ...tidy];
}

export type HealthVerdict = {
  text: string;
  tone: "attention" | "good" | "unknown";
  chips: string[];
};

/** One plain-language sentence at the top: someone who didn't write the code
 *  should read it and know whether to worry.
 *
 *  The green arm is the one with a guard on it. `issues_found` is the engine's
 *  own count of real problems; if the items above don't account for all of
 *  them, something ran that this screen can't explain, and an unexplained
 *  problem must never render as an all-clear. */
export function healthHeadline(
  items: HealthItem[],
  r: DoctorReport,
): HealthVerdict {
  const attention = items.filter((i) => i.severity === "attention").length;
  const tidy = items.filter((i) => i.severity === "info").length;
  const accounted = items.reduce((n, i) => n + i.counts, 0);
  const unexplained = Math.max(0, (r.issues_found ?? 0) - accounted);

  const chips: string[] = [];
  if (attention > 0) chips.push(`${attention} to look at`);
  if (tidy > 0) chips.push(`${tidy} safe to tidy up`);
  if (unexplained > 0)
    chips.push(
      `${unexplained} ${plural(unexplained, "finding", "findings")} this screen can't explain`,
    );

  if (unexplained > 0) {
    return {
      text: "Aura found something this screen can't explain",
      tone: "unknown",
      chips,
    };
  }
  if (attention > 0) {
    return { text: "A couple of things need a look", tone: "attention", chips };
  }
  return {
    text: "Your project's in good shape",
    tone: "good",
    chips: chips.length ? chips : ["Nothing needs your attention"],
  };
}
