// Side by side — the rail group, drawn.
//
// It sits between the people and the projects, in the same column and on the
// same ruler as both, because a club IS a place: the rail lists everywhere the
// window can stand, and "this project beside that machine" is one of those
// somewheres. Filing it anywhere else — a menu, a dialog, a page — would make
// the one arrangement you built the only place in the app you cannot get to
// from the list of places.
//
// No title bar. A club is not a wizard and this is not a surface; the rail's
// section caption ("Side by side") is the whole of the chrome it gets, exactly
// as "People" and "Projects" get above and below it.
//
// Three real states, not one, same as the People rail: we haven't been told
// yet (a club is mid-entry — its row spins), we tried and couldn't (the entry
// failed, and the row says why with a way to try again), and there is
// genuinely nothing.
//
// "Genuinely nothing" draws NOTHING. The group used to hold its place with a
// three-line pitch and a button, on the theory that hiding it would take the
// only door with it. That theory was wrong twice over: the second door is on
// the project row itself ("Put side by side…"), so nothing was ever locked
// away; and a permanent advert for a feature you are not using, sitting above
// the projects you are, costs every session to serve the rare one. A rail is a
// list of where you can stand. If you are standing nowhere side by side, the
// honest length of that list is zero.
//
// Takes everything it draws as props and reaches for nothing. `ClubRailMount`
// does the reaching.

import { AsciiSpinner } from "../ui/ascii-spinner";
import { CloudGlyph } from "../ui/cloud-glyph";
import { clubLabel, clubMembersLine, placeLabel, type ClubPick } from "../../lib/clubGesture";
import { isRemotePlace, placeKey } from "../../lib/placeRef";
import { MIN_CLUB_MEMBERS, type Club } from "../../lib/workspaceClubStore";

export type ClubRailProps = {
  /** Every club that exists, oldest first. */
  clubs: Club[];
  /** The one being viewed, or null while standing in a single place. */
  activeClubId: string | null;
  /** The club being assembled right now. */
  pick: ClubPick;
  /** The club whose entry is in flight — its row shows the loader. Entering
   *  can mean opening a project that isn't loaded yet, which is disk work and
   *  can take a moment; a row that looked inert for that moment is how "it
   *  didn't do anything" happens. */
  enteringId?: string | null;
  /** Why the last entry failed, and which club it was for. */
  error?: { clubId: string; message: string } | null;
  onBeginPick: () => void;
  onCancelPick: () => void;
  /** Turn the picked places into a club and go there. */
  onOpenPicked: () => void;
  /** Drop one place from the pick — the chip's ×. */
  onUnpick: (key: string) => void;
  onEnter: (clubId: string) => void;
  /** Step off the club that's up, back into a single place. */
  onLeave: () => void;
  onDissolve: (clubId: string) => void;
};

/** Two panes side by side — a club's mark, where a local copy wears a branch
 *  fork and a machine wears the cloud. Same optical stroke as the roster's
 *  glyphs (1.4 nominal at 16 viewBox, rendered 13px), so it reads as one of
 *  them rather than as a heavier neighbour. */
function SideBySideGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="1.7"
        y="3"
        width="5.6"
        height="10"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="8.7"
        y="3"
        width="5.6"
        height="10"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** The pick's checkbox, in the slot a row's identity glyph normally holds.
 *
 *  Exported because the rows being picked are the ROSTER's — a mark drawn one
 *  way in the bar and another way on the row it refers to is two marks for one
 *  state. */
export function PickMark({ on }: { on: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2.2"
        y="2.2"
        width="11.6"
        height="11.6"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill={on ? "currentColor" : "none"}
      />
      {on && (
        <path
          d="M5 8.2l2.1 2.1L11.2 6"
          stroke="var(--color-bg-0)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A plus, for the control that starts a pick. */
function PlusGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3.5v9M3.5 8h9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ClubRail({
  clubs,
  activeClubId,
  pick,
  enteringId = null,
  error = null,
  onBeginPick,
  onCancelPick,
  onOpenPicked,
  onUnpick,
  onEnter,
  onLeave,
  onDissolve,
}: ClubRailProps) {
  const enough = pick.places.length >= MIN_CLUB_MEMBERS;
  const short = MIN_CLUB_MEMBERS - pick.places.length;

  // Nothing side by side and nobody picking: the group is not here. It comes
  // back the moment either is true — the row menu's "Put side by side…" starts
  // a pick, which brings the bar up with it.
  if (clubs.length === 0 && !pick.picking) return null;

  return (
    <nav className="flex flex-col text-[13px]" aria-label="Side by side">
      <div className="ade-sec-h">
        Side by side
        <span className="right">
          <button
            type="button"
            className="projhead-btn"
            onClick={pick.picking ? onCancelPick : onBeginPick}
            title={
              pick.picking
                ? "Stop picking"
                : "Put two side by side. Pick any two rows below — copies of a project, or a machine"
            }
            aria-label={
              pick.picking ? "Stop picking" : "Put two side by side"
            }
          >
            <PlusGlyph />
          </button>
        </span>
      </div>

      {/* The bar the gesture speaks through: what it wants next, what you have
          chosen so far, and the one command that opens them. It replaces the
          empty line rather than stacking under it — while you are picking, the
          question is the picking. */}
      {pick.picking && (
        <div className="club-pick">
          <div className="club-pick-say">
            {enough
              ? "Open these together, or keep picking."
              : pick.places.length === 0
                ? "Click two rows below — a copy of a project, or a machine."
                : `Pick ${short} more row${short === 1 ? "" : "s"} below.`}
          </div>
          {pick.places.length > 0 && (
            <div className="club-pick-chips">
              {pick.places.map((p) => (
                <span className="club-chip" key={placeKey(p)}>
                  {isRemotePlace(p) && <CloudGlyph size={11} />}
                  <span className="club-chip-nm">{placeLabel(p)}</span>
                  <button
                    type="button"
                    onClick={() => onUnpick(placeKey(p))}
                    title={`Don't include ${placeLabel(p)}`}
                    aria-label={`Remove ${placeLabel(p)} from the pick`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="club-pick-go">
            <button
              type="button"
              className="club-open"
              disabled={!enough}
              onClick={onOpenPicked}
              title={
                enough
                  ? "Open the picked rows side by side"
                  : `A side-by-side needs ${MIN_CLUB_MEMBERS} rows`
              }
            >
              Open side by side
            </button>
            <button type="button" className="club-cancel" onClick={onCancelPick}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {clubs.map((club) => {
        const active = club.id === activeClubId;
        const entering = club.id === enteringId;
        const failed = error?.clubId === club.id ? error.message : null;
        const members = clubMembersLine(club);
        return (
          <div key={club.id}>
            <div
              role="button"
              tabIndex={0}
              className={`ade-wrow${active ? " active" : ""}`}
              onClick={() => (active ? onLeave() : onEnter(club.id))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (active) onLeave();
                  else onEnter(club.id);
                }
              }}
              title={
                active
                  ? `You are in ${members} · leave, and each place keeps its own tabs`
                  : `${members} · open them side by side`
              }
            >
              <span className="l1">
                <span className="wsa">
                  {entering ? (
                    <AsciiSpinner className="wsa-spin text-sm" />
                  ) : (
                    <SideBySideGlyph />
                  )}
                </span>
                <span className="name">{clubLabel(club)}</span>
                {/* Which places are in it, said as marks rather than as a
                    second line: one dot per member, filled for a machine.
                    The names are already on the row; this is the shape of
                    the arrangement at a glance. */}
                <span className="badges">
                  {club.members.map((m) => (
                    <span
                      key={placeKey(m)}
                      className={`club-dot${isRemotePlace(m) ? " remote" : ""}`}
                      aria-hidden
                    />
                  ))}
                </span>
                <button
                  type="button"
                  className="wrow-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDissolve(club.id);
                  }}
                  title="Break this side-by-side up. Each one keeps its own tabs"
                  aria-label="Break this side-by-side up"
                >
                  ×
                </button>
              </span>
            </div>
            {failed && (
              <div className="px-2 pb-1.5">
                <div className="text-2xs leading-[15px] text-red">
                  Couldn’t open {clubLabel(club)}.
                </div>
                <div className="mt-0.5 break-words text-2xs leading-[15px] text-text-4">
                  {failed}
                </div>
                <button
                  type="button"
                  className="club-start"
                  onClick={() => onEnter(club.id)}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
