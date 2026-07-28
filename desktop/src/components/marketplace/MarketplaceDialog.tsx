// Modes marketplace — large dialog with search, filter tabs, and a
// list of mode cards. Sits behind the "Browse marketplace" CTA in the
// Settings → Modes pane and from the composer's mode chip when the
// user wants to add a new specialist.
//
// Three tabs: All (marketplace + installed merged), Installed (just
// the installed list), Updates (slugs with newer pins upstream).
// Search runs server-side via `modes_search` to keep semantics
// consistent with any future MCP exposure.

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

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

  useEffect(() => {
    if (!open) return;
    void refreshInstalledModes();
    void refreshMarketplace();
    void refreshUpdates();
  }, [open]);

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
                className="h-8 pl-7 text-[12px]"
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
                  {t === "installed" && `Installed (${store.installed.length})`}
                  {t === "updates" && `Updates (${store.updates.length})`}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                void refreshInstalledModes();
                void refreshMarketplace();
                void refreshUpdates();
              }}
              title="Refresh"
            >
              {store.marketplaceLoading ? (
                <AsciiSpinner className="text-[12px] leading-none" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto space-y-2 pr-1">
            {store.marketplaceError && tab !== "installed" && (
              <div className="text-[12px] text-red bg-red/10 rounded p-2">
                Marketplace unavailable: {store.marketplaceError}
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="text-[12px] text-text-4 text-center py-6">
                {tab === "updates"
                  ? "All modes are up to date."
                  : query
                    ? `No modes match "${query}".`
                    : "No modes yet."}
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

          <div className="flex items-center justify-between text-[10.5px] text-text-4">
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
