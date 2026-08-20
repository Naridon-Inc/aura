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
// remembered. Every actionable row hands its work to Aura rather than running
// git silently — the review, the prove, the attestations and the git moves are
// all real agent runs you can read, not fake progress bars.
//
// They run as BACKGROUND JOBS (lib/auraJob): each click mints its own session
// instead of writing a synthetic user turn into whatever conversation you're
// currently having. Clicking "Safety check" mid-chat used to splice a paragraph
// of instructions into your thread and yank the rail onto it. Now the row spins
// while the job runs, a toast offers the transcript when it lands, and your
// conversation is left alone. The two "Add to chat" affordances are the
// deliberate exception — putting a comment IN the chat is the whole point.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type AheadBehind,
  type PrComment,
  type PrDetail,
  type PrSummary,
} from "../../lib/api";
import { fetchAheadBehind, fetchDiffStats } from "../../lib/gitStateCache";
import { fetchPrDetail } from "../../lib/prDetailCache";
import { fetchPrComments } from "../../lib/prCommentsCache";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  pickBranchPr,
  subscribePrList,
} from "../../lib/prsCache";
import { branchStateDetail, branchStateLabel } from "./reviewState";
import { monogram } from "../../lib/monogram";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { useVerticalSplit } from "../../lib/useVerticalSplit";
import { useEditorStore } from "../../lib/editorStore";
import { startAuraJob, useAuraJobs } from "../../lib/auraJob";
import { sendToAmbientManager } from "../../lib/focusManager";
import {
  safetyCheckPrompt,
  proveGoalsPrompt,
  attestPrompt,
  createPrPrompt,
  resolveConflictsPrompt,
  updatePrJobId,
  updatePrPrompt,
  UPDATE_PR_HINT,
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
  // `null` until a read lands. The seed used to be `{0, 0, has_upstream:
  // false}` — a perfectly valid answer meaning "this branch was never
  // published" — so the Status section's first frame drew "Nobody else can
  // see this yet" with a Publish action, having read nothing. `catch` kept
  // that seed for the whole session whenever git failed.
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [readErr, setReadErr] = useState<string>("");
  const [changedCount, setChangedCount] = useState(0);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  // Live background jobs for this repo, keyed by the row that fired them. A row
  // shows an amber spinner for as long as its job is actually running — not a
  // 2-second "Asked ✓" flash that lied about work still in flight — then a
  // brief "Done ✓" while the finished job lingers in the store.
  const job = useAuraJobs(repoRoot);
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
          fetchAheadBehind(repoRoot),
          fetchDiffStats(repoRoot).catch(() => null),
        ]);
        if (cancelled) return;
        setAb(a);
        setReadErr("");
        if (d) setChangedCount(d.changed_files);
      } catch (e) {
        // A failed read is its own state. Leaving `ab` at a zeroed struct is
        // what made "unpublished" the resting state of every git failure, and
        // the rows below say so out loud rather than inventing a verdict.
        if (cancelled) return;
        setReadErr(String(e).replace(/^Error:\s*/i, "").split("\n")[0]);
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

  const branch = ab?.branch ?? null;
  // The OPEN pull request for this branch wins — see `pickBranchPr`. This whole
  // panel is that PR's document: its title is editable here, "Update with Aura"
  // rewrites its description. Landing on a superseded closed PR meant editing
  // the wrong one while the live PR sat in the list below.
  const pr = useMemo(() => pickBranchPr(prs, branch), [prs, branch]);
  const prState = pr?.state.toLowerCase() ?? null;

  // Load the PR body prose once per PR (for the description document).
  useEffect(() => {
    if (!pr) {
      setDetail(null);
      return;
    }
    let alive = true;
    void fetchPrDetail(repoRoot, pr.number)
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
    void fetchPrComments(repoRoot, pr.number)
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

  // Run a row's work as a background job. Nothing is written into the chat the
  // user may be in the middle of, and the rail doesn't jump — the row's own
  // spinner and the completion toast carry the whole story.
  const askAura = useCallback(
    (id: string, title: string, text: string) => {
      startAuraJob({ repoRoot, id, title, text });
    },
    [repoRoot],
  );

  // The right-hand action label for a row: its default verb, or a brief
  // "Done ✓" while the finished job lingers. The live "Working…" state is
  // rendered by <Row running> and takes over the whole action slot.
  const actionText = useCallback(
    (id: string, label: string) => {
      const status = job(id)?.status;
      if (status === "done") return "Done ✓";
      if (status === "failed") return "Try again";
      return label;
    },
    [job],
  );
  const isRunning = useCallback(
    (id: string) => job(id)?.status === "running",
    [job],
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

  // Re-write the PR from what's on the branch NOW — on request. We already
  // track the intent log, the commits and the diff, so Aura has everything it
  // needs; what it doesn't have is a trigger. This is the trigger, and it is a
  // person pressing a button. (The comment here used to open "Aura keeps the PR
  // properly written as work lands", which is how the empty state below came to
  // promise the same thing. It isn't automatic and never was.)
  //
  // The job id is shared with the header's "Update PR" button and the PR tab's
  // own action (`updatePrJobId`), so all three show the one run for the one PR.
  // There used to be a `pr ? updatePrJobId(pr.number) : "update-pr"` alias here
  // for the two reads below. Both live inside `{pr ? … }`, so the fallback was
  // unreachable — and a bare "update-pr" in the source is the exact shape of
  // the bug `updatePrJobId` exists to prevent, sitting where the next person to
  // copy a line from this file would find it.
  const updateWithAura = useCallback(() => {
    if (!pr) return;
    askAura(
      updatePrJobId(pr.number),
      `Update pull request #${pr.number}`,
      updatePrPrompt(pr.head_ref, pr.number),
    );
  }, [askAura, pr]);

  // No PR yet: hand the whole "open a pull request" job to Aura. The
  // auto-written description only appears once a PR exists (it's the top
  // document above), so without this affordance the panel just reads "no PR"
  // and the writing never kicks in — which is exactly the "it shows nothing"
  // gap. `createPrPrompt` is the same full sequence the header's Create PR
  // button runs: look at the working tree and the diff, commit what belongs,
  // run the checks, then open the PR.
  const draftWithAura = useCallback(() => {
    askAura(
      "create-pr",
      "Open the pull request",
      createPrPrompt(branch ?? "the current branch", ""),
    );
  }, [askAura, branch]);

  const approved = pr?.review_decision === "APPROVED";
  // The row this gates says "Up to date", and its hover — shared with the bar
  // at the top of the rail — reads "In sync with the upstream branch, **and
  // nothing uncommitted**". The second half was never checked here: `inSync`
  // only ever looked at ahead/behind, so a branch level with the remote drew
  // a green tick claiming nothing was uncommitted directly under a row
  // counting fifteen changed files.
  const inSync =
    ab !== null &&
    ab.has_upstream &&
    ab.ahead === 0 &&
    ab.behind === 0 &&
    changedCount === 0;
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
                className="w-full bg-transparent px-1 -mx-1 py-0.5 text-md font-semibold text-text-1 leading-snug outline-none border-b border-accent/50"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(pr.title);
                  setEditingTitle(true);
                }}
                title="Click to edit the PR title"
                className="w-full text-left text-md font-semibold text-text-1 leading-snug rounded px-1 -mx-1 hover:bg-state-hover transition-colors"
              >
                {pr.title}
              </button>
            )
          ) : (
            <div className="text-md font-semibold text-text-1 leading-snug">
              {branch ? `Branch ${branch}` : "No branch"}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-xs text-text-4 min-w-0">
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
                    className="inline-flex items-center gap-1 text-xs font-medium text-text-3 hover:text-text-1 transition-colors"
                  >
                    <OpenTabGlyph />
                    <span>Open as tab</span>
                  </button>
                  <button
                    type="button"
                    onClick={updateWithAura}
                    title={UPDATE_PR_HINT}
                    className="inline-flex items-center gap-1 text-xs font-medium text-text-3 hover:text-text-1 transition-colors"
                  >
                    {isRunning(updatePrJobId(pr.number)) ? (
                      <>
                        <AsciiSpinner className="text-2xs" />
                        <span>Updating…</span>
                      </>
                    ) : (
                      actionText(updatePrJobId(pr.number), "Update with Aura")
                    )}
                  </button>
                </div>
              </>
            ) : (
              branch && <span className="font-mono truncate">{branch}</span>
            )}
          </div>
        </div>

        <div className="mx-4 h-px bg-line-soft/70" />

        {/* Quiet status strip — git reality + Aura's semantic checks. Every
            action hands the work to the Aura chat.

            It leads the panel now. It used to sit UNDER the PR description,
            and a description is unbounded: on a real PR it took seventy-odd
            lines of scrolling to reach a single check, so a tab called
            "Checks" opened on prose and showed none. Everything above the
            description is bounded and glanceable, in ascending order of how
            far it can grow — six git rows, three Aura rows, one line per
            review comment — and the one section with no ceiling goes last. */}
        <div className="px-4 py-3 flex flex-col gap-3">
          <Section label="Status">
            {/* Every label here comes from `branchStateLabel` — the same
                vocabulary the state bar at the top of this rail uses. These
                rows used to write their own copy, so a conflicted branch read
                "Merge conflicts" in the bar and "Incompatible with remote"
                fifteen rows below it, each with its own Resolve button.

                `hint` is the precise git fact, on the row's hover. It is the
                same split the bar makes: the words on screen say what the
                state means to someone who doesn't write code, and "586
                commits on the upstream branch that this one doesn't have" is
                one hover away rather than gone. */}
            {conflictsCount > 0 && (
              <Row
                done={false}
                running={isRunning("resolve")}
                label={branchStateLabel("conflicts")}
                hint={branchStateDetail("conflicts")}
                actionLabel={actionText("resolve", "Resolve")}
                onAction={() =>
                  askAura("resolve", "Resolve the conflicts", resolveConflictsPrompt())
                }
              />
            )}
            {changedCount > 0 && (
              <Row
                done={false}
                running={isRunning("commit")}
                label={branchStateLabel("uncommitted", changedCount)}
                hint={branchStateDetail("uncommitted", changedCount)}
                actionLabel={actionText("commit", "Commit and push")}
                onAction={() =>
                  askAura(
                    "commit",
                    "Commit and push",
                    "Commit the current uncommitted changes with a clear, accurate message that reflects what changed and why, then push to the remote.",
                  )
                }
              />
            )}
            {/* Nothing has come back from git yet, or the last read failed
                with nothing before it. Every row below reads a field of `ab`,
                and the zeroed struct that used to stand in for "not read"
                spelled "unpublished" exactly — so this section opened by
                telling you nobody could see your work and offering to publish
                it, and stayed there for the session if git kept failing. */}
            {ab === null ? (
              <Row
                passive
                label={branchStateLabel("unknown")}
                hint={
                  readErr
                    ? `${branchStateDetail("unknown")}\n${readErr}`
                    : branchStateDetail("unknown")
                }
              />
            ) : !ab.has_upstream ? (
              <Row
                done={false}
                running={isRunning("publish")}
                label={branchStateLabel("unpublished")}
                hint={branchStateDetail("unpublished")}
                actionLabel={actionText("publish", "Publish")}
                onAction={() =>
                  askAura(
                    "publish",
                    "Publish the branch",
                    "Publish this branch to the remote (set its upstream) and push the commits.",
                  )
                }
              />
            ) : (
              <>
                {ab.behind > 0 && (
                  <Row
                    done={false}
                    running={isRunning("pull")}
                    label={branchStateLabel("behind", ab.behind)}
                    hint={branchStateDetail("behind", ab.behind)}
                    actionLabel={actionText("pull", "Pull")}
                    onAction={() =>
                      askAura(
                        "pull",
                        "Pull from the remote",
                        "Pull the latest changes from the remote into this branch and reconcile anything that needs it.",
                      )
                    }
                  />
                )}
                {ab.ahead > 0 && (
                  <Row
                    done={false}
                    running={isRunning("push")}
                    label={branchStateLabel("ahead", ab.ahead)}
                    hint={branchStateDetail("ahead", ab.ahead)}
                    actionLabel={actionText("push", "Push")}
                    onAction={() =>
                      askAura(
                        "push",
                        "Push to the remote",
                        `Push the ${ab.ahead} unpushed commit${ab.ahead === 1 ? "" : "s"} on this branch to the remote.`,
                      )
                    }
                  />
                )}
                {inSync && conflictsCount === 0 && (
                  <Row
                    done
                    label={branchStateLabel("clean")}
                    hint={branchStateDetail("clean")}
                  />
                )}
              </>
            )}
            {pr &&
              (prState === "merged" ? (
                <Row
                  done
                  label={branchStateLabel("merged")}
                  hint={branchStateDetail("merged")}
                />
              ) : prState === "closed" ? (
                // Closed and never merged: an ending, not a pending step. It
                // used to draw the amber spinner — the app's "working on it"
                // mark — and animate it forever beside a PR nothing would ever
                // happen to again.
                <Row glyph={<ClosedCircle />} label="Closed without merging" />
              ) : (
                <Row
                  done={approved}
                  passive={!approved}
                  label={approved ? "PR approved" : "Waiting for PR review"}
                />
              ))}
          </Section>

          <Section label="Aura">
            {/* Each of these has Aura run its OWN tool (`aura pr-review` /
                `aura prove` / `aura attest`) as a background job and report the
                verdict there. The row spins while it runs; the toast that lands
                when it's done opens the transcript.

                The hints say what the row DOES, not which command produces it.
                They used to be the command's own summary line — "Semantic PR
                review — bugs, security, layer drift", "Signed intent +
                provenance" — which reads as a feature list to someone who
                already knows the feature and as nothing at all to everybody
                else. Aura's term for the thing goes in parentheses where it
                helps you find it again elsewhere; it never leads. */}
            <Row
              glyph={<RunGlyph />}
              running={isRunning("review")}
              label="Safety check"
              hint="Aura reads every change here and looks for bugs, security holes, and code reaching into places it shouldn't. Runs in the background; open it from the toast when it's done."
              actionLabel={actionText("review", "Review")}
              onAction={() => askAura("review", "Safety check", safetyCheckPrompt())}
            />
            <Row
              glyph={<RunGlyph />}
              running={isRunning("prove")}
              label="Goals proven"
              hint="Checks that what you set out to build actually works end to end, not just that the code for it exists. Runs in the background; open it from the toast when it's done."
              actionLabel={actionText("prove", "Prove")}
              onAction={() => askAura("prove", "Prove the goals", proveGoalsPrompt())}
            />
            <Row
              glyph={<RunGlyph />}
              running={isRunning("attest")}
              label="Signed record"
              hint="A signed, tamper-evident record of who changed what here and why, so it can be checked later (Aura calls these attestations). Runs in the background; open it from the toast when it's done."
              actionLabel={actionText("attest", "View")}
              onAction={() => askAura("attest", "Signed record", attestPrompt())}
            />
          </Section>

          {/* Real PR discussion — comments people left on this pull request,
              each with hover-reveal actions (Hide / Add to chat). One line
              apiece, so N comments cost N lines and the checks above them
              never move. */}
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
        </div>

        <div className="mx-4 h-px bg-line-soft/70" />

        {/* The PR document — the long read, and the only section here with no
            ceiling on its height. Editable in place: click the prose to write
            it, ⌘↵ or blur to save. */}
        <div className="px-4 py-3">
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
                className="w-full bg-transparent outline-none resize-none text-base text-text-2 leading-relaxed placeholder:text-text-5"
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
                className="group/desc block w-full text-left rounded px-1 -mx-1 hover:bg-state-hover transition-colors"
              >
                {body ? (
                  <MarkdownInline source={body} className="text-text-2" />
                ) : (
                  <span className="text-sm text-text-4">
                    Add a description…
                  </span>
                )}
              </button>
            )
          ) : (
            <div className="flex flex-col gap-2">
              {/* This used to end "Once a PR is open, Aura keeps its title and
                  description written for you as work lands." Nothing does that.
                  `updatePrPrompt` has exactly three callers and all three are
                  onClick handlers — the button above, the one in the header, and
                  the one on a PR tab. Nothing watches for a commit or a push and
                  re-runs it, so a person who read that sentence and then pushed
                  four more commits would be looking at a description of work
                  that shipped three days ago, believing it was current. Say what
                  the button does and where the button is. */}
              <p className="text-sm text-text-4 leading-relaxed">
                No pull request for this branch yet, so there's nothing to
                describe here. Open one and Aura writes the title and
                description from what actually changed. It won't revise them on
                its own after that. When more work lands, press "Update with
                Aura" at the top of this panel.
              </p>
              <button
                type="button"
                onClick={draftWithAura}
                title="Aura commits and pushes what's needed, runs the checks, opens the pull request, and writes its description from what actually changed. In the background"
                className="self-start inline-flex items-center gap-1.5 text-xs font-medium text-text-3 hover:text-text-1 transition-colors"
              >
                {isRunning("create-pr") ? (
                  <>
                    <AsciiSpinner className="text-2xs" />
                    <span>Opening the pull request…</span>
                  </>
                ) : (
                  <>
                    <PlusGlyph />
                    <span>
                      {actionText("create-pr", "Draft the pull request with Aura")}
                    </span>
                  </>
                )}
              </button>
            </div>
          )}
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
        <span className="text-2xs tracking-wide text-text-4">{label}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="ml-auto text-xs font-medium text-text-3 hover:text-text-1 hover:underline"
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
        className="min-w-0 flex-1 text-left truncate text-sm leading-snug hover:underline underline-offset-2"
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
          className="text-xs font-medium text-text-3 hover:text-text-1"
        >
          Add to chat
        </button>
        <button
          type="button"
          onClick={onHide}
          title="Hide this comment"
          className="text-xs font-medium text-text-4 hover:text-text-1"
        >
          Hide
        </button>
      </span>
    </div>
  );
}

function Monogram({ name }: { name: string }) {
  // One monogram for the whole app — see lib/monogram. This one indexed by code unit, so an
  // author whose name opened with an emoji rendered half a surrogate pair.
  const ch = monogram(name);
  return (
    <span className="w-4 h-4 rounded-full bg-bg-3 text-text-3 text-2xs font-medium flex items-center justify-center">
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
  /** Real, unfinished, and not yours to finish — "Waiting for PR review" waits
   *  on a person. It draws a static pending mark rather than the empty circle
   *  (which pairs with an action button you can press) and rather than the
   *  spinner (which means Aura is running something right now). */
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
          <AsciiSpinner className="text-2xs" />
        ) : glyph ? (
          glyph
        ) : passive ? (
          <PendingCircle />
        ) : done ? (
          <CheckCircle />
        ) : (
          <EmptyCircle />
        )}
      </span>
      <span
        className={`flex-1 min-w-0 truncate text-sm ${
          done ? "text-text-3" : "text-text-2"
        }`}
      >
        {label}
      </span>
      {running ? (
        <span className="shrink-0 flex items-center gap-1 text-xs font-medium text-amber">
          <AsciiSpinner className="text-2xs" />
          Working…
        </span>
      ) : (
        actionLabel &&
        onAction && (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 text-xs font-medium text-text-3 hover:text-text-1 hover:underline"
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

// Pending on someone else — a ring with a centred dot. Reads as "started, not
// finished, nothing for you to press", which is exactly what waiting on a
// human reviewer is. Static: nothing is computing.
function PendingCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6.2"
        stroke="var(--color-text-4)"
        strokeWidth="1.4"
      />
      <circle cx="8" cy="8" r="2.2" fill="var(--color-text-4)" />
    </svg>
  );
}

// Closed without merging — a ring struck through. An ending that isn't a
// success, so it takes neither the green tick nor the empty to-do circle.
function ClosedCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6.2"
        stroke="var(--color-text-4)"
        strokeWidth="1.4"
      />
      <line
        x1="5.2"
        y1="8"
        x2="10.8"
        y2="8"
        stroke="var(--color-text-4)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
