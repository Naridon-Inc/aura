// The two lists under a change's summary: "Previous was this" over the old
// side of the diff and "New is this" over the new side. Each piece leads with
// its real-world meaning — a non-engineer can't read `pub struct AgentRef` —
// and keeps the raw identifier and kind on a quiet mechanism line, with the
// full signature tucked into its hover.

import type { AtlasHoverEntry, ChangedSymbol } from "../../../lib/api";
import { lookupEntry, type AtlasIndex } from "../../../lib/atlasHover";
import { Button } from "../../ui/button";
import { changeMark, changeWord, pieceLine, pieceTitle, prettyKind } from "./changeWords";

export type ChangeSideName = "previous" | "next";

type PieceProps = {
  s: ChangedSymbol;
  /** Show the raw signature in the mechanism line's hover. Only the new side
   *  does: a modified piece's recorded signature is its NEW shape. */
  showSignature: boolean;
  entry: AtlasHoverEntry | undefined;
  side: ChangeSideName;
  relFile: string;
  /** The model-written line for THIS piece on THIS side — what it does now on
   *  the new side, what it used to do on the old one. The most specific meaning
   *  there is, so it wins; it arrives after the first paint and upgrades the
   *  piece in place. */
  symbolMeaning?: string;
  /** The file-level generated line for this side, used only when this is the
   *  single changed piece — then the file's story IS this piece's story. */
  meaningOverride?: string;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
  /** This piece is the one highlighted in the diff below. */
  selected?: boolean;
  /** Show this piece in the code below; clicking it again clears that. Absent
   *  on a surface with no diff underneath. */
  onSelect?: () => void;
};

/** One changed piece, meaning first. */
function ChangePiece({
  s,
  showSignature,
  entry,
  side,
  relFile,
  symbolMeaning,
  meaningOverride,
  onBringBack,
  busySymbol,
  selected,
  onSelect,
}: PieceProps) {
  const title = pieceTitle(s, entry);
  const meaning = pieceLine(s, symbolMeaning, meaningOverride, entry);
  const why = s.rationale?.trim() || "";
  // A modified piece has an earlier version to restore (offered on the new
  // side); a removed one can be brought back (offered on the old side). An
  // added piece has nothing to go back to.
  const canBringBack =
    !!onBringBack &&
    ((side === "next" && s.change === "modified") ||
      (side === "previous" && s.change === "deleted"));
  const busy = busySymbol === s.identifier;

  const body = (
    <>
      <span className="ui-change-piece-head">
        <strong>{title}</strong>
        <small>{changeWord(s.change)}</small>
      </span>
      <span className="ui-change-piece-line">{meaning}</span>
      {why ? (
        <span className="ui-change-piece-line">
          <span className="ui-change-note-label">Why: </span>
          {why}
        </span>
      ) : null}
      <code title={showSignature && s.signature ? s.signature : undefined}>
        {s.identifier}
        <small>{prettyKind(s.kind)}</small>
      </code>
    </>
  );

  return (
    <li className="ui-change-piece">
      <span className="ui-changes-status" data-status={s.change} aria-hidden>
        {changeMark(s.change)}
      </span>
      <div className="ui-change-piece-main">
        {onSelect ? (
          <button
            type="button"
            className="ui-change-piece-body"
            onClick={onSelect}
            aria-pressed={!!selected}
            title={
              selected
                ? "Stop highlighting this piece in the code below"
                : "Show this piece in the code below"
            }
          >
            {body}
          </button>
        ) : (
          <div className="ui-change-piece-body">{body}</div>
        )}
        {canBringBack ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => onBringBack!(s.identifier, relFile)}
            disabled={busy}
            title="Bring just this one piece back to its previous saved version"
          >
            {busy ? "Bringing back…" : "Bring this back"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

type SideProps = {
  label: string;
  symbols: ChangedSymbol[];
  showSignature: boolean;
  /** What the side says when the file is one-sided (brand new, or removed). */
  emptyNote: string;
  index: AtlasIndex | null;
  filePath: string | undefined;
  side: ChangeSideName;
  relFile: string;
  /** The generated file-level line for this side. Applied to a lone changed
   *  piece only; one file-level line can't speak for several. */
  sideLine?: string;
  /** Per-piece model meanings (identifier → sentence). */
  symbolMeanings?: Map<string, string>;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
  /** The piece highlighted in the diff below, when it is on this side. */
  selectedIdentifier?: string | null;
  onSelect?: (identifier: string) => void;
};

/** One side's list. An empty side says so plainly instead of leaving a blank
 *  header. */
export function ChangeSide({
  label,
  symbols,
  showSignature,
  emptyNote,
  index,
  filePath,
  side,
  relFile,
  sideLine,
  symbolMeanings,
  onBringBack,
  busySymbol,
  selectedIdentifier,
  onSelect,
}: SideProps) {
  const lone = symbols.length === 1;
  return (
    <div className="ui-change-side" data-side={side}>
      <h4>{label}</h4>
      {symbols.length ? (
        <ul>
          {symbols.map((s) => (
            <ChangePiece
              key={`${s.change}:${s.identifier}`}
              s={s}
              showSignature={showSignature}
              entry={index ? lookupEntry(index, s.identifier, filePath) : undefined}
              side={side}
              relFile={relFile}
              symbolMeaning={symbolMeanings?.get(s.identifier)}
              meaningOverride={lone ? sideLine : undefined}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
              selected={selectedIdentifier === s.identifier}
              onSelect={onSelect ? () => onSelect(s.identifier) : undefined}
            />
          ))}
        </ul>
      ) : (
        <p>{emptyNote}</p>
      )}
    </div>
  );
}
