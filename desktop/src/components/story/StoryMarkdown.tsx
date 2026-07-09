// StoryMarkdown — one themed markdown surface for the Intent change story.
//
// The app had five ad-hoc markdown mappings (MarkdownView, TaskMarkdown,
// ChatMarkdown, ManagerChatView, EditViewPanel), each re-theming from
// scratch and drifting apart. This is the single deep-green-tokened
// renderer the Intent↔AST story uses for every prose surface it shows:
// the originating ask, the AI's stated intents, and per-symbol rationale.
//
// Built on react-markdown + remark-gfm (already shipped — no new dep).
// Code is rendered in theme mono rather than pulling a syntax highlighter;
// the story shows signatures and short identifiers, not large code blocks,
// so a highlighter would be weight without payoff. Only the props we
// actually render are destructured, so no stray `node` attribute leaks
// onto the DOM and the strict no-unused-params lint stays happy.

import ReactMarkdown from "react-markdown";
import { onExternalAnchorClick } from "../../lib/openExternal";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { cn } from "../../lib/utils";

type Props = {
  children: string;
  className?: string;
  /** Dense mode for inline beats (per-symbol rationale) — tighter type. */
  compact?: boolean;
};

export function StoryMarkdown({ children, className, compact }: Props) {
  return (
    <div
      className={cn(
        "story-md text-text-2 leading-relaxed",
        compact ? "text-[12px]" : "text-[12.5px]",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

const COMPONENTS: Components = {
  p({ children }) {
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return (
      <h1 className="text-[14px] font-semibold text-text-1 mt-3 mb-1.5 first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="text-[13px] font-semibold text-text-1 mt-3 mb-1.5 first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="text-[12.5px] font-semibold text-text-1 mt-2 mb-1 first:mt-0">
        {children}
      </h3>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={onExternalAnchorClick}
        className="text-accent hover:underline"
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return (
      <ul className="list-disc pl-5 my-2 space-y-1 marker:text-text-4">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="list-decimal pl-5 my-2 space-y-1 marker:text-text-4">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="text-text-2">{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-line-soft pl-3 my-2 text-text-3 italic">
        {children}
      </blockquote>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-text-1">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  hr() {
    return <hr className="my-3 border-line-soft" />;
  },
  code({ className, children }) {
    // react-markdown v10 drops the `inline` flag — block code carries a
    // `language-*` class (and is wrapped in our <pre>), inline code does
    // not. Style each accordingly.
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[11.5px]", className)}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-bg-2 text-text-1 px-1 py-0.5 rounded text-[11.5px] font-mono">
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="bg-bg-2 border border-line-soft rounded-md my-2 p-2.5 overflow-x-auto text-[11.5px]">
        {children}
      </pre>
    );
  },
};
