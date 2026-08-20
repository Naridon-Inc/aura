// PrDiscussionCard — Stage 8J. Collapsible "Discussion (N)" card on the
// PR Overview tab that surfaces issue-level (conversation) comments
// the same way Graphite does.
//
// Inline thread comments are rendered next to their diff lines via
// PrThreadColumn — this card is strictly for the conversation track:
// comments without a `path`/`line` (issue comments) plus a thin
// "Open Conversation tab" affordance.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PrComment } from "../../lib/api";
import { monogram } from "../../lib/monogram";
import { relativeAgeFromIso } from "../../lib/relativeTime";

type Props = {
  comments: PrComment[];
};

export function PrDiscussionCard({ comments }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const issueComments = comments
    .filter((c) => c.is_issue_comment)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const count = issueComments.length;

  return (
    <section className="border border-line-soft rounded-lg bg-bg-content overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-4 h-11 hover:bg-state-hover transition-colors"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 10 10"
          className={`text-text-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
        <span className="text-base font-semibold text-text-1">
          Discussion
        </span>
        <span className="text-sm text-text-4 tabular-nums">{count}</span>
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 pt-1">
          {count === 0 ? (
            <div className="text-text-4 text-sm py-2">
              No conversation comments yet.
            </div>
          ) : (
            <ul className="space-y-3">
              {issueComments.map((c) => (
                <DiscussionRow key={c.id} c={c} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function DiscussionRow({ c }: { c: PrComment }) {
  // One monogram for the whole app — see lib/monogram.
  const initial = monogram(c.author);
  return (
    <li className="flex gap-2.5">
      <span className="w-6 h-6 rounded-full bg-violet/30 text-violet flex items-center justify-center text-xs font-bold flex-shrink-0">
        {initial}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-1 font-medium">{c.author}</span>
          <span className="text-text-4">{relAge(c.created_at)}</span>
        </div>
        <div className="mt-1 text-base text-text-2 leading-[1.55] [&_p]:my-0 [&_p+p]:mt-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
        </div>
      </div>
    </li>
  );
}

function relAge(iso: string): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromIso(iso, { empty: "—" });
}
