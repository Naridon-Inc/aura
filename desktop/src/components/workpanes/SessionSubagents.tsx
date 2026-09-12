// SessionSubagents — the Workers tab body of a session detail.
//
// It answers three questions about a session and nothing else: who else worked
// on this, what were they told to do, and what did they report back.
//
// # Why it is a tree and not a list
//
// A worker can spawn its own workers, and this repo's transcripts hold runs
// three deep. Printed flat, nine rows say "nine things happened here", which
// is the fact you already had from the file count. Nested, they say who
// answered to whom — and that is the shape of the session, the thing you open
// a session detail to see. So the indent is load-bearing, not decoration, and
// it comes from the tree we can actually see rather than from the depth a run
// reports about itself (see `chainOfCommand`).
//
// # Why the rows are this quiet
//
// The lane is scanned, not read: 311 runs have been recorded under one session
// here. So every fact keeps a fixed lane and the ink stays uniform, the same
// two rules the Workspaces board and the console's session roster are built
// on. The description carries the row, because it is the only field written in
// a person's — or the parent's — own words.
//
// The closing report is the exception. It is up to 4 KB, it cannot sit in a
// row, and truncating it to a sentence would throw away the only account the
// worker gave of its own work. So a row with a report opens, in place, and the
// rest of the run's facts come with it rather than crowding the row.

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitFork } from "lucide-react";

import { relativeAgeFromSecs } from "../../lib/relativeTime";
import {
  chainOfCommand,
  countRuns,
  nestedCount,
  type SubagentNode,
  type SubagentRun,
} from "./subagentRuns";

/** Left inset of a row at `depth`, in pixels. One step per level of command. */
function inset(depth: number): number {
  return 14 + depth * 18;
}

/** The identity to print when the parent wrote no description. The id is a
 *  hash, so only its head is worth the width — but it is a real answer, and it
 *  is the value that joins this run to the edits it made. */
function shortId(agentId: string): string {
  return agentId.length > 10 ? `${agentId.slice(0, 10)}…` : agentId;
}

export function SessionSubagents({ runs }: { runs: SubagentRun[] }) {
  const roots = useMemo(() => chainOfCommand(runs), [runs]);
  // One clock for the whole lane, so two rows written a second apart cannot
  // print ages that disagree about when "now" was.
  const now = useMemo(() => Date.now(), [runs]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = (agentId: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(agentId)) next.add(agentId);
      return next;
    });

  const total = countRuns(roots);
  const nested = nestedCount(roots);

  return (
    <div className="h-full overflow-y-auto">
      {/* The rollup, in the two numbers the record can stand behind: how many
          workers ran, and how many of those answered to another worker rather
          than to the session. */}
      <div className="border-b border-line-soft px-3.5 py-2 text-2xs text-text-4">
        {total} {total === 1 ? "worker" : "workers"}
        {nested > 0
          ? ` · ${nested} spawned by another worker`
          : " · all spawned by this session"}
      </div>

      <Branch nodes={roots} depth={0} now={now} open={open} onToggle={toggle} />
    </div>
  );
}

function Branch({
  nodes,
  depth,
  now,
  open,
  onToggle,
}: {
  nodes: SubagentNode[];
  depth: number;
  now: number;
  open: ReadonlySet<string>;
  onToggle: (agentId: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <Fragment key={node.run.agent_id}>
          <RunRow
            node={node}
            depth={depth}
            now={now}
            open={open.has(node.run.agent_id)}
            onToggle={() => onToggle(node.run.agent_id)}
          />
          {node.children.length > 0 ? (
            <Branch
              nodes={node.children}
              depth={depth + 1}
              now={now}
              open={open}
              onToggle={onToggle}
            />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

function RunRow({
  node,
  depth,
  now,
  open,
  onToggle,
}: {
  node: SubagentNode;
  depth: number;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const run = node.run;
  // Only a run that reported something has anything to reveal, so only that
  // row is a control. The rest are plain rows rather than buttons that open
  // onto nothing — the same rule the console's roster follows for a session
  // with no stored trace.
  const openable = Boolean(run.last_message);
  const age = relativeAgeFromSecs(run.last_write ?? 0, {
    now,
    style: "compact",
    empty: "",
  });

  const body = (
    <>
      {/* Disclosure, or the space one would occupy — kept even on a row that
          cannot open, so the description column starts in the same place all
          the way down. */}
      <span className="flex w-3.5 shrink-0 items-center text-text-4">
        {openable ? (
          open ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )
        ) : null}
      </span>

      {/* What kind of worker it was. Claude's own word for it. */}
      <span className="meta-tag font-mono" title={`Agent type: ${run.agent_type}`}>
        {run.agent_type}
      </span>

      {/* What it was told to do — the parent's own words, and the reason this
          lane is worth opening. A run whose parent wrote nothing falls back to
          its id, which is a real answer rather than an empty cell. */}
      <span className="min-w-0 flex-1 truncate text-base text-text-2" title={run.description}>
        {run.description || (
          <span className="font-mono text-text-4" title={run.agent_id}>
            {shortId(run.agent_id)}
          </span>
        )}
      </span>

      {/* The facts, each in a fixed lane. Every one of them is omitted rather
          than zeroed when the record does not carry it. */}
      {run.is_fork ? (
        <span className="meta-tag" title="A fork — it inherited the parent's context rather than starting fresh">
          <GitFork size={11} aria-hidden />
          fork
        </span>
      ) : null}
      {run.worktree_branch ? (
        <span className="meta-tag font-mono" title={`Worked in its own worktree on ${run.worktree_branch}`}>
          {run.worktree_branch}
        </span>
      ) : null}
      {run.files != null ? (
        <span className="shrink-0 text-2xs text-text-4">
          {run.files} {run.files === 1 ? "file" : "files"}
        </span>
      ) : null}
      <span className="w-[34px] shrink-0 text-right font-mono text-2xs tabular-nums text-text-4">
        {age}
      </span>
    </>
  );

  const className = "flex w-full items-center gap-2 py-2 pr-3.5 text-left";
  const style = { paddingLeft: inset(depth) };

  return (
    <div className="border-b border-line-soft">
      {openable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={`${className} hover:bg-state-hover`}
          style={style}
        >
          {body}
        </button>
      ) : (
        <div className={className} style={style} title="This worker recorded no closing report.">
          {body}
        </div>
      )}

      {open ? <RunReport node={node} depth={depth} /> : null}
    </div>
  );
}

/** What one worker reported back, plus the facts that were too small to earn a
 *  lane in the row. Shown only on demand — see the header note on why the
 *  report is never inlined or trimmed. */
function RunReport({ node, depth }: { node: SubagentNode; depth: number }) {
  const run = node.run;
  return (
    <div
      className="border-t border-line-soft bg-bg-2 py-2.5 pr-3.5"
      style={{ paddingLeft: inset(depth) + 20 }}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-text-4">
        <span className="font-mono" title="Claude's id for this run — the same id its edits were filed under">
          {run.agent_id}
        </span>
        {run.model ? <span>{run.model}</span> : null}
        <span>
          {run.spawn_depth === 1
            ? "spawned by this session"
            : `spawned ${run.spawn_depth} levels deep`}
        </span>
        {node.orphaned ? (
          // Said plainly rather than drawn: the row sits at the root because
          // the worker that spawned it has no record here, and pretending it
          // had no parent would be the wrong claim.
          <span title={`Spawned by ${run.parent_agent_id}, which has no record in this session`}>
            its parent has no record here
          </span>
        ) : null}
      </div>
      <div className="section-label mb-1">Reported back</div>
      <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-2">
        {run.last_message}
      </pre>
    </div>
  );
}
