// Settings → Modes pane. Lists every installed mode + a "Browse
// marketplace" CTA. Mirrors the BrainTab pattern: state hoisted from
// the modesStore, refresh on mount, atomic mutations through the
// Tauri commands. Lives in its own file so the SettingsDialog stays
// thin — the marketplace surface is heavier than a normal tab.

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Share2, Sparkles, Store } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModeCard } from "./ModeCard";
import { ModeInstallSheet } from "./ModeInstallSheet";
import { MarketplaceDialog } from "./MarketplaceDialog";
import { PublishModeDialog } from "./PublishModeDialog";
import { api } from "../../lib/api";
import {
  hasUpdate,
  refreshInstalledModes,
  refreshMarketplace,
  refreshUpdates,
  setActiveMode,
  useModes,
} from "../../lib/modesStore";

export function InstalledModesPane() {
  const store = useModes();
  const [query, setQuery] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [publishSlug, setPublishSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshInstalledModes();
    void refreshUpdates();
    // Touch the marketplace once so updates() can resolve display_name
    // for each row.
    void refreshMarketplace();
  }, []);

  const handleUninstall = async (slug: string) => {
    setError(null);
    try {
      await api.modesUninstall(slug);
      await refreshInstalledModes();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSetActive = (slug: string) => {
    setActiveMode(slug);
  };

  const handleUpdate = async (slug: string) => {
    const row = store.updates.find((u) => u.slug === slug);
    if (!row) return;
    try {
      await api.modesInstallFromUrl({
        url: row.marketplace.url,
        expectedPin: row.marketplace.pin_blake3 ?? null,
        advancedAcknowledged: false,
      });
      await refreshInstalledModes();
      await refreshUpdates();
    } catch (e) {
      setError(String(e));
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = store.installed.filter((m) =>
    !q
      ? true
      : m.id.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-text-1">Modes</h2>
              <p className="text-[11.5px] text-text-3 mt-0.5">
                Specialist personas you can switch between in chat. Each mode
                ships a system prompt, tool ACL, and optional Brain
                preferences.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setMarketOpen(true)}
              >
                <Store className="h-3.5 w-3.5 mr-1" />
                Browse marketplace
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  void refreshInstalledModes();
                  void refreshUpdates();
                }}
                title="Refresh"
              >
                {store.installedLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter installed modes…"
            className="h-8 text-[12px]"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setInstallOpen(true)}
          >
            Install from URL
          </Button>
        </div>

        {store.activeSlug && (
          <div className="flex items-center gap-2 text-[11.5px] text-text-3 rounded border border-bg-3 bg-bg-1 p-2">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            Active mode:{" "}
            <span className="font-medium text-text-1">{store.activeSlug}</span>
            <button
              type="button"
              className="ml-auto text-text-4 hover:text-text-1 underline"
              onClick={() => setActiveMode(null)}
            >
              clear
            </button>
          </div>
        )}

        {error && (
          <div className="text-[12px] text-red-700 dark:text-red-300 bg-red-100/30 dark:bg-red-900/20 rounded p-2">
            {error}
          </div>
        )}

        {store.installedError && !error && (
          <div className="text-[12px] text-red-700 dark:text-red-300">
            {store.installedError}
          </div>
        )}

        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="text-[12px] text-text-4 text-center py-6">
              {q
                ? `No installed modes match "${q}".`
                : "No modes installed yet."}
            </div>
          ) : (
            filtered.map((m) => (
              <div key={m.id} className="space-y-1">
                <ModeCard
                  state={{
                    kind: "installed",
                    entry: m,
                    updateAvailable: hasUpdate(store, m.id),
                  }}
                  onSelect={() => handleSetActive(m.id)}
                  onUpdate={() => void handleUpdate(m.id)}
                  onUninstall={() => void handleUninstall(m.id)}
                  onEdit={() => setPublishSlug(m.id)}
                />
                <div className="flex items-center gap-3 text-[10.5px] text-text-4 ml-3.5">
                  <button
                    type="button"
                    className="hover:text-text-2 inline-flex items-center gap-1"
                    onClick={() => setPublishSlug(m.id)}
                    title="Publish to Gist"
                  >
                    <Share2 className="h-3 w-3" /> Publish
                  </button>
                  {m.installed_at > 0 && (
                    <span>
                      installed{" "}
                      {new Date(m.installed_at * 1000).toLocaleDateString()}
                    </span>
                  )}
                  {m.pin_blake3 && (
                    <span title={m.pin_blake3}>
                      pin {m.pin_blake3.slice(0, 8)}…
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <MarketplaceDialog
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
      />
      <ModeInstallSheet
        open={installOpen}
        entry={null}
        onClose={() => setInstallOpen(false)}
      />
      <PublishModeDialog
        open={publishSlug !== null}
        slug={publishSlug}
        onClose={() => setPublishSlug(null)}
      />
    </>
  );
}
