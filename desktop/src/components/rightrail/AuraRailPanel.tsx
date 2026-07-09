// Right-rail "Aura" tab — always-on Manager surface scoped to the current
// workspace. Boots an ambient ManagerSession per repoRoot; the same session
// survives reloads via localStorage[`aura.ambient.<repoRoot>`].
//
// Visual shell ports the Forge Chat-States prototype (Stage 11.6): the
// pre-sid empty state uses the prototype's panel chrome verbatim — tabs
// strip + scroll area with empty-hero + dock-with-composer. Once the
// session exists, ManagerSurface takes over and renders the same shell
// around the live chat.
//
// First send: managerChatStart only stages the session shell — manager_chat
// is what actually fires brain::run_turn. We call both before persisting.

import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { ManagerSurface } from "../manager/ManagerSurface";
import { ChatIconsSprite } from "../manager/ChatIconsSprite";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FOCUS_MANAGER_EVENT, type FocusManagerDetail } from "../../lib/focusManager";

type Props = { repoRoot: string };

const ambientKey = (repoRoot: string) => `aura.ambient.${repoRoot}`;

/** Same-directory check, tolerant of trailing slashes. The ambient pointer
 *  is keyed by repoRoot, but a stale entry written before sessions were
 *  workspace-scoped could point at a session from another project — we must
 *  never resolve and operate on it here. Compared as normalized strings;
 *  the backend's `manager_list` does the canonical (symlink-resolving)
 *  match, this is just the renderer-side guard. */
function sameRoot(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export function AuraRailPanel({ repoRoot }: Props) {
  const [sid, setSid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Validate persisted sid for this repoRoot. Drop the entry if the server
  // no longer knows it (rare — happens after `aura manager prune` or fresh
  // backend state).
  useEffect(() => {
    let alive = true;
    setReady(false);
    setSid(null);
    setError(null);
    const persisted = localStorage.getItem(ambientKey(repoRoot));
    if (!persisted) {
      setReady(true);
      return;
    }
    api
      .managerStatus(persisted)
      .then((s) => {
        if (!alive) return;
        // The session must both exist AND belong to this workspace. A
        // session bound to another project (or none) is a cross-workspace
        // leak — drop the stale pointer rather than show/operate on it.
        const belongs =
          !!s &&
          !!s.id &&
          s.projects.some((p) => sameRoot(p.root, repoRoot));
        if (belongs) setSid(s.id);
        else localStorage.removeItem(ambientKey(repoRoot));
      })
      .catch(() => {
        if (!alive) return;
        localStorage.removeItem(ambientKey(repoRoot));
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // External callers (manager launcher, plan handoff, dashboard click)
  // persist the ambient sid + dispatch this event. We snap to the new
  // session when it matches our repoRoot.
  useEffect(() => {
    function onFocus(ev: Event) {
      const detail = (ev as CustomEvent<FocusManagerDetail>).detail;
      if (!detail || detail.repoRoot !== repoRoot) return;
      setSid(detail.sessionId);
      setSeed("");
      setError(null);
    }
    window.addEventListener(FOCUS_MANAGER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_MANAGER_EVENT, onFocus);
  }, [repoRoot]);

  async function startSession(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const newSid = await api.managerChatStart(repoRoot, trimmed);
      localStorage.setItem(ambientKey(repoRoot), newSid);
      // Fire the brain — chat_start only stages the session.
      api.managerChat(newSid, trimmed).catch((e) => {
        console.warn("[aura-rail] manager_chat failed:", e);
      });
      setSid(newSid);
      setSeed("");
    } catch (e) {
      console.warn("[aura-rail] manager_chat_start failed:", e);
      setError(
        e instanceof Error
          ? e.message
          : "Failed to start ambient Aura session.",
      );
    } finally {
      setBusy(false);
    }
  }

  function newThread() {
    if (busy) return;
    localStorage.removeItem(ambientKey(repoRoot));
    setSid(null);
    setSeed("");
    setTimeout(() => taRef.current?.focus(), 0);
  }

  if (!ready) {
    return (
      <div className="h-full w-full flex items-center justify-center text-text-3 text-xs">
        Loading Aura…
      </div>
    );
  }

  if (sid) {
    // ManagerSurface owns the .aura-chat wrapper + sprite for the live
    // session — keep it self-contained so it works in non-rail contexts too.
    return <ManagerSurface sessionId={sid} onNewThread={newThread} />;
  }

  // Empty state — direct port of the prototype's "01 — Empty / new chat".
  // panel > p-tabs + p-scroll(empty-hero) + p-dock(composer).
  const canSend = seed.trim().length > 0 && !busy;
  return (
    <div className="aura-chat h-full w-full flex flex-col min-h-0">
      <ChatIconsSprite />
      <div className="panel">
        <div className="p-tabs">
          <div className="p-tab active">
            <span className="dot faint" />
            New chat
          </div>
          <div className="spacer" />
          <button type="button" className="icon-btn" title="New tab" onClick={newThread}>
            <svg className="ico"><use href="#i-plus" /></svg>
          </button>
          <button type="button" className="icon-btn" title="History">
            <svg className="ico"><use href="#i-history" /></svg>
          </button>
          <button type="button" className="icon-btn" title="More">
            <svg className="ico"><use href="#i-more" /></svg>
          </button>
        </div>

        <div className="p-scroll" style={{ display: "flex" }}>
          <div className="empty-hero">
            <h3>What are we building today?</h3>
            <p>
              Ask a question, plan a change, or paste an error. Use{" "}
              <span className="codeword">@</span> to attach files and{" "}
              <span className="codeword">/</span> for commands.
            </p>
            <div className="quick-row">
              <button
                type="button"
                className="quick"
                onClick={() => void startSession("Plan a refactor across the repo")}
              >
                <span className="qg"><svg className="ico"><use href="#i-sparkles" /></svg></span>
                Plan a refactor across the repo
                <svg className="ico arrow"><use href="#i-chev-right" /></svg>
              </button>
              <button
                type="button"
                className="quick"
                onClick={() => void startSession("Explain what this file does")}
              >
                <span className="qg"><svg className="ico"><use href="#i-up-right" /></svg></span>
                Explain what this file does
                <svg className="ico arrow"><use href="#i-chev-right" /></svg>
              </button>
              <button
                type="button"
                className="quick"
                onClick={() => void startSession("Set up a multi-agent task")}
              >
                <span className="qg"><svg className="ico"><use href="#i-stack" /></svg></span>
                Set up a multi-agent task
                <svg className="ico arrow"><use href="#i-chev-right" /></svg>
              </button>
            </div>
            {error && (
              <Badge variant="warn" className="!h-auto !whitespace-normal !py-1 max-w-[300px]">
                {error}
              </Badge>
            )}
          </div>
        </div>

        <div className="p-dock">
          <div className="composer">
            <textarea
              ref={taRef}
              autoFocus
              className="inputline"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void startSession(seed);
                }
              }}
              placeholder="Plan, Build, / for commands, @ for context"
              rows={1}
              disabled={busy}
            />
            <div className="composer-bottom">
              <span className="chip mode">
                <svg className="ico-12"><use href="#i-list-checks" /></svg>
                Plan
                <svg className="ico-12"><use href="#i-chev-down" /></svg>
              </span>
              <span className="chip">
                Auto
                <svg className="ico-12"><use href="#i-chev-down" /></svg>
              </span>
              <div className="right">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="font-mono"
                  disabled={!canSend}
                  onClick={() => void startSession(seed)}
                  title="Send (↵)"
                >
                  <svg className="ico-12"><use href="#i-arrow-up" /></svg>
                  <span className="send-kbd">⌘↵</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
