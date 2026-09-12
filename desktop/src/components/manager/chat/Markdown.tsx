//! Markdown renderer + inline reference linkifier for the native Aura chat.
//!
//! Lifted out of the `ManagerChatView` monolith. `MarkdownBody` is the core
//! export every message body uses; it drives `react-markdown` + `remark-gfm`
//! through a token-colored component map (never react-markdown's defaults) so
//! prose lands references-grade: comfortable line-height, inline code and code
//! blocks on `--color-bg-2` with a `--color-line` hairline, links in
//! `--color-accent`, blockquotes with a left accent rule, and tables ruled in
//! `--color-line`.
//!
//! On top of the markdown, a linkifier walks plain-text runs and replaces
//! structured references with subtle clickable token chips:
//!   - `Wave N`        → scrolls to the matching row in the WaveTimeline
//!   - `@plan-uuid`    → copies the plan id (rich open needs the envelope)
//!   - `commit <hex>`  → copies the short hash
//!   - file paths      → open the file via the editor store
//!   - URLs            → open in a new tab
//! Inline code chips that *name* a path or URL likewise become openable chips
//! with a leading glyph; everything else stays a quiet bordered code chip.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkCallouts } from "../../markdown/remarkCallouts";
import { calloutFromBlockquote } from "../../markdown/Callout";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openFileImperative } from "../../../lib/editorStore";
import { resolveAgainstRepo, useChatRepoRoot } from "./context";
import { Code } from "../../ui/code";
import { CopyButton } from "../../ui/copyButton";

// Open an external URL in the system browser. A plain `<a target="_blank">`
// does NOTHING inside the Tauri WKWebView (no window.open handler), so every
// link in the chat looked dead — this routes the click through the opener
// plugin the rest of the app uses (updater, onboarding). Best-effort: a
// rejected open (bad scheme, user-cancelled) is swallowed, not thrown.
export function openExternalUrl(href: string) {
  void openUrl(href).catch(() => {
    /* unopenable scheme / cancelled — nothing useful to surface inline */
  });
}

// ─── Inline reference linkifier ───────────────────────────────────────
// Walks plain-text children and replaces structured refs (Wave N, file
// paths, commit hashes, @plan-id) with clickable spans. Wave N scrolls
// to its row in the WaveTimeline; file paths open via editorStore;
// commits render as mono chips (Git surface integration is a follow-up).

export const REF_PATTERN =
  // 1: URL (http/https/mailto/ftp/file or `www.…` host)
  // 2: Wave N    3: @plan-uuid    4: commit (7-12 hex after `commit `)    5: file path with ext
  /(\b(?:https?|mailto|ftp|file|tel):[^\s<>"')\]]+|\bwww\.[a-z0-9][a-z0-9-]*\.[a-z]{2,}[^\s<>"')\]]*)|\bWave\s+(\d+)\b|@([a-z0-9][a-z0-9-]{6,})\b|\bcommit\s+`?([a-f0-9]{7,12})`?|((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,8}(?::\d{1,7}(?::\d{1,5})?)?)/gi;

export function linkifyString(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  REF_PATTERN.lastIndex = 0;
  while ((m = REF_PATTERN.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[1]) {
      // Strip common trailing punctuation that the regex over-eats
      // ("see https://example.com." → URL stops before the period).
      let url = m[1];
      let tail = "";
      while (url.length > 0 && /[).,;:!?]/.test(url[url.length - 1]!)) {
        tail = url[url.length - 1]! + tail;
        url = url.slice(0, -1);
      }
      out.push(<UrlRef key={`${m.index}-u`} url={url} />);
      if (tail) out.push(tail);
    } else if (m[2]) {
      const wave = Number(m[2]);
      out.push(<WaveRef key={`${m.index}-w`} wave={wave} />);
    } else if (m[3]) {
      out.push(<PlanRef key={`${m.index}-p`} planId={m[3]} />);
    } else if (m[4]) {
      out.push(<CommitRef key={`${m.index}-c`} commit={m[4]} />);
    } else if (m[5]) {
      out.push(<FileRef key={`${m.index}-f`} path={m[5]} />);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

// Shared base style for the linkify chips so Wave/Plan/Commit/File/URL
// read as one quiet family: a hairline-bordered token chip in mono.
const CHIP_BASE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  lineHeight: 1.4,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--color-line)",
  background: "var(--color-bg-2)",
  padding: "0 5px",
  margin: "0 1px",
  cursor: "pointer",
};

export function UrlRef({ url }: { url: string }) {
  const href = ensureUrlScheme(url);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternalUrl(href);
      }}
      className="underline decoration-dotted underline-offset-2"
      style={{ color: "var(--color-accent)", cursor: "pointer" }}
      title={`Open ${href}`}
    >
      {url}
    </a>
  );
}

export function applyLinkify(children: React.ReactNode): React.ReactNode {
  if (children === null || children === undefined) return children;
  if (typeof children === "string") return linkifyString(children);
  if (Array.isArray(children)) {
    return children.flatMap((c, i) => {
      const linked = applyLinkify(c);
      if (Array.isArray(linked)) {
        return linked.map((n, j) =>
          typeof n === "string"
            ? n
            : React.isValidElement(n)
              ? React.cloneElement(n, { key: `${i}-${j}` })
              : n,
        );
      }
      return [linked];
    });
  }
  return children;
}

export function WaveRef({ wave }: { wave: number }) {
  const onClick = () => {
    const el = document.querySelector<HTMLElement>(`[data-wave-row="${wave}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el) {
      el.style.transition = "background 0.2s";
      const prev = el.style.background;
      el.style.background = "color-mix(in srgb, var(--color-accent) 18%, transparent)";
      setTimeout(() => {
        el.style.background = prev;
      }, 900);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-baseline"
      style={{ ...CHIP_BASE, color: "var(--color-accent)" }}
      title={`Jump to Wave ${wave} in the timeline`}
    >
      Wave {wave}
    </button>
  );
}

export function PlanRef({ planId }: { planId: string }) {
  // Plan IDs are uuid-ish. We don't always have the PlanTabData handy to
  // open the rich view here — fall back to copy + announce. (Wiring
  // openPlan needs the full PendingPlan envelope which only the session
  // has.)
  const onClick = () => {
    void navigator.clipboard?.writeText(planId);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-baseline"
      style={{ ...CHIP_BASE, color: "var(--color-accent)" }}
      title={`Copy plan id ${planId}`}
    >
      @{planId.slice(0, 8)}
    </button>
  );
}

export function CommitRef({ commit }: { commit: string }) {
  const onClick = () => {
    void navigator.clipboard?.writeText(commit);
  };
  return (
    <span
      onClick={onClick}
      role="button"
      className="inline-flex items-baseline"
      style={{ ...CHIP_BASE, color: "var(--color-accent-green)" }}
      title={`Commit ${commit} (click to copy)`}
    >
      {commit.slice(0, 7)}
    </span>
  );
}

export function FileRef({ path }: { path: string }) {
  const repoRoot = useChatRepoRoot();
  const { base, line } = splitLineSuffix(path);
  const onClick = () => {
    openFileAtLine(resolveAgainstRepo(repoRoot, base), line);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 align-baseline"
      style={{
        ...CHIP_BASE,
        color: "var(--color-accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: 2,
      }}
      title={line ? `Open ${base} at line ${line}` : `Open ${path}`}
    >
      <svg width="11" height="11" aria-hidden="true" style={{ flexShrink: 0 }}>
        <use href="#i-file" />
      </svg>
      <span>{path}</span>
    </button>
  );
}

// File-extension whitelist for path detection. Lowercase, no leading dot.
// Conservative — anything that's clearly a source/asset file the user
// would want to open in the editor. Add new ones as needed; chips that
// fail this check fall through to the bordered-only style.
const PATH_EXT_WHITELIST = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "rb", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "json", "toml", "yaml", "yml", "xml", "html", "css", "scss", "md", "mdx",
  "sh", "zsh", "bash", "fish", "ps1",
  "sql", "graphql", "gql", "proto",
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp",
  "lock", "env", "gitignore", "dockerfile",
]);

// Strip a trailing `:line` or `:line:col` source-location suffix from a
// path-ish token (`featureFlags.ts:56`, `main.rs:120:8`) so the file part
// can be classified and opened, and the line surfaced to scroll there.
// Only fires when the colon is followed by digits, so member paths
// (`Foo::bar`, `store::for_commit`) and URLs are left untouched.
export function splitLineSuffix(text: string): {
  base: string;
  line?: number;
  column?: number;
} {
  const m = /^(.*?):(\d{1,7})(?::(\d{1,5}))?$/.exec(text.trim());
  if (!m) return { base: text.trim() };
  return {
    base: m[1]!,
    line: Number(m[2]),
    column: m[3] ? Number(m[3]) : undefined,
  };
}

// Detects an inline code chip that names a path the user can open.
// Two patterns count:
//   - Contains a path separator (`/` or `\`) → folder or nested file.
//   - Starts with a bare filename that has a whitelisted extension.
// A trailing `:line(:col)` location is tolerated (`featureFlags.ts:56`).
// Whitespace and command-like strings (anything with spaces) are
// rejected so prose like `cargo build --release` stays a plain chip.
export function inlineCodeKind(text: string): "file" | "folder" | null {
  const t0 = text.trim();
  if (!t0 || /\s/.test(t0)) return null;
  const { base: t } = splitLineSuffix(t0);
  if (!t || t.length > 256) return null;
  // Reject pure punctuation / numeric tokens (e.g. `1.6`, `--flag`).
  if (/^[-.\d]+$/.test(t)) return null;
  if (t.startsWith("--") || t.startsWith("-")) return null;
  const hasSep = t.includes("/") || t.includes("\\");
  const isFolderShape = hasSep && (t.endsWith("/") || t.endsWith("\\"));
  if (isFolderShape) return "folder";
  // Strip trailing punctuation users sometimes leave inside the chip
  // (`src/foo.ts.` vs `src/foo.ts`).
  const stripped = t.replace(/[)\].,;:!?]+$/, "");
  const lastDot = stripped.lastIndexOf(".");
  const lastSep = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  if (lastDot > lastSep && lastDot < stripped.length - 1) {
    const ext = stripped.slice(lastDot + 1).toLowerCase();
    if (PATH_EXT_WHITELIST.has(ext)) return "file";
  }
  // Path-shaped string with no extension (folder-ish, e.g. `src/components`).
  if (hasSep) return "folder";
  return null;
}

// True for absolute URLs (http/https/mailto/ftp/file) and protocol-less
// hostnames like `example.com/path`. Conservative — bare words like
// `localhost` or single tokens with no dot aren't matched so we don't
// turn every CSS keyword into a link.
export function isUrlLike(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (t.length > 2048) return false;
  if (/^(https?:\/\/|mailto:|ftp:\/\/|file:\/\/|tel:)/i.test(t)) return true;
  // Protocol-less hostnames: at least one dot, looks like a domain.
  // www.example.com, example.com/foo
  if (/^(www\.|[a-z0-9][a-z0-9-]*\.)([a-z]{2,})(\/.*)?$/i.test(t)) return true;
  return false;
}

export function ensureUrlScheme(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

export function ClickableUrlChip({ text }: { text: string }) {
  const href = ensureUrlScheme(text);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternalUrl(href);
      }}
      className="inline-flex items-center gap-1 align-baseline"
      style={{
        ...CHIP_BASE,
        color: "var(--color-accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: 2,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
      title={`Open ${href}`}
    >
      <svg width="11" height="11" aria-hidden="true" style={{ flexShrink: 0 }}>
        <use href="#i-link" />
      </svg>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{text}</span>
    </a>
  );
}

// Open a resolved file, then (if a line was named) reveal it once the editor
// has mounted. Mirrors the open-then-scroll sequencing the ⌘K search and
// terminal-link clicks use — Monaco listens for `aura:scroll-to-line` and
// filters on `filePath`, so we pass the same resolved path we opened.
export function openFileAtLine(resolved: string, line?: number) {
  void openFileImperative(resolved).then(() => {
    if (!line) return;
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("aura:scroll-to-line", {
          detail: { filePath: resolved, line, column: 1 },
        }),
      );
    }, 120);
  });
}

export function ClickableCodeChip({
  text,
  kind,
}: {
  text: string;
  kind: "file" | "folder";
}) {
  const repoRoot = useChatRepoRoot();
  const { base, line } = splitLineSuffix(text);
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (kind === "folder") {
      // Folders aren't openable in the editor — surface as a tooltip-only
      // chip for now. (A future change can route to the FileTree, but
      // there's no current command for "reveal in tree".)
      return;
    }
    openFileAtLine(resolveAgainstRepo(repoRoot, base), line);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 align-baseline${
        kind === "file" ? " aura-md-file-chip" : ""
      }`}
      style={{
        ...CHIP_BASE,
        // Calm at rest — a path reads as a quiet code chip, not a green wall
        // of links the way the reference keeps inline paths neutral until you
        // reach for them. The accent (green in chat) is held back for :hover
        // (see .aura-md-file-chip in styles.css), where it signals "clickable".
        color: "var(--color-text-2)",
        cursor: kind === "file" ? "pointer" : "default",
        textDecoration: "none",
        maxWidth: "100%",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
      title={
        kind === "file"
          ? line
            ? `Open ${base} at line ${line}`
            : `Open ${base}`
          : text
      }
    >
      <svg width="11" height="11" aria-hidden="true" style={{ flexShrink: 0 }}>
        <use href={kind === "file" ? "#i-file" : "#i-folder"} />
      </svg>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{text}</span>
    </button>
  );
}

// Tokens that LOOK like symbols but are language keywords/literals — never
// route these to a symbol search. Lowercase-compared.
const SYMBOL_STOP = new Set([
  "true", "false", "null", "undefined", "nan", "none", "nil", "void",
  "self", "this", "super", "const", "let", "var", "function", "return",
  "async", "await", "import", "export", "default", "class", "extends",
  "if", "else", "for", "while", "match", "switch", "case", "enum",
  "struct", "impl", "trait", "fn", "type", "interface", "public", "private",
  "todo", "fixme", "note", "ok", "yes", "no", "done", "string", "number",
  "boolean", "object", "array", "promise",
]);

// Recognize an inline-code token that NAMES a code symbol the user can jump
// to — a JSX element (`<OnboardingFlow>`), PascalCase type/component
// (`OnboardingDialog`), SCREAMING_SNAKE constant (`ONBOARDING_V2`),
// snake_case fn (`loop_ready_view`), camelCase fn (`tasksCreate`), or a
// member path (`api.tasksCreate`, `store::for_commit`). Returns the search
// query (the most specific segment), else null. Deliberately conservative:
// single bareword lowercase tokens, keywords, literals, flags, numbers and
// anything with whitespace are rejected so `true`, `--release`, `cargo`,
// `let x = 1` stay quiet, non-clickable chips.
export function inlineSymbolQuery(text: string): string | null {
  let t = text.trim();
  if (!t || /\s/.test(t) || t.length > 80) return null;
  // Unwrap a JSX element: <Name ...>, </Name>, <Name/>.
  const jsx = /^<\/?([A-Za-z_$][\w$.]*)\b[^>]*>?$/.exec(t);
  if (jsx) t = jsx[1]!;
  if (SYMBOL_STOP.has(t.toLowerCase())) return null;
  // Member path of identifiers (a.b, a::b, a#b) → query the last segment.
  const memberPath = /^[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)+(?:\(\))?$/;
  if (memberPath.test(t)) {
    const seg = t.replace(/\(\)$/, "").split(/::|\.|#/).pop()!;
    return seg.length >= 2 ? seg : null;
  }
  const bare = t.replace(/\(\)$/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(bare)) return null;
  if (SYMBOL_STOP.has(bare.toLowerCase())) return null;
  const isPascal = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(bare); // OnboardingFlow
  const isScreaming = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(bare); // ONBOARDING_V2
  const isSnake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(bare); // loop_ready_view
  const isCamel = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(bare); // tasksCreate
  if ((isPascal || isScreaming || isSnake || isCamel) && bare.length >= 3) {
    return bare;
  }
  return null;
}

// A clickable inline-code chip for a code symbol. Looks identical to a quiet
// bordered code chip (so prose stays calm) but on click opens the project
// search prefilled with the symbol — the deterministic "find this" we have,
// no flaky go-to-definition. Keyboard-accessible.
export function SymbolChip({ text, query }: { text: string; query: string }) {
  const onActivate = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("aura:open-search", { detail: { query } }),
    );
  };
  return (
    <Code
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate(e);
      }}
      className="aura-md-symbol cursor-pointer"
      title={`Find “${query}” in this project`}
    >
      {text}
    </Code>
  );
}

// Shared token surface for fenced code blocks: a quiet raised slab on
// --color-bg-2 ruled with a --color-line hairline. (Inline chips now render
// through the `Code` primitive, which bakes the same surface in.)
const CODE_SURFACE: React.CSSProperties = {
  background: "var(--color-bg-2)",
  border: "1px solid var(--color-line)",
  borderRadius: "var(--radius-sm)",
};

// Pull the plain source text out of a react-markdown code node (usually a
// single <code> whose child is the string) so the copy button has something
// to write. Recurses to be safe against nested highlighter spans.
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

// A fenced code block with a hover-revealed copy button in the top-right
// corner (Medusa's code-block affordance). The `<pre>` keeps the quiet
// slab; the copy chip floats over it and only appears on hover/focus so it
// never competes with the code at rest.
function CodeBlock({ children }: { children: React.ReactNode }) {
  const text = React.useMemo(
    () => nodeText(children).replace(/\n+$/, ""),
    [children],
  );
  return (
    <div className="group relative my-2">
      {text && (
        <CopyButton
          content={text}
          variant="mini"
          className="absolute right-1.5 top-1.5 z-10 rounded-md bg-bg-1 p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
      <pre
        className="overflow-x-auto p-2.5 font-mono text-sm leading-relaxed"
        style={{ ...CODE_SURFACE, color: "var(--color-text-1)" }}
      >
        {children}
      </pre>
    </div>
  );
}

// Hoisted out of the render so the plugin array and the component map keep a
// stable identity across renders — that's what lets `MarkdownChunk` memoize on
// its source string alone. Rebuilding the map inline (as this did) meant
// react-markdown re-ran its whole pipeline on every parent re-render even when
// the text hadn't changed by a single character.
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCallouts];
const REHYPE_PLUGINS = [rehypeKatex];

const MD_COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="m-0 mb-[9px] first:mt-0 last:mb-0">
      {applyLinkify(children)}
    </p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (href) openExternalUrl(ensureUrlScheme(href));
      }}
      className="underline decoration-dotted underline-offset-2"
      style={{ color: "var(--color-accent)", cursor: "pointer" }}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mt-1.5 mb-[9px] ml-[16px] list-disc last:mb-0 space-y-[3px] marker:text-[var(--color-text-4)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-1.5 mb-[9px] ml-[16px] list-decimal last:mb-0 space-y-[3px] marker:text-[var(--color-text-4)]">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="pl-0.5" style={{ lineHeight: 1.5 }}>
      {applyLinkify(children)}
    </li>
  ),
  h1: ({ children }) => (
    <h1
      className="text-lg font-[650] mt-4 mb-1.5 first:mt-0"
      style={{ color: "var(--color-text-1)", lineHeight: 1.3, letterSpacing: "-0.01em" }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="text-md font-[650] mt-3.5 mb-1 first:mt-0"
      style={{ color: "var(--color-text-1)", lineHeight: 1.32, letterSpacing: "-0.006em" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="text-base font-semibold mt-3 mb-0.5 first:mt-0"
      style={{ color: "var(--color-text-1)", lineHeight: 1.35 }}
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4
      className="section-label mt-3 mb-1 first:mt-0"
      style={{ color: "var(--color-text-3)", letterSpacing: "0.04em" }}
    >
      {children}
    </h4>
  ),
  blockquote: ({ children, className }) =>
    calloutFromBlockquote(className, children) ?? (
      <blockquote
        className="my-3 pl-3.5 italic"
        style={{
          borderLeft: "2px solid var(--color-accent)",
          color: "var(--color-text-2)",
        }}
      >
        {children}
      </blockquote>
    ),
  hr: () => (
    <hr
      className="my-4 border-0"
      style={{ borderTop: "1px solid var(--color-line)" }}
    />
  ),
  code: ({ className, children, ...rest }: any) => {
    // react-markdown v10 no longer passes the `inline` flag, so we
    // detect block-vs-inline ourselves (otherwise EVERY inline code
    // span fell through to the block branch below — its clickable
    // file/URL chips never fired, which is exactly the "entities
    // aren't clickable" bug). A fenced block carries a `language-*`
    // class or an embedded newline; everything else is inline.
    const raw =
      typeof children === "string"
        ? children
        : Array.isArray(children) && children.length === 1 && typeof children[0] === "string"
          ? (children[0] as string)
          : null;
    const isBlock =
      /language-/.test(className ?? "") || (raw != null && /\n/.test(raw));
    if (isBlock) {
      return (
        <code
          className={`font-mono text-sm ${className ?? ""}`}
          style={{ color: "var(--color-text-1)" }}
          {...rest}
        >
          {children}
        </code>
      );
    }
    // Inline span. Single-child string chips often name a file path,
    // folder, or URL — render those as clickable chips with a leading
    // icon so users jump straight into the editor or browser. Falls
    // back to the bordered chip for everything else (flags,
    // identifiers, commands).
    if (raw && isUrlLike(raw)) {
      return <ClickableUrlChip text={raw} />;
    }
    const kind = raw ? inlineCodeKind(raw) : null;
    if (raw && kind) {
      return <ClickableCodeChip text={raw} kind={kind} />;
    }
    // Not a path/URL — does it NAME a code symbol? Route those to a
    // prefilled project search so `OnboardingFlow`, `ONBOARDING_V2`,
    // `api.tasksCreate` are all jumpable, while flags/keywords stay
    // quiet bordered chips.
    const symQuery = raw ? inlineSymbolQuery(raw) : null;
    if (raw && symQuery) {
      return <SymbolChip text={raw} query={symQuery} />;
    }
    // Everything else (flags, commands, identifiers we can't route) —
    // the quiet bordered token from the `Code` primitive.
    return <Code {...rest}>{children}</Code>;
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table
        className="text-sm border-collapse"
        style={{ border: "1px solid var(--color-line)" }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      className="px-2 py-1 text-left font-semibold"
      style={{
        background: "var(--color-bg-2)",
        border: "1px solid var(--color-line)",
        color: "var(--color-text-1)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-2 py-1 align-top"
      style={{
        border: "1px solid var(--color-line)",
        color: "var(--color-text-2)",
      }}
    >
      {children}
    </td>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold" style={{ color: "var(--color-text-1)" }}>
      {children}
    </strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
};

/** One parsed run of markdown. `React.memo` on the source string is the whole
 *  point: while a reply streams, the settled prefix is byte-identical render
 *  after render, so remark never re-parses it — only the short live tail is
 *  re-parsed. react-markdown renders into a Fragment (no wrapper element), so
 *  two chunks inside one `.aura-md` produce exactly the same DOM children — and
 *  therefore the same `first:`/`last:` margin collapse — as one chunk would. */
const MarkdownChunk = React.memo(function MarkdownChunk({
  source,
}: {
  source: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
});

// ─── Incremental parse split ──────────────────────────────────────────
//
// A streaming reply hands this component a source string that grows a couple
// of characters at a time (see StreamingMessageText's char-drip). Re-parsing
// the whole accumulated message on every one of those ticks is quadratic in
// message length — the "chat gets slower the longer the answer runs" lag.
//
// The fix: cut the text at the last CommonMark *block boundary* that is
// provably safe, render everything before it as a memoized chunk (parsed once,
// then skipped), and re-parse only the block currently being typed. A blank
// line at the top level ends every leaf block in CommonMark, so parsing the two
// halves separately yields the same tree as parsing the whole — provided the
// boundary is not inside a construct that spans blank lines. Those exceptions
// are exactly what the guards below refuse:
//
//   - fenced code   a blank line inside ``` … ``` is content, not a boundary;
//                   we track fence state and only accept depth-0 blank lines.
//   - lists         "- a\n\n- b" is ONE loose list. Splitting it would emit two
//                   <ul>s (and restart an <ol> at 1, since our `ol` override
//                   drops the `start` attribute). We refuse any boundary whose
//                   preceding block is still inside a list unless the next line
//                   is unindented and not itself a list item — CommonMark's own
//                   list-termination rule.
//   - indented code "    a\n\n    b" is one code block spanning the blank line,
//                   so we refuse a boundary whose next line is indented 4+.
//   - reference defs / footnotes  a `[x]: url` or `[^1]: …` definition resolves
//                   references anywhere in the document. Split the halves and
//                   the reference stops resolving, so the moment a definition
//                   line appears we stop splitting that message entirely.
//
// Tables and blockquotes need no guard: GFM tables cannot contain a blank line,
// and a blank line already terminates a blockquote, so neither can straddle a
// boundary. Raw HTML isn't rendered at all (no rehype-raw), so it can't render
// differently either.
//
// Everything not provably safe falls back to the old whole-source parse, and a
// settled message ALWAYS takes that path — so the final rendered form is
// byte-for-byte what it was before this optimization existed.

/** `- item` / `* item` / `+ item` / `1. item` / `1) item`, up to 3 leading
 *  spaces (4+ would be indented code, not a list). */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A list marker whose content hasn't streamed in yet — the bare `-` / `1.`
 *  that exists for a few characters between "the model typed a bullet" and
 *  "the model typed what's in it". CommonMark reads an empty item differently
 *  standalone than it does in document context, so it is never a safe cut. */
const EMPTY_LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
/** A link-reference or footnote definition: `[label]: …` / `[^1]: …`. */
const DEFINITION_RE = /^ {0,3}\[[^\]\n]*\]:/;

/** Count leading spaces (a tab counts as 4 — enough to trip the indented-code
 *  guard, which is all we use this for). Stops at 4 since nothing downstream
 *  distinguishes deeper indents. */
function leadingIndent(src: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end && n < 4; i++) {
    const c = src.charCodeAt(i);
    if (c === 32) n += 1;
    else if (c === 9) n += 4;
    else break;
  }
  return n;
}

/** Index at which `src` can be cut into an already-settled prefix and a still-
 *  streaming tail, such that parsing the two halves independently renders the
 *  same as parsing the whole. Returns -1 when no safe cut exists (then the
 *  caller parses the whole thing, exactly as before).
 *
 *  Single linear scan, no allocation — it runs on every drip tick, and a
 *  charCode walk is orders of magnitude cheaper than the remark parse it
 *  saves. */
function settledSplitIndex(src: string): number {
  let lastValid = -1;
  // Start of the block following the current blank-line run, plus what the
  // block *before* that run was (still inside a list / an indented code
  // block). -1 when we're not sitting after a blank line.
  let pendingBoundary = -1;
  let pendingInList = false;
  let pendingIndentedCode = false;
  // Indent of the last non-blank line outside a fence, so the blank-line
  // handler can tell whether the block it just closed was indented code.
  let lastIndent = 0;
  // Open fence, if any: the marker character and the run length that opened it
  // (a closing fence must be the same char and at least as long).
  let fenceChar = 0;
  let fenceLen = 0;
  let inList = false;
  let pos = 0;
  const len = src.length;
  while (pos <= len) {
    const nl = src.indexOf("\n", pos);
    const atEnd = nl < 0;
    const lineEnd = atEnd ? len : nl;
    const indent = leadingIndent(src, pos, lineEnd);
    let contentStart = pos;
    while (
      contentStart < lineEnd &&
      (src.charCodeAt(contentStart) === 32 || src.charCodeAt(contentStart) === 9)
    ) {
      contentStart++;
    }
    const blank = contentStart >= lineEnd;
    if (!blank) lastIndent = indent;

    if (fenceChar !== 0) {
      // Inside a fence: only a closing fence matters. Blank lines here are
      // code content, never boundaries.
      if (!blank && indent < 4 && src.charCodeAt(contentStart) === fenceChar) {
        let run = 0;
        while (
          contentStart + run < lineEnd &&
          src.charCodeAt(contentStart + run) === fenceChar
        ) {
          run++;
        }
        // A closing fence carries no info string — only the marker + spaces.
        let rest = contentStart + run;
        while (
          rest < lineEnd &&
          (src.charCodeAt(rest) === 32 || src.charCodeAt(rest) === 9)
        ) {
          rest++;
        }
        if (run >= fenceLen && rest >= lineEnd) {
          fenceChar = 0;
          fenceLen = 0;
        }
      }
    } else if (blank) {
      // Remember where the next block would start; it is only *committed* once
      // we see what that block actually is (below).
      if (pendingBoundary < 0) {
        pendingInList = inList;
        pendingIndentedCode = lastIndent >= 4;
      }
      pendingBoundary = atEnd ? len : nl + 1;
    } else {
      const c = src.charCodeAt(contentStart);
      // A definition anywhere in the message resolves references anywhere else
      // — never safe to split. Bail out for this message entirely.
      if (c === 91 /* [ */ && indent < 4) {
        if (DEFINITION_RE.test(src.slice(contentStart, lineEnd))) return -1;
      }
      if (pendingBoundary >= 0) {
        // Commit the pending boundary iff this next block can't be a
        // continuation of what came before the blank line, and iff it is
        // itself far enough along to parse the same alone as in context.
        const lineText = src.slice(pos, lineEnd);
        const isListItem = indent < 4 && LIST_ITEM_RE.test(lineText);
        const safe =
          // An indented code block bends what follows it: `10) x` after one
          // parses as a paragraph in context but as an ordered list alone.
          // Rather than model that, never cut straight after indented code.
          pendingIndentedCode
            ? false
            : isListItem && EMPTY_LIST_ITEM_RE.test(lineText)
              ? false
              : pendingInList
                ? indent === 0 && !isListItem
                : indent < 4;
        if (safe) lastValid = pendingBoundary;
        pendingBoundary = -1;
      }
      // Fence opener? (``` or ~~~, 3+, indented less than 4.)
      if (indent < 4 && (c === 96 /* ` */ || c === 126 /* ~ */)) {
        let run = 0;
        while (
          contentStart + run < lineEnd &&
          src.charCodeAt(contentStart + run) === c
        ) {
          run++;
        }
        if (run >= 3) {
          fenceChar = c;
          fenceLen = run;
        }
      }
      if (fenceChar === 0) {
        // CommonMark list termination: a list item starts/continues a list; an
        // unindented non-item line ends it. Indented lines are lazy
        // continuations, so they leave the flag alone.
        if (indent < 4 && LIST_ITEM_RE.test(src.slice(pos, lineEnd))) inList = true;
        else if (indent === 0) inList = false;
      }
    }
    if (atEnd) break;
    pos = nl + 1;
  }
  // The message ends on a blank line: everything before it is settled, so long
  // as no fence is open and neither a list nor an indented code block could
  // still be continued by content that hasn't streamed in yet.
  if (
    pendingBoundary >= 0 &&
    fenceChar === 0 &&
    !pendingInList &&
    !pendingIndentedCode
  ) {
    lastValid = pendingBoundary;
  }
  return lastValid > 0 ? lastValid : -1;
}

export function MarkdownBody({
  source,
  trailingCursor,
  streaming = false,
}: {
  source: string;
  trailingCursor?: boolean;
  /** The text is still arriving. Enables the incremental split above; a
   *  settled body always parses whole, so what finally lands on screen is
   *  identical to the pre-optimization render. Optional because the streaming
   *  callers don't have to say so — a body whose `source` is observed GROWING
   *  is self-evidently live (see below). */
  streaming?: boolean;
}) {
  // Strip mode-label decorations the model occasionally emits ("[PLAN]
  // ...", "[Ask] ...") and stale prefixes from earlier sessions. The
  // composer chip already shows mode — labels in body text are noise.
  const cleaned = source.replace(/^\s*\[(plan|ask|build)\][ \t]*/i, "");
  // Self-detected live body: a source that is a strict extension of what this
  // same mount rendered last commit can only be a stream in progress. Sticky,
  // so a re-render that doesn't happen to add characters doesn't flip us back
  // to the whole-source parse mid-stream (which would re-parse everything).
  // Recorded in an effect, never during render, so the render stays pure — and
  // so a body's FIRST paint is always the plain whole-source parse. A settled
  // message never grows, so it never leaves that path.
  const liveRef = React.useRef(false);
  const prevRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevRef.current;
    if (prev !== null && cleaned.length > prev.length && cleaned.startsWith(prev)) {
      liveRef.current = true;
    }
    prevRef.current = cleaned;
  });
  const split = streaming || liveRef.current ? settledSplitIndex(cleaned) : -1;
  const head = split > 0 ? cleaned.slice(0, split) : cleaned;
  const tail = split > 0 ? cleaned.slice(split) : "";
  return (
    <div
      className="aura-md"
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "13px",
        lineHeight: 1.55,
        letterSpacing: "0.003em",
        color: "var(--color-text-1)",
        overflowWrap: "anywhere",
        wordBreak: "normal",
        minWidth: 0,
        WebkitFontSmoothing: "antialiased",
        textRendering: "optimizeLegibility",
      }}
    >
      <MarkdownChunk source={head} />
      {tail ? <MarkdownChunk source={tail} /> : null}
      {trailingCursor && (
        <span
          className="inline-block w-1.5 h-3 ml-0.5 align-text-bottom animate-pulse"
          style={{ background: "color-mix(in srgb, var(--color-text-2) 60%, transparent)" }}
        />
      )}
    </div>
  );
}
