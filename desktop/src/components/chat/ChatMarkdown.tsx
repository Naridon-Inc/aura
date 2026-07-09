// ChatMarkdown — markdown body renderer for chat messages.
//
// Goals:
//   1. **bold**, *italic*, `inline`, ```fenced``` code blocks, links,
//      lists, blockquotes — full GFM.
//   2. Preserve @mention highlighting (was the prior plain-text path).
//   3. Click bare URLs to open in browser; PR/issue/commit URLs render
//      as a rich embed card (see RichUrlEmbed, layered separately).
//   4. No heavyweight syntax highlighter — chats are short; a monospace
//      block with theme bg is enough. Full hljs can land later.
//
// Mention handling: ReactMarkdown emits text nodes as plain strings.
// We override the leaf renderers (p, li, td, strong, em) to walk their
// children, splitting any string child on `@handle` matches and emitting
// styled mention spans inline.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";

export type ChatMarkdownProps = {
  body: string;
  members: { handle: string }[];
  selfHandle: string;
};

const MENTION_RE = /@([a-zA-Z0-9_.\-]+)/g;

function transformMentions(
  node: ReactNode,
  handleSet: Set<string>,
  selfHandle: string,
): ReactNode {
  if (typeof node === "string") {
    const parts: ReactNode[] = [];
    let last = 0;
    let key = 0;
    MENTION_RE.lastIndex = 0;
    for (let match = MENTION_RE.exec(node); match; match = MENTION_RE.exec(node)) {
      if (match.index > last) {
        parts.push(node.slice(last, match.index));
      }
      const handle = match[1].toLowerCase();
      if (handleSet.has(handle)) {
        const self = handle === selfHandle;
        parts.push(
          <span
            key={`m-${key++}`}
            className="px-1 rounded font-medium"
            style={
              self
                ? { background: "rgba(244, 63, 94, 0.18)", color: "rgb(244, 63, 94)" }
                : { background: "rgba(91, 141, 239, 0.15)", color: "rgb(120, 162, 247)" }
            }
          >
            {match[0]}
          </span>,
        );
      } else {
        parts.push(match[0]);
      }
      last = match.index + match[0].length;
    }
    if (last < node.length) parts.push(node.slice(last));
    return parts.length === 1 ? parts[0] : <Fragment>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</Fragment>;
  }
  if (Array.isArray(node)) {
    return node.map((c, i) => (
      <Fragment key={i}>{transformMentions(c, handleSet, selfHandle)}</Fragment>
    ));
  }
  return node;
}

export function ChatMarkdown({ body, members, selfHandle }: ChatMarkdownProps) {
  const handleSet = new Set(members.map((m) => m.handle));
  const walk = (children: ReactNode) => transformMentions(children, handleSet, selfHandle);

  return (
    <div className="aura-chat-md text-[12.5px] min-w-0 max-w-full" style={{ lineHeight: 1.5, overflowWrap: "anywhere" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="m-0 my-1 first:mt-0 last:mb-0">{walk(children)}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={onExternalAnchorClick}
              className="underline decoration-dotted underline-offset-2"
              style={{ color: "var(--color-accent-blue)" }}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{walk(children)}</li>,
          h1: ({ children }) => <h3 className="text-[13.5px] font-semibold my-1">{children}</h3>,
          h2: ({ children }) => <h3 className="text-[13px] font-semibold my-1">{children}</h3>,
          h3: ({ children }) => <h3 className="text-[12.5px] font-semibold my-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-[12.5px] font-semibold my-0.5">{children}</h4>,
          blockquote: ({ children }) => (
            <blockquote
              className="my-1 pl-2 italic"
              style={{ borderLeft: "2px solid var(--color-line-soft)", color: "var(--color-fg-muted)" }}
            >
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr className="my-1.5 border-0" style={{ borderTop: "1px solid var(--color-line-soft)" }} />
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code: ({ inline, className, children, ...rest }: any) => {
            if (inline) {
              return (
                <code
                  className="px-1 py-0.5 rounded font-mono text-[11.5px]"
                  style={{
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-line-soft)",
                  }}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={`font-mono text-[11.5px] ${className ?? ""}`} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              className="my-1.5 p-2 rounded overflow-x-auto max-w-full font-mono text-[11.5px] leading-snug"
              style={{
                background: "var(--color-bg-card)",
                border: "1px solid var(--color-line-soft)",
              }}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-1 overflow-x-auto">
              <table className="text-[11.5px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="px-1.5 py-0.5 text-left font-semibold"
              style={{ borderBottom: "1px solid var(--color-line)" }}
            >
              {walk(children)}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="px-1.5 py-0.5"
              style={{ borderBottom: "1px solid var(--color-line-soft)" }}
            >
              {walk(children)}
            </td>
          ),
          strong: ({ children }) => <strong className="font-semibold">{walk(children)}</strong>,
          em: ({ children }) => <em className="italic">{walk(children)}</em>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
