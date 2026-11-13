// What the Run panel offers for a workspace on one of the org's machines:
// the commands the box's own copy of the project justified, named the way a
// person would say them, and the session it last started there.
//
// Pure, so the naming and the remembering are testable without a machine.

import type { RunSuggestion } from "../../lib/api";
import type { CloudRunAction } from "../ui/cloud-run-panel";

const word = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The name a detected command goes by: the script it came from
 *  (`package.json · dev` is Dev), else the command itself. */
function nameOf(source: string, command: string): string {
  const tail = source.split("·").pop()?.trim() ?? "";
  return source.includes("·") && tail ? word(tail) : command;
}

/** The commands the panel offers, the one detection chose first. Empty when
 *  nothing in the checkout said how to run it — the panel says so rather
 *  than guessing `npm run dev`. */
export function runActions(found: RunSuggestion | null): CloudRunAction[] {
  if (!found) return [];
  const out: CloudRunAction[] = [];
  const seen = new Set<string>();
  const add = (name: string, command: string, detail?: string) => {
    if (out.some((a) => a.command === command)) return;
    const unique = seen.has(name.toLowerCase()) ? `${name} (${command})` : name;
    seen.add(unique.toLowerCase());
    out.push({ name: unique, command, ...(detail ? { detail } : {}) });
  };
  const first = found.command?.trim();
  const chosen = first ? found.candidates.find((c) => c.command === first) : undefined;
  if (first) add(chosen ? nameOf(chosen.source, first) : "Run", first, chosen?.source);
  for (const c of found.candidates) add(nameOf(c.source, c.command), c.command, c.source);
  return out;
}

/** The session the panel started on a machine, as this window remembers it:
 *  only its name and command. The box decides whether it is still there. */
export type RunMemory = { session: string; command: string };

/** Where one worktree's memory is kept. */
export function runMemoryKey(machineId: string, remoteRoot: string): string {
  return `aura.cloud.run:${machineId}:${remoteRoot}`;
}

/** A remembered run, or null for anything else the slot holds. */
export function readRunMemory(raw: string | null): RunMemory | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RunMemory>;
    return typeof v.session === "string" && v.session && typeof v.command === "string"
      ? { session: v.session, command: v.command }
      : null;
  } catch {
    return null;
  }
}
