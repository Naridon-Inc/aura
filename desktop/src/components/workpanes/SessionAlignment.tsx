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
import { useEditorStore } from "../../lib/editorStore";
import { StoryMarkdown } from "../story/StoryMarkdown";
import { AgentBadge } from "../agent/AgentBadge";
import { Button } from "../ui/button";
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
    <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
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
        <div className="max-w-[520px] rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3 font-mono text-[11.5px] text-red break-words">
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
                  <Chip>{asked.intentType}</Chip>
                ) : null}
                <span className="ml-auto text-[10.5px] tabular-nums text-text-4">
                  {formatRelative(asked.timestamp)}
                </span>
              </div>
              <div className="px-3.5 py-3 text-[13px] leading-relaxed text-text-1">
                <StoryMarkdown>{asked.text}</StoryMarkdown>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-text-4">
              No task intent was recorded near this commit — the change has no
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
// whether any of it is worth a second look. The "worth a look" signals are
// fully automated and need no goal-linking — an unfinished bit (TODO/stub), a
// possible hard-coded secret, or a deletion. When none are present we say so
// plainly. No match score, no coverage bar, no status dot: a calm card in the
// same neutral language as the rest of the surface.
function ChangeOverview({ report }: { report: IntentReport }) {
  const nodes = useMemo(() => deriveNodes(report), [report]);
  const fileCount = report.changed_files.length;
  const changeCount = nodes.length;

  const secrets = nodes.filter((n) => n.contains_secret).length;
  const stubs = nodes.filter((n) => n.is_stub).length;
  const deletions = nodes.filter((n) => n.change === "deleted").length;

  // The plain "how much changed" line.
  const summary =
    changeCount > 0
      ? `The AI changed ${changeCount} ${changeCount === 1 ? "thing" : "things"}${
          fileCount > 0
            ? ` across ${fileCount} ${fileCount === 1 ? "file" : "files"}`
            : ""
        }.`
      : fileCount > 0
        ? `The AI touched ${fileCount} ${fileCount === 1 ? "file" : "files"} — settings or data, not code Aura breaks down piece by piece.`
        : "No file changes were recorded for this run.";

  // The safety line. Secrets are the loudest; stubs / deletions are "worth a
  // look". Anything else reads clean.
  const worth: string[] = [];
  if (stubs > 0)
    worth.push(`${stubs} unfinished ${stubs === 1 ? "bit" : "bits"} (a TODO/placeholder)`);
  if (deletions > 0)
    worth.push(`${deletions} ${deletions === 1 ? "deletion" : "deletions"}`);

  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <p className="text-[13px] font-medium leading-snug text-text-1">{summary}</p>

      {secrets > 0 ? (
        <p
          className="mt-2 text-[12.5px] leading-snug"
          style={{ color: "var(--color-red)" }}
        >
          Heads up — {secrets} {secrets === 1 ? "spot looks" : "spots look"} like a
          password or key written straight into the code. Worth checking before this
          goes anywhere.
        </p>
      ) : worth.length > 0 ? (
        <p
          className="mt-2 text-[12.5px] leading-snug"
          style={{ color: "var(--color-amber)" }}
        >
          Worth a look: {joinWorth(worth)}. Nothing else here looks risky.
        </p>
      ) : changeCount > 0 || fileCount > 0 ? (
        <p className="mt-2 text-[12.5px] leading-snug text-text-3">
          Nothing here looks risky — no unfinished code, no deletions, no secrets.
        </p>
      ) : null}
    </div>
  );
}

function joinWorth(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// ── Said ───────────────────────────────────────────────────────────────

function SaidRow({ stated }: { stated: StatedIntent }) {
  return (
    <div className="border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <div className="mb-1 flex items-center gap-2">
        <AgentBadge agentId={stated.agent_id} />
        {stated.intent_type ? <Chip>{stated.intent_type}</Chip> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-text-4">
          {formatRelative(stated.timestamp)}
        </span>
      </div>
      <div className="text-[12.5px] leading-relaxed text-text-2">
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

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <SectionLabel>What changed</SectionLabel>
        <span className="flex items-center gap-1.5 text-[11px] text-text-4">
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
        <p className="text-[12.5px] leading-relaxed text-text-4">
          No code-level changes to break down here
          {fileCount > 0 ? (
            <>
              {" "}
              — the {fileCount} changed file{fileCount === 1 ? "" : "s"} changed in
              a way Aura doesn&apos;t track piece-by-piece (settings, data, or
              generated files)
            </>
          ) : null}
          .
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
            {(showAll ? sorted : sorted.slice(0, NODE_LIMIT)).map((node, i) => (
              <NodeRow
                key={`${node.identifier}-${i}`}
                node={node}
                onDismiss={onDismiss}
              />
            ))}
          </div>
          {sorted.length > NODE_LIMIT ? (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 px-0 text-[11px] text-text-3 hover:text-text-1"
            >
              {showAll
                ? "Show fewer"
                : `Show ${sorted.length - NODE_LIMIT} more change${
                    sorted.length - NODE_LIMIT === 1 ? "" : "s"
                  }`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

const NODE_LIMIT = 18;

function NodeRow({ node, onDismiss }: { node: NodeRef; onDismiss?: () => void }) {
  const editor = useEditorStore();
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
    editor.openTraceTool("rewind", { identifier: node.identifier, file });
    onDismiss?.();
  };

  const sig = node.signature?.trim();
  const sub = file ? `${file}${line ? `:${line}` : ""}` : sig || null;

  return (
    <div className="group border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <KindGlyph kind={node.kind} />
        <span
          className="min-w-0 truncate font-mono text-[12.5px] text-text-1"
          title={node.identifier}
        >
          {node.identifier}
        </span>
        <ChangeBadge change={node.change} />
        {node.is_stub ? (
          <RiskChip tone="amber" title="Looks unfinished — a TODO or placeholder">
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
              className="text-[10.5px] text-text-4 hover:text-text-1"
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
            className="text-[10.5px] text-text-4 hover:text-text-1"
          >
            Rewind
          </Button>
        </div>
      </div>
      {sub ? (
        <div className="mt-1 truncate pl-[26px] font-mono text-[10.5px] text-text-4" title={sub}>
          {sub}
        </div>
      ) : null}
      {node.rationale ? (
        <div className="mt-1.5 pl-[26px] text-[12px] text-text-2">
          <StoryMarkdown compact>{node.rationale}</StoryMarkdown>
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
    <p className="text-[11px] leading-relaxed text-text-4">
      <span className="font-mono text-text-3">Time machine</span> puts one part of this
      change back the way it was — just that part, nothing else. Aura keeps a copy
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
    <div className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-text-4">
      {children}
    </div>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded border border-line-soft bg-bg-2 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-text-3"
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
      className="shrink-0 rounded px-1.5 py-px text-[9.5px]"
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
      className="shrink-0 rounded px-1.5 py-px text-[9.5px]"
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
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line-soft bg-bg-2 font-mono text-[9px] text-text-4">
      {label}
    </span>
  );
}
