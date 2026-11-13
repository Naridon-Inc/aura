// The safety check's findings for a pull request, read the way the safety
// check itself reads: a verdict line, then what it found as rows of the shared
// check-run list in one bordered box. The humanized findings when the engine
// wrote them, the folded raw rows when it didn't, and one honest line when
// there is nothing to say.

import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, Circle, FileText, ShieldCheck, X } from "lucide-react";
import type { AuraChangeIntent, AuraHumanFinding, PrDetail } from "../../../lib/api";
import { shortDateFromSecs } from "../../../lib/calendarDate";
import { humanizeFindingText } from "../../../lib/humanizeFinding";
import { noFindingsLine, prReviewState, prReviewTotal } from "../../../lib/prReviewState";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { EmptyState, ErrorState } from "../../ui/state";
import { TraceCaption } from "../../ui/trace-detail";
import {
  SEVERITY_STATUS,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  categoryLabel,
  isProseCategory,
  type CheckStatus,
  type FindingGroup,
  buildFindingGroups,
  HUMAN_SEVERITY_STATUS,
  HUMAN_SEVERITY_LABEL,
  HUMAN_SEVERITY_RANK,
} from "./prFindingGroups";
import "../../ui/check-report.css";
import "../../ui/log-note.css";
import "../../ui/pr-findings.css";

/** How many of a folded row's lines open under it before "…and N more". */
const ROW_CAP = 50;

export function PrFindingsPanel({ detail }: { detail: PrDetail }) {
  const review = detail.aura_review;
  // What this panel is allowed to say, and when — see `prReviewState`. It used
  // to answer straight off `review`, which was `null` for four different
  // reasons, only one of which meant "there isn't one".
  const state = prReviewState({
    review,
    reviewError: detail.aura_review_error,
    base: detail.base_ref,
  });
  const groups = useMemo(
    () => (review && state.kind === "raw" ? buildFindingGroups(review) : []),
    [review, state.kind],
  );
  const total = prReviewTotal(state);

  return (
    <>
      {/* The risk score counts findings — including the taste stream the
          bridge used to drop. Only show it beside a list we actually drew,
          so a score can never sit next to an empty panel again. */}
      <TraceCaption
        trailing={
          review && (state.kind === "humanized" || state.kind === "raw") && (
            <RiskBadge label={review.risk_label} score={review.risk_score} />
          )
        }
      >
        {total > 0 ? `${total} ${total === 1 ? "finding" : "findings"}` : "Safety check"}
      </TraceCaption>
      <div className="ui-check-report ui-pr-findings">
        {state.kind === "failed" || state.kind === "unreadable" ? (
          <ErrorState size="md" title={state.title} message={state.message} />
        ) : state.kind === "absent" ? (
          <EmptyState
            size="md"
            icon={ShieldCheck}
            title={state.title}
            body={state.body}
          />
        ) : state.kind === "humanized" ? (
          <HumanizedReview
            summary={review?.summary}
            findings={review?.findings ?? []}
            changes={review?.changes ?? []}
            unverified={state.unverified}
          />
        ) : state.kind === "raw" ? (
          <FindingsList groups={groups} />
        ) : (
          <NoFindingsLine title={state.title} body={state.body} />
        )}
      </div>
    </>
  );
}

/** The one place the app says a review turned up nothing — used by the raw
 *  fallback and by the humanized surface, so they can't drift into saying
 *  different things about the same review. A caveat makes it a yellow
 *  verdict, not a green one. */
function NoFindingsLine({
  title,
  body,
}: {
  title: string;
  body: string | null;
}) {
  return (
    <header className="ui-verdict" data-tone={body ? "attention" : "good"}>
      <strong>{title}</strong>
      {body && <span>{body}</span>}
    </header>
  );
}

/** A check-report section: its name and count, then its rows in one box. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="ui-log-note-files-head">
        <span>{title}</span>
        <span className="ui-log-note-count">{count}</span>
      </div>
      <div className="ui-check-runs ui-check-box">{children}</div>
    </section>
  );
}

function StatusMark({ status }: { status: CheckStatus }) {
  if (status === "failed") return <X size={14} />;
  if (status === "attention") return <AlertTriangle size={14} />;
  return <Circle size={14} />;
}

// ── Humanized review (engine `pr_humanize`) ─────────────────────────────────
// Plain-language summary, then each finding as what / why it matters / what to
// do / where, then a "Why these changes" list, so a non-developer can decide
// without reading the raw engine strings.

function HumanizedReview({
  summary,
  findings,
  changes,
  unverified,
}: {
  summary?: string;
  findings: AuraHumanFinding[];
  changes: AuraChangeIntent[];
  /** How many changed pieces the engine couldn't trace. Zero findings plus a
   *  non-zero count here is not a clean review, and this panel used to say it
   *  was. */
  unverified: number;
}) {
  const sorted = useMemo(
    () =>
      [...findings].sort(
        (a, b) => HUMAN_SEVERITY_RANK[a.severity] - HUMAN_SEVERITY_RANK[b.severity],
      ),
    [findings],
  );
  const withWhy = useMemo(() => changes.filter((c) => !!c.why), [changes]);
  const emptyLine = noFindingsLine(unverified);
  const lead = summary?.trim();

  return (
    <>
      {lead && <p className="ui-pr-findings-summary">{lead}</p>}

      {sorted.length > 0 ? (
        <Section title="Worth a look" count={sorted.length}>
          {sorted.map((f, i) => (
            <HumanFindingRow key={i} finding={f} />
          ))}
        </Section>
      ) : (
        <NoFindingsLine title={emptyLine.title} body={emptyLine.body} />
      )}

      {withWhy.length > 0 && (
        <Section title="Why these changes" count={withWhy.length}>
          {withWhy.map((c, i) => (
            <WhyChangeRow key={i} change={c} />
          ))}
        </Section>
      )}
    </>
  );
}

function HumanFindingRow({ finding }: { finding: AuraHumanFinding }) {
  const status = HUMAN_SEVERITY_STATUS[finding.severity] ?? "pending";
  const loc =
    finding.file && finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file ?? null;
  const meta = [
    HUMAN_SEVERITY_LABEL[finding.severity] ?? "FYI",
    finding.count > 1 ? `seen ${finding.count} times` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div data-status={status}>
      <StatusMark status={status} />
      <span>
        {finding.title}
        <small>{finding.detail}</small>
        {finding.suggestion && <small data-fix="">{finding.suggestion}</small>}
        <small>{meta}</small>
        {loc && <small data-loc="">{loc}</small>}
      </span>
    </div>
  );
}

function WhyChangeRow({ change }: { change: AuraChangeIntent }) {
  const when =
    typeof change.when === "number" && change.when > 0
      ? shortDateFromSecs(change.when)
      : null;
  const meta = [change.what, change.who, when].filter(Boolean).join(" · ");
  return (
    <div data-status="pending">
      <FileText size={14} />
      <span>
        <span data-loc="">{change.file}</span>
        {change.why && <small>{change.why}</small>}
        {meta && <small>{meta}</small>}
      </span>
    </div>
  );
}

/** The engine's overall read, in the same ink the safety check gives it. */
function RiskBadge({ label, score }: { label: string; score: number }) {
  const norm = (label || "").toUpperCase();
  const color =
    norm === "CRITICAL" ? "var(--ui-red)" : norm === "MODERATE" ? "var(--ui-yellow)" : "var(--ui-green)";
  const human =
    norm === "CRITICAL"
      ? "Critical"
      : norm === "MODERATE"
        ? "Moderate"
        : norm === "LOW"
          ? "Low"
          : label || "—";
  return (
    <Badge variant="outline" style={{ color }} title={`Risk score ${score}`}>
      {human}
    </Badge>
  );
}

// ── Raw findings, folded ────────────────────────────────────────────────────

function FindingsList({ groups }: { groups: FindingGroup[] }) {
  const bySeverity = useMemo(
    () =>
      SEVERITY_ORDER.map((sev) => ({
        sev,
        rows: groups.filter((g) => g.severity === sev),
      })).filter((s) => s.rows.length > 0),
    [groups],
  );
  return (
    <>
      {bySeverity.map(({ sev, rows }) => (
        <Section
          key={sev}
          title={SEVERITY_LABEL[sev]}
          count={rows.reduce((n, r) => n + r.count, 0)}
        >
          {rows.map((g) => (
            <FindingRow key={g.key} group={g} />
          ))}
        </Section>
      ))}
    </>
  );
}

function FindingRow({ group }: { group: FindingGroup }) {
  const [open, setOpen] = useState(false);
  // Only openable when the row folded several distinct messages; otherwise
  // the ×N is just a repeat count and there's nothing more to show.
  const drillable = group.items.length > 1;
  // A single finding shows its full text (the generic label could have
  // stripped a meaningful "… with …" tail); a folded group shows the shared
  // template, with the specifics underneath on demand.
  const prose = isProseCategory(group.category);
  const rawDisplay = group.items.length === 1 ? group.items[0] : group.label;
  const display = prose ? humanizeFindingText(rawDisplay) : rawDisplay;
  const status = SEVERITY_STATUS[group.severity];
  const shown = group.items.slice(0, ROW_CAP);
  const hidden = group.items.length - shown.length;
  return (
    <Fragment>
      <div data-status={status}>
        <StatusMark status={status} />
        <span>
          {display}
          <small title={group.category}>
            {categoryLabel(group.category)}
            {group.count > 1 ? ` · ×${group.count}` : ""}
          </small>
        </span>
        {drillable && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : `Show ${group.items.length}`}
          </Button>
        )}
      </div>
      {open && drillable && (
        <ul className="ui-check-box-rows" data-prose={prose ? "" : undefined}>
          {shown.map((it, i) => (
            <li key={i}>{prose ? humanizeFindingText(it) : it}</li>
          ))}
          {hidden > 0 && <li className="ui-check-box-more">…and {hidden} more</li>}
        </ul>
      )}
    </Fragment>
  );
}
