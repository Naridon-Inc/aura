// Machines — the computers your work can run on besides this one: boxes you
// connected over SSH and the ones your team shares. Drawn as the same page as
// Home (40px toolbar, 44px rows) because a machine is chosen the way a
// workspace is: find it in a list, open it.
//
// Every row is a real `places_list` entry. Opening one goes to that machine's
// workspace; Connect adds one by its SSH address. Having Aura make a machine is
// offered only to the people the org lets do it, the same gate as before.
//
// Two views of the same machines. "In <org>" is the org you are working as —
// the list every other surface uses. "All my machines" is every account at
// once: personal, each team, this laptop — each row marked with whose it is.
// "Who can use" says which teammates may open the org's machines, and lets an
// owner or admin hand out seats.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Layers, Plus, Search, Sparkles, Users } from "lucide-react";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { WorkspacesPage } from "../ui/workspaces-page";
import { api, type AllPlaces, type PlaceGroup, type PlaceRoster, type PlaceRow } from "../../lib/api";
import { opensHere } from "../../lib/cloudAccess";
import { onOrgChanged, switchOrg } from "../../lib/cloudOrgs";
import { openRemoteWorkspace } from "../../lib/editorStore";
import { emptyLine, mayHaveOneMade, orgNotice } from "../../lib/place";
import { toast } from "../../lib/toast";
import { AddComputer } from "../commons/crew/AddComputer";
import { GetComputerWizard } from "../commons/crew/GetComputerWizard";
import { MakePlaceWizard } from "../commons/crew/MakePlaceWizard";
import { AllMachinesList } from "./AllMachinesList";
import { MachineAccessDialog } from "./MachineAccessDialog";
import { MachineRow } from "./MachineRow";

const UNREADABLE: PlaceRoster = {
  places: [],
  org: {
    status: "unreachable",
    detail: "This build couldn't read the machine list.",
    slug: null,
    name: null,
    my_role: null,
  },
};

const UNREADABLE_ALL: AllPlaces = {
  status: "unreachable",
  detail: "This build couldn't read the machine list.",
  groups: [],
};

type Scope = "org" | "all";

export function MachinesSurface({
  repoRoot,
  onClose,
  leading,
}: {
  /** The checkout a conversation opened on a machine belongs to. */
  repoRoot?: string;
  onClose: () => void;
  leading?: ReactNode;
}) {
  const [roster, setRoster] = useState<PlaceRoster | null>(null);
  const [all, setAll] = useState<AllPlaces | null>(null);
  const [scope, setScope] = useState<Scope>("org");
  const [query, setQuery] = useState("");
  const [making, setMaking] = useState(false);
  // Connect opens the one-line way to add a computer you have; getting one
  // from Aura and the older SSH way are reached from inside it.
  const [adding, setAdding] = useState<"add" | "aura" | null>(null);
  const [access, setAccess] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(
    () => api.placesList().then(setRoster).catch(() => setRoster(UNREADABLE)),
    [],
  );
  const loadAll = useCallback(
    () => api.placesListAll().then(setAll).catch(() => setAll(UNREADABLE_ALL)),
    [],
  );
  useEffect(() => {
    void load();
    return onOrgChanged(() => {
      void load();
      setAll(null);
    });
  }, [load]);
  // Every org is a round trip each, so it is asked only when somebody looks.
  useEffect(() => {
    if (scope === "all" && all === null) void loadAll();
  }, [scope, all, loadAll]);

  const places = roster?.places ?? [];
  const notice = roster ? orgNotice(roster.org) : null;
  const signedIn = roster?.org.status === "ok";
  const orgName = roster?.org.name ?? roster?.org.slug ?? null;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return places;
    return places.filter((r) =>
      `${r.name} ${r.machine?.repo_path ?? ""}`.toLowerCase().includes(q),
    );
  }, [places, query]);

  const connect = () => setAdding("add");
  const connectOverSsh = () => {
    setAdding(null);
    openRemoteWorkspace({ repoRoot });
  };
  const open = (row: PlaceRow) => openRemoteWorkspace({ machineId: row.machine?.id, repoRoot });
  // A machine of another account opens as that account: switch first, so the
  // workspace, its chats and its bill all land in the org that owns the box.
  const openFromAll = async (group: PlaceGroup, row: PlaceRow) => {
    if (!opensHere(group) && group.org.slug) {
      try {
        await switchOrg(group.org.slug);
      } catch (e) {
        toast.danger(`Couldn't switch to ${group.org.name ?? group.org.slug}`, String(e));
        return;
      }
    }
    open(row);
  };

  return (
    <WorkspacesPage label="Machines" onClose={onClose}>
      <section className="ui-workspace-home" aria-label="Machines">
        <div className="ui-home-toolbar">
          {leading}
          <div className="ui-home-search">
            <Search size={16} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search machines"
              placeholder="Search"
            />
          </div>
          <div className="ui-home-filters">
            {signedIn && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label="Whose machines">
                    <Layers />
                    {scope === "all" ? "All my machines" : `In ${orgName ?? "this team"}`}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuCheckboxItem
                    checked={scope === "org"}
                    onCheckedChange={() => setScope("org")}
                  >
                    In {orgName ?? "this team"}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={scope === "all"}
                    onCheckedChange={() => setScope("all")}
                  >
                    All my machines
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {signedIn && scope === "org" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAccess(true)}
                title="Which teammates may open this team's machines"
              >
                <Users />
                Who can use
              </Button>
            )}
            {scope === "org" && mayHaveOneMade(roster?.org.my_role) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMaking(true)}
                title="Aura makes the machine, keeps its key, and lets your team in"
              >
                <Sparkles />
                Have Aura make one
              </Button>
            )}
            <Button
              size="sm"
              onClick={connect}
              title="Connect a computer you have: paste one line on it."
            >
              <Plus />
              Connect
            </Button>
          </div>
        </div>
        <div className="ui-home-list" role="list" aria-label="Machines">
          {scope === "all" ? (
            <AllMachinesList all={all} query={query} nowMs={nowMs} onOpen={(g, r) => void openFromAll(g, r)} />
          ) : (
            <>
              {notice && (
                <div className="ui-home-row" role="note" data-tone="notice">
                  <span className="ui-home-title">{notice}</span>
                </div>
              )}
              {roster === null ? (
                <div className="ui-home-empty">
                  <AsciiSpinner />
                </div>
              ) : (
                rows.map((row) => (
                  <div role="listitem" key={row.id}>
                    <MachineRow row={row} nowMs={nowMs} onOpen={() => open(row)} />
                  </div>
                ))
              )}
              {roster !== null && !rows.length && (
                <div className="ui-home-empty">
                  {places.length ? "No machines found" : emptyLine(roster.org)}
                </div>
              )}
            </>
          )}
        </div>
      </section>
      {making && (
        <MakePlaceWizard
          places={places}
          onClose={() => setMaking(false)}
          onMade={() => void load()}
          onConnectInstead={() => {
            setMaking(false);
            connect();
          }}
        />
      )}
      {adding === "add" && (
        <AddComputer
          initial="own"
          onClose={() => setAdding(null)}
          onGetOne={() => setAdding("aura")}
          onSsh={connectOverSsh}
          onConnected={() => void load()}
        />
      )}
      {adding === "aura" && (
        <GetComputerWizard
          onClose={() => setAdding(null)}
          onReady={() => void load()}
          onConnectInstead={() => setAdding("add")}
        />
      )}
      <MachineAccessDialog
        open={access}
        onOpenChange={setAccess}
        orgName={orgName}
        myRole={roster?.org.my_role ?? null}
      />
    </WorkspacesPage>
  );
}
