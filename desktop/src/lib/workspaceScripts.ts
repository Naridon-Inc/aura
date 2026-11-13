// A workspace's setup and archive scripts, as the app sees them.
//
// The scripts are the repository's `[worktree] setup` / `archive`. Setup runs
// on its own right after a workspace is made (the backend copies the
// repository's copy list in first); this module keeps, per workspace, the
// latest run and its output so the Setup tab, the chat's intro and the
// details popover all read the same thing.
//
// The backend sends `workspace-script` events — a piece of output, or the
// run's new state — and keeps each run's log on disk, so a workspace opened
// after its setup ended still shows how it went.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ScriptKind = "setup" | "archive";

export type ScriptStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "did_not_start";

export type ScriptRun = {
  kind: ScriptKind;
  worktreePath: string;
  command: string;
  status: ScriptStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  reason: string | null;
};

export type ScriptEvent = {
  worktreePath: string;
  kind: ScriptKind;
  chunk: string | null;
  run: ScriptRun | null;
};

export type WorkspaceScriptsState = {
  setup: ScriptRun | null;
  archive: ScriptRun | null;
};

export const SCRIPT_EVENT = "workspace-script";

/** How much output is kept in memory per script; older output is dropped
 *  from the front (the full log stays on disk). */
export const LOG_KEEP_CHARS = 256 * 1024;

export function workspaceScriptsState(worktreePath: string): Promise<WorkspaceScriptsState> {
  return invoke("workspace_scripts_state", { worktreePath });
}

export function workspaceScriptLog(worktreePath: string, kind: ScriptKind): Promise<string> {
  return invoke("workspace_script_log", { worktreePath, kind });
}

export function workspaceScriptRun(
  repoRoot: string,
  worktreePath: string,
  kind: ScriptKind,
): Promise<ScriptRun> {
  return invoke("workspace_script_run", { repoRoot, worktreePath, kind });
}

export function workspaceScriptStop(worktreePath: string, kind: ScriptKind): Promise<ScriptRun | null> {
  return invoke("workspace_script_stop", { worktreePath, kind });
}

/** Run the archive script before a workspace goes, and wait for it. `null`
 *  when the repository has none. */
export function workspaceArchiveScript(repoRoot: string, worktreePath: string): Promise<ScriptRun | null> {
  return invoke("workspace_archive_script", { repoRoot, worktreePath });
}

// ── pure ──────────────────────────────────────────────────────────────────

export function isLive(run: ScriptRun | null | undefined): boolean {
  return run?.status === "running" || run?.status === "stopping";
}

/** A script's latest run and what it printed. `gen` changes whenever the log
 *  is replaced rather than added to (a new run, a read back from disk);
 *  `total` counts every character added since, so a viewer that has drawn
 *  `n` of them knows the last `total - n` characters of `log` are new. */
export type ScriptView = { run: ScriptRun | null; log: string; gen: number; total: number };

export const EMPTY_VIEW: ScriptView = { run: null, log: "", gen: 0, total: 0 };

function keep(log: string): string {
  return log.length > LOG_KEEP_CHARS ? log.slice(log.length - LOG_KEEP_CHARS) : log;
}

/** PURE: fold one event into a script's view. A state for a run that began
 *  at a different time is a new run, and starts a new log. */
export function reduceScriptEvent(view: ScriptView, ev: ScriptEvent): ScriptView {
  let next = view;
  if (ev.run) {
    const fresh = !view.run || view.run.startedAt !== ev.run.startedAt;
    next = fresh ? { run: ev.run, log: "", gen: view.gen + 1, total: 0 } : { ...view, run: ev.run };
  }
  if (ev.chunk) next = { ...next, log: keep(next.log + ev.chunk), total: next.total + ev.chunk.length };
  return next;
}

/** PURE: what a viewer that has drawn `drawn` (its gen, its count) still has
 *  to draw: the new tail, or — when the log was replaced or more arrived than
 *  is kept — the whole log again. */
export function unseenOutput(
  view: ScriptView,
  drawn: { gen: number; total: number },
): { reset: boolean; text: string } {
  const behind = view.total - drawn.total;
  if (drawn.gen !== view.gen || behind < 0 || behind > view.log.length) {
    return { reset: true, text: view.log };
  }
  return { reset: false, text: behind === 0 ? "" : view.log.slice(view.log.length - behind) };
}

/** PURE: the message that hands a failed setup to the agent, with the log
 *  attached beside it. */
export function fixSetupScriptPrompt(setupScript: string | null | undefined, logs: string): string {
  const script = setupScript?.trim()
    ? `The setup script is: \`${setupScript.trim()}\`. The user can change this script in Settings > Scripts.\n\n`
    : "";
  return (
    "The user's setup script failed. (Aura runs the setup script in each new workspace after it's been created.) " +
    `Can you fix it?\n\n${script}Setup logs:\n${plainLog(logs).trim()}`
  );
}

/** Which of the setup button's three faces to show for a run. */
export type SetupFace = "run" | "rerun" | "stop";

export function setupFace(run: ScriptRun | null): SetupFace {
  if (isLive(run)) return "stop";
  return run ? "rerun" : "run";
}

/** The one-line state the details popover shows for setup; `null` when there
 *  is nothing to say (no run yet). */
export function setupStatusLabel(run: ScriptRun | null): string | null {
  if (!run) return null;
  switch (run.status) {
    case "running":
    case "stopping":
      return "Setting up...";
    case "completed":
      return "Setup succeeded";
    case "failed":
    case "did_not_start":
      return "Setup failed";
    case "cancelled":
      return "Setup stopped";
  }
}

/** PURE: what to tell the user after a workspace's archive script ran, or
 *  `null` when it went fine or there was none. Archiving goes ahead either
 *  way: a failed clean-up is worth knowing about, not worth keeping the
 *  workspace in the sidebar for. */
export function archiveNotice(run: ScriptRun | null): { title: string; body?: string } | null {
  if (!run) return null;
  switch (run.status) {
    case "failed":
      return {
        title: "Archive script failed",
        body: run.exitCode == null ? run.command : `${run.command} exited with code ${run.exitCode}`,
      };
    case "did_not_start":
      return { title: "Archive script didn't run", body: run.reason ?? undefined };
    case "cancelled":
      return { title: "Archive script was stopped" };
    default:
      return null;
  }
}

/** PURE: the log as plain text — colour codes and cursor moves taken out,
 *  carriage-return redraws (progress bars) collapsed to their last state. */
export function plainLog(text: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
  return noAnsi
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r");
      return at === -1 ? line : line.slice(at + 1);
    })
    .join("\n");
}

// ── the shared view, per workspace and script ─────────────────────────────

const views = new Map<string, ScriptView>();
const subscribers = new Map<string, Set<() => void>>();
let listening: Promise<unknown> | null = null;

function keyOf(worktreePath: string, kind: ScriptKind): string {
  return `${kind}\u0000${worktreePath.replace(/\/+$/, "")}`;
}

function notify(key: string) {
  subscribers.get(key)?.forEach((fn) => fn());
}

function set(key: string, view: ScriptView) {
  views.set(key, view);
  notify(key);
}

/** Fold a backend event into the shared view. Exported for the event
 *  listener and for tests. */
export function applyScriptEvent(ev: ScriptEvent) {
  const key = keyOf(ev.worktreePath, ev.kind);
  const before = views.get(key) ?? EMPTY_VIEW;
  set(key, reduceScriptEvent(before, ev));
  // A run that has just ended: read the log back once, so what is shown is
  // exactly what was kept, whatever arrived while the view was loading.
  if (ev.run && !isLive(ev.run) && isLive(before.run)) void reloadLog(ev.worktreePath, ev.kind);
}

function ensureListening() {
  if (listening) return;
  listening = listen<ScriptEvent>(SCRIPT_EVENT, (e) => applyScriptEvent(e.payload)).catch(() => {
    listening = null;
  });
}

async function reloadLog(worktreePath: string, kind: ScriptKind) {
  const key = keyOf(worktreePath, kind);
  try {
    const log = keep(await workspaceScriptLog(worktreePath, kind));
    const before = views.get(key) ?? EMPTY_VIEW;
    set(key, { run: before.run, log, gen: before.gen + 1, total: log.length });
  } catch {
    /* the live log stands */
  }
}

/** Read a workspace's script state and log from the backend into the view. */
export async function loadWorkspaceScript(worktreePath: string, kind: ScriptKind): Promise<void> {
  ensureListening();
  const key = keyOf(worktreePath, kind);
  try {
    const [state, log] = await Promise.all([
      workspaceScriptsState(worktreePath),
      workspaceScriptLog(worktreePath, kind),
    ]);
    const run = (kind === "setup" ? state?.setup : state?.archive) ?? null;
    const text = keep(typeof log === "string" ? log : "");
    const before = views.get(key) ?? EMPTY_VIEW;
    set(key, { run, log: text, gen: before.gen + 1, total: text.length });
  } catch {
    /* outside the desktop app, or the backend is older: nothing to show */
  }
}

export function scriptView(worktreePath: string, kind: ScriptKind): ScriptView {
  return views.get(keyOf(worktreePath, kind)) ?? EMPTY_VIEW;
}

export function subscribeScript(worktreePath: string, kind: ScriptKind, fn: () => void): () => void {
  ensureListening();
  const key = keyOf(worktreePath, kind);
  let set = subscribers.get(key);
  if (!set) subscribers.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

/** Test seam: forget every view. */
export function resetWorkspaceScriptsForTest() {
  views.clear();
  subscribers.clear();
}
