// The workspace list while you stand on a machine: only that machine's
// workspaces, one section per repository, and nothing from this computer or
// the cloud. The place switcher in the account menu is the way back.

import type { CloudThread } from "../../../lib/cloudJobs";
import type { Place } from "../../../lib/place";
import { humanizeWorkspaceName } from "../../../lib/workspaceLabel";
import { SidebarItem } from "../../ui/sidebar";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { CloudRow, MachineRow } from "./PlaceRows";
import { RosterSection } from "./RosterSections";
import { FirstWorkspace } from "./SidebarFirstWorkspace";
import type { RosterSort } from "./rosterLayout";
import type { RosterEnv } from "./rosterTypes";
import type { RosterPick } from "./useRosterPick";

export type MachineSection = { key: string; root: string | null; places: Place[] };

/** A machine's workspaces, filed by repository: the ones filed under a
 *  repository on the list, then the machine's unfiled ones under its name. */
export function machineSections(
  machineId: string,
  placesByRoot: ReadonlyMap<string, readonly Place[]>,
  unplaced: readonly Place[],
): MachineSection[] {
  const out: MachineSection[] = [];
  for (const [root, places] of placesByRoot) {
    const here = places.filter((p) => p.machineId === machineId);
    if (here.length) out.push({ key: `:machine:${root}`, root, places: here });
  }
  const loose = unplaced.filter((p) => p.machineId === machineId);
  if (loose.length) out.push({ key: `:machine:${machineId}`, root: null, places: loose });
  return out;
}

/** The heading's "Filter by project" and "Sort by", applied to a machine's
 *  sections: one repository's section when the filter names one that is
 *  here (all of them otherwise, as on this computer), each section's
 *  workspaces newest-used or newest-added first. */
export function arrangeMachineSections(
  sections: readonly MachineSection[],
  sort: RosterSort,
  repoFilter: string | null,
): MachineSection[] {
  const kept =
    repoFilter && sections.some((s) => s.root === repoFilter)
      ? sections.filter((s) => s.root === repoFilter)
      : sections;
  const key = sort === "created" ? (p: Place) => p.addedAt : (p: Place) => p.lastUsedAt;
  return kept.map((s) => ({ ...s, places: [...s.places].sort((a, b) => key(b) - key(a)) }));
}

export function MachinePlaceRoster({
  machineId,
  loading,
  sections,
  threads,
  collapsed,
  onToggle,
  onCreate,
  env,
  pick,
}: {
  machineId: string;
  loading: boolean;
  /** From `machineSections`. */
  sections: readonly MachineSection[];
  /** Cloud conversations you came onto this machine through. */
  threads: readonly CloudThread[];
  collapsed: Readonly<Record<string, boolean>>;
  onToggle: (key: string) => void;
  onCreate: () => void;
  env: RosterEnv;
  pick: RosterPick;
}) {
  if (loading) {
    return (
      <div className="ui-roster-row">
        <SidebarItem label="Reading your machines…" icon={<AsciiSpinner size={13} />} />
      </div>
    );
  }
  if (sections.length === 0 && threads.length === 0) {
    return <FirstWorkspace onCreate={onCreate} />;
  }
  return (
    <>
      {sections.map(({ key, root, places }) => {
        const title = root
          ? env.custom[root]?.name || humanizeWorkspaceName(root)
          : places[0]?.name || machineId;
        return (
          <RosterSection
            key={key}
            kind="custom"
            title={title}
            count={places.length}
            collapsed={!!collapsed[key]}
            onToggle={() => onToggle(key)}
          >
            {places.map((p) => (
              <MachineRow
                key={`${p.machineId}:${p.project.path ?? p.name}`}
                p={p}
                repoRoot={root ?? undefined}
                env={env}
                pick={pick}
              />
            ))}
          </RosterSection>
        );
      })}
      {threads.map((t) => (
        <CloudRow key={t.key} thread={t} showRepository env={env} pick={pick} />
      ))}
    </>
  );
}
