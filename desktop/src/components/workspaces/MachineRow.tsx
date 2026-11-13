// One machine on the Machines page: its name, whose it is or what project it
// holds, and how long since it was used — or "Connect" when this laptop has no
// address for it yet. On the every-org list it also wears a chip naming the
// account it belongs to.

import { Badge } from "../ui/badge";
import { CloudGlyph } from "../ui/cloud-glyph";
import type { PlaceRow } from "../../lib/api";
import {
  addedByLine,
  isAsleep,
  ownerLine,
  placeOfRow,
  rowTooltip,
  sleepBadge,
  sleepTooltip,
} from "../../lib/place";
import { relativeAgeFromDelta } from "../../lib/relativeTime";

/** The repository's name out of its path on the box. */
function boxRepoName(repoPath: string): string {
  const p = repoPath.replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

export function MachineRow({
  row,
  nowMs,
  onOpen,
  tag,
}: {
  row: PlaceRow;
  nowMs: number;
  onOpen: () => void;
  /** Whose machine this is, on a list that mixes accounts. */
  tag?: { label: string; kind: string };
}) {
  const place = placeOfRow(row);
  const asleep = place && isAsleep(place) ? place : null;
  const age =
    row.last_used_at > 0
      ? relativeAgeFromDelta(Math.max(0, Math.floor(nowMs / 1000) - row.last_used_at), {
          style: "compact",
        })
      : "";
  // Owner and who added it are the difference between a box that is yours and
  // one your team shares — which decides what installing something on it does.
  const whose = `${ownerLine(row)} · ${addedByLine(row)}`;
  return (
    <button
      type="button"
      className="ui-home-row"
      onClick={onOpen}
      title={asleep ? `${rowTooltip(row)}\n${sleepTooltip(asleep, nowMs)}` : rowTooltip(row)}
    >
      <CloudGlyph size={14} />
      <span className="ui-home-title">
        {row.name}
        {row.machine?.box_kind === "shared" && " · Shared"}
        {asleep && ` · ${sleepBadge(asleep)}`}
      </span>
      {tag && (
        <Badge variant="outline" className="ui-machines-tag" data-kind={tag.kind} title={tag.label}>
          {tag.label}
        </Badge>
      )}
      <span className="ui-home-project" title={whose}>
        {row.machine?.repo_path ? boxRepoName(row.machine.repo_path) : whose}
      </span>
      <time>{row.may.connect ? "Connect" : age}</time>
    </button>
  );
}
