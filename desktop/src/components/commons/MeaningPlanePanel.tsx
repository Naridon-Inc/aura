// MeaningPlanePanel — the calm, read-only home for Aura's portable
// "why + proof" record (M4, sovereign substrate). For our non-engineer
// audience the promise is simple: every change here carries the reason it was
// made, and Aura checks whether what was promised actually happened — and
// because that record travels with the repo on ANY git host, it stays
// verifiable on this very copy you cloned. No terminal, no jargon.
//
// Two reads on mount:
//   • `metaPlaneVerify` → the top banner ("Verified on this clone", or "N
//     things need a look").
//   • `metaPlaneLog`    → the recent commits, told day by day on Trace's
//     story timeline: each change, the newest reason it was made, and whether
//     it checks out. Opening one reads every reason and every goal checked.
//
// We never invent a datum. If a proof or a reason isn't recorded, the row
// simply omits it — nothing is faked to look complete. Green means "good",
// yellow means "needs a look"; everything else stays quiet.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ShellNotice, type ShellNoticeTone } from "../ui/shell-notice";
import { TraceMark } from "../ui/trace-list";
import { TraceStoryChapter, TraceStoryDay, TraceStoryText } from "../ui/trace-story";
import { TraceTimeline, TraceTimelineEntry } from "../ui/trace-timeline";

import {
  metaPlaneLog,
  metaPlaneVerify,
  type MetaLogEntry,
  type MetaVerifyReport,
} from "../../lib/metaPlane";
import { verifyBanner, type VerifyTone } from "../../lib/metaVerifyBanner";
import { dayLabel, fullStamp, relTime } from "../trace/sessionsFeed";
import { MomentFacts } from "../trace/story/SessionMoment";
import "../ui/meaning-record.css";

type Props = {
  repoRoot: string;
};

type LoadState = "loading" | "ready" | "error";

/** When the newest reason was written: the one time this record carries. */
function latestOf(entry: MetaLogEntry): number {
  return entry.rows.reduce((t, row) => Math.max(t, row.ts), 0);
}

type ChangeDay = { key: string; label: string; entries: MetaLogEntry[] };

/** The log's own order (newest commit first), cut into days. A change with no
 *  recorded reason has no time of its own, so it stays with the day before it
 *  rather than being moved somewhere it never happened. */
function byDay(entries: MetaLogEntry[]): ChangeDay[] {
  const days: ChangeDay[] = [];
  for (const entry of entries) {
    const at = latestOf(entry);
    const label = at > 0 ? dayLabel(new Date(at * 1000)) : null;
    const last = days[days.length - 1];
    if (last && (label === null || label === last.label)) {
      last.entries.push(entry);
    } else {
      days.push({ key: `${days.length}:${label ?? ""}`, label: label ?? "Not dated", entries: [entry] });
    }
  }
  return days;
}

export function MeaningPlanePanel({ repoRoot }: Props) {
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>("");
  const [report, setReport] = useState<MetaVerifyReport | null>(null);
  const [entries, setEntries] = useState<MetaLogEntry[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    let alive = true;
    setState("loading");
    setError("");
    Promise.all([metaPlaneVerify(repoRoot), metaPlaneLog(repoRoot)])
      .then(([verify, log]) => {
        if (!alive) return;
        setReport(verify);
        setEntries(log);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError(typeof e === "string" ? e : String(e));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => load(), [load]);

  const days = useMemo(() => byDay(entries), [entries]);

  const toggle = (sha: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  return (
    <div className="ui-meaning">
      {state === "loading" && <LoadingState label="Reading the record…" size="md" />}
      {state === "error" && (
        <ErrorState
          title="Couldn’t read the record"
          message={error}
          onRetry={() => void load()}
        />
      )}
      {state === "ready" && (
        <>
          {report && <VerifyBanner report={report} onRefresh={() => void load()} />}
          {entries.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Nothing recorded yet"
              body="This is where the reason behind each change is kept, so anyone can see why it was made, not just what moved. Make a change and the first entry appears."
              size="sm"
            />
          ) : (
            days.map((day) => (
              <TraceStoryDay key={day.key} label={day.label}>
                <TraceTimeline label={`Changes and the reasons behind them, ${day.label}`}>
                  {day.entries.map((entry) => (
                    <ChangeMoment
                      key={entry.sha}
                      entry={entry}
                      open={open.has(entry.sha)}
                      onToggle={() => toggle(entry.sha)}
                    />
                  ))}
                </TraceTimeline>
              </TraceStoryDay>
            ))
          )}
        </>
      )}
    </div>
  );
}

// ── Top banner ─────────────────────────────────────────────────────────────

const NOTICE_TONE: Record<VerifyTone, ShellNoticeTone> = {
  ok: "ok",
  warn: "attention",
  calm: "neutral",
};

// Green is earned by a verdict, never by a file being present — the fold in
// `metaVerifyBanner` is the one place that decides which of the three states
// this report has earned, so the wording and the number can't drift apart.
function VerifyBanner({
  report,
  onRefresh,
}: {
  report: MetaVerifyReport;
  onRefresh: () => void;
}) {
  const banner = verifyBanner(report);
  return (
    <div className="ui-meaning-banner">
      <ShellNotice
        tone={NOTICE_TONE[banner.tone]}
        action={{ label: "Refresh", onClick: onRefresh, title: "Read the record again" }}
        detail={banner.scope && (<span className="ui-meaning-scope">{banner.scope}</span>)}
      >
        <strong>{banner.title}</strong>
        {banner.detail && (
          <span
            className="ui-meaning-banner-detail"
            title={report.issues.length > 0 ? report.issues.join("\n") : undefined}
          >
            {" "}
            · {banner.detail}
          </span>
        )}
      </ShellNotice>
    </div>
  );
}

// ── One change ──────────────────────────────────────────────────────────────

/** A change on the timeline: what moved, the newest reason it was made, and
 *  whether it checks out. Opening it reads every reason and every goal that
 *  was checked — only offered when there is more than the moment already says. */
function ChangeMoment({
  entry,
  open,
  onToggle,
}: {
  entry: MetaLogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const latest = latestOf(entry);
  const newest = entry.rows.reduce<MetaLogEntry["rows"][number] | null>(
    (best, row) => (best === null || row.ts >= best.ts ? row : best),
    null,
  );
  const goals = entry.proof?.goals ?? [];
  const more = entry.rows.length > 1 || goals.length > 0;

  return (
    <>
      <TraceTimelineEntry
        title={<span title={entry.summary}>{entry.summary}</span>}
        active={open}
        onSelect={more ? onToggle : undefined}
        detail={
          <>
            {newest && <span className="ui-meaning-reason">{newest.intent}</span>}
            <MomentFacts
              facts={[
                <ProofMark key="proof" proof={entry.proof} />,
                newest?.agent_id,
                <code key="sha" className="ui-meaning-sha" title={entry.sha}>
                  {entry.short}
                </code>,
                latest > 0 ? (
                  <span key="at" title={fullStamp(latest)}>
                    {relTime(Math.floor(Date.now() / 1000) - latest)}
                  </span>
                ) : null,
              ]}
            />
          </>
        }
      />

      {open && more && (
        <li className="ui-meaning-detail" aria-label={`Why ${entry.short}`}>
          {entry.rows.length > 1 && (
            <TraceStoryChapter title="Every reason recorded">
              {entry.rows.map((row, i) => (
                <div key={`${row.ts}-${i}`} className="ui-meaning-why">
                  <TraceStoryText>{row.intent}</TraceStoryText>
                  <span>
                    {row.agent_id}
                    {row.ts > 0 && <> · {fullStamp(row.ts)}</>}
                  </span>
                </div>
              ))}
            </TraceStoryChapter>
          )}

          {goals.length > 0 && (
            <TraceStoryChapter title="What was checked">
              {goals.map((goal) => (
                <div key={goal.id} className="ui-meaning-goal">
                  <TraceStoryText>{goal.text}</TraceStoryText>
                  <TraceMark tone={goalTone(goal.verdict)}>
                    {goalLabel(goal.verdict)} · {goal.ok}/{goal.total}
                  </TraceMark>
                </div>
              ))}
            </TraceStoryChapter>
          )}
        </li>
      )}
    </>
  );
}

function ProofMark({ proof }: { proof?: MetaLogEntry["proof"] }) {
  if (!proof) return <TraceMark>Not checked</TraceMark>;
  const proven = proof.verdict === "verified" || (proof.total > 0 && proof.ok === proof.total);
  return (
    <TraceMark tone={proven ? "good" : "warn"}>
      {proven ? "Proven" : "Almost"} · {proof.ok}/{proof.total}
    </TraceMark>
  );
}

function goalTone(verdict: string): "good" | "warn" | undefined {
  if (verdict === "verified") return "good";
  if (verdict === "partial") return "warn";
  return undefined;
}

function goalLabel(verdict: string): string {
  switch (verdict) {
    case "verified":
      return "Proven";
    case "partial":
      return "Partly proven";
    case "not_wired":
      return "Not connected yet";
    default:
      return "Not checked";
  }
}
