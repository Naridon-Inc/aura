// Everything a session detail reads about one run, worked out in one place so
// the pane is only layout. Each value here used to be computed inline in the
// pane; the reasoning that came with each one moved with it.

import { useEffect, useMemo, useState } from "react";
import {
  api,
  isMechanicalHookCapture,
  type ClaudeSession,
  type IntentChangeset,
  type IntentChangesetFile,
  type IntentRow,
} from "../../lib/api";
import { fetchSessions } from "../../lib/sessionsCache";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { TRACE_IA_V3 } from "../../lib/featureFlags";
import {
  correlateClaudeSession,
  displayedProvenance,
  isAutoStub,
  sessionDisplayTitle,
  type IntentProvenance,
} from "../../lib/sessionMeta";
import { splitIntent } from "../workpanes/IntentProse";
import {
  useChangesetSymbols,
  useChangesetSymbolsByFile,
} from "../workpanes/useChangesetSymbols";
import { useSubagentRuns } from "../workpanes/useSubagentRuns";
import type { SubagentRuns } from "../workpanes/subagentRuns";

/** Sum additions/deletions across a set of changeset files (null → 0). */
export function churnOf(files: IntentChangesetFile[]) {
  let adds = 0;
  let dels = 0;
  let hasChurn = false;
  for (const f of files) {
    if (typeof f.additions === "number") {
      adds += f.additions;
      hasChurn = true;
    }
    if (typeof f.deletions === "number") {
      dels += f.deletions;
      hasChurn = true;
    }
  }
  return { files: files.length, adds, dels, hasChurn };
}

/** Claude Code sessions for this project, painted from the process-lifetime
 *  cache and revalidated underneath, so a guard `[auto]` row can borrow the
 *  agent's real prompt and step count. A failed refresh never blanks a list
 *  we already had. */
function useClaudeSessions(repoRoot: string): ClaudeSession[] {
  const [sessions, setSessions] = useState<ClaudeSession[]>(
    () => peekCache<ClaudeSession[]>(`sessions:claude:${repoRoot}`) ?? [],
  );
  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    const key = `sessions:claude:${repoRoot}`;
    const cached = peekCache<ClaudeSession[]>(key);
    if (cached) setSessions(cached);
    fetchSessions(repoRoot)
      .then((s) => {
        const list = Array.isArray(s) ? s : [];
        writeCache(key, list);
        if (alive) setSessions(list);
      })
      .catch(() => {
        if (alive && !cached) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return sessions;
}

/** A native Aura chat row carries no intent-log changeset (the chat edits the
 *  working tree and never commits), so its files and their diffs against the
 *  chat's starting point are fetched here. null for any other row, and for a
 *  chat that only orchestrated — its changes live in the agents it started. */
function useChatChangeset(repoRoot: string, managerSessionId: string | null) {
  const [changeset, setChangeset] = useState<IntentChangeset | null>(() =>
    managerSessionId
      ? peekCache<IntentChangeset>(`mgrChangeset:${repoRoot}:${managerSessionId}`) ?? null
      : null,
  );
  useEffect(() => {
    if (!repoRoot || !managerSessionId) {
      setChangeset(null);
      return;
    }
    let alive = true;
    const key = `mgrChangeset:${repoRoot}:${managerSessionId}`;
    const cached = peekCache<IntentChangeset>(key);
    if (cached) setChangeset(cached);
    api
      .managerSessionChangeset(repoRoot, managerSessionId)
      .then((cs) => {
        const val = cs ?? null;
        if (val) writeCache(key, val);
        if (alive) setChangeset(val);
      })
      .catch(() => {
        if (alive && !cached) setChangeset(null);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, managerSessionId]);
  return changeset;
}

export function useSessionDetail({
  repoRoot,
  row,
  subagentRuns,
}: {
  repoRoot: string;
  row: IntentRow;
  subagentRuns?: SubagentRuns;
}) {
  const sessions = useClaudeSessions(repoRoot);
  const managerSessionId = (row.manager_session_id ?? "").trim() || null;
  const chatChangeset = useChatChangeset(repoRoot, managerSessionId);

  // One clock for every relative time on the page.
  const nowSecs = useMemo(() => Math.floor(Date.now() / 1000), []);
  const rel = relativeAgeFromDelta(nowSecs - row.timestamp, { style: "compact" });
  const whenAbsolute = useMemo(() => {
    const s = new Date(row.timestamp * 1000).toLocaleString();
    return s === "Invalid Date" ? "—" : s;
  }, [row.timestamp]);

  // A genuine intent row carries its own changeset; a chat row borrows the
  // fetched one, so both kinds of run render the same way downstream.
  const changeset = row.changeset ?? chatChangeset;
  const files = useMemo(() => changeset?.files ?? [], [changeset]);
  const churn = churnOf(files);
  const changedSymbols = useChangesetSymbols(repoRoot, files);
  const symbolsByFile = useChangesetSymbolsByFile(repoRoot, files);

  // Start writing the plain-language account of this run's commits the moment
  // it opens — opening a run is the signal someone is about to read it, and the
  // words take longer to write than a click. Safe to repeat: the backend
  // serves what it already wrote and never starts a second run of a piece.
  const commitShas = useMemo(() => {
    const seen = new Set<string>();
    for (const f of files) if (f.commit) seen.add(f.commit);
    return [...seen];
  }, [files]);
  useEffect(() => {
    if (!repoRoot) return;
    for (const sha of commitShas) {
      void api.prewarmChangeSummaries(repoRoot, sha).catch(() => {});
    }
  }, [repoRoot, commitShas]);

  // A blocked guard record is an attempt Aura refused to let land: no
  // transcript, no changeset, nothing to resume or prove.
  const isBlocked = row.intent_type === "blocked";

  // The Claude Code session this run matches by time. A chat row replays its
  // own conversation and a blocked record has none, so neither borrows the
  // nearest transcript — that false match is what once made a block read
  // "21 steps · Resume".
  const sess = useMemo(
    () => (managerSessionId || isBlocked ? null : correlateClaudeSession(row, sessions)),
    [managerSessionId, isBlocked, row, sessions],
  );

  // Which session to ask about its workers: the id stamped on the row at
  // log-intent time, else the matched transcript. Null when the answer could
  // only be false (a chat, a blocked record) or the host already read them.
  const subagentSessionId =
    subagentRuns || managerSessionId || isBlocked
      ? null
      : (row.claude_session_id ?? "").trim() || sess?.session_id || null;
  const ownSubagents = useSubagentRuns(subagentSessionId);
  const subagents = subagentRuns ?? ownSubagents;
  // An unanswered read and an answer of zero both mean no Workers tab: one is
  // a question nobody got to ask, the other a tab empty on most runs.
  const workers = useMemo(() => (subagents.known ? subagents.runs : []), [subagents]);

  const title = sessionDisplayTitle(row, sessions);
  // The run's own logged intent, stable while the correlation resolves. Only a
  // guard auto-stub borrows the matched session's first prompt.
  const asked = isAutoStub(row) ? sess?.first_prompt || title : row.intent;
  const { headline } = useMemo(() => splitIntent(asked), [asked]);
  // A run whose whole record is tool calls has no statement of its own: its
  // text is the command it ran, which is evidence, not a reason. The header
  // says the true title and the command goes in the Summary body.
  const commandOnly = isMechanicalHookCapture(row);
  const shownHeadline = (commandOnly ? "" : headline) || title;
  const statement = commandOnly ? row.intent : asked;
  const provenance: IntentProvenance = displayedProvenance(row, sess?.first_prompt);

  // The run's own commit — the key the Match view compares against.
  const alignmentSha = useMemo(() => {
    for (const f of files) {
      const c = (f.commit ?? "").trim();
      if (c) return c;
    }
    return null;
  }, [files]);
  // Match and Genuine record are worked out by the CLI against a checkout. A
  // changeset the cloud assembled has neither the AST nor the signed block, so
  // both views could only fail there.
  const locallyDerivable = changeset?.source !== "cloud";
  const showAlignment = TRACE_IA_V3 && !!alignmentSha && locallyDerivable;
  const alignmentAvailability = useMemo(
    () => ({
      available: showAlignment,
      unsupportedReason: !alignmentSha
        ? "This run's changes aren't saved to the repository's history yet, so there's no version to compare against."
        : !locallyDerivable
          ? "This record came from the cloud. Comparing what was asked with what changed needs the code on this computer."
          : "Comparing what was asked with what changed isn't available for this run.",
    }),
    [showAlignment, alignmentSha, locallyDerivable],
  );

  // How much work the run was: the agent's steps, and the person's messages
  // only when they steered more than once. Runs scanned before steps were
  // counted fall back to the old turn label.
  const depth = useMemo(() => {
    if (!sess) return [] as string[];
    const out: string[] = [];
    if (sess.turn_count > 1) out.push(`${sess.turn_count} messages`);
    if (sess.step_count > 0) out.push(`${sess.step_count} step${sess.step_count === 1 ? "" : "s"}`);
    else if (sess.turn_count === 1) out.push("1 turn");
    return out;
  }, [sess]);

  return {
    sessions,
    sess,
    managerSessionId,
    isBlocked,
    signed: !!row.signed_block_id,
    changeset,
    files,
    churn,
    changedSymbols,
    symbolsByFile,
    workers,
    title,
    shownHeadline,
    statement,
    provenance,
    showAlignment,
    canAttest: !!row.signed_block_id && locallyDerivable,
    alignmentAvailability,
    whenAbsolute,
    rel,
    depth,
    hasTranscript: !!managerSessionId || !!sess?.file_path,
  };
}

export type SessionDetail = ReturnType<typeof useSessionDetail>;
