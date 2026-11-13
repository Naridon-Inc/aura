//! What an empty conversation shows before its first message.
//!
//! The first chat in a project says where you are: the copy of the repository
//! this chat works in, the branch it was made from, and how its setup script
//! is doing. Once the project has
//! history, a new chat says which folder it is in and offers the earlier
//! conversations and saved plans as attachments for the first message. The
//! starters for a first chat sit above the composer (ChatStarters).

import * as React from "react";
import { GitBranch } from "lucide-react";
import { api } from "../../../lib/api";
import { worktreeParentName } from "../../../lib/workspaceLabel";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { Timeline } from "../../ui/timeline";
import { chatPlace, chatPlaceSentence } from "./chatPlace";
import { getActiveWorkspaceRoot } from "../../../lib/editorStore";
import { usePlanPages, usePriorChats } from "./chatStartSources";
import { PlanChips, TranscriptChips } from "./ChatStartAttachments";
import { useSetupEntry } from "./ChatSetupEntry";
import "../../ui/chat-start.css";

/** A branch name is "default" — the shared trunk, not a personal copy. We never
 *  show the working-copy context card on these. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

/** Drop the `origin/` (or any remote) prefix from an upstream ref so the base
 *  reads as a plain branch name: `origin/main` → "main". */
function shortBase(ref: string): string {
  return ref.replace(/^[^/]+\//, "");
}

/** The real git context for the current working copy, resolved on mount. Only
 *  fields we could actually read are set — a missing value means "omit that
 *  row", never a placeholder. */
interface ChatContext {
  /** Current branch name, when it's a non-default branch (a personal copy). */
  branch: string;
  /** Base branch this copy was branched from, when we could determine it. */
  base: string | null;
}

/** Resolve the current working copy's git context from real data only. Returns
 *  `null` while loading, when there's no repo root, or when we're on the shared
 *  trunk (main/master) — in which case the caller shows the plain welcome with
 *  no context card. */
function useChatContext(repoRoot?: string): {
  ctx: ChatContext | null;
  /** Whether the folder answered at all. `null` until we know — an unfinished
   *  read must not be reported as a folder that has gone. */
  reachable: boolean | null;
} {
  const [ctx, setCtx] = React.useState<ChatContext | null>(null);
  const [reachable, setReachable] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (!repoRoot) {
      setCtx(null);
      setReachable(null);
      return;
    }
    let cancelled = false;
    setReachable(null);
    void (async () => {
      try {
        const branch = (await api.gitBranch(repoRoot)).trim();
        if (!cancelled) setReachable(true);
        // On the shared trunk there's no "copy" to describe — stay plain.
        if (!branch || DEFAULT_BRANCHES.has(branch)) {
          if (!cancelled) setCtx(null);
          return;
        }
        // Find this branch's upstream to name the base it was branched from.
        // No upstream → look for a default branch that actually exists locally
        // before naming one, so we never invent a base that isn't there.
        let base: string | null = null;
        try {
          const rich = await api.gitBranchesRich(repoRoot);
          const current = rich.find((b) => b.isCurrent && !b.isRemote);
          if (current?.upstream) {
            base = shortBase(current.upstream);
          } else {
            const names = new Set(rich.map((b) => shortBase(b.name)));
            base =
              ["main", "master"].find((d) => names.has(d)) ?? null;
          }
        } catch {
          // Rich branch read failed — keep the headline, omit the base row.
          base = null;
        }
        if (!cancelled) setCtx({ branch, base });
      } catch {
        // The folder did not answer: deleted, renamed, or no longer a repo.
        // A chat bound to it cannot run, which is worth saying out loud.
        if (!cancelled) {
          setCtx(null);
          setReachable(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  return { ctx, reachable };
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The first chat in a copy of the repository: the copy named, then the
 *  branch it was made from, read from git. */
function NewCopyCard({
  ctx,
  projectLabel,
  repoRoot,
  sessionId,
}: {
  ctx: ChatContext;
  projectLabel?: string;
  repoRoot: string;
  sessionId?: string;
}) {
  const repo = worktreeParentName(repoRoot) ?? projectLabel ?? folderName(repoRoot);
  const setup = useSetupEntry(repoRoot, sessionId);
  const entries = [
    ...(ctx.base
      ? [
          {
            id: "branched",
            title: "",
            marker: <GitBranch aria-hidden />,
            detail: (
              <>
                Branched <span className="ui-chat-start-mono">{ctx.branch}</span> from{" "}
                <span className="ui-chat-start-mono">{ctx.base}</span>
              </>
            ),
          },
        ]
      : []),
    ...(setup ? [setup] : []),
  ];
  return (
    <div className="ui-chat-start-copy">
      <div className="ui-chat-start-copy-head">
        <h3>
          You&rsquo;re in a new copy of <span className="ui-chat-start-mono">{repo}</span> called{" "}
          <span className="ui-chat-start-mono">{folderName(repoRoot)}</span>
        </h3>
      </div>
      {entries.length > 0 && <Timeline entries={entries} />}
    </div>
  );
}

/** One quiet line naming where the work happens. */
function PlaceLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="ui-chat-empty-place">
      {icon}
      <span>{children}</span>
    </p>
  );
}

export function ChatEmptyState({
  projectLabel,
  repoRoot,
  machineName,
  sessionId,
}: {
  projectLabel?: string;
  repoRoot?: string;
  /** Set when this conversation's hands are on a connected machine: the
   *  working copy is over there, so the local git reads are skipped. */
  machineName?: string;
  /** The conversation whose composer takes the attachments. Without one there
   *  is nothing to attach to, so only the place is said. */
  sessionId?: string;
}) {
  const { ctx, reachable } = useChatContext(machineName ? undefined : repoRoot);
  const prior = usePriorChats(repoRoot, sessionId);
  const plans = usePlanPages(machineName ? undefined : repoRoot);

  // Where this chat's hands are, against where the window is standing. A chat
  // runs in the project it was started against, which is right and was also
  // silent: on 2026-08-23 the sidebar said `zagreb` and this surface described
  // `managua`, a worktree that had already been deleted.
  const place = machineName
    ? ({ kind: "same" } as const)
    : chatPlace(repoRoot, getActiveWorkspaceRoot(), reachable);
  const placeLine = chatPlaceSentence(place);
  const firstChat = prior !== null && prior.length === 0;
  const dir = repoRoot && !machineName ? folderName(repoRoot) : undefined;

  return (
    <div className="ui-chat-start">
      {prior === null ? null : firstChat ? (
        machineName ? (
          <MachineNote machineName={machineName} />
        ) : ctx && repoRoot && place.kind === "same" ? (
          <NewCopyCard ctx={ctx} projectLabel={projectLabel} repoRoot={repoRoot} sessionId={sessionId} />
        ) : dir ? (
          <NewChatIn dir={dir} />
        ) : null
      ) : (
        <div className="ui-chat-start-history">
          {machineName ? <MachineNote machineName={machineName} /> : dir && <NewChatIn dir={dir} />}
          {sessionId && prior.length > 0 && <TranscriptChips sessionId={sessionId} chats={prior} />}
          {sessionId && plans.length > 0 && repoRoot && (
            <PlanChips sessionId={sessionId} repoRoot={repoRoot} plans={plans} />
          )}
        </div>
      )}
      {/* Said instead of the working-copy card, never beside it: two
          sentences naming two different places is the confusion this ends. */}
      {placeLine && <PlaceLine icon={<GitBranch size={12} aria-hidden />}>{placeLine}</PlaceLine>}
    </div>
  );
}

function NewChatIn({ dir }: { dir: string }) {
  return (
    <p className="ui-chat-start-label">
      New chat in <span className="ui-chat-start-mono">/{dir}</span>.
    </p>
  );
}

/** Which disk the answers come from, on a conversation whose hands are on a
 *  connected machine: everything else on screen is the same as a local chat,
 *  which is what makes an unlabelled remote one easy to mistake for it. */
function MachineNote({ machineName }: { machineName: string }) {
  return (
    <PlaceLine icon={<CloudGlyph size={12} />}>
      Reading and running on {machineName}. The conversation is kept here.
    </PlaceLine>
  );
}
