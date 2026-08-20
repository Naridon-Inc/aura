// "Machines" — every place that isn't this one, in one list.
//
// The rest of this page answers "where is my work". This section answers the
// question underneath it: "where can I work". A machine you've connected is a
// workspace like any other — it has a shell, a project directory and whichever
// agents are installed on it — and the only thing that made it different was
// that nothing on this page ever offered it.
//
// It sits above the cloud list on purpose. Cloud rows are *jobs*, and a job is
// only ever visible after you've sent one; the machine is what you send them
// to, so a laptop with a connected box and no jobs yet had a remote workspace
// it could not reach from anywhere in the app. The connect row is always here
// for the same reason — the door has to exist before there's anything behind
// it.
//
// ── One list, two sources ──────────────────────────────────────────────────
//
// This drew the machine book alone: the `0600` address book on this laptop.
// Your org's places — the machines on its runner board — were a different
// screen entirely, so a member whose admin had given them a box saw nothing
// here at all until somebody told them in Slack, and a box you connected
// yourself looked exactly like one the whole team is on.
//
// `places_list` merges the two at READ time and every row says which it is:
// whose place it is, who added it, and what you may do with it. The book is not
// synced anywhere to make that work and is not loosened to make it readable —
// the merge happens in this process, and a row for a place you haven't
// connected carries no address at all, because we don't have one.

import { useCallback, useEffect, useState } from "react";

import { Server, Sparkles } from "lucide-react";

import { api, type PlaceRoster, type PlaceRow } from "../../lib/api";
import { onOrgChanged } from "../../lib/cloudOrgs";
import { openRemoteWorkspace } from "../../lib/editorStore";
import {
  addedByLine,
  emptyLine,
  isAsleep,
  mayHaveOneMade,
  orgNotice,
  ownerLine,
  placeOfRow,
  rowTooltip,
  sleepBadge,
  sleepTooltip,
} from "../../lib/place";
import { MakePlaceWizard } from "../commons/crew/MakePlaceWizard";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import { CloudGlyph } from "../ui/cloud-glyph";
import { Plus } from "../Icons";
import { relativeAgeFromDelta } from "../../lib/relativeTime";

export function WorkspacesMachinesSection({
  /** The checkout whose board a conversation on that machine would belong to.
   *  Carried through so entering from here can still answer a runner. */
  repoRoot,
  nowMs,
}: {
  repoRoot?: string;
  nowMs: number;
}) {
  // `null` is "we haven't asked yet", which is a third state and not an empty
  // list. Drawing them the same way is how a slow read reads as "you have no
  // machines" to somebody who has four.
  const [roster, setRoster] = useState<PlaceRoster | null>(null);
  // Whether the "have Aura make one" flow is up. Its own state rather than a
  // route, because it is a decision about this list and it closes back onto it.
  const [making, setMaking] = useState(false);

  const load = useCallback(
    () =>
      api
        .placesList()
        .then(setRoster)
        // `places_list` answers even when the cloud doesn't — the local half is
        // a file on this disk. A rejection here is the bridge itself failing,
        // which is not a state this section can describe, so it falls back to
        // an empty book and lets the connect row carry the page.
        .catch(() =>
          setRoster({
            places: [],
            org: {
              status: "unreachable",
              detail: "This build couldn't read the machine list.",
              slug: null,
              name: null,
              my_role: null,
            },
          }),
        ),
    [],
  );

  useEffect(() => {
    void load();
    // The book is filtered to the org you are acting as and the board is the
    // org's own, so switching org changes both halves of this list — the same
    // way it changes which jobs are on the board below.
    return onOrgChanged(() => void load());
  }, [load]);

  const places = roster?.places ?? [];
  const notice = roster ? orgNotice(roster.org) : null;
  // Read off the roster this section already loaded, so the door costs no extra
  // request. It is not the gate — the server decides at the moment the place is
  // written, and a member who got past this still meets a 403 — it is only
  // whether an offer nobody could take belongs on screen.
  const mayMake = mayHaveOneMade(roster?.org.my_role);

  return (
    <section>
      <div className="flex items-center gap-1.5 px-2 pb-1">
        <h3 className="text-xs font-medium text-text-4">Machines</h3>
        {roster !== null && places.length > 0 && (
          <span className="text-xs text-text-5 tabular-nums">
            {places.length}
          </span>
        )}
      </div>

      {/* Why half the list is missing, in the server's own words. Never in
          place of the rows: the boxes on this laptop are still reachable and
          still listed. */}
      {notice && <ErrorNote className="mx-2 mb-1.5">{notice}</ErrorNote>}

      {roster === null ? (
        <LoadingState label="Looking for your machines…" size="sm" />
      ) : (
        <div className="flex flex-col">
          {places.length === 0 ? (
            <EmptyState
              icon={Server}
              size="sm"
              title="No machines yet"
              body={emptyLine(roster.org)}
              className="py-6"
            />
          ) : (
            places.map((row) => (
              <MachineRow
                key={row.id}
                row={row}
                nowMs={nowMs}
                onOpen={() =>
                  openRemoteWorkspace({
                    // A row you may open always has a book entry behind it;
                    // one you may only connect has none, and the wizard is
                    // what turns the second into the first.
                    machineId: row.machine?.id,
                    repoRoot,
                  })
                }
              />
            ))
          )}
          <button
            type="button"
            onClick={() => openRemoteWorkspace({ repoRoot })}
            className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
            title="Connect a machine over SSH — its address is kept on this laptop, never its key"
          >
            <span className="flex-none">
              <Plus size={13} />
            </span>
            <span className="text-base">
              {places.length ? "Connect another machine" : "Connect a machine"}
            </span>
          </button>
          {/* The second door, and only for the people who can walk through it.
              A machine you already own and a machine Aura makes for you end up
              as the same kind of row in this list — what differs is who had to
              buy one. Shown under the first because it is the newer answer to a
              question the first has always been here to answer. */}
          {mayMake && (
            <button
              type="button"
              onClick={() => setMaking(true)}
              className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
              title="Aura makes the machine, keeps its key, and lets your team in"
            >
              <span className="flex-none">
                <Sparkles size={13} />
              </span>
              <span className="text-base">Have Aura make one</span>
            </button>
          )}
        </div>
      )}

      {making && (
        <MakePlaceWizard
          places={places}
          onClose={() => setMaking(false)}
          // The new place is on the org's board and — unless the book write
          // failed — in this laptop's book too, so the list behind the wizard is
          // stale the moment it exists. Reloaded while the wizard is still up,
          // so closing it lands on a list with the machine already in it.
          onMade={() => void load()}
          onConnectInstead={() => {
            setMaking(false);
            openRemoteWorkspace({ repoRoot });
          }}
        />
      )}
    </section>
  );
}

function MachineRow({
  row,
  nowMs,
  onOpen,
}: {
  row: PlaceRow;
  nowMs: number;
  onOpen: () => void;
}) {
  // Seconds, not milliseconds — the book stores unix seconds so it stays
  // readable by hand. A place you have never been has no age to show, and
  // "never" in that column would read as a machine that is out of use.
  const age =
    row.last_used_at > 0
      ? relativeAgeFromDelta(
          Math.max(0, Math.floor(nowMs / 1000) - row.last_used_at),
          { style: "compact" },
        )
      : "";

  // A stopped machine refuses connections the way a dead one does, so this is
  // the only thing on the row that can tell them apart — the book knows, and
  // nothing this list could reach for would. `null` for an org place with no
  // address here, which is not a place this laptop could have put to sleep.
  const place = placeOfRow(row);
  const asleep = place && isAsleep(place) ? place : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-9 w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-state-hover"
      title={
        asleep
          ? `${rowTooltip(row)}\n${sleepTooltip(asleep, nowMs)}`
          : rowTooltip(row)
      }
    >
      {/* Dimmed for a place with no address here: the row still opens, but
          what it opens is the wizard, not a shell. */}
      <span className={`mt-0.5 flex-none ${row.may.open ? "text-text-4" : "text-text-5"}`}>
        <CloudGlyph size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-base text-text-1">
            {row.name}
          </span>
          {/* Whose box it is decides what you may do on it, so it is on the row
              and not buried in the workspace you're about to open. */}
          {row.machine?.box_kind === "shared" && (
            <span className="flex-none text-xs text-text-5">Shared</span>
          )}
          {/* Deliberately the same quiet grey as "Shared" rather than a warning
              colour. Asleep is the machine working as intended and costing
              nothing; drawing it in the palette of a problem would send people
              to fix something that isn't broken. */}
          {asleep && (
            <span className="flex-none text-xs text-text-5">
              {sleepBadge(asleep)}
            </span>
          )}
        </span>
        {/* The two facts the merge exists to surface. A list of machine names
            cannot tell you that one of them is your team's and one is yours,
            and that is the difference that decides what happens when you
            install something on it. */}
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-5">
          <span className="truncate">{ownerLine(row)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{addedByLine(row)}</span>
        </span>
      </span>

      {/* Which project on that box, not which address.
          One runner holds clones of several repos and is one row per repo, so
          without this the same name appears twice with nothing to tell them
          apart — and the address, which used to sit here, differentiated
          nothing (it is identical on every row for one box) while putting a
          server IP on a screen people share. It is still in the row's tooltip,
          which is where you go when the machine itself is the question. */}
      {row.machine?.repo_path && (
        <span className="mt-0.5 flex-none max-w-[220px] truncate text-xs text-text-5">
          {boxProjectName(row.machine.repo_path)}
        </span>
      )}

      {/* What you may do, where the age would be. A place you can enter shows
          how long since you were on it; one you'd have to connect says so,
          because "—" in that column reads as a machine nobody has touched
          rather than one you have never had. */}
      <span className="mt-0.5 w-16 flex-none text-right text-xs tabular-nums text-text-4">
        {row.may.connect ? (
          <span className="text-accent">Connect</span>
        ) : (
          age
        )}
      </span>
    </button>
  );
}

/** The project's own name, out of its path ON THE BOX. Those are POSIX paths
 *  whatever this laptop is, so this doesn't go through a platform path module. */
function boxProjectName(repoPath: string): string {
  const p = repoPath.replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}
