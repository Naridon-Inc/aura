// Which projects an Aura turn acted on, read from its own tool results.
//
// The brain stamps every project-scoped tool result with the project it ran
// against (manager/brain/project_plane.rs): a JSON result gains a `target`
// field, and a plain-text one ends with a single `aura-target: {…}` line. A
// fleet sweep instead names each project on its own row (`projects[].root`).
// This reads those back so the chat can show, under the turn, where it
// actually went — and link there.
//
// Only what the tools reported counts. A project merely mentioned in the
// prose is not a project the turn touched.

import type { ChatTurn, PersistedToolCall } from "./api";

export type TurnProject = {
  /** The project's label, as the brain resolved it. */
  label: string;
  /** The project's root on this computer. */
  root: string;
  /** A workspace inside it the turn made or named, when there was one. */
  workspace?: string;
};

/** Must match `project_plane::TARGET_MARKER`. */
const TARGET_MARKER = "aura-target: ";

type Raw = Record<string, unknown>;

function asProject(v: unknown): TurnProject | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Raw;
  const root = typeof o.root === "string" ? o.root.trim() : "";
  if (!root) return null;
  const label =
    typeof o.project === "string" && o.project.trim()
      ? o.project.trim()
      : root.split("/").filter(Boolean).pop() || root;
  const workspace =
    typeof o.workspace === "string" && o.workspace.trim() ? o.workspace.trim() : undefined;
  return workspace ? { label, root, workspace } : { label, root };
}

function fromMarker(text: string): TurnProject | null {
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (!last.startsWith(TARGET_MARKER)) return null;
  try {
    return asProject(JSON.parse(last.slice(TARGET_MARKER.length)));
  } catch {
    return null;
  }
}

/** The projects one tool call reports acting on. Errors report nothing: a
 *  call that was refused didn't act anywhere. */
export function projectsOfToolCall(call: PersistedToolCall): TurnProject[] {
  const res = call.result;
  if (!res || res.is_error || typeof res.content !== "string") return [];
  const text = res.content;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const marked = fromMarker(text);
    return marked ? [marked] : [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const o = parsed as Raw;
  const target = asProject(o.target);
  if (target) return [target];
  if (Array.isArray(o.projects)) {
    return o.projects.map(asProject).filter((p): p is TurnProject => p !== null);
  }
  return [];
}

/** Every project a turn's tool calls report, first-seen order, one per root.
 *  A workspace named by a later call is kept when an earlier one didn't. */
export function projectsTouchedByTurn(turn: Pick<ChatTurn, "tool_calls">): TurnProject[] {
  const byRoot = new Map<string, TurnProject>();
  for (const call of turn.tool_calls ?? []) {
    for (const p of projectsOfToolCall(call)) {
      const seen = byRoot.get(p.root);
      if (!seen) byRoot.set(p.root, p);
      else if (!seen.workspace && p.workspace) byRoot.set(p.root, { ...seen, workspace: p.workspace });
    }
  }
  return [...byRoot.values()];
}

/** The event a chip fires to go to a project (or a workspace in it). App
 *  listens for it; the chat doesn't need to know how the shell navigates. */
export const GO_PROJECT_EVENT = "aura:go-project";

export type GoProjectDetail = { root: string; workspace?: string };

export function goToTurnProject(p: TurnProject): void {
  window.dispatchEvent(
    new CustomEvent<GoProjectDetail>(GO_PROJECT_EVENT, {
      detail: p.workspace ? { root: p.root, workspace: p.workspace } : { root: p.root },
    }),
  );
}
