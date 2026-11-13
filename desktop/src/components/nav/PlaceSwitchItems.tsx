// The places you can be in, as the account menu lists them: this computer,
// the organization's cloud, and each machine connected to it. The check marks
// where you are standing; picking another goes there (lib/placeScope), and the
// workspace list beside it then shows that place's workspaces only.

import { useEffect, useMemo, useState } from "react";
import { Check, Monitor } from "lucide-react";
import { api, type Machine } from "../../lib/api";
import { useEnteredMachines } from "../../lib/activeMachine";
import { orgLabel, useCloudOrgs } from "../../lib/cloudOrgs";
import { placesOfMachines } from "../../lib/place";
import { CLOUD_SCOPE, LOCAL_SCOPE, goToPlace, usePlaceScope } from "../../lib/placeScope";
import { CloudGlyph } from "../ui/cloud-glyph";
import { CloudOrganizationGlyph } from "../ui/cloud-workspace";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";

/** One row per machine in the book, however many folders it holds. */
export type MachinePlaceEntry = { machineId: string; name: string; at: string };

export function machinePlaceEntries(machines: readonly Machine[]): MachinePlaceEntry[] {
  const seen = new Map<string, MachinePlaceEntry>();
  for (const p of placesOfMachines(machines)) {
    if (!p.machineId || seen.has(p.machineId)) continue;
    seen.set(p.machineId, {
      machineId: p.machineId,
      name: p.name,
      at: `${p.identity.user}@${p.identity.host}`,
    });
  }
  return [...seen.values()];
}

/** The machine book, read while the menu is open. A book that won't read
 *  lists no machines; the repository menu still offers "Connect a machine…". */
function useMenuMachines(active: boolean): MachinePlaceEntry[] {
  const [machines, setMachines] = useState<Machine[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .machinesList()
      .then((ms) => {
        if (alive) setMachines(ms);
      })
      .catch(() => {
        if (alive) setMachines([]);
      });
    return () => {
      alive = false;
    };
  }, [active]);
  return useMemo(() => machinePlaceEntries(machines), [machines]);
}

export function PlaceSwitchItems({ active, connected }: { active: boolean; connected: boolean }) {
  const scope = usePlaceScope();
  const { orgs } = useCloudOrgs(active && connected);
  const current = orgs.find((org) => org.current);
  const machines = useMenuMachines(active);
  const held = useEnteredMachines();
  const heldIds = new Set(held.map((m) => m.machineId).filter(Boolean));
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => goToPlace(LOCAL_SCOPE)}>
        <Monitor />
        My workspace
        <span className="ml-auto opacity-70">Local</span>
        {scope.kind === "local" && <Check />}
      </DropdownMenuItem>
      {connected && (
        <DropdownMenuItem onSelect={() => goToPlace(CLOUD_SCOPE)}>
          <CloudOrganizationGlyph size={16} />
          <span className="truncate">{current ? orgLabel(current) : "Your organization"}</span>
          <span className="ml-auto opacity-70">Cloud</span>
          {scope.kind === "cloud" && <Check />}
        </DropdownMenuItem>
      )}
      {machines.map((m) => {
        const here = scope.kind === "machine" && scope.machineId === m.machineId;
        return (
          <DropdownMenuItem
            key={m.machineId}
            title={m.at}
            onSelect={() => goToPlace({ kind: "machine", machineId: m.machineId })}
          >
            <CloudGlyph size={16} />
            <span className="truncate">{m.name}</span>
            <span className="ml-auto opacity-70">
              {!here && heldIds.has(m.machineId) ? "Open" : "Machine"}
            </span>
            {here && <Check />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
