// The card-stack tab switcher — a full-panel overlay reached from the bottom
// bar's stack button. Lists every open tab as a card (title + host + close),
// the active one ringed, with a "+ New tab" card to spawn another. Mounted
// above the native webview hole; while it's open the rail stops rendering the
// hole, so the webview is hidden and these React cards aren't painted over.

import { Globe, Plus, RotateCw, X } from "lucide-react";

import { hostOf } from "../../../lib/browserEngine";
import type { BrowserTab } from "../../../lib/browserStore";

function tabTitle(tab: BrowserTab): string {
  if (tab.title) return tab.title;
  if (tab.url) return hostOf(tab.url);
  return "New tab";
}

export function BrowserTabSwitcher({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
  onCloseTab,
}: {
  tabs: BrowserTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg-1">
      <div className="flex items-center justify-between h-11 px-3 flex-shrink-0">
        <span className="text-sm font-semibold text-text-1">
          {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Done"
          aria-label="Done"
          className="flex items-center justify-center w-7 h-7 rounded-full text-text-3 hover:text-text-1 hover:bg-state-hover transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={`group w-full flex items-center gap-2.5 h-12 pl-3 pr-2 rounded-xl text-left transition-colors ${
              t.id === activeId
                ? "bg-bg-2 ring-1 ring-accent/50"
                : "bg-bg-2/60 hover:bg-state-hover ring-1 ring-line-soft"
            }`}
          >
            {t.loading ? (
              <RotateCw className="h-4 w-4 flex-shrink-0 animate-spin text-text-3" />
            ) : (
              <Globe className="h-4 w-4 flex-shrink-0 text-text-3" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-base text-text-1 truncate">{tabTitle(t)}</div>
              {t.url && <div className="text-xs text-text-4 truncate">{hostOf(t.url)}</div>}
            </div>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(t.id);
              }}
              title="Close tab"
              aria-label="Close tab"
              className="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full text-text-4 hover:text-text-1 hover:bg-state-hover opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          </button>
        ))}

        <button
          type="button"
          onClick={onNewTab}
          className="w-full flex items-center justify-center gap-2 h-12 rounded-xl border border-dashed border-line-soft text-text-3 hover:text-text-1 hover:bg-state-hover transition-colors"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">New tab</span>
        </button>
      </div>
    </div>
  );
}
