// AuraRefCard — renders inline cards for relay payloads and aura:// URLs.
//
// Two entry points:
//   <RelayCardView card={…} repoRoot={…} />       // structured payloads
//   <AuraRefUnfurl url={…} repoRoot={…} />        // aura:// URL unfurl
//
// Both surfaces share the same visual idiom (a tight bordered card,
// 2-row layout: header line + body), so a chat message that combines a
// `<aura:relay>` sentinel with a pasted aura:// URL reads as a single
// coherent activity strip.
//
// Data fetching is lazy and cached per (kind, key) so repeated bubbles
// referencing the same artifact don't refetch.

import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  CheckCircle2,
  FileCode2,
  FileText,
  GitCommit,
  GitPullRequest,
  ListTodo,
  Quote,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  api,
  type CommitEntry,
  type IntentRow,
  type NoteScope,
  type SnapshotEntry,
} from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import type {
  AuraRef,
  CommitRelayPayload,
  FunctionRefRelayPayload,
  IntentRelayPayload,
  PrLineRelayPayload,
  PrOpenedRelayPayload,
  PrReviewRelayPayload,
  ProveRelayPayload,
  RelayCard,
  SnapshotRelayPayload,
} from "../../lib/auraRelay";
import { parseAuraRef } from "../../lib/auraRelay";

// ─── Module-scoped cache (per URL / payload key) ─────────────────────

type CacheEntry =
  | { status: "loading" }
  | { status: "ok"; data: unknown }
  | { status: "error"; error: string };

const cache = new Map<string, CacheEntry>();
const cacheSubscribers = new Map<string, Set<() => void>>();

function notify(key: string) {
  const subs = cacheSubscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn();
}

function useCacheEntry(key: string | null): CacheEntry | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!key) return;
    const subs = cacheSubscribers.get(key) ?? new Set<() => void>();
    const fn = () => force((x) => x + 1);
    subs.add(fn);
    cacheSubscribers.set(key, subs);
    return () => {
      subs.delete(fn);
    };
  }, [key]);
  return key ? cache.get(key) ?? null : null;
}

async function ensureFetched<T>(key: string, run: () => Promise<T>): Promise<void> {
  if (cache.has(key)) return;
  cache.set(key, { status: "loading" });
  notify(key);
  try {
    const data = await run();
    cache.set(key, { status: "ok", data });
  } catch (e) {
    cache.set(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    notify(key);
  }
}

// ─── Public components ───────────────────────────────────────────────

export function RelayCardView({
  card,
  repoRoot,
}: {
  card: RelayCard;
  repoRoot: string;
}) {
  switch (card.kind) {
    case "intent":
      return <IntentCard payload={card.payload as IntentRelayPayload} />;
    case "snapshot":
      return <SnapshotCard payload={card.payload as SnapshotRelayPayload} />;
    case "commit":
      return <CommitCard payload={card.payload as CommitRelayPayload} />;
    case "prove":
      return <ProveCard payload={card.payload as ProveRelayPayload} />;
    case "pr_review":
      return <PrReviewCard payload={card.payload as PrReviewRelayPayload} />;
    case "function_ref":
      return (
        <FunctionRefCard payload={card.payload as FunctionRefRelayPayload} repoRoot={repoRoot} />
      );
    case "pr_opened":
      return (
        <PrOpenedCard payload={card.payload as PrOpenedRelayPayload} repoRoot={repoRoot} />
      );
    case "pr_line":
      return (
        <PrLineCard payload={card.payload as PrLineRelayPayload} repoRoot={repoRoot} />
      );
    default:
      return null;
  }
}

export function AuraRefUnfurl({ url, repoRoot }: { url: string; repoRoot: string }) {
  const ref = useMemo(() => parseAuraRef(url), [url]);
  if (!ref) return null;
  switch (ref.kind) {
    case "intent":
      return <IntentUnfurl refData={ref} repoRoot={repoRoot} />;
    case "snapshot":
      return <SnapshotUnfurl refData={ref} repoRoot={repoRoot} />;
    case "commit":
      return <CommitUnfurl refData={ref} repoRoot={repoRoot} />;
    case "function":
      return <FunctionUnfurl refData={ref} repoRoot={repoRoot} />;
    case "prove":
      return <ProveUnfurlInline goal={ref.goal} />;
    case "pr_review":
      return <PrReviewUnfurlInline base={ref.base} />;
    case "task":
      return <TaskUnfurl refData={ref} repoRoot={repoRoot} />;
    case "page":
      return <PageUnfurl refData={ref} repoRoot={repoRoot} />;
    default:
      return null;
  }
}

// ─── Card chrome ─────────────────────────────────────────────────────

function CardShell({
  icon,
  tone,
  label,
  title,
  meta,
  detail,
  cta,
}: {
  icon: React.ReactNode;
  tone: "neutral" | "good" | "warn" | "bad";
  label: string;
  title: string;
  meta?: React.ReactNode;
  detail?: React.ReactNode;
  cta?: React.ReactNode;
}) {
  const toneColor =
    tone === "good"
      ? "#86efac"
      : tone === "warn"
        ? "#fbbf24"
        : tone === "bad"
          ? "#f87171"
          : "var(--color-accent)";
  return (
    <div className="mt-1.5 rounded-md border border-line-soft bg-bg-2 max-w-[420px] overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-line-soft">
        <span
          className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: `${toneColor}22`, color: toneColor }}
        >
          {icon}
        </span>
        <span
          className="text-[9.5px] uppercase tracking-wider font-medium"
          style={{ color: toneColor }}
        >
          {label}
        </span>
        {meta ? (
          <span className="text-text-4 text-[10.5px] ml-auto tabular-nums flex-shrink-0">
            {meta}
          </span>
        ) : null}
      </div>
      <div className="px-2.5 py-1.5">
        <div className="text-text-1 text-[12px] font-medium break-words">{title}</div>
        {detail ? <div className="mt-1 text-text-3 text-[11px]">{detail}</div> : null}
        {cta ? <div className="mt-1.5">{cta}</div> : null}
      </div>
    </div>
  );
}

function CtaButton({
  label,
  onClick,
  tone = "neutral",
}: {
  label: string;
  onClick: () => void;
  tone?: "neutral" | "good";
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`text-[11px] px-2.5 py-1 rounded border ${
        tone === "good"
          ? "bg-accent-green/10 border-accent-green/40 text-accent-green hover:bg-accent-green/15"
          : "bg-bg-1 border-line-soft text-text-2 hover:text-text-1 hover:border-line"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Card bodies (structured payload variants) ───────────────────────

function relTime(secs?: number): string {
  if (!secs || !Number.isFinite(secs)) return "";
  const now = Math.floor(Date.now() / 1000);
  const d = Math.max(0, now - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

function IntentCard({ payload }: { payload: IntentRelayPayload }) {
  const fileCount = payload.files?.length ?? 0;
  const detail = (
    <>
      <span className="text-text-4">by</span>{" "}
      <span className="text-text-2">{payload.agent_id || "unknown"}</span>
      {payload.branch ? (
        <>
          {" · "}
          <span className="font-mono text-text-3">{payload.branch}</span>
        </>
      ) : null}
      {fileCount > 0 ? (
        <>
          {" · "}
          <span>
            {fileCount} file{fileCount === 1 ? "" : "s"}
          </span>
        </>
      ) : null}
    </>
  );
  return (
    <CardShell
      icon={<Sparkles size={11} />}
      tone="neutral"
      label="reason"
      title={payload.subject || "(no subject)"}
      meta={relTime(payload.ts)}
      detail={detail}
    />
  );
}

function SnapshotCard({ payload }: { payload: SnapshotRelayPayload }) {
  const onRestore = () => {
    window.dispatchEvent(
      new CustomEvent("aura:open-snapshot-restore", {
        detail: { path: payload.path, snapshotId: payload.id },
      }),
    );
  };
  return (
    <CardShell
      icon={<Camera size={11} />}
      tone="neutral"
      label="save point"
      title={payload.path}
      meta={relTime(payload.ts)}
      detail={payload.id ? <span className="font-mono">{payload.id.slice(0, 12)}</span> : null}
      cta={<CtaButton label="Bring back…" onClick={onRestore} />}
    />
  );
}

function CommitCard({ payload }: { payload: CommitRelayPayload }) {
  const onOpenDiff = () => {
    window.dispatchEvent(
      new CustomEvent("aura:open-commit-diff", {
        detail: { sha: payload.sha, subject: payload.subject },
      }),
    );
  };
  return (
    <CardShell
      icon={<GitCommit size={11} />}
      tone="good"
      label="commit"
      title={payload.subject}
      meta={relTime(payload.ts)}
      detail={
        <>
          <span className="font-mono">{payload.sha.slice(0, 7)}</span>
          {payload.author ? (
            <>
              {" · "}
              <span>{payload.author}</span>
            </>
          ) : null}
          {payload.branch ? (
            <>
              {" · "}
              <span className="font-mono text-text-4">{payload.branch}</span>
            </>
          ) : null}
        </>
      }
      cta={<CtaButton label="Open diff" onClick={onOpenDiff} />}
    />
  );
}

function ProveCard({ payload }: { payload: ProveRelayPayload }) {
  const detail = (
    <>
      {payload.nodes_matched != null ? (
        <>
          <span>
            {payload.nodes_matched} node{payload.nodes_matched === 1 ? "" : "s"} matched
          </span>
        </>
      ) : null}
      {payload.gaps && payload.gaps.length > 0 ? (
        <div className="mt-1 text-text-4 text-[10.5px]">
          Gaps: {payload.gaps.slice(0, 3).join(", ")}
          {payload.gaps.length > 3 ? `, +${payload.gaps.length - 3}` : ""}
        </div>
      ) : null}
    </>
  );
  return (
    <CardShell
      icon={payload.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      tone={payload.ok ? "good" : "bad"}
      label="prove"
      title={payload.goal}
      detail={detail}
    />
  );
}

function PrReviewCard({ payload }: { payload: PrReviewRelayPayload }) {
  const tone = payload.verdict === "ok" ? "good" : payload.verdict === "warn" ? "warn" : "bad";
  const icon =
    payload.verdict === "ok" ? (
      <CheckCircle2 size={11} />
    ) : payload.verdict === "warn" ? (
      <ShieldCheck size={11} />
    ) : (
      <XCircle size={11} />
    );
  const onOpen = () => {
    window.dispatchEvent(new CustomEvent("aura:open-pr-review", { detail: { base: payload.base } }));
  };
  const title =
    payload.headline ||
    (payload.violations != null
      ? `${payload.violations} violation${payload.violations === 1 ? "" : "s"} vs ${payload.base}`
      : `PR review vs ${payload.base}`);
  return (
    <CardShell
      icon={icon}
      tone={tone}
      label="pr review"
      title={title}
      detail={
        payload.undocumented != null && payload.undocumented > 0 ? (
          <span>
            {payload.undocumented} undocumented node
            {payload.undocumented === 1 ? "" : "s"}
          </span>
        ) : null
      }
      cta={<CtaButton label="Open review" onClick={onOpen} />}
    />
  );
}

function FunctionRefCard({
  payload,
  repoRoot: _repoRoot,
}: {
  payload: FunctionRefRelayPayload;
  repoRoot: string;
}) {
  const onOpen = () => {
    window.dispatchEvent(
      new CustomEvent("aura:open-file", {
        detail: { path: payload.path, line: payload.line },
      }),
    );
  };
  return (
    <CardShell
      icon={<FileCode2 size={11} />}
      tone="neutral"
      label="function"
      title={`${payload.name}()`}
      detail={
        <span className="font-mono text-text-3">
          {payload.path}
          {payload.line ? `:${payload.line}` : ""}
        </span>
      }
      cta={<CtaButton label="Open file" onClick={onOpen} />}
    />
  );
}

// ─── aura:// URL unfurls (lazy-loaded) ───────────────────────────────

function Skeleton({ label }: { label: string }) {
  return (
    <div className="mt-1.5 rounded-md border border-line-soft bg-bg-2 max-w-[420px] px-2.5 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wider text-text-5">{label}</div>
      <div className="mt-1 h-3 w-40 bg-bg-1 rounded animate-pulse" />
      <div className="mt-1 h-3 w-24 bg-bg-1 rounded animate-pulse" />
    </div>
  );
}

function ErrorPill({ label, error }: { label: string; error: string }) {
  return (
    <div className="mt-1.5 rounded-md border border-line-soft bg-bg-2 max-w-[420px] px-2.5 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wider text-text-5">{label}</div>
      <div className="mt-0.5 text-text-3 text-[11px]">Unavailable · {error}</div>
    </div>
  );
}

function IntentUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "intent" }>;
  repoRoot: string;
}) {
  const key = `intent:${repoRoot}:${refData.ts}`;
  const entry = useCacheEntry(key);
  useEffect(() => {
    void ensureFetched<IntentRow | null>(key, async () => {
      // Pull a reasonable window, then find the row matching the ts.
      const rows = await api.auraIntentRecent(repoRoot, 500);
      return rows.find((r) => r.timestamp === refData.ts) ?? null;
    });
  }, [key, repoRoot, refData.ts]);

  if (!entry || entry.status === "loading") return <Skeleton label="reason" />;
  if (entry.status === "error") return <ErrorPill label="reason" error={entry.error} />;
  const row = entry.data as IntentRow | null;
  if (!row) {
    return (
      <CardShell
        icon={<Sparkles size={11} />}
        tone="warn"
        label="reason"
        title="(reason not found on this machine)"
        detail={<span className="font-mono">ts={refData.ts}</span>}
      />
    );
  }
  const files = (row.changeset?.files ?? []).map((f) => f.path);
  return (
    <IntentCard
      payload={{
        ts: row.timestamp,
        subject: row.intent,
        agent_id: row.agent_id,
        files: files.length > 0 ? files : undefined,
      }}
    />
  );
}

function SnapshotUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "snapshot" }>;
  repoRoot: string;
}) {
  const key = `snapshot:${repoRoot}:${refData.id}`;
  const entry = useCacheEntry(key);
  useEffect(() => {
    void ensureFetched<SnapshotEntry | null>(key, async () => {
      const all = await api.auraListSnapshots(repoRoot);
      // The id may be either the raw snapshot id or a file path. Try both.
      return (
        all.find((s) => s.id === refData.id) ??
        all.find((s) => s.file === refData.id) ??
        null
      );
    });
  }, [key, repoRoot, refData.id]);

  if (!entry || entry.status === "loading") return <Skeleton label="save point" />;
  if (entry.status === "error") return <ErrorPill label="save point" error={entry.error} />;
  const snap = entry.data as SnapshotEntry | null;
  if (!snap) {
    return (
      <SnapshotCard payload={{ path: refData.id, id: refData.id }} />
    );
  }
  return <SnapshotCard payload={{ path: snap.file, id: snap.id, ts: snap.mtime }} />;
}

function CommitUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "commit" }>;
  repoRoot: string;
}) {
  const key = `commit:${repoRoot}:${refData.sha}`;
  const entry = useCacheEntry(key);
  useEffect(() => {
    void ensureFetched<CommitEntry | null>(key, async () => {
      // Pull a generous window and pattern-match by sha prefix.
      const commits = await api.gitRecentCommits(repoRoot, 200);
      const needle = refData.sha.toLowerCase();
      return commits.find((c) => c.sha.toLowerCase().startsWith(needle)) ?? null;
    });
  }, [key, repoRoot, refData.sha]);

  if (!entry || entry.status === "loading") return <Skeleton label="commit" />;
  if (entry.status === "error") return <ErrorPill label="commit" error={entry.error} />;
  const c = entry.data as CommitEntry | null;
  if (!c) {
    return (
      <CommitCard
        payload={{
          sha: refData.sha,
          subject: "(commit not found in recent window)",
        }}
      />
    );
  }
  return (
    <CommitCard
      payload={{
        sha: c.sha,
        subject: c.subject,
        author: c.author,
        ts: c.timestamp,
        branch: c.branch,
      }}
    />
  );
}

function FunctionUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "function" }>;
  repoRoot: string;
}) {
  // No fetch needed — render directly from the URL components and let
  // the user click through. Line is unknown until the editor opens.
  return (
    <FunctionRefCard
      payload={{ path: refData.path, name: refData.name }}
      repoRoot={repoRoot}
    />
  );
}

function ProveUnfurlInline({ goal }: { goal: string }) {
  // We don't auto-run `aura goal-trace` on every unfurl — that would
  // shell out aggressively on every channel render. Show a passive
  // reference card with the goal text; the user can re-fire a fresh
  // /prove from the composer to update the card.
  return (
    <CardShell
      icon={<CheckCircle2 size={11} />}
      tone="neutral"
      label="prove (link)"
      title={goal}
      detail={<span className="text-text-4">Re-run with /prove to refresh</span>}
    />
  );
}

function PrReviewUnfurlInline({ base }: { base: string }) {
  return (
    <CardShell
      icon={<ShieldCheck size={11} />}
      tone="neutral"
      label="pr review (link)"
      title={`Review vs ${base}`}
      detail={<span className="text-text-4">Re-run with /pr-review to refresh</span>}
    />
  );
}

// ─── task / page unfurls ─────────────────────────────────────────────
//
// These land in auto-DMs the moment someone is assigned a task or
// @mentioned on a page. The body sentence ("Assigned you …") carries
// the human context; the card gives a one-click way into the item.
// Clicking dispatches the same `aura:open-task` / `aura:open-page`
// deep-links App listens for, so the right pane opens in place.

function TaskUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "task" }>;
  repoRoot: string;
}) {
  const key = `task:${repoRoot}:${refData.id}`;
  const entry = useCacheEntry(key);
  useEffect(() => {
    void ensureFetched<{ title: string; seq: number } | null>(key, async () => {
      const tasks = await api.tasksList(repoRoot);
      const t = tasks.find((x) => x.id === refData.id);
      return t ? { title: t.title, seq: t.sequence_id } : null;
    });
  }, [key, repoRoot, refData.id]);

  const data =
    entry && entry.status === "ok"
      ? (entry.data as { title: string; seq: number } | null)
      : null;
  const title = data ? `AURA-${data.seq} · ${data.title}` : "Open task";
  return (
    <CardShell
      icon={<ListTodo size={11} />}
      tone="neutral"
      label="task"
      title={title}
      cta={
        <CtaButton
          label="Open task"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("aura:open-task", { detail: { id: refData.id } }),
            )
          }
        />
      }
    />
  );
}

function PageUnfurl({
  refData,
  repoRoot,
}: {
  refData: Extract<AuraRef, { kind: "page" }>;
  repoRoot: string;
}) {
  const key = `page:${repoRoot}:${refData.scope}/${refData.bucket}/${refData.id}`;
  const entry = useCacheEntry(key);
  useEffect(() => {
    void ensureFetched<string | null>(key, async () => {
      const note = await api.notesRead(
        repoRoot,
        refData.scope as NoteScope,
        refData.bucket,
        refData.id,
      );
      return note.frontmatter.title?.trim() || null;
    });
  }, [key, repoRoot, refData.scope, refData.bucket, refData.id]);

  const fetched =
    entry && entry.status === "ok" ? (entry.data as string | null) : null;
  const title = fetched || "Open page";
  return (
    <CardShell
      icon={<FileText size={11} />}
      tone="neutral"
      label="page"
      title={title}
      cta={
        <CtaButton
          label="Open page"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("aura:open-page", {
                detail: {
                  scope: refData.scope,
                  bucket: refData.bucket,
                  id: refData.id,
                },
              }),
            )
          }
        />
      }
    />
  );
}

// ─── pr_opened / pr_line cards ───────────────────────────────────────
//
// A `pr_opened` card lands when the cloud webhook fans a new PR into
// the team's #pull-requests channel. The CTA opens the PR in a
// workpane tab via the editor store — same affordance the Inbox uses
// (see `openPrDetail`). "Take it" posts an acknowledgement message
// in the same channel; the per-team assignee write goes through a
// separate task surface (`U.1` — manifest assignee setter).
//
// A `pr_line` card lands when someone right-clicks a diff card and
// picks "Quote in chat". It carries a truncated snippet plus a link
// back to the github line range; clicking "View in PR" opens the
// PR detail in the workpane.

const PR_LINE_MAX_SNIPPET_LINES = 12;

function PrOpenedCard({
  payload,
  repoRoot,
}: {
  payload: PrOpenedRelayPayload;
  repoRoot: string;
}) {
  const { openPrDetail } = useEditorStore();
  const onOpen = () => {
    openPrDetail(repoRoot, payload.number, payload.title);
  };
  const onTake = async () => {
    // TODO(U.1): wire team manifest assignee setter so this also
    // marks the PR as picked-up in `team.json`. For now we post a
    // chat-only acknowledgement in the same channel so the rest of
    // the team can see who grabbed it.
    try {
      const identity = await api.teamIdentity(repoRoot).catch(() => null);
      const who = identity?.handle || identity?.name || "someone";
      const body = `${who} picked up #${payload.number}`;
      await api.chatSend({
        repoRoot,
        channel: "pull-requests",
        body,
      });
    } catch (e) {
      console.warn("/take failed:", e);
    }
  };
  const meta =
    payload.additions != null || payload.deletions != null ? (
      <span className="font-mono">
        {payload.additions != null ? (
          <span className="text-green-400">+{payload.additions}</span>
        ) : null}
        {payload.additions != null && payload.deletions != null ? " " : ""}
        {payload.deletions != null ? (
          <span className="text-red-400">-{payload.deletions}</span>
        ) : null}
        {payload.changed_files != null ? (
          <span className="text-text-4"> · {payload.changed_files}f</span>
        ) : null}
      </span>
    ) : null;
  const detail = (
    <>
      <span className="text-text-4">by</span>{" "}
      <span className="text-text-2">{payload.author || "unknown"}</span>
      {" · "}
      <span className="font-mono text-text-3">{payload.base_branch}</span>
      <span className="text-text-4"> ← </span>
      <span className="font-mono text-text-3">{payload.head_branch}</span>
      <div className="mt-0.5 text-text-4 text-[10.5px] font-mono">
        {payload.repo}
      </div>
    </>
  );
  return (
    <CardShell
      icon={<GitPullRequest size={11} />}
      tone="good"
      label="pr opened"
      title={`#${payload.number} · ${payload.title}`}
      meta={meta}
      detail={detail}
      cta={
        <div className="flex items-center gap-1.5">
          <CtaButton label="Open PR" onClick={onOpen} tone="good" />
          <CtaButton label="Take it" onClick={onTake} />
        </div>
      }
    />
  );
}

function PrLineCard({
  payload,
  repoRoot,
}: {
  payload: PrLineRelayPayload;
  repoRoot: string;
}) {
  const { openPrDetail } = useEditorStore();
  const onOpen = () => {
    openPrDetail(repoRoot, payload.number, `PR #${payload.number}`);
  };
  const range =
    payload.line_start === payload.line_end
      ? `${payload.line_start}`
      : `${payload.line_start}-${payload.line_end}`;
  const lines = payload.snippet.split("\n");
  const truncated = lines.length > PR_LINE_MAX_SNIPPET_LINES;
  const shown = truncated
    ? [...lines.slice(0, PR_LINE_MAX_SNIPPET_LINES), "…"].join("\n")
    : payload.snippet;
  const langChip = payload.language ? (
    <span className="text-text-4 text-[10.5px] font-mono">
      {payload.language}
    </span>
  ) : null;
  const detail = (
    <>
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className="font-mono text-text-3">{payload.file}</span>
        <span className="text-text-4">:{range}</span>
        {langChip ? <span className="text-text-5">·</span> : null}
        {langChip}
      </div>
      <pre className="mt-1 max-h-[200px] overflow-auto rounded bg-bg-1 border border-line-soft/60 p-1.5 text-[10.5px] leading-[1.4] font-mono text-text-2 whitespace-pre">
        {shown}
      </pre>
    </>
  );
  return (
    <CardShell
      icon={<Quote size={11} />}
      tone="neutral"
      label="pr quote"
      title={`PR #${payload.number}`}
      meta={
        <span className="font-mono text-text-4 text-[10.5px]">
          {payload.repo}
        </span>
      }
      detail={detail}
      cta={<CtaButton label="View in PR" onClick={onOpen} />}
    />
  );
}

// Re-export a no-op restore handler so consumers can wire it without
// importing the window-event constant string.
export const AURA_SNAPSHOT_RESTORE_EVENT = "aura:open-snapshot-restore";
