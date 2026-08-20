//! Pre-first-message hint for the native Aura chat.
//!
//! Conductor-style: NOT a big centered hero. A calm, compact cluster that sits
//! quietly near the top of the pane (a quiet hint above the composer), not a
//! medallion stranded in the dead-center. One short tagline + a tight pill-row
//! of suggestion chips that prefill the composer. On a personal copy, a single
//! quiet one-line working-copy note (REAL git data) precedes it — never a
//! bordered hero card. Lots of breathing room, nothing oversized.

import * as React from "react";
import { GitBranch } from "lucide-react";
import { api } from "../../../lib/api";
import { worktreeParentName } from "../../../lib/workspaceLabel";
import { CloudGlyph } from "../../ui/cloud-glyph";

/** A single suggestion starter: leading glyph, short label, prefill prompt. */
interface Suggestion {
  label: string;
  prompt: string;
  glyph: React.ReactNode;
}

/** Shared props for the monoline inline glyphs: ~14px, currentColor, calm. */
const glyphProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Checklist + target — "find ready work". */
function ReadyWorkGlyph() {
  return (
    <svg {...glyphProps}>
      <path d="M4 6h8" />
      <path d="M4 12h8" />
      <path d="M4 18h6" />
      <circle cx="17.5" cy="16.5" r="4" />
      <path d="M17.5 14.5v2l1.3 1.3" />
    </svg>
  );
}

/** Map / route — "plan a feature". */
function PlanGlyph() {
  return (
    <svg {...glyphProps}>
      <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z" />
      <path d="M9 4v14" />
      <path d="M15 6v14" />
    </svg>
  );
}

/** Bug — "hunt a bug". */
function BugGlyph() {
  return (
    <svg {...glyphProps}>
      <rect x="8" y="8" width="8" height="11" rx="4" />
      <path d="M8 13H4" />
      <path d="M20 13h-4" />
      <path d="M8.5 9 6.5 6.5" />
      <path d="M15.5 9 17.5 6.5" />
      <path d="M8 17l-3 1.5" />
      <path d="M16 17l3 1.5" />
      <path d="M12 8V5" />
    </svg>
  );
}

/** Book / compass — "explain this codebase". */
function ExplainGlyph() {
  return (
    <svg {...glyphProps}>
      <path d="M4 5.5A2 2 0 0 1 6 4h12v15H6a2 2 0 0 0-2 2V5.5Z" />
      <circle cx="11" cy="11.5" r="3.2" />
      <path d="m12.6 9.9-1 2.2-2.2 1 1-2.2 2.2-1Z" />
    </svg>
  );
}

const SUGGESTIONS: ReadonlyArray<Suggestion> = [
  {
    label: "Find ready work",
    prompt:
      "What's ready to work on right now? Look at what's on the board, skip anything that's blocked, and pick the most important one.",
    glyph: <ReadyWorkGlyph />,
  },
  {
    label: "Plan a feature",
    prompt:
      "Help me plan a new feature. Ask me what we're building, then break it into clear, ordered steps.",
    glyph: <PlanGlyph />,
  },
  {
    label: "Hunt a bug",
    prompt: "There's a bug. Help me reproduce it, find the root cause, and fix it.",
    glyph: <BugGlyph />,
  },
  {
    label: "Explain this codebase",
    prompt:
      "Give me a tour of this codebase. The architecture and the main modules.",
    glyph: <ExplainGlyph />,
  },
];

/** One suggestion chip. Interactive only when an `onPick` handler is given;
 *  otherwise it renders as a calm, non-interactive affordance. */
function SuggestionChip({
  suggestion,
  onPick,
}: {
  suggestion: Suggestion;
  onPick?: (prompt: string) => void;
}) {
  const [hover, setHover] = React.useState(false);
  const interactive = typeof onPick === "function";

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={interactive ? () => onPick?.(suggestion.prompt) : undefined}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      className="inline-flex items-center gap-1.5 text-sm transition-colors"
      style={{
        background: hover ? "var(--color-bg-2)" : "transparent",
        border: "1px solid",
        borderColor: hover ? "var(--color-line)" : "var(--color-line-soft)",
        borderRadius: "999px",
        padding: "4px 10px",
        color: hover ? "var(--color-text-1)" : "var(--color-text-2)",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <span
        className="inline-flex items-center"
        style={{ color: "var(--color-text-4)" }}
      >
        {suggestion.glyph}
      </span>
      <span>{suggestion.label}</span>
    </button>
  );
}

/** The single, quiet identity mark — a small code-bracket frame around a dot,
 *  drawn from the faintest line/text tokens. Deliberately tiny so it reads as a
 *  calm inline hint, not a hero medallion. Echoes `WorkSurfaceEmpty`'s
 *  restraint — recognizably Aura, but it recedes rather than announcing itself. */
function BracketGlyph() {
  return (
    <svg
      width={30}
      height={22}
      viewBox="0 0 56 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-5"
      aria-hidden
    >
      <path d="M18 6 8 20l10 14" />
      <path d="M38 6l10 14-10 14" />
      <circle cx="28" cy="20" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A branch name is "default" — the shared trunk, not a personal copy. We never
 *  show the working-copy context card on these. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

/** Turn a branch name into plain words: drop the leading `work/`, `lane/`, or
 *  `feat/` namespace, then dashes/underscores → spaces. `work/fix-login` reads
 *  as "fix login". Falls back to the raw name if there's nothing to humanize. */
function humanizeBranch(branch: string): string {
  const tail = branch.replace(/^(work|lane|feat|feature|fix|chore)\//, "");
  const words = tail.replace(/[-_]+/g, " ").trim();
  return words || branch;
}

/** Drop the `origin/` (or any remote) prefix from an upstream ref so the base
 *  reads as a plain branch name: `origin/main` → "main". */
function shortBase(ref: string): string {
  return ref.replace(/^[^/]+\//, "");
}

/** The real git context for the current working copy, resolved on mount. Only
 *  fields we could actually read are set — a missing value means "omit that
 *  row", never a placeholder. */
interface ChatContext {
  /** Current branch name, when it's a non-default branch (a personal copy). */
  branch: string;
  /** Base branch this copy was branched from, when we could determine it. */
  base: string | null;
}

/** Resolve the current working copy's git context from real data only. Returns
 *  `null` while loading, when there's no repo root, or when we're on the shared
 *  trunk (main/master) — in which case the caller shows the plain welcome with
 *  no context card. */
function useChatContext(repoRoot?: string): ChatContext | null {
  const [ctx, setCtx] = React.useState<ChatContext | null>(null);

  React.useEffect(() => {
    if (!repoRoot) {
      setCtx(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const branch = (await api.gitBranch(repoRoot)).trim();
        // On the shared trunk there's no "copy" to describe — stay plain.
        if (!branch || DEFAULT_BRANCHES.has(branch)) {
          if (!cancelled) setCtx(null);
          return;
        }
        // Find this branch's upstream to name the base it was branched from.
        // No upstream → look for a default branch that actually exists locally
        // before naming one, so we never invent a base that isn't there.
        let base: string | null = null;
        try {
          const rich = await api.gitBranchesRich(repoRoot);
          const current = rich.find((b) => b.isCurrent && !b.isRemote);
          if (current?.upstream) {
            base = shortBase(current.upstream);
          } else {
            const names = new Set(rich.map((b) => shortBase(b.name)));
            base =
              ["main", "master"].find((d) => names.has(d)) ?? null;
          }
        } catch {
          // Rich branch read failed — keep the headline, omit the base row.
          base = null;
        }
        if (!cancelled) setCtx({ branch, base });
      } catch {
        if (!cancelled) setCtx(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  return ctx;
}

/** The working-copy note, compact: a single quiet line (muted branch icon +
 *  plain-language sentence) instead of a bordered hero card. Shown only on
 *  non-default branches. Names the copy in plain words and, when we could read
 *  it, the base it was branched from — all from REAL git data, never faked. */
function ChatContextNote({
  ctx,
  projectLabel,
  repoRoot,
}: {
  ctx: ChatContext;
  projectLabel?: string;
  repoRoot?: string;
}) {
  // When this chat is a machine worktree, name the project it's a copy OF
  // (the parent folder, e.g. "New Git") rather than the worktree's own hash
  // dir — "a copy of agent-a6f18ff…" reads as gibberish to the audience.
  const parent = repoRoot ? worktreeParentName(repoRoot) : null;
  const copyName = parent
    ? `a copy of ${parent}`
    : projectLabel
    ? `a copy of ${projectLabel}`
    : `a copy called ${humanizeBranch(ctx.branch)}`;

  return (
    <div
      className="inline-flex items-center gap-1.5 text-sm leading-snug"
      style={{ color: "var(--color-text-3)" }}
    >
      <GitBranch size={12} style={{ color: "var(--color-text-4)" }} aria-hidden />
      <span>
        You&rsquo;re working in {copyName}
        {ctx.base ? `, branched from ${ctx.base}` : ""}.
      </span>
    </div>
  );
}

/** Pre-first-message hint: a calm, compact cluster — NOT a centered hero. It
 *  sits near the top of the pane (a quiet hint above the composer): a small
 *  inline bracket glyph beside a short tagline, a tight pill-row of suggestion
 *  chips that prefill the composer via `onPick`, and, on a personal copy, a
 *  single quiet working-copy line built from real git data. */
export function ChatEmptyState({
  onPick,
  projectLabel,
  repoRoot,
  machineName,
}: {
  onPick?: (prompt: string) => void;
  projectLabel?: string;
  repoRoot?: string;
  /** Set when this conversation's hands are on a connected machine. Same
   *  opening, same chips — the one line underneath changes, because the
   *  working copy being described is over there. */
  machineName?: string;
}) {
  // The local working-copy line is read from this laptop's git. On a
  // conversation whose hands are on a box that would be a confident sentence
  // about the wrong checkout, so we don't ask for it at all.
  const ctx = useChatContext(machineName ? undefined : repoRoot);

  return (
    <div className="flex flex-col items-start gap-3 px-6 pt-10 pb-2 select-none">
      <div className="flex items-center gap-2">
        <BracketGlyph />
        <span className="text-base" style={{ color: "var(--color-text-3)" }}>
          Ask Aura to plan a feature, hunt a bug, or explain the codebase.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 max-w-[480px]">
        {SUGGESTIONS.map((suggestion) => (
          <SuggestionChip key={suggestion.label} suggestion={suggestion} onPick={onPick} />
        ))}
      </div>
      {machineName ? (
        <div className="mt-0.5">
          <MachineNote machineName={machineName} />
        </div>
      ) : ctx ? (
        <div className="mt-0.5">
          <ChatContextNote ctx={ctx} projectLabel={projectLabel} repoRoot={repoRoot} />
        </div>
      ) : null}
    </div>
  );
}

/** The same quiet one-liner the local chat gets, saying the one thing that is
 *  actually different: which disk the answers come from. Worth stating plainly
 *  — everything else on screen is identical, which is the point, and that is
 *  exactly what makes an unlabelled remote chat easy to mistake for a local
 *  one. */
function MachineNote({ machineName }: { machineName: string }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 text-sm leading-snug"
      style={{ color: "var(--color-text-3)" }}
    >
      <CloudGlyph size={12} />
      <span>
        Reading and running on {machineName}. The conversation is kept here.
      </span>
    </div>
  );
}
