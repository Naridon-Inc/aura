// A row of figures at the head of a summary page: each a number over what it
// counts, with an optional second line that gives the number its scope. One
// row of one kind of thing, so no boxes — a hairline between neighbours says
// "these are separate readings" at a fraction of the ink.

import { type ReactNode } from "react";
import "./trace-stats.css";

export function TraceStats({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-trace-stats" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function TraceStat({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-trace-stat">
      <div className="ui-trace-stat-value">{children}</div>
      <div className="ui-trace-stat-label">{label}</div>
      {sub ? <div className="ui-trace-stat-sub">{sub}</div> : null}
    </div>
  );
}

/** A quiet run of exits at the foot of a summary: where to go next. */
export function TraceExits({ children }: { children: ReactNode }) {
  return <div className="ui-trace-exits">{children}</div>;
}
