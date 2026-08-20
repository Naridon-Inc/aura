// Every agent PTY the shell currently owns, in ANY project or worktree.
//
// This is the answer to "I have agents running everywhere, why does this say
// nothing is open?". A picker built only from THIS editor's tab lists reports
// an empty machine the moment your agents happen to live in other panes or
// other projects — which is most of the time, and is exactly what the "+"
// picker did until it started calling this.
//
// `ptyListAlive` is the only call that spans projects (`agent_pty_list` filters
// to one root), so it discovers WHICH roots have agents; the per-root
// follow-ups add the window titles that tell six Claudes apart. Both read the
// same in-memory registry, so polling this while a picker is on screen is
// cheap.

import { useEffect, useState } from "react";
import { api, type LiveAgentSession } from "./api";
import { titleCaseName } from "./textCase";

const POLL_MS = 6000;

/** Identity, not activity: re-setting state on every poll would rebuild the
 *  list twice a minute for nothing. Timestamps are deliberately out of the key
 *  — rows are ordered by recency, they don't print it. */
function identity(rows: LiveAgentSession[]): string {
  return rows.map((r) => `${r.session_id}\u0000${r.title ?? ""}`).join("\u0001");
}

/** Poll the live agent registry while `active` (a picker being open). Pass
 *  `false` and the hook holds its last answer without polling. */
export function useLiveAgentSessions(active = true): LiveAgentSession[] {
  const [live, setLive] = useState<LiveAgentSession[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function refresh() {
      try {
        const alive = await api.ptyListAlive();
        const roots = [...new Set(alive.map((s) => s.repo_root))];
        const perRoot = await Promise.all(
          roots.map((root) => api.agentPtyList(root).catch(() => [])),
        );
        if (cancelled) return;
        const rich = perRoot.flat();
        // A session `ptyListAlive` knows about but whose root returned nothing
        // (registry raced with a close) still deserves a row — better a row
        // without a title than a missing agent.
        const covered = new Set(rich.map((s) => s.session_id));
        const rest: LiveAgentSession[] = alive
          .filter((s) => !covered.has(s.session_id))
          .map((s) => ({
            session_id: s.session_id,
            agent_id: s.agent_id,
            repo_root: s.repo_root,
            last_byte_ms: 0,
            title: null,
          }));
        const next = [...rich, ...rest];
        setLive((prev) => (identity(prev) === identity(next) ? prev : next));
      } catch {
        if (!cancelled) setLive([]);
      }
    }

    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  return live;
}

/** Just the ids, for callers that only need to ask "is this session still
 *  running?" — the roster lane and the Workspaces board, which hold their own
 *  labels already and would pay for `agent_pty_list` per root for nothing.
 *
 *  Starts EMPTY and fills on the first poll. Callers use it to admit persisted
 *  agents, so the pre-first-poll answer under-reports (live tabs only) rather
 *  than over-reporting — the direction that doesn't invent working agents. */
export function useLivePtySessionIds(active = true): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function refresh() {
      try {
        const alive = await api.ptyListAlive();
        if (cancelled) return;
        const next = new Set(alive.map((s) => s.session_id));
        setIds((prev) =>
          prev.size === next.size && [...next].every((id) => prev.has(id))
            ? prev
            : next,
        );
      } catch {
        // A failed read is not evidence that nothing is running. Hold the
        // last answer rather than emptying every lane on one bad poll.
      }
    }

    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  return ids;
}

/** Display name for a running agent's CLI id — `cursor-agent` → `Cursor
 *  Agent`. A live session carries only the id; hand-written launcher labels
 *  don't reach these rows.
 *
 *  The one seam for this question, kept as its own name rather than inlined at
 *  the call sites: six separate tables in this app map a known agent id to a
 *  hand-written name (Claude, OpenAI, DeepSeek…), and when those are folded
 *  together this is where the lookup belongs. Until then it is the slug rule. */
export function labelForAgentId(agentId: string): string {
  return titleCaseName(agentId);
}
