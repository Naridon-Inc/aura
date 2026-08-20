// Aura Manager landing — chat-first, Codex-style.
//
// Workspace-open should land you IN a chat, not at an empty splash. So this
// surface is ambient-session-aware:
//   • On mount it resolves the project's ambient ManagerSession (the same
//     localStorage[`aura.ambient.<repoRoot>`] pointer AuraRailPanel uses,
//     validated against `manager_status` so a stale/cross-workspace sid is
//     dropped). When one exists we render the live <ManagerSurface> — you
//     resume your chat the moment the workspace opens.
//   • Otherwise the launcher splash shows. The first send converts it in
//     place into the live chat (via `sendToAmbientManager`, which both
//     starts the session AND fires the brain's first turn). We never eagerly
//     mint an empty session, so there's no empty-thread sprawl.
//   • "New thread" clears the ambient pointer and drops back to the splash.
//
// The Manager plans the objective, fans it out across Claude Code / Gemini /
// Codex / Cursor, keeps every step audited, and surfaces the result
// like a chat (what each agent said + what it edited).
//
// Layout (matches the Codex web reference):
//   • centered "What should we build in <project>?" headline
//   • big rounded composer whose bar holds the one control that works here:
//       send. Permissions, model, effort and mode are per-TURN knobs; they
//       live on the chat composer this converts into on the first send.
//   • context chips row directly below — project / scope / branch
//   • one-tap suggestion rows with thin dividers (no pills)
//   • Resume-recent rows in the same divider-list pattern when present
//
// Strict no-emoji policy: every glyph is an inline SVG.

import { useEffect, useState } from "react";
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
import { ManagerSurface } from "./ManagerSurface";
import { truncate } from "../../lib/truncate";

type Props = {
  repoRoot: string;
  projectName: string;
};

/** This surface is the workspace's own dashboard — the copy of the project on
 *  this disk — so the pointer it keeps is the local one. A conversation about
 *  a machine's copy belongs to that machine's workspace and has its own. */
const ambientKey = (repoRoot: string) => ambientKeyFor(repoRoot, null);

/** Trailing-slash-tolerant root compare — same guard AuraRailPanel applies
 *  before trusting a persisted ambient sid. A pointer written for another
 *  project (or before sessions were workspace-scoped) must never resolve
 *  here. */
function sameRoot(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

type Suggestion = {
  glyph: SuggestionGlyphKind;
  text: string;
};

type SuggestionGlyphKind =
  | "wrench"
  | "bug"
  | "package"
  | "check"
  | "note";

const SUGGESTIONS: ReadonlyArray<Suggestion> = [
  { glyph: "wrench",  text: "Add a dark mode toggle to Settings" },
  { glyph: "bug",     text: "Fix the flaky test in the auth suite" },
  { glyph: "package", text: "Refactor the API client into a typed module" },
  { glyph: "check",   text: "Add tests for the recently changed files" },
  { glyph: "note",    text: "Write a release note for the last 10 commits" },
];

export function ManagerDashboardSurface({ repoRoot, projectName }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [branch, setBranch] = useState<string>("");
  // Ambient-session state. `ready=false` guards the first paint so we don't
  // flash the launcher splash before we know a live chat exists to resume.
  const [sid, setSid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

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

  // The launcher's resume-recent list + branch chip only matter while the
  // splash is showing — load them lazily once we know there's no live chat.
  useEffect(() => {
    if (sid || !ready) return;
    let cancelled = false;
    fetchSessions(repoRoot)
      .then((list) => {
        if (cancelled) return;
        setSessions(list.slice(0, 4));
      })
      .catch(() => {});
    api
      .gitBranch(repoRoot)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoRoot, sid, ready]);

  async function dispatch(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // sendToAmbientManager does the proven two-step (start the session AND
      // fire the brain's first turn) + persists the ambient pointer + focuses
      // the rail. We adopt the returned sid so the center converts in place
      // into the live chat instead of leaving the user staring at the splash.
      const sessionId = await sendToAmbientManager(repoRoot, trimmed);
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

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      dispatch(prompt);
    }
  }

  function resume(s: ClaudeSession) {
    window.dispatchEvent(
      new CustomEvent("aura:resume-claude-session", { detail: { session: s } }),
    );
  }

  if (!ready) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-content text-text-3 text-xs">
        Loading Aura…
      </div>
    );
  }

  if (sid) {
    // A live chat exists for this workspace — resume it in place. ManagerSurface
    // owns its own .aura-chat shell + composer; "New thread" drops back here.
    return <ManagerSurface sessionId={sid} onNewThread={newThread} />;
  }

  const branchShort = shortenBranch(branch);

  return (
    <div className="h-full w-full overflow-y-auto bg-bg-content">
      <div className="flex justify-center px-6 pt-16 pb-10">
        <div className="w-full max-w-[600px] flex flex-col items-stretch gap-3">
          <h1 className="text-xl font-medium text-text-1 text-center leading-snug">
            What should we build in {projectName}?
          </h1>

          <div className="flex flex-col gap-1.5">
            <div className="rounded-[14px] border border-line-soft bg-bg-card focus-within:border-line transition-colors">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKey}
                placeholder="Ask Aura anything. @ to mention files"
                rows={1}
                disabled={busy}
                autoFocus
                className="w-full bg-transparent px-3.5 pt-2.5 pb-1 text-base text-text-1 placeholder:text-text-4 focus:outline-none resize-none disabled:opacity-50 no-scrollbar leading-relaxed"
                style={{ minHeight: 30 }}
              />
              {/* Only what works. This bar used to draw an attach button, a
                  permissions chip, a model chip and a mic — four affordances
                  with carets and hover states and no handlers behind any of
                  them, on the first screen of an opened workspace. The real
                  ones live on the chat composer this converts into on the
                  first send, where a per-turn knob can actually mean
                  something. */}
              <div className="flex items-center gap-1 px-2 pb-1.5 pt-0.5">
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => dispatch(prompt)}
                  disabled={busy || !prompt.trim()}
                  title={busy ? "Dispatching…" : "Dispatch ⌘↵"}
                  className="flex items-center justify-center rounded-full transition-opacity disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90"
                  style={{
                    width: 22,
                    height: 22,
                    background: "var(--color-text-1)",
                    color: "var(--color-bg-1)",
                  }}
                >
                  <ArrowUpGlyph />
                </button>
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-1 pl-0.5">
              <ContextChip glyph={<FolderChipGlyph />} text={projectName} />
              <ContextChip glyph={<LaptopGlyph />} text="Work locally" />
              <ContextChip
                glyph={<BranchGlyph />}
                text={branchShort || "no branch"}
              />
            </div>

            {error ? (
              <div className="text-xs text-caret-orange px-1">
                Failed: {error}
              </div>
            ) : null}
          </div>

          <DividerList>
            {SUGGESTIONS.map((s, i) => (
              <DividerRow
                key={s.text}
                first={i === 0}
                onClick={() => dispatch(s.text)}
                disabled={busy}
                glyph={<SuggestionGlyph kind={s.glyph} />}
                text={s.text}
              />
            ))}
          </DividerList>

          {sessions.length > 0 && (
            <DividerList header="Resume recent">
              {sessions.slice(0, 3).map((s, i) => {
                const preview =
                  s.last_prompt || s.first_prompt || "(no prompt recorded)";
                return (
                  <DividerRow
                    key={s.session_id}
                    first={i === 0}
                    onClick={() => resume(s)}
                    glyph={<ResumeGlyph />}
                    text={preview}
                    meta={`Claude · ${s.turn_count} turn${s.turn_count === 1 ? "" : "s"} · ${formatAge(s.mtime)}`}
                    title={`Resume Claude session. ${s.turn_count} turn${s.turn_count === 1 ? "" : "s"}`}
                  />
                );
              })}
            </DividerList>
          )}
        </div>
      </div>
    </div>
  );
}

function shortenBranch(b: string): string {
  return truncate(b, 30);
}

function ContextChip({
  glyph,
  text,
}: {
  glyph: React.ReactNode;
  text: string;
}) {
  return (
    <span
      className="flex items-center gap-1 text-xs text-text-3 hover:text-text-2 hover:bg-state-hover rounded px-1.5 transition-colors cursor-default"
      style={{ height: 22 }}
    >
      <span className="text-text-4 flex items-center justify-center" style={{ width: 11, height: 11 }}>
        {glyph}
      </span>
      <span className="truncate max-w-[160px]">{text}</span>
      <span className="text-text-4">
        <CaretGlyph />
      </span>
    </span>
  );
}

function DividerList({
  header,
  children,
}: {
  header?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {header && (
        <div className="section-label px-1 pb-1">
          {header}
        </div>
      )}
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function DividerRow({
  first,
  onClick,
  disabled,
  glyph,
  text,
  meta,
  title,
}: {
  first?: boolean;
  onClick: () => void;
  disabled?: boolean;
  glyph: React.ReactNode;
  text: string;
  meta?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`group w-full text-left flex items-center gap-2.5 px-2 transition-colors disabled:opacity-50 hover:bg-state-hover ${first ? "" : "border-t border-line-soft"}`}
      style={{ minHeight: 32, paddingTop: meta ? 6 : 0, paddingBottom: meta ? 6 : 0 }}
    >
      <span
        className="text-text-4 group-hover:text-text-2 flex items-center justify-center flex-shrink-0"
        style={{ width: 14, height: 14 }}
      >
        {glyph}
      </span>
      <span className="flex-1 min-w-0">
        <span className="text-sm text-text-2 group-hover:text-text-1 block truncate">
          {text}
        </span>
        {meta && (
          <span className="text-2xs text-text-4 block truncate mt-0.5">
            {meta}
          </span>
        )}
      </span>
    </button>
  );
}

function CaretGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUpGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M8 12V4M4.5 7.5L8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderChipGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1.5 3.5h3l1 1h4.5a.5.5 0 0 1 .5.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function LaptopGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="3" width="8" height="5" rx="0.7" stroke="currentColor" strokeWidth="1.1" />
      <path d="M1 9h10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="3" cy="3" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="3" cy="9" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="4.5" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 4.2v3.6M3 5.5C5 5.5 7.6 5.5 7.6 4.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function SuggestionGlyph({ kind }: { kind: SuggestionGlyphKind }) {
  switch (kind) {
    case "wrench":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M11 2.5a3 3 0 1 0 2.5 4.5L9.5 11l-3-3 4-4-1-1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M9.5 11l-5 5-2-2 5-5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "bug":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="4" width="6" height="8" rx="3" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2 6h2M2 10h2M12 6h2M12 10h2M5.5 4.5l-1-1.5M10.5 4.5l1-1.5M5.5 12l-1 1.5M10.5 12l1 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "package":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 4.5l5.5-2.5 5.5 2.5v7l-5.5 2.5L2.5 11.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M2.5 4.5L8 7l5.5-2.5M8 7v7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "check":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "note":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 2.5h7L13 5.5V13a1 1 0 0 1-1 1H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M5 7h6M5 9.5h6M5 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
  }
}

function ResumeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8a5 5 0 1 1 1.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M2 6.5l1 2 2-1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatAge(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(secs);
}
