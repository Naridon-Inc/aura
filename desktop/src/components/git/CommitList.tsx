// CommitList — the left rail of the History tab: a selectable list of the
// project's saved versions, newest first, each row carrying its branch / tag /
// "you are here" badges so the shape of history reads at a glance. Selection
// drives the detail pane on the right (the commit's intent story), so this is a
// quiet master list, not the lane-graph renderer (that lives in CommitGraph,
// which dispatches global events instead of driving an in-surface selection).

import { type GraphCommit, type GraphRef } from "../../lib/api";
import { Avatar } from "../team/presentation/Avatar";

export function CommitList({
  commits,
  selected,
  loading,
  onSelect,
}: {
  commits: GraphCommit[];
  selected: string | null;
  loading: boolean;
  onSelect: (sha: string) => void;
}) {
  if (loading && commits.length === 0) {
    return <div className="px-3.5 py-3 text-[11.5px] text-text-4">Loading history…</div>;
  }
  if (commits.length === 0) {
    return (
      <div className="px-3.5 py-6 text-[11.5px] leading-relaxed text-text-4">
        No saved versions yet. Once you save your first version, the project’s
        story shows up here.
      </div>
    );
  }
  return (
    <div className="py-1">
      {commits.map((c) => (
        <CommitRow
          key={c.sha}
          commit={c}
          active={selected === c.sha}
          onClick={() => onSelect(c.sha)}
        />
      ))}
    </div>
  );
}

function CommitRow({
  commit,
  active,
  onClick,
}: {
  commit: GraphCommit;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors ${
        active ? "bg-bg-2" : "hover:bg-bg-2/60"
      }`}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full"
          style={{ background: "var(--color-accent)" }}
          aria-hidden
        />
      )}
      <Avatar name={commit.author} size={22} title={commit.author} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          {commit.refs.map((r, i) => (
            <RefBadge key={i} name={r.name} kind={r.kind} />
          ))}
          <span className="truncate text-[12.5px] text-text-1">
            {commit.subject || "(no message)"}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-4">
          <span className="font-mono text-text-3">{commit.short}</span>
          <span>·</span>
          <span className="truncate">{commit.author}</span>
          <span>·</span>
          <span className="tabular-nums">{relTime(commit.timestamp)}</span>
        </span>
      </span>
    </button>
  );
}

/** Branch tip / tag / HEAD pill — HEAD ("You are here") leads in arctic-blue,
 *  tags amber, remote dim, local outlined. Mirrors the graph's badge language
 *  so the two history views read identically. */
function RefBadge({ name, kind }: { name: string; kind: GraphRef["kind"] }) {
  if (kind === "head") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[9.5px] font-medium leading-[15px] text-white"
        style={{ background: "var(--color-accent)" }}
        title="You are here — the version you’re working from"
      >
        <span className="inline-block h-1 w-1 rounded-full bg-white" />
        {name}
      </span>
    );
  }
  if (kind === "tag") {
    return (
      <span
        className="inline-flex shrink-0 items-center rounded px-1.5 text-[9.5px] leading-[15px]"
        style={{ background: "rgba(245,158,11,0.14)", color: "#f59e0b" }}
        title="A named release point"
      >
        ⌖ {name}
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-1.5 text-[9.5px] leading-[15px] text-text-3"
      style={{ borderColor: "var(--color-line-soft)", opacity: kind === "remote" ? 0.7 : 1 }}
      title={kind === "remote" ? "A copy that lives on the server" : "A branch"}
    >
      {name}
    </span>
  );
}

function relTime(secs: number): string {
  if (!secs) return "";
  const d = Math.floor(Date.now() / 1000) - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  if (d < 2592000) return `${Math.floor(d / 604800)}w ago`;
  return new Date(secs * 1000).toLocaleDateString();
}
