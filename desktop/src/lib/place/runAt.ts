// Starting the project's own command where the project is (AURA-1307).
//
// A run script is typed into a terminal. On this laptop the terminal opens in
// the project and the command is typed. On a machine the terminal still opens
// here — it is the same terminal tab, the same pty — but what gets typed into
// it first is the line that opens a shell on the box in the project's folder
// (the one `askBoot` answers with, the one door every remote terminal goes
// through), and the command is typed after it, so it lands in that shell.
//
// The pty's `shell` is a binary path, not a command line, which is why the
// boot line goes in as the first line of `bootCommand` rather than as the
// shell: `Terminal.tsx` types `bootCommand` once the pty is up, and a line
// typed ahead of a shell that is still connecting is read by the shell that
// arrives — the way a person typing quickly at a prompt is.

import { remotePlaceForRoot } from "../activeMachine";
import { askBoot, openShell } from "./boot";
import type { Place } from "./contract";

/** `s`, safe to paste into a POSIX shell as one word. */
export function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The lines to type, given the box's boot line: the boot line, then the
 *  command — with a `cd` into the launched worktree in front when the
 *  workspace lives in one, since the boot line lands in the machine's own
 *  checkout. Pure, so the shape is testable without a machine book. */
export function composeRemoteRun(
  bootLine: string,
  command: string,
  remoteRoot?: string | null,
): string {
  const there = remoteRoot?.trim();
  const run = there ? `cd ${shellWord(there)} && ${command}` : command;
  return `${bootLine.replace(/\n+$/, "")}\n${run}`;
}

/** What to type into a fresh terminal so `command` runs in `repoRoot` where
 *  it stands. On this laptop that is the command itself. On a machine it is
 *  the box's boot line followed by the command; a box that cannot be named
 *  is an error the caller shows — never a local run of a remote project's
 *  command, which would start the wrong thing on the wrong computer while
 *  looking like it worked. */
export async function bootCommandFor(repoRoot: string, command: string): Promise<string> {
  const at = remotePlaceForRoot(repoRoot);
  if (!at) return command;
  const place = {
    machineId: at.machineId,
    project: { root: at.repoRoot, path: null, branch: null },
  } as Place;
  const bootLine = await askBoot(place, openShell());
  return composeRemoteRun(bootLine, command, at.remoteRoot);
}
