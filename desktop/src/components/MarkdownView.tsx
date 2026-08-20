// Rendered markdown surface for *.md / *.markdown / *.mdx file tabs.
//
// Three view modes live in WorkSurface (raw | rendered | split). This
// component owns the rendered side. Uses the existing react-markdown +
// remark-gfm deps so we don't pull a new parser. Theme follows the
// resolved app theme via `useResolvedTheme`.
//
// Buffer is the live Editor buffer (current text). Re-renders on every
// keystroke when split mode is on so the user sees their edits immediately.

import { Children, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkCallouts } from "./markdown/remarkCallouts";
import { calloutFromBlockquote } from "./markdown/Callout";
import rehypeKatex from "rehype-katex";
import { useResolvedTheme } from "../lib/themeStore";
import { onExternalAnchorClick } from "../lib/openExternal";

type Props = {
  /** Source markdown — usually the active file's `current` buffer. */
  source: string;
};

export function MarkdownView({ source }: Props) {
  const theme = useResolvedTheme();
  const isDark = theme === "dark";
  return (
    <div
      className={`h-full w-full overflow-auto px-8 py-6 ${
        isDark ? "bg-bg-content text-text-1" : "bg-white text-neutral-900"
      }`}
    >
      <article
        className="markdown-body mx-auto max-w-[860px]"
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          color: isDark ? "var(--text-1, #e6e6e6)" : "#1f2328",
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkCallouts]}
          rehypePlugins={[rehypeKatex]}
          components={mdComponents(isDark)}
        >
          {source}
        </ReactMarkdown>
      </article>
    </div>
  );
}

// Inline markdown — same prose mapping as the full file view, but WITHOUT the
// page chrome (no h-full/overflow/bg/centered max-w). For embedding rendered
// markdown inside another surface: a session summary, a card, a side panel.
// The caller owns the container, scroll and width; we only render prose.
export const MarkdownInline = memo(function MarkdownInline({
  source,
  className,
}: {
  source: string;
  /** Extra classes on the prose <article> (e.g. a tighter font size). */
  className?: string;
}) {
  const theme = useResolvedTheme();
  const isDark = theme === "dark";
  return (
    // `min-w-0 break-words` keeps prose inside a narrow embedding (review rail,
    // card) — without them a long unbroken token widens the article past its
    // column and clips. `compact` headings keep titles subtle at this size.
    <article
      className={`markdown-body min-w-0 break-words ${className ?? ""}`}
      style={{ fontSize: 12, lineHeight: 1.55 }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCallouts]}
        rehypePlugins={[rehypeKatex]}
        components={mdComponents(isDark, true)}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
});

// Light prose styling — keeps the renderer focused on text without
// pulling in a global CSS dependency. Each component overrides the
// default react-markdown HTML mapping to add tailwind classes.
//
// `compact` picks the heading scale. The full-page file view (860px) gets a
// calm reading scale — a slightly larger title with a section-dividing rule,
// but body-sized copy so a `.md` doc reads at the same density as the Checks
// rail rather than as a billboard. The inline/rail embedding (session
// summaries, review rail, cards — often a ~320px column) gets an even SUBTLER
// scale that sits right on top of body size.
function mdComponents(isDark: boolean, compact = false) {
  // Inline code carries NO background box. A tinted box staircases the moment a
  // token wraps — the padded fill splits across two lines into an ugly stack
  // (seen with `shared-features` / `autopilot-v2.ts` in a narrow rail). Monospace
  // + a soft cool tint reads unmistakably as code while flowing inside prose like
  // any other word, so it never breaks the line and never stacks.
  const code = isDark ? "text-[#a7b6d0]" : "text-[#57606a]";
  const codeBlock = isDark ? "bg-[#0d1117] border-[#30363d]" : "bg-neutral-50 border-neutral-200";
  const link = isDark ? "text-sky-300 hover:underline" : "text-sky-700 hover:underline";
  const tableHead = isDark ? "bg-[#161b22] border-[#30363d]" : "bg-neutral-50 border-neutral-200";
  const tableCell = isDark ? "border-[#30363d]" : "border-neutral-200";
  const blockquote = isDark
    ? "border-l-4 border-neutral-600 text-neutral-400"
    : "border-l-4 border-neutral-300 text-neutral-600";
  const h = compact
    ? {
        h1: "text-base font-semibold text-text-1 mt-3.5 mb-1.5 first:mt-0",
        h2: "text-sm font-semibold text-text-1 mt-3 mb-1 first:mt-0",
        h3: "text-sm font-semibold text-text-1 mt-2.5 mb-1 first:mt-0",
        h4: "text-xs font-semibold text-text-2 mt-2.5 mb-0.5 first:mt-0",
        h5: "text-xs font-semibold text-text-2 mt-2 mb-0.5 first:mt-0",
        h6: "section-label mt-2 mb-0.5 first:mt-0",
      }
    : {
        h1: "text-lg font-semibold mt-5 mb-2 pb-1.5 border-b border-bd-2",
        h2: "text-md font-semibold mt-4 mb-1.5 pb-1 border-b border-bd-2",
        h3: "text-base font-semibold mt-3 mb-1",
        h4: "text-base font-semibold mt-2.5 mb-1",
        h5: "text-sm font-semibold mt-2.5 mb-0.5",
        h6: "section-label mt-2.5 mb-0.5",
      };
  const blockMargin = compact ? "my-2" : "my-2.5";
  return {
    h1: (p: any) => <h1 {...p} className={h.h1} />,
    h2: (p: any) => <h2 {...p} className={h.h2} />,
    h3: (p: any) => <h3 {...p} className={h.h3} />,
    h4: (p: any) => <h4 {...p} className={h.h4} />,
    h5: (p: any) => <h5 {...p} className={h.h5} />,
    h6: (p: any) => <h6 {...p} className={h.h6} />,
    p: (p: any) => <p {...p} className={blockMargin} />,
    a: (p: any) => (
      // `break-words` so a bare long URL wraps at the column edge instead of
      // stretching the prose past its container and forcing a sideways scroll.
      <a {...p} className={`${link} break-words`} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick} />
    ),
    // Task lists (remark-gfm `- [ ]`) drop the bullet and lay the circle
    // checkbox out beside the text; ordinary lists keep their markers.
    ul: ({ className, ...p }: any) =>
      /contains-task-list/.test(className ?? "") ? (
        <ul {...p} className={`list-none pl-1 ${blockMargin} space-y-1`} />
      ) : (
        <ul {...p} className={`list-disc pl-6 ${blockMargin} space-y-1`} />
      ),
    ol: (p: any) => <ol {...p} className={`list-decimal pl-6 ${blockMargin} space-y-1`} />,
    li: ({ className, children, ...p }: any) => {
      if (!/task-list-item/.test(className ?? "")) {
        return (
          <li {...p} className="">
            {children}
          </li>
        );
      }
      // A GFM task item is `<input checkbox> prose…`. Keep the checkbox beside
      // the prose, but fold EVERYTHING after it into ONE inline-flow block.
      // Without this the flex row blockifies every inline child — each text run
      // and each inline <code> becomes its own flex item that shrinks to
      // min-content and wraps, towering `shared-features` into a 2-line column
      // and shattering `delivery/api … monitor.ts` across the row. The single
      // `min-w-0 flex-1` span restores normal inline wrapping (and a clean
      // hanging indent) while the checkbox stays put.
      const kids = Children.toArray(children);
      return (
        <li {...p} className="flex items-start gap-1.5">
          {kids[0]}
          <span className="min-w-0 flex-1">{kids.slice(1)}</span>
        </li>
      );
    },
    // Render the GFM checkbox as the status-row circle glyph (see
    // ChecksPanel): filled accent-green + check when done, stroked circle
    // when not — so markdown checklists read as the same affordance.
    input: ({ type, checked, ...rest }: any) =>
      type === "checkbox" ? (
        <span
          className="mt-[3px] inline-flex shrink-0 items-center justify-center"
          aria-hidden
          {...rest}
        >
          {checked ? <MdCheckCircle /> : <MdEmptyCircle />}
        </span>
      ) : (
        <input type={type} checked={checked} {...rest} />
      ),
    blockquote: (p: any) =>
      calloutFromBlockquote(p.className, p.children) ?? (
        <blockquote {...p} className={`${blockquote} pl-4 ${blockMargin}`} />
      ),
    hr: (p: any) => <hr {...p} className={`${compact ? "my-3" : "my-4"} border-bd-2`} />,
    code: ({ className, children, ...rest }: any) => {
      // react-markdown v10 dropped the `inline` prop. A fenced/block code node
      // carries a `language-*` class (and is wrapped by <pre>); an inline
      // `code` span has neither a language class nor an internal newline.
      // Without this check every inline span renders display:block and breaks
      // its line — e.g. `repo_root` lands on its own line mid-sentence.
      const isBlock =
        /language-/.test(className ?? "") || String(children ?? "").includes("\n");
      if (!isBlock) {
        // Inline code sits INLINE with prose as tinted monospace — no box, no
        // fill, no padding, no border. A boxed chip staircases the instant a
        // token wraps: the padded background splits across lines into an ugly
        // stack (the exact `shared-features` / `autopilot-v2.ts` breakage). With
        // no box there is nothing to split — it flows like any word and just
        // wraps. `break-words` (overflow-wrap: break-word) still lets a long
        // path wrap at the column edge instead of overflowing; NOT
        // `overflow-wrap:anywhere`, which would drop min-content width to one
        // character and tower the code into a column of single letters.
        return (
          <code
            className={`${code} text-[0.9em] font-mono leading-[inherit] align-baseline break-words`}
            {...rest}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={`${className ?? ""} block font-mono text-base`} {...rest}>
          {children}
        </code>
      );
    },
    pre: (p: any) => (
      <pre
        className={`${codeBlock} my-3 p-3 rounded border overflow-x-auto`}
        {...p}
      />
    ),
    table: (p: any) => (
      <div className="my-3 overflow-x-auto">
        <table {...p} className="border-collapse text-sm" />
      </div>
    ),
    th: (p: any) => <th {...p} className={`${tableHead} border px-3 py-1 font-semibold text-left`} />,
    td: (p: any) => <td {...p} className={`${tableCell} border px-3 py-1`} />,
    img: (p: any) => <img {...p} className="max-w-full rounded" />,
  };
}

// Status-row circle glyphs (mirrors ChecksPanel CheckCircle/EmptyCircle) so a
// rendered markdown checklist matches the right-rail status affordance.
function MdCheckCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="var(--color-accent-green)" />
      <path
        d="M5.2 8.2 7 10l3.8-4"
        stroke="var(--color-bg-1)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MdEmptyCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.2" stroke="var(--color-text-4)" strokeWidth="1.4" />
    </svg>
  );
}
