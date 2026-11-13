// Settings → Modes. Every installed mode, and the ways in: browse the
// marketplace, or install from a URL.
//
// Drawn from the settings parts, the same way the Plugins and Connections
// pages are: a row that counts what is installed and holds the page's
// actions, then one settings row per mode with its marks after the name,
// what it is for underneath, and its menu on the right.
//
// There is no switch for the mode in use. Nothing starts a chat in a mode
// yet, so a switch here would only remember a choice nobody reads; the row
// gets one when a chat does.
//
// State is hoisted from modesStore, refreshed on mount, mutated through the
// Tauri commands.

import { useEffect, useState } from "react";
import { MoreHorizontal, RefreshCw, Search, Store } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsGroup,
  SettingsIntro,
} from "../ui/settings-blocks";
import { SettingsMcpTitle, SettingsMcpToolbar } from "../ui/settings-mcp-parts";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
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
  useModes,
} from "../../lib/modesStore";
import "../ui/settings-modes.css";

import type { ModeDescriptor } from "../../lib/api";

/** A filter is worth its row only once the list is longer than a glance. */
const FILTER_FROM = 6;

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

  const count = store.installedLoading && store.installed.length === 0 ? (
    <span className="ui-settings-status" role="status">
      <AsciiSpinner />
      Looking for installed modes…
    </span>
  ) : (
    `${store.installed.length} installed`
  );

  return (
    <>
      <SettingsIntro>
        A mode is a way of working you can hand an agent: how to think about the job, which tools
        it may reach for, and which model to think with. The modes you install are kept here, ready
        to update, publish or remove. Chats don't start in a mode yet.
      </SettingsIntro>

      {error && <SettingsError>{error}</SettingsError>}
      {store.installedError && !error && <SettingsError>{store.installedError}</SettingsError>}

      <SettingsGroup>
        <SettingsRow
          title="Modes"
          description={count}
          control={
            <SettingsMcpToolbar>
              <Button
                size="sm"
                variant="ghost"
                disabled={store.installedLoading}
                onClick={() => {
                  void refreshInstalledModes();
                  void refreshUpdates();
                }}
              >
                <RefreshCw />
                Refresh
              </Button>
              <Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
                Install from URL
              </Button>
              <Button size="sm" onClick={() => setMarketOpen(true)}>
                <Store />
                Browse marketplace
              </Button>
            </SettingsMcpToolbar>
          }
        />
      </SettingsGroup>

      <SettingsSection title="Installed">
        {store.installed.length >= FILTER_FROM && (
          <div className="ui-settings-modes-filter">
            <Input
              size="small"
              prefix={<Search size={14} />}
              aria-label="Filter installed modes"
              placeholder="Filter installed modes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {filtered.length === 0 ? (
          q ? (
            <SettingsEmpty>None of your installed modes match “{query.trim()}”.</SettingsEmpty>
          ) : (
            <SettingsEmpty>
              No modes installed yet. A mode is a set of habits you give an agent: how to write,
              what to check before it finishes, which parts of the repository to leave alone.{" "}
              <Button variant="link" size="xs" onClick={() => setMarketOpen(true)}>
                Browse modes
              </Button>
            </SettingsEmpty>
          )
        ) : (
          filtered.map((m) => (
            <ModeRow
              key={m.id}
              mode={m}
              updateAvailable={hasUpdate(store, m.id)}
              onUpdate={() => void handleUpdate(m.id)}
              onUninstall={() => void handleUninstall(m.id)}
              onPublish={() => setPublishSlug(m.id)}
            />
          ))
        )}
      </SettingsSection>

      <MarketplaceDialog open={marketOpen} onClose={() => setMarketOpen(false)} />
      <ModeInstallSheet open={installOpen} entry={null} onClose={() => setInstallOpen(false)} />
      <PublishModeDialog
        open={publishSlug !== null}
        slug={publishSlug}
        onClose={() => setPublishSlug(null)}
      />
    </>
  );
}

/** One installed mode as a settings row: its name and marks, what it is
 *  for, who made it, and on the right its update and a menu. */
function ModeRow({
  mode,
  updateAvailable,
  onUpdate,
  onUninstall,
  onPublish,
}: {
  mode: ModeDescriptor;
  updateAvailable: boolean;
  onUpdate: () => void;
  onUninstall: () => void;
  onPublish: () => void;
}) {
  const facts = [
    mode.author ? `by ${mode.author}` : null,
    mode.tags.length > 0 ? mode.tags.slice(0, 4).join(", ") : null,
    mode.installed_at > 0 ? `installed ${shortDateFromSecs(mode.installed_at)}` : null,
  ].filter((f): f is string => f !== null);

  return (
    <SettingsRow
      title={
        <SettingsMcpTitle name={mode.display_name}>
          {mode.bundled && <Badge variant="outline">bundled</Badge>}
          <ModePermissionsBadge toolAcl={mode.tool_acl} />
        </SettingsMcpTitle>
      }
      description={mode.description || undefined}
      help={facts.length > 0 ? facts.join(" · ") : undefined}
      control={
        <SettingsActions>
          {updateAvailable && (
            <Button size="sm" variant="outline" onClick={onUpdate}>
              <RefreshCw />
              Update
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="iconSm" aria-label={`More for ${mode.display_name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onPublish}>Publish to a Gist</DropdownMenuItem>
              {!mode.bundled && (
                <DropdownMenuItem onSelect={onUninstall}>Uninstall</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsActions>
      }
    />
  );
}
