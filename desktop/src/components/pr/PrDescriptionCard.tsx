// PrDescriptionCard — the collapsible card that renders a pull request's body
// as Markdown, using the project's existing react-markdown install (with
// remark-gfm for tables / task lists / strikethrough).
//
// `onEdit` opens the PR authoring dialog — the same one the pane header's Edit
// opens, so there is one editor whichever Edit you reach for. It used to be a
// no-op placeholder kept "so the layout matches the screenshot", which meant
// the empty state told you to click a button that did nothing.

import { useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCallouts } from "../markdown/remarkCallouts";
import { calloutFromBlockquote } from "../markdown/Callout";
import { Button } from "../ui/button";

type Props = {
  body: string;
  onEdit?: () => void;
};

export function PrDescriptionCard({ body, onEdit }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const empty = body.trim().length === 0;
  return (
    <section className="border border-line-soft rounded-lg bg-bg-content overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line-soft/50">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-text-4 hover:text-text-1 flex items-center"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 10 10"
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          >
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
          </svg>
        </button>
        <span className="text-base font-semibold text-text-1">
          Description
        </span>
        <Button
          variant="subtle"
          size="xs"
          onClick={onEdit}
          className="ml-auto gap-1.5"
        >
          <PencilIcon />
          Edit
        </Button>
      </div>
      {!collapsed && (
        <div className="p-3.5">
          {empty ? (
            <DescriptionPlaceholder />
          ) : (
            <div className="text-sm text-text-2 leading-[1.55]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkCallouts]}
                components={MARKDOWN_COMPONENTS}
              >
                {body}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DescriptionPlaceholder() {
  // Mirrors Graphite's empty-PR-body template — two ghost subheadings
  // hinting at the expected structure ("What changed?" / "Why?") so a
  // reviewer landing on a PR with no description still has a frame to
  // ask the author about, instead of a flat "no description." line.
  return (
    <div className="text-base leading-[1.65] space-y-3">
      <div>
        <div className="text-md font-semibold text-text-3">
          What changed?
        </div>
        <div className="text-text-4 italic">
          The author didn't add a description. Click Edit to add one. Start
          with the high-level change.
        </div>
      </div>
      <div>
        <div className="text-md font-semibold text-text-3">Why?</div>
        <div className="text-text-4 italic">
          What user need / bug / regression / decision motivated this change?
        </div>
      </div>
    </div>
  );
}

// Inline component map — Tailwind v4 here doesn't ship the typography
// plugin, so `prose` classes are no-ops. Map each markdown tag to a
// Tailwind-styled element so headings/code/lists render with hierarchy.
export const MARKDOWN_COMPONENTS = {
  h1: (p: { children?: React.ReactNode }) => (
    <h1 className="text-xl font-semibold text-text-1 mt-5 mb-2 first:mt-0">
      {p.children}
    </h1>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <h2 className="text-lg font-semibold text-text-1 mt-5 mb-2 first:mt-0">
      {p.children}
    </h2>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <h3 className="text-md font-semibold text-text-1 mt-4 mb-1.5 first:mt-0">
      {p.children}
    </h3>
  ),
  p: (p: { children?: React.ReactNode }) => (
    <p className="my-2.5 first:mt-0 last:mb-0">{p.children}</p>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-5 my-2.5 space-y-1">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-5 my-2.5 space-y-1">{p.children}</ol>
  ),
  li: (p: { children?: React.ReactNode }) => <li className="">{p.children}</li>,
  code: (p: { children?: React.ReactNode; className?: string }) => {
    const isBlock = (p.className ?? "").startsWith("language-");
    if (isBlock) return <code className={p.className}>{p.children}</code>;
    return (
      // Boxless inline code — tinted monospace, no fill/padding/border — so a
      // path or command flows inside prose like a word. A boxed chip staircases
      // when a token wraps (the padded fill splits across lines into an ugly
      // stack); with no box there is nothing to split.
      <code className="text-text-2 font-mono text-[0.9em] leading-[inherit] align-baseline break-words">
        {p.children}
      </code>
    );
  },
  pre: (p: { children?: React.ReactNode }) => (
    <pre className="my-3 px-3 py-2.5 rounded-md bg-bg-1 border border-line-soft overflow-x-auto text-sm font-mono leading-[1.55]">
      {p.children}
    </pre>
  ),
  blockquote: (p: { children?: React.ReactNode; className?: string }) =>
    calloutFromBlockquote(p.className, p.children) ?? (
      <blockquote className="my-3 pl-3 border-l-2 border-line text-text-3 italic">
        {p.children}
      </blockquote>
    ),
  a: (p: { children?: React.ReactNode; href?: string }) => (
    <a
      href={p.href}
      target="_blank"
      rel="noreferrer"
      onClick={onExternalAnchorClick}
      className="text-violet hover:text-violet/80 underline underline-offset-2"
    >
      {p.children}
    </a>
  ),
  hr: () => <hr className="my-4 border-line-soft" />,
  strong: (p: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-1">{p.children}</strong>
  ),
  em: (p: { children?: React.ReactNode }) => (
    <em className="italic">{p.children}</em>
  ),
  table: (p: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-line-soft">
      <table className="w-full text-sm border-collapse">{p.children}</table>
    </div>
  ),
  th: (p: { children?: React.ReactNode }) => (
    <th className="text-left font-semibold text-text-1 px-3 py-1.5 bg-bg-1 border-b border-line-soft">
      {p.children}
    </th>
  ),
  td: (p: { children?: React.ReactNode }) => (
    <td className="px-3 py-1.5 border-b border-line-soft/50">{p.children}</td>
  ),
};

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M11 2l3 3-8 8H3v-3l8-8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
