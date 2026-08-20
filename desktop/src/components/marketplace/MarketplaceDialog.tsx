// Modes marketplace — large dialog with search, filter tabs, and a
// list of mode cards. Sits behind the "Browse marketplace" CTA in the
// Settings → Modes pane and from the composer's mode chip when the
// user wants to add a new specialist.
//
// Three tabs: All (marketplace + installed merged), Installed (just
// the installed list), Updates (slugs with newer pins upstream).
// Search runs server-side via `modes_search` to keep semantics
// consistent with any future MCP exposure.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, RefreshCw, Search } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  EmptyState,
  ErrorState,
  FilteredEmptyState,
  LoadingState,
} from "../ui/state";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ModeCard } from "./ModeCard";
import { ModeInstallSheet } from "./ModeInstallSheet";
import { api, type MarketplaceIndexEntry } from "../../lib/api";
import {
  hasUpdate,
  refreshInstalledModes,
  refreshMarketplace,
  refreshUpdates,
  useModes,
} from "../../lib/modesStore";
import { modesEmptyCopy, tabCountLabel } from "../../lib/modesEmpty";

type Tab = "all" | "installed" | "updates";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function MarketplaceDialog({ open, onClose }: Props) {
  const store = useModes();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [installEntry, setInstallEntry] = useState<MarketplaceIndexEntry | null>(
    null,
  );
  const [installOpen, setInstallOpen] = useState(false);

  // Every read this dialog draws from, in one place: the mount, the toolbar
  // button and the error state's "Try again" all mean the same thing.
  const refreshAll = useCallback(() => {
    void refreshInstalledModes();
    void refreshMarketplace();
    void refreshUpdates();
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshAll();
  }, [open, refreshAll]);

  const installedById = useMemo(() => {
    const m = new Map<string, (typeof store.installed)[number]>();
    for (const e of store.installed) m.set(e.id, e);
    return m;
  }, [store.installed]);

  // Merged "All" view: marketplace entries first, with installed
  // entries replacing them when slugs collide. Locally-authored modes
  // (no marketplace listing) append at the end.
  const allEntries = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<
      | { kind: "marketplace"; entry: MarketplaceIndexEntry }
      | { kind: "installed"; entry: (typeof store.installed)[number] }
    > = [];
    if (store.marketplace) {
      for (const e of store.marketplace.entries) {
        const installed = installedById.get(e.id);
        if (installed) {
          out.push({ kind: "installed", entry: installed });
        } else {
          out.push({ kind: "marketplace", entry: e });
        }
        seen.add(e.id);
      }
    }
    for (const e of store.installed) {
      if (!seen.has(e.id)) out.push({ kind: "installed", entry: e });
    }
    return out;
  }, [store.marketplace, store.installed, installedById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows: typeof allEntries;
    if (tab === "installed") {
      rows = store.installed.map((e) => ({ kind: "installed" as const, entry: e }));
    } else if (tab === "updates") {
      const updateSlugs = new Set(store.updates.map((u) => u.slug));
      rows = store.installed
        .filter((e) => updateSlugs.has(e.id))
        .map((e) => ({ kind: "installed" as const, entry: e }));
    } else {
      rows = allEntries;
    }
    if (!q) return rows;
    return rows.filter((r) => {
      const e = r.entry;
      return (
        e.id.toLowerCase().includes(q) ||
        e.display_name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [tab, query, allEntries, store.installed, store.updates]);

  // What to say when the list is empty — and, just as important, when we
  // haven't earned the right to say anything yet. See `modesEmptyCopy`.
  const empty = modesEmptyCopy({
    tab,
    query: query.trim(),
    installedLoading: store.installedLoading,
    installedLoadedAt: store.installedLoadedAt,
    installedError: store.installedError,
    marketplaceLoading: store.marketplaceLoading,
    marketplaceLoadedAt: store.marketplaceLoadedAt,
    marketplaceError: store.marketplaceError,
    updatesLoading: store.updatesLoading,
    updatesLoadedAt: store.updatesLoadedAt,
    updatesError: store.updatesError,
  });

  const handleInstallMarketplace = (entry: MarketplaceIndexEntry) => {
    setInstallEntry(entry);
    setInstallOpen(true);
  };

  const handleUninstall = async (slug: string) => {
    try {
      await api.modesUninstall(slug);
      await refreshInstalledModes();
    } catch (e) {
      console.error("uninstall", e);
    }
  };

  const handleUpdate = async (slug: string) => {
    const row = store.updates.find((u) => u.slug === slug);
    if (!row) return;
    setInstallEntry(row.marketplace);
    setInstallOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Modes Marketplace</DialogTitle>
            <DialogDescription>
              Specialist personas you can switch between in chat. Bundled
              defaults ship with Aura; the marketplace adds modes
              published by the community.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="absolute left-2 top-1/2 -translate-y-1/2 text-text-4"
                size={12}
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search modes…"
                className="h-8 pl-7 text-sm"
              />
            </div>
            <div className="flex gap-1">
              {(["all", "installed", "updates"] as Tab[]).map((t) => (
                <Button
                  key={t}
                  variant={tab === t ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTab(t)}
                >
                  {t === "all" && "All"}
                  {t === "installed" &&
                    tabCountLabel(
                      "Installed",
                      store.installed.length,
                      store.installedLoadedAt,
                    )}
                  {t === "updates" &&
                    tabCountLabel("Updates", store.updates.length, store.updatesLoadedAt)}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={refreshAll}
              title="Refresh"
            >
              {store.marketplaceLoading ? (
                <AsciiSpinner className="text-sm leading-none" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto space-y-2 pr-1">
            {/* Rows arrived but the marketplace didn't: the list below is real
                and worth showing, so this stays a band rather than taking the
                surface over. When there are no rows the fold speaks instead —
                one answer, not a banner stacked on a contradicting sentence. */}
            {store.marketplaceError && tab !== "installed" && filtered.length > 0 && (
              <div className="text-sm text-red bg-red/10 rounded p-2">
                Marketplace unavailable: {store.marketplaceError}
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="py-6">
                {empty.kind === "waiting" ? (
                  <LoadingState size="md" label={empty.label} />
                ) : empty.kind === "failed" ? (
                  <ErrorState
                    size="md"
                    title={empty.title}
                    message={empty.message}
                    onRetry={refreshAll}
                  />
                ) : empty.kind === "filtered" ? (
                  <FilteredEmptyState size="md" onClear={() => setQuery("")} />
                ) : (
                  <EmptyState
                    size="md"
                    icon={Boxes}
                    title={empty.title}
                    body={empty.body}
                  />
                )}
              </div>
            ) : (
              filtered.map((r) => (
                <ModeCard
                  key={r.entry.id + "-" + r.kind}
                  state={
                    r.kind === "marketplace"
                      ? { kind: "marketplace", entry: r.entry }
                      : {
                          kind: "installed",
                          entry: r.entry,
                          updateAvailable: hasUpdate(store, r.entry.id),
                        }
                  }
                  onInstall={() =>
                    r.kind === "marketplace" &&
                    handleInstallMarketplace(r.entry)
                  }
                  onUpdate={() => handleUpdate(r.entry.id)}
                  onUninstall={() => void handleUninstall(r.entry.id)}
                />
              ))
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-text-4">
            <span>
              {store.marketplaceLoadedAt
                ? `Marketplace fetched ${new Date(
                    store.marketplaceLoadedAt,
                  ).toLocaleTimeString()}`
                : "Marketplace not yet fetched"}
            </span>
            <button
              type="button"
              className="text-text-3 hover:text-text-1 underline"
              onClick={() => {
                setInstallEntry(null);
                setInstallOpen(true);
              }}
            >
              Install from URL…
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <ModeInstallSheet
        open={installOpen}
        entry={installEntry}
        onClose={() => setInstallOpen(false)}
      />
    </>
  );
}
