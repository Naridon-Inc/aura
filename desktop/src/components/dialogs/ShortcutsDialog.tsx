// The ⌘/ keyboard-shortcuts sheet.
//
// Summoned from anywhere with ⌘/ (or the command palette, or `?` on the tasks
// board) and dismissed with Esc. A search box sits under the title: with
// nothing typed, every shortcut shows under its group; typing turns it into
// one list of the rows that fit, best first, with the typed letters of each
// name standing out and the rest dimmed. It reads the one SHORTCUT_GROUPS
// map Settings → Keyboard shortcuts also reads, so the two list the same keys.
//
// Groups that only apply somewhere (a focused task card, an open plan) say
// where under their heading: a scoped key with no scope printed is tried on
// the wrong screen and taken for broken.

import { Fragment, useMemo, useState } from "react";
import { Command, Search } from "lucide-react";

import { SHORTCUT_GROUPS, comboKeys } from "../../lib/shortcuts";
import { searchShortcuts, shortcutRows, type ShortcutRow } from "../../lib/shortcutSearch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import "../ui/shortcuts-dialog.css";

/** A name with the matched letters at full strength and the rest dimmed.
 *  With a query but no letters matched (the group's name did), all dimmed. */
function MatchedTitle({ title, match, hasQuery }: { title: string; match?: number[]; hasQuery: boolean }) {
  if (!hasQuery) return <>{title}</>;
  if (!match || match.length === 0) return <span className="ui-shortcuts-dim">{title}</span>;
  const hit = new Set(match);
  const runs: { text: string; on: boolean }[] = [];
  for (let i = 0; i < title.length; i++) {
    const on = hit.has(i);
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.text += title[i];
    else runs.push({ text: title[i], on });
  }
  return (
    <span>
      {runs.map((r, i) => (
        <span key={i} className={r.on ? undefined : "ui-shortcuts-dim"}>
          {r.text}
        </span>
      ))}
    </span>
  );
}

function ShortcutLine({ row, match, hasQuery }: { row: ShortcutRow; match?: number[]; hasQuery: boolean }) {
  return (
    <div className="ui-shortcuts-row">
      <span className="ui-shortcuts-name">
        <MatchedTitle title={row.title} match={match} hasQuery={hasQuery} />
      </span>
      <div className="ui-shortcuts-keys">
        {comboKeys(row.keys).map((cap, i) => (
          <Fragment key={`${cap}-${i}`}>
            <Kbd>{cap}</Kbd>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => shortcutRows(), []);
  const hits = query.trim() ? searchShortcuts(rows, query) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setQuery("");
        onClose();
      }}
    >
      <DialogContent className="ui-shortcuts-dialog" aria-describedby={undefined}>
        <DialogHeader className="ui-shortcuts-head">
          <DialogTitle className="ui-shortcuts-title">
            <Command size={20} aria-hidden />
            Keyboard shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className="ui-shortcuts-search">
          <Search size={16} aria-hidden />
          <Input
            placeholder="Search shortcuts..."
            aria-label="Search shortcuts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ui-shortcuts-body">
          {hits !== undefined ? (
            hits.length > 0 ? (
              <div className="ui-shortcuts-rows">
                {hits.map((h) => (
                  <ShortcutLine key={h.row.id} row={h.row} match={h.titleMatch} hasQuery />
                ))}
              </div>
            ) : (
              <div className="ui-shortcuts-none">No shortcuts found for "{query}"</div>
            )
          ) : (
            SHORTCUT_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="ui-shortcuts-group">{group.title}</h3>
                {group.note && <p className="ui-shortcuts-note">{group.note}</p>}
                <div className="ui-shortcuts-rows">
                  {rows
                    .filter((r) => r.category === group.title)
                    .map((r) => (
                      <ShortcutLine key={r.id} row={r} hasQuery={false} />
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
