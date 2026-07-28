import { useEffect, useMemo, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ImpactAlert, type IntentEntry, type SnapshotEntry, type StreamEvent } from "../../lib/api";
import { streamChannel, useAgentStream } from "../../lib/agentStreamStore";
import { useGitChanges, type ChangedFile } from "../../lib/useGitChanges";
import { isToolMetadataPath } from "../../lib/categorizeChange";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { AgentIcon, brandFor } from "../agent/AgentIcon";
import { Churn } from "../diff/Churn";

type Props = {
  repoRoot: string;
};

type AgentId = "claude" | "gemini" | "codex" | "cursor";

type AgentEventRow = {
  key: string;
  agentId: AgentId;
  event: StreamEvent;
  index: number;
  filePath: string | null;
  turnId: string;
};

type FileStoryItem = {
  key: string;
  title: string;
  /** Human-readable label of the most recent agent (for back-compat). */
  agent: string;
  /** Every distinct agent id that touched this file in the current
   *  session, ordered by first contribution. Renders as a row of
   *  brand-colored chips so multi-Claude / cross-agent attribution is
   *  visible at a glance. */
  contributors: AgentId[];
  filePath: string;
  snippet: string[];
  additions: number;
  deletions: number;
  status: string;
  snapshotted: boolean;
  note?: string;
};

type DiffRenderLine = {
  raw: string;
  oldLine: number | null;
  newLine: number | null;
};

type TasteSummary = {
  total: number;
  active: number;
  provisional: number;
  candidate: number;
};

export function EditViewPanel({ repoRoot }: Props) {
  const visible = useDocumentVisibility();
  const changes = useGitChanges(repoRoot);
  const claude = useAgentStream(streamChannel("claude", repoRoot));
  const gemini = useAgentStream(streamChannel("gemini", repoRoot));
  const codex = useAgentStream(streamChannel("codex", repoRoot));
  const cursor = useAgentStream(streamChannel("cursor", repoRoot));
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const latestIntent = intents[0] ?? null;
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [impacts, setImpacts] = useState<ImpactAlert[]>([]);
  const [taste, setTaste] = useState<TasteSummary | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});

  const streamRows = useMemo(
    () =>
      buildAgentRows([
        { agentId: "claude", events: claude.events },
        { agentId: "gemini", events: gemini.events },
        { agentId: "codex", events: codex.events },
        { agentId: "cursor", events: cursor.events },
      ], repoRoot),
    [claude.events, gemini.events, codex.events, cursor.events, repoRoot],
  );

  const changedFiles = useMemo(
    () =>
      dedupeChangedFiles([
        ...changes.unstaged,
        ...changes.staged,
        ...changes.untracked,
      ]).filter((file) => !isToolMetadataPath(file.path)),
    [changes.unstaged, changes.staged, changes.untracked],
  );

  useEffect(() => {
    let cancelled = false;
    function load() {
      api
        .auraReadIntentLogV2(repoRoot, 40)
        .then((page) => {
          if (!cancelled) setIntents(page.entries ?? []);
        })
        .catch(() => {
          if (!cancelled) setIntents([]);
        });
      api
        .auraListSnapshots(repoRoot)
        .then((rows) => {
          if (!cancelled) setSnapshots(rows.slice(0, 80));
        })
        .catch(() => {
          if (!cancelled) setSnapshots([]);
        });
      api
        .auraReadImpacts(repoRoot)
        .then((rows) => {
          if (!cancelled) setImpacts(rows.filter((r) => !r.resolved));
        })
        .catch(() => {
          if (!cancelled) setImpacts([]);
        });
      api
        .auraCli(repoRoot, ["taste", "status", "--json"])
        .then((r) => {
          if (cancelled) return;
          if (r.status !== 0 || !r.stdout) {
            setTaste(null);
            return;
          }
          try {
            const parsed = JSON.parse(r.stdout);
            const rules = parsed?.rules ?? {};
            setTaste({
              total: Number(rules.total ?? 0),
              active: Number(rules.active ?? 0),
              provisional: Number(rules.provisional ?? 0),
              candidate: Number(rules.candidate ?? 0),
            });
          } catch {
            setTaste(null);
          }
        })
        .catch(() => {
          if (!cancelled) setTaste(null);
        });
    }
    load();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  useEffect(() => {
    let cancelled = false;
    const paths = changedFiles.map((file) => file.path).slice(0, 12);
    if (paths.length === 0) {
      setDiffs({});
      return;
    }
    Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await api.gitDiff(repoRoot, path)] as const;
        } catch {
          return [path, ""] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setDiffs(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, changedFiles, changes.changedCount]);

  const story = useMemo(
    () =>
      buildStory({
        latestIntent,
        snapshots,
        streamRows,
        changedFiles,
        diffs,
        repoRoot,
      }),
    [latestIntent, snapshots, streamRows, changedFiles, diffs, repoRoot],
  );

  const running = claude.running || gemini.running || codex.running || cursor.running;
  const additions = story.reduce((sum, item) => sum + item.additions, 0);
  const deletions = story.reduce((sum, item) => sum + item.deletions, 0);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-1">
      <header className="h-8 px-3 border-b border-line-soft flex items-center shrink-0">
        <span className="text-text-2 text-[11.5px] font-medium uppercase tracking-wider">
          Story
        </span>
        <span className="ml-auto text-text-5 text-[10px] font-mono tabular-nums">
          {running ? "live" : `${story.length} files`}
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="px-3 py-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-text-1 text-[13px] font-medium">
              {story.length} file{story.length === 1 ? "" : "s"} changed
            </span>
            {/* This IS the workspace you're in right now — the one churn
                readout on screen that earns its colour. */}
            <Churn additions={additions} deletions={deletions} tone="active" />
          </div>
          <TimelineRibbon
            latestIntent={latestIntent}
            snapshots={snapshots}
            impacts={impacts}
            taste={taste}
            running={running}
          />
          {story.length === 0 ? (
            <div className="text-text-4 text-[11px] leading-snug">
              Waiting for file activity. Aura will show opened, viewed, and edited files here with the exact changed snippet.
            </div>
          ) : (
            <div className="space-y-3">
              {story.slice(-24).map((item) => (
                <FileStorySection key={item.key} item={item} />
              ))}
            </div>
          )}
          {intents.length > 1 && (
            <IntentsTimeline intents={intents.slice(1)} />
          )}
        </section>
      </div>
    </div>
  );
}

function IntentsTimeline({ intents }: { intents: IntentEntry[] }) {
  return (
    <section className="mt-5 pt-4 border-t border-line-soft">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-text-5">
          Intent timeline
        </span>
        <span className="text-[10px] font-mono text-text-5 ml-auto tabular-nums">
          {intents.length}
        </span>
      </div>
      <ol className="space-y-1.5">
        {intents.map((it, idx) => (
          <IntentTimelineRow key={it.id || `it-${idx}`} entry={it} />
        ))}
      </ol>
    </section>
  );
}

function IntentTimelineRow({ entry }: { entry: IntentEntry }) {
  const [open, setOpen] = useState(false);
  const body = cleanIntentBodyEV(entry.intent);
  const title = oneLine(body, 140);
  const files = entry.changeset?.files ?? [];
  const adds = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const dels = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  const canExpand = files.length > 0 || body.includes("\n");
  return (
    <li className="rounded border border-line-soft bg-bg-1">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`w-full text-left px-2 py-1.5 flex items-baseline gap-2 ${canExpand ? "hover:bg-bg-2" : ""}`}
      >
        <span className="text-[10px] font-mono text-text-5 tabular-nums shrink-0">
          {timeAgo(entry.timestamp)}
        </span>
        <span className="flex-1 text-[11.5px] text-text-2 truncate">{title}</span>
        {files.length > 0 && (
          <span className="text-[10px] font-mono text-text-5 tabular-nums shrink-0">
            {files.length}f
          </span>
        )}
        <Churn additions={adds} deletions={dels} className="text-[10px]" />
      </button>
      {open && (
        <div className="border-t border-line-soft px-2 py-1.5 space-y-1.5">
          {body.includes("\n") && (
            <div className="text-[11px] text-text-3 whitespace-pre-wrap leading-snug">
              {body}
            </div>
          )}
          {files.length > 0 && (
            <ul className="divide-y divide-line-soft border border-line-soft rounded overflow-hidden">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="px-2 py-1 flex items-center gap-2 hover:bg-bg-2"
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.dispatchEvent(
                        new CustomEvent("aura:open-file", {
                          detail: { path: f.path },
                        }),
                      );
                    }}
                    className="font-mono text-[11px] text-text-3 hover:text-accent hover:underline truncate flex-1 text-left"
                    title={f.path}
                  >
                    {f.path}
                  </button>
                  {f.status && (
                    <span className="text-[9.5px] uppercase tracking-wider text-text-5 shrink-0">
                      {f.status}
                    </span>
                  )}
                  <Churn
                    additions={f.additions ?? 0}
                    deletions={f.deletions ?? 0}
                    className="text-[10px]"
                  />
                </li>
              ))}
            </ul>
          )}
          {entry.commit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent("aura:open-commit-diff", {
                    detail: { sha: entry.commit, subject: title },
                  }),
                );
              }}
              className="text-[10.5px] px-2 py-0.5 rounded border border-line-soft text-text-3 hover:text-text-1 hover:bg-bg-2"
            >
              Show diff
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Local twin of CommsPanel's cleanIntentBody so EditViewPanel doesn't have
// to import across the rightrail/components boundary. Strips the XML
// envelope that some intent loggers wrap around the prose body.
function cleanIntentBodyEV(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/<\/?intent[^>]*>/gi, "");
  s = s.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "");
  s = s.replace(/<parameter\b[^>]*>[\s\S]*$/gi, "");
  s = s.replace(/<\/parameter>/gi, "");
  s = s.replace(/<[a-zA-Z/!?][^>]*>/g, "");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function TimelineRibbon({
  latestIntent,
  snapshots,
  impacts,
  taste,
  running,
}: {
  latestIntent: IntentEntry | null;
  snapshots: SnapshotEntry[];
  impacts: ImpactAlert[];
  taste: TasteSummary | null;
  running: boolean;
}) {
  const snapshotCount = snapshots.length;
  const impactCount = impacts.length;
  const tasteActive = taste?.active ?? 0;
  const tastePending = (taste?.provisional ?? 0) + (taste?.candidate ?? 0);
  // E2 empty case — no intent and no other signal. Prompt the user to
  // log intent. Skip when running because activity is still streaming in.
  if (
    !latestIntent &&
    snapshotCount === 0 &&
    impactCount === 0 &&
    tasteActive === 0 &&
    tastePending === 0 &&
    !running
  ) {
    return (
      <div className="mb-3 rounded-md border border-line/40 bg-bg-1 px-3 py-2.5 space-y-2">
        <div className="text-[11.5px] text-text-2">Nothing tracked here yet</div>
        <div className="text-[10.5px] text-text-4 leading-snug">
          Add a reason before your next commit so your history has context,
          or take a save point so you can bring back a single piece later.
        </div>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => openIntentDialog("")}
            className="text-[10.5px] px-2 py-0.5 rounded border border-line/40 text-text-2 hover:text-text-1 hover:bg-bg-2"
          >
            Add a reason
          </button>
          <span className="text-[10.5px] text-text-5 self-center">
            or <span className="font-mono text-text-4">/plan</span> in chat
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-3 space-y-2">
      {latestIntent && (
        <div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-text-5 shrink-0">
              Reason
            </span>
            <span className="text-[10px] font-mono text-text-5 ml-auto shrink-0">
              {running ? "live" : timeAgo(latestIntent.timestamp)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => openIntentDialog(latestIntent.intent)}
            className="block w-full text-left mt-1"
            title={latestIntent.intent}
          >
            <MarkdownBody source={latestIntent.intent} compact />
          </button>
        </div>
      )}
      {(snapshotCount > 0 || impactCount > 0 || tasteActive > 0 || tastePending > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {snapshotCount > 0 && (
            <SignalChip tone="neutral" title="Save points taken before edits — you can bring any one back">
              {snapshotCount} save point{snapshotCount === 1 ? "" : "s"}
            </SignalChip>
          )}
          {impactCount > 0 && (
            <SignalChip
              tone="warn"
              title={`${impactCount} change${impactCount === 1 ? "" : "s"} on another branch that touch your work`}
            >
              {impactCount} impact{impactCount === 1 ? "" : "s"}
            </SignalChip>
          )}
          {(tasteActive > 0 || tastePending > 0) && (
            <SignalChip
              tone={tasteActive > 0 ? "ok" : "neutral"}
              title={
                tastePending > 0
                  ? `${tasteActive} active + ${tastePending} pending style rule${tastePending === 1 ? "" : "s"} Aura learned from your code. Run /taste in chat to review.`
                  : `${tasteActive} active style rule${tasteActive === 1 ? "" : "s"} Aura learned from your code. Run /taste in chat to review.`
              }
            >
              style {tasteActive}
              {tastePending > 0 ? ` (+${tastePending})` : ""}
            </SignalChip>
          )}
        </div>
      )}
    </div>
  );
}

function SignalChip({
  children,
  title,
  tone,
}: {
  children: React.ReactNode;
  title: string;
  tone: "neutral" | "warn" | "ok";
}) {
  const cls =
    tone === "warn"
      ? "border-amber/40 text-amber bg-amber/5"
      : tone === "ok"
        ? "border-line/40 text-text-2 bg-bg-1"
        : "border-line/40 text-text-3 bg-bg-1";
  return (
    <span
      title={title}
      className={`text-[10.5px] px-1.5 py-0.5 rounded border ${cls}`}
    >
      {children}
    </span>
  );
}

function FileStorySection({ item }: { item: FileStoryItem }) {
  return (
    <div className="min-w-0">
      {item.note && <MarkdownBody source={item.note} />}
      <SnippetCallout item={item} />
    </div>
  );
}

function SnippetCallout({ item }: { item: FileStoryItem }) {
  const lines = item.snippet.length > 0 ? item.snippet : fallbackSnippet(item);
  const numbered = numberDiffLines(lines);
  // Convergence stripe: primary contributor's brand colour stripes the
  // left edge so a multi-Claude / multi-agent story is scannable. When
  // multiple agents touched the same file the stripe blends both
  // colours so the user immediately sees "this is shared work".
  const primary = item.contributors[0] ?? null;
  const stripeColor = primary ? brandFor(primary).fg : "transparent";
  const blendStripe =
    item.contributors.length > 1
      ? `linear-gradient(to bottom, ${brandFor(item.contributors[0]).fg}, ${brandFor(item.contributors[1]).fg})`
      : null;
  return (
    <div
      className="rounded-lg border border-line-soft bg-bg-deep overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] relative"
      style={{ background: "color-mix(in srgb, var(--color-bg-1) 86%, black)" }}
    >
      {primary && (
        <div
          className="absolute left-0 top-0 bottom-0 w-[3px]"
          style={{ background: blendStripe ?? stripeColor }}
        />
      )}
      <button
        type="button"
        onClick={() => openSourceControl(item.filePath)}
        className="w-full h-9 pl-3 pr-3 flex items-center gap-2 text-left hover:bg-bg-2 transition-colors"
      >
        <span className="font-mono text-[12px] text-text-4 truncate" title={item.filePath}>
          {directoryLabel(item.filePath)}
          <span className="text-text-1">{baseName(item.filePath)}</span>
        </span>
        <Churn
          additions={item.additions}
          deletions={item.deletions}
          className="ml-auto"
        />
        {item.contributors.length > 0 ? (
          <ContributorChips contributors={item.contributors} />
        ) : (
          <span className="text-text-5 text-[9.5px] font-mono shrink-0">{item.agent}</span>
        )}
        {item.snapshotted && (
          <span className="text-text-5 text-[9.5px] font-mono shrink-0">
            snapshot
          </span>
        )}
      </button>
      <pre className="text-[11px] font-mono leading-[1.5] overflow-auto max-h-80 pb-3">
        {numbered.map((line, i) => (
          <div
            key={i}
            className={`grid grid-cols-[2.6rem_2.6rem_minmax(0,1fr)] ${diffTone(line.raw)}`}
          >
            <span className="text-right select-none text-text-5/70 pr-2">
              {line.oldLine ?? ""}
            </span>
            <span className="text-right select-none text-text-5/70 pr-2">
              {line.newLine ?? ""}
            </span>
            <span className="whitespace-pre min-w-max">{line.raw || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function ContributorChips({ contributors }: { contributors: AgentId[] }) {
  // De-dupe defensively. Each chip shows the agent's brand glyph so a
  // file touched by Claude AND Gemini reads as "C G" rather than text.
  const unique = Array.from(new Set(contributors));
  return (
    <span
      className="ml-auto flex items-center gap-0.5 shrink-0"
      title={unique.map((c) => agentLabel(c)).join(" + ")}
    >
      {unique.map((agentId) => {
        const brand = brandFor(agentId);
        return (
          <span
            key={agentId}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full"
            style={{
              background: brand.bg,
              border: `1px solid ${brand.ring}`,
            }}
          >
            <AgentIcon agentId={agentId} size={9} />
          </span>
        );
      })}
    </span>
  );
}

function fallbackSnippet(item: FileStoryItem): string[] {
  if (item.status === "?") return [`+ ${baseName(item.filePath)}`];
  if (item.additions || item.deletions) {
    return [
      `@@ ${shortPath(item.filePath)} @@`,
      item.deletions > 0 ? `- ${item.deletions} removed line${item.deletions === 1 ? "" : "s"}` : "",
      item.additions > 0 ? `+ ${item.additions} added line${item.additions === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
  }
  return [`  ${shortPath(item.filePath)}`];
}

function numberDiffLines(lines: string[]): DiffRenderLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = lines.some((line) => line.startsWith("@@")) ? null : 1;

  return lines.map((raw) => {
    const hunk = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      return { raw, oldLine: null, newLine: null };
    }
    if (raw.startsWith("@@")) {
      return { raw, oldLine: null, newLine: null };
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const line = { raw, oldLine: null, newLine };
      if (newLine != null) newLine += 1;
      return line;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      const line = { raw, oldLine, newLine: null };
      if (oldLine != null) oldLine += 1;
      return line;
    }

    const line = { raw, oldLine, newLine };
    if (oldLine != null) oldLine += 1;
    if (newLine != null) newLine += 1;
    return line;
  });
}

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-2 last:mb-0 text-text-2 text-[11.5px] leading-relaxed">
      {children}
    </p>
  ),
  strong: ({ children }) => <strong className="text-text-1 font-medium">{children}</strong>,
  em: ({ children }) => <em className="text-text-2 italic">{children}</em>,
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded bg-bg-2 text-text-1 font-mono text-[10.5px]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 last:mb-0 overflow-auto rounded-md bg-bg-deep px-2 py-1.5 text-[10.5px]">
      {children}
    </pre>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 last:mb-0 pl-4 list-disc text-text-2 text-[11.5px] leading-relaxed">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 last:mb-0 pl-4 list-decimal text-text-2 text-[11.5px] leading-relaxed">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-accent-blue hover:underline"
      target="_blank"
      rel="noreferrer"
      onClick={onExternalAnchorClick}
    >
      {children}
    </a>
  ),
};

function MarkdownBody({
  source,
  compact = false,
}: {
  source: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "line-clamp-3" : "mb-2"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

function buildAgentRows(
  sources: Array<{ agentId: AgentId; events: StreamEvent[] }>,
  repoRoot: string,
): AgentEventRow[] {
  return sources.flatMap((source, sourceIndex) =>
    source.events.map((event, index) => ({
      key: `${source.agentId}-${index}-${event.kind}`,
      agentId: source.agentId,
      event,
      index: sourceIndex * 100_000 + index,
      filePath: eventFilePath(event, repoRoot),
      turnId: "turn_id" in event ? event.turn_id : "",
    })),
  ).sort((a, b) => a.index - b.index);
}

type FileStoryDraft = Omit<FileStoryItem, "agent" | "contributors"> & {
  agentId: AgentId | null;
  contributors: AgentId[];
  index: number;
};

function buildStory({
  latestIntent,
  snapshots,
  streamRows,
  changedFiles,
  diffs,
  repoRoot,
}: {
  latestIntent: IntentEntry | null;
  snapshots: SnapshotEntry[];
  streamRows: AgentEventRow[];
  changedFiles: ChangedFile[];
  diffs: Record<string, string>;
  repoRoot: string;
}): FileStoryItem[] {
  const title = latestIntent?.intent ? oneLine(latestIntent.intent, 120) : "AI file edit";
  const drafts = new Map<string, FileStoryDraft>();
  const assistantByTurn = new Map<string, string>();
  const snapshotFiles = new Set(
    snapshots.map((snapshot) => normalizePath(snapshot.file, repoRoot)),
  );

  for (const row of streamRows) {
    if (row.event.kind === "assistant_text") {
      assistantByTurn.set(row.turnId, trimMarkdown(row.event.text, 700));
    }
  }

  const draftFor = (filePath: string, agentId: AgentId | null, index: number) => {
    const prev = drafts.get(filePath);
    if (prev) {
      prev.index = Math.max(prev.index, index);
      if (agentId) {
        prev.agentId = agentId;
        if (!prev.contributors.includes(agentId)) {
          prev.contributors.push(agentId);
        }
      }
      return prev;
    }
    const next: FileStoryDraft = {
      key: `story-${filePath}`,
      title,
      agentId,
      contributors: agentId ? [agentId] : [],
      filePath,
      snippet: [],
      additions: 0,
      deletions: 0,
      status: "",
      snapshotted: snapshotFiles.has(filePath),
      note: undefined,
      index,
    };
    drafts.set(filePath, next);
    return next;
  };

  for (const row of streamRows) {
    if (!row.filePath) continue;
    const draft = draftFor(row.filePath, row.agentId, row.index);
    const turnNote = assistantByTurn.get(row.turnId);
    if (turnNote) draft.note = turnNote;

    if (row.event.kind === "tool_use") {
      if (isEditTool(row.event.name)) {
        const snippet = editSnippet(row.event);
        if (snippet.length > 0) draft.snippet = snippet;
      }
      continue;
    }

    if (row.event.kind === "aura_snapshot") {
      draft.snapshotted = true;
      continue;
    }

    if (row.event.kind === "aura_warning") {
      draft.note = row.event.message;
    }
  }

  for (const [index, file] of changedFiles.entries()) {
    const draft = draftFor(file.path, null, streamRows.length + index);
    draft.additions = Math.max(draft.additions, file.additions);
    draft.deletions = Math.max(draft.deletions, file.deletions);
    draft.status = file.status;
    const diffSnippet = compactDiffSnippet(diffs[file.path] ?? "");
    if (diffSnippet.length > 0) draft.snippet = diffSnippet;
  }

  return [...drafts.values()]
    .filter((draft) => hasVisibleSnippet(draft))
    .sort((a, b) => a.index - b.index)
    .map(toFileStoryItem);
}

function toFileStoryItem(draft: FileStoryDraft): FileStoryItem {
  return {
    key: draft.key,
    title: draft.title,
    agent: draft.agentId ? agentLabel(draft.agentId) : "Aura",
    contributors: draft.contributors,
    filePath: draft.filePath,
    snippet: draft.snippet,
    additions: draft.additions,
    deletions: draft.deletions,
    status: draft.status,
    snapshotted: draft.snapshotted,
    note: draft.note,
  };
}

function hasVisibleSnippet(draft: FileStoryDraft): boolean {
  return (
    draft.snippet.length > 0 ||
    draft.additions > 0 ||
    draft.deletions > 0 ||
    draft.status === "?"
  );
}

function dedupeChangedFiles(files: ChangedFile[]): ChangedFile[] {
  const map = new Map<string, ChangedFile>();
  for (const file of files) {
    const prev = map.get(file.path);
    if (!prev) {
      map.set(file.path, file);
      continue;
    }
    map.set(file.path, {
      ...file,
      additions: Math.max(file.additions, prev.additions),
      deletions: Math.max(file.deletions, prev.deletions),
    });
  }
  return [...map.values()];
}

function eventFilePath(event: StreamEvent, repoRoot: string): string | null {
  if (event.kind === "aura_snapshot") return normalizePath(event.file_path, repoRoot);
  if (event.kind === "aura_warning" && event.file_path) {
    return normalizePath(event.file_path, repoRoot);
  }
  if (event.kind !== "tool_use") return null;
  const input = event.input;
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const raw = obj.file_path ?? obj.filePath ?? obj.path;
  return typeof raw === "string" ? normalizePath(raw, repoRoot) : null;
}

function isEditTool(name: string): boolean {
  return name === "Edit" || name === "Write" || name === "MultiEdit";
}

function editSnippet(event: Extract<StreamEvent, { kind: "tool_use" }>): string[] {
  if (!event.input || typeof event.input !== "object") return [];
  const obj = event.input as Record<string, unknown>;
  const str = (key: string) => (typeof obj[key] === "string" ? (obj[key] as string) : "");
  if (event.name === "Edit") {
    return [`- ${oneLine(str("old_string"), 180)}`, `+ ${oneLine(str("new_string"), 180)}`]
      .filter((line) => line.trim().length > 1);
  }
  if (event.name === "Write") {
    return str("content")
      .split(/\r?\n/)
      .slice(0, 10)
      .map((line) => `+ ${line}`);
  }
  if (event.name === "MultiEdit" && Array.isArray(obj.edits)) {
    return (obj.edits as unknown[]).slice(0, 4).flatMap((edit, index) => {
      if (!edit || typeof edit !== "object") return [];
      const e = edit as Record<string, unknown>;
      const oldText = typeof e.old_string === "string" ? e.old_string : "";
      const newText = typeof e.new_string === "string" ? e.new_string : "";
      return [
        `@@ edit ${index + 1} @@`,
        `- ${oneLine(oldText, 140)}`,
        `+ ${oneLine(newText, 140)}`,
      ];
    });
  }
  return [];
}

function compactDiffSnippet(diff: string): string[] {
  const lines = trimDiff(diff).filter(
    (line) => line.length > 0 && !line.startsWith("--- ") && !line.startsWith("+++ "),
  );
  if (lines.length === 0) return [];
  const firstChange = lines.findIndex(
    (line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"),
  );
  const start = firstChange <= 0 ? 0 : Math.max(0, firstChange - 2);
  return lines.slice(start, start + 14);
}

function openSourceControl(filePath?: string) {
  window.dispatchEvent(
    new CustomEvent("aura:open-changes-panel", {
      detail: { filePath },
    }),
  );
}

function openIntentDialog(defaultText?: string) {
  window.dispatchEvent(
    new CustomEvent("aura:open-log-intent", {
      detail: { source: "edit-view", defaultText },
    }),
  );
}

function normalizePath(path: string, repoRoot: string): string {
  if (path.startsWith(repoRoot + "/")) return path.slice(repoRoot.length + 1);
  return path;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
}

function directoryLabel(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return "";
  return path.slice(0, index + 1);
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function oneLine(value: string, max = 220): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function trimMarkdown(value: string, max = 700): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function trimDiff(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index "));
}

/** Diff-body tone, matching UnifiedDiff / InlineDiff: a restrained tinted row
 *  with the code itself on the neutral ramp. The leading +/− is the marker;
 *  colouring the whole line as well turns a snippet into a highlighter. */
function diffTone(line: string): string {
  if (line.startsWith("+")) return "bg-green/[0.08] text-text-2";
  if (line.startsWith("-")) return "bg-red/[0.07] text-text-2";
  if (line.startsWith("@@")) return "bg-bg-2/70 text-text-4";
  return "text-text-3";
}

function agentLabel(agentId: AgentId): string {
  if (agentId === "claude") return "Claude";
  if (agentId === "gemini") return "Gemini";
  if (agentId === "codex") return "Codex";
  return "Cursor";
}

function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
