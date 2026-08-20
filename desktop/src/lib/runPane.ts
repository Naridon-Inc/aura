// Run — one command per project, always in the same place, one keystroke.
//
// Everything the app does for you happens while the thing you are building
// sits unstarted in a terminal you have to open by hand, cd into, and type
// the incantation at. The agent edits your dev server's code; seeing the
// result is a separate manual ritual every single time.
//
// So: Run is a terminal the app owns. It knows the command because it read
// the repo (`run_detect`), it lives in one reserved place in the panel, and
// ⌘R starts it — or restarts it, which is the same key you already press
// after a change in every IDE you have used.
//
// WHY RESTART RATHER THAN REUSE. A dev server's state after a change is the
// question ⌘R is asked to answer, and the honest answer is "start it again
// and see". Sending a command into a shell that may be at a prompt, may be
// mid-build, or may be sitting inside a REPL is a guess about what that
// shell is doing; killing the terminal and opening a new one is not. It also
// means Run never silently accumulates dead processes.
//
// WHY NO "RUNNING" LIGHT. We can know the terminal is alive; we cannot know
// your server is up — you may have hit ⌃C in it, or it may have crashed with
// its shell still at a prompt. A green dot meaning "alive" would be read as
// "your app is up", and it would be wrong exactly when it mattered. So the
// row says what it knows: whether Run is open, and what it runs.

import { api, type RunSuggestion } from "./api";
import { readShared, sharedReader, dropShared } from "./sharedRead";

/** The label the reserved terminal carries. Also what the panel row says. */
export const RUN_LABEL = "Run";

/** How long a detection stays good. A `package.json` script changes about as
 *  often as anyone edits it, and re-reading four small files is cheap — but
 *  it is still a cross-process hop, and the panel re-renders far more often
 *  than the repo changes. */
const DETECT_FRESH_MS = 60_000;

const detector = sharedReader<RunSuggestion>(
  (repoRoot) => api.runDetect(repoRoot),
  DETECT_FRESH_MS,
);

const OVERRIDE_PREFIX = "aura.run.cmd:";
const TERM_PREFIX = "aura.run.term:";

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the feature degrades to "not remembered" */
  }
}

/** The command this project's owner chose by hand, if they chose one. Beats
 *  anything we detected: they know their repo and we are reading its files. */
export function runCommandOverride(repoRoot: string): string | null {
  const raw = lsGet(OVERRIDE_PREFIX + repoRoot);
  return raw && raw.trim() ? raw : null;
}

/** Pin a command for this project, or clear the pin with `null` and fall back
 *  to what the repo says. */
export function setRunCommandOverride(repoRoot: string, command: string | null): void {
  const trimmed = command?.trim();
  lsSet(OVERRIDE_PREFIX + repoRoot, trimmed ? trimmed : null);
}

/** What the repo says about running itself, shared and cached. */
export function detectRun(repoRoot: string, force = false): Promise<RunSuggestion> {
  return readShared(detector, repoRoot, force);
}

/** Forget the detection — for after a `package.json` or `Makefile` edit. */
export function invalidateRunDetection(): void {
  dropShared(detector);
}

/** The command Run would use right now: the pin if there is one, else the
 *  best candidate the repo justified, else `null`.
 *
 *  `null` is a real answer and callers must render it as one — a project with
 *  no dev script gets asked, not given `npm run dev` and a failure. */
export async function resolveRunCommand(repoRoot: string): Promise<string | null> {
  const pinned = runCommandOverride(repoRoot);
  if (pinned) return pinned;
  try {
    return (await detectRun(repoRoot)).command;
  } catch {
    return null;
  }
}

/** The store surface Run needs. Passed in rather than imported so the logic
 *  below is exercisable without a React tree or a live editor store. */
export type RunDeps = {
  openPanelTerminal: (
    cwd: string,
    opts?: { bootCommand?: string; label?: string },
  ) => string;
  selectPanelTerminal: (termId: string) => void;
  closeTerminal: (termId: string) => void;
  /** The panel's live terminals — used to check that a remembered Run
   *  terminal still exists before we claim it does. */
  terminals: ReadonlyArray<{ termId: string; cwd: string }>;
};

/** The Run terminal for this project, if it is still there.
 *
 *  A remembered id is a claim about the world, and the world moves: the tab
 *  gets closed, the app restarts with a different set, the project is
 *  reopened somewhere else. So the id is only returned when a live terminal
 *  actually carries it AND still points at this project; a stale pointer is
 *  forgotten on the spot rather than handed out. */
export function liveRunTermId(repoRoot: string, deps: RunDeps): string | null {
  const remembered = lsGet(TERM_PREFIX + repoRoot);
  if (!remembered) return null;
  const tab = deps.terminals.find((t) => t.termId === remembered);
  if (!tab || tab.cwd !== repoRoot) {
    lsSet(TERM_PREFIX + repoRoot, null);
    return null;
  }
  return remembered;
}

export type RunOutcome =
  | { ok: true; termId: string; command: string; restarted: boolean }
  /** Nothing in the repo justified a command and nothing was pinned. The
   *  caller asks the user for one — it does not invent a default. */
  | { ok: false; reason: "no-command" };

/** Start this project, or restart it if Run is already open.
 *
 *  Restarting closes the old terminal first, so the reserved place holds one
 *  Run and the previous process is actually gone rather than orphaned behind
 *  a new tab. */
export async function runProject(repoRoot: string, deps: RunDeps): Promise<RunOutcome> {
  const command = await resolveRunCommand(repoRoot);
  if (!command) return { ok: false, reason: "no-command" };

  const existing = liveRunTermId(repoRoot, deps);
  if (existing) deps.closeTerminal(existing);

  const termId = deps.openPanelTerminal(repoRoot, {
    bootCommand: command,
    label: RUN_LABEL,
  });
  lsSet(TERM_PREFIX + repoRoot, termId);
  deps.selectPanelTerminal(termId);
  return { ok: true, termId, command, restarted: existing !== null };
}

/** Close Run for this project. Nothing open is not a failure — the button
 *  that calls this is allowed to be pressed twice. */
export function stopRun(repoRoot: string, deps: RunDeps): boolean {
  const existing = liveRunTermId(repoRoot, deps);
  if (!existing) return false;
  deps.closeTerminal(existing);
  lsSet(TERM_PREFIX + repoRoot, null);
  return true;
}

/** Focus Run without restarting it — the row click, as opposed to the play
 *  button. Returns false when there is nothing open to focus. */
export function focusRun(repoRoot: string, deps: RunDeps): boolean {
  const existing = liveRunTermId(repoRoot, deps);
  if (!existing) return false;
  deps.selectPanelTerminal(existing);
  return true;
}
