// A task's properties as label/value rows: the name of the property on the
// left, and on the right the control that changes it. Empty values read as
// a muted word, and a run of tags wraps with a count of the ones not shown.

import type { ReactNode } from "react";

import { Badge } from "./badge";

import "./tasks-properties.css";

export function TaskPropertyList({ children }: { children: ReactNode }) {
  return <dl className="ui-tasks-properties">{children}</dl>;
}

export function TaskProperty({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** What a property shows when it has no value. */
export function TaskPropertyEmpty({ children }: { children: ReactNode }) {
  return <span className="ui-tasks-property-empty">{children}</span>;
}

/** Up to `max` tags, then "+N" for the rest. */
export function TaskPropertyTags({ tags, max = 4 }: { tags: string[]; max?: number }) {
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="ui-tasks-property-tags">
      {shown.map((tag) => (
        <Badge key={tag} variant="outline">
          {tag}
        </Badge>
      ))}
      {rest > 0 && <span className="ui-tasks-property-more">+{rest}</span>}
    </span>
  );
}
