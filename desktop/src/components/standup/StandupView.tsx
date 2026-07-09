// Standup view — per-member daily rollup sourced from
// `.aura/intent_log.jsonl`, plus a period task summary from the Tasks
// board (`tasks_list`). Rendered as a full workpane tab (kind: "standup")
// and as a Settings → Team → Activity sub-pane.
//
// "Post to #standup" publishes the rollup as a markdown digest to the
// team's `standup` channel via `chat_send` — real data, real send, no
// placeholder.

import { useEffect, useState } from "react";
import {
  api,
  type IntentEntry,
  type Task,
  type TeamManifest,
} from "../../lib/api";

type Props = {
  repoRoot: string;
  /** When true, the view is embedded in a workpane tab (no chrome). */
  embedded?: boolean;
};

type DayBucket = {
  date: string; // YYYY-MM-DD
  byAuthor: Map<string, IntentEntry[]>;
};

type TaskSummary = {
  completed: Task[]; // status done, updated within the window
  inProgress: number;
  inReview: number;
};

const DAYS_BACK = 7;
const STANDUP_CHANNEL = "standup";

export function StandupView({ repoRoot, embedded = false }: Props) {
  const [team, setTeam] = useState<TeamManifest | null>(null);
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postNote, setPostNote] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const [t, entries, taskRows] = await Promise.all([
          api.teamLoad(repoRoot).catch(() => null),
          api
            .auraReadIntentLogV2(repoRoot, 500)
            .then((p) => p.entries ?? [])
            .catch(() => [] as IntentEntry[]),
          api.tasksList(repoRoot).catch(() => [] as Task[]),
        ]);
        if (cancelled) return;
        setTeam(t);
        setIntents(entries);
        setTasks(taskRows);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const buckets = bucketByDay(intents, DAYS_BACK);
  const taskSummary = summarizeTasks(tasks, DAYS_BACK);
  const empty =
    buckets.length === 0 &&
    taskSummary.completed.length === 0 &&
    taskSummary.inProgress === 0 &&
    taskSummary.inReview === 0;

  const post = async () => {
    setPosting(true);
    setPostNote(null);
    try {
      const body = buildDigest(buckets, taskSummary, team, DAYS_BACK);
      await api.chatSend({ repoRoot, channel: STANDUP_CHANNEL, body });
      setPostNote({ ok: true, text: `Posted to #${STANDUP_CHANNEL}` });
    } catch (e) {
      setPostNote({ ok: false, text: String(e) });
    } finally {
      setPosting(false);
    }
  };

  const root = embedded
    ? "h-full w-full flex flex-col bg-bg-content"
    : "flex flex-col bg-bg-content rounded border border-line max-h-[80vh]";

  return (
    <div className={root}>
      <div className="px-4 py-3 border-b border-line-soft flex items-center gap-3">
        <h2 className="text-[14px] font-medium text-text-1">Standup</h2>
        <span className="text-[11px] text-text-3">
          Last {DAYS_BACK} days · per-member rollup
        </span>
        <div className="ml-auto flex items-center gap-2">
          {postNote && (
            <span
              className="text-[11px]"
              style={{
                color: postNote.ok ? "var(--color-green)" : "var(--color-red)",
              }}
            >
              {postNote.text}
            </span>
          )}
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded bg-bg-2 hover:bg-bg-3 text-text-2 disabled:opacity-50"
            disabled={posting || loading || empty}
            title={`Publish this rollup to the team's #${STANDUP_CHANNEL} channel`}
            onClick={() => void post()}
          >
            {posting ? "Posting…" : `Post to #${STANDUP_CHANNEL}`}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="text-[12px] text-text-3">Loading rollup…</div>
        )}
        {err && (
          <div
            className="text-[11px] px-2 py-1 rounded"
            style={{
              background: "color-mix(in oklab, var(--color-red) 12%, transparent)",
              color: "var(--color-red)",
            }}
          >
            {err}
          </div>
        )}
        {!loading && !err && (
          <TasksSummaryCard summary={taskSummary} days={DAYS_BACK} />
        )}
        {!loading && !err && empty && (
          <div className="text-[12px] text-text-3">
            No intent entries or task activity in the last {DAYS_BACK} days.
            Activity will appear here once team members log intent or move
            tasks.
          </div>
        )}
        {buckets.map((b) => (
          <DaySection
            key={b.date}
            bucket={b}
            knownMembers={team?.members ?? []}
          />
        ))}
      </div>

      <div className="px-4 py-2 border-t border-line-soft text-[10.5px] text-text-4">
        Sourced from the intent log + Tasks board. Post publishes a markdown
        digest to #{STANDUP_CHANNEL}.
      </div>
    </div>
  );
}

// Period task rollup: completed-this-window with titles, plus live
// in-progress / in-review counts. Hidden entirely when there's nothing
// to show so it never renders an empty card.
function TasksSummaryCard({
  summary,
  days,
}: {
  summary: TaskSummary;
  days: number;
}) {
  const { completed, inProgress, inReview } = summary;
  if (completed.length === 0 && inProgress === 0 && inReview === 0) return null;
  const bits = [
    `${completed.length} completed`,
    `${inProgress} in progress`,
  ];
  if (inReview > 0) bits.push(`${inReview} in review`);
  return (
    <section className="border border-line-soft rounded px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[12px] font-medium text-text-1">Tasks</span>
        <span className="text-[10.5px] text-text-4">
          last {days}d · {bits.join(" · ")}
        </span>
      </div>
      {completed.length > 0 && (
        <ul className="space-y-0.5">
          {completed.slice(0, 6).map((t) => (
            <li
              key={t.id}
              className="text-[11.5px] text-text-2 truncate"
              title={t.title}
            >
              <span className="text-green">✓</span>{" "}
              {t.sequence_id > 0 && (
                <span className="text-text-4 tabular-nums">
                  AURA-{t.sequence_id}{" "}
                </span>
              )}
              {t.title}
            </li>
          ))}
          {completed.length > 6 && (
            <li className="text-[10.5px] text-text-4">
              +{completed.length - 6} more…
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function DaySection({
  bucket,
  knownMembers,
}: {
  bucket: DayBucket;
  knownMembers: TeamManifest["members"];
}) {
  return (
    <section>
      <div className="text-[11px] uppercase tracking-wider text-text-4 mb-1.5">
        {bucket.date}
      </div>
      <div className="space-y-2">
        {Array.from(bucket.byAuthor.entries()).map(([author, rows]) => {
          const member = knownMembers.find(
            (m) => m.email === author || m.handle === author,
          );
          const display = member?.name || member?.handle || author;
          return (
            <div
              key={author}
              className="border border-line-soft rounded px-3 py-2"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-medium text-text-1">
                  {display}
                </span>
                <span className="text-[10.5px] text-text-4 tabular-nums">
                  {rows.length} intent{rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="space-y-0.5">
                {rows.slice(0, 6).map((r) => (
                  <li
                    key={r.id}
                    className="text-[11.5px] text-text-2 truncate"
                    title={r.intent}
                  >
                    · {r.intent}
                  </li>
                ))}
                {rows.length > 6 && (
                  <li className="text-[10.5px] text-text-4">
                    +{rows.length - 6} more…
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function bucketByDay(intents: IntentEntry[], days: number): DayBucket[] {
  const map = new Map<string, DayBucket>();
  const cutoff = Date.now() / 1000 - days * 86400;
  for (const e of intents) {
    if (e.timestamp < cutoff) continue;
    const d = new Date(e.timestamp * 1000);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { date: key, byAuthor: new Map() };
      map.set(key, bucket);
    }
    const author = e.agent || "unknown";
    const arr = bucket.byAuthor.get(author) ?? [];
    arr.push(e);
    bucket.byAuthor.set(author, arr);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
}

// Completed = done + updated inside the window (newest first); the
// in-progress / in-review counts are a live snapshot of the board.
function summarizeTasks(tasks: Task[], days: number): TaskSummary {
  const cutoff = Date.now() - days * 86400 * 1000;
  const completed: Task[] = [];
  let inProgress = 0;
  let inReview = 0;
  for (const t of tasks) {
    if (t.status === "in_progress") inProgress++;
    else if (t.status === "in_review") inReview++;
    if (t.status === "done") {
      const ts = Date.parse(t.updated_at);
      if (!Number.isNaN(ts) && ts >= cutoff) completed.push(t);
    }
  }
  completed.sort(
    (a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0),
  );
  return { completed, inProgress, inReview };
}

// Markdown digest posted to #standup. Mirrors the on-screen rollup: a
// task headline line, then per-day per-author intents.
function buildDigest(
  buckets: DayBucket[],
  taskSummary: TaskSummary,
  team: TeamManifest | null,
  days: number,
): string {
  const lines: string[] = [];
  lines.push(`**Standup — last ${days} days**`);
  const { completed, inProgress, inReview } = taskSummary;
  const bits = [`${completed.length} completed`, `${inProgress} in progress`];
  if (inReview > 0) bits.push(`${inReview} in review`);
  lines.push(`_Tasks: ${bits.join(" · ")}_`);
  lines.push("");
  for (const b of buckets) {
    lines.push(`**${b.date}**`);
    for (const [author, rows] of b.byAuthor.entries()) {
      const member = (team?.members ?? []).find(
        (m) => m.email === author || m.handle === author,
      );
      const display = member?.name || member?.handle || author;
      lines.push(
        `- ${display} — ${rows.length} intent${rows.length === 1 ? "" : "s"}`,
      );
      for (const r of rows.slice(0, 6)) lines.push(`  - ${r.intent}`);
      if (rows.length > 6) lines.push(`  - +${rows.length - 6} more…`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
