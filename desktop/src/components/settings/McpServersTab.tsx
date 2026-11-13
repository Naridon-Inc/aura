// Settings → MCP servers.
//
// Rather than build a bespoke plugin SDK, we let MCP servers BE the plugin
// system. Configs live at `~/.aura/mcp/<name>.json`; this page is the only
// UI that mutates them. The composer pulls the merged tool catalog from
// `useMcpTools()`, so add/remove here flows straight into the slash palette
// and the @-mention picker. The rows, dialogs and templates live in `./mcp/`.

import { useCallback, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import {
  api,
  type DiscoveredMcp,
  type McpServerToolList,
} from "../../lib/api";
import { refreshMcpTools } from "../../lib/mcpToolsStore";
import { useCachedResource } from "../../lib/useCachedResource";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import {
  SettingsEmpty,
  SettingsError,
  SettingsGroup,
} from "../ui/settings-blocks";
import { SettingsMcpToolbar } from "../ui/settings-mcp-parts";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import { PaneIntro } from "./kit";
import { McpAddDialog } from "./mcp/McpAddDialog";
import { McpAuthDialog } from "./mcp/McpAuthDialog";
import { McpDiscoverSection } from "./mcp/McpDiscoverSection";
import { McpServerRow } from "./mcp/McpServerRow";
import { McpTemplateList } from "./mcp/McpTemplateList";
import {
  discoveredKey,
  EMPTY_FORM,
  parseEnvBlock,
  type AddFormState,
  type McpTemplate,
} from "./mcp/mcpTemplates";

/** How long a tool catalog is shown without starting the servers again. */
const TOOLS_FRESH_MS = 2 * 60_000;

export function McpServersTab({ repoRoot }: { repoRoot: string }) {
  // Both reads go through the shared cache, keyed by repository, so coming
  // back to this tab paints the last answer at once. The server list is a
  // file read and is re-checked on every open. The tool catalog starts every
  // enabled server (an npx server takes seconds), so an answer younger than
  // TOOLS_FRESH_MS is shown without asking again; every change made here
  // reloads it on purpose.
  const servers = useCachedResource(
    `mcp:servers:${repoRoot}`,
    useCallback(() => api.mcpServersList(repoRoot || undefined), [repoRoot]),
  );
  const catalog = useCachedResource(
    `mcp:tools:${repoRoot}`,
    useCallback(() => api.mcpToolsList(repoRoot || undefined), [repoRoot]),
    { freshMs: TOOLS_FRESH_MS },
  );
  const rows = servers.data ?? null;
  // A failed catalog read keeps the last one; a row without tools just
  // shows none, so there is nothing more to say about it here.
  const tools = catalog.data ?? null;
  // Three error slots, not one. A single pane-level `error` printed
  // every failure in the same banner at the very top — so pressing Save
  // at the foot of the Add form put the refusal above the templates
  // grid, off-screen, and the click read as doing nothing at all.
  // `listError` = we couldn't read the list; `formError` = the Add form
  // was refused; `rowError` = a toggle or remove failed.
  const listError = servers.staleError;
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  // QQ.2 — Discover-from-agents picker state. Lives next to the rest
  // of the tab so an open discover panel doesn't survive a tab switch.
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredMcp[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  // Wave A — name of the server whose auth modal is currently open
  // (null when closed). Only one modal at a time.
  const [authTarget, setAuthTarget] = useState<string | null>(null);

  const refresh = servers.reload;
  const refreshTools = catalog.reload;

  const runDiscover = useCallback(async () => {
    setDiscoverError(null);
    setDiscovering(true);
    setDiscoverOpen(true);
    try {
      const found = await api.mcpServersDiscoverAgents(repoRoot);
      setDiscovered(found);
      setPicked(
        new Set(
          found.filter((d) => !d.already_imported).map((d) => discoveredKey(d)),
        ),
      );
    } catch (e) {
      setDiscoverError(String(e));
      setDiscovered([]);
    } finally {
      setDiscovering(false);
    }
  }, [repoRoot]);

  const runImport = useCallback(async () => {
    if (!discovered) return;
    const chosen = discovered.filter(
      (d) => !d.already_imported && picked.has(discoveredKey(d)),
    );
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      await api.mcpServersImportDiscovered(chosen);
      setDiscovered(null);
      setDiscoverOpen(false);
      setPicked(new Set());
      await refresh();
      void refreshTools();
      void refreshMcpTools();
    } catch (e) {
      setDiscoverError(String(e));
    } finally {
      setBusy(false);
    }
  }, [discovered, picked, refresh, refreshTools]);

  const toolsByServer = useMemo(() => {
    const m = new Map<string, McpServerToolList>();
    for (const t of tools ?? []) m.set(t.server, t);
    return m;
  }, [tools]);

  const onToggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    setRowError(null);
    try {
      await api.mcpServersToggle(name, enabled);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setRowError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (name: string) => {
    if (
      !(await askConfirm({
        title: `Remove the connection to "${name}"?`,
        body: "Its tools stop being offered to your agents. You can add it again later.",
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    setRowError(null);
    try {
      await api.mcpServersRemove(name);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setRowError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openAdd = (next: AddFormState) => {
    setFormError(null);
    setForm(next);
    setAdding(true);
  };

  const closeAdd = () => {
    setAdding(false);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const closeDiscover = () => {
    setDiscoverOpen(false);
    setDiscovered(null);
    setPicked(new Set());
    setDiscoverError(null);
  };

  const applyTemplate = (t: McpTemplate) => {
    const env = t.envKeys.map((k) => `${k}=`).join("\n");
    setFormError(null);
    openAdd({
      name: t.id,
      command: t.command,
      args: t.args.join(" "),
      envText: env,
      description: t.label,
      serverUrl: t.serverUrl ?? "",
      scope: EMPTY_FORM.scope,
    });
  };

  const submitAdd = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const env = parseEnvBlock(form.envText);
      const newName = form.name.trim();
      const serverUrl = form.serverUrl.trim();
      await api.mcpServersAdd({
        name: newName,
        command: form.command.trim(),
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        env,
        description: form.description.trim() || null,
        serverUrl: serverUrl || undefined,
        // Opened in a repository, the server belongs to it unless the form
        // says every repository; it used to be added everywhere regardless.
        projectRoot: repoRoot && form.scope === "repository" ? repoRoot : null,
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      await refresh();
      void refreshMcpTools();
      void refreshTools();
      // When the new server is a remote/native-OAuth one, jump straight
      // into the auth modal — otherwise the user would have to find the
      // row and click Auth, which is exactly the friction we just fixed.
      if (serverUrl) {
        setAuthTarget(newName);
      }
    } catch (e) {
      setFormError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const enabledCount = rows?.filter((r) => r.enabled).length ?? 0;
  const authServer = authTarget ? rows?.find((r) => r.name === authTarget) : undefined;

  return (
    <>
      <PaneIntro text="Connections let your agents reach tools you already use — your issue tracker, your error reports, your docs. Add one here and it shows up in the composer for every agent in this repository." />

      {/* A read that failed is not a read still running. The catch leaves
          `rows` at null, which the status line draws as the spinner — so
          the failure is checked first, with a way to ask again. */}
      {rows === null && listError ? (
        <SettingsError>
          Aura couldn&apos;t read your connections.{" "}
          <Button variant="link" size="xs" onClick={() => void refresh()}>
            Try again
          </Button>
        </SettingsError>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          title="Servers"
          description={
            rows === null ? (
              listError ? (
                "Not read yet."
              ) : (
                <span className="ui-settings-status">
                  <AsciiSpinner />
                  Looking for connected servers…
                </span>
              )
            ) : (
              `${rows.length} configured · ${enabledCount} enabled`
            )
          }
          control={
            <SettingsMcpToolbar>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void refresh();
                  void refreshTools();
                  void refreshMcpTools();
                }}
                disabled={busy}
              >
                <RefreshCw />
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runDiscover()}
                disabled={busy || discovering}
                title="Scan agent configs (Claude Code, Cursor, Windsurf, Cline, Zed, opencode, Gemini CLI, …) for MCP servers you already have authenticated"
              >
                {discovering ? <AsciiSpinner /> : null}
                {discovering ? "Scanning…" : "Import from agents"}
              </Button>
              <Button size="sm" onClick={() => openAdd(EMPTY_FORM)} disabled={busy}>
                <Plus />
                Add server
              </Button>
            </SettingsMcpToolbar>
          }
        />
      </SettingsGroup>

      {discoverOpen && (
        <McpDiscoverSection
          discovered={discovered}
          discovering={discovering}
          error={discoverError}
          picked={picked}
          onPick={setPicked}
          onImport={() => void runImport()}
          onCancel={closeDiscover}
          busy={busy}
        />
      )}

      {rows !== null && rows.length === 0 && (
        <SettingsEmpty>
          No connections yet. Pick one below to add the first, or use Add server for anything else.
        </SettingsEmpty>
      )}

      {rows && rows.length > 0 && (
        <SettingsSection title="Configured servers">
          {/* A toggle or a remove that failed belongs with the rows,
              not in a banner at the top of a page you've scrolled past. */}
          {rowError && <SettingsError>{rowError}</SettingsError>}
          {rows.map((row) => (
            <McpServerRow
              key={row.name}
              row={row}
              toolList={toolsByServer.get(row.name)}
              onToggle={(next) => void onToggle(row.name, next)}
              onRemove={() => void onRemove(row.name)}
              onAuth={() => setAuthTarget(row.name)}
              disabled={busy}
            />
          ))}
        </SettingsSection>
      )}

      <McpTemplateList rows={rows} onPick={applyTemplate} disabled={busy} />

      <McpAddDialog
        open={adding}
        form={form}
        repoName={repoRoot ? repoRoot.split("/").filter(Boolean).pop() : null}
        onChange={setForm}
        formError={formError}
        busy={busy}
        onCancel={closeAdd}
        onSave={() => void submitAdd()}
      />

      {authServer && (
        <McpAuthDialog
          server={authServer}
          onClose={() => setAuthTarget(null)}
          onSaved={async () => {
            setAuthTarget(null);
            await refresh();
            void refreshTools();
            void refreshMcpTools();
          }}
        />
      )}
    </>
  );
}
