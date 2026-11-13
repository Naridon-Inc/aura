// A run's report: the readable column a session's Summary is, drawn with the
// same type and hairlines as the rest of Trace. Sections carry a quiet caption,
// facts are label/value lines, and anything with a state — a check, a seal, a
// thing still owed — is an item with a status glyph at its left edge, so a
// reader can run down the edge and see what is settled without reading a word.
// No boxes: the hairline between items is enough to say "separate things".

import { type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, FileText } from "lucide-react";
import { DiffCount } from "./sidebar";
import "./trace-detail.css";
import "./trace-report.css";

export type TraceTone = "good" | "bad" | "warn" | "muted";

export function TraceReport({ children }: { children: ReactNode }) {
  return (
    <div className="ui-trace-report">
      <div className="ui-trace-report-column">{children}</div>
    </div>
  );
}

export function TraceSection({
  title,
  count,
  trailing,
  children,
}: {
  title: ReactNode;
  count?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-trace-section">
      <header>
        <h2>
          {title}
          {count != null && <small>{count}</small>}
        </h2>
        {trailing}
      </header>
      {children}
    </section>
  );
}

const GLYPH = {
  good: CircleCheck,
  bad: CircleX,
  warn: CircleAlert,
  muted: CircleDashed,
} as const;

/** The 14px status glyph an item, or a verdict, opens with. */
export function TraceStatusGlyph({ tone }: { tone: TraceTone }) {
  const Glyph = GLYPH[tone];
  return (
    <span className="ui-trace-glyph" data-tone={tone} aria-hidden>
      <Glyph />
    </span>
  );
}

/** One statement about the whole run — the seal, a block — said as a line
 *  with its glyph rather than as a coloured panel. */
export function TraceVerdict({
  tone,
  icon,
  title,
  children,
}: {
  tone: TraceTone;
  /** Replaces the status glyph when the statement has a mark of its own. */
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ui-trace-verdict" data-tone={tone}>
      {icon ? (
        <span className="ui-trace-glyph" data-tone={tone} aria-hidden>
          {icon}
        </span>
      ) : (
        <TraceStatusGlyph tone={tone} />
      )}
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function TraceItems({ children }: { children: ReactNode }) {
  return <div className="ui-trace-items">{children}</div>;
}

/** A thing with a state: glyph, title and its marks on the first line, then
 *  what it means, then whatever settles it. */
export function TraceItem({
  tone,
  title,
  marks,
  children,
  actions,
}: {
  tone: TraceTone;
  title: ReactNode;
  marks?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ui-trace-item">
      <TraceStatusGlyph tone={tone} />
      <div className="ui-trace-item-body">
        <div className="ui-trace-item-title">
          <strong>{title}</strong>
          {marks}
        </div>
        {children}
        {actions && <div className="ui-trace-item-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** A line under an item's title. `note` is the quiet kind (what a button would
 *  touch, a caveat); `danger` and `warn` are for a failure or an out-of-date
 *  result that must not read like the rest. */
export function TraceLine({
  tone,
  children,
}: {
  tone?: "note" | "danger" | "warn";
  children: ReactNode;
}) {
  return (
    <p className="ui-trace-line" data-tone={tone}>
      {children}
    </p>
  );
}

/** A changed file, as a review row: the whole row opens it. */
export function TraceFileRow({
  path,
  added,
  removed,
  onOpen,
}: {
  path: string;
  added: number;
  removed: number;
  onOpen: (path: string) => void;
}) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <button
      type="button"
      className="ui-trace-file-row"
      onClick={() => onOpen(path)}
      title={`Open ${path} in Review changes`}
    >
      <FileText />
      <span className="ui-trace-file-path">
        {dir && <span>{dir}</span>}
        {name}
      </span>
      {(added > 0 || removed > 0) && <DiffCount added={added} removed={removed} />}
    </button>
  );
}
