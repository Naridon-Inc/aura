import { useState } from "react";
import { Search, X } from "lucide-react";
import { useRepoIcons } from "./loadRepoIcons";
import type { RepoIconTabProps } from "./repoIconChoice";

/** The named icons, searchable by name. */
export function IconsTab({ look, onClose }: RepoIconTabProps) {
  const [query, setQuery] = useState("");
  const icons = useRepoIcons();
  const q = query.trim().toLowerCase();
  const names = icons ? icons.REPO_ICON_NAMES.filter((n) => !q || n.includes(q)) : [];
  return (
    <div className="ui-repo-icon-tab">
      <div className="ui-repo-icon-search">
        <Search size={14} aria-hidden />
        <input
          placeholder="Search icons"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {look.custom && (
          <button
            type="button"
            className="ui-repo-icon-clear"
            aria-label="Remove icon"
            title="Remove icon"
            onClick={() => {
              look.setAutomatic();
              onClose();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="ui-repo-icon-grid" data-cols="9">
        {icons &&
          names.map((n) => {
            const Glyph = icons.REPO_ICONS[n]!;
            return (
              <button
                key={n}
                type="button"
                title={n}
                aria-label={n}
                data-selected={look.chosen === n || undefined}
                onClick={() => {
                  if (look.setIcon(n)) onClose();
                }}
              >
                <Glyph size={20} />
              </button>
            );
          })}
      </div>
      {icons && names.length === 0 && <p className="ui-repo-icon-empty">No icons found</p>}
    </div>
  );
}
