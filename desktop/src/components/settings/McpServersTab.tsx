// Settings → MCP Servers pane.
//
// Post-W4 pivot surface: rather than continue building the bespoke
// worker-bridge plugin SDK, we let MCP servers BE the plugin system.
// Configs live at `~/.aura/mcp/<name>.json`; this pane is the only UI
// that mutates them. The Composer pulls the merged tool catalog from
// `useMcpTools()` so add/remove here flows straight into the slash
// palette + @-mention picker.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Eye,
  EyeOff,
  Plug,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState, ErrorNote } from "../ui/state";
import {
  MODAL_BACKDROP,
  MODAL_FOOTER,
  MODAL_HEADER,
  MODAL_PANEL,
  MODAL_TITLE,
} from "../ui/modalSurface";
import { cn } from "../../lib/utils";
import {
  api,
  type DiscoveredMcp,
  type McpServerEntry,
  type McpServerToolList,
} from "../../lib/api";
import { refreshMcpTools } from "../../lib/mcpToolsStore";
import { Field, PaneIntro, Section, Toggle } from "./kit";
import { askConfirm } from "../ui/ask";

type McpTemplate = {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  /** Per-key hint shown next to the field in the auth modal. */
  envHints?: Record<string, string>;
  /** Per-key sensitivity flag — true means render as password input. */
  envSecret?: Record<string, boolean>;
  /** Provider's token-issue page. The auth modal renders this as an
   *  "Open token page" button that uses the system browser, so users
   *  don't have to hunt for the right Settings panel. */
  tokenPageUrl?: string;
  /** Remote MCP endpoint. When set, Aura uses its native Streamable
   *  HTTP transport + OAuth 2.1 PKCE flow rather than spawning a
   *  stdio child. Mutually informative with `command`/`args` (a
   *  template can be remote-only with empty command, or hybrid). */
  serverUrl?: string;
};

const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "atlassian-remote",
    label: "Atlassian (remote · native OAuth)",
    description:
      "Atlassian's hosted remote MCP. Aura authenticates via native OAuth 2.1 and calls it over Streamable HTTP.",
    command: "",
    args: [],
    envKeys: [],
    serverUrl: "https://mcp.atlassian.com/v1/sse",
  },
  {
    id: "atlassian",
    label: "Atlassian (Jira + Confluence)",
    description:
      "Atlassian's official MCP server. Needs ATLASSIAN_API_TOKEN + ATLASSIAN_EMAIL + ATLASSIAN_DOMAIN.",
    command: "npx",
    args: ["-y", "@atlassian/mcp-server"],
    envKeys: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_EMAIL", "ATLASSIAN_DOMAIN"],
    envHints: {
      ATLASSIAN_API_TOKEN: "Create at id.atlassian.com → Security → API tokens",
      ATLASSIAN_EMAIL: "Your Atlassian account email",
      ATLASSIAN_DOMAIN: "e.g. yourco.atlassian.net (no https://)",
    },
    envSecret: { ATLASSIAN_API_TOKEN: true },
    tokenPageUrl:
      "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  {
    id: "linear",
    label: "Linear",
    description:
      "Linear's MCP bridge. Needs a personal API key with read/write scopes (LINEAR_API_KEY).",
    command: "npx",
    args: ["-y", "@linear/mcp-server"],
    envKeys: ["LINEAR_API_KEY"],
    envHints: {
      LINEAR_API_KEY: "Create at linear.app/settings/api",
    },
    envSecret: { LINEAR_API_KEY: true },
    tokenPageUrl: "https://linear.app/settings/api",
  },
  {
    id: "github",
    label: "GitHub",
    description:
      "GitHub's MCP server. Needs a fine-grained personal access token (GITHUB_PERSONAL_ACCESS_TOKEN).",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    envHints: {
      GITHUB_PERSONAL_ACCESS_TOKEN:
        "Use a fine-grained PAT with repo + issues scopes",
    },
    envSecret: { GITHUB_PERSONAL_ACCESS_TOKEN: true },
    tokenPageUrl: "https://github.com/settings/tokens?type=beta",
  },
  {
    id: "sentry",
    label: "Sentry",
    description:
      "Sentry issue + event search. Needs SENTRY_AUTH_TOKEN and the org slug.",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
    envHints: {
      SENTRY_AUTH_TOKEN: "Create at sentry.io → Settings → Auth Tokens",
      SENTRY_ORG: "Your org slug (visible in any Sentry URL)",
    },
    envSecret: { SENTRY_AUTH_TOKEN: true },
    tokenPageUrl: "https://sentry.io/settings/account/api/auth-tokens/",
  },
];

// Best-effort match from a configured server back to its template. Used
// by the AuthSetupModal to know which env keys to prompt for. We match
// on `id === name` first (the import flow keeps the template slug as
// the server name); fall back to scanning args for the npm package
// hint so renamed-but-otherwise-identical configs still snap into the
// right template.
function matchTemplate(
  name: string,
  args: string[] | undefined,
): McpTemplate | null {
  const byName = MCP_TEMPLATES.find((t) => t.id === name.toLowerCase());
  if (byName) return byName;
  const argBlob = (args ?? []).join(" ").toLowerCase();
  for (const t of MCP_TEMPLATES) {
    const pkgArg = t.args[t.args.length - 1] ?? "";
    if (pkgArg && argBlob.includes(pkgArg.toLowerCase())) return t;
  }
  return null;
}

type AddFormState = {
  name: string;
  command: string;
  args: string;
  envText: string;
  description: string;
  /** Remote MCP endpoint. When non-empty the backend wires the native
   *  Streamable HTTP transport and OAuth 2.1 PKCE flow; the stdio
   *  command/args become optional (empty = pure-remote). */
  serverUrl: string;
};

const EMPTY_FORM: AddFormState = {
  name: "",
  command: "",
  args: "",
  envText: "",
  description: "",
  serverUrl: "",
};

// Identity key for a discovered row. Used as the picker checkbox key so
// the same server surfaced from multiple agents (Claude+Cursor+Windsurf
// pointed at the same binary) collapses to one row, but configs that
// diverge stay distinct.
function discoveredKey(d: DiscoveredMcp): string {
  return `${d.name}::${d.command}::${d.args.join(" ")}`;
}

export function McpServersTab({ repoRoot }: { repoRoot: string }) {
  const [rows, setRows] = useState<McpServerEntry[] | null>(null);
  const [tools, setTools] = useState<McpServerToolList[] | null>(null);
  // Three error slots, not one. A single pane-level `error` printed
  // every failure in the same banner at the very top — so pressing Save
  // at the foot of the Add form put the refusal above the templates
  // grid, off-screen, and the click read as doing nothing at all.
  // `listError` = we couldn't read the list; `formError` = the Add form
  // was refused; `rowError` = a toggle or remove failed.
  const [listError, setListError] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      const list = await api.mcpServersList();
      setRows(list);
      setListError(null);
    } catch (e) {
      setListError(String(e));
    }
  }, []);

  // Best-effort tool-catalog read. Failures don't block the list —
  // we surface them inline on the row so the user can fix the config.
  const refreshTools = useCallback(async () => {
    try {
      const t = await api.mcpToolsList();
      setTools(t);
    } catch (e) {
      console.warn("mcpToolsList failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshTools();
  }, [refresh, refreshTools]);

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

  const applyTemplate = (t: McpTemplate) => {
    const env = t.envKeys.map((k) => `${k}=`).join("\n");
    setFormError(null);
    setForm({
      name: t.id,
      command: t.command,
      args: t.args.join(" "),
      envText: env,
      description: t.label,
      serverUrl: t.serverUrl ?? "",
    });
    setAdding(true);
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

  return (
    <>
      <PaneIntro text="Connections let your agents reach tools you already use — your issue tracker, your error reports, your docs. Add one here and it shows up in the composer for every agent in this project." />

      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-1.5 text-sm text-text-3">
          {/* A read that failed is not a read still running. The catch
              left `rows` at null, which this row drew as the spinner —
              so a list call that failed every time span here forever,
              on a machine that may well have connections set up. */}
          {rows === null && listError ? (
            <span className="text-red">
              Aura couldn&apos;t read your connections.{" "}
              <button
                type="button"
                onClick={() => void refresh()}
                className="underline underline-offset-2 hover:text-text-2"
              >
                Try again
              </button>
            </span>
          ) : rows === null ? (
            <>
              <AsciiSpinner className="text-sm leading-none" />
              Looking for connected servers…
            </>
          ) : (
            `${rows.length} configured · ${rows.filter((r) => r.enabled).length} enabled`
          )}
        </div>
        <div className="flex items-center gap-2">
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
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runDiscover()}
            disabled={busy || discovering}
            title="Scan agent configs (Claude Code, Cursor, Windsurf, Cline, Zed, opencode, Gemini CLI, …) for MCP servers you already have authenticated"
          >
            {discovering ? "Scanning…" : "Import from agents"}
          </Button>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
              Add server
            </Button>
          )}
        </div>
      </div>

      {discoverOpen && (
        <Section title="Discovered from your agents">
          {discoverError && (
            <div className="text-sm text-red mb-2" role="alert">
              {discoverError}
            </div>
          )}
          {discovered === null && discovering && (
            <div className="text-sm text-text-3">
              Scanning agent configs…
            </div>
          )}
          {discovered !== null && discovered.length === 0 && !discovering && (
            <EmptyState
              icon={Search}
              title="Nothing new found"
              size="sm"
              className="py-4"
              body={
                <>
                  Aura scans Claude Code, Claude Desktop, Cursor, Windsurf,
                  Cline, Roo Cline, Zed, opencode, Gemini CLI, Codex, and
                  repo-local <code>.mcp.json</code>. Configure a server in any
                  of those and re-run.
                </>
              }
            />
          )}
          {discovered !== null && discovered.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-text-3 px-1">
                <div>
                  {discovered.length} server
                  {discovered.length === 1 ? "" : "s"} found ·{" "}
                  {discovered.filter((d) => !d.already_imported).length}{" "}
                  importable
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-text-3 hover:text-text-1"
                    onClick={() =>
                      setPicked(
                        new Set(
                          discovered
                            .filter((d) => !d.already_imported)
                            .map((d) => discoveredKey(d)),
                        ),
                      )
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-xs text-text-3 hover:text-text-1"
                    onClick={() => setPicked(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-[280px] overflow-y-auto rounded border border-line-soft divide-y divide-line-soft">
                {discovered.map((d) => {
                  const k = discoveredKey(d);
                  const checked = picked.has(k);
                  const disabled = d.already_imported;
                  return (
                    <label
                      key={`${k}::${d.source}`}
                      className={`flex items-start gap-2.5 px-2.5 py-2 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-state-hover"}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          });
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="text-base font-medium text-text-1 truncate">
                            {d.name}
                          </div>
                          <span className="text-2xs text-text-4 px-1.5 py-0.5 rounded bg-bg-1 border border-line-soft">
                            {d.source}
                          </span>
                          {disabled && (
                            <span className="text-2xs text-accent-green px-1.5 py-0.5 rounded border border-accent-green/40">
                              already imported
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-4 font-mono truncate mt-0.5">
                          {d.command} {d.args.join(" ")}
                        </div>
                        {Object.keys(d.env).length > 0 && (
                          <div className="text-2xs text-text-4 mt-0.5">
                            {Object.keys(d.env).length} env var
                            {Object.keys(d.env).length === 1 ? "" : "s"}{" "}
                            inherited
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDiscoverOpen(false);
                    setDiscovered(null);
                    setPicked(new Set());
                    setDiscoverError(null);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void runImport()}
                  disabled={busy || picked.size === 0}
                >
                  Import {picked.size > 0 ? `(${picked.size})` : ""}
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}

      {rows !== null && rows.length === 0 && !adding && (
        <EmptyState
          icon={Plug}
          title="No connections yet"
          size="sm"
          body="Pick one below to add the first, or use Add server for anything else."
        />
      )}

      <Section title="Ready to add">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {MCP_TEMPLATES.map((t) => {
            // Adding a template whose name is already taken can only
            // fail — `mcp_servers_add` refuses to overwrite a config on
            // disk. Say so on the card instead of answering the click
            // with "server 'linear' already exists".
            const added = rows?.some((r) => r.name === t.id) ?? false;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTemplate(t)}
                disabled={added}
                className={cn(
                  "text-left p-2.5 rounded border border-line-soft transition-colors bg-bg-1/40",
                  added
                    ? "opacity-50 cursor-default"
                    : "hover:border-text-4",
                )}
              >
                <div className="flex items-baseline gap-2">
                  <div className="text-base font-medium text-text-1">
                    {t.label}
                  </div>
                  {added && (
                    <span className="text-xs text-accent-green">added</span>
                  )}
                </div>
                {/* Not clamped. What the card is FOR is the line telling
                    you what it needs before you click — clamping cut
                    Atlassian's third variable and GitHub's token name
                    off mid-sentence. */}
                <div className="text-xs text-text-3 mt-1">{t.description}</div>
                <div className="text-xs text-text-4 mt-1 font-mono truncate">
                  {/* Pure-remote templates carry no command; showing the
                      endpoint beats an empty line where every other card
                      has one. */}
                  {t.command
                    ? `${t.command} ${t.args.join(" ")}`
                    : (t.serverUrl ?? "")}
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      {adding && (
        <Section title="Add server">
          <div className="space-y-2.5">
            <Field
              label="Name"
              hint="Becomes the file name under ~/.aura/mcp/. Letters, digits, dashes."
            >
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="atlassian"
                className="h-8 text-sm"
              />
            </Field>
            <Field
              label="Remote URL"
              hint="Optional. For hosted MCP servers. Aura uses its native Streamable HTTP transport and OAuth 2.1 PKCE flow. Leave blank for stdio-only servers."
            >
              <Input
                value={form.serverUrl}
                onChange={(e) =>
                  setForm({ ...form, serverUrl: e.target.value })
                }
                placeholder="https://mcp.atlassian.com/v1/sse"
                className="h-8 text-sm"
              />
            </Field>
            <Field label="Command" hint="Executable Aura spawns. Usually 'npx'. Leave blank for pure-remote servers.">
              <Input
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx"
                className="h-8 text-sm"
              />
            </Field>
            <Field label="Arguments" hint="Space-separated argv passed after the command.">
              <Input
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder="-y @atlassian/mcp-server"
                className="h-8 text-sm"
              />
            </Field>
            <Field
              label="Environment"
              hint="One KEY=VALUE per line. Leave blank to inherit the shell environment only."
            >
              <textarea
                value={form.envText}
                onChange={(e) => setForm({ ...form, envText: e.target.value })}
                rows={4}
                spellCheck={false}
                placeholder={"ATLASSIAN_API_TOKEN=\nATLASSIAN_EMAIL="}
                className="w-full bg-bg-1 border border-line rounded px-2 py-1.5 text-sm font-mono text-text-1 outline-none focus:border-text-4 resize-y"
              />
            </Field>
            <Field label="Description" hint="Optional note shown next to the row.">
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Atlassian Jira + Confluence"
                className="h-8 text-sm"
              />
            </Field>
            {/* Under the fields, above the button that raised it. */}
            {formError && <ErrorNote>{formError}</ErrorNote>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setForm(EMPTY_FORM);
                  setFormError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void submitAdd()}
                disabled={
                  busy ||
                  !form.name.trim() ||
                  (!form.command.trim() && !form.serverUrl.trim())
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Section>
      )}

      {rows && rows.length > 0 && (
        <Section title="Configured servers">
          {/* A toggle or a remove that failed belongs with the rows,
              not in a banner at the top of a pane you've scrolled past. */}
          {rowError && <ErrorNote className="mb-2">{rowError}</ErrorNote>}
          <div className="flex flex-col gap-1">
            {rows.map((row) => {
              const tl = toolsByServer.get(row.name);
              return (
                <McpServerRow
                  key={row.name}
                  row={row}
                  toolList={tl}
                  onToggle={(next) => void onToggle(row.name, next)}
                  onRemove={() => void onRemove(row.name)}
                  onAuth={() => setAuthTarget(row.name)}
                  disabled={busy}
                />
              );
            })}
          </div>
        </Section>
      )}
      {authTarget &&
        (() => {
          const target = rows?.find((r) => r.name === authTarget);
          if (!target) return null;
          return (
            <AuthSetupModal
              server={target}
              onClose={() => setAuthTarget(null)}
              onSaved={async () => {
                setAuthTarget(null);
                await refresh();
                void refreshTools();
                void refreshMcpTools();
              }}
            />
          );
        })()}
    </>
  );
}

function McpServerRow({
  row,
  toolList,
  onToggle,
  onRemove,
  onAuth,
  disabled,
}: {
  row: McpServerEntry;
  toolList: McpServerToolList | undefined;
  onToggle: (next: boolean) => void;
  onRemove: () => void;
  onAuth: () => void;
  disabled: boolean;
}) {
  const probeOk = toolList?.ok ?? null;
  const probeErr = toolList?.ok === false ? toolList.error : null;
  const probeCount = toolList?.tools.length ?? null;

  // Inline native-OAuth CTAs. We only surface these when we KNOW the
  // user can act — `server_url` set means the backend will run native
  // OAuth on click; otherwise the generic Auth button stays the only
  // entry point. "Authenticate now" for first-time auth, escalating to
  // amber "Re-authenticate" once the tools probe spits a 401/expired
  // signal so the row reads as actionable, not just broken.
  const hasRemote = Boolean(row.server_url);
  const needsAuth = hasRemote && !row.has_oauth_token;
  const errBlob = `${row.status ?? ""} ${probeErr ?? ""}`.toLowerCase();
  const tokensRejected =
    hasRemote &&
    row.has_oauth_token &&
    (errBlob.includes("401") ||
      errBlob.includes("unauthor") ||
      errBlob.includes("expired"));
  // A remote server you haven't signed into answers every probe with a
  // 401 — which the row used to label "error" and print verbatim as
  // `http 401 Unauthorized: {"error":"invalid_token",…}`. Nothing is
  // broken and nothing needs fixing: that is exactly the state the
  // Authenticate button next to it exists for. Any OTHER probe failure
  // (bad host, 500, timeout) still gets said out loud.
  const authRefused =
    errBlob.includes("401") ||
    errBlob.includes("unauthor") ||
    errBlob.includes("invalid_token");
  const awaitingAuth = needsAuth && (probeOk !== false || authRefused);

  const statusLabel = !row.enabled
    ? "disabled"
    : awaitingAuth
      ? "not signed in"
      : probeOk === true
        ? `${probeCount ?? 0} tools`
        : probeOk === false
          ? "error"
          : "unknown";
  const statusColor = !row.enabled
    ? "text-text-4"
    : awaitingAuth
      ? "text-amber"
      : probeOk === true
        ? "text-accent-green"
        : probeOk === false
          ? "text-red"
          : "text-text-3";
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-line-soft last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base text-text-1 font-medium truncate">
            {row.name}
          </span>
          <span className={`text-xs ${statusColor}`}>{statusLabel}</span>
          {row.plugin_id && (
            <span
              className="text-xs px-[3px] py-[1.5px] rounded bg-bg-1 text-text-3 border border-line-soft"
              title="Bundled by a plugin. Env + secrets are managed in the Plugins pane"
            >
              plugin
            </span>
          )}
          {row.server_url && (
            <span
              className="text-xs px-[3px] py-[1.5px] rounded bg-bg-1 text-text-3 border border-line-soft"
              title={`Remote transport. Uses HTTP/SSE to ${row.server_url}`}
            >
              remote
            </span>
          )}
          {row.has_oauth_token && (
            <span
              className="text-xs px-[3px] py-[1.5px] rounded bg-accent-green/15 text-accent-green border border-accent-green/30"
              title="OAuth tokens stored in OS keychain"
            >
              authenticated
            </span>
          )}
        </div>
        <div className="text-xs text-text-4 mt-0.5 truncate font-mono">
          {row.command} {row.args.join(" ")}
        </div>
        {row.description && (
          <div className="text-sm text-text-3 mt-0.5 line-clamp-2">
            {row.description}
          </div>
        )}
        {probeErr && !awaitingAuth && (
          <div
            className="text-xs text-red mt-1 break-words"
            title={probeErr}
          >
            {probeErr}
          </div>
        )}
        {awaitingAuth && (
          <div className="text-xs text-text-3 mt-1">
            Authenticate and Aura will keep the tokens for you. Its tools
            stay out of the composer until you do.
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {(() => {
          // ONE auth button per row — label + tone derived from state.
          // Mirrors Claude Code's /mcp drill-in where a server flagged
          // "needs authentication" gets a single Authenticate CTA.
          // Plugin-bundled servers authenticate via the secrets broker
          // in the Plugins pane — no env-edit modal here.
          if (row.plugin_id) {
            return null;
          }
          if (needsAuth) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="A browser window will open for authentication"
                className="px-2 py-0.5 rounded text-xs font-medium border transition-colors text-text-2 border-line hover:bg-state-hover disabled:opacity-40"
              >
                Authenticate
              </button>
            );
          }
          if (tokensRejected) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="Tokens rejected. Refresh required"
                className="px-2 py-0.5 rounded text-xs font-medium border transition-colors text-amber border-amber/40 hover:bg-amber/10 disabled:opacity-40"
              >
                Re-authenticate
              </button>
            );
          }
          if (probeOk === false || (!hasRemote && !row.has_oauth_token)) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="Set up auth. Env or browser flow"
                className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                  probeOk === false
                    ? "text-amber border-amber/40 hover:bg-amber/10"
                    : "text-text-3 border-line-soft hover:text-text-1 hover:border-text-4"
                } disabled:opacity-40`}
              >
                Auth
              </button>
            );
          }
          return null;
        })()}
        <Toggle label="" value={row.enabled} onChange={onToggle} />
        {!row.plugin_id && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            title="Remove server"
            className="p-1 text-text-4 hover:text-red disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

// Wave A — Auth setup modal. For known providers (atlassian, linear,
// github, sentry) it shows per-key labels + hints + a deep link to the
// provider's token page. For unknown servers it falls back to a free-
// form KEY=value textarea so power users aren't blocked.
//
// Wave B (OAuth via mcp-remote): when the configured command points at
// `mcp-remote` or contains an `https://` arg, this modal also renders
// an "Authenticate in browser" path that spawns the proxy interactively
// and watches for the auth URL.
function AuthSetupModal({
  server,
  onClose,
  onSaved,
}: {
  server: McpServerEntry;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const template = useMemo(
    () => matchTemplate(server.name, server.args),
    [server.name, server.args],
  );
  // For known templates we render one field per envKey. We never seed
  // the input with the existing secret value (security — and stops
  // accidental leakage if the user takes a screenshot of this dialog);
  // an empty submission leaves prior values intact (handled backend-
  // side via the merge semantics).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of template?.envKeys ?? []) init[k] = "";
    // Pre-fill non-secret fields (email, domain, org) from existing
    // config — these aren't sensitive and saving the user a re-type is
    // worth the small leakage risk. Secrets stay blank.
    for (const k of template?.envKeys ?? []) {
      if (template?.envSecret?.[k]) continue;
      if (server.env[k]) init[k] = server.env[k];
    }
    return init;
  });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [freeform, setFreeform] = useState<string>(() => {
    // Show existing env in the freeform editor for unknown templates.
    if (template) return "";
    return Object.entries(server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remote = useMemo(() => detectRemote(server), [server]);

  // Wave B — OAuth-via-mcp-remote flow state. Lives alongside the
  // env-paste state so a remote-OAuth server can ALSO have env vars
  // (the proxy itself reads no env, but custom transports might).
  const [authBusy, setAuthBusy] = useState(false);
  const [authLog, setAuthLog] = useState<string[]>([]);
  const [authResult, setAuthResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Native OAuth 2.1 + PKCE state. Shares the per-server
  // `mcp:auth_log:<name>` topic with the mcp-remote piggyback so a
  // single log view shows whichever flow the user kicked off.
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeResult, setNativeResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const runBrowserAuth = useCallback(async () => {
    setAuthBusy(true);
    setAuthLog([]);
    setAuthResult(null);
    setError(null);
    // Subscribe to per-server log + url topics. We unsubscribe in the
    // finally block so a second auth attempt doesn't double-fire.
    const { listen } = await import("@tauri-apps/api/event");
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    let urlOpened = false;
    const unlistenLog = await listen<string>(
      `mcp:auth_log:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, e.payload];
          // Cap to last 200 lines so a runaway proxy doesn't blow the
          // React tree.
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    const unlistenUrl = await listen<string>(
      `mcp:auth_url:${server.name}`,
      (e) => {
        if (urlOpened) return;
        urlOpened = true;
        void openUrl(e.payload).catch((err) => {
          console.warn("openUrl failed:", err);
        });
      },
    );
    try {
      const res = await api.mcpServersAuthRun(server.name);
      if (res.timed_out) {
        setAuthResult({
          ok: false,
          text: "Timed out after 5 minutes. If you completed the browser flow, the token may still be cached. Try Save & retry. Otherwise re-run Authenticate.",
        });
      } else if (res.exit_code === 0) {
        setAuthResult({
          ok: true,
          text: "Auth succeeded. Token cached. Close this dialog and the server will probe green.",
        });
      } else {
        setAuthResult({
          ok: false,
          text: `Proxy exited with code ${res.exit_code ?? "unknown"}. Check the log for details.`,
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlistenLog();
      unlistenUrl();
      setAuthBusy(false);
    }
  }, [server.name]);

  const runNativeOAuth = useCallback(async () => {
    setNativeBusy(true);
    setAuthLog([]);
    setNativeResult(null);
    setError(null);
    const { listen } = await import("@tauri-apps/api/event");
    // The backend opens the browser itself via tauri-plugin-opener,
    // but we still subscribe to `mcp:auth_url` so the log shows the
    // URL inline as a fallback for users who don't see the browser
    // pop (corporate "always-on-top app" / browser sandbox edge case).
    const unlistenLog = await listen<string>(
      `mcp:auth_log:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, e.payload];
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    const unlistenUrl = await listen<string>(
      `mcp:auth_url:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, `[link] ${e.payload}`];
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    try {
      await api.mcpServersOauthStart(server.name);
      setNativeResult({
        ok: true,
        text: "Tokens stored. Aura now holds the OAuth credentials for this server.",
      });
      await onSaved();
    } catch (e) {
      setNativeResult({ ok: false, text: String(e) });
    } finally {
      unlistenLog();
      unlistenUrl();
      setNativeBusy(false);
    }
  }, [server.name, onSaved]);

  const clearOAuthTokens = useCallback(async () => {
    setError(null);
    try {
      await api.mcpServersOauthClear(server.name);
      await onSaved();
    } catch (e) {
      setError(String(e));
    }
  }, [server.name, onSaved]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const env: Record<string, string> = template
        ? { ...values }
        : parseEnvBlock(freeform);
      // Drop empty strings — backend treats them as "clear this key",
      // which would wipe pre-existing values the user didn't intend to
      // touch. Only submit fields the user actually typed into.
      for (const k of Object.keys(env)) {
        if (env[k] === "") delete env[k];
      }
      if (Object.keys(env).length === 0 && template) {
        setError("Paste at least one value, or close the dialog");
        setBusy(false);
        return;
      }
      await api.mcpServersUpdateEnv(server.name, env);
      await onSaved();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const openTokenPage = async () => {
    if (!template?.tokenPageUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(template.tokenPageUrl);
    } catch (e) {
      console.warn("openUrl failed:", e);
      window.open(template.tokenPageUrl, "_blank", "noopener");
    }
  };

  return (
    <div
      className={cn(MODAL_BACKDROP, "z-[10000] flex items-center justify-center")}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={server.name}
    >
      <div
        className={cn(MODAL_PANEL, "max-w-lg max-h-[80vh] flex flex-col")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={cn(MODAL_HEADER, "items-start justify-between gap-3")}>
          <div className="min-w-0">
            <div className={MODAL_TITLE}>{server.name}</div>
            {server.server_url ? (
              <div className="text-text-4 text-sm mt-0.5 truncate font-mono">
                {server.server_url}
              </div>
            ) : (
              <div className="text-text-4 text-sm mt-0.5 truncate font-mono">
                {server.command} {server.args.join(" ")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover"
            aria-label="Close"
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {(() => {
            // Pick ONE flow. Mirror Claude Code's UX: native OAuth is the
            // primary path when we have a remote URL; mcp-remote
            // piggyback covers servers whose discovered config wraps a
            // URL we haven't promoted to `server_url` yet; env paste is
            // only for stdio templates that take an API token.
            const useNative = !!server.server_url;
            const useBrowserPiggyback =
              !useNative && remote.kind !== "none";
            const remoteFlow = useNative || useBrowserPiggyback;
            if (!remoteFlow) return null;
            const busy = useNative ? nativeBusy : authBusy;
            const result = useNative ? nativeResult : authResult;
            const onAuth = useNative ? runNativeOAuth : runBrowserAuth;
            const label = busy
              ? `Authenticating with ${server.name}…`
              : server.has_oauth_token
                ? "Re-authenticate"
                : "Authenticate";
            return (
              <div className="space-y-3">
                <Button
                  type="button"
                  size="lg"
                  onClick={() => void onAuth()}
                  disabled={busy}
                  className="w-full"
                >
                  {busy ? (
                    <AsciiSpinner className="text-sm leading-none" />
                  ) : (
                    <ExternalLink aria-hidden />
                  )}
                  {label}
                </Button>
                <div className="text-text-3 text-sm leading-relaxed">
                  {busy ? (
                    <>
                      A browser window will open for authentication.
                      <br />
                      Return here after authenticating in your browser.
                    </>
                  ) : (
                    <>
                      Clicking Authenticate opens a browser window. Approve
                      the request and Aura will store the tokens in your
                      OS keychain.
                    </>
                  )}
                </div>
                {server.has_oauth_token && !busy && (
                  <button
                    type="button"
                    onClick={() => void clearOAuthTokens()}
                    className="inline-flex items-center gap-1.5 text-sm text-text-4 hover:text-red"
                    title="Delete stored tokens from the OS keychain"
                  >
                    Disconnect
                  </button>
                )}
                {authLog.length > 0 && busy && (
                  <div className="font-mono text-xs text-text-4 bg-bg-1/40 border border-line-soft rounded max-h-28 overflow-y-auto p-2 leading-relaxed">
                    {authLog.slice(-30).map((line, i) => (
                      <div key={i} className="break-all">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                {result && (
                  <div
                    className={
                      result.ok
                        ? "text-accent-green text-sm"
                        : "text-amber text-sm"
                    }
                  >
                    {result.text}
                  </div>
                )}
              </div>
            );
          })()}

          {template && template.envKeys.length > 0 && !server.server_url ? (
            <>
              <div className="text-text-3 text-sm leading-relaxed">
                {template.description}
              </div>
              {template.tokenPageUrl && (
                <button
                  type="button"
                  onClick={() => void openTokenPage()}
                  className="inline-flex items-center gap-1.5 text-sm text-text-2 hover:text-text-1 hover:underline"
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                  Open token page
                </button>
              )}
              {template.envKeys.map((k) => {
                const isSecret = !!template.envSecret?.[k];
                const isRevealed = !!reveal[k];
                const hasExisting = !!server.env[k];
                return (
                  <Field
                    key={k}
                    label={k}
                    hint={template.envHints?.[k]}
                  >
                    <div className="relative">
                      <Input
                        type={
                          isSecret && !isRevealed ? "password" : "text"
                        }
                        value={values[k] ?? ""}
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [k]: e.target.value,
                          }))
                        }
                        placeholder={
                          isSecret && hasExisting
                            ? "(saved. Leave blank to keep)"
                            : ""
                        }
                        className="pr-8"
                      />
                      {isSecret && (
                        <button
                          type="button"
                          onClick={() =>
                            setReveal((prev) => ({
                              ...prev,
                              [k]: !prev[k],
                            }))
                          }
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-text-4 hover:text-text-1"
                          title={isRevealed ? "Hide" : "Reveal"}
                        >
                          {isRevealed ? (
                            <EyeOff className="w-3.5 h-3.5" aria-hidden />
                          ) : (
                            <Eye className="w-3.5 h-3.5" aria-hidden />
                          )}
                        </button>
                      )}
                    </div>
                  </Field>
                );
              })}
            </>
          ) : !server.server_url && remote.kind === "none" ? (
            <>
              <div className="text-text-3 text-sm leading-relaxed">
                This server isn't a known template. Paste any env vars it
                needs as <code>KEY=value</code>, one per line.
              </div>
              <Field
                label="Environment"
                hint="One KEY=value per line. Values are stored as-is at ~/.aura/mcp/<name>.json."
              >
                <textarea
                  value={freeform}
                  onChange={(e) => setFreeform(e.target.value)}
                  rows={6}
                  className="w-full bg-bg-1 border border-line-soft rounded px-2 py-1.5 text-sm text-text-1 font-mono"
                  placeholder="ATLASSIAN_API_TOKEN=…"
                />
              </Field>
            </>
          ) : null}

          {error && (
            <div className="text-red text-sm" role="alert">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={MODAL_FOOTER}>
          <Button
            size="xs"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            {server.server_url || remote.kind !== "none" ? "Close" : "Cancel"}
          </Button>
          {!(server.server_url || remote.kind !== "none") &&
            template &&
            template.envKeys.length > 0 && (
              <Button
                size="xs"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy && (
                  <AsciiSpinner className="text-sm leading-none mr-1.5" />
                )}
                Save & retry
              </Button>
            )}
          {!(server.server_url || remote.kind !== "none") &&
            !template && (
              <Button
                size="xs"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy && (
                  <AsciiSpinner className="text-sm leading-none mr-1.5" />
                )}
                Save & retry
              </Button>
            )}
        </div>
      </div>
    </div>
  );
}

// Wave B helper — classifies an MCP server as a remote-OAuth flavour
// based on command shape. `mcp-remote` is the canonical npm proxy
// shipped by Anthropic for browser-OAuth-gated remote MCPs (Atlassian
// remote, Notion remote, etc); plain `https://` first-arg matches the
// MCP-spec native remote transport. `none` means stdio with env vars
// only — the env-paste path is the right one.
function detectRemote(
  server: McpServerEntry,
): { kind: "none" | "mcp-remote" | "remote-url"; url?: string } {
  const allArgs = server.args.join(" ").toLowerCase();
  if (allArgs.includes("mcp-remote")) {
    const httpsArg = server.args.find((a) => a.startsWith("https://"));
    return { kind: "mcp-remote", url: httpsArg };
  }
  const remoteArg = server.args.find((a) => a.startsWith("https://"));
  if (remoteArg) return { kind: "remote-url", url: remoteArg };
  return { kind: "none" };
}

/** Parse "KEY=value" lines from the textarea into a string-string map.
 *  Blank lines + lines without `=` are skipped; values keep their literal
 *  text (no shell expansion). */
function parseEnvBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}
