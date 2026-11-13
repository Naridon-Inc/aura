// Every machine you have, across every account you belong to: your personal
// account, each team, and the boxes only this laptop knows. One heading per
// account, and a chip on each row saying whose it is — so a client's box and
// your own never read as the same kind of thing. Data, billing and access stay
// with each org; only the view is shared.

import type { AllPlaces, PlaceGroup, PlaceRow } from "../../lib/api";
import { groupHeading, groupTag } from "../../lib/cloudAccess";
import { orgNotice } from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { MachineRow } from "./MachineRow";
import "./machine-access.css";

export function AllMachinesList({
  all,
  query,
  nowMs,
  onOpen,
}: {
  all: AllPlaces | null;
  query: string;
  nowMs: number;
  onOpen: (group: PlaceGroup, row: PlaceRow) => void;
}) {
  if (all === null) {
    return (
      <div className="ui-home-empty">
        <AsciiSpinner />
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const groups = all.groups
    .map((g) => ({
      ...g,
      places: q
        ? g.places.filter((r) => `${r.name} ${r.machine?.repo_path ?? ""}`.toLowerCase().includes(q))
        : g.places,
    }))
    // An account with nothing in it still gets its heading when nothing is
    // being searched — "Naridon has no machines" is an answer.
    .filter((g) => !q || g.places.length);
  const total = groups.reduce((n, g) => n + g.places.length, 0);
  return (
    <>
      {all.status !== "ok" && (
        <div className="ui-home-row" role="note" data-tone="notice">
          <span className="ui-home-title">
            {all.status === "signed_out"
              ? "Sign in to see the machines your teams have."
              : `Couldn't ask which teams you're in: ${all.detail}`}
          </span>
        </div>
      )}
      {groups.map((g) => {
        const tag = { label: groupTag(g), kind: g.kind };
        const notice = g.kind === "laptop" ? null : orgNotice(g.org);
        return (
          <div role="group" aria-label={groupHeading(g)} key={`${g.kind}:${g.org.slug ?? ""}`}>
            <div className="ui-machines-group">
              <span>{groupHeading(g)}</span>
              {g.current && <small>Working as</small>}
            </div>
            {notice && (
              <div className="ui-home-row" role="note" data-tone="notice">
                <span className="ui-home-title">{notice}</span>
              </div>
            )}
            {g.places.map((row) => (
              <div role="listitem" key={`${g.org.slug ?? "laptop"}:${row.id}`}>
                <MachineRow row={row} nowMs={nowMs} tag={tag} onOpen={() => onOpen(g, row)} />
              </div>
            ))}
            {!g.places.length && !notice && (
              <div className="ui-home-row" data-tone="empty">
                <span className="ui-home-title">No machines yet</span>
              </div>
            )}
          </div>
        );
      })}
      {q && !total && <div className="ui-home-empty">No machines found</div>}
    </>
  );
}
