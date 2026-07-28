/** Scribble — restricted inline markdown renderer (read-only).
 *
 *  Renders a block's stored markdown for past (frozen) days and pinned previews
 *  without mounting an editor. Supports exactly what a Scribble block can hold:
 *  `**bold**`, `*italic*` / `_it_`, `@handle` mentions, and inline gif/images
 *  `![alt](url)` — no headings, no blocks. Everything is built as React nodes
 *  (never raw HTML), and the container wraps, so a long line never scrolls
 *  sideways. */

import { useMemo, type ReactNode } from "react";
import type { TeamMember } from "../../../lib/api";
import { membersByHandle } from "../../../lib/mentions";

const TOKEN_RE =
  /(!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|@[a-zA-Z0-9._-]+)/g;
const IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function InlineText({
  text,
  members = [],
  className,
  onClick,
}: {
  text: string;
  members?: TeamMember[];
  className?: string;
  onClick?: () => void;
}) {
  const lookup = useMemo(() => membersByHandle(members), [members]);
  const nodes = useMemo<ReactNode[]>(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
      const match = m[0];
      const offset = m.index ?? 0;
      if (offset > last) out.push(<span key={key++}>{text.slice(last, offset)}</span>);
      const img = IMG_RE.exec(match);
      if (img) {
        out.push(
          <img
            key={key++}
            src={img[2]}
            alt={img[1]}
            className="my-1 block max-h-48 max-w-full rounded"
          />,
        );
      } else if (match.startsWith("**")) {
        out.push(<strong key={key++}>{match.slice(2, -2)}</strong>);
      } else if (match.startsWith("*")) {
        out.push(<em key={key++}>{match.slice(1, -1)}</em>);
      } else if (match.startsWith("_")) {
        out.push(<em key={key++}>{match.slice(1, -1)}</em>);
      } else {
        const handle = match.slice(1);
        const known = lookup.has(handle);
        out.push(
          <span
            key={key++}
            className={known ? "text-accent font-medium" : "text-text-3 font-medium"}
          >
            {match}
          </span>,
        );
      }
      last = offset + match.length;
    }
    if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
    return out;
  }, [text, lookup]);

  return (
    <span className={className} onClick={onClick}>
      {nodes.length > 0 ? nodes : "​"}
    </span>
  );
}
