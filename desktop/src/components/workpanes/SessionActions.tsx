// SessionActions — the "do something with this session" controls, mounted in
// the session detail's wizard header action slot (FullscreenOverlay `actions`).
// Two affordances, both wired to real, proven plumbing:
//
//   • Resume — continue the exact Claude conversation as a live REPL
//     (`claude --resume <id>` via agent_pty_open) and dismiss the overlay so
//     the user lands in the running agent. The read-only replay lives in the
//     Transcript tab; this is the "now keep going" half.
//   • Rewind — Aura's whole point versus Claude Code's /rewind. Claude restores
//     EVERYTHING to a point (risky — unrelated work goes too). Aura reverts ONE
//     thing: pick a single changed function (surgical, AST-level, zero merge
//     conflicts) or a single file. The menu lists exactly what this session
//     touched. A clearly-secondary "restore everything" escape hatch (full
//     checkout, HEAD-detach) sits at the bottom for the rare all-or-nothing
//     case the user explicitly opts into.
//
// Resume only shows when we actually correlated a Claude session id; Rewind
// only shows when the run has a changeset to revert from.

import { useMemo, useState } from "react";
import {
  api,
  type ChangedSymbol,
  type ClaudeSession,
  type IntentChangesetFile,
} from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";

// Resume spawns a *live* billed agent, so the first time round we explain
// what it does and confirm before launching — "don't just do it". A user who
// resumes constantly can opt out; the choice persists here so we honor the
// "ask at least once" intent without nagging forever.
const RESUME_SKIP_KEY = "aura.session.resumeConfirm.skip";
function readResumeSkip(): boolean {
  try {
    return localStorage.getItem(RESUME_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}
function writeResumeSkip(skip: boolean) {
  try {
    if (skip) localStorage.setItem(RESUME_SKIP_KEY, "1");
    else localStorage.removeItem(RESUME_SKIP_KEY);
  } catch {
    /* storage disabled (private mode) — the confirm just always shows. */
  }
}

/** The commit this session lands on — the sha stamped on its changed files.
 *  A logged run is normally one commit, so the first stamped sha is exact;
 *  a multi-commit backfill picks its first (any is "this point"). null when
 *  nothing is committed yet (a live working-tree claim). */
function sessionCommit(files: IntentChangesetFile[]): string | null {
  for (const f of files) {
    if (f.commit) return f.commit;
  }
  return null;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Absolute path for a repo-relative changeset path. The Time machine's
 *  snapshot matcher keys on the absolute file, mirroring the symbol
 *  right-click menu's contract. */
function toAbs(repoRoot: string, relPath: string): string {
  const root = repoRoot.replace(/\/$/, "");
  return relPath.startsWith("/") ? relPath : `${root}/${relPath}`;
}

/** Symbols for a changeset file: exact path key first, then a basename match
 *  (the change-note report path and the changeset path can differ by prefix).
 *  Empty → the file is offered as a whole-file rewind. */
function symbolsFor(
  byFile: Record<string, ChangedSymbol[]>,
  path: string,
): ChangedSymbol[] {
  const exact = byFile[path];
  if (exact && exact.length) return exact;
  const base = basename(path);
  for (const k of Object.keys(byFile)) {
    if (basename(k) === base && byFile[k].length) return byFile[k];
  }
  return [];
}

type RewindTarget = {
  /** Repo-relative path (for the label). */
  path: string;
  /** Absolute path (for the rewind tool). */
  abs: string;
  symbols: ChangedSymbol[];
};

function ResumeGlyph() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden width="13" height="13">
      <path
        d="M4 3.2v7.6l6-3.8z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RewindGlyph() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden width="13" height="13">
      <path
        d="M3 7a4 4 0 1 1 1.2 2.85M3 7V4.3M3 7h2.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Tiny added/modified/deleted tag for a symbol row. */
function ChangeTag({ change }: { change: string }) {
  const tone =
    change === "added"
      ? "text-accent-green"
      : change === "deleted"
        ? "text-red"
        : "text-text-4";
  const label =
    change === "added" ? "added" : change === "deleted" ? "removed" : "changed";
  return (
    <span className={`ml-auto shrink-0 text-[9.5px] uppercase tracking-wide ${tone}`}>
      {label}
    </span>
  );
}

function RewindRow({
  onClick,
  children,
  indent,
}: {
  onClick: () => void;
  children: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[12px] text-text-2 transition-colors hover:bg-bg-2 hover:text-text-1 ${
        indent ? "pl-5" : "pl-2.5"
      }`}
    >
      {children}
    </button>
  );
}

export function SessionActions({
  repoRoot,
  sess,
  managerSessionId,
  managerLabel,
  files,
  symbolsByFile,
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
  const [confirmCheckout, setConfirmCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resume explain-and-confirm popover.
  const [confirmResume, setConfirmResume] = useState(false);
  const [dontAskResume, setDontAskResume] = useState(false);
  const [skipResumeConfirm, setSkipResumeConfirm] = useState(readResumeSkip);

  const mgrId = (managerSessionId ?? "").trim() || null;
  // A native Aura chat carries on through the manager store, never a Claude
  // resume — so the two paths are mutually exclusive by construction.
  const canResume = !mgrId && !!sess?.session_id;
  const canContinueChat = !!mgrId;
  const commit = sessionCommit(files);
  const shortSha = commit ? commit.slice(0, 7) : null;
  const canRewind = files.length > 0;

  // Claude resolves `--resume <id>` by the cwd it was launched from, so we
  // spawn from the session's own cwd — which may be a sibling worktree on a
  // different branch than the workspace the user is currently looking at.
  // That divergence is the load-bearing thing to confirm before launching.
  const spawnRoot =
    sess?.cwd && sess.cwd.length > 0 ? sess.cwd : repoRoot;
  const divergentRoot =
    spawnRoot.replace(/\/$/, "") !== repoRoot.replace(/\/$/, "");

  const targets = useMemo<RewindTarget[]>(
    () =>
      files.map((f) => ({
        path: f.path,
        abs: toAbs(repoRoot, f.path),
        symbols: symbolsFor(symbolsByFile, f.path),
      })),
    [files, symbolsByFile, repoRoot],
  );
  const fnCount = useMemo(
    () => targets.reduce((n, t) => n + t.symbols.length, 0),
    [targets],
  );

  // Confirmed from the popover — honor "don't ask again" then launch.
  function confirmResumeNow() {
    if (dontAskResume) {
      writeResumeSkip(true);
      setSkipResumeConfirm(true);
    }
    setConfirmResume(false);
    void resume();
  }

  async function resume() {
    if (!sess?.session_id || busy) return;
    setBusy("resume");
    setError(null);
    try {
      // Spawn an interactive Claude REPL resumed onto this session. forceNew
      // so it's a fresh second tab, not a reattach to some live (claude,root).
      const handle = await api.agentPtyOpen(
        "claude",
        spawnRoot,
        80,
        24,
        sess.session_id,
        true,
      );
      store.openAgent({
        sessionId: handle.id,
        agentId: "claude",
        agentLabel: "Claude",
        agentMonogram: "C",
        repoRoot: spawnRoot,
        mode: "pty",
      });
      store.setActiveAgent(handle.id);
      // The detail is a fullscreen overlay; closing it reveals the build
      // surface, which now auto-follows the freshly-active agent tab.
      onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  /** Continue a native Aura chat where it left off: re-home its session into a
   *  live chat tab (the same `openManager` path the Sessions list and the
   *  `/resume` card use) and close this overlay so the user lands on it. No
   *  Claude resume, no token-spend confirm — it's reopening an existing thread. */
  function continueChat() {
    if (!mgrId) return;
    store.openManager(mgrId, (managerLabel ?? "").trim() || "Aura");
    onDismiss();
  }

  /** Route to the visual Rewind tool, scoped to one symbol (surgical) or one
   *  whole file. Non-destructive: the tool previews + confirms before it runs. */
  function rewind(identifier: string | null, abs: string) {
    store.openTraceTool(
      "rewind",
      identifier ? { identifier, file: abs } : { file: abs },
    );
    onDismiss();
  }

  async function checkout() {
    if (!commit || busy) return;
    setBusy("checkout");
    setError(null);
    try {
      await api.gitCheckout(repoRoot, commit);
      onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirmCheckout(false);
    }
  }

  if (!canResume && !canContinueChat && !canRewind) return null;

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span
          className="max-w-[180px] truncate text-[11px] text-red"
          title={error}
        >
          {error}
        </span>
      ) : null}

      {canContinueChat ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={continueChat}
          title="Reopen this Aura chat and keep going where it left off"
        >
          <ResumeGlyph />
          Continue chat
        </Button>
      ) : null}

      {canResume ? (
        <Popover
          open={confirmResume}
          onOpenChange={(o) => {
            // Single entry point for the trigger (Radix composes the click
            // into onOpenChange, so a separate onClick would double-fire and
            // open two agents). Honor a remembered "don't ask" choice: resume
            // straight away, never flashing the confirm. Esc / outside-click
            // closes.
            if (busy) return;
            if (o && skipResumeConfirm) {
              void resume();
              return;
            }
            setConfirmResume(o);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              title="Resume this Claude conversation as a live terminal session"
            >
              <ResumeGlyph />
              {busy === "resume" ? "Resuming…" : "Resume"}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="w-[340px] border-line bg-bg-content p-0 text-text-1 shadow-[var(--shadow-modal)]"
          >
            <div className="border-b border-line-soft px-3.5 pb-2.5 pt-3">
              <div className="text-[12px] font-medium text-text-1">
                Resume this conversation
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-text-4">
                Aura launches a{" "}
                <span className="text-text-2">live Claude session</span> that
                picks up this exact conversation where it left off — a real
                running agent that uses tokens. It opens as a new terminal tab
                and you&apos;ll land on it.
              </p>
            </div>

            <div className="px-3.5 py-2.5 text-[11px] leading-relaxed">
              {/* Which run — so the user confirms it's the one they meant. */}
              <div className="flex items-center gap-1.5 text-text-4">
                <span className="tabular-nums text-text-3">
                  {sess?.turn_count ?? 0} turn
                  {sess?.turn_count === 1 ? "" : "s"}
                </span>
                {sess?.session_id ? (
                  <>
                    <span className="text-text-5">·</span>
                    <span className="font-mono text-text-5">
                      {sess.session_id.slice(0, 8)}
                    </span>
                  </>
                ) : null}
              </div>

              {/* Where it runs — the load-bearing confirmation. */}
              <div className="mt-2 flex items-center gap-1.5">
                <span className="shrink-0 text-text-5">runs in</span>
                <span
                  className="truncate font-mono text-text-3"
                  title={spawnRoot}
                >
                  {basename(spawnRoot)}
                </span>
              </div>
              {divergentRoot ? (
                <p className="mt-1.5 rounded-[var(--radius-sm)] border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-amber-300">
                  This conversation ran in a different workspace than the one
                  you&apos;re in now — resuming launches Claude there, not here.
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2 border-t border-line-soft px-3.5 py-2.5">
              <label className="mr-auto flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-text-4">
                <Checkbox
                  checked={dontAskResume}
                  onCheckedChange={(v) => setDontAskResume(v === true)}
                />
                Don&apos;t ask again
              </label>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirmResume(false)}
              >
                Cancel
              </Button>
              <Button size="xs" variant="secondary" onClick={confirmResumeNow}>
                Resume
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {canRewind ? (
        <Popover onOpenChange={(o) => !o && setConfirmCheckout(false)}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="subtle"
              title="Revert a single function or file to its last safe version"
            >
              <RewindGlyph />
              Rewind
              <Chevron />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="w-[340px] border-line bg-bg-content p-0 text-text-1 shadow-[var(--shadow-modal)]"
          >
            <div className="border-b border-line-soft px-3.5 pb-2.5 pt-3">
              <div className="text-[12px] font-medium text-text-1">
                Rewind one piece
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-text-4">
                Revert a single function or file to its last safe version —
                everything else this session changed stays exactly as it is.
                Aura snapshots first, so it&apos;s itself undoable.
              </p>
            </div>

            <div className="max-h-[300px] overflow-y-auto px-1.5 py-1.5">
              {targets.map((t) => (
                <div key={t.path} className="mb-1 last:mb-0">
                  {/* File row — whole-file rewind, and the group header for its
                      functions. */}
                  <RewindRow onClick={() => rewind(null, t.abs)}>
                    <span
                      className="truncate font-mono text-[11px] text-text-3"
                      title={t.path}
                    >
                      {t.path}
                    </span>
                    {t.symbols.length === 0 ? (
                      <span className="ml-auto shrink-0 text-[9.5px] uppercase tracking-wide text-text-5">
                        whole file
                      </span>
                    ) : null}
                  </RewindRow>
                  {t.symbols.map((s) => (
                    <RewindRow
                      key={`${t.path}::${s.identifier}`}
                      indent
                      onClick={() => rewind(s.identifier, t.abs)}
                    >
                      <RewindGlyph />
                      <span className="truncate font-mono text-[12px] text-text-1">
                        {s.identifier}
                      </span>
                      <ChangeTag change={s.change} />
                    </RewindRow>
                  ))}
                </div>
              ))}
              {fnCount === 0 ? (
                <p className="px-2.5 py-1 text-[10.5px] leading-relaxed text-text-5">
                  No resolved function map for this run — rewind by file above,
                  then pick the symbol in the next step.
                </p>
              ) : null}
            </div>

            {/* Secondary escape hatch — the blunt, all-or-nothing restore. */}
            {commit ? (
              <div className="border-t border-line-soft px-3 py-2.5">
                {confirmCheckout ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] leading-relaxed text-text-3">
                      Move your whole project back to{" "}
                      <span className="font-mono text-text-2">{shortSha}</span>?
                      This also undoes unrelated work and leaves you off any branch.
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={checkout}
                        disabled={busy === "checkout"}
                      >
                        {busy === "checkout" ? "Restoring…" : "Restore everything"}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setConfirmCheckout(false)}
                        disabled={busy === "checkout"}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmCheckout(true)}
                    className="flex w-full items-center gap-1.5 text-left text-[11px] text-text-4 transition-colors hover:text-text-2"
                  >
                    <span>Restore everything to this point</span>
                    <span className="ml-auto shrink-0 text-[9.5px] uppercase tracking-wide text-amber">
                      risky
                    </span>
                  </button>
                )}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden width="10" height="10">
      <path
        d="M3 4.5 6 7.5l3-3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
