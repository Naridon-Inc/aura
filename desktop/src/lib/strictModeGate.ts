// Strict-mode commit-time gate. The pre-commit hook is the source of
// truth and will block a commit that fails Intent Verification — but
// once you've already typed a commit message and clicked the button,
// the failure is jarring and the message is lost. This module gives
// the UI a chance to ask first: "we counted N tool_uses and 0 intents
// in this session — proceed anyway?".
//
// Heuristic: walk the agent stream's events for tool_uses that touch
// files (Edit, Write, MultiEdit), then walk the intent log filtered
// to this agent + a 30-minute window. Pair them. Anything unpaired is
// a candidate for the warning.
//
// We deliberately don't try to be precise — the hook is the source of
// truth. This is just a "look before you leap" surface.

import { api, type StreamEvent } from "./api";
import { basename } from "./paths";

const COMMIT_WINDOW_MS = 30 * 60 * 1000;
const PAIR_WINDOW_MS = 60_000;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export type StrictReadiness = {
  /** True when there are tool_uses that don't have a matching intent
   *  inside the session window. */
  needsAttention: boolean;
  /** Number of unpaired tool_uses. Drives the dialog copy. */
  unpaired: number;
  /** First few file paths that are missing intent — for the dialog
   *  body so the user can see what triggered the warning. */
  files: string[];
};

export async function checkStrictModeReadiness(
  repoRoot: string,
  events: StreamEvent[],
  agentId: string,
): Promise<StrictReadiness> {
  const now = Date.now();
  const cutoffMs = now - COMMIT_WINDOW_MS;

  type Tool = { id: string; file: string; ts: number };
  const tools: Tool[] = [];
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    if (!FILE_TOOLS.has(e.name)) continue;
    const file = extractFilePath(e.input);
    if (!file) continue;
    // The stream events don't carry their own ts — use a per-event
    // monotonic that puts every event "now or earlier". Good enough
    // for pairing.
    tools.push({ id: e.id, file, ts: now });
  }
  if (tools.length === 0) {
    return { needsAttention: false, unpaired: 0, files: [] };
  }

  let intentRows: { ts: number; agent: string; intent: string }[] = [];
  try {
    const all = await api.auraReadIntentLog(repoRoot);
    intentRows = all
      .filter(
        (r) => r.agent === agentId && (r.timestamp ?? 0) * 1000 >= cutoffMs,
      )
      .map((r) => ({
        ts: (r.timestamp ?? 0) * 1000,
        agent: r.agent,
        intent: r.intent ?? "",
      }));
  } catch {
    // Fail closed — if we can't read the log, treat everything as
    // unpaired so the dialog still nudges. The hook will give a real
    // answer.
  }

  const used = new Set<number>();
  const unpairedFiles: string[] = [];
  for (const t of tools) {
    const base = basename(t.file);
    let hit = false;
    for (let i = 0; i < intentRows.length; i++) {
      if (used.has(i)) continue;
      const r = intentRows[i];
      const within = Math.abs(r.ts - t.ts) <= PAIR_WINDOW_MS;
      const mentions = r.intent.includes(base);
      if (within || mentions) {
        used.add(i);
        hit = true;
        break;
      }
    }
    if (!hit) unpairedFiles.push(t.file);
  }

  const dedupFiles = Array.from(new Set(unpairedFiles));
  return {
    needsAttention: dedupFiles.length > 0,
    unpaired: dedupFiles.length,
    files: dedupFiles.slice(0, 5),
  };
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const fp = obj.file_path ?? obj.filePath ?? obj.path;
  return typeof fp === "string" ? fp : null;
}
