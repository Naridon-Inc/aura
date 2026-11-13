// CommitList — the left rail of the History tab: a selectable list of the
// project's saved versions, newest first, each row carrying its branch / tag /
// "you are here" badges so the shape of history reads at a glance. Selection
// drives the detail pane on the right (the commit's intent story), so this is a
// quiet master list, not the lane-graph renderer (that lives in CommitGraph,
// which dispatches global events instead of driving an in-surface selection).

import { GitCommitHorizontal } from "lucide-react";

import { type GraphCommit, type GraphRef } from "../../lib/api";
import { monogram } from "../../lib/monogram";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { shortDateFromSecs } from "../../lib/calendarDate";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { EmptyState, LoadingState } from "../ui/state";
import { TraceList, TraceMark, TraceRow } from "../ui/trace-list";
import "../ui/commit-list.css";

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
    return <LoadingState label="Reading the repository’s story…" className="ui-commit-list-state" />;
  }
  if (commits.length === 0) {
    return (
      <EmptyState
        icon={GitCommitHorizontal}
        size="sm"
        title="No saved versions yet"
        body="Once you save your first version, the repository’s story shows up here."
        className="ui-commit-list-empty"
      />
    );
  }
  return (
    <TraceList label="Saved versions" className="ui-commit-list">
      {commits.map((c, i) => (
        <CommitRow
          key={c.sha}
          commit={c}
          index={i}
          active={selected === c.sha}
          onClick={() => onSelect(c.sha)}
        />
      ))}
    </TraceList>
  );
}

function CommitRow({
  commit,
  index,
  active,
  onClick,
}: {
  commit: GraphCommit;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const when = relTime(commit.timestamp);
  return (
    <TraceRow
      index={index}
      active={active}
      onOpen={onClick}
      icon={
        <Avatar className="ui-commit-list-avatar" title={commit.author}>
          <AvatarFallback>{monogram(commit.author, { empty: "·" })}</AvatarFallback>
        </Avatar>
      }
      title={commit.subject || "(no message)"}
      marks={
        commit.refs.length > 0
          ? commit.refs.map((r, i) => <RefMark key={i} name={r.name} kind={r.kind} />)
          : undefined
      }
      where={<code>{commit.short}</code>}
      whereTitle={commit.sha}
      time={when}
      timeTitle={commit.timestamp ? new Date(commit.timestamp * 1000).toLocaleString() : undefined}
      preview={{
        meta: (
          <>
            <code>{commit.short}</code>
            <span>{commit.author}</span>
            {when && <span>{when}</span>}
          </>
        ),
        title: commit.subject || "(no message)",
        footer:
          commit.refs.length > 0 ? (
            <span className="ui-commit-list-refs">
              {commit.refs.map((r, i) => (
                <RefMark key={i} name={r.name} kind={r.kind} />
              ))}
            </span>
          ) : undefined,
      }}
    />
  );
}

/** Branch tip / tag / HEAD mark. HEAD ("You are here") is the one
 *  orientation cue that earns a colour; tags and branches are categories, so
 *  they stay quiet. A copy on the server is quieter still. */
function RefMark({ name, kind }: { name: string; kind: GraphRef["kind"] }) {
  if (kind === "head") {
    return (
      <TraceMark tone="good" title="You are here. The version you’re working from">
        <span className="ui-commit-list-here" aria-hidden />
        {name}
      </TraceMark>
    );
  }
  if (kind === "tag") {
    return <TraceMark title="A named release point">⌖ {name}</TraceMark>;
  }
  return (
    <span className="ui-commit-list-ref" data-remote={kind === "remote" ? "" : undefined}>
      <TraceMark title={kind === "remote" ? "A copy that lives on the server" : "A branch"}>
        {name}
      </TraceMark>
    </span>
  );
}

function relTime(secs: number): string {
  if (!secs) return "";
  // Past a month a commit is history, not news — the date is the useful fact.
  // One ladder for the whole app — see lib/relativeTime.
  const d = Math.floor(Date.now() / 1000) - secs;
  if (d >= 2592000) return shortDateFromSecs(secs);
  return relativeAgeFromDelta(d);
}
