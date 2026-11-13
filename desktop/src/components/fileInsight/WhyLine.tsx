// Why it changed — secondary to what changed, so one quiet line by default:
// the best reason, who gave it and how long ago. Opens to the other notes.

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { relativeAge } from "../../lib/relativeTime";
import type { WhyNote } from "./story";

function signature(n: WhyNote): string {
  const age = n.whenMs === null ? "" : relativeAge(n.whenMs);
  const who = n.provenance === "stated" ? `stated by ${n.who}` : n.provenance === "session" ? `this session · ${n.who}` : n.who;
  return [who, age].filter(Boolean).join(" · ");
}

export function WhyLine({ notes }: { notes: WhyNote[] }) {
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;
  const [first, ...rest] = notes;
  const more = rest.slice(0, 2);
  return (
    <div className="ui-story-why" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="ui-story-why-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? "Show less" : first.text}
      >
        <ChevronRight size={12} aria-hidden />
        <span className="ui-story-why-label">Why</span>
        <span className="ui-story-why-text">{first.text}</span>
        <small>{signature(first)}</small>
      </button>
      {open && more.length > 0 && (
        <ul className="ui-story-why-more">
          {more.map((n) => (
            <li key={n.id}>
              <span>{n.text}</span>
              <small>{signature(n)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
