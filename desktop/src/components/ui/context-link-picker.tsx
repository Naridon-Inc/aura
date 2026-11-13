import { useState } from "react";
import { Folder, FolderInput, Link, Check } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandShortcut,
} from "./command";
import { AsciiSpinner } from "./ascii-spinner";
export interface ContextLinkItem {
  id: string;
  title: string;
  group: string;
  detail?: string;
  linked?: boolean;
}
export function ContextLinkPicker({
  kind,
  open,
  onOpenChange,
  items,
  onSelect,
  onBrowse,
  loading,
  error,
  onCloseAutoFocus,
}: {
  kind: "issue" | "workspace";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ContextLinkItem[];
  onSelect: (item: ContextLinkItem) => void;
  onBrowse?: () => void;
  loading?: boolean;
  error?: string;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <CommandDialog
      onCloseAutoFocus={onCloseAutoFocus}
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setQuery("");
      }}
      title="Search"
      description={`Search ${kind === "issue" ? "issues" : "workspaces"} and press Enter to link one.`}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={`Search ${kind === "issue" ? "issues" : "workspaces"}…`}
        aria-label={`Search ${kind === "issue" ? "issues" : "workspaces"}`}
      />
      <CommandList>
        {loading ? (
          <div className="ui-link-picker-state">
            <AsciiSpinner />
            Loading your {kind === "issue" ? "issues" : "workspaces"}…
          </div>
        ) : error ? (
          <div role="alert" className="ui-link-picker-state">
            {error}
          </div>
        ) : (
          <>
            <CommandEmpty>No {kind === "issue" ? "issues" : "workspaces"} found.</CommandEmpty>
            {kind === "workspace" && onBrowse && (
              <CommandGroup heading="Directories">
                <CommandItem onSelect={onBrowse}>
                  <FolderInput />
                  Browse…<CommandShortcut>Enter</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            )}
            {[...new Set(items.map((item) => item.group))].map((group) => (
              <CommandGroup key={group} heading={group}>
                {items
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`${item.title} ${item.detail ?? ""}`}
                      disabled={item.linked}
                      onSelect={() => {
                        onSelect(item);
                        onOpenChange(false);
                      }}
                    >
                      {kind === "workspace" ? <Folder /> : <Link />}
                      <span>
                        {item.title}
                        <small>{item.detail}</small>
                      </span>
                      <CommandShortcut>
                        {item.linked ? <Check size={14} /> : "Link ↵"}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
