// Markdown rendering for task descriptions / comments. Built on the
// existing react-markdown + remark-gfm deps so we don't pull a new
// parser. Mention chips (`@handle`) are preserved by recursively
// wrapping string children of every inline-bearing component in
// `MentionedText`.
//
// Styling is dense on purpose — these render inside side panels and
// comment threads where the host text is 12.5px / leading-relaxed.
// The fuller `MarkdownView` (for *.md file tabs) stays separate so
// each surface can tune fonts independently.

import { Children, type ReactNode } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCallouts } from "../markdown/remarkCallouts";
import { calloutFromBlockquote } from "../markdown/Callout";

import { MentionedText } from "../Mentions";
import type { TeamMember } from "../../lib/api";

type Props = {
  /** Markdown source. */
  source: string;
  /** Team members for `@handle` chip resolution. */
  members?: TeamMember[];
  /** Optional class merged onto the wrapping article. */
  className?: string;
};

export function TaskMarkdown({ source, members = [], className = "" }: Props) {
  return (
    <article
      className={`task-md text-[12.5px] text-text-2 leading-relaxed break-words ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        components={mdComponents(members)}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}

// Walk children once and swap string nodes for mention-aware spans.
// Non-string children (other React elements like <a>, <code>, <strong>)
// pass through unchanged — the recursion happens implicitly via the
// nested element renderer's own children pass.
function withMentions(children: ReactNode, members: TeamMember[]): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      // Skip the wrapper entirely when the string has no `@` to keep
      // the DOM tree small in the common case (most paragraphs don't
      // mention anyone).
      if (!child.includes("@")) return child;
      return <MentionedText text={child} members={members} />;
    }
    return child;
  });
}

function mdComponents(members: TeamMember[]) {
  const wrap = (children: ReactNode) => withMentions(children, members);
  return {
    // Headings — tuned a notch smaller than MarkdownView so they don't
    // dwarf the surrounding side-panel layout.
    h1: ({ children, ...p }: any) => (
      <h1
        {...p}
        className="text-[16px] font-semibold text-text-1 mt-4 mb-2 first:mt-0"
      >
        {wrap(children)}
      </h1>
    ),
    h2: ({ children, ...p }: any) => (
      <h2
        {...p}
        className="text-[14.5px] font-semibold text-text-1 mt-4 mb-2 first:mt-0"
      >
        {wrap(children)}
      </h2>
    ),
    h3: ({ children, ...p }: any) => (
      <h3
        {...p}
        className="text-[13.5px] font-semibold text-text-1 mt-3 mb-1.5 first:mt-0"
      >
        {wrap(children)}
      </h3>
    ),
    h4: ({ children, ...p }: any) => (
      <h4
        {...p}
        className="text-[12.5px] font-semibold text-text-1 mt-3 mb-1 first:mt-0"
      >
        {wrap(children)}
      </h4>
    ),
    h5: ({ children, ...p }: any) => (
      <h5
        {...p}
        className="text-[12px] font-semibold text-text-1 mt-3 mb-1 first:mt-0 uppercase tracking-wide"
      >
        {wrap(children)}
      </h5>
    ),
    h6: ({ children, ...p }: any) => (
      <h6
        {...p}
        className="text-[11.5px] font-semibold text-text-2 mt-3 mb-1 first:mt-0 uppercase tracking-wider"
      >
        {wrap(children)}
      </h6>
    ),
    p: ({ children, ...p }: any) => (
      <p {...p} className="my-2 first:mt-0 last:mb-0">
        {wrap(children)}
      </p>
    ),
    a: ({ children, href, ...p }: any) => (
      <a
        {...p}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={onExternalAnchorClick}
        className="text-accent hover:underline break-all"
      >
        {wrap(children)}
      </a>
    ),
    ul: ({ children, ...p }: any) => (
      <ul {...p} className="list-disc pl-5 my-2 space-y-1 marker:text-text-4">
        {children}
      </ul>
    ),
    ol: ({ children, ...p }: any) => (
      <ol {...p} className="list-decimal pl-5 my-2 space-y-1 marker:text-text-4">
        {children}
      </ol>
    ),
    li: ({ children, ...p }: any) => (
      <li {...p} className="leading-relaxed">
        {wrap(children)}
      </li>
    ),
    blockquote: ({ children, ...p }: any) =>
      calloutFromBlockquote(p.className, wrap(children)) ?? (
        <blockquote
          {...p}
          className="border-l-2 border-line-soft pl-3 my-2 text-text-3"
        >
          {wrap(children)}
        </blockquote>
      ),
    hr: (p: any) => <hr {...p} className="my-4 border-line-soft" />,
    strong: ({ children, ...p }: any) => (
      <strong {...p} className="font-semibold text-text-1">
        {wrap(children)}
      </strong>
    ),
    em: ({ children, ...p }: any) => (
      <em {...p} className="italic">
        {wrap(children)}
      </em>
    ),
    code: ({ inline, className, children, ...rest }: any) => {
      if (inline ?? !className) {
        return (
          <code
            className="bg-bg-2 text-text-1 px-1 py-px rounded text-[11.5px] font-mono"
            {...rest}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          className={`${className ?? ""} block font-mono text-[11.5px]`}
          {...rest}
        >
          {children}
        </code>
      );
    },
    pre: (p: any) => (
      <pre
        {...p}
        className="bg-bg-2 border border-line-soft rounded-md my-2 p-2.5 overflow-x-auto text-[11.5px] font-mono"
      />
    ),
    table: ({ children, ...p }: any) => (
      <div className="my-2 overflow-x-auto">
        <table
          {...p}
          className="border-collapse text-[12px] border border-line-soft rounded"
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...p }: any) => (
      <th
        {...p}
        className="bg-bg-2 border border-line-soft px-2 py-1 font-semibold text-left text-text-1"
      >
        {wrap(children)}
      </th>
    ),
    td: ({ children, ...p }: any) => (
      <td {...p} className="border border-line-soft px-2 py-1">
        {wrap(children)}
      </td>
    ),
    img: (p: any) => <img {...p} className="max-w-full rounded my-2" />,
    // GFM task list checkboxes — readonly here. Editing toggles happen
    // through the TiptapEditor instance, not via the rendered view.
    input: ({ type, checked, ...p }: any) => {
      if (type === "checkbox") {
        return (
          <input
            type="checkbox"
            checked={!!checked}
            readOnly
            className="mr-1.5 accent-accent translate-y-[1px]"
            {...p}
          />
        );
      }
      return <input type={type} {...p} />;
    },
  };
}
