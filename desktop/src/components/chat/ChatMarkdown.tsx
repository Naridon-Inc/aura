// ChatMarkdown — the body of a message said in a shared session.
//
// It is the shared message markdown — the same type, links, code blocks and
// tables a chat reply reads in — with what a room adds: `@handle` mentions
// drawn as tags (yours in the warning colour, so a line aimed at you stands
// out of the scroll), callout blockquotes, and maths.
//
// Mention handling: the markdown renderer emits text nodes as plain strings.
// The leaf renderers (p, li, td, th, strong, em) walk their children,
// splitting any string child on `@handle` matches that name someone in the
// room and emitting a tag inline. A handle nobody here has stays plain text.

import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { onExternalAnchorClick } from "../../lib/openExternal";
import { calloutFromBlockquote } from "../markdown/Callout";
import { remarkCallouts } from "../markdown/remarkCallouts";
import { CodeMessage, MessageMarkdown } from "../ui/transcript-content";
import "../ui/chat-markdown.css";
import "../ui/session-room.css";

export type ChatMarkdownProps = {
  body: string;
  members: { handle: string }[];
  selfHandle: string;
};

const MENTION_RE = /@([a-zA-Z0-9_.\-]+)/g;

const REMARK = [remarkGfm, remarkMath, remarkCallouts];
const REHYPE = [rehypeKatex];

export function transformMentions(
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
        parts.push(
          <span
            key={`m-${key++}`}
            className="ui-session-mention-tag"
            data-self={handle === selfHandle ? "" : undefined}
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
    return parts.length === 1 ? (
      parts[0]
    ) : (
      <Fragment>
        {parts.map((p, i) => (
          <Fragment key={i}>{p}</Fragment>
        ))}
      </Fragment>
    );
  }
  if (Array.isArray(node)) {
    return node.map((c, i) => (
      <Fragment key={i}>{transformMentions(c, handleSet, selfHandle)}</Fragment>
    ));
  }
  return node;
}

function roomComponents(handleSet: Set<string>, selfHandle: string): Components {
  const walk = (children: ReactNode) => transformMentions(children, handleSet, selfHandle);
  return {
    a: ({ node: _node, ...props }) => (
      <a {...props} target="_blank" rel="noopener noreferrer" onClick={onExternalAnchorClick} />
    ),
    pre: ({ children }) => <CodeMessage>{children}</CodeMessage>,
    blockquote: ({ children, className }) =>
      calloutFromBlockquote(className, children) ?? <blockquote>{children}</blockquote>,
    p: ({ children }) => <p>{walk(children)}</p>,
    li: ({ node: _node, children, ...props }) => <li {...props}>{walk(children)}</li>,
    strong: ({ children }) => <strong>{walk(children)}</strong>,
    em: ({ children }) => <em>{walk(children)}</em>,
    table: ({ node: _node, ...props }) => (
      <div className="ui-markdown-table">
        <table {...props} />
      </div>
    ),
    th: ({ node: _node, children, ...props }) => <th {...props}>{walk(children)}</th>,
    td: ({ node: _node, children, ...props }) => <td {...props}>{walk(children)}</td>,
  };
}

// Memoized: the markdown is re-parsed whenever its components change, which
// is the single heaviest cost in a room row. A message's body, members and
// selfHandle almost never change once landed, so a shallow-prop memo — and
// components keyed on the handles rather than rebuilt per render — skip the
// re-parse for every unrelated stream update (a new message, someone typing).
export const ChatMarkdown = memo(function ChatMarkdown({
  body,
  members,
  selfHandle,
}: ChatMarkdownProps) {
  const handleKey = members.map((m) => m.handle).join("\u0000");
  const components = useMemo(
    () => roomComponents(new Set(handleKey ? handleKey.split("\u0000") : []), selfHandle),
    [handleKey, selfHandle],
  );
  return (
    <MessageMarkdown
      content={body}
      components={components}
      remarkPlugins={REMARK}
      rehypePlugins={REHYPE}
      // Someone typing `<div>` in a room meant the characters, as before.
      skipHtml={false}
    />
  );
});
