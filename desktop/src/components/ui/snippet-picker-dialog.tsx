// The snippet picker: a search field over two panes, the saved snippets on
// the left (name, ";keyword", Insert ↵ on the row the keys are on) with a
// "Create snippet" row under them, and the chosen snippet's whole text on the
// right. Enter on a snippet inserts it; on "Create snippet" it opens the form.

import { useMemo, useState } from "react";
import { CornerDownLeft, Plus } from "lucide-react";

import type { Snippet } from "../../lib/snippets";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import { Marked, matchedLetters } from "./composerSuggestions";
import "./issue-link-dialog.css";
import "./snippet-dialogs.css";

const CREATE = "create-snippet";

/** The snippets a search keeps: a name or text holding what was typed, then
 *  names holding its letters in order. Everything when nothing is typed. */
export function searchSnippets(snippets: readonly Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...snippets];
  const whole = snippets.filter(
    (s) => s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
  );
  const loose = snippets.filter((s) => !whole.includes(s) && matchedLetters(s.name, q).length > 0);
  return [...whole, ...loose];
}

export function SnippetPickerDialog({
  open,
  onOpenChange,
  snippets,
  onInsert,
  onCreate,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snippets: readonly Snippet[];
  onInsert: (snippet: Snippet) => void;
  onCreate: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const shown = useMemo(() => searchSnippets(snippets, query), [snippets, query]);
  // Each opening starts on the first snippet (the one just saved comes back
  // here too), so Enter inserts and the preview shows its text.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSelected(shown[0]?.id ?? CREATE);
  }
  const preview = shown.find((s) => s.id === selected);
  const typed = query.trim();
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      title="Snippets"
      description="Search your snippets and press Enter to insert one."
      className="ui-snippet-picker"
      onCloseAutoFocus={onCloseAutoFocus}
      commandProps={{ shouldFilter: false, loop: true, value: selected, onValueChange: setSelected }}
    >
      <CommandInput placeholder="Search snippets..." value={query} onValueChange={setQuery} autoFocus />
      <div className="ui-snippet-picker-body">
        <CommandList className="ui-snippet-picker-list">
          {shown.length === 0 ? (
            <p className="ui-snippet-picker-empty">{typed ? "No matching snippets" : "No snippets"}</p>
          ) : (
            <CommandGroup>
              {shown.map((s) => (
                <CommandItem
                  key={s.id}
                  value={s.id}
                  className="ui-snippet-picker-row"
                  onSelect={() => onInsert(s)}
                >
                  <span className="ui-snippet-picker-name">
                    <Marked text={s.name} query={typed} />
                  </span>
                  {s.keyword && <span className="ui-snippet-picker-keyword">;{s.keyword}</span>}
                  <span className="ui-snippet-picker-hint">
                    Insert
                    <CornerDownLeft aria-label="Enter" />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup>
            <CommandItem value={CREATE} className="ui-snippet-picker-row" onSelect={onCreate}>
              <Plus aria-hidden="true" />
              <span className="ui-snippet-picker-name">Create snippet</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        {preview ? (
          <div className="ui-snippet-picker-preview">
            <div className="ui-snippet-picker-preview-head">
              <h3>{preview.name}</h3>
              {preview.keyword && <span className="ui-snippet-picker-keyword">;{preview.keyword}</span>}
            </div>
            <p>{preview.body}</p>
          </div>
        ) : (
          <div className="ui-snippet-picker-preview" />
        )}
      </div>
    </CommandDialog>
  );
}
