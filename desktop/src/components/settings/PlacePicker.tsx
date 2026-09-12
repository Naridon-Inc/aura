// "Which machine?" — the picker the place-scoped settings panes share.
//
// A project has one place that is always there (this computer) and any number
// of cloud machines connected to it. Both panes under Machines ask a question
// about one place at a time, so they share this one control and this one way
// of finding the list: the machine book, filtered to boxes that carry this
// project. The local place is always first and is the default.

import { useEffect, useMemo, useState } from "react";
import { api, type Machine } from "../../lib/api";
import { placeHere, placeOfMachine, type Place } from "../../lib/place/contract";
import { SelectField } from "./kit";

const HERE = "__here__";

/** The places this project can be worked on, this computer first. Machines the
 *  book cannot list (no book yet, or a failed read) leave just this computer,
 *  which is a real answer and not an error the pane needs to show. */
export function useProjectPlaces(repoRoot: string): Place[] {
  const [machines, setMachines] = useState<Machine[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .machinesList()
      .then((rows) => {
        if (alive) setMachines(rows);
      })
      .catch(() => {
        if (alive) setMachines([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return useMemo(
    () => [
      placeHere(repoRoot),
      ...machines
        .filter((m) => m.project_root === repoRoot)
        .map((m) => placeOfMachine(m)),
    ],
    [repoRoot, machines],
  );
}

export function PlacePicker({
  places,
  value,
  onChange,
  disabled,
}: {
  places: Place[];
  value: Place;
  onChange: (place: Place) => void;
  disabled?: boolean;
}) {
  const options = places.map((p) => ({
    value: p.machineId ?? HERE,
    label: p.name,
  }));
  return (
    <SelectField
      value={value.machineId ?? HERE}
      onChange={(v) => {
        const next = places.find((p) => (p.machineId ?? HERE) === v);
        if (next) onChange(next);
      }}
      options={options}
      disabled={disabled || places.length <= 1}
      widthClass="min-w-[200px]"
    />
  );
}
