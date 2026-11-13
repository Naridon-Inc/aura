// The changed things, one flat row each: the +/−/~ mark, the plain line first,
// and — dim, beside it — the name or key it came from. A reworked piece adds
// what it used to do underneath. Capped, with the rest one click away.

import { forwardRef, useState, type HTMLAttributes } from "react";
import { SymbolContextMenu } from "../SymbolContextMenu";
import type { StoryRow } from "./story";

const CAP = 6;

const MARK_LABEL: Record<StoryRow["mark"], string> = {
  "+": "Added",
  "−": "Removed",
  "~": "Changed",
};

export function StoryRows({ rows, filePath }: { rows: StoryRow[]; filePath: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, CAP);
  const hidden = rows.length - shown.length;
  return (
    <>
      <ul className="ui-story-rows">
        {shown.map((r) =>
          r.symbol ? (
            <SymbolContextMenu
              key={r.id}
              identifier={r.symbol.identifier}
              filePath={filePath}
              kind={r.symbol.kind}
            >
              <Row row={r} />
            </SymbolContextMenu>
          ) : (
            <Row key={r.id} row={r} />
          ),
        )}
      </ul>
      {(hidden > 0 || all) && rows.length > CAP && (
        <button type="button" className="ui-story-more" onClick={() => setAll((v) => !v)}>
          {hidden > 0 ? `Show ${hidden} more` : "Show fewer"}
        </button>
      )}
    </>
  );
}

/** Forwards its ref and the props it is handed, so it can sit directly under
 *  the symbol menu's trigger. */
const Row = forwardRef<HTMLLIElement, { row: StoryRow } & HTMLAttributes<HTMLLIElement>>(function Row(
  { row, ...rest },
  ref,
) {
  const title = [row.text, row.was ? `Used to: ${row.was}` : "", row.symbol?.line ? `line ${row.symbol.line}` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <li
      {...rest}
      ref={ref}
      className="ui-story-row"
      data-mark={row.mark === "+" ? "added" : row.mark === "−" ? "removed" : "changed"}
      data-pending={row.pending ? "" : undefined}
      title={title}
    >
      <span className="ui-story-mark" aria-label={MARK_LABEL[row.mark]}>
        {row.mark}
      </span>
      <span className="ui-story-main">
        <span className="ui-story-text">{row.text}</span>
        {row.was && <span className="ui-story-was">Used to: {row.was}</span>}
      </span>
      {row.key && <code className="ui-story-key">{row.key}</code>}
    </li>
  );
});
