// One checkout, one line.
//
// The row is deliberately almost colourless. A board with forty rows can only
// be scanned if the ink is uniform, so branch, counts and age all sit on the
// neutral text ramp — added/removed included, which are numbers, not alarms.
// Colour is spent in exactly two places, and both mean "look here now":
// a live agent's dot, and a cross-checkout collision. Everything else earns
// attention through position and weight instead.

import type { CSSProperties } from "react";

import * as Icons from "../../Icons";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { labelForAgentId } from "../../../lib/useLiveAgentSessions";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { shortAge, type WorkspaceRowData } from "./model";
import { compactNumber } from "../../../lib/compactNumber";

type Props = {
  row: WorkspaceRowData;
  badge?: WorktreeBadge;
  now: number;
  selected: boolean;
  /** The branch this copy's ahead/behind counts are measured against. Named on
   *  the row itself so the list needs no caption explaining what "behind"
   *  means — see `describeDrift`. */
  trunk: string;
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

/** What this copy is carrying, said in the words the rest of the app uses.
 *
 *  This read `59 uncommitted · 21 ahead 397 behind`, set in a monospace face.
 *  Three problems, all of them in one 40-character string:
 *
 *  "uncommitted", "ahead" and "behind" are git's words for three ideas the app
 *  already has plain names for — the board one tab away calls the first lane
 *  "Unsaved changes", and this product exists so that someone who has never
 *  run `git status` can read what their agents did.
 *
 *  "ahead" and "behind" are also meaningless without saying what of. The page
 *  answered that with a caption above the list — "measured against main" —
 *  which is a whole band of chrome spent explaining a word that could simply
 *  have carried its own reference point. Now it does, and the caption is gone.
 *
 *  And the monospace was doing nothing. Its comment claimed the digits lined
 *  up column-to-column, but these strings are right-aligned and every one of
 *  them is a different length ("3 unsaved" against "1 unsaved · 143 behind"),
 *  so nothing has ever lined up. `tabular-nums` gives the only alignment that
 *  was real, and the row rejoins the typeface the list beside it is set in. */
function describeDrift(
  dirty: number,
  ahead: number,
  behind: number,
  trunk: string,
): { parts: string[]; tip: string } {
  // An empty trunk means the plane hasn't finished reading; name the idea
  // rather than printing "ahead of ".
  const base = trunk || "the main line";
  const parts: string[] = [];
  const tip: string[] = [];
  if (dirty > 0) {
    parts.push(`${dirty} unsaved`);
    tip.push(
      `${dirty} ${dirty === 1 ? "file has" : "files have"} changes that haven't been saved to this copy's history yet.`,
    );
  }
  if (ahead > 0) {
    parts.push(`${ahead} ahead of ${base}`);
    tip.push(
      `${ahead} saved ${ahead === 1 ? "change" : "changes"} here that ${base} doesn't have yet.`,
    );
  }
  if (behind > 0) {
    parts.push(`${behind} behind`);
    tip.push(
      `${behind} ${behind === 1 ? "change" : "changes"} on ${base} that this copy hasn't taken yet.`,
    );
  }
  return { parts, tip: tip.join("\n") };
}

export function WorkspaceRow({
  row,
  badge,
  now,
  selected,
  trunk,
  onOpen,
  onMessage,
}: Props) {
  const { card } = row;
  const live = row.liveAgents.length > 0;
  const collision = row.collisions[0];
  const drift = describeDrift(card.dirty_files, card.ahead, card.behind, trunk);

  return (
    <div
      // The app has one wash for "this is the row you are on" and one for
      // hover; this row was painting its own pair by hand, in two greys that
      // belong to neither ladder.
      className={`group flex flex-col gap-0.5 rounded-sm px-2 py-[7px] transition-colors ${
        selected ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          // The row shows the branch read aloud, so the slug itself lives
          // here with the path — the two things you'd copy, not read.
          title={card.branch ? `${card.branch}\n${card.path}` : card.path}
        >
          {/* The one leading mark. This list is a single repository's
              checkouts, so the project avatar beside it was the same 15px
              square repeated down forty rows — a column that never varied
              telling you which project you were already in. */}
          <ForkGlyph live={live} />

          <span
            className="truncate text-base"
            style={{ color: selected ? "var(--color-text-1)" : "var(--color-text-2)" }}
          >
            {row.title}
          </span>

          {/* The row is already washed as the selected one; the word is what
              says *why* it's selected, so it stays — as a word, not as a
              filled ALL-CAPS pill on top of a fill that already means this. */}
          {card.is_here && (
            <span className="shrink-0 text-xs font-medium text-accent">
              You&rsquo;re here
            </span>
          )}
          {card.missing && (
            <span style={{ ...chip, color: "var(--color-text-5)" }}>folder gone</span>
          )}
        </button>

        {/* Running somewhere that isn't this disk. Every other mark on this
            row is read out of the local checkout, so a copy a runner is
            mid-turn on looks exactly like one nobody has touched: no live
            dot, no diff, an old timestamp. This is the only thing on the row
            that can say otherwise, which is why it sits ahead of the agent
            dot rather than after the counts.

            Still while the job is queued. `submitted` means no machine has
            claimed it, and a breathing glyph there would say a box is working
            when none is. */}
        {badge?.cloud && (
          <span
            className="flex shrink-0 items-center"
            style={{ color: "var(--color-text-4)" }}
            title={
              badge.cloud.status === "submitted"
                ? `Queued for a machine. ${labelForAgentId(badge.cloud.agent)} hasn't started yet`
                : `Running on your machine in the cloud. ${labelForAgentId(badge.cloud.agent)}`
            }
          >
            <CloudGlyph size={13} pulse={badge.cloud.status !== "submitted"} />
          </span>
        )}

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

        {/* What this copy is carrying, against the main line — see
            `describeDrift` for why it no longer speaks git. */}
        {drift.parts.length > 0 && (
          <span className="shrink-0 tabular-nums" style={chip} title={drift.tip}>
            {drift.parts.join(" · ")}
          </span>
        )}

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
                +{compactNumber(badge.added)}
              </span>
            )}
            {badge.removed > 0 && (
              <span style={{ color: selected ? "var(--color-red)" : "var(--color-text-3)" }}>
                −{compactNumber(badge.removed)}
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
          className="flex items-center gap-1.5 pl-[26px] text-xs"
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
