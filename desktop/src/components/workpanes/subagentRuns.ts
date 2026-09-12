// Who else worked on a session — the reader's half of `aura-cli/src/subagents`.
//
// An agent that fans work out to sub-agents is the normal shape of a long
// session now. Every file one of those workers edits already reached Aura,
// because the post-tool-use hook fires inside a sub-agent exactly as it does
// on the main thread — but until the CLI half shipped it reached us anonymous,
// filed under the parent as though the parent had typed it. Twenty files
// changed, one session, and no answer to "which of the nine things running did
// this". The CLI now pushes one row per finished worker; this module is what
// turns those rows back into the chain of command they came from.
//
// # Two things live here and nothing else
//
//  • **The route, written once.** Both apps read the same endpoint over
//    different transports — the desktop with the cloud bearer it holds in
//    Rust, the console with the one in its own store — and a route spelled
//    twice is a route that gets corrected once.
//  • **The tree.** `parent_agent_id` and `spawn_depth` describe a tree, and a
//    flat list of nine rows loses the single thing this feature exists to
//    show. Kept pure and away from React so the shapes below can be tested as
//    the rules they are.
//
// Nothing here invents a value. A field the server did not send is `null`, and
// `null` is not zero: a worker whose file count nobody counted must print no
// number at all rather than a "0 files" that says it touched nothing.

/** One sub-agent run, as the cloud stores it.
 *
 *  The field names are `Run::to_json`'s — one shape on the wire, so a field
 *  can never mean one thing in the CLI and another on screen. */
export type SubagentRun = {
  /** Claude's own id for the worker. The join key: an intent row logged
   *  mid-run carries the same value. */
  agent_id: string;
  /** `Explore`, `general-purpose`, `fork`, or a name from the project's own
   *  `.claude/agents/`. `subagent` when an older Claude wrote no sidecar. */
  agent_type: string;
  /** The one-line description the parent wrote when it spawned the worker —
   *  the only place the *purpose* of a run is written in the parent's words. */
  description: string;
  /** 1 for a worker the session itself spawned, 2 for one spawned by a
   *  worker. Reported by the run; the lane indents by the tree it can
   *  actually see (see `chainOfCommand`). */
  spawn_depth: number;
  /** A fork inherits the parent's context instead of starting fresh, which
   *  changes how its report should be read — it is a continuation, not an
   *  answer to a brief. */
  is_fork: boolean;
  /** The worker that spawned this one, when it was not the main thread. */
  parent_agent_id: string | null;
  model: string | null;
  /** Set when the run was given its own git worktree, so its commits can be
   *  found later. */
  worktree_branch: string | null;
  /** Unix seconds of the run's last file write. */
  last_write: number | null;
  /** What the worker reported back when it stopped, bounded to 4 KB by the
   *  hook that pushed it. Too long to sit in a row, which is why the lane
   *  makes it openable rather than truncating it to a sentence. */
  last_message: string | null;
  /** How many files this worker's own edits reached, when the server counted
   *  them. Null means nobody counted — the lane prints nothing rather than a
   *  zero that would claim the worker changed nothing. */
  files: number | null;
};

/** The mount the session endpoints answer on. The console's client already
 *  defaults to it, so only the desktop, which builds an absolute URL, spells
 *  it out. */
export const SUBAGENT_RUNS_MOUNT = "/api/v2";

/**
 * Where a session's runs are read from, relative to the mount.
 *
 * The write and the read are not the same address. The CLI pushes a finished
 * run to `/subagent-runs` — a run is its own thing and arrives before anyone
 * has asked for it — but reading is always "the workers on this session", so
 * the server hangs it off the session: `/sessions/{id}/subagents`. Deliberate
 * on the server's side, because a run can land before its session row is
 * synthesised and the read still has to answer.
 *
 * Spelled once so a rename is one line. A wrong path answers 404, and a 404 is
 * already "we don't know about any sub-agents here", so nothing downstream
 * misreports while the two halves are catching up with each other.
 */
export function subagentRunsPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/subagents`;
}

/**
 * What the reader knows about a session's sub-agents.
 *
 * The distinction is the whole point. "We asked and there were none" and "we
 * could not ask" look identical if you collapse them into an empty array, and
 * every server deployed today answers the second — so an empty lane would tell
 * a person that a session they watched fan out nine ways did all the work
 * itself. `known: false` is a shrug, and a shrug renders as nothing at all.
 */
export type SubagentRuns =
  | { known: false }
  | { known: true; runs: SubagentRun[] };

/** The shrug, as a value — shared so every "we don't know" is the same one. */
export const UNKNOWN_RUNS: SubagentRuns = { known: false };

// ─── reading the wire ───────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  // The list may arrive bare or wrapped. Both spellings the server could
  // reasonably pick are read, because the alternative to reading them is a
  // silent empty lane — and an empty lane is the one thing this module exists
  // to never render by accident.
  const o = body as Record<string, unknown>;
  for (const key of ["runs", "subagent_runs", "subagents"]) {
    if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  return [];
}

/**
 * The runs in a response body, or an empty list if it carried none.
 *
 * Tolerant on purpose: a row missing its `agent_id` is the one thing that
 * cannot be rendered (it is the identity and the join key), so that row is
 * dropped. Everything else falls back the way the CLI's own reader does — an
 * unknown type is `subagent`, an unstated depth is 1, an absent parent means
 * the session spawned it.
 */
export function parseSubagentRuns(body: unknown): SubagentRun[] {
  const out: SubagentRun[] = [];
  for (const raw of rows(body)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const agentId = str(r.agent_id);
    if (!agentId) continue;
    out.push({
      agent_id: agentId,
      agent_type: str(r.agent_type) ?? "subagent",
      description: str(r.description) ?? "",
      spawn_depth: num(r.spawn_depth) ?? 1,
      is_fork: r.is_fork === true,
      parent_agent_id: str(r.parent_agent_id),
      model: str(r.model),
      worktree_branch: str(r.worktree_branch),
      last_write: num(r.last_write),
      last_message: str(r.last_message),
      // The count is the server half's to add, and it is being written beside
      // this one. Both plain spellings are read so a name that lands slightly
      // differently shows the number instead of quietly dropping it; neither
      // present means null, which prints nothing.
      files: num(r.files) ?? num(r.file_count),
    });
  }
  return out;
}

// ─── the chain of command ───────────────────────────────────────────────────

/** One run and the runs it spawned. */
export type SubagentNode = {
  run: SubagentRun;
  children: SubagentNode[];
  /** The run named a parent, and no run with that id is in this set — the
   *  parent's own record never arrived, or it is not a worker at all. It sits
   *  at the root so the work stays visible, and says so rather than being
   *  indented under nothing. */
  orphaned: boolean;
};

/** `last_write` first, oldest to newest, then id. The CLI's own order, so the
 *  lane and `aura subagents` list a session's workers the same way round. A
 *  run with no recorded write sorts first, matching Rust's `None < Some`. */
function byRunOrder(a: SubagentNode, b: SubagentNode): number {
  const at = a.run.last_write ?? -Infinity;
  const bt = b.run.last_write ?? -Infinity;
  if (at !== bt) return at - bt;
  return a.run.agent_id < b.run.agent_id ? -1 : a.run.agent_id > b.run.agent_id ? 1 : 0;
}

/** Walking up from `from`, do we reach `target`? Guards the parent links
 *  against a cycle: ids come off a wire, and a run adopted as its own
 *  ancestor would hang the render rather than draw a wrong tree. */
function reaches(
  from: SubagentNode,
  target: SubagentNode,
  nodes: Map<string, SubagentNode>,
): boolean {
  const seen = new Set<string>();
  let at: SubagentNode | undefined = from;
  while (at) {
    if (at === target) return true;
    if (seen.has(at.run.agent_id)) return true;
    seen.add(at.run.agent_id);
    const parentId: string | null = at.run.parent_agent_id;
    at = parentId ? nodes.get(parentId) : undefined;
  }
  return false;
}

/**
 * The runs as the tree they were spawned as, roots first.
 *
 * A worker that spawned its own workers has to read as nested — that is the
 * one thing a flat list of nine rows cannot say, and the reason this feature
 * exists. Three cases the wire can hand us, and none of them may lose a run:
 *
 *  • **A parent we hold** — the run nests under it.
 *  • **A parent we do not hold** — a partial push, a run still in flight, a
 *    session read mid-fan-out. The run becomes a root, flagged `orphaned`, and
 *    is *not* indented by its own `spawn_depth`: indenting a run under a
 *    parent that is not on screen draws a level nobody can account for.
 *  • **A cycle** — impossible from Claude and cheap to survive; the run
 *    becomes a root rather than hanging the walk.
 *
 * Duplicate ids collapse to the first seen, because a second row for one
 * worker is one worker, not two.
 */
export function chainOfCommand(runs: SubagentRun[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();
  for (const run of runs) {
    if (!run.agent_id || nodes.has(run.agent_id)) continue;
    nodes.set(run.agent_id, { run, children: [], orphaned: false });
  }

  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.run.parent_agent_id;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (!parent || parent === node || reaches(parent, node, nodes)) {
      node.orphaned = Boolean(parentId);
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  roots.sort(byRunOrder);
  for (const node of nodes.values()) node.children.sort(byRunOrder);
  return roots;
}

/** Every run in the tree. Counted from the tree rather than from the list it
 *  was built out of, so a duplicated row cannot inflate the header line above
 *  the number of rows the reader can actually see. */
export function countRuns(roots: SubagentNode[]): number {
  let n = 0;
  for (const node of roots) n += 1 + countRuns(node.children);
  return n;
}

/** How many of them were spawned by another worker rather than by the session
 *  — the honest number behind "3 of them were spawned by another worker". */
export function nestedCount(roots: SubagentNode[]): number {
  return Math.max(0, countRuns(roots) - roots.length);
}
