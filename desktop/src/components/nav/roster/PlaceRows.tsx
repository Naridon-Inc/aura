// Workspaces that are not on this computer. A machine connected for a
// repository, and cloud work running on one, are the same kind of thing as a
// local checkout (somewhere with the repository in it and agents you can run),
// so they are the same row. What differs is which computer "there" is, which
// is what the cloud mark and the `user@host` tooltip say.

import { ContextMenu, ContextMenuTrigger } from "../../ui/context-menu";
import { SidebarItem } from "../../ui/sidebar";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { PickMark } from "../../places/ClubRail";
import { openRemoteWorkspace } from "../../../lib/editorStore";
import { cloudStatusLine, isCloudThreadLive, type CloudThread } from "../../../lib/cloudJobs";
import { isAsleep, placeRowLabel, sleepBadge, sleepTooltip, type Place } from "../../../lib/place";
import { remotePlace } from "../../../lib/placeRef";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { labelForAgentId } from "../../../lib/useLiveAgentSessions";
import { humanizeWorkspaceName } from "../../../lib/workspaceLabel";
import { RosterActionsMenu, RosterContextMenuContent } from "./rosterMenu";
import { placeMenu } from "./rosterMenus";
import type { RosterEnv } from "./rosterTypes";
import type { RosterPick } from "./useRosterPick";

/** Lit when you are inside it, held when it is open behind what you are
 *  looking at. Entering a box swaps every shell in the window, so the list
 *  has to say which one you are standing on. */
export function MachineRow({
  p,
  repoRoot,
  env,
  pick,
}: {
  p: Place;
  repoRoot?: string;
  env: RosterEnv;
  pick: RosterPick;
}) {
  // A place without an address is this laptop, which the list already draws
  // as local checkouts.
  const machineId = p.machineId;
  if (machineId === null) return null;

  const isActive = machineId === env.activeMachineId;
  const isHeld = !isActive && env.heldMachineIds.has(machineId);
  // The repository travels with the click: it is how a place that never
  // recorded one learns which repository it is a workspace of.
  const open = () => openRemoteWorkspace({ machineId, repoRoot });
  const age = relativeAgeFromSecs(p.lastUsedAt, {
    style: "compact",
    now: env.now,
    empty: "",
  });
  const { work, machine } = placeRowLabel(p);
  const at = `${p.identity.user}@${p.identity.host}`;
  // Stopped because nobody was using it. The row still opens (opening one is
  // what starts it again), but it has to say it is asleep.
  const asleep = isAsleep(p);
  const sleepNote = asleep ? sleepTooltip(p, env.now) : "";
  // Identical to what `open` hands over, so the row a pair holds, the row you
  // click and the row you pop out are one thing.
  const place = remotePlace({ machineId, repoRoot });
  const { picked, pickTitle, toggle } = pick.pickRow(place);
  const activate = () => (pick.picking ? toggle() : open());
  const entries = () =>
    placeMenu({ place, title: work, subtitle: at, openLabel: "Go to this machine" });
  const checkedOut = machine ? ` · ${work} is checked out there` : "";
  const title = pick.picking
    ? pickTitle
    : isActive
      ? `You are on ${p.name} · ${at}${checkedOut}`
      : isHeld
        ? `${p.name} is still open · ${at} · go back to it${checkedOut}`
        : `${sleepNote ? `${sleepNote}\n` : ""}${at} · open a workspace on this machine${checkedOut}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="ui-roster-row"
          data-held={isHeld || undefined}
          data-picked={picked || undefined}
          title={title}
        >
          <SidebarItem
            label={machine ? `${work} · ${machine}` : work}
            icon={pick.picking ? <PickMark on={picked} /> : <CloudGlyph size={14} />}
            selected={isActive && !env.pageUp}
            trailing={
              asleep ? (
                <span title={sleepNote}>{sleepBadge(p)}</span>
              ) : age ? (
                <span title={`You were last on this machine ${age} ago`}>{age}</span>
              ) : undefined
            }
            onClick={activate}
            actions={<RosterActionsMenu aria-label="Machine actions" entries={entries} />}
          />
        </div>
      </ContextMenuTrigger>
      <RosterContextMenuContent entries={entries} />
    </ContextMenu>
  );
}

/** Work running on a machine that isn't this one. Clicking it does what
 *  clicking a workspace does: it takes you there. `showRepository` names the
 *  repository on the row only when the row is not under that repository. */
export function CloudRow({
  thread,
  showRepository = false,
  env,
  pick,
}: {
  thread: CloudThread;
  showRepository?: boolean;
  env: RosterEnv;
  pick: RosterPick;
}) {
  const { label, tint } = cloudStatusLine(thread.latest, env.now);
  const live = isCloudThreadLive(thread, env.now);
  const sent = thread.latest.created_at ? Date.parse(thread.latest.created_at) : NaN;
  const age = Number.isNaN(sent)
    ? ""
    : relativeAgeFromSecs(Math.floor(sent / 1000), {
        style: "compact",
        now: env.now,
        empty: "",
      });
  const open = () =>
    openRemoteWorkspace({
      threadKey: thread.key,
      repoRoot: thread.repoRoot,
    });
  const isActive = thread.key === env.activeThreadKey;
  const isHeld = !isActive && env.heldThreadKeys.has(thread.key);
  const repoName = humanizeWorkspaceName(thread.repoRoot);
  // A conversation is a place too, one that hasn't resolved a box yet.
  const place = remotePlace({
    threadKey: thread.key,
    repoRoot: thread.repoRoot,
  });
  const { picked, pickTitle, toggle } = pick.pickRow(place);
  const activate = () => (pick.picking ? toggle() : open());
  const entries = () =>
    placeMenu({
      place,
      title: thread.title,
      subtitle: `${repoName} · ${label}`,
      openLabel: "Open the machine this runs on",
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="ui-roster-row"
          data-held={isHeld || undefined}
          data-picked={picked || undefined}
          title={
            pick.picking
              ? pickTitle
              : `${repoName} · ${label} · ${labelForAgentId(thread.latest.agent)} · open the machine this is running on`
          }
        >
          <SidebarItem
            label={showRepository ? `${thread.title} · ${repoName}` : thread.title}
            icon={
              pick.picking ? (
                <PickMark on={picked} />
              ) : (
                // It breathes only once a machine has actually claimed it.
                <CloudGlyph size={14} pulse={live && thread.latest.status !== "submitted"} />
              )
            }
            selected={isActive && !env.pageUp}
            trailing={
              <span className="ui-roster-trailing">
                <span style={{ color: tint }}>{label}</span>
                {age && <span title={`Sent ${age} ago`}>{age}</span>}
              </span>
            }
            onClick={activate}
            actions={<RosterActionsMenu aria-label="Cloud work actions" entries={entries} />}
          />
        </div>
      </ContextMenuTrigger>
      <RosterContextMenuContent entries={entries} />
    </ContextMenu>
  );
}
