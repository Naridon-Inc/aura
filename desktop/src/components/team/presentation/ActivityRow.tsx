/** Team (chat) presentation — Aura activity-event row (commit/intent/prove/review/snapshot relays).
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { useState } from "react";
import { AuraRelayMenu } from "../../auraRelayMenu";
import { hhmm, type ActivityPayload, type Msg } from "../domain";
import { Button } from "../../ui/button";

// ── activity-row renderer ────────────────────────────────────────────
//
// Project-feed rows (commits, intents, snapshots, sentinel pings) are
// dense, structured records, not chat. Rendering them as bubbles wastes
// vertical space and buries the metadata that makes them useful (which
// branch, which agent, did it succeed). This component renders them as
// a tight, expandable list row that mirrors the GitLens / Source Control
// activity-feed feel:
//
//   ✦  agent · "Pivoted ScheduleScreen to Unacadem…"      12:10
//                  apps/mobile/lib/features/…
//                  [feat/x] [a1b2c3d] [ok]
//
// Click anywhere on the row to expand the full body. Click the file
// chip to open the file in the editor.

export function ActivityRow({
  msg,
  activity,
  repoRoot,
}: {
  msg: Msg;
  activity: ActivityPayload;
  repoRoot: string;
}) {
  const [open, setOpen] = useState(false);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const meta = activityMeta(activity.type);
  const hasFiles = !!activity.files && activity.files.length > 0;
  const hasDetail = !!activity.detail && activity.detail.trim() !== "";
  const canShowDiff = !!activity.commitSha;
  const canShare = !!activity.commitSha || activity.type === "intent";
  // Every activity row is clickable. Even a single-line intent without
  // files or commit deserves an expand state: it shows the un-truncated
  // title, badges, and (for commits) the Show diff CTA.

  const openDiff = (e: React.MouseEvent) => {
    if (!activity.commitSha) return;
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("aura:open-commit-diff", {
        detail: { sha: activity.commitSha, subject: activity.title },
      }),
    );
  };

  const openFile = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("aura:open-file", { detail: { path } }),
    );
  };

  const openShare = (e: React.MouseEvent | React.UIEvent) => {
    if (!canShare) return;
    e.preventDefault();
    e.stopPropagation();
    // Anchor on the row itself so the menu drops down beneath it.
    const el = e.currentTarget as HTMLElement;
    setShareAnchor(el);
  };

  // Render an inline "Share to channel" affordance + a right-click
  // shortcut. Only commits + intents currently have payload shape; we
  // gate `canShare` on those to avoid offering it for other rows.
  const shareMenu = canShare && shareAnchor ? (
    activity.commitSha ? (
      <AuraRelayMenu
        repoRoot={repoRoot}
        kind="commit"
        payload={{
          sha: activity.commitSha,
          subject: activity.title || "(no subject)",
          author: msg.sender,
          ts: msg.ts,
        }}
        anchor={shareAnchor}
        onClose={() => setShareAnchor(null)}
      />
    ) : (
      <AuraRelayMenu
        repoRoot={repoRoot}
        kind="intent"
        payload={{
          ts: msg.ts,
          subject: activity.title || "(no subject)",
          agent_id: msg.sender,
          files: activity.files?.map((f) => f.path),
        }}
        anchor={shareAnchor}
        onClose={() => setShareAnchor(null)}
      />
    )
  ) : null;

  return (
    <div
      className="group my-0.5 mx-1 rounded px-2 py-1 cursor-pointer hover:bg-state-hover"
      onClick={() => setOpen((x) => !x)}
      onContextMenu={canShare ? openShare : undefined}
      title={open ? "Collapse" : canShare ? "Click to expand · right-click to share" : "Expand"}
    >
      <div className="flex items-baseline gap-1.5 leading-snug">
        <span className="text-xs text-text-3 font-medium truncate">
          {msg.sender}
        </span>
        <span className="section-label">
          {meta.label}
        </span>
        <span className="text-2xs text-text-5 ml-auto tabular-nums flex-shrink-0">
          {hhmm(msg.ts)}
        </span>
      </div>
      <div className={`text-sm text-text-2 ${open ? "" : "truncate"}`}>
        {activity.title || "(no title)"}
      </div>

      {activity.badges && activity.badges.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {activity.badges.map((b, i) => (
            <span
              key={`${b.label}-${i}`}
              // Only a failed/rejected badge earns colour — it's the one that
              // needs the reader. "ok"/"applied" is settled history, so it
              // reads on the neutral ramp like every other informational chip.
              className={`px-1.5 py-[1px] rounded text-2xs font-mono border ${
                b.tone === "warn"
                  ? "border-red/30 bg-red/10 text-red"
                  : "border-line-soft bg-bg-2 text-text-4"
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-2">
          {hasDetail ? (
            <div className="whitespace-pre-wrap break-words text-sm text-text-2 leading-snug bg-bg-1 border border-line-soft rounded px-2 py-1.5">
              {activity.detail}
            </div>
          ) : (
            // Single-line activity: show the full title in the same styled
            // block so expand always reveals SOMETHING.
            <div className="whitespace-pre-wrap break-words text-sm text-text-2 leading-snug bg-bg-1 border border-line-soft rounded px-2 py-1.5">
              {activity.title}
            </div>
          )}

          {hasFiles && (
            <div className="border border-line-soft rounded overflow-hidden">
              <div className="section-label px-2 py-1 bg-bg-1 border-b border-line-soft">
                {activity.files!.length} file
                {activity.files!.length === 1 ? "" : "s"}
              </div>
              <ul className="divide-y divide-line-soft">
                {activity.files!.map((f) => (
                  <li
                    key={f.path}
                    className="px-2 py-1 flex items-center gap-2 hover:bg-state-hover"
                  >
                    <button
                      type="button"
                      onClick={(e) => openFile(e, f.path)}
                      className="font-mono text-xs text-text-3 hover:text-accent hover:underline truncate flex-1 text-left"
                      title={f.path}
                    >
                      {f.path}
                    </button>
                    {f.status && (
                      <span className="section-label flex-shrink-0">
                        {f.status}
                      </span>
                    )}
                    {/* Line counts are a measurement, not an alarm — they read
                        on the neutral ramp. Green/red is reserved for the
                        worktree the user is actually standing in. */}
                    {(f.additions != null || f.deletions != null) && (
                      <span className="text-2xs font-mono tabular-nums text-text-3 flex-shrink-0">
                        {f.additions != null && <span>+{f.additions}</span>}
                        {f.additions != null && f.deletions != null && " "}
                        {f.deletions != null && <span>−{f.deletions}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canShowDiff && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={openDiff}
                className="text-xs"
              >
                Show diff
              </Button>
              {canShare && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={openShare}
                  className="text-xs"
                  title="Share this commit to a chat channel as a rich card"
                >
                  Share to channel…
                </Button>
              )}
            </div>
          )}
          {!canShowDiff && canShare && (
            <div className="flex">
              <Button
                variant="secondary"
                size="sm"
                onClick={openShare}
                className="text-xs"
                title="Share this entry to a chat channel as a rich card"
              >
                Share to channel…
              </Button>
            </div>
          )}
        </div>
      )}
      {shareMenu}
    </div>
  );
}

// The kind label is already a word — hue on top of it was decoration, not
// signal, so both kinds read on the neutral ramp and the text does the work.
function activityMeta(t: ActivityPayload["type"]): { label: string } {
  switch (t) {
    case "intent":
      return { label: "intent" };
    case "commit":
      return { label: "commit" };
  }
}
