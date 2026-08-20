// The other half of "what goes in this pane": what was already in it.
//
// Everything else the launcher offers is a thing that exists right now — an
// agent on PATH, a tab open somewhere, a session still running. None of that
// helps the reader whose actual question is "what was I doing here yesterday",
// and answering it meant leaving for the Sessions page and coming back.
//
// These rows are THIS CHECKOUT's own Claude Code transcripts, newest first,
// and picking one resumes it INTO this pane. They wear the same Row shape as
// everything else in the list so one search box and one Enter key still cover
// the whole panel.
//
// "This checkout" is load-bearing. `claude_list_sessions` deliberately unions
// every sibling worktree and the parent repo — a manual /resume picker should
// be able to reach a transcript whatever authored it — so the raw list shown in
// a worktree named `marrakesh` is mostly other people's work: `auckland`'s
// sessions, the main checkout's, a pruned worktree's. That is the wrong answer
// for a pane whose whole promise is "what was I doing HERE", and the first row
// under the reader's cursor would usually belong to another branch. Filtered
// through `isOwnWorktreeSession`, which decides on the transcript's physical
// project dir rather than its `cwd` (the lister rewrites `cwd` for orphans).

import { useEffect, useMemo, useState } from "react";

import { api, type ClaudeSession } from "../../lib/api";
import { isOwnWorktreeSession, resumeCwdOf } from "../../lib/agentSessionScope";
import { getPermissionMode, streamChannel } from "../../lib/agentStreamStore";
import { useEditorStore, type WorkPaneRef } from "../../lib/editorStore";
import { fetchSessions, peekSessions } from "../../lib/sessionsCache";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { sessionPromptTitle } from "../../lib/sessionPromptTitle";
import { toast } from "../../lib/toast";
import { truncate } from "../../lib/truncate";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Group, PickRow, type Row } from "./row";

/** How many transcripts the pane lists. A repo that has been worked in for
 *  months holds hundreds, and this is a 46vh card inside a launcher, not the
 *  history page — the row at the foot of the list says so and goes there. */
const SHOWN = 40;

/** Narrow the unioned list down to the transcripts this exact checkout
 *  authored. `undefined` in, `undefined` out — "nothing read yet" has to stay
 *  distinguishable from "read, and this worktree has none", or the pane paints
 *  a spinner forever on a fresh worktree. */
function ownOnly(
  list: ClaudeSession[] | undefined,
  repoRoot: string,
): ClaudeSession[] | null {
  if (!list) return null;
  return list.filter((s) => isOwnWorktreeSession(s, repoRoot));
}

export type EarlierSessions = {
  rows: Row[];
  /** The read is in flight and we have nothing cached to paint meanwhile. */
  loading: boolean;
  /** The walk failed. An empty list is a different fact and is not this. */
  error: string | null;
  /** How many exist in total — `rows` is capped at {@link SHOWN}. */
  total: number;
};

/** This repo's past agent sessions, as launcher rows that resume into a pane.
 *
 *  `place` is the launcher's own placement callback, so a resumed session lands
 *  where the reader is looking instead of appearing in some other pane. */
export function useEarlierSessions(
  repoRoot: string,
  place: (ref: WorkPaneRef) => void,
): EarlierSessions {
  const store = useEditorStore();
  // Paint whatever the shared cache already holds — the Sessions page, the
  // resume dialog and the overview all read the same list, so switching to
  // this tab usually has an answer in hand and a spinner would be a lie.
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(() =>
    ownOnly(peekSessions(repoRoot), repoRoot),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setSessions(ownOnly(peekSessions(repoRoot), repoRoot));
    fetchSessions(repoRoot)
      .then((list) => {
        if (live) setSessions(ownOnly(list, repoRoot));
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [repoRoot]);

  /** Re-open a past conversation as a live Claude tab in this pane.
   *
   *  The cwd is the session's own, not this workspace's: Claude resolves
   *  `--resume <id>` by the directory it was launched in, so a conversation
   *  authored inside a sibling worktree spawned at the project root comes back
   *  as an empty REPL with none of the transcript in it. */
  async function resume(s: ClaudeSession) {
    const title = sessionPromptTitle(s.last_prompt) || sessionPromptTitle(s.first_prompt);
    const label = truncate(title, 24) || "Claude";
    try {
      const cwd = resumeCwdOf(s, repoRoot);
      const pm = getPermissionMode(streamChannel("claude", cwd));
      const handle = await api.agentPtyOpen(
        "claude",
        cwd,
        96,
        32,
        s.session_id,
        true,
        undefined,
        pm === "default" ? undefined : pm,
      );
      store.openAgent({
        sessionId: handle.id,
        agentId: "claude",
        agentLabel: label,
        agentMonogram: "C",
        repoRoot: cwd,
        mode: "pty",
        resumeSessionId: s.session_id,
      });
      place({ kind: "agent", id: handle.id });
    } catch (e) {
      // Silence here reads as a dead row: the CLI can be missing, the
      // transcript can have been deleted out from under the list.
      toast.danger(`Couldn't resume ${label}`, String(e));
    }
  }

  const rows = useMemo<Row[]>(() => {
    return (sessions ?? []).slice(0, SHOWN).map((s) => {
      const last = sessionPromptTitle(s.last_prompt);
      const first = sessionPromptTitle(s.first_prompt);
      // The LAST thing typed identifies a conversation; openings are "hi" and
      // "continue" more often than they are the subject.
      const label = last || first || "Untitled session";
      return {
        key: `s:${s.session_id}`,
        label,
        sub: s.mtime > 0 ? relativeAgeFromSecs(s.mtime) : "",
        // Everything a reader might type looking for one of these. The search
        // box is the only filter in this panel, so the words it can't see are
        // words that don't work.
        kind: `session history resume claude ${s.cwd_rel}`.toLowerCase(),
        icon: <AgentIcon agentId="claude" label="C" size={13} />,
        onPick: () => void resume(s),
      };
    });
    // `store` and `place` outlive a picker that unmounts the moment it is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, repoRoot]);

  return {
    rows,
    loading: sessions === null && !error,
    error,
    total: sessions?.length ?? 0,
  };
}

/** The earlier half of the launcher's list. Same rows, same cursor — the only
 *  thing this adds is what to say when there are none, and the way out to the
 *  full history for the ones this pane doesn't list. */
export function EarlierBody({
  rows,
  state,
  activeKey,
  onOpenHistory,
}: {
  rows: Row[];
  state: EarlierSessions;
  activeKey?: string;
  /** Omitted when the Sessions page isn't available — we never print a way out
   *  that goes nowhere. */
  onOpenHistory?: () => void;
}) {
  if (state.loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-4 text-sm text-text-4">
        <AsciiSpinner />
        Looking for what ran here before…
      </div>
    );
  }

  if (state.error) {
    // Not "you have no history" — we could not look, and those are different
    // facts. Saying the first when the second is true is how a reader concludes
    // their work is gone.
    return (
      <p className="px-3 py-4 text-xs leading-relaxed text-text-4">
        Couldn&rsquo;t read the sessions here.
        <span className="block mt-1 font-mono text-2xs text-text-5">
          {state.error}
        </span>
      </p>
    );
  }

  if (state.total === 0) {
    // "here", not "in this project": the list is scoped to this checkout, and
    // a worktree with no history of its own sits inside a project with plenty.
    return (
      <p className="px-3 py-4 text-xs leading-relaxed text-text-4">
        Nothing has run here yet. The first agent you start from &ldquo;Start
        something new&rdquo; shows up here afterwards.
      </p>
    );
  }

  return (
    <>
      <Group label="Pick up where you left off">
        {rows.map((r) => (
          <PickRow key={r.key} row={r} active={activeKey === r.key} />
        ))}
      </Group>
      {/* A cap the reader can't see is a cap that reads as "that's all of
          them". Say the number and point at the surface that holds the rest. */}
      {(state.total > rows.length || onOpenHistory) && (
        <div className="flex items-center gap-2 px-3 pb-3 pt-1 text-xs text-text-5">
          {state.total > rows.length && (
            <span>
              Showing the {rows.length} most recent of {state.total}.
            </span>
          )}
          {onOpenHistory && (
            <button
              type="button"
              onClick={onOpenHistory}
              className="text-text-4 hover:text-text-1 hover:underline transition-colors"
            >
              Open the full history
            </button>
          )}
        </div>
      )}
    </>
  );
}
