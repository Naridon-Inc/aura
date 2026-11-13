// The pull request page's header parts: the update button, the reviewer
// avatars, the risk and check chips, the tab glyphs, and the cold-load
// silhouette.

import { runGitChat } from "../../../lib/gitChat";
import { updatePrJobId, UPDATE_PR_HINT } from "../../../lib/worktreeActions";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { StatusChip } from "../../ui/statusChip";

/**
 * "Update with Aura" — the same chat the review rail's button opens, offered
 * where you actually read a pull request.
 *
 * Aura opens most of these PRs, and a PR it opened goes stale the moment more
 * work lands on the branch: the diff follows the branch head automatically, the
 * prose does not. So the title, the description, the blast-radius note and the
 * reviewer checklist keep describing the PR as it was on the day it opened. The
 * fix is a chat that rewrites the PR to match what the branch does now, and it
 * was only reachable from the review rail, which is exactly the thing a PR tab
 * takes off the screen.
 *
 * It runs on any open PR, not only Aura's. We don't record who opened a pull
 * request, and gating on provenance we'd have to guess at would hide the button
 * on half the PRs that need it. Rewriting a description to match the branch is
 * worth doing whoever opened it.
 */
export function UpdateWithAuraButton({
  repoRoot,
  prNumber,
  headRef,
  running,
}: {
  repoRoot: string;
  prNumber: number;
  headRef: string;
  running: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={running}
      onClick={() =>
        void runGitChat(repoRoot, updatePrJobId(prNumber), {
          action: "update-pr",
          branch: headRef,
          prNumber,
        })
      }
      title={UPDATE_PR_HINT}
    >
      {running ? (
        <>
          <AsciiSpinner className="text-2xs" />
          Updating…
        </>
      ) : (
        "Update with Aura"
      )}
    </Button>
  );
}

export function hashRoot(root: string): string {
  // Cheap stable key — repo root absolute paths are long; we only need
  // collision-resistance within a single user's localStorage.
  let h = 5381;
  for (let i = 0; i < root.length; i++) {
    h = ((h << 5) + h + root.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ── Header pills ─────────────────────────────────────────────────────

export function ReviewerPips({
  reviewers,
}: {
  reviewers: { login: string; state: string }[];
}) {
  // Up to four reviewers as overlapping marks, with a +N pill for the rest.
  const MAX = 4;
  const visible = reviewers.slice(0, MAX);
  const overflow = reviewers.length - visible.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((r) => (
        <Pip key={r.login} login={r.login} approved={r.state === "APPROVED"} />
      ))}
      {overflow > 0 && (
        <span className="relative w-6 h-6 rounded-full bg-bg-2 border border-bg-content text-text-3 text-2xs font-bold flex items-center justify-center">
          +{overflow}
        </span>
      )}
    </div>
  );
}

export function Pip({ login, approved }: { login: string; approved: boolean }) {
  const initial = (login || "?").charAt(0).toUpperCase();
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      title={`${login}${approved ? " ✓ approved" : ""}`}
      className="relative w-6 h-6 rounded-full border-2 border-bg-content flex items-center justify-center text-2xs font-bold text-white"
      style={{ backgroundColor: `hsl(${hue}, 45%, 38%)` }}
    >
      {initial}
      {approved && (
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-500 border border-bg-content text-white text-2xs font-bold flex items-center justify-center leading-none">
          ✓
        </span>
      )}
    </span>
  );
}

// Mirrors the populated layout (file list, patch, side column)
// so the cold-load silhouette matches the eventual content; user's eye
// stays put when data lands.
export function PrDetailSkeleton() {
  return (
    <div className="flex-1 min-h-0 flex" aria-hidden>
      <div className="w-[260px] flex-shrink-0 border-r border-line-soft p-3 space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      <div className="flex-1 min-w-0 border-r border-line-soft p-3 space-y-2">
        <Skeleton className="h-3 w-1/3" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      <div className="w-[340px] flex-shrink-0 p-3 space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

// ── Tab glyphs ───────────────────────────────────────────────────────
// 14px stroke icons for the header tab cells (WizardStepTabs `tabs`
// variant); colour is inherited (currentColor) so active = accent.

export function OverviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2.5" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="8" width="7" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="8" width="3" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function FilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 2h5l3 3v9H4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function ChecksIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.5 8.2l1.7 1.7 3.3-3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function renderRiskChip(score: number, label: string) {
  const tone = score > 60 ? "red" : score > 0 ? "amber" : "green";
  return (
    <StatusChip dense tone={tone} title={`Aura risk score ${score}`}>
      aura {label || score}
    </StatusChip>
  );
}
