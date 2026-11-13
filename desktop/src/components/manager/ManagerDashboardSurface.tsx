// The workspace's home: the chat before there is a chat.
//
// Workspace-open should land you IN a chat, not at an empty splash. So this
// surface is ambient-session-aware:
//   • On mount it resolves the project's ambient ManagerSession (the same
//     localStorage[`aura.ambient.<repoRoot>`] pointer AuraRailPanel uses,
//     validated against `manager_status` so a stale/cross-workspace sid is
//     dropped). When one exists we render the live <ManagerSurface> — you
//     resume your chat the moment the workspace opens.
//   • Otherwise the home shows. The first send converts it in place into the
//     live chat (via `sendToAmbientManager`, which both starts the session
//     AND fires the brain's first turn). We never eagerly mint an empty
//     session, so there's no empty-thread sprawl.
//   • "New thread" clears the ambient pointer and drops back to the home.
//
// The Manager plans the objective, fans it out across Claude Code / Gemini /
// Codex / Cursor, keeps every step audited, and surfaces the result
// like a chat (what each agent said + what it edited).
//
// It is drawn as the empty conversation it turns into: the chat's own empty
// state (headline, starters, the line naming where the work happens) in the
// conversation column, the same composer band under it, and the
// conversations you could pick back up beneath the starters. It used to be a
// page of its own — its own headline, its own text box, three context chips
// drawn with carets that opened nothing — so the first thing a workspace
// showed you was a screen that changed shape the moment you used it.
//
// The box keeps what was typed in it: Up at the start of an empty field walks
// back through the prompts sent from here, and the prompt that opens a
// conversation is that conversation's first entry, so Up in the chat it
// becomes recalls it. Neither used to happen — the home had no recall, and the
// chat it opened started with an empty ring.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ambientKey as ambientKeyFor } from "../../lib/ambientSession";
import { api, type ClaudeSession } from "../../lib/api";
import { fetchManagerList } from "../../lib/managerCache";
import { fetchSessions } from "../../lib/sessionsCache";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import {
  FOCUS_MANAGER_EVENT,
  type FocusManagerDetail,
  sendToAmbientManager,
} from "../../lib/focusManager";
import { AgentIcon } from "../agent/AgentIcon";
import { composerKey, MANAGER_HISTORY_PREFIX, rememberSent } from "../composer/composerDrafts";
import { usePromptRecall } from "../composer/usePromptRecall";
import { ChatComposerArea, ChatTranscript } from "../ui/chat-surface";
import { Composer } from "../ui/composer";
import { ErrorNote, LoadingState } from "../ui/state";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { ChatStarters } from "./chat/ChatStarters";
import { ManagerSurface } from "./ManagerSurface";
import "../ui/log-note.css";
import "../ui/chat-home.css";

type Props = {
  repoRoot: string;
  projectName: string;
};

/** This surface is the workspace's own dashboard — the copy of the project on
 *  this disk — so the pointer it keeps is the local one. A conversation about
 *  a machine's copy belongs to that machine's workspace and has its own. */
const ambientKey = (repoRoot: string) => ambientKeyFor(repoRoot, null);

/** The home's own recall ring: the prompts sent from this workspace's home,
 *  filed beside the chat rings under the same prefix. */
const homeRecallKey = (repoRoot: string) =>
  composerKey(MANAGER_HISTORY_PREFIX, `home:${repoRoot}`);

/** Trailing-slash-tolerant root compare — same guard AuraRailPanel applies
 *  before trusting a persisted ambient sid. A pointer written for another
 *  project (or before sessions were workspace-scoped) must never resolve
 *  here. */
function sameRoot(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export function ManagerDashboardSurface({ repoRoot, projectName }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  // Ambient-session state. `ready=false` guards the first paint so we don't
  // flash the home before we know a live chat exists to resume.
  const [sid, setSid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const recall = usePromptRecall({
    storageKey: homeRecallKey(repoRoot),
    value: prompt,
    setValue: setPrompt,
    fieldRef,
  });

  // Resolve which chat to land on when the workspace opens. Two-step, so a
  // workspace that HAS chats never dumps you at the empty launcher:
  //
  //   1. Prefer the explicit ambient pointer (localStorage[`aura.ambient.<root>`],
  //      the same one AuraRailPanel writes) when it still resolves to a live
  //      session bound to THIS repoRoot. Validated via `manager_status` so a
  //      stale or cross-workspace sid is dropped.
  //   2. No usable pointer → resume the workspace's most-recent chat. The
  //      pointer is only ever written when a surface explicitly focuses a
  //      session (boot restore, the rail, a launch), so a returning user who
  //      opens a workspace they never explicitly focused — including the
  //      bundled Get Started sample, whose seeded conversation lives under its
  //      root but whose pointer was only written on a genuine first run — would
  //      otherwise always land on the empty splash even though a real chat
  //      exists. We adopt the latest and persist the pointer so the rail and
  //      center stay in sync.
  //
  // A workspace with no chats at all falls through to the launcher splash,
  // which is the chat's own empty home (the first send converts it in place) —
  // so "open a workspace → land in the chat" holds without ever minting an
  // empty thread.
  useEffect(() => {
    let alive = true;
    setReady(false);
    setSid(null);

    (async () => {
      // 1) Explicit ambient pointer, if it still resolves for this workspace.
      let persisted: string | null = null;
      try {
        persisted = localStorage.getItem(ambientKey(repoRoot));
      } catch {
        persisted = null;
      }
      if (persisted) {
        try {
          const s = await api.managerStatus(persisted);
          const belongs =
            !!s && !!s.id && s.projects.some((p) => sameRoot(p.root, repoRoot));
          if (belongs) {
            if (alive) {
              setSid(s.id);
              setReady(true);
            }
            return;
          }
        } catch {
          /* stale/unknown sid — fall through to the per-workspace resume */
        }
        // Pointer no longer resolves for this workspace — drop it so we don't
        // keep re-checking a dead sid on every open.
        try {
          localStorage.removeItem(ambientKey(repoRoot));
        } catch {
          /* ignore */
        }
      }

      // 2) Resume the workspace's most-recent chat instead of the empty splash.
      try {
        const list = await fetchManagerList(repoRoot);
        const latest = list
          .filter((m) => !!m.repo_root && sameRoot(m.repo_root, repoRoot))
          // …and running HERE. A chat whose hands are on a machine is filed
          // under this project too — its board and transcript are local — but
          // adopting it into the local workspace's dashboard would put a
          // conversation about another copy of the code in front of you and
          // then write it down as this project's local thread.
          .filter((m) => !m.machine_id)
          .sort((a, b) => b.updated_at - a.updated_at)[0];
        if (latest && alive) {
          setSid(latest.id);
          try {
            localStorage.setItem(ambientKey(repoRoot), latest.id);
          } catch {
            /* quota — non-fatal, the sid still drives this session */
          }
        }
      } catch {
        /* no list available — show the launcher splash */
      }
      if (alive) setReady(true);
    })();

    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Stay in sync when another surface (rail, PR copilot, launch glue) focuses
  // a session for this workspace — snap the center to the same live chat.
  useEffect(() => {
    function onFocus(ev: Event) {
      const detail = (ev as CustomEvent<FocusManagerDetail>).detail;
      if (!detail || detail.repoRoot !== repoRoot) return;
      setSid(detail.sessionId);
      setError(null);
    }
    window.addEventListener(FOCUS_MANAGER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_MANAGER_EVENT, onFocus);
  }, [repoRoot]);

  // The resume-recent list only matters while the home is showing — load it
  // lazily once we know there's no live chat. (The branch is the empty
  // state's to read: it names the working copy from real git data.)
  useEffect(() => {
    if (sid || !ready) return;
    let cancelled = false;
    fetchSessions(repoRoot)
      .then((list) => {
        if (cancelled) return;
        setSessions(list.slice(0, 4));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoRoot, sid, ready]);

  // The home is where a workspace opens, so its box takes the keyboard — as
  // the text box it replaces did.
  const showingHome = ready && !sid;
  useEffect(() => {
    if (showingHome) fieldRef.current?.focus();
  }, [showingHome]);

  async function dispatch(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // sendToAmbientManager does the proven two-step (start the session AND
      // fire the brain's first turn) + persists the ambient pointer + focuses
      // the rail. We adopt the returned sid so the center converts in place
      // into the live chat instead of leaving the user staring at the home.
      const sessionId = await sendToAmbientManager(repoRoot, trimmed);
      // The opening prompt is the conversation's first message: file it where
      // the chat's composer looks, before that composer mounts and reads it.
      rememberSent(composerKey(MANAGER_HISTORY_PREFIX, sessionId), trimmed);
      recall.remember(trimmed);
      setSid(sessionId);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function newThread() {
    if (busy) return;
    try {
      localStorage.removeItem(ambientKey(repoRoot));
    } catch {
      /* ignore */
    }
    setSid(null);
    setPrompt("");
    setError(null);
  }

  /** Enter sends (the composer's own key, as in the chat); ⌘↵ still does,
   *  as it always has here; Up/Down at the field's edge walk the recall. */
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void dispatch(prompt);
      return;
    }
    recall.onKeyDown(e);
  }

  function resume(s: ClaudeSession) {
    window.dispatchEvent(
      new CustomEvent("aura:resume-claude-session", { detail: { session: s } }),
    );
  }

  if (!ready) {
    return (
      <div className="ui-chat-home" data-state="loading">
        <LoadingState size="md" label="Loading Aura…" />
      </div>
    );
  }

  if (sid) {
    // A live chat exists for this workspace — resume it in place. ManagerSurface
    // owns its own .aura-chat shell + composer; "New thread" drops back here.
    return <ManagerSurface sessionId={sid} onNewThread={newThread} />;
  }

  const recent = sessions.slice(0, 3);

  return (
    <div className="ui-chat-home">
      <ChatTranscript>
        <ChatEmptyState projectLabel={projectName} repoRoot={repoRoot} />
        {recent.length > 0 && (
          <section className="ui-chat-home-recent" aria-label="Resume recent">
            <div className="ui-log-note-files-head">
              <span>Resume recent</span>
              <span className="ui-log-note-count">{recent.length}</span>
            </div>
            {recent.map((s) => {
              const preview = s.last_prompt || s.first_prompt || "(no prompt recorded)";
              const turns = `${s.turn_count} turn${s.turn_count === 1 ? "" : "s"}`;
              return (
                <button
                  key={s.session_id}
                  type="button"
                  className="ui-menu-row"
                  onClick={() => resume(s)}
                  title={`Resume Claude session. ${turns}`}
                >
                  <AgentIcon agentId="claude" label="Claude" size={14} />
                  <span className="ui-chat-home-recent-text">
                    <span>{preview}</span>
                    <small>{`Claude · ${turns} · ${formatAge(s.mtime)}`}</small>
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </ChatTranscript>
      <ChatComposerArea>
        {error && <ErrorNote>Didn’t send: {error}</ErrorNote>}
        {!busy && <ChatStarters repoRoot={repoRoot} onPick={(p) => void dispatch(p)} />}
        <Composer
          value={prompt}
          onChange={setPrompt}
          onSend={() => void dispatch(prompt)}
          disabled={busy}
          placeholder="Ask Aura anything"
          ariaLabel="Message Aura"
          textareaRef={fieldRef}
          onKeyDown={onKey}
        />
      </ChatComposerArea>
    </div>
  );
}

function formatAge(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(secs);
}
