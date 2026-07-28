// The "Checks" tab — Checks and PRs are ONE surface, split by height.
//
//   TOP    a readable PR document: the title, the description rendered as
//          real markdown (Conductor's Description view), then a QUIET strip of
//          git-status + Aura semantic checks. An open space to READ, not a
//          form to fill — no uppercase group chrome, no shouting action links.
//   BOTTOM the full pull-request list (the same PrRailPanel that used to be
//          its own tab), so "Checks" and "PRs" live in one place.
//
// The split between the two is draggable (useVerticalSplit) and the ratio is
// remembered. Every actionable row hands its work to the ambient Aura chat
// rather than running git silently or popping a separate trace tab — the review,
// the prove, the attestations and the git moves all surface as agent tool calls
// you can watch, keeping the whole flow inside the Aura conversation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type AheadBehind,
  type PrComment,
  type PrDetail,
  type PrSummary,
} from "../../lib/api";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  subscribePrList,
} from "../../lib/prsCache";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { useVerticalSplit } from "../../lib/useVerticalSplit";
import { useEditorStore } from "../../lib/editorStore";
import { sendToAmbientManager } from "../../lib/focusManager";
import {
  safetyCheckPrompt,
  proveGoalsPrompt,
  attestPrompt,
  resolveConflictsPrompt,
} from "../../lib/worktreeActions";
import { MarkdownInline } from "../MarkdownView";
import { PrRailPanel } from "./PrRailPanel";
import { AsciiSpinner } from "../ui/ascii-spinner";

const POLL_MS = 6000;

type Props = {
  repoRoot: string;
  /** Live merge-conflict count (App scans sentinel + git markers). */
  conflictsCount: number;
  /** Kept for the caller's contract; the "Commit and push" row now hands the
   *  work to the Aura chat rather than jumping the rail, so it's unused. */
  onGoToChanges?: () => void;
};

export function ChecksPanel({ repoRoot, conflictsCount }: Props) {
  const editor = useEditorStore();
  const [ab, setAb] = useState<AheadBehind>({
    ahead: 0,
    behind: 0,
    has_upstream: false,
    branch: null,
  });
  const [changedCount, setChangedCount] = useState(0);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [updateSent, setUpdateSent] = useState(false);
  // Flash for the no-PR "Draft it with Aura" action (mirrors updateSent).
  const [draftSent, setDraftSent] = useState(false);
  // The row whose work is ACTUALLY running in the ambient chat right now, so it
  // shows a live amber spinner until the brain settles — not just a 2s "Asked ✓"
  // flash that vanishes while the review is still churning. `sid` is "" until
  // sendToAmbientManager resolves the session id that drives the poll.
  const [runningAction, setRunningAction] = useState<{
    id: string;
    sid: string;
  } | null>(null);
  // Brief "Done ✓" flash on the row after its run settles, keyed by row id.
  const [doneAction, setDoneAction] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Locally-dismissed review comments (the per-comment "Hide" action). Keyed by
  // comment id; resets when the PR changes.
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  // Inline editing of the PR document (title / description) — borderless, saves
  // on blur, no boxed editor chrome.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // Collapse the whole bottom PR list; the top document reclaims the height.
  const [prCollapsed, setPrCollapsed] = useState(() => {
    try {
      return localStorage.getItem("aura.checks.prCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const togglePrCollapsed = useCallback(() => {
    setPrCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("aura.checks.prCollapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const visible = useDocumentVisibility();

  // Draggable height split between the PR document (top) and the PR list.
  const { ratio, containerRef, onPointerDown } = useVerticalSplit(
    "aura.checks.split",
    0.5,
  );

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function poll() {
      try {
        // Real git status — ahead/behind AND the uncommitted working-tree
        // count (vs HEAD), so "N uncommitted changes" reflects reality, not
        // just the Aura checks.
        const [a, d] = await Promise.all([
          api.gitAheadBehind(repoRoot),
          api.gitDiffStats(repoRoot).catch(() => null),
        ]);
        if (cancelled) return;
        setAb(a);
        if (d) setChangedCount(d.changed_files);
      } catch {
        /* transient */
      }
    }
    void poll();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible, tick]);

  useEffect(() => {
    let alive = true;
    void fetchPrList(repoRoot)
      .then((list) => alive && setPrs(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, tick]);
  useEffect(() => subscribePrList(repoRoot, setPrs), [repoRoot]);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("aura:git-changed", bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("aura:git-changed", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const branch = ab.branch;
  const pr = useMemo(
    () => (branch ? (prs.find((p) => p.head_ref === branch) ?? null) : null),
    [prs, branch],
  );
  const prState = pr?.state.toLowerCase() ?? null;

  // Load the PR body prose once per PR (for the description document).
  useEffect(() => {
    if (!pr) {
      setDetail(null);
      return;
    }
    let alive = true;
    void api
      .prDetail(repoRoot, pr.number)
      .then((d) => alive && setDetail(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, pr?.number, tick]);

  // Real PR discussion — the comments people left on THIS pull request.
  useEffect(() => {
    if (!pr) {
      setComments([]);
      return;
    }
    setHidden(new Set());
    let alive = true;
    void api
      .prCommentsList(repoRoot, pr.number)
      .then((c) => alive && setComments(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, pr?.number, tick]);

  // Only the comments that carry prose (a bare approval review has an empty
  // body) and aren't locally hidden — those are what's worth reading / handing
  // to Aura.
  const discussion = useMemo(
    () => comments.filter((c) => c.body.trim().length > 0 && !hidden.has(c.id)),
    [comments, hidden],
  );

  // Send a message into the project's ambient Aura chat and drive a live
  // spinner on the row that fired it. The spinner shows immediately on click,
  // then the returned session id feeds the poll below that clears it when the
  // brain actually finishes — so the row reflects real progress, not a fixed
  // 2-second flash that lied about work still in flight.
  const askAura = useCallback(
    (id: string, text: string) => {
      setDoneAction((cur) => (cur === id ? null : cur));
      // Spinner on now; the sid arrives a beat later once the session exists.
      setRunningAction({ id, sid: "" });
      void sendToAmbientManager(repoRoot, text)
        .then((sid) => {
          setRunningAction((cur) => (cur && cur.id === id ? { id, sid } : cur));
        })
        .catch(() => {
          // Session never started — drop the spinner rather than spin forever.
          setRunningAction((cur) => (cur && cur.id === id ? null : cur));
        });
    },
    [repoRoot],
  );

  // While a row's work runs, poll the ambient session until the brain leaves
  // "running" (or the session vanishes / a safety timeout trips), then flash a
  // brief "Done ✓". A short grace before the first observed "running" avoids
  // clearing the spinner before the CLI brain has spun up.
  useEffect(() => {
    const active = runningAction;
    if (!active || !active.sid) return;
    const { id, sid } = active;
    let alive = true;
    let sawRunning = false;
    const startedAt = Date.now();
    const settle = () => {
      if (!alive) return;
      setRunningAction((cur) => (cur && cur.id === id ? null : cur));
      setDoneAction(id);
      window.setTimeout(
        () => setDoneAction((cur) => (cur === id ? null : cur)),
        2500,
      );
    };
    const timer = window.setInterval(() => {
      void api
        .managerStatus(sid)
        .then((s) => {
          if (!alive) return;
          // Match ManagerSurface's live signal: the session is working when its
          // status is "running" OR any of its tasks are still running.
          const busy =
            s.status === "running" ||
            s.tasks.some((t) => t.status === "running");
          if (busy) sawRunning = true;
          const terminal =
            (s.status === "completed" || s.status === "cancelled") && !busy;
          const elapsed = Date.now() - startedAt;
          const settled =
            terminal ||
            elapsed > 180_000 ||
            (!busy && (sawRunning || elapsed > 6_000));
          if (settled) {
            window.clearInterval(timer);
            settle();
          }
        })
        .catch(() => {
          // Session gone — treat as settled so the spinner never hangs.
          if (!alive) return;
          window.clearInterval(timer);
          settle();
        });
    }, 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [runningAction]);

  // The right-hand action label for a row: its default verb, or a brief
  // "Done ✓" right after its run settles. The live "Working…" state is rendered
  // by <Row running> and takes over the whole action slot while it runs.
  const actionText = useCallback(
    (id: string, label: string) => (doneAction === id ? "Done ✓" : label),
    [doneAction],
  );

  // Hand the whole review thread to the ambient Aura session so it can read
  // every comment and address each one — the same "add all to chat" affordance
  // Conductor offers, wired to the agent that owns this repo.
  const addAllToChat = useCallback(() => {
    if (!pr || discussion.length === 0) return;
    const lines = discussion.map((c) => {
      const where = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
      return `- @${c.author}${where}: ${c.body.trim()}`;
    });
    const text =
      `Review comments on PR #${pr.number} "${pr.title}". Please read them and ` +
      `address each one:\n\n${lines.join("\n")}`;
    void sendToAmbientManager(repoRoot, text);
  }, [pr, discussion, repoRoot]);

  // Hand a single review comment to the chat.
  const addOneToChat = useCallback(
    (c: PrComment) => {
      if (!pr) return;
      const where = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
      const text =
        `Address this review comment on PR #${pr.number}${where} from ` +
        `@${c.author}:\n\n${c.body.trim()}`;
      void sendToAmbientManager(repoRoot, text);
    },
    [pr, repoRoot],
  );

  // Persist an edited field to the PR (gh pr edit). Title and body save
  // independently — the other stays null (unchanged). Refreshes the detail
  // (tick) and the list (title shows there too).
  const saveField = useCallback(
    async (patch: { title?: string; body?: string }) => {
      if (!pr) return;
      try {
        await api.prUpdate(
          repoRoot,
          pr.number,
          patch.title ?? null,
          patch.body ?? null,
        );
        setTick((t) => t + 1);
        await invalidatePrList(repoRoot).catch(() => {});
      } catch (e) {
        console.error("[checks] prUpdate failed:", e);
      }
    },
    [pr, repoRoot],
  );

  const commitTitle = useCallback(() => {
    const t = titleDraft.trim();
    setEditingTitle(false);
    if (!pr || !t || t === pr.title) return;
    void saveField({ title: t });
  }, [titleDraft, pr, saveField]);

  const commitBody = useCallback(() => {
    setEditingBody(false);
    const original = detail?.body.trim() ?? "";
    if (!pr || bodyDraft.trim() === original) return;
    void saveField({ body: bodyDraft });
  }, [bodyDraft, detail, pr, saveField]);

  // Aura keeps the PR properly written as work lands: we already track the
  // intent log, the commits, and the diff — so ask the agent to reconcile the
  // title + description with what actually shipped and update the PR.
  const updateWithAura = useCallback(() => {
    if (!pr) return;
    const text =
      `Review everything that changed on branch "${pr.head_ref}" for PR #${pr.number} — ` +
      `the intent log, the commits, and the diff — then rewrite the PR title and ` +
      `description so they accurately describe what actually shipped and why, and ` +
      `update the pull request.`;
    void sendToAmbientManager(repoRoot, text);
    setUpdateSent(true);
    window.setTimeout(() => setUpdateSent(false), 2200);
  }, [pr, repoRoot]);

  // No PR yet: hand the whole "open a pull request" job to the ambient Aura
  // chat. The auto-written description only appears once a PR exists (it's the
  // top document above), so without this affordance the panel just reads "no PR"
  // and the writing never kicks in — which is exactly the "it shows nothing"
  // gap. This tells the agent to get the branch ready (commit + push if needed)
  // and open the PR with an accurate, auto-written title + description.
  const draftWithAura = useCallback(() => {
    const text =
      `Open a pull request for the "${branch ?? "current"}" branch. First make ` +
      `sure everything is committed and the branch is pushed to the remote, then ` +
      `create the PR — read the intent log, the commits, and the diff and write a ` +
      `clear, accurate title and description that explain what changed and why. If ` +
      `a pull request already exists for this branch, update it instead of opening ` +
      `a new one.`;
    void sendToAmbientManager(repoRoot, text);
    setDraftSent(true);
    window.setTimeout(() => setDraftSent(false), 2200);
  }, [branch, repoRoot]);

  const approved = pr?.review_decision === "APPROVED";
  const inSync = ab.has_upstream && ab.ahead === 0 && ab.behind === 0;
  const body = pr && detail ? detail.body.trim() : "";

  // Grow the borderless body editor to fit its content as you type.
  const autosize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  return (
    <div ref={containerRef} className="h-full flex flex-col overflow-hidden">
      {/* ── TOP: the PR document — a space to read ──────────────────────── */}
      {/* `overflow-x-hidden` is load-bearing: `overflow-y-auto` alone makes the
          browser compute `overflow-x` to `auto`, so one markdown child a hair
          too wide (a long token, an autolinked URL) gives this pane a sideways
          scrollbar — and it lands scrolled right, clipping the PR title's left
          edge. Pinning x-hidden forces that content to wrap in-column instead. */}
      <div
        className="min-h-0 overflow-y-auto overflow-x-hidden"
        style={{ flexGrow: ratio, flexBasis: 0 }}
      >
        <div className="px-4 pt-3.5 pb-3">
          {pr ? (
            editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setTitleDraft(pr.title);
                    e.currentTarget.blur();
                  }
                }}
                onBlur={commitTitle}
                className="w-full bg-transparent px-1 -mx-1 py-0.5 text-[14px] font-semibold text-text-1 leading-snug outline-none border-b border-accent/50"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(pr.title);
                  setEditingTitle(true);
                }}
                title="Click to edit the PR title"
                className="w-full text-left text-[14px] font-semibold text-text-1 leading-snug rounded px-1 -mx-1 hover:bg-bg-2/40 transition-colors"
              >
                {pr.title}
              </button>
            )
          ) : (
            <div className="text-[14px] font-semibold text-text-1 leading-snug">
              {branch ? `Branch ${branch}` : "No branch"}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-4 min-w-0">
            {pr ? (
              <>
                <span className="tabular-nums shrink-0">#{pr.number}</span>
                <span className="font-mono truncate">{pr.head_ref}</span>
                <div className="ml-auto shrink-0 flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      editor.openPrDetail(repoRoot, pr.number, pr.title)
                    }
                    title="Open this pull request as a full tab"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-text-3 hover:text-text-1 transition-colors"
                  >
                    <OpenTabGlyph />
                    <span>Open as tab</span>
                  </button>
                  <button
                    type="button"
                    onClick={updateWithAura}
                    title="Ask Aura to reconcile the PR title + description with what actually shipped"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-text-3 hover:text-text-1 transition-colors"
                  >
                    {updateSent ? "Sent to Aura ✓" : "Update with Aura"}
                  </button>
                </div>
              </>
            ) : (
              branch && <span className="font-mono truncate">{branch}</span>
            )}
          </div>

          {pr ? (
            editingBody ? (
              <textarea
                ref={bodyRef}
                autoFocus
                value={bodyDraft}
                onChange={(e) => {
                  setBodyDraft(e.target.value);
                  autosize(e.currentTarget);
                }}
                onFocus={(e) => autosize(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingBody(false);
                  }
                }}
                onBlur={commitBody}
                placeholder="Add a description…"
                className="mt-3 w-full bg-transparent outline-none resize-none text-[12.5px] text-text-2 leading-relaxed placeholder:text-text-5"
                style={{ minHeight: "4.5em" }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setBodyDraft(body);
                  setEditingBody(true);
                }}
                title="Click to edit the description"
                className="group/desc block w-full text-left mt-3 rounded px-1 -mx-1 hover:bg-bg-2/40 transition-colors"
              >
                {body ? (
                  <MarkdownInline source={body} className="text-text-2" />
                ) : (
                  <span className="text-[12px] text-text-4">
                    Add a description…
                  </span>
                )}
              </button>
            )
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-[12px] text-text-4 leading-relaxed">
                No pull request for this branch yet — so there's nothing to
                describe here. Once a PR is open, Aura keeps its title and
                description written for you as work lands.
              </p>
              <button
                type="button"
                onClick={draftWithAura}
                title="Ask Aura to commit and push if needed, open the pull request, and write its description from what actually changed"
                className="self-start inline-flex items-center gap-1.5 text-[11px] font-medium text-text-3 hover:text-text-1 transition-colors"
              >
                {draftSent ? (
                  "Sent to Aura ✓"
                ) : (
                  <>
                    <PlusGlyph />
                    <span>Draft the pull request with Aura</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        <div className="mx-4 h-px bg-line-soft/70" />

        {/* Quiet status strip — git reality + Aura's semantic checks. Every
            action hands the work to the Aura chat. */}
        <div className="px-4 py-3 flex flex-col gap-3">
          <Section label="Status">
            {conflictsCount > 0 && (
              <Row
                done={false}
                running={runningAction?.id === "resolve"}
                label="Incompatible with remote"
                actionLabel={actionText("resolve", "Resolve")}
                onAction={() => askAura("resolve", resolveConflictsPrompt())}
              />
            )}
            {changedCount > 0 && (
              <Row
                done={false}
                running={runningAction?.id === "commit"}
                label={`${changedCount} uncommitted change${changedCount === 1 ? "" : "s"}`}
                actionLabel={actionText("commit", "Commit and push")}
                onAction={() =>
                  askAura(
                    "commit",
                    "Commit the current uncommitted changes with a clear, accurate message that reflects what changed and why, then push to the remote.",
                  )
                }
              />
            )}
            {!ab.has_upstream ? (
              <Row
                done={false}
                running={runningAction?.id === "publish"}
                label="Branch isn't published yet"
                actionLabel={actionText("publish", "Publish")}
                onAction={() =>
                  askAura(
                    "publish",
                    "Publish this branch to the remote (set its upstream) and push the commits.",
                  )
                }
              />
            ) : (
              <>
                {ab.behind > 0 && (
                  <Row
                    done={false}
                    running={runningAction?.id === "pull"}
                    label={`${ab.behind} commit${ab.behind === 1 ? "" : "s"} behind remote`}
                    actionLabel={actionText("pull", "Pull")}
                    onAction={() =>
                      askAura(
                        "pull",
                        "Pull the latest changes from the remote into this branch and reconcile anything that needs it.",
                      )
                    }
                  />
                )}
                {ab.ahead > 0 && (
                  <Row
                    done={false}
                    running={runningAction?.id === "push"}
                    label={`${ab.ahead} commit${ab.ahead === 1 ? "" : "s"} ahead of remote`}
                    actionLabel={actionText("push", "Push")}
                    onAction={() =>
                      askAura(
                        "push",
                        `Push the ${ab.ahead} unpushed commit${ab.ahead === 1 ? "" : "s"} on this branch to the remote.`,
                      )
                    }
                  />
                )}
                {inSync && conflictsCount === 0 && (
                  <Row done label="In sync with remote" />
                )}
              </>
            )}
            {pr &&
              (prState === "merged" ? (
                <Row done label="Merged" />
              ) : prState === "closed" ? (
                <Row done={false} passive label="PR closed without merging" />
              ) : (
                <Row
                  done={approved}
                  passive={!approved}
                  label={approved ? "PR approved" : "Waiting for PR review"}
                />
              ))}
          </Section>

          {/* Real PR discussion — comments people left on this pull request,
              each with hover-reveal actions (Hide / Add to chat). */}
          {pr && discussion.length > 0 && (
            <Section
              label="Comments"
              action={{ label: "Add all to chat", onClick: addAllToChat }}
            >
              {discussion.map((c) => (
                <CommentRow
                  key={c.id}
                  author={c.author}
                  body={c.body.trim()}
                  onOpen={() =>
                    editor.openPrDetail(repoRoot, pr.number, pr.title, "conversation")
                  }
                  onHide={() =>
                    setHidden((prev) => new Set(prev).add(c.id))
                  }
                  onAddToChat={() => addOneToChat(c)}
                />
              ))}
            </Section>
          )}

          <Section label="Aura">
            {/* Each of these asks Aura to run its OWN tool (`aura pr-review` /
                `aura prove` / `aura attest`) right in the chat the user is
                already watching, and report the verdict inline — no separate
                tab or pane opens. `askAura` seeds the ambient manager chat. */}
            <Row
              glyph={<RunGlyph />}
              running={runningAction?.id === "review"}
              label="Safety check"
              hint="Semantic PR review — bugs, security, layer drift (Aura runs aura pr-review in chat)"
              actionLabel={actionText("review", "Review")}
              onAction={() => askAura("review", safetyCheckPrompt())}
            />
            <Row
              glyph={<RunGlyph />}
              running={runningAction?.id === "prove"}
              label="Goals proven"
              hint="Prove the user-facing behavior is actually wired (Aura runs aura prove in chat)"
              actionLabel={actionText("prove", "Prove")}
              onAction={() => askAura("prove", proveGoalsPrompt())}
            />
            <Row
              glyph={<RunGlyph />}
              running={runningAction?.id === "attest"}
              label="Attestations"
              hint="Signed intent + provenance for these changes (Aura runs aura attest in chat)"
              actionLabel={actionText("attest", "View")}
              onAction={() => askAura("attest", attestPrompt())}
            />
          </Section>
        </div>
      </div>

      {/* ── Drag handle between the document and the PR list ─────────────── */}
      {!prCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onPointerDown}
          title="Drag to resize"
          className="group relative h-1.5 shrink-0 cursor-row-resize border-t border-line-soft"
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "var(--color-accent)" }} />
        </div>
      )}

      {/* ── BOTTOM: every pull request. Collapsed → just its header (the top
          document takes the freed height); expanded → the resizable share. ── */}
      <div
        className={`min-h-0 overflow-hidden ${prCollapsed ? "shrink-0 border-t border-line-soft" : ""}`}
        style={prCollapsed ? undefined : { flexGrow: 1 - ratio, flexBasis: 0 }}
      >
        <PrRailPanel
          repoRoot={repoRoot}
          collapsed={prCollapsed}
          onToggleCollapsed={togglePrCollapsed}
        />
      </div>
    </div>
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  /** Optional right-aligned section action (e.g. "Add all to chat"). */
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center mb-1">
        <span className="text-[10px] tracking-wide text-text-4">{label}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="ml-auto text-[11px] font-medium text-text-3 hover:text-text-1 hover:underline"
          >
            {action.label}
          </button>
        )}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function CommentRow({
  author,
  body,
  onOpen,
  onHide,
  onAddToChat,
}: {
  author: string;
  body: string;
  /** Open the PR on its Conversation tab, scrolled to the discussion. */
  onOpen: () => void;
  onHide: () => void;
  onAddToChat: () => void;
}) {
  return (
    // ONE line per comment: author + body truncated to a single row so a wall of
    // GitHub discussion doesn't shove the checks off-screen. The full text is a
    // native tooltip on hover; clicking opens the PR's Conversation tab to read
    // (and reply to) the whole thread. Actions reveal on row hover.
    <div className="group flex items-center gap-2 py-1 min-w-0">
      <span className="shrink-0">
        <Monogram name={author} />
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={`${author}: ${body}`}
        className="min-w-0 flex-1 text-left truncate text-[11.5px] leading-snug hover:underline underline-offset-2"
      >
        <span className="text-text-2 font-medium">{author}</span>{" "}
        <span className="text-text-3">{body}</span>
      </button>
      {/* Hover-reveal per-comment actions (Conductor-style). */}
      <span className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onAddToChat}
          title="Add this comment to the Aura chat"
          className="text-[11px] font-medium text-text-3 hover:text-text-1"
        >
          Add to chat
        </button>
        <button
          type="button"
          onClick={onHide}
          title="Hide this comment"
          className="text-[11px] font-medium text-text-4 hover:text-text-1"
        >
          Hide
        </button>
      </span>
    </div>
  );
}

function Monogram({ name }: { name: string }) {
  const ch = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="w-4 h-4 rounded-full bg-bg-3 text-text-3 text-[9px] font-medium flex items-center justify-center">
      {ch}
    </span>
  );
}

function Row({
  done = false,
  passive = false,
  running = false,
  label,
  hint,
  actionLabel,
  onAction,
  glyph,
}: {
  done?: boolean;
  passive?: boolean;
  /** The row's work is live in the ambient chat: the leading glyph becomes an
   *  amber spinner and the action is replaced by a non-clickable "Working…" so
   *  the in-progress state is unmistakable while the brain runs. */
  running?: boolean;
  label: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Overrides the leading status glyph. The Aura tool rows use this to show a
   *  "run" mark instead of a checkbox — they launch a tool, not track a task,
   *  so a circle that can never tick would read as a stuck to-do. */
  glyph?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-1 min-w-0" title={hint}>
      <span className="shrink-0 w-3.5 flex items-center justify-center">
        {running ? (
          <AsciiSpinner className="text-[10px]" />
        ) : glyph ? (
          glyph
        ) : passive ? (
          <AsciiSpinner className="text-[10px]" />
        ) : done ? (
          <CheckCircle />
        ) : (
          <EmptyCircle />
        )}
      </span>
      <span
        className={`flex-1 min-w-0 truncate text-[11.5px] ${
          done ? "text-text-3" : "text-text-2"
        }`}
      >
        {label}
      </span>
      {running ? (
        <span className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-amber">
          <AsciiSpinner className="text-[10px]" />
          Working…
        </span>
      ) : (
        actionLabel &&
        onAction && (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 text-[11px] font-medium text-text-3 hover:text-text-1 hover:underline"
          >
            {actionLabel}
          </button>
        )
      )}
    </div>
  );
}

function OpenTabGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9.5 2.5H13.5V6.5M13 3 7.5 8.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Small plus for the "draft a PR" affordance — reads as "create a new PR".
function PlusGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// "Run" mark for the Aura tool rows — a small emerald play triangle that reads
// as "run Aura's own check", distinct from the status circles above it.
function RunGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5 3.5v9l7-4.5-7-4.5z" fill="var(--color-accent)" />
    </svg>
  );
}

function CheckCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="var(--color-accent-green)" />
      <path
        d="M5.2 8.2 7 10l3.8-4"
        stroke="var(--color-bg-1)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmptyCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6.2"
        stroke="var(--color-text-4)"
        strokeWidth="1.4"
      />
    </svg>
  );
}
