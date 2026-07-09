// PrFilesSection — Stage 8F. Inline files diff section beneath the
// Description card on the Overview tab. Mirrors the Graphite layout:
// a single toolbar (Show files / Compare Base → head ref / File
// settings) on top, then a vertical stack of per-file collapsible
// cards. Each card is a `PrFileDiffCard` — header (chevron + path +
// language chip + +/- + comment-count + Viewed) and a body that
// renders the existing PrDiffBody for that file's hunk.
//
// We deliberately keep the same diff parser/renderer the Files tab
// uses (`PrDiffBody`) so line-range selection + Comment/Suggest
// composer stays consistent. The toolbar Show files button doesn't
// open a separate file tree on the Overview tab — it scrolls back
// up to the description so the user can re-orient. Future hook for
// a sticky file tree drawer; out of scope for v1.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuraReviewPayload, PrComment, PrFileStat } from "../../lib/api";
import type { PrLineRelayPayload } from "../../lib/auraRelay";
import { repoSlugFor } from "../../lib/repoSlug";
import { AuraRelayMenu } from "../auraRelayMenu";
import { PR_DIFF_EAGER_MOUNT_LIMIT, PrDiffBody, groupThreads } from "./PrDiffBody";
import { usePrThreadActive, usePrThreadRegister } from "./PrThreadColumn";
import { StatusChip } from "../ui/statusChip";
import { Button } from "../ui/button";
import { Churn } from "../diff/Churn";
import { detectLanguage } from "../../lib/fileLang";

// Stage 8L — Tailwind classes don't apply via DOM mutation reliably
// with arbitrary opacity tokens, so we use explicit classes that the
// Tailwind v4 JIT will pick up because they appear in this file. The
// active-thread row gets the app accent border + faint inner glow
// (token-driven, no off-palette sky).
const ANCHOR_HIGHLIGHT_CLASSES = [
  "ring-1",
  "ring-inset",
  "ring-accent/70",
  "bg-accent/10",
];

function applyAnchorHighlight(el: HTMLElement) {
  el.classList.add(...ANCHOR_HIGHLIGHT_CLASSES);
}
function clearAnchorHighlight(el: HTMLElement) {
  el.classList.remove(...ANCHOR_HIGHLIGHT_CLASSES);
}

type Props = {
  repoRoot: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  files: PrFileStat[];
  /** Full unified-diff body returned by `gh pr diff`. */
  diff: string;
  /** v0.2.12 — when set, every diff strategy failed; render this in
   *  place of "No diff body for this file" so users see the cause. */
  diffError?: string | null;
  comments: PrComment[];
  onPosted?: (c: PrComment) => void;
  /** Stage 8G — Aura semantic review payload, used to derive per-file
   *  finding badges (invariant violations + unverified nodes that
   *  reference the file path). */
  auraReview?: AuraReviewPayload | null;
};

export function PrFilesSection({
  repoRoot,
  prNumber,
  baseRef,
  headRef,
  files,
  diff,
  diffError,
  comments,
  onPosted,
  auraReview,
}: Props) {
  const fileChunks = useMemo(() => splitDiffByFile(diff), [diff]);
  const commentsByPath = useMemo(() => {
    const m = new Map<string, PrComment[]>();
    for (const c of comments) {
      if (!c.path) continue;
      const arr = m.get(c.path) ?? [];
      arr.push(c);
      m.set(c.path, arr);
    }
    return m;
  }, [comments]);
  const auraByPath = useMemo(
    () => deriveAuraByPath(auraReview, files),
    [auraReview, files],
  );

  if (files.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-line-soft bg-bg-content overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line-soft/60">
        <span className="text-[12px] text-text-3 flex items-center gap-1.5">
          <CompareIcon />
          Compare
          <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-bg-2 text-text-2">
            {baseRef}
          </span>
          <span className="text-text-4">→</span>
          <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-bg-2 text-text-2">
            {headRef}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11.5px] text-text-4">
          <span className="tabular-nums">
            {files.length} file{files.length === 1 ? "" : "s"}
          </span>
        </span>
      </div>

      {/* File cards */}
      <div className="p-2 space-y-2">
        {files.map((f, idx) => (
          <PrFileDiffCard
            key={f.path}
            repoRoot={repoRoot}
            prNumber={prNumber}
            headRef={headRef}
            file={f}
            chunk={fileChunks.get(f.path) ?? ""}
            diffError={diffError ?? null}
            comments={commentsByPath.get(f.path) ?? []}
            auraFindingCount={auraByPath.get(f.path) ?? 0}
            // v0.2.12 S.1b — only mount Monaco eagerly for the first
            // PR_DIFF_EAGER_MOUNT_LIMIT files; the rest lazy-mount via
            // IntersectionObserver inside PrDiffBody.
            mountDiffEagerly={idx < PR_DIFF_EAGER_MOUNT_LIMIT}
            onPosted={onPosted}
          />
        ))}
      </div>
    </section>
  );
}

// ── Per-file card ─────────────────────────────────────────────────────

function PrFileDiffCard({
  repoRoot,
  prNumber,
  headRef,
  file,
  chunk,
  diffError,
  comments,
  auraFindingCount,
  mountDiffEagerly,
  onPosted,
}: {
  repoRoot: string;
  prNumber: number;
  /** Head branch ref — used to build a github permalink for the
   *  "Quote in chat" snippet. */
  headRef: string;
  file: PrFileStat;
  chunk: string;
  diffError: string | null;
  comments: PrComment[];
  auraFindingCount: number;
  /** v0.2.12 S.1b — when false, the Monaco DiffEditor inside PrDiffBody
   *  defers its mount until the card scrolls into view. */
  mountDiffEagerly: boolean;
  onPosted?: (c: PrComment) => void;
}) {
  const commentCount = comments.length;
  const lsKey = `aura.pr.${repoRoot}.${prNumber}.viewed.${file.path}`;
  const [viewed, setViewed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(lsKey) === "1";
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(!viewed);
  const language = detectLanguage(file.path);
  const languageSlug = languageForChunk(file.path);

  // v0.2.12 T.1 — Quote in chat. Anchor + payload are set when the user
  // right-clicks the card (or clicks the More-actions button); rendering
  // the AuraRelayMenu opens the channel picker. The snippet captures
  // the first PR_LINE_SNIPPET_LINES of the diff body so the bubble
  // stays bounded.
  const [quoteAnchor, setQuoteAnchor] = useState<HTMLElement | null>(null);
  const [quotePayload, setQuotePayload] = useState<PrLineRelayPayload | null>(
    null,
  );

  const buildQuotePayload = useCallback(async (): Promise<PrLineRelayPayload> => {
    const slug = (await repoSlugFor(repoRoot)) || "";
    const snippet = extractFirstAdditionsBlock(chunk, PR_LINE_SNIPPET_LINES);
    const startLine = 1;
    const endLine = Math.max(1, snippet.lines.length);
    const url = slug
      ? `https://github.com/${slug}/blob/${encodeURIComponent(headRef)}/${file.path}`
      : "";
    return {
      repo: slug,
      url,
      number: prNumber,
      file: file.path,
      line_start: startLine,
      line_end: endLine,
      snippet: snippet.lines.join("\n"),
      language: languageSlug ?? undefined,
    };
  }, [repoRoot, chunk, prNumber, file.path, headRef, languageSlug]);

  const openQuoteMenu = useCallback(
    async (anchor: HTMLElement | null) => {
      const payload = await buildQuotePayload();
      if (!payload) return;
      setQuotePayload(payload);
      setQuoteAnchor(anchor);
    },
    [buildQuotePayload],
  );

  const closeQuoteMenu = useCallback(() => {
    setQuoteAnchor(null);
    setQuotePayload(null);
  }, []);

  // Stage 8I — fluid threads: PrDiffBody emits row elements; we
  // forward each anchored row to the shared PrThreadColumn registry,
  // which renders FloatingThreadCard bubbles in the right rail's
  // overflow strip (under PrRightRail). No per-card absolute layout
  // here — threads live in the rail column, not next to the file
  // card, so they don't collide with the rail.
  const threads = useMemo(() => groupThreads(comments), [comments]);
  const threadByLine = useMemo(() => {
    const m = new Map<number, ReturnType<typeof groupThreads>[number]>();
    for (const t of threads) {
      if (t.root.line != null) m.set(t.root.line, t);
    }
    return m;
  }, [threads]);
  const registerThread = usePrThreadRegister();
  const { activeKey } = usePrThreadActive();

  // Stage 8L — track every anchored row by key so we can toggle the
  // teal ring when activeKey matches. Map keeps stale entries out as
  // rows unmount.
  const rowsByKey = useRef<Map<string, HTMLElement>>(new Map());
  // Stage 8M — mirror of activeKey readable inside the stable
  // `registerRow` useCallback. Without this, when comments change
  // (cache subscribe / refetch), threadByLine recomputes →
  // registerRow reidentifies → React swaps ref callbacks → the new
  // mount can't see activeKey and the highlight blinks off.
  const activeKeyRef = useRef<string | null>(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(lsKey, viewed ? "1" : "0");
    } catch {
      // localStorage can fail in private browsing — silently ignore.
    }
  }, [viewed, lsKey]);

  const registerRow = useCallback(
    (rightLine: number, el: HTMLElement | null) => {
      if (!registerThread) return;
      const key = `${file.path}@${rightLine}`;
      const t = threadByLine.get(rightLine) ?? null;
      // Tag the row so onViewUnresolved (PrOverviewTab) can scrollIntoView
      // by querySelector('[data-thread-key="…"]'). Strip when el goes null.
      if (el) {
        el.dataset.threadKey = key;
        rowsByKey.current.set(key, el);
        // Stage 8M — re-apply highlight on remount so it survives
        // ref-callback churn when comments / threadByLine change.
        if (activeKeyRef.current === key) applyAnchorHighlight(el);
      } else {
        const prev = rowsByKey.current.get(key);
        if (prev) clearAnchorHighlight(prev);
        rowsByKey.current.delete(key);
      }
      registerThread(key, el, t);
    },
    [registerThread, threadByLine, file.path],
  );

  // Stage 8L — apply the teal-ring highlight to the row whose key
  // matches activeKey, clear it from all others. Toggling DOM classes
  // directly (rather than re-rendering the row) avoids paying the
  // cost of a parent re-render every time the user clicks a thread.
  useEffect(() => {
    for (const [key, el] of rowsByKey.current) {
      if (key === activeKey) applyAnchorHighlight(el);
      else clearAnchorHighlight(el);
    }
  }, [activeKey]);

  return (
    <div
      className="rounded-lg border border-line-soft overflow-hidden bg-bg-1/30"
      onContextMenu={(e) => {
        // v0.2.12 T.1 — right-click anywhere on the card surfaces the
        // quote-in-chat affordance. We swallow the native menu so the
        // popover lands at the cursor instead.
        e.preventDefault();
        const anchor = e.currentTarget as HTMLElement;
        void openQuoteMenu(anchor);
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 h-9 bg-bg-content/60 border-b border-line-soft/60">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setExpanded((v) => !v)}
          className="w-5 h-5 text-text-4 hover:text-text-1 flex-shrink-0"
        >
          <ChevronIcon expanded={expanded} />
        </Button>
        <span className="font-mono text-[12px] text-text-1 truncate">
          {file.path}
        </span>
        <Churn additions={file.additions} deletions={file.deletions} />

        {language && (
          <span className="text-[11px] text-text-4">{language}</span>
        )}
        {auraFindingCount > 0 && (
          <StatusChip
            tone="amber"
            dense
            icon={<SparkleIcon />}
            title={`Safety check: ${auraFindingCount} thing${auraFindingCount === 1 ? "" : "s"} worth a look in this file`}
          >
            {auraFindingCount}
          </StatusChip>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => setViewed(e.target.checked)}
              className="w-3.5 h-3.5 cursor-pointer"
              style={{ accentColor: "var(--color-accent)" }}
            />
            Viewed
          </label>
          {commentCount > 0 ? (
            // Real action: the diff body renders each thread inline at its
            // line, so clicking the count expands the file to reveal them.
            <button
              type="button"
              className="text-text-4 hover:text-text-1 relative"
              title={`${commentCount} comment${commentCount === 1 ? "" : "s"} — show threads`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
            >
              <BubbleIcon />
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
                style={{ background: "var(--color-violet)" }}
              >
                {commentCount}
              </span>
            </button>
          ) : (
            // No threads → a plain indicator, not a dead button.
            <span className="text-text-5 relative" title="No comments" aria-hidden="true">
              <BubbleIcon />
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="w-5 h-5 text-text-4 hover:text-text-1 flex-shrink-0"
            title="Quote in chat"
            onClick={(e) => {
              e.stopPropagation();
              void openQuoteMenu(e.currentTarget);
            }}
          >
            <MoreDotsIcon />
          </Button>
        </div>
      </div>

      {quotePayload ? (
        <AuraRelayMenu
          repoRoot={repoRoot}
          kind="pr_line"
          payload={quotePayload}
          defaultChannel="pull-requests"
          anchor={quoteAnchor}
          onClose={closeQuoteMenu}
        />
      ) : null}

      {/* Body */}
      {expanded && (
        chunk ? (
          <>
            <PrDiffBody
              repoRoot={repoRoot}
              prNumber={prNumber}
              filePath={file.path}
              body={chunk}
              comments={comments}
              onPosted={onPosted}
              onRegisterRow={registerRow}
              mountEagerly={mountDiffEagerly}
            />
            <FileCardFooter chunkLines={countChunkLines(chunk)} />
          </>
        ) : diffError ? (
          // v0.2.12 — surface the real gh/git error so users can act
          // (re-auth, retry, file an issue) instead of guessing.
          <div className="px-3 py-3 text-[12px]">
            <details className="text-red">
              <summary className="cursor-pointer text-red font-medium">
                Diff unavailable — click for details
              </summary>
              <pre className="mt-2 px-3 py-2 bg-red/5 border border-red/30 rounded text-[11px] text-red/90 whitespace-pre-wrap break-words">
                {diffError.length > 400
                  ? `${diffError.slice(0, 400)}…`
                  : diffError}
              </pre>
            </details>
          </div>
        ) : (
          <div className="px-3 py-3 text-text-4 text-[12px]">
            No diff content (gh returned empty).
          </div>
        )
      )}
    </div>
  );
}

function countChunkLines(chunk: string): number {
  // Line count visible in the rendered diff (skipping the "@@" hunk
  // headers and the "diff --git" preamble). Used for the footer "↕ N
  // lines" stat that mirrors Graphite's per-file footer.
  let n = 0;
  for (const ln of chunk.split("\n")) {
    if (ln.startsWith("@@") || ln.startsWith("diff ") || ln.startsWith("index ")
      || ln.startsWith("---") || ln.startsWith("+++")) continue;
    if (ln.length > 0) n++;
  }
  return n;
}

function FileCardFooter({ chunkLines }: { chunkLines: number }) {
  return (
    <div className="flex items-center justify-end gap-3 px-3 h-7 border-t border-line-soft/40 bg-bg-content/30 text-[10.5px] text-text-4">
      <span className="flex items-center gap-1.5">
        <ExpandGlyph />
        {chunkLines} line{chunkLines === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function ExpandGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
      <path
        d="M5 1l1.5 1.5M5 1L3.5 2.5M5 9l1.5-1.5M5 9L3.5 7.5M5 1v8"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function splitDiffByFile(body: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  type Hit = { idx: number; path: string };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    hits.push({ idx: m.index, path: m[2] });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx;
    const end = i + 1 < hits.length ? hits[i + 1].idx : body.length;
    out.set(hits[i].path, body.slice(start, end));
  }
  return out;
}

// v0.2.12 T.1 — slug form ("rust", "ts") used as the `language` hint in
// the pr_line relay payload, so the receiving card knows what fence to
// label the code block with. Separate from the display name so we don't
// burn "TypeScript" into the wire format.
const LANG_SLUG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  cpp: "cpp",
  cc: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
};

function languageForChunk(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return LANG_SLUG_BY_EXT[ext] ?? null;
}

/** Per-card cap for the snippet inlined into a `pr_line` relay card.
 *  Bigger than the receiving card's render cap (12) so callers can pass
 *  a slightly longer snippet and the card chooses how much to show —
 *  but small enough that a chat fan-out stays bandwidth-cheap. */
const PR_LINE_SNIPPET_LINES = 14;

/** Pull the first block of additions/context out of a unified-diff
 *  chunk so we can preview the meat of the change in a chat card. We
 *  skip diff metadata (`diff --git`, `index`, `---`, `+++`, `@@`) and
 *  strip the leading "+"/" "/"-" markers from each kept line. Returns
 *  at most `cap` lines. */
function extractFirstAdditionsBlock(
  chunk: string,
  cap: number,
): { lines: string[] } {
  if (!chunk) return { lines: [] };
  const out: string[] = [];
  for (const raw of chunk.split("\n")) {
    if (out.length >= cap) break;
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("@@")
    ) {
      continue;
    }
    // Skip pure removals to keep the preview focused on what's new.
    if (raw.startsWith("-")) continue;
    // Drop the leading marker on context (" ") + addition ("+") lines.
    const lead = raw.charAt(0);
    const body = lead === "+" || lead === " " ? raw.slice(1) : raw;
    out.push(body);
  }
  return { lines: out };
}

// Stage 8G — derive a per-file Aura finding count by substring-matching
// the file path against the freeform invariant_violations / blast_radius
// strings the backend emits. Fragile but acceptable until the backend
// surfaces structured per-file findings; gives the user a visible hint
// that "this file is in the AST review danger zone."
function deriveAuraByPath(
  review: AuraReviewPayload | null | undefined,
  files: PrFileStat[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!review) return out;
  const haystacks: string[] = [
    ...review.invariant_violations,
    ...review.blast_radius,
    ...review.cross_branch_conflicts,
  ];
  // unverified_nodes is `unknown` (serde_json::Value); accept array of
  // strings or array of {path,...} objects best-effort.
  const uv = review.unverified_nodes;
  if (Array.isArray(uv)) {
    for (const n of uv) {
      if (typeof n === "string") haystacks.push(n);
      else if (n && typeof n === "object") {
        const obj = n as Record<string, unknown>;
        const path = typeof obj.path === "string" ? obj.path : null;
        const node = typeof obj.node === "string" ? obj.node : null;
        if (path) haystacks.push(path);
        if (node) haystacks.push(node);
      }
    }
  }
  for (const f of files) {
    let n = 0;
    for (const h of haystacks) {
      if (h.includes(f.path)) n += 1;
    }
    if (n > 0) out.set(f.path, n);
  }
  return out;
}

function SparkleIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
    </svg>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
    >
      <path
        d="M2 4l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}

function MoreDotsIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
      <circle cx="2" cy="5" r="0.9" />
      <circle cx="5" cy="5" r="0.9" />
      <circle cx="8" cy="5" r="0.9" />
    </svg>
  );
}

function CompareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M5 3v6a3 3 0 003 3h2M11 13v-6a3 3 0 00-3-3H6"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="5" cy="3" r="1.5" fill="currentColor" />
      <circle cx="11" cy="13" r="1.5" fill="currentColor" />
    </svg>
  );
}

function BubbleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V4a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
