// Words for the cloud machine page: what each machine is doing, which agent a
// job went to and where that job has got to. Every label here is the plain
// version of a registry or task enum — the page never shows the raw value.

import type { CloudRunner } from "../../../lib/api";
import { relativeTime } from "./crewShared";

// The agents you can hand cloud work to. Kept to the three most common so the
// picker stays a glance, not a menu; the value is the bare provider id the
// backend namespaces as `a2a:<agent>`.
export type CloudAgent = "claude" | "codex" | "gemini";
export const AGENT_OPTIONS: Array<{ value: CloudAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

// One job the page handed to the cloud in this session. We keep our own list
// (rather than inventing a "cloud tasks" feed we can't truthfully populate)
// because the cloud task id + status come straight back from `loopCloudSend` —
// so every row is a real thing we really sent.
export type SentJob = {
  id: string;
  status: string;
  text: string;
  agent: CloudAgent;
  at: number;
  /** The runner's reason, once it reports one. A job that failed and said why
   *  is the single most useful row on this page — it's usually one command
   *  away from fixed. */
  reason?: string | null;
};

/** Statuses a job can't move on from. Anything else is still worth re-reading. */
export const TERMINAL = new Set(["completed", "done", "failed", "canceled", "rejected"]);

/** The detail line under a machine's name: what it's doing, which agents it can
 *  run, and when it last spoke. Every part is dropped when the registry doesn't
 *  know it, so a box that has only just registered says less rather than
 *  padding the line with "unknown". */
export function machineLine(r: CloudRunner): string {
  const bits: string[] = [blockedNote(r) ?? runnerStatusLabel(r.status)];
  if (r.agent_kinds.length > 0) bits.push(r.agent_kinds.map(agentLabel).join(", "));
  if (r.version) bits.push(`Aura ${r.version}`);
  const beat = r.last_heartbeat_at ? Date.parse(r.last_heartbeat_at) : NaN;
  if (Number.isFinite(beat)) bits.push(`seen ${relativeTime(beat)}`);
  return bits.join(" · ");
}

/** A machine that is up but can't sign its agent in.
 *
 *  This is the worst row the board can show, because every honest signal on it
 *  is green: the box registered, it heartbeats, it reports `idle`. It then
 *  fails every job it claims with "Not logged in", and that sentence lands on
 *  the task row where nobody connects it to the machine that caused it.
 *
 *  The runner checks before it claims anything and reports the reason on each
 *  beat (`runner_creds::auth_for`). There is no field for it — the registry
 *  stores status, task and version — so it rides in on `current_task` behind a
 *  lead phrase both sides agree on (`AUTH_NOTE_LEAD` in `runner.rs`). When it's
 *  there it isn't a detail about the status; it *is* the status. */
export function blockedNote(r: CloudRunner): string | null {
  const note = (r.current_task ?? "").trim();
  return note.startsWith("Needs sign-in") ? note : null;
}

/** `idle`/`busy` are the registry's words; nobody outside the code says them. */
export function runnerStatusLabel(status: string): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "busy":
    case "working":
      return "Working";
    case "offline":
      return "Offline";
    default:
      return status || "Ready";
  }
}

/** Provider id → the name the product uses for it. */
export function agentLabel(kind: string): string {
  const known = AGENT_OPTIONS.find((o) => o.value === kind);
  return known ? known.label : kind;
}

/** Plain-language label for a cloud task's lifecycle — never the raw enum. */
export function statusLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "Waiting for the machine";
    case "working":
    case "in_progress":
      return "Being worked on";
    case "completed":
    case "done":
      return "Finished";
    case "failed":
      return "Hit a problem";
    default:
      return status || "Sent";
  }
}
