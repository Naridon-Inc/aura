// Settings → Modes pane. Every installed mode, and the ways in: browse the
// marketplace, or install from a URL.
//
// This pane predates the settings kit and still drew itself the old way: its
// own <h2>Modes</h2> under the rail's own "Modes" heading, then a stack of
// bordered, rounded cards each wearing a coloured rail — the exact shape the
// Brains pane was rewritten out of, for the same reason. A list of things you
// pick one of is hairline-divided rows here; the card belongs to the
// marketplace grid, where a card is what you are shopping through.
//
// The bigger problem was that it never showed which mode was in use. Clicking
// a card set the active mode and nothing in the list changed — the only sign
// was a separate strip above printing a raw slug. The row itself carries that
// now, on the same accent the rail, the Pages tree and the Brains pane use.
//
// State is hoisted from modesStore, refreshed on mount, mutated through the
// Tauri commands.

import { useEffect, useState } from "react";
import { Check, RefreshCw, SearchX, Share2, Sparkles, Store, Trash2 } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState, ErrorNote } from "../ui/state";
import { PaneIntro, Section } from "../settings/kit/rows";
import { shortDateFromSecs } from "../../lib/calendarDate";
import { ModePermissionsBadge } from "./ModePermissionsBadge";
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

import type { ModeDescriptor } from "../../lib/api";

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
      <PaneIntro
        text={
          <>
            A mode is a way of working you can hand an agent — how to think
            about the job, which tools it may reach for, and which model to
            think with. Pick one here and every chat starts in it until you
            pick another.
          </>
        }
      />

      <div className="mb-7 flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter installed modes…"
          className="h-8 text-sm"
        />
        <Button variant="subtle" size="sm" onClick={() => setInstallOpen(true)}>
          Install from URL
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setMarketOpen(true)}>
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
            <AsciiSpinner className="text-sm leading-none" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {store.installedError && !error && (
        <ErrorNote>{store.installedError}</ErrorNote>
      )}

      <Section title="Installed">
        {filtered.length === 0 ? (
          q ? (
            <EmptyState
              icon={SearchX}
              title="No modes match"
              body={`None of your installed modes are called “${q}”.`}
              size="sm"
            />
          ) : (
            <EmptyState
              icon={Sparkles}
              title="No modes installed yet"
              body="A mode is a set of habits you give an agent. How to write, what to check before it finishes, which parts of the project to leave alone. Install one and every agent you run follows it."
              action={{
                label: "Browse modes",
                onClick: () => setMarketOpen(true),
                icon: Store,
              }}
              size="sm"
            />
          )
        ) : (
          filtered.map((m) => (
            <ModeRow
              key={m.id}
              mode={m}
              active={store.activeSlug === m.id}
              updateAvailable={hasUpdate(store, m.id)}
              onToggle={() =>
                setActiveMode(store.activeSlug === m.id ? null : m.id)
              }
              onUpdate={() => void handleUpdate(m.id)}
              onUninstall={() => void handleUninstall(m.id)}
              onPublish={() => setPublishSlug(m.id)}
            />
          ))
        )}
      </Section>

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

/** One installed mode. The whole left side is the switch — press it to work
 *  in this mode, press it again to stop. Deliberately not a radio: a radio
 *  group has no way back to "none", and none is a real answer here. */
function ModeRow({
  mode,
  active,
  updateAvailable,
  onToggle,
  onUpdate,
  onUninstall,
  onPublish,
}: {
  mode: ModeDescriptor;
  active: boolean;
  updateAvailable: boolean;
  onToggle: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
  onPublish: () => void;
}) {
  return (
    <div className={active ? "row-selected" : undefined}>
      <div className="flex items-start">
        <button
          type="button"
          aria-pressed={active}
          onClick={onToggle}
          title={mode.id}
          className="flex min-w-0 flex-1 flex-col gap-1 px-2 py-4 text-left transition-colors hover:bg-state-hover"
        >
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={`text-sm font-medium ${
                active ? "text-accent" : "text-text-1"
              }`}
            >
              {mode.display_name}
            </span>
            {active && (
              <span className="inline-flex items-center gap-0.5 text-xs text-text-3">
                <Check className="h-3 w-3" />
                in use
              </span>
            )}
            {mode.bundled && <span className="section-label">bundled</span>}
            {updateAvailable && (
              <span className="text-xs text-amber">update available</span>
            )}
          </span>
          {/* Descriptions were clamped to two lines, which cut most of them
              mid-sentence — a row that ends in an ellipsis is a row you have
              to go elsewhere to finish reading. */}
          <span className="text-[13px] leading-relaxed text-text-3">
            {mode.description}
          </span>
          <span className="flex flex-wrap items-center gap-2 pt-0.5">
            {mode.author && (
              <span className="text-2xs text-text-4">by {mode.author}</span>
            )}
            {mode.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="text-2xs text-text-3 bg-bg-2 rounded px-1.5 py-0.5"
              >
                {t}
              </span>
            ))}
            <ModePermissionsBadge toolAcl={mode.tool_acl} />
            {mode.installed_at > 0 && (
              <span className="text-2xs text-text-4">
                installed {shortDateFromSecs(mode.installed_at)}
              </span>
            )}
          </span>
        </button>
        {/* Publish used to sit on its own line under the card, between one
            mode and the next, belonging to neither. It is this mode's
            action, so it stands with this mode's actions.

            There were two controls here, not one: a pencil captioned "Edit
            YAML" beside it. Both opened the publish-to-Gist dialog — there
            is no YAML editor behind either. One action, named for what it
            actually does. */}
        <div className="flex shrink-0 items-center gap-1 pt-4">
          {updateAvailable && (
            <Button size="sm" onClick={onUpdate}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Update
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={onPublish}
            title="Publish to a Gist"
          >
            <Share2 className="h-3.5 w-3.5" />
          </Button>
          {!mode.bundled && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onUninstall}
              title="Uninstall"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
