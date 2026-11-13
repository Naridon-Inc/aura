// What the gate card carries beyond the request itself: what the change
// would break, and the change, folded until asked for.

import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { TraceMark } from "../../ui/trace-list";
import type { AgentImpact } from "./gateTypes";
import "../../ui/parked-dock.css";

// impact severity → the word for it and how loud it reads. `feature_loss` is
// the loudest; `callers_only` a softer caution; `leaf_safe` reassuring;
// `unknown` stays quiet so we never over-claim danger we couldn't prove.
const IMPACT_TONE: Record<AgentImpact["severity"], { word: string; tone?: "danger" | "warn" | "good" }> = {
  feature_loss: { word: "Could break a feature", tone: "danger" },
  callers_only: { word: "Affects other code", tone: "warn" },
  leaf_safe: { word: "Likely safe", tone: "good" },
  unknown: { word: "Not sure" },
};

// Tiny inline formatter: turns `**x**` into <strong> and `` `x` `` into
// <code>. No markdown lib, no dangerouslySetInnerHTML — we split on the
// two marker syntaxes and emit React nodes, so the text stays inert.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Match a `**bold**` run OR a `` `code` `` run; everything else is plain.
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={key++}>
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <code key={key++}>
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Map a feature/caller `kind` from the backend onto a calm, human label.
// Falls back to the raw kind (humanized) so an unknown kind still reads ok.
function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    desktop_command: "desktop command",
    tauri_command: "desktop command",
    http_route: "HTTP route",
    route: "HTTP route",
    cli_command: "CLI command",
    cli: "CLI command",
    ui: "UI",
    ui_component: "UI",
    component: "UI",
    api: "API",
    mcp_tool: "API",
  };
  const k = kind.toLowerCase();
  return map[k] ?? k.replace(/_/g, " ");
}

// Humanize an age in seconds → "42s" / "9m" / "3h" / "5d". Coarse on
// purpose — staleness is a vibe, not a stopwatch.
function humanizeAge(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs, { style: "compact" });
}

// Impact panel — a compact summary of what user-facing feature the doomed
// change would break. Built entirely from the structured `AgentImpact`
// payload; purely informational (no focusable controls).
export function ImpactPanel({ impact }: { impact: AgentImpact }) {
  const tone = IMPACT_TONE[impact.severity] ?? IMPACT_TONE.unknown;

  const features = impact.features ?? [];
  const callers = impact.directCallers ?? [];

  const shownFeatures = features.slice(0, 6);
  const moreFeatures = features.length - shownFeatures.length;

  const shownCallers = callers.slice(0, 4);
  const moreCallers = callers.length - shownCallers.length;
  const hasNameOnly = callers.some((c) => c.confidence === "name_only");

  // Footer caveats: the always-on hedge, plus graph-provenance notes when
  // the analysis was run against something other than a fresh checkpoint,
  // was truncated, or is meaningfully stale (> 1 day).
  const notes: string[] = [];
  if (impact.graphSource === "none") {
    notes.push("limited view. Nothing recent to compare against");
  } else if (impact.graphSource !== "checkpoint") {
    notes.push("based on your unsaved changes");
  } else if (impact.graphStalenessSecs != null && impact.graphStalenessSecs > 86400) {
    notes.push(`based on a save from ${humanizeAge(impact.graphStalenessSecs)} ago`);
  }
  if (impact.truncated) notes.push("partial check");

  return (
    <div
      className="ui-parked-impact"
      data-tone={tone.tone === "good" ? undefined : tone.tone}
    >
      <div className="ui-parked-impact-head">
        <span className="ui-parked-impact-label">Impact</span>
        <TraceMark tone={tone.tone}>{tone.word}</TraceMark>
        <Badge variant="outline" title="How sure the check is">
          {impact.confidence} confidence
        </Badge>
      </div>

      {/* The headline sentence, with inline **bold** and `code` rendered
          safely (no markdown lib, no raw HTML). */}
      <p className="ui-parked-impact-summary">{renderInline(impact.summary)}</p>

      {/* The user-facing surfaces upstream of the change, each with the
          chain of calls that reaches it ("the because"). */}
      {shownFeatures.length > 0 && (
        <ul className="ui-parked-impact-features">
          {shownFeatures.map((f, i) => (
            <li
              key={`${f.entrySymbol}:${f.file}:${i}`}
              title={`${f.path && f.path.length > 1 ? f.path.join(" → ") : f.entrySymbol} · ${f.file}`}
            >
              <span className="ui-parked-impact-feature">{f.name}</span>
              <span className="ui-parked-impact-kind">{kindLabel(f.kind)}</span>
              {f.path && f.path.length > 1 && (
                <span className="ui-parked-impact-path">{f.path.join(" → ")}</span>
              )}
            </li>
          ))}
          {moreFeatures > 0 && <li className="ui-parked-impact-more">+{moreFeatures} more</li>}
        </ul>
      )}

      {/* The other parts of the code that rely on this. */}
      {callers.length > 0 && (
        <div className="ui-parked-impact-callers">
          Used by:{" "}
          {shownCallers.map((c, i) => (
            <span key={`${c.symbol}:${i}`}>
              {i > 0 && ", "}
              <code title={c.file ?? undefined}>{c.symbol}</code>
            </span>
          ))}
          {moreCallers > 0 && <span> (+{moreCallers} more)</span>}
          {hasNameOnly && <span> · some of these are uncertain matches</span>}
        </div>
      )}

      {/* The honesty caveat + provenance notes. */}
      <p className="ui-parked-impact-hedge">
        {impact.hedge}
        {notes.map((n) => (
          <span key={n}> · {n}</span>
        ))}
      </p>
    </div>
  );
}

/** The change the agent wants to make, folded until asked for. Split on
 *  newlines and tinted by the leading +/- — no diff lib. */
export function FoldedDiff({ diff }: { diff: string }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => diff.replace(/\n$/, "").split("\n"), [diff]);
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ui-parked-diff-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight />
        {open ? "Hide changes" : "Show changes"}
      </Button>
      {open && (
        <div className="ui-parked-diff" role="region" aria-label="The change">
          {lines.map((line, i) => {
            const kind =
              line.startsWith("+") && !line.startsWith("+++")
                ? "add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "del"
                  : undefined;
            return (
              <div key={i} className="ui-parked-diff-line" data-kind={kind}>
                {line || " "}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
