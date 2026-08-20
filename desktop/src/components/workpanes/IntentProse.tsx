// IntentProse — renders a session's intent / prompt text as calm, human-readable
// prose with *entity awareness*. The audience is increasingly non-developers who
// arrived through AI agents, so the goal is "what happened, in plain language,
// with the technical bits gently highlighted and navigable" — never a raw
// markdown dump.
//
// Two surfaces share one entity model:
//   • InlineEntities — a backtick tokenizer for short, single-line strings (the
//     header headline). No markdown block structure: just text with `code`
//     spans styled as subtle chips, and file-naming tokens turned into pills.
//   • IntentProse — full markdown for multi-paragraph bodies, with a custom
//     `code` renderer. react-markdown v10 no longer passes the `inline` flag, so
//     we detect block-vs-inline ourselves (otherwise an inline `code` span wraps
//     onto its own line — the bug the Summary tab used to show).
//
// Entity model: any `code` token that names a file in *this run's* changeset
// (by full path, basename, or basename-without-extension — so `FullscreenOverlay`
// resolves to `…/FullscreenOverlay.tsx`) becomes a clickable pill that jumps into
// the Changes tab at that file. A token that names a *changed symbol* of this run
// (a function / type from the AST diff, passed in `symbols`) renders as a styled
// chip — so prose that mentions `traceFieldsForRef` or `openInspector` lights up
// even though they're not files. Every other `code` token is a plain chip. Files
// win over symbols on a tie, so a name that is both stays a clickable pill.

import { useMemo, type ReactNode } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IntentChangesetFile } from "../../lib/api";
import { basename } from "../../lib/paths";

/** Split an intent / commit message into a short headline + the remaining body.
 *  Mirrors git's "subject line, blank line, body" convention and falls back to
 *  peeling the first sentence for single-blob agent intents, so the header can
 *  show a tight title while the body carries the detail — without printing the
 *  same text twice. */
export function splitIntent(text: string): { headline: string; body: string } {
  const t = (text ?? "").trim();
  if (!t) return { headline: "", body: "" };
  const para = t.indexOf("\n\n");
  if (para > 0) {
    return {
      headline: t.slice(0, para).replace(/\s*\n\s*/g, " ").trim(),
      body: t.slice(para + 2).trim(),
    };
  }
  const nl = t.indexOf("\n");
  if (nl > 0) {
    return { headline: t.slice(0, nl).trim(), body: t.slice(nl + 1).trim() };
  }
  // One blob: peel the first sentence as the headline when it is long enough to
  // leave a body worth separating.
  if (t.length > 110) {
    const m = t.match(/^(.{24,}?[.!?])\s+(\S.*)$/s);
    if (m) return { headline: m[1].trim(), body: m[2].trim() };
  }
  return { headline: t, body: "" };
}

function stripExt(b: string): string {
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

/** Build a token → full-path lookup so a code token like `FullscreenOverlay`,
 *  `cmd_sessions.rs`, or `src/foo/Bar.tsx` resolves to a changed-file path. */
function buildFileIndex(files: IntentChangesetFile[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of files) {
    const p = f.path;
    if (!p) continue;
    const b = basename(p);
    idx.set(p, p);
    if (!idx.has(b)) idx.set(b, p);
    const stem = stripExt(b);
    if (!idx.has(stem)) idx.set(stem, p);
  }
  return idx;
}

/** Resolve a single code token to a changed-file path, or null. Tolerates a
 *  trailing `()` (call notation) and a leading path-ish prefix. */
function matchFile(tokenRaw: string, idx: Map<string, string>): string | null {
  const token = tokenRaw.trim().replace(/\(\)$/, "");
  if (!token || /\s/.test(token)) return null;
  if (idx.has(token)) return idx.get(token)!;
  const b = basename(token);
  if (idx.has(b)) return idx.get(b)!;
  const stem = stripExt(b);
  if (idx.has(stem)) return idx.get(stem)!;
  return null;
}

/** A bare (un-backticked) word is only auto-linked when it *looks* like code —
 *  has an uppercase letter (PascalCase component), a dot (file.ext), or a slash
 *  (a path). This keeps plain English words ("review", "context", "index") from
 *  matching a same-named file, while still lighting up `FullscreenOverlay`,
 *  `cmd_sessions.rs`, or `src/foo/Bar.tsx` written without backticks. */
function looksLikeCode(token: string): boolean {
  return /[A-Z]/.test(token) || /[./]/.test(token);
}

/** A bare word is auto-chipped as a *symbol* only when it is both an exact
 *  changed-symbol name AND distinctive enough that it can't be ordinary prose:
 *  camelCase/PascalCase (`traceFieldsForRef`), or snake_case (`compose_note`).
 *  A flat lowercase symbol (`run`, `snap`) written without backticks is left
 *  alone — an exact match there is as likely the English word, and the reader
 *  can still backtick it to force the chip. */
function looksLikeSymbol(token: string): boolean {
  return looksLikeCode(token) || token.includes("_");
}

// ── shared chip / pill rendering ─────────────────────────────────────────────

const CODE_CHIP =
  "rounded bg-bg-2 px-1.5 py-px font-mono text-[0.86em] text-text-1 " +
  "border border-line-soft align-baseline";

function FileGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 -mt-px"
    >
      <path
        d="M4 1.6h5L13 5.6v8.8H4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9 1.6V5.6h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A clickable file entity — jumps into Changes at the named file. */
function FilePill({
  path,
  children,
  onOpenFile,
}: {
  path: string;
  children: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(path)}
      title={`Open ${path} in Changes`}
      className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-px font-mono text-[0.86em] text-accent border border-accent/30 hover:bg-accent/20 transition-colors align-baseline"
    >
      <FileGlyph />
      {children}
    </button>
  );
}

/** Render a single `code` token as either a clickable file pill or a chip. */
function renderCodeToken(
  raw: string,
  children: ReactNode,
  idx: Map<string, string>,
  onOpenFile?: (path: string) => void,
): ReactNode {
  const path = onOpenFile ? matchFile(raw, idx) : null;
  if (path && onOpenFile) {
    return (
      <FilePill path={path} onOpenFile={onOpenFile}>
        {children}
      </FilePill>
    );
  }
  return <code className={CODE_CHIP}>{children}</code>;
}

/** Linkify bare changed-file / changed-symbol tokens in a plain-text run (no
 *  markdown). Splits on identifier-ish words; a changed file becomes a clickable
 *  pill (guarded by `looksLikeCode`), a changed symbol becomes a chip (guarded by
 *  `looksLikeSymbol`). Files win on a tie. English words are left alone. */
function linkifyText(
  text: string,
  idx: Map<string, string>,
  symbols: Set<string>,
  onOpenFile: ((path: string) => void) | undefined,
  keyPrefix: string,
): ReactNode {
  if (!onOpenFile && symbols.size === 0) return text;
  const parts = text.split(/([A-Za-z0-9_./-]+)/g);
  return parts.map((seg, i) => {
    if (i % 2 === 1) {
      if (onOpenFile && looksLikeCode(seg)) {
        const path = matchFile(seg, idx);
        if (path) {
          return (
            <FilePill key={`${keyPrefix}-${i}`} path={path} onOpenFile={onOpenFile}>
              {seg}
            </FilePill>
          );
        }
      }
      if (symbols.has(seg) && looksLikeSymbol(seg)) {
        return (
          <code key={`${keyPrefix}-${i}`} className={CODE_CHIP}>
            {seg}
          </code>
        );
      }
    }
    return <span key={`${keyPrefix}-${i}`}>{seg}</span>;
  });
}

/** Wrap bare changed-file / changed-symbol tokens in the body source with
 *  backticks, so the markdown `code` renderer turns them into pills (files) or
 *  chips (symbols). Only transforms text outside existing inline / fenced code,
 *  and only distinctive identifier-ish tokens — so prose stays untouched but
 *  `SessionDetailPane` or `traceFieldsForRef` written plainly becomes live.
 *  Longest-first ordering means a path wins over its own basename. */
function autoBacktickEntities(
  source: string,
  idx: Map<string, string>,
  symbols: Set<string>,
): string {
  const fileTokens = [...idx.keys()].filter(
    (t) => t.length >= 3 && looksLikeCode(t) && /^[A-Za-z0-9_./-]+$/.test(t),
  );
  const symbolTokens = [...symbols].filter(
    (t) =>
      t.length >= 3 &&
      looksLikeSymbol(t) &&
      /^[A-Za-z0-9_.]+$/.test(t) &&
      !idx.has(t),
  );
  const tokens = [...new Set([...fileTokens, ...symbolTokens])].sort(
    (a, b) => b.length - a.length,
  );
  if (!tokens.length) return source;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?<![\\w/.-])(${tokens.map(esc).join("|")})(?![\\w/.-])`,
    "g",
  );
  // Keep existing fenced / inline code spans intact; only touch plain segments.
  return source
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(re, "`$1`")))
    .join("");
}

// ── inline (headline) ────────────────────────────────────────────────────────

/** Tokenize a short single-line string on backticks and render the `code`
 *  segments as entity chips / file pills. Used for the header headline, where a
 *  full markdown block renderer would be overkill (and would wrap in a <p>). */
export function InlineEntities({
  text,
  files,
  symbols,
  onOpenFile,
  className,
}: {
  text: string;
  files: IntentChangesetFile[];
  /** Changed-symbol names from this run's change-note — chipped when matched. */
  symbols?: string[];
  onOpenFile?: (path: string) => void;
  className?: string;
}) {
  const idx = useMemo(() => buildFileIndex(files), [files]);
  const symbolSet = useMemo(() => new Set(symbols ?? []), [symbols]);
  const parts = useMemo(() => text.split(/`([^`]+)`/g), [text]);
  return (
    <span className={className}>
      {parts.map((seg, i) =>
        i % 2 === 1 ? (
          <span key={i}>{renderCodeToken(seg, seg, idx, onOpenFile)}</span>
        ) : (
          <span key={i}>
            {linkifyText(seg, idx, symbolSet, onOpenFile, String(i))}
          </span>
        ),
      )}
    </span>
  );
}

// ── block (body) ─────────────────────────────────────────────────────────────

/** Full markdown body with entity-aware code. Calm prose typography tuned for
 *  reading, not a file view: roomy line-height, gentle paragraph rhythm. */
export function IntentProse({
  source,
  files,
  symbols,
  onOpenFile,
  className,
}: {
  source: string;
  files: IntentChangesetFile[];
  /** Changed-symbol names from this run's change-note — chipped when matched. */
  symbols?: string[];
  onOpenFile?: (path: string) => void;
  className?: string;
}) {
  const idx = useMemo(() => buildFileIndex(files), [files]);
  const symbolSet = useMemo(() => new Set(symbols ?? []), [symbols]);
  const prepared = useMemo(
    () =>
      onOpenFile || symbolSet.size
        ? autoBacktickEntities(source, idx, symbolSet)
        : source,
    [source, idx, symbolSet, onOpenFile],
  );
  return (
    <div
      className={`text-md leading-[1.7] text-text-2 ${className ?? ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (p: any) => <p {...p} className="my-2.5 first:mt-0 last:mb-0" />,
          ul: (p: any) => (
            <ul {...p} className="my-2.5 list-disc space-y-1 pl-5 marker:text-text-4" />
          ),
          ol: (p: any) => (
            <ol {...p} className="my-2.5 list-decimal space-y-1 pl-5 marker:text-text-4" />
          ),
          li: (p: any) => <li {...p} className="pl-0.5" />,
          a: (p: any) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              onClick={onExternalAnchorClick}
              className="text-accent hover:underline"
            />
          ),
          strong: (p: any) => <strong {...p} className="font-semibold text-text-1" />,
          em: (p: any) => <em {...p} className="italic" />,
          blockquote: (p: any) => (
            <blockquote
              {...p}
              className="my-3 border-l-2 border-line pl-3 text-text-3"
            />
          ),
          hr: (p: any) => <hr {...p} className="my-4 border-line-soft" />,
          code: ({ node, className: cn, children, ...rest }: any) => {
            const raw = Array.isArray(children)
              ? children.join("")
              : String(children ?? "");
            // react-markdown v10 drops `inline`; a fenced block carries a
            // language-* class or a newline, everything else is inline.
            const isBlock = /\n/.test(raw) || /language-/.test(cn ?? "");
            if (isBlock) {
              return (
                <code
                  className="block overflow-x-auto rounded-md border border-line-soft bg-bg-1 p-3 font-mono text-sm leading-relaxed text-text-1"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return renderCodeToken(raw, children, idx, onOpenFile);
          },
          pre: (p: any) => <pre {...p} className="my-3" />,
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
