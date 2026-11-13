// Markdown for a task's description and comments. It is the shared message
// markdown — the same type, links, code blocks and tables a chat reply reads
// in — with two things a task adds: `@handle` mentions drawn as chips, and
// callout blockquotes.

import { Children, Fragment, useMemo, type ReactNode } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { TeamMember } from "../../lib/api";
import { membersByHandle, parseMentions } from "../../lib/mentions";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { cn } from "../../lib/utils";
import { calloutFromBlockquote } from "../markdown/Callout";
import { remarkCallouts } from "../markdown/remarkCallouts";
import { CodeMessage, MessageMarkdown } from "../ui/transcript-content";
import "../ui/chat-markdown.css";
import "../ui/task-markdown.css";

type Props = {
  /** Markdown source. */
  source: string;
  /** Team members, so a known `@handle` reads as one. */
  members?: TeamMember[];
  className?: string;
};

const PLUGINS = [remarkGfm, remarkCallouts];

export function TaskMarkdown({ source, members = [], className }: Props) {
  const components = useMemo(() => taskComponents(membersByHandle(members)), [members]);
  return (
    <div className={cn("ui-task-markdown", className)}>
      <MessageMarkdown
        content={source}
        components={components}
        remarkPlugins={PLUGINS}
        skipHtml={false}
      />
    </div>
  );
}

/** A string run with its `@handle`s as chips. Strings without an `@` pass
 *  through untouched, which is most of them. */
function withMentions(children: ReactNode, lookup: Map<string, TeamMember>): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string" || !child.includes("@")) return child;
    return parseMentions(child).map((tok, i) => {
      if (tok.kind === "text") return tok.text;
      const handle = tok.handle;
      const known = lookup.get(handle);
      return (
        <Fragment key={i}>
          <span
            className="ui-task-mention"
            data-known={known ? "" : undefined}
            title={known ? known.name || known.email || handle : "Not on this team"}
          >
            @{handle}
          </span>
        </Fragment>
      );
    });
  });
}

function taskComponents(lookup: Map<string, TeamMember>): Components {
  const wrap = (children: ReactNode) => withMentions(children, lookup);
  return {
    a: ({ node: _node, children, ...props }) => (
      <a {...props} target="_blank" rel="noopener noreferrer" onClick={onExternalAnchorClick}>
        {wrap(children)}
      </a>
    ),
    pre: ({ children }) => <CodeMessage>{children}</CodeMessage>,
    blockquote: ({ children, className }) =>
      calloutFromBlockquote(className, wrap(children)) ?? <blockquote>{wrap(children)}</blockquote>,
    p: ({ children }) => <p>{wrap(children)}</p>,
    li: ({ node: _node, children, ...props }) => <li {...props}>{wrap(children)}</li>,
    h1: ({ children }) => <h1>{wrap(children)}</h1>,
    h2: ({ children }) => <h2>{wrap(children)}</h2>,
    h3: ({ children }) => <h3>{wrap(children)}</h3>,
    h4: ({ children }) => <h4>{wrap(children)}</h4>,
    h5: ({ children }) => <h5>{wrap(children)}</h5>,
    h6: ({ children }) => <h6>{wrap(children)}</h6>,
    strong: ({ children }) => <strong>{wrap(children)}</strong>,
    em: ({ children }) => <em>{wrap(children)}</em>,
    table: ({ node: _node, ...props }) => (
      <div className="ui-markdown-table">
        <table {...props} />
      </div>
    ),
    th: ({ node: _node, children, ...props }) => <th {...props}>{wrap(children)}</th>,
    td: ({ node: _node, children, ...props }) => <td {...props}>{wrap(children)}</td>,
  };
}
