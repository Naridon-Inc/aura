// Rendered markdown surface for *.md / *.markdown / *.mdx file tabs.
//
// Three view modes live in WorkSurface (raw | rendered | split). This
// component owns the rendered side. Uses the existing react-markdown +
// remark-gfm deps so we don't pull a new parser. Theme follows the
// resolved app theme via `useResolvedTheme`.
//
// Buffer is the live Editor buffer (current text). Re-renders on every
// keystroke when split mode is on so the user sees their edits immediately.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
          fontSize: 14,
          lineHeight: 1.65,
          color: isDark ? "var(--text-1, #e6e6e6)" : "#1f2328",
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
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
export function MarkdownInline({
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
    <article
      className={`markdown-body ${className ?? ""}`}
      style={{ fontSize: 13, lineHeight: 1.6 }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(isDark)}>
        {source}
      </ReactMarkdown>
    </article>
  );
}

// Light prose styling — keeps the renderer focused on text without
// pulling in a global CSS dependency. Each component overrides the
// default react-markdown HTML mapping to add tailwind classes.
function mdComponents(isDark: boolean) {
  const code = isDark ? "bg-[#161b22] text-[#e6edf3]" : "bg-neutral-100 text-neutral-800";
  const codeBlock = isDark ? "bg-[#0d1117] border-[#30363d]" : "bg-neutral-50 border-neutral-200";
  const link = isDark ? "text-sky-300 hover:underline" : "text-sky-700 hover:underline";
  const tableHead = isDark ? "bg-[#161b22] border-[#30363d]" : "bg-neutral-50 border-neutral-200";
  const tableCell = isDark ? "border-[#30363d]" : "border-neutral-200";
  const blockquote = isDark
    ? "border-l-4 border-neutral-600 text-neutral-400"
    : "border-l-4 border-neutral-300 text-neutral-600";
  return {
    h1: (p: any) => <h1 {...p} className="text-[26px] font-semibold mt-6 mb-3 pb-2 border-b border-bd-2" />,
    h2: (p: any) => <h2 {...p} className="text-[20px] font-semibold mt-5 mb-2 pb-1 border-b border-bd-2" />,
    h3: (p: any) => <h3 {...p} className="text-[17px] font-semibold mt-4 mb-2" />,
    h4: (p: any) => <h4 {...p} className="text-[15px] font-semibold mt-3 mb-1" />,
    h5: (p: any) => <h5 {...p} className="text-[13px] font-semibold mt-3 mb-1" />,
    h6: (p: any) => <h6 {...p} className="text-[12px] font-semibold mt-3 mb-1 uppercase tracking-wider" />,
    p: (p: any) => <p {...p} className="my-3" />,
    a: (p: any) => (
      <a {...p} className={link} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick} />
    ),
    ul: (p: any) => <ul {...p} className="list-disc pl-6 my-3 space-y-1" />,
    ol: (p: any) => <ol {...p} className="list-decimal pl-6 my-3 space-y-1" />,
    li: (p: any) => <li {...p} className="" />,
    blockquote: (p: any) => <blockquote {...p} className={`${blockquote} pl-4 my-3`} />,
    hr: (p: any) => <hr {...p} className="my-6 border-bd-2" />,
    code: ({ className, children, ...rest }: any) => {
      // react-markdown v10 dropped the `inline` prop. A fenced/block code node
      // carries a `language-*` class (and is wrapped by <pre>); an inline
      // `code` span has neither a language class nor an internal newline.
      // Without this check every inline span renders display:block and breaks
      // its line — e.g. `repo_root` lands on its own line mid-sentence.
      const isBlock =
        /language-/.test(className ?? "") || String(children ?? "").includes("\n");
      if (!isBlock) {
        return (
          <code className={`${code} px-1 py-[1px] rounded text-[12.5px] font-mono`} {...rest}>
            {children}
          </code>
        );
      }
      return (
        <code className={`${className ?? ""} block font-mono text-[12.5px]`} {...rest}>
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
        <table {...p} className="border-collapse text-[13px]" />
      </div>
    ),
    th: (p: any) => <th {...p} className={`${tableHead} border px-3 py-1 font-semibold text-left`} />,
    td: (p: any) => <td {...p} className={`${tableCell} border px-3 py-1`} />,
    img: (p: any) => <img {...p} className="max-w-full rounded" />,
  };
}
