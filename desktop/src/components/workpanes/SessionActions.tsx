// SessionActions — the "do something with this session" controls, mounted in
// the session detail's header action slot. Both wired to real plumbing:
//
//   • Resume — continue the exact conversation as a live agent
//     (`claude --resume <id>` via agent_pty_open) and dismiss the overlay so
//     the user lands in the running agent. The read-only replay lives in the
//     Transcript tab; this is the "now keep going" half. A native Aura chat
//     carries on through the manager store instead ("Continue chat").
//   • Rewind — revert ONE thing: a single changed function (surgical,
//     AST-level) or a single file, from a menu of exactly what this session
//     touched. The blunt "restore everything" sits last, behind a confirm.
//
// Resume only shows when we correlated a session id; Rewind only when the
// run has a changeset to revert from.

import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import { api, type ChangedSymbol, type ClaudeSession, type IntentChangesetFile } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { planLaunchesAgent, resumePlan } from "../../lib/resumePlan";
import { startResume } from "../../lib/resumeLaunch";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { goToTrace } from "../trace/traceRoute";
import { ResumeConfirm } from "./sessionActions/ResumeConfirm";
import { RewindMenu } from "./sessionActions/RewindMenu";
import {
  readResumeSkip,
  rewindTargets,
  sessionCommit,
  writeResumeSkip,
} from "./sessionActions/sessionActionsModel";
import "../ui/session-actions.css";

export function SessionActions({
  repoRoot,
  sess,
  managerSessionId,
  managerLabel,
  files,
  symbolsByFile,
  agentId,
  worktree,
  onDismiss,
}: {
  repoRoot: string;
  /** Correlated Claude session — drives "Resume". Null → no resume. */
  sess: ClaudeSession | null;
  /** Native Aura chat (manager) session id — set only when this row is a
   *  native chat, not a Claude run. Drives "Continue chat": these resume
   *  through the manager store (`openManager`), not `claude --resume`, so
   *  without this branch a native chat opened in Trace had no way to carry on. */
  managerSessionId?: string | null;
  /** Plain title for the chat tab when it re-homes (the session objective). */
  managerLabel?: string;
  /** Which agent did this work, from the record — so a run by an agent Aura
   *  cannot reopen says so by name instead of showing no button and no reason. */
  agentId?: string | null;
  /** The folder the record says the work happened in. Used only to name the
   *  folder that has since gone missing; never resolved as a path. */
  worktree?: string | null;
  /** This run's changed files — drives "Rewind". */
  files: IntentChangesetFile[];
  /** Changed symbols grouped by file (from the change-note), for per-function
   *  rewind. A file missing here is offered as a whole-file rewind. */
  symbolsByFile: Record<string, ChangedSymbol[]>;
  /** Close the detail overlay so the user lands on the resumed agent /
   *  the rewind tool we just opened. */
  onDismiss: () => void;
}) {
  const store = useEditorStore();
  const [busy, setBusy] = useState<null | "resume" | "checkout">(null);
  const [error, setError] = useState<string | null>(null);
  /** The underlying failure, kept for the hover title so the plain sentence
   *  doesn't have to carry a stack trace. */
  const [errorDetail, setErrorDetail] = useState("");
  const [confirmResume, setConfirmResume] = useState(false);
  const [dontAskResume, setDontAskResume] = useState(false);
  const [skipResumeConfirm, setSkipResumeConfirm] = useState(readResumeSkip);

  const mgrId = (managerSessionId ?? "").trim() || null;
  // Where this would land and whether it is a continuation at all, worked out
  // once, in the words the confirm prints. A native Aura chat carries on
  // through the manager store, never a Claude resume, so the two paths stay
  // mutually exclusive by construction.
  const plan = useMemo(
    () => resumePlan({ repoRoot, session: sess, managerSessionId: mgrId, agentId, worktree }),
    [repoRoot, sess, mgrId, agentId, worktree],
  );
  const canResume = planLaunchesAgent(plan);
  const canContinueChat = plan.kind === "chat";
  const commit = sessionCommit(files);
  const canRewind = files.length > 0;
  const targets = useMemo(
    () => rewindTargets(repoRoot, files, symbolsByFile),
    [repoRoot, files, symbolsByFile],
  );

  function confirmResumeNow() {
    if (dontAskResume) {
      writeResumeSkip(true);
      setSkipResumeConfirm(true);
    }
    setConfirmResume(false);
    void resume();
  }

  async function resume() {
    if (!canResume || busy) return;
    setBusy("resume");
    setError(null);
    setErrorDetail("");
    // Spawns an interactive Claude REPL, resumed onto this conversation when
    // the plan says it can be, brand new when it can't. The launch is claimed
    // across the spawn, so a second press — or the launcher opening the same
    // conversation at the same moment — waits instead of starting a twin.
    const started = await startResume({ repoRoot, cwd: plan.cwd, sessionId: plan.sessionId });
    if (!started.ok) {
      // Nothing opened. Say that, rather than leaving "Starting…" as the last
      // word on the subject.
      setError(started.message);
      setErrorDetail(started.detail);
      setBusy(null);
      return;
    }
    store.openAgent({
      sessionId: started.handleId,
      agentId: "claude",
      agentLabel: "Claude",
      agentMonogram: "C",
      repoRoot: plan.cwd,
      mode: "pty",
      resumeSessionId: plan.sessionId ?? undefined,
    });
    store.setActiveAgent(started.handleId);
    // The detail is a fullscreen overlay; closing it reveals the build
    // surface, which now auto-follows the freshly-active agent tab.
    onDismiss();
  }

  /** Re-home a native Aura chat into a live chat tab (the same `openManager`
   *  path the Sessions list and the `/resume` card use). No token-spend
   *  confirm — it's reopening an existing thread. */
  function continueChat() {
    if (!mgrId) return;
    store.openManager(mgrId, (managerLabel ?? "").trim() || "Aura");
    onDismiss();
  }

  /** Route to the visual Rewind tool, scoped to one symbol or one whole file.
   *  Non-destructive: the tool previews and confirms before it runs. */
  function rewind(identifier: string | null, abs: string) {
    goToTrace({
      kind: "tool",
      tool: "rewind",
      arg: identifier ? { identifier, file: abs } : { file: abs },
    });
    onDismiss();
  }

  async function restoreAll(): Promise<boolean> {
    if (!commit || busy) return false;
    setBusy("checkout");
    setError(null);
    setErrorDetail("");
    try {
      await api.gitCheckout(repoRoot, commit);
      onDismiss();
      return true;
    } catch (e) {
      setError("Couldn’t restore the repository.");
      setErrorDetail(e instanceof Error ? e.message : String(e));
      setBusy(null);
      return false;
    }
  }

  const unsupportedNote = plan.kind === "none" && !!plan.warning;
  if (!canResume && !canContinueChat && !canRewind && !unsupportedNote) return null;

  return (
    <div className="ui-session-actions">
      {error && (
        <span className="ui-session-actions-note" data-tone="error" title={errorDetail || error}>
          {error}
        </span>
      )}

      {/* Nothing to resume, and a reason worth saying: a run by an agent whose
          history lives in its own store. Silence reads as a missing button
          rather than an unsupported one. */}
      {unsupportedNote && (
        <span className="ui-session-actions-note" title={plan.warning}>
          {plan.warning}
        </span>
      )}

      {canContinueChat && (
        <Button size="sm" variant="secondary" onClick={continueChat} title={plan.headline}>
          <Play />
          Continue chat
        </Button>
      )}

      {canResume && (
        <Popover
          open={confirmResume}
          onOpenChange={(o) => {
            // Single entry point for the trigger (Radix composes the click
            // into onOpenChange, so a separate onClick would double-fire and
            // open two agents). A remembered "don't ask" resumes straight
            // away, never flashing the confirm.
            if (busy) return;
            if (o && skipResumeConfirm) {
              void resume();
              return;
            }
            setConfirmResume(o);
          }}
        >
          <PopoverTrigger asChild>
            <Button size="sm" variant="secondary" disabled={busy !== null} title={plan.headline}>
              <Play />
              {busy === "resume" ? "Starting…" : plan.verb}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="ui-resume-popover">
            <ResumeConfirm
              plan={plan}
              sess={sess}
              dontAsk={dontAskResume}
              onDontAsk={setDontAskResume}
              onCancel={() => setConfirmResume(false)}
              onConfirm={confirmResumeNow}
            />
          </PopoverContent>
        </Popover>
      )}

      {canRewind && (
        <RewindMenu
          targets={targets}
          commit={commit}
          restoring={busy === "checkout"}
          onRewind={rewind}
          onRestoreAll={restoreAll}
        />
      )}
    </div>
  );
}
