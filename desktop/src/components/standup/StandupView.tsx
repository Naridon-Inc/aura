// Standup view — per-member daily rollup sourced from
// `.aura/intent_log.jsonl`, plus a period task summary from the Tasks
// board (`tasks_list`). Rendered as a full workpane tab (kind: "standup")
// and as a Settings → Team → Activity sub-pane, in the settings parts
// either way.
//
// "Post to #standup" publishes the rollup as a markdown digest to the
// team's `standup` channel via `chat_send` — real data, real send, no
// placeholder.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  api,
  type IntentEntry,
  type Task,
  type TeamManifest,
} from "../../lib/api";
import { fetchTasks } from "../../lib/tasksCache";
import { fetchTeam } from "../../lib/teamCache";
import { agentName } from "../../lib/agentNames";
import { cn } from "../../lib/utils";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { SettingsEmpty, SettingsError } from "../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import "../ui/standup.css";

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
          fetchTeam(repoRoot).catch(() => null),
          api
            .auraReadIntentLogV2(repoRoot, 500)
            .then((p) => p.entries ?? [])
            .catch(() => [] as IntentEntry[]),
          fetchTasks(repoRoot).catch(() => [] as Task[]),
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

  return (
    <div className={cn("ui-standup", embedded && "ui-standup-pane")}>
      <SettingsRow
        title={`Last ${DAYS_BACK} days`}
        description={`What each person and agent worked on, from the reasons they saved and the Tasks board. Post shares a written summary in #${STANDUP_CHANNEL}.`}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={posting || loading || empty}
            title={`Share this summary with the team in #${STANDUP_CHANNEL}`}
            onClick={() => void post()}
          >
            {posting ? "Posting…" : `Post to #${STANDUP_CHANNEL}`}
          </Button>
        }
      />
      {postNote &&
        (postNote.ok ? (
          <p className="ui-settings-status ui-standup-note" role="status">
            {postNote.text}
          </p>
        ) : (
          <SettingsError>{postNote.text}</SettingsError>
        ))}

      {loading && (
        <p className="ui-settings-status ui-standup-note" role="status">
          <AsciiSpinner /> Loading the week…
        </p>
      )}
      {err && <SettingsError>{err}</SettingsError>}
      {!loading && !err && <TasksSummary summary={taskSummary} />}
      {!loading && !err && empty && (
        <SettingsEmpty>
          Nothing happened in the last {DAYS_BACK} days. As soon as someone saves work or moves a
          task, it shows up here.
        </SettingsEmpty>
      )}
      {buckets.map((b) => (
        <DaySection key={b.date} bucket={b} knownMembers={team?.members ?? []} />
      ))}
    </div>
  );
}

// Period task rollup: completed-this-window with titles, plus live
// in-progress / in-review counts. Hidden entirely when there's nothing
// to show so it never draws an empty section.
function TasksSummary({ summary }: { summary: TaskSummary }) {
  const { completed, inProgress, inReview } = summary;
  if (completed.length === 0 && inProgress === 0 && inReview === 0) return null;
  const bits = [`${completed.length} completed`, `${inProgress} in progress`];
  if (inReview > 0) bits.push(`${inReview} in review`);
  return (
    <SettingsSection title="Tasks" description={bits.join(" · ")}>
      {completed.length > 0 && (
        <ul className="ui-standup-list">
          {completed.slice(0, 6).map((t) => (
            <li key={t.id} title={t.title}>
              <Check className="ui-standup-done" aria-label="Done" />
              {t.sequence_id > 0 && <span className="ui-standup-handle">AURA-{t.sequence_id}</span>}
              <span className="ui-standup-text">{t.title}</span>
            </li>
          ))}
          {completed.length > 6 && (
            <li className="ui-standup-more">{completed.length - 6} more</li>
          )}
        </ul>
      )}
    </SettingsSection>
  );
}

/** The name to print over a day's updates.
 *
 *  Three different things end up in this column and only one of them was
 *  handled. A teammate on the roster resolves to their name. An agent id —
 *  `claude`, `cli:gemini` — is a product, not a person, and belongs in the
 *  one table every other surface names agents from; printed raw it was a
 *  slug. And a row with nobody recorded printed the literal key "unknown",
 *  which is also what every row on this pane looked like for as long as the
 *  reader underneath was dropping `agent_id` on the floor. */
function authorDisplay(
  author: string,
  knownMembers: TeamManifest["members"],
): string {
  const member = knownMembers.find(
    (m) => m.email === author || m.handle === author,
  );
  if (member) return member.name || member.handle;
  // An address nobody on the roster claims is still the most recognisable
  // thing we hold for that person — more use than the title-cased local part
  // the agent table would reduce it to.
  if (author.includes("@")) return author;
  return agentName(author, { empty: "Not recorded", unknown: "Not recorded" });
}

/** A day the way people say it: Today, Yesterday, then the weekday and
 *  date. The bucket key is a local `YYYY-MM-DD`, so it is read as local. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function DaySection({
  bucket,
  knownMembers,
}: {
  bucket: DayBucket;
  knownMembers: TeamManifest["members"];
}) {
  const authors = Array.from(bucket.byAuthor.entries());
  const updates = authors.reduce((n, [, rows]) => n + rows.length, 0);
  return (
    <SettingsSection
      title={dayLabel(bucket.date)}
      description={`${updates} ${updates === 1 ? "update" : "updates"} from ${authors.length} ${authors.length === 1 ? "person or agent" : "people and agents"}`}
    >
      {authors.map(([author, rows]) => (
        <div key={author || "(none)"} className="ui-standup-author">
          <div className="ui-standup-author-head">
            <span>{authorDisplay(author, knownMembers)}</span>
            <small>
              {rows.length} {rows.length === 1 ? "update" : "updates"}
            </small>
          </div>
          <ul className="ui-standup-list">
            {rows.slice(0, 6).map((r) => (
              <li key={r.id} title={r.intent}>
                <span className="ui-standup-text">{r.intent}</span>
              </li>
            ))}
            {rows.length > 6 && <li className="ui-standup-more">{rows.length - 6} more</li>}
          </ul>
        </div>
      ))}
    </SettingsSection>
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
    // Keyed by the raw id, named later. "unknown" as a key is a word a
    // teammate could plausibly commit under, and it decided here what the
    // screen said, which put a made-up name beyond the reach of the roster.
    const author = e.agent || "";
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
  lines.push(`**Standup. Last ${days} days**`);
  const { completed, inProgress, inReview } = taskSummary;
  const bits = [`${completed.length} completed`, `${inProgress} in progress`];
  if (inReview > 0) bits.push(`${inReview} in review`);
  lines.push(`_Tasks: ${bits.join(" · ")}_`);
  lines.push("");
  for (const b of buckets) {
    lines.push(`**${b.date}**`);
    for (const [author, rows] of b.byAuthor.entries()) {
      // Same naming as the screen, off the same function: a digest that
      // named people differently from the pane it was built from would be
      // read as a second, disagreeing account of the same week.
      const display = authorDisplay(author, team?.members ?? []);
      lines.push(
        `- ${display} · ${rows.length} intent${rows.length === 1 ? "" : "s"}`,
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
