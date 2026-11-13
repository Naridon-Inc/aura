// "Who can use" — the list of who may open the org's machines, and the switch
// beside each name. One list, two homes: the Machines page raises it in a
// dialog, and Settings › Cloud computer shows it inline under the computer, so
// the person looking for "who can access my machine" finds it where the
// machine is.
//
// The org owns its machines. Owners and admins always get in and are the ones
// who make, connect and take machines away; everyone else needs a cloud seat,
// which an owner or admin hands out here. No seat, no machine. The switches are
// the server's existing seat grants (`/orgs/{slug}/cloud-access`), so what this
// shows is exactly who the server will let through — a member sees the same
// list with nothing to flip.

import { useCallback, useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { SettingsMemberRow } from "../ui/settings-team-members";
import { Avatar } from "../team/presentation/Avatar";
import { api, type CloudAccess, type CloudOrgMember } from "../../lib/api";
import {
  accessDetail,
  accessRows,
  mayManageAccess,
  seatLine,
  type AccessRow,
} from "../../lib/cloudAccess";
import { myRosterRole } from "../../lib/orgRosterPowers";
import { toast } from "../../lib/toast";
import "./machine-access.css";

type Loaded = {
  /** Signed in to the cloud at all. Signed out there is nobody to list. */
  connected: boolean;
  members: CloudOrgMember[];
  access: CloudAccess | null;
  myLogin: string | null;
  /** What the cloud calls the org you are working as. */
  orgName: string | null;
};

export type MachineAccess = {
  /** `null` until the first read lands. */
  loaded: Loaded | null;
  error: string | null;
  /** The member whose switch is being flipped. */
  busy: string | null;
  /** You are an owner or admin, so the switches are yours to flip. */
  manage: boolean;
  /** A personal account: an org of one, with nobody to hand a seat to. */
  alone: boolean;
  rows: AccessRow[];
  flip: (row: AccessRow, on: boolean) => Promise<void>;
};

/** Who may open the org's machines, read while `active`.
 *
 *  `roleHint` is your role as some other list read it; the roster's own answer
 *  wins once it is in. */
export function useMachineAccess(active: boolean, roleHint: string | null = null): MachineAccess {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    // Asked together: the roster is the slow one, and waiting on the sign-in
    // read first would put a second round trip in front of every open.
    const [status, members] = await Promise.all([
      api.cloudAuthStatus().catch(() => null),
      api.cloudOrgMembers().then(
        (list) => ({ list, why: null as string | null }),
        (e) => ({ list: [] as CloudOrgMember[], why: String(e) }),
      ),
    ]);
    if (status && !status.connected) {
      setLoaded({ connected: false, members: [], access: null, myLogin: null, orgName: null });
      return;
    }
    const orgName = status?.org_name?.trim() || status?.org_slug?.trim() || null;
    const myLogin = status?.user ?? null;
    if (members.why) {
      setError(members.why);
      setLoaded({ connected: true, members: [], access: null, myLogin, orgName });
      return;
    }
    // Seats are their own read: an org on a plan without shared machines
    // still has a roster worth showing, with every member simply off.
    const access = await api.cloudAccessList().catch((e) => {
      setError(String(e));
      return null;
    });
    setLoaded({ connected: true, members: members.list, access, myLogin, orgName });
  }, []);

  useEffect(() => {
    if (active) void load();
    else setLoaded(null);
  }, [active, load]);

  const myRole = (loaded && myRosterRole(loaded.members, loaded.myLogin)) ?? roleHint;
  const manage = mayManageAccess(myRole);
  const rows = loaded ? accessRows(loaded.members, loaded.access, myRole) : [];
  const alone = loaded !== null && loaded.members.length === 1;

  const flip = async (row: AccessRow, on: boolean) => {
    setBusy(row.userId);
    try {
      if (on) await api.cloudAccessGrant(row.login);
      else await api.cloudAccessRevoke(row.userId);
      const access = await api.cloudAccessList();
      setLoaded((prev) => (prev ? { ...prev, access } : prev));
      setError(null);
    } catch (e) {
      toast.danger(on ? `Couldn't give @${row.login} a seat` : `Couldn't take @${row.login}'s seat back`, String(e));
    } finally {
      setBusy(null);
    }
  };

  return { loaded, error, busy, manage, alone, rows, flip };
}

/** The seat count, any error, and a switch per person. */
export function MachineAccessList({ access }: { access: MachineAccess }) {
  const { loaded, error, busy, alone, rows, flip } = access;
  if (loaded === null) {
    return (
      <div className="ui-machine-access-wait">
        <AsciiSpinner />
      </div>
    );
  }
  return (
    <>
      {loaded.access && !alone && <p className="ui-machine-access-seats">{seatLine(loaded.access)}</p>}
      {error && <p className="ui-machine-access-error">{error}</p>}
      <div className="ui-machine-access-list" role="list" aria-label="Who can use these machines">
        {rows.map((row) => (
          <div role="listitem" key={row.userId}>
            <SettingsMemberRow
              avatar={<Avatar name={row.name} identity={row.login} src={row.avatar} size={26} title={row.name} />}
              name={row.login.toLowerCase() === loaded.myLogin?.toLowerCase() ? `${row.name} (you)` : row.name}
              detail={accessDetail(row)}
              control={
                <>
                  {busy === row.userId && <AsciiSpinner />}
                  <Switch
                    size="small"
                    checked={row.state !== "off"}
                    disabled={!row.canToggle || busy !== null}
                    onCheckedChange={(on) => void flip(row, on)}
                    aria-label={`${row.login} can use the team's machines`}
                  />
                </>
              }
            />
          </div>
        ))}
      </div>
    </>
  );
}
