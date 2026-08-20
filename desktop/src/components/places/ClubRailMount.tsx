// The side-by-side rail, wired to the window.
//
// `ClubRail` draws and reaches for nothing. This is the reaching: the two club
// stores on one side (which clubs exist, which places are picked) and the
// window's own two moves on the other (stand in a club, step off it), which
// only App can make because they park live state and may have to open a
// project first.
//
// The order of the entry matters and is the reason this file exists at all.
// The store is told "you are in this club" only AFTER the window actually got
// there: entering can mean loading a project off disk, that can fail, and a
// row lit over a screen that never changed is the failure mode the loading and
// error states below exist to prevent.

import { useCallback, useState } from "react";

import { ClubRail } from "./ClubRail";
import {
  beginClubPick,
  cancelClubPick,
  enterClubFromRail,
  openPickedClub,
  toggleClubPick,
} from "../../lib/clubGesture";
import { placeKey } from "../../lib/placeRef";
import { useClubPick, useClubs } from "../../lib/useClubGesture";
import { dissolveClub } from "../../lib/workspaceClubStore";

export type ClubRailMountProps = {
  /** Take the window into this club: park whatever it is standing in, stand in
   *  the club's own place, union its members' tabs. Async — a member project
   *  that isn't open yet has to be loaded first. Throwing is how it says the
   *  entry didn't happen; the row shows the reason and offers another go. */
  onEnter: (clubId: string) => void | Promise<void>;
  /** Step off the club, back into a single place. Each member keeps its own
   *  live state — see editorStore's `exitClub`. */
  onLeave: () => void;
};

export function ClubRailMount({ onEnter, onLeave }: ClubRailMountProps) {
  const pick = useClubPick();
  const { clubs, activeClubId } = useClubs();
  const [entering, setEntering] = useState<string | null>(null);
  const [error, setError] = useState<{ clubId: string; message: string } | null>(
    null,
  );

  const enter = useCallback(
    async (clubId: string) => {
      setError(null);
      setEntering(clubId);
      try {
        await onEnter(clubId);
        // The window is there now, so the store can say so — which lights the
        // row, unlights whichever project row was lit, and puts the pick away.
        enterClubFromRail(clubId);
      } catch (e) {
        setError({
          clubId,
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setEntering(null);
      }
    },
    [onEnter],
  );

  const openPicked = useCallback(() => {
    // Null means fewer than two distinct places — the bar stays up and keeps
    // asking, which is the whole of the "not yet" state.
    const club = openPickedClub();
    if (club) void enter(club.id);
  }, [enter]);

  const dissolve = useCallback(
    (clubId: string) => {
      // Leave first when it is the one on screen: dropping the club out from
      // under the window would leave the editor standing in a place that no
      // longer exists, holding tabs with nowhere to be parked.
      if (clubId === activeClubId) onLeave();
      dissolveClub(clubId);
    },
    [activeClubId, onLeave],
  );

  return (
    <ClubRail
      clubs={clubs}
      activeClubId={activeClubId}
      pick={pick}
      enteringId={entering}
      error={error}
      onBeginPick={() => beginClubPick()}
      onCancelPick={cancelClubPick}
      onOpenPicked={openPicked}
      onUnpick={(key) => {
        // A chip carries the key; the toggle takes the ref that key came
        // from, so what gets dropped is the place actually held in the pick
        // rather than a second one built from a string.
        const held = pick.places.find((p) => placeKey(p) === key);
        if (held) toggleClubPick(held);
      }}
      onEnter={(clubId) => void enter(clubId)}
      onLeave={onLeave}
      onDissolve={dissolve}
    />
  );
}
