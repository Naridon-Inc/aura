// SessionAlignment — the Alignment tab body of a session detail.
//
// It answers one question about this run's committed change: does the code
// match what was asked? Rebuilt from scratch in the session-detail language
// (the same verdict-hero + SectionLabel'd spec cards as Summary and
// Attestation) instead of the numbered-rail "story" the standalone Intent↔AST
// page uses — so the wizard reads as one consistent card front to back.
//
// Verdict-first, then the supporting beats as calm stacked sections:
//
//   • Verdict   — Matches task / Needs review / No clear match + coverage bar
//   • Asked     — the closest recorded signal to the original ask
//   • Said      — what the agent logged as it worked (when present)
//   • Changed   — what actually changed, per symbol, risk-first
//   • Recover   — surgical per-symbol rewind, explained
//
// Data is the shared `aura intent-vs-actual show` report, loaded by the pane
// and passed in. The asked/said split, node derivation, and verdict tone come
// from IntentStory's shared helpers so the two surfaces never disagree on the
// facts — only on how they're drawn.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ClaudeSession } from "../../lib/api";
import { humanizeIdentifier } from "../../lib/prove";
import { intentTypeChip } from "../../lib/intentTypeLabels";
import { StoryMarkdown } from "../story/StoryMarkdown";
import { AgentBadge } from "../agent/AgentBadge";
import { Button } from "../ui/button";
import { goToTrace } from "../trace/traceRoute";
import { sentenceCase } from "../../lib/textCase";
import {
  changeCounts,
  changeSummary,
  safetyLine,
  type SafetyTone,
} from "../../lib/changeSafety";
import {
  deriveAskedSaid,
  deriveNodes,
  formatRelative,
  type IntentReport,
  type NodeRef,
  type StatedIntent,
} from "./IntentStory";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="section-label">
      {children}
    </h2>
  );
}

export function SessionAlignment({
  repoRoot,
  report,
  sessions,
  loading,
  error,
  onDismiss,
}: {
  repoRoot: string;
  report: IntentReport | null;
  sessions: ClaudeSession[];
  loading: boolean;
  error: string | null;
  /** Closes the fullscreen session overlay. Open / Rewind route to the editor
   *  *behind* this overlay, so without dismissing it the click looks dead —
   *  we call this after firing the action so the result is actually visible. */
  onDismiss?: () => void;
}) {
  if (loading) {
    return <Centered>reading how this change lines up…</Centered>;
  }
  if (error) {
    return (
      <div className="flex h-full items-start justify-center px-6 pt-10">
        <div className="max-w-[520px] rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3 font-mono text-sm text-red break-words">
          {error}
        </div>
      </div>
    );
  }
  if (!report) {
    return <Centered>No alignment report for this run yet.</Centered>;
  }

  const { asked, said } = deriveAskedSaid(report, sessions);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-4">
        {/* 1 · Overview — plain-language: what the AI changed + is any of it
            worth a second look. No match score, no goal-linking — just the two
            things a non-engineer asked for ("is it safe, and what happened"). */}
        <ChangeOverview report={report} />

        {/* 2 · Asked — the closest recorded signal to the original ask. */}
        <section>
          <div className="mb-2.5">
            <SectionLabel>Asked</SectionLabel>
          </div>
          {asked ? (
            <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
              <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
                <AgentBadge agentId={asked.agentId} />
                {asked.fromSession ? (
                  <Chip title="The user's first message in the correlated session">
                    prompt
                  </Chip>
                ) : asked.intentType ? (
                  <Chip>{intentTypeChip(asked.intentType)}</Chip>
                ) : null}
                <span className="ml-auto text-xs tabular-nums text-text-4">
                  {formatRelative(asked.timestamp)}
                </span>
              </div>
              <div className="px-3.5 py-3 text-base leading-relaxed text-text-1">
                <StoryMarkdown>{asked.text}</StoryMarkdown>
              </div>
            </div>
          ) : (
            <p className="text-base leading-relaxed text-text-4">
              No task intent was recorded near this commit. The change has no
              stated origin to compare against.
            </p>
          )}
        </section>

        {/* 3 · Said — what the agent logged as it worked. */}
        {said.length > 0 ? (
          <section>
            <div className="mb-2.5">
              <SectionLabel>
                Said
                <span className="ml-1.5 font-normal text-text-4">
                  what the agent logged
                </span>
              </SectionLabel>
            </div>
            <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
              {said.map((s, i) => (
                <SaidRow key={i} stated={s} />
              ))}
            </div>
          </section>
        ) : null}

        {/* 4 · Changed — what actually changed, per symbol, risk-first. */}
        <ChangedSection report={report} onDismiss={onDismiss} />

        {/* 5 · Recover — surgical rewind, explained. */}
        <RecoverNote repoRoot={repoRoot} report={report} />
      </div>
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────

// The lead card. Two facts, in plain words: *how much* the AI changed, and
// whether any of it is worth a second look. Both come from `lib/changeSafety`,
// which carries the one thing this card used to leave out — how much of the
// run the scan actually covered.
//
// The signals (an unfinished bit, a possible hard-coded secret, a deletion)
// live on the report's structured `nodes`, and the CLI emits those only for
// symbols it could resolve back to a parsed AST node, dropping the list
// entirely when none resolved. The card filtered that list for secrets and,
// finding none in a list that was never populated, told a non-engineer there
// were none. It now says what it checked.
function ChangeOverview({ report }: { report: IntentReport }) {
  const counts = useMemo(() => changeCounts(report), [report]);
  const line = useMemo(() => safetyLine(counts), [counts]);

  const TONE_COLOR: Record<SafetyTone, string | undefined> = {
    risk: "var(--color-red)",
    attention: "var(--color-amber)",
    calm: undefined,
  };

  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <p className="text-base font-medium leading-snug text-text-1">
        {changeSummary(counts)}
      </p>

      {line.kind !== "none" && (
        <p
          className={`mt-2 text-base leading-snug${
            line.tone === "calm" ? " text-text-3" : ""
          }`}
          style={TONE_COLOR[line.tone] ? { color: TONE_COLOR[line.tone] } : undefined}
        >
          {line.text}
        </p>
      )}
    </div>
  );
}

// ── Said ───────────────────────────────────────────────────────────────

function SaidRow({ stated }: { stated: StatedIntent }) {
  return (
    <div className="border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <div className="mb-1 flex items-center gap-2">
        <AgentBadge agentId={stated.agent_id} />
        {stated.intent_type ? <Chip>{intentTypeChip(stated.intent_type)}</Chip> : null}
        <span className="ml-auto text-xs tabular-nums text-text-4">
          {formatRelative(stated.timestamp)}
        </span>
      </div>
      <div className="text-base leading-relaxed text-text-2">
        <StoryMarkdown compact>{stated.intent}</StoryMarkdown>
      </div>
    </div>
  );
}

// ── Changed ────────────────────────────────────────────────────────────

function ChangedSection({
  report,
  onDismiss,
}: {
  report: IntentReport;
  onDismiss?: () => void;
}) {
  const nodes = useMemo(() => deriveNodes(report), [report]);
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => {
    // Risk-first, not match-first: anything worth a second look floats up so
    // it's the first thing seen. A possible secret beats an unfinished bit
    // beats a deletion; ordinary edits and additions settle to the bottom.
    const riskScore = (n: NodeRef) =>
      (n.contains_secret ? 4 : 0) +
      (n.is_stub ? 2 : 0) +
      (n.change === "deleted" ? 1 : 0);
    const rank = { modified: 0, added: 1, deleted: 2 } as const;
    return [...nodes].sort((a, b) => {
      const ra = riskScore(a);
      const rb = riskScore(b);
      if (ra !== rb) return rb - ra;
      return rank[a.change] - rank[b.change];
    });
  }, [nodes]);

  const fileCount = report.changed_files.length;

  // Capabilities lead — the named things a person can reason about (a function,
  // a class, a component). Bare values (a local, a constant) are internal
  // mechanics: kept, but folded under a quiet toggle so the real features read
  // first. With no capabilities, the values stand alone and open by default.
  const capabilities = useMemo(() => sorted.filter(isCapabilityNode), [sorted]);
  const values = useMemo(
    () => sorted.filter((n) => !isCapabilityNode(n)),
    [sorted],
  );
  const shownCaps = showAll ? capabilities : capabilities.slice(0, NODE_LIMIT);

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <SectionLabel>What changed</SectionLabel>
        <span className="flex items-center gap-1.5 text-xs text-text-4">
          {nodes.length > 0 ? (
            <span className="tabular-nums">
              {nodes.length} change{nodes.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {fileCount > 0 ? (
            <>
              <span className="text-text-5">·</span>
              <span className="tabular-nums">
                {fileCount} file{fileCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </span>
      </div>

      {nodes.length === 0 ? (
        <p className="text-base leading-relaxed text-text-4">
          No code-level changes to break down here
          {fileCount > 0 ? (
            <>
              {" "}, the {fileCount} changed file{fileCount === 1 ? "" : "s"} changed in
              a way Aura doesn&apos;t track piece-by-piece (settings, data, or
              generated files)
            </>
          ) : null}
          .
        </p>
      ) : (
        <>
          {shownCaps.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
              {shownCaps.map((node, i) => (
                <NodeRow
                  key={`${node.identifier}-${i}`}
                  node={node}
                  onDismiss={onDismiss}
                />
              ))}
            </div>
          ) : null}
          {capabilities.length > NODE_LIMIT ? (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 px-0 text-xs text-text-3 hover:text-text-1"
            >
              {showAll
                ? "Show fewer"
                : `Show ${capabilities.length - NODE_LIMIT} more`}
            </Button>
          ) : null}
          {values.length > 0 ? (
            <SupportingChanges
              nodes={values}
              onDismiss={onDismiss}
              defaultOpen={capabilities.length === 0}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

const NODE_LIMIT = 18;

// A "capability" is a named thing a person can reason about — a function,
// method, class, component. Bare values (a local, a constant, a type alias) are
// internal mechanics. Unknown/blank kinds count as capabilities so a change we
// simply couldn't classify is never hidden.
const CAPABILITY_KIND =
  /function|fn|method|class|interface|enum|struct|trait|component|hook|constructor|module/i;
function isCapabilityNode(n: NodeRef): boolean {
  const k = (n.kind || "").toLowerCase();
  return k === "" || CAPABILITY_KIND.test(k);
}

// A plain noun for the kind — what a person would call this piece of code.
function kindNoun(kind: string): string {
  const k = (kind || "").toLowerCase();
  if (k.includes("class")) return "class";
  if (k.includes("component")) return "component";
  if (k.includes("hook")) return "hook";
  if (k.includes("method")) return "method";
  if (k.includes("constructor")) return "setup";
  if (k.includes("function") || k === "fn") return "function";
  if (k.includes("interface")) return "interface";
  if (k.includes("enum")) return "enum";
  if (k.includes("type")) return "type";
  if (
    k.includes("variable") ||
    k.includes("declarator") ||
    k.includes("const") ||
    k.includes("field") ||
    k.includes("property")
  )
    return "value";
  return "code";
}

function NodeRow({ node, onDismiss }: { node: NodeRef; onDismiss?: () => void }) {
  const file = node.file ?? undefined;
  const line = node.start_line ?? undefined;

  // Both actions land in the editor *behind* this fullscreen session overlay,
  // so we dismiss it right after firing — otherwise the click looks dead.
  const openFile = () => {
    if (!file) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-file", { detail: { path: file, line } }),
    );
    onDismiss?.();
  };
  const rewind = () => {
    goToTrace({
      kind: "tool",
      tool: "rewind",
      arg: { identifier: node.identifier, file },
    });
    onDismiss?.();
  };

  const sig = node.signature?.trim();
  // Non-coder first: the plain-language name leads. The exact symbol, its kind,
  // and where it lives are demoted to a small dimmed detail line below.
  const plain = sentenceCase(humanizeIdentifier(node.identifier)) || node.identifier;
  const kindWord = kindNoun(node.kind);
  const loc = file ? `${file}${line ? `:${line}` : ""}` : sig || null;

  return (
    <div className="group border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <KindGlyph kind={node.kind} />
        <span
          className="min-w-0 truncate text-base font-medium text-text-1"
          title={node.identifier}
        >
          {plain}
        </span>
        <ChangeBadge change={node.change} />
        {node.is_stub ? (
          <RiskChip tone="amber" title="Looks unfinished. A TODO or placeholder">
            unfinished
          </RiskChip>
        ) : null}
        {node.contains_secret ? (
          <RiskChip tone="red" title="Looks like a password or key written into the code">
            possible secret
          </RiskChip>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {file ? (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={openFile}
              title={`Open ${file}${line ? `:${line}` : ""}`}
              className="text-xs text-text-4 hover:text-text-1"
            >
              Open
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={rewind}
            title="Put this part back the way it was"
            className="text-xs text-text-4 hover:text-text-1"
          >
            Rewind
          </Button>
        </div>
      </div>
      {/* Coder detail, demoted: kind · the exact symbol · where it lives. */}
      <div className="mt-1 flex items-center gap-1.5 pl-[26px] text-xs text-text-4">
        <span className="shrink-0 capitalize">{kindWord}</span>
        <span className="text-text-5">·</span>
        <code
          className="shrink-0 rounded border border-line-soft bg-bg-2 px-1 py-px font-mono text-2xs text-text-3"
          title="The exact name in the code"
        >
          {node.identifier}
        </code>
        {loc ? (
          <>
            <span className="text-text-5">·</span>
            <span className="min-w-0 truncate font-mono" title={loc}>
              {loc}
            </span>
          </>
        ) : null}
      </div>
      {node.rationale ? (
        <div className="mt-1.5 pl-[26px] text-sm text-text-2">
          <StoryMarkdown compact>{node.rationale}</StoryMarkdown>
        </div>
      ) : null}
    </div>
  );
}

// Internal values (locals, constants) that changed — real, but not new
// features. Folded away by default so capabilities lead; a non-engineer can
// open them if they want the full picture.
function SupportingChanges({
  nodes,
  onDismiss,
  defaultOpen,
}: {
  nodes: NodeRef[];
  onDismiss?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-text-4 transition-colors hover:text-text-2"
      >
        <span className="font-mono text-2xs leading-none">
          {open ? "▾" : "▸"}
        </span>
        <span className="tabular-nums">
          {nodes.length} supporting change{nodes.length === 1 ? "" : "s"}
        </span>
        <span className="text-text-5">. Internal values, not new features</span>
      </button>
      {open ? (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line-soft bg-bg-1">
          {nodes.map((node, i) => (
            <NodeRow
              key={`${node.identifier}-${i}`}
              node={node}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Recover ────────────────────────────────────────────────────────────

function RecoverNote({ repoRoot, report }: { repoRoot: string; report: IntentReport }) {
  const [count, setCount] = useState<number | null>(null);
  const changed = useMemo(() => new Set(report.changed_files), [report.changed_files]);

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    api
      .auraListSnapshotsV2(repoRoot, 200)
      .then((page) => {
        if (cancelled) return;
        setCount(page.entries.filter((e) => changed.has(e.file)).length);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, changed]);

  return (
    <p className="text-xs leading-relaxed text-text-4">
      <span className="font-mono text-text-3">Time machine</span> puts one part of this
      change back the way it was, just that part, nothing else. Aura keeps a copy
      of every file from before the AI touched it, so you can always undo.
      {count !== null && count > 0 ? (
        <>
          {" "}
          It has {count} saved version{count === 1 ? "" : "s"} of the file
          {report.changed_files.length === 1 ? "" : "s"} this change touched.
        </>
      ) : null}
    </p>
  );
}

// ── Small parts ────────────────────────────────────────────────────────

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-base text-text-4">
      {children}
    </div>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="meta-tag"
    >
      {children}
    </span>
  );
}

function RiskChip({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone: "amber" | "red";
  title?: string;
}) {
  const color = tone === "amber" ? "var(--color-amber)" : "var(--color-red)";
  return (
    <span
      title={title}
      className="shrink-0 rounded px-1.5 py-px text-2xs"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `0.5px solid color-mix(in oklab, ${color} 32%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function ChangeBadge({ change }: { change: NodeRef["change"] }) {
  const map = {
    added: { label: "added", color: "var(--color-accent-green)" },
    modified: { label: "modified", color: "var(--color-text-3)" },
    deleted: { label: "deleted", color: "var(--color-red)" },
  } as const;
  const m = map[change];
  return (
    <span
      className="shrink-0 rounded px-1.5 py-px text-2xs"
      style={{
        color: m.color,
        background: `color-mix(in oklab, ${m.color} 12%, transparent)`,
      }}
    >
      {m.label}
    </span>
  );
}

// A minimal glyph hinting the node kind; generic dot when the CLI didn't carry
// a kind (synthesized nodes).
function KindGlyph({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  const label = k.includes("class")
    ? "C"
    : k.includes("method")
      ? "M"
      : k.includes("function") || k.includes("fn")
        ? "ƒ"
        : "•";
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line-soft bg-bg-2 font-mono text-2xs text-text-4">
      {label}
    </span>
  );
}
