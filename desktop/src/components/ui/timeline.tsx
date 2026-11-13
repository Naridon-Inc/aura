import { type ReactNode } from "react";
export interface TimelineEntry {
  id: string;
  title: string;
  detail?: ReactNode;
  tone?: "neutral" | "active" | "incomplete";
  marker?: ReactNode;
}
export function Timeline({
  entries,
  orientation = "vertical",
  position = "after",
}: {
  entries: TimelineEntry[];
  orientation?: "vertical" | "horizontal";
  position?: "before" | "after";
}) {
  return (
    <ol className="ui-timeline" data-orientation={orientation} data-position={position}>
      {entries.map((entry) => (
        <li key={entry.id} data-tone={entry.tone ?? "neutral"}>
          <span className="ui-timeline-marker" aria-hidden>
            {entry.marker}
          </span>
          <div>
            <strong>{entry.title}</strong>
            {entry.detail && <div>{entry.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
