// One checkout, one line.
//
// The row is deliberately almost colourless. A board with forty rows can only
// be scanned if the ink is uniform, so branch, counts and age all sit on the
// neutral text ramp — added/removed included, which are numbers, not alarms.
// Colour is spent in exactly two places, and both mean "look here now":
// a live agent's dot, and a cross-checkout collision. Everything else earns
// attention through position and weight instead.

import type { CSSProperties } from "react";

import { RepoAvatar } from "../../RepoAvatar";
import * as Icons from "../../Icons";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { compactCount, shortAge, type WorkspaceRowData } from "./model";

type Props = {
  row: WorkspaceRowData;
  /** Repository root — what the avatar identifies the project by. */
  repoRoot: string;
  badge?: WorktreeBadge;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onMessage: () => void;
};

/** Branch-fork glyph, the row's leading mark. Filled when an agent is live in
 *  this checkout, hollow when nobody is — the same "is anyone home" signal the
 *  dot carries, readable in one glance down the column. */
function ForkGlyph({ live }: { live: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ color: live ? "var(--color-text-2)" : "var(--color-text-4)" }}
    >
      <circle cx="4.5" cy="3.5" r="1.9" stroke="currentColor" strokeWidth="1.3" fill={live ? "currentColor" : "none"} />
      <circle cx="11.5" cy="3.5" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.4v5.2M11.5 5.4v1.1a2.5 2.5 0 0 1-2.5 2.5H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const chip: CSSProperties = {
  fontSize: 10.5,
  lineHeight: "14px",
  letterSpacing: "0.01em",
  color: "var(--color-text-4)",
  whiteSpace: "nowrap",
};

export function WorkspaceRow({
  row,
  repoRoot,
  badge,
  now,
  selected,
  onOpen,
  onMessage,
}: Props) {
  const { card } = row;
  const live = row.liveAgents.length > 0;
  const collision = row.collisions[0];

  return (
    <div
      className="group flex flex-col gap-0.5 rounded-sm px-2 py-[7px] transition-colors"
      style={{ background: selected ? "var(--color-bg-2)" : "transparent" }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--color-bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          title={card.path}
        >
          <ForkGlyph live={live} />

          <RepoAvatar
            repoRoot={repoRoot}
            size={15}
            fallback={
              <span
                className="grid h-[15px] w-[15px] place-items-center rounded-[3px] text-[9px] font-medium"
                style={{ background: "var(--color-bg-3)", color: "var(--color-text-3)" }}
              >
                {(card.branch ?? card.token).charAt(0).toUpperCase()}
              </span>
            }
          />

          <span
            className="truncate text-[12.5px]"
            style={{ color: selected ? "var(--color-text-1)" : "var(--color-text-2)" }}
          >
            {row.title}
          </span>

          {card.is_here && (
            <span
              className="shrink-0 rounded-[3px] px-1 py-px text-[9.5px] font-medium uppercase tracking-wide"
              style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
            >
              here
            </span>
          )}
          {card.missing && (
            <span style={{ ...chip, color: "var(--color-text-5)" }}>folder gone</span>
          )}
        </button>

        {/* Who is standing in it. The dot is the only always-coloured mark on
            the row, because "an agent is running here right now" is the one
            thing worth interrupting a scan for. */}
        {row.liveAgents.length > 0 && (
          <span className="flex shrink-0 items-center gap-1.5" style={chip}>
            <span
              className="h-[5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-green)" }}
              aria-hidden
            />
            {row.liveAgents.length === 1
              ? row.liveAgents[0].agent_id
              : `${row.liveAgents.length} agents`}
          </span>
        )}

        {card.inbox > 0 && (
          <button
            type="button"
            onClick={onMessage}
            style={{ ...chip, color: "var(--color-text-3)" }}
            className="shrink-0 underline-offset-2 hover:underline"
            title="Unread messages sent to this copy from another one"
          >
            {card.inbox} unread
          </button>
        )}

        {/* Drift from trunk and uncommitted work — mono so the digits line up
            column-to-column down a long list. */}
        <span className="shrink-0 font-mono tabular-nums" style={chip}>
          {card.dirty_files > 0 && <span>{card.dirty_files} uncommitted</span>}
          {card.dirty_files > 0 && (card.ahead > 0 || card.behind > 0) && <span> · </span>}
          {card.ahead > 0 && <span>{card.ahead} ahead</span>}
          {card.ahead > 0 && card.behind > 0 && <span> </span>}
          {card.behind > 0 && <span>{card.behind} behind</span>}
        </span>

        {/* Added / removed.
            Plain text on every row but one: green-and-red down a whole list
            turns the board into a traffic light and drowns the two signals
            that genuinely need colour. The copy you are standing in is the
            exception — that diff is *your* uncommitted work, you are about to
            act on it, and there is only ever one such row on screen, so the
            colour costs nothing and reads instantly. */}
        {badge && (badge.added > 0 || badge.removed > 0) && (
          <span className="flex shrink-0 gap-1 font-mono tabular-nums" style={chip}>
            {badge.added > 0 && (
              <span style={{ color: selected ? "var(--color-accent-green)" : "var(--color-text-3)" }}>
                +{compactCount(badge.added)}
              </span>
            )}
            {badge.removed > 0 && (
              <span style={{ color: selected ? "var(--color-red)" : "var(--color-text-3)" }}>
                −{compactCount(badge.removed)}
              </span>
            )}
          </span>
        )}

        <span
          className="w-[30px] shrink-0 text-right font-mono tabular-nums"
          style={{ ...chip, color: "var(--color-text-4)" }}
        >
          {shortAge(row.activityAt, now)}
        </span>

        <button
          type="button"
          onClick={onMessage}
          aria-label={`Message ${row.token}`}
          title={`Message ${row.token}`}
          className="shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--color-text-4)" }}
        >
          <Icons.Users size={12} />
        </button>
      </div>

      {/* The one thing no other tool can tell you: this copy and another one
          are holding the same function, so whoever pushes second will find
          their change unpickable from the other's. Worth its own line. */}
      {collision && (
        <div
          className="flex items-center gap-1.5 pl-[26px] text-[10.5px]"
          style={{ color: "var(--color-red)" }}
        >
          <Icons.Impacts size={11} />
          <span className="truncate">
            {collision.function} in {collision.file.split("/").pop()} is also held in{" "}
            {collision.holders
              .filter((h) => h.worktree !== row.token)
              .map((h) => h.worktree)
              .join(", ")}
            {row.collisions.length > 1 && ` · +${row.collisions.length - 1} more`}
          </span>
        </div>
      )}
    </div>
  );
}
