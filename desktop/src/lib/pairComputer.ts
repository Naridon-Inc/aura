// Adding a computer somebody already has: a server, another computer, or the
// one the app is running on. Each call is one Tauri command
// (cmd_pair_computer.rs) over the signed-in token. The server decides who may
// add which kind and words every refusal; what is left here is the few
// sentences the screen says while it waits.

import { invoke } from "@tauri-apps/api/core";

/** `personal`: only the person who added it. `team`: everyone in the team. */
export type PairScope = "personal" | "team";

/** A fresh one-time code, from `POST /places/pair`. */
export type PairIssued = {
  id: string;
  code: string;
  scope: PairScope;
  expires_at: string;
  /** The one line to paste on the computer. */
  install: string;
  /** The same, for a computer that already has `aura`. */
  join: string;
};

export type PairState = "waiting" | "joining" | "connected" | "expired" | "removed";

/** What the computer said about itself when it joined. */
export type PairedComputer = {
  name: string;
  os: string | null;
  arch: string | null;
  cpus: number | null;
  memory_gb: number | null;
};

export type PairStatus = {
  id: string;
  scope: PairScope;
  state: PairState;
  expires_at: string;
  place_id: string | null;
  computer: PairedComputer | null;
};

/** What `aura join --json` said on this computer, plus the code it spent. */
export type JoinReport = {
  ok: boolean;
  state: "connected" | "already_connected" | "left" | "not_connected" | "refused" | "failed";
  message: string;
  org?: string;
  name?: string;
  place_id?: string;
  scope?: PairScope;
  service?: string;
  /** Whether Claude Code was found where the service will look for it. */
  agent_ready?: boolean;
  notes?: string[];
  pair_id: string;
};

export const pairComputerStart = (scope: PairScope) => invoke<PairIssued>("pair_computer_start", { scope });
export const pairComputerStatus = (id: string) => invoke<PairStatus>("pair_computer_status", { id });
export const pairComputerCancel = (id: string) => invoke<void>("pair_computer_cancel", { id });
/** Connects the computer the app runs on, for the signed-in person only. The
 *  code is made and spent on the Rust side; it never reaches this page. */
export const pairThisComputer = () => invoke<JoinReport>("pair_this_computer");

/** Nothing more will change without somebody doing something. */
export function settled(state: PairState): boolean {
  return state === "connected" || state === "expired" || state === "removed";
}

/** "Mo's server · 24 cores · 188 GB" — whatever the computer told us. */
export function computerLine(c: Pick<PairedComputer, "name" | "cpus" | "memory_gb">): string {
  const parts = [c.name.trim() || "Computer"];
  if (c.cpus && c.cpus > 0) parts.push(`${c.cpus} ${c.cpus === 1 ? "core" : "cores"}`);
  if (c.memory_gb && c.memory_gb > 0) parts.push(`${c.memory_gb} GB`);
  return parts.join(" · ");
}

/** The one line under the pasted command, for each state. */
export function waitingLine(state: PairState): string {
  switch (state) {
    case "waiting":
      return "Waiting for your computer…";
    case "joining":
      return "Your computer is connecting…";
    case "connected":
      return "Connected";
    case "expired":
      return "This line ran out before it was used.";
    case "removed":
      return "That computer was connected and has since been removed.";
  }
}

/** Minutes until the code runs out, rounded up; 0 once it has. */
export function minutesLeft(expiresAt: string, now: number = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 60_000));
}

/** What the screen says once this computer has been connected. Claude Code
 *  missing is the one thing a person must still do themselves. */
export function joinedNotes(r: JoinReport): string[] {
  const notes = r.notes ?? [];
  if (r.agent_ready === false && !notes.some((n) => /claude/i.test(n))) {
    return [...notes, "Install Claude Code on this computer so it can answer chats."];
  }
  return notes;
}
