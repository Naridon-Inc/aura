// IntentStory — the "change story" renderer, shared by the Intent ↔ AST page
// (IntentInspector) and the Session Detail "Alignment" tab.
//
// It narrates one commit top-to-bottom as a sequence of beats:
//
//   1. Asked   — the closest recorded signal to the original ask
//   2. Said    — what the AI said it would do (typed intents)
//   3. Did     — what actually changed, as per-symbol cards (the heart)
//   4. Lines up— does the code match the ask? (verdict as conclusion)
//   5. Recover — snapshots + per-symbol rewind, if something's wrong
//
// Data: `aura intent-vs-actual show <sha> --json` via the `api.auraCli`
// passthrough — exposed here as the `useIntentReport(repoRoot, sha)` hook so
// both call sites load a report the same way. The report's node lists are
// plain strings on older binaries; deriveNodes() synthesizes the same card
// shape from the string arrays so the page works on either. Recovery
// snapshots come from `aura_list_snapshots_v2`; per-symbol rewind opens the
// existing Trace rewind tool via the editor store. No new Tauri commands.
//
// Extracted from IntentInspector.tsx so the session-level Alignment tab reads
// identically to the standalone page (one renderer, no drift). The standalone
// page keeps its left timeline + this story as the right pane; the Alignment
// tab mounts the story alone with `showHeader={false}` (the session header
// already carries the commit's title + chips).

import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeSession, type IntentChangesetFile } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { StoryMarkdown } from "../story/StoryMarkdown";
import { AgentBadge } from "../agent/AgentBadge";
import { Button } from "../ui/button";
import { isAutoStubText, nearestSessionByTime } from "../../lib/sessionMeta";

export type StatedIntent = {
  timestamp: number;
  agent_id: string;
  intent: string;
  intent_type?: string | null;
};

// Structured per-symbol change. Emitted by `intent-vs-actual show` once
// the CLI carries it; until then deriveNodes() synthesizes the same shape
// (minus file/line/signature/rationale) from the string arrays.
export type NodeRef = {
  identifier: string;
  kind: string;
  change: "added" | "modified" | "deleted";
  file?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  signature?: string | null;
  is_stub?: boolean;
  contains_secret?: boolean;
  covered?: boolean;
  rationale?: string | null;
};

export type IntentReport = {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_time: number;
  author: string;
  stated: StatedIntent[];
  modified_nodes: string[];
  added_nodes: string[];
  deleted_nodes: string[];
  aligned_nodes: string[];
  mismatched_nodes: string[];
  alignment_score: number;
  banner: "aligned" | "drift" | "diverged";
  changed_files: string[];
  // Forward-compatible: present once the CLI emits structured nodes.
  nodes?: NodeRef[];
};

// ── Report loading ───────────────────────────────────────────────────

/** Load the per-commit alignment report for one sha. `sha === null` is the
 *  idle state — no fetch, no error — so a caller can gate the CLI call on a
 *  tab being active. Re-fetches whenever repoRoot or sha changes. */
export function useIntentReport(
  repoRoot: string,
  sha: string | null,
): { report: IntentReport | null; loading: boolean; error: string | null } {
  const [report, setReport] = useState<IntentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sha) {
      setReport(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .auraCli(repoRoot, ["intent-vs-actual", "show", sha, "--json"])
      .then((r) => {
        if (cancelled) return;
        if (r.status !== 0) {
          setError(r.stderr.trim() || `aura exit ${r.status}`);
          setReport(null);
          setLoading(false);
          return;
        }
        try {
          setReport(JSON.parse(r.stdout) as IntentReport);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, sha]);

  return { report, loading, error };
}

// ── Session-level report (whole run, every commit) ───────────────────

/** Merge several per-commit reports into one run-level report. A single run
 *  usually lands as several commits; judging only the first (what the raw
 *  single-commit hook does) leaves "what changed" empty whenever that first
 *  commit happens to be a deps bump / merge / non-code touch while the real
 *  symbol work lives in later commits — even though the Changes tab counts
 *  files across all of them. Unioning the node + file + intent lists gives the
 *  whole run's picture; coverage is recomputed so the verdict stays honest.
 *  The newest commit supplies the representative metadata. */
export function mergeIntentReports(reports: IntentReport[]): IntentReport | null {
  const live = reports.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  const head = [...live].sort((a, b) => b.commit_time - a.commit_time)[0];
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

  const modified = uniq(live.flatMap((r) => r.modified_nodes));
  const added = uniq(live.flatMap((r) => r.added_nodes));
  const deleted = uniq(live.flatMap((r) => r.deleted_nodes));
  const aligned = uniq(live.flatMap((r) => r.aligned_nodes));
  const mismatched = uniq(live.flatMap((r) => r.mismatched_nodes));
  const changed_files = uniq(live.flatMap((r) => r.changed_files));

  // Dedupe stated intents by (time, agent, text) — the same note can recur
  // when a file is touched across more than one of the run's commits.
  const statedSeen = new Set<string>();
  const stated: StatedIntent[] = [];
  for (const r of live) {
    for (const s of r.stated) {
      const k = `${s.timestamp}|${s.agent_id}|${s.intent}`;
      if (statedSeen.has(k)) continue;
      statedSeen.add(k);
      stated.push(s);
    }
  }
  stated.sort((a, b) => a.timestamp - b.timestamp);

  // Structured nodes (rich cards w/ file+line+rationale), deduped by identity.
  const nodeSeen = new Set<string>();
  const nodes: NodeRef[] = [];
  for (const r of live) {
    for (const n of r.nodes ?? []) {
      const k = `${n.identifier}|${n.change}|${n.file ?? ""}`;
      if (nodeSeen.has(k)) continue;
      nodeSeen.add(k);
      nodes.push(n);
    }
  }

  const totalChanged = modified.length + added.length + deleted.length;
  const score =
    totalChanged > 0 ? Math.min(1, aligned.length / totalChanged) : head.alignment_score ?? 0;
  const banner: IntentReport["banner"] =
    stated.length === 0
      ? "diverged"
      : mismatched.length === 0
        ? "aligned"
        : aligned.length >= mismatched.length
          ? "drift"
          : "diverged";

  return {
    ...head,
    stated,
    modified_nodes: modified,
    added_nodes: added,
    deleted_nodes: deleted,
    aligned_nodes: aligned,
    mismatched_nodes: mismatched,
    changed_files,
    nodes: nodes.length > 0 ? nodes : undefined,
    alignment_score: score,
    banner,
  };
}

/** Run-level alignment report: load `intent-vs-actual show` for every distinct
 *  commit in the run's changeset and merge them, so the Alignment tab judges
 *  the whole run (matching the Changes tab's file scope) instead of just the
 *  first commit. `active === false` is the idle gate (no fetch) so the CLI
 *  fan-out stays off the Summary-first open. Best-effort per commit — a commit
 *  whose report fails is skipped, and the tab only errors when *every* commit
 *  fails. Keys on the distinct-commit set, so it won't refire on unrelated
 *  re-renders even though `files` is a fresh array each time. */
export function useSessionIntentReport(
  repoRoot: string,
  files: IntentChangesetFile[],
  active: boolean,
): { report: IntentReport | null; loading: boolean; error: string | null } {
  const commitKey = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      const c = (f.commit ?? "").trim();
      if (c) set.add(c);
    }
    return [...set].sort().join(",");
  }, [files]);

  const [report, setReport] = useState<IntentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !repoRoot || !commitKey) {
      setReport(null);
      setLoading(false);
      setError(null);
      return;
    }
    const commits = commitKey.split(",");
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(
      commits.map((sha) =>
        api
          .auraCli(repoRoot, ["intent-vs-actual", "show", sha, "--json"])
          .then((r) => {
            if (r.status !== 0) return null;
            try {
              return JSON.parse(r.stdout) as IntentReport;
            } catch {
              return null;
            }
          })
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const live = results.filter((r): r is IntentReport => r !== null);
      if (live.length === 0) {
        setReport(null);
        setError(
          `Couldn't read changes for ${commits.length} commit${commits.length === 1 ? "" : "s"}.`,
        );
      } else {
        setReport(mergeIntentReports(live));
        setError(null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [repoRoot, commitKey, active]);

  return { report, loading, error };
}

// ── The story ────────────────────────────────────────────────────────

// A normalized "Asked" beat — either the user's real prompt (from the
// correlated Claude session) or, failing that, the earliest genuine logged
// intent. `fromSession` drives the provenance line.
export type AskedNode = {
  text: string;
  agentId: string;
  timestamp: number;
  intentType?: string | null;
  fromSession: boolean;
};

/** Split a report's stated intents into the user's "asked" (the correlated
 *  session's first prompt, else the earliest genuine logged intent) and the
 *  "said" (every other genuine intent). Guard `[auto]` placeholders are
 *  dropped — they name no real work. Shared by the standalone story and the
 *  session Alignment tab so both read the same beats from one rule. */
export function deriveAskedSaid(
  report: IntentReport,
  sessions: ClaudeSession[],
): { asked: AskedNode | null; said: StatedIntent[] } {
  const genuine = [...report.stated]
    .filter((s) => !isAutoStubText(s.intent))
    .sort((a, b) => a.timestamp - b.timestamp);

  const sess = nearestSessionByTime(report.commit_time, sessions);
  const sessionPrompt = sess?.first_prompt?.trim() || "";
  if (sessionPrompt) {
    return {
      asked: {
        text: sessionPrompt,
        agentId: "claude",
        timestamp: sess ? sess.mtime : report.commit_time,
        fromSession: true,
      },
      said: genuine,
    };
  }
  if (genuine.length > 0) {
    const first = genuine[0];
    return {
      asked: {
        text: first.intent,
        agentId: first.agent_id,
        timestamp: first.timestamp,
        intentType: first.intent_type,
        fromSession: false,
      },
      said: genuine.slice(1),
    };
  }
  return { asked: null, said: [] };
}

export function IntentStory({
  repoRoot,
  report,
  sessions,
  loading,
  error,
  showHeader = true,
}: {
  repoRoot: string;
  report: IntentReport | null;
  sessions: ClaudeSession[];
  loading: boolean;
  error: string | null;
  /** Show the commit title + verdict pill at the top. The standalone page
   *  wants it; the Alignment tab hides it (the session header already carries
   *  the title) and leads straight into the beats. */
  showHeader?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex-1 min-w-0 px-5 py-4 text-text-4 text-[12px]">
        reading this change…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 min-w-0 px-5 py-4 text-red-400 text-[11px] font-mono">
        {error}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="flex-1 min-w-0 px-5 py-4 text-text-4 text-[12px]">
        Pick a change from the timeline to read its story.
      </div>
    );
  }

  // Prefer the user's actual prompt as "Asked", every genuine logged intent as
  // "Said" — one shared rule (also used by the session Alignment tab).
  const { asked, said } = deriveAskedSaid(report, sessions);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-[680px] mx-auto px-4 py-4">
        {showHeader && <StoryHeader report={report} />}
        <div className={showHeader ? "mt-6 space-y-6" : "space-y-6"}>
          <Beat n={1} label="Asked" hint="closest recorded signal">
            <AskedBeat asked={asked} />
          </Beat>
          {said.length > 0 && (
            <Beat n={2} label="Said" hint="what the AI logged as it worked">
              <SaidBeat said={said} />
            </Beat>
          )}
          <Beat n={said.length > 0 ? 3 : 2} label="Did" hint="what actually changed">
            <DidBeat report={report} />
          </Beat>
          <Beat n={said.length > 0 ? 4 : 3} label="Lines up?" hint="does the code match the ask">
            <VerdictBeat report={report} />
          </Beat>
          <Beat
            n={said.length > 0 ? 5 : 4}
            label="Recover"
            hint="if something's wrong"
            last
          >
            <RecoverBeat repoRoot={repoRoot} report={report} />
          </Beat>
        </div>
      </div>
    </div>
  );
}

export function StoryHeader({ report }: { report: IntentReport }) {
  const tone = bannerTone(report);
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-text-1 font-medium leading-snug break-words">
            {report.commit_message?.split("\n")[0] || "(no message)"}
          </div>
          <div className="text-[10.5px] text-text-4 mt-1 font-mono">
            {report.commit_short} · {report.author} ·{" "}
            {formatAbsolute(report.commit_time)}
          </div>
        </div>
        <span
          className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border"
          style={{ color: tone.color, borderColor: tone.color, background: tone.bg }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: tone.color }}
          />
          {tone.label}
        </span>
      </div>
    </div>
  );
}

// Vertical-rail beat: a numbered node on a connector line, label, content.
export function Beat({
  n,
  label,
  hint,
  last,
  children,
}: {
  n: number;
  label: string;
  hint?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="relative pl-7">
      {!last && (
        <span
          aria-hidden
          className="absolute left-[8.5px] top-5 bottom-[-24px] w-px bg-line-soft"
        />
      )}
      <span className="absolute left-0 top-0.5 w-[18px] h-[18px] rounded-full bg-bg-2 border border-line-soft flex items-center justify-center text-[9px] font-mono text-text-3">
        {n}
      </span>
      <div className="text-[11px] uppercase tracking-wider text-text-4 font-medium">
        {label}
        {hint && (
          <span className="ml-2 normal-case tracking-normal text-text-4/70">
            {hint}
          </span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function AskedBeat({ asked }: { asked: AskedNode | null }) {
  if (!asked) {
    return (
      <div className="text-[12px] text-text-4 italic">
        No reason was recorded near this commit — the change has no stated
        origin to compare against.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line-soft bg-bg-1/40 px-3.5 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <AgentBadge agentId={asked.agentId} />
        {asked.fromSession ? (
          <span
            className="text-[9.5px] px-1 py-px rounded border border-line-soft bg-bg-2 text-text-3"
            title="The user's first message in the correlated Claude Code session"
          >
            prompt
          </span>
        ) : asked.intentType ? (
          <TypeBadge type={asked.intentType} />
        ) : null}
        <span className="ml-auto text-[10px] text-text-4 tabular-nums">
          {formatRelative(asked.timestamp)}
        </span>
      </div>
      <StoryMarkdown>{asked.text}</StoryMarkdown>
    </div>
  );
}

export function SaidBeat({ said }: { said: StatedIntent[] }) {
  return (
    <ul className="space-y-2.5">
      {said.map((s, i) => (
        <li key={i} className="border-l-2 border-line-soft pl-3">
          <div className="flex items-center gap-2 mb-0.5">
            <AgentBadge agentId={s.agent_id} />
            {s.intent_type && <TypeBadge type={s.intent_type} />}
            <span className="ml-auto text-[10px] text-text-4 tabular-nums">
              {formatRelative(s.timestamp)}
            </span>
          </div>
          <StoryMarkdown compact>{s.intent}</StoryMarkdown>
        </li>
      ))}
    </ul>
  );
}

// The heart: what changed, as per-symbol cards. Uncovered (risk) first.
function DidBeat({ report }: { report: IntentReport }) {
  const nodes = useMemo(() => deriveNodes(report), [report]);
  const [showAll, setShowAll] = useState(false);
  // All hooks run before any early return (Rules of Hooks).
  const sorted = useMemo(() => {
    const rank = { modified: 0, added: 1, deleted: 2 } as const;
    return [...nodes].sort((a, b) => {
      // Uncovered (not named in the task) is the risk — float it up.
      const ca = a.covered ? 1 : 0;
      const cb = b.covered ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return rank[a.change] - rank[b.change];
    });
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="text-[12px] text-text-4">
        No code-level changes detected
        {report.changed_files.length > 0 && (
          <> in {report.changed_files.length} changed file
          {report.changed_files.length === 1 ? "" : "s"}</>
        )}
        .
      </div>
    );
  }

  const LIMIT = 18;
  const shown = showAll ? sorted : sorted.slice(0, LIMIT);
  const uncovered = nodes.filter((n) => !n.covered).length;

  return (
    <div>
      <div className="text-[10.5px] text-text-4 mb-2 flex items-center gap-2">
        <span>
          {nodes.length} piece{nodes.length === 1 ? "" : "s"} ·{" "}
          {report.changed_files.length} file
          {report.changed_files.length === 1 ? "" : "s"}
        </span>
        {uncovered > 0 && (
          <span className="text-amber-300/80">{uncovered} not in your ask</span>
        )}
      </div>
      <div className="space-y-1.5">
        {shown.map((node, i) => (
          <NodeCard key={`${node.identifier}-${i}`} node={node} />
        ))}
      </div>
      {sorted.length > LIMIT && (
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 px-0 text-[11px] text-text-3 hover:text-text-1"
        >
          {showAll
            ? "Show fewer"
            : `Show ${sorted.length - LIMIT} more piece${
                sorted.length - LIMIT === 1 ? "" : "s"
              }`}
        </Button>
      )}
    </div>
  );
}

function NodeCard({ node }: { node: NodeRef }) {
  const editor = useEditorStore();
  const file = node.file ?? undefined;
  const line = node.start_line ?? undefined;

  const openFile = () => {
    if (!file) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-file", { detail: { path: file, line } }),
    );
  };
  const rewind = () => {
    editor.openTraceTool("rewind", { identifier: node.identifier, file });
  };

  return (
    <div className="rounded-md border border-line-soft bg-bg-1/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <KindGlyph kind={node.kind} />
        <span
          className="font-mono text-[12px] text-text-1 truncate"
          title={node.identifier}
        >
          {node.identifier}
        </span>
        <ChangeBadge change={node.change} />
        {node.covered === false && (
          <span
            className="text-[9.5px] px-1 py-px rounded border border-amber-500/30 bg-amber-500/10 text-amber-300/90"
            title="This code changed, but it wasn't part of what you asked for"
          >
            not in your ask
          </span>
        )}
        {node.is_stub && (
          <span className="text-amber-300" title="Contains a stub / TODO">
            ⚠
          </span>
        )}
        {node.contains_secret && (
          <span className="text-red-400" title="Possible hardcoded secret">
            🔒
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {file && (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={openFile}
              className="text-[10.5px] text-text-4 hover:text-text-1"
              title={`Open ${file}${line ? `:${line}` : ""}`}
            >
              Open
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={rewind}
            className="text-[10.5px] text-text-4 hover:text-text-1"
            title="Put this piece back the way it was"
          >
            Rewind
          </Button>
        </div>
      </div>
      {file && (
        <div className="mt-1 text-[10px] font-mono text-text-4 truncate" title={file}>
          {file}
          {line ? `:${line}` : ""}
        </div>
      )}
      {node.signature && (
        <div
          className="mt-1 text-[11px] font-mono text-text-3 truncate"
          title={node.signature}
        >
          {node.signature}
        </div>
      )}
      {node.rationale && (
        <div className="mt-1.5 text-text-2">
          <StoryMarkdown compact>{node.rationale}</StoryMarkdown>
        </div>
      )}
    </div>
  );
}

export function VerdictBeat({ report }: { report: IntentReport }) {
  const tone = bannerTone(report);
  // Color rides on the glyph + the coverage meter only — never as a card fill.
  const glyph =
    report.banner === "aligned" ? "✓" : report.banner === "drift" ? "–" : "✗";
  const pct = Math.round(Math.max(0, Math.min(1, report.alignment_score)) * 100);
  const totalChanged =
    report.modified_nodes.length +
    report.added_nodes.length +
    report.deleted_nodes.length;
  const uncovered = report.mismatched_nodes;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-[12px] leading-none" style={{ color: tone.color }}>
          {glyph}
        </span>
        <span className="text-[13px] font-semibold text-text-1">{tone.label}</span>
        <span className="ml-auto text-[10.5px] text-text-4 tabular-nums">
          {report.aligned_nodes.length}/{Math.max(totalChanged, 1)} pieces
          covered · {pct}%
        </span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-bg-2 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: tone.color }}
        />
      </div>
      <div className="text-[12.5px] text-text-2 mt-2 leading-snug">
        {tone.msg}
      </div>
      {uncovered.length > 0 && (
        <div className="mt-2 text-[11.5px] text-text-3">
          Not named in the task:{" "}
          <span className="font-mono text-amber-300/90">
            {uncovered.slice(0, 6).join(", ")}
          </span>
          {uncovered.length > 6 && (
            <span className="text-text-4"> +{uncovered.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  );
}

export function RecoverBeat({
  repoRoot,
  report,
}: {
  repoRoot: string;
  report: IntentReport;
}) {
  const [count, setCount] = useState<number | null>(null);
  const changed = useMemo(
    () => new Set(report.changed_files),
    [report.changed_files],
  );

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    api
      .auraListSnapshotsV2(repoRoot, 200)
      .then((page) => {
        if (cancelled) return;
        const n = page.entries.filter((e) => changed.has(e.file)).length;
        setCount(n);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, changed]);

  return (
    <div className="text-[12px] text-text-3 leading-relaxed">
      <p>
        Every <span className="font-mono text-text-2">Bring back</span> above
        restores one piece to the way it was — just that piece, nothing else,
        and never a clash. Aura saves a copy of every file before edits, so
        undoing is always safe.
      </p>
      {count !== null && count > 0 && (
        <p className="mt-1.5 text-text-4">
          {count} save point{count === 1 ? "" : "s"} cover the file
          {report.changed_files.length === 1 ? "" : "s"} this change touched.
        </p>
      )}
    </div>
  );
}

// ── Small parts ──────────────────────────────────────────────────────

function ChangeBadge({ change }: { change: NodeRef["change"] }) {
  const map = {
    added: { label: "added", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
    modified: { label: "modified", cls: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
    deleted: { label: "deleted", cls: "border-red-500/30 bg-red-500/10 text-red-300" },
  } as const;
  const m = map[change];
  return (
    <span
      className={`text-[9.5px] px-1 py-px rounded border flex-shrink-0 ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="text-[9.5px] px-1 py-px rounded border border-line-soft bg-bg-2 text-text-3">
      {type}
    </span>
  );
}

// A minimal glyph hinting the node kind. Falls back to a generic dot when
// the CLI didn't carry a kind (synthesized nodes).
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
    <span className="w-4 h-4 flex-shrink-0 rounded bg-bg-2 border border-line-soft flex items-center justify-center text-[9px] font-mono text-text-4">
      {label}
    </span>
  );
}

// ── Data shaping ─────────────────────────────────────────────────────

// Use the CLI's structured nodes when present; otherwise synthesize cards
// from the string arrays so the page is rich on a new binary and still
// works on an old one. The change axis (added/modified/deleted) and the
// coverage axis (aligned) are merged: each changed symbol becomes one card
// tagged with whether the task named it.
export function deriveNodes(report: IntentReport): NodeRef[] {
  if (report.nodes && report.nodes.length > 0) return report.nodes;
  const aligned = new Set(report.aligned_nodes);
  const mk = (ids: string[], change: NodeRef["change"]): NodeRef[] =>
    ids.map((id) => ({
      identifier: id,
      kind: "",
      change,
      covered: aligned.has(id),
    }));
  return [
    ...mk(report.modified_nodes, "modified"),
    ...mk(report.added_nodes, "added"),
    ...mk(report.deleted_nodes, "deleted"),
  ];
}

export function bannerTone(report: IntentReport): {
  color: string;
  bg: string;
  label: string;
  msg: string;
} {
  if (report.banner === "aligned") {
    return {
      color: "var(--color-accent-green)",
      bg: "color-mix(in oklab, var(--color-accent-green) 12%, transparent)",
      label: "Matches task",
      msg: "Every changed piece is covered by the recorded reason.",
    };
  }
  if (report.banner === "drift") {
    return {
      color: "var(--color-amber)",
      bg: "color-mix(in oklab, var(--color-amber) 12%, transparent)",
      label: "Needs review",
      msg: "Some changed pieces weren't named in the reason.",
    };
  }
  return {
    color: "var(--color-red)",
    bg: "color-mix(in oklab, var(--color-red) 12%, transparent)",
    label: "No clear match",
    msg:
      report.stated.length === 0
        ? "No reason was recorded near this commit."
        : "The reason covers few or none of the changed pieces.",
  };
}

export function formatRelative(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}

export function formatAbsolute(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
