// Settings → Agents pane.
//
// The installed coding CLIs — which are on this machine, which is the
// default, and the per-agent overrides (binary path, extra args, env)
// that `~/.aura/agents.toml` carries. Editing a row here is the same
// write the CLI makes, so a change lands for every surface that starts
// an agent.

import { useEffect, useMemo, useState } from "react";
import { Download, Pin, Upload } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field as FormField } from "../ui/field";
import { FullscreenOverlay } from "../FullscreenOverlay";
import {
  api,
  type AgentConfigSyncStatus,
  type AgentDescriptor,
  type AgentInstallHealth,
  type AgentsTomlEntry,
} from "../../lib/api";
import { AgentIcon } from "../agent/AgentIcon";
import { usePinned } from "../../lib/agentPrefs";
import { MANAGER_AGENT } from "../../lib/agents";
import { AURA_MANAGER_ENABLED } from "../../lib/featureFlags";
import {
  Card,
  ConnectionStatus,
  KeyValueTable,
  PaneIntro,
  Section,
  Toggle,
} from "../settings/kit";
import { askConfirm } from "../ui/ask";

export function AgentsTab() {
  const [registry, setRegistry] = useState<AgentDescriptor[]>([]);
  const [tomlEntries, setTomlEntries] = useState<AgentsTomlEntry[]>([]);
  const [installs, setInstalls] = useState<AgentInstallHealth[]>([]);
  const [editing, setEditing] = useState<AgentsTomlEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<AgentConfigSyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState<"push" | "pull" | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const reload = async () => {
    setBusy(true);
    try {
      const [reg, toml] = await Promise.all([
        api.agentsList(),
        api.settingsAgentsTomlList(),
      ]);
      setRegistry(reg);
      setTomlEntries(toml);
    } finally {
      setBusy(false);
    }
    // Separate from the two above: it spawns a process per copy of every
    // agent binary on PATH, so it must never hold up the list rendering.
    try {
      setInstalls(await api.agentsInstallsGet());
    } catch {
      setInstalls([]);
    }
  };
  useEffect(() => {
    reload();
    void refreshSyncStatus();
  }, []);

  async function refreshSyncStatus() {
    try {
      const status = await api.settingsAgentConfigsStatus();
      setSyncStatus(status);
      setSyncError(status.error);
    } catch (e) {
      setSyncError(String(e));
    }
  }

  async function pushAgentConfigs() {
    setSyncBusy("push");
    setSyncError(null);
    setSyncMessage(null);
    try {
      const status = await api.settingsAgentConfigsPush();
      setSyncStatus(status);
      const suffix = status.remoteFiles.length === 1 ? "" : "s";
      setSyncMessage(
        status.remoteFiles.length > 0
          ? `Uploaded ${status.remoteFiles.length} redacted configuration file${suffix}.`
          : "Uploaded an empty configuration bundle; no supported local files were found.",
      );
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncBusy(null);
    }
  }

  async function pullAgentConfigs() {
    if (
      !(await askConfirm({
        title: "Apply the cloud copy on this machine?",
        body: "Aura backs up every existing file beside the original before replacing it.",
        confirmLabel: "Apply",
      }))
    ) {
      return;
    }
    setSyncBusy("pull");
    setSyncError(null);
    setSyncMessage(null);
    try {
      const result = await api.settingsAgentConfigsPull();
      setSyncStatus(result.status);
      const fileSuffix = result.applied.length === 1 ? "" : "s";
      const backupSuffix = result.backups.length === 1 ? "" : "s";
      setSyncMessage(
        `Applied ${result.applied.length} configuration file${fileSuffix}${
          result.backups.length > 0
            ? ` and created ${result.backups.length} backup${backupSuffix}`
            : ""
        }.`,
      );
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncBusy(null);
    }
  }

  const reloadProviders = async () => {
    setBusy(true);
    try {
      const reg = await api.agentsReload();
      setRegistry(reg);
    } finally {
      setBusy(false);
    }
  };

  // Distinguish compiled-in vs TOML-declared so the user knows which
  // they can edit. TOML ids show up in `tomlEntries`; everything else
  // is compiled in (claude / gemini / codex / cursor / kimi).
  const tomlIds = useMemo(() => new Set(tomlEntries.map((e) => e.id)), [
    tomlEntries,
  ]);

  // Which agents lead the "+" menu. The quick-launch BAR these pins used to
  // fill is gone — it was a full-width band of agent pills stacked directly
  // above the tab strip, carrying the same names and icons as the tabs 32px
  // below it. Its rows are now the "+" menu on the tab strip itself, which
  // has room for every installed agent, so a pin no longer decides whether an
  // agent is reachable — only whether it leads the list.
  const { isPinned, toggle: togglePin } = usePinned();

  const missingCount = useMemo(
    () => registry.filter((p) => !p.available).length,
    [registry],
  );

  return (
    <>
      <PaneIntro text="The coding agents Aura can drive on this machine. Pin the ones you use most and they lead the “+” menu on the tab strip." />
      <div className="mb-3.5 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("aura:open-onboarding"))
          }
        >
          Replay onboarding
        </Button>
        {/* "Reload" read as reloading the app. It re-checks this machine for
            the agents below. */}
        <Button
          variant="ghost"
          size="xs"
          onClick={reloadProviders}
          disabled={busy}
        >
          {busy ? <AsciiSpinner className="text-xs leading-none" /> : null}
          Look again
        </Button>
        <div className="flex-1" />
        <Button
          variant="default"
          size="xs"
          onClick={() => setEditing(blankEntry())}
        >
          + Add an agent
        </Button>
      </div>
      <Card>
        {registry.map((p) => (
          <AgentRow
            key={p.id}
            descriptor={p}
            install={installs.find((i) => i.agent_id === p.id)}
            isTomlDeclared={tomlIds.has(p.id)}
            tomlEntry={tomlEntries.find((e) => e.id === p.id)}
            pinned={isPinned(p.id)}
            onTogglePin={() => togglePin(p.id)}
            onEdit={(e) => setEditing(e)}
            onRemove={async () => {
              if (
                !(await askConfirm({
                  title: `Remove the TOML override for ${p.id}?`,
                  body: "That agent goes back to the settings Aura ships with.",
                  confirmLabel: "Remove",
                  tone: "danger",
                }))
              )
                return;
              await api.settingsAgentsTomlRemove(p.id);
              await reload();
              await reloadProviders();
            }}
          />
        ))}
        {tomlEntries
          .filter((e) => !registry.some((r) => r.id === e.id))
          .map((e) => (
            <div
              key={e.id}
              className="py-2 text-sm text-amber"
            >
              {e.id}. You declared this one in ~/.aura/agents.toml, but Aura
              hasn’t picked it up yet. Press “Look again”.
            </div>
          ))}
      </Card>
      {/* The four agents Aura can't find used to say nothing at all beyond a
          grey dot, and what they had to say was the same thing four times.
          Once, under the list, in the place you'd read it. */}
      {missingCount > 0 && (
        <p className="mt-2.5 text-xs leading-snug text-text-3">
          {missingCount === 1
            ? "One of these isn’t on this machine yet."
            : `${missingCount} of these aren’t on this machine yet.`}{" "}
          Nothing is broken. Install the tool the usual way, then press “Look
          again” and Aura will pick it up.
        </p>
      )}
      <Section title="Order in the New-tab menu">
        {/* Aura itself is not in the CLI registry above — it is built in, not
            discovered on PATH — so it needs its own row here. */}
        {AURA_MANAGER_ENABLED && (
          <Toggle
            label="Put Aura first"
            hint="Aura is the orchestrator that fans work out to the other agents. Everything installed is still listed below the pinned ones."
            value={isPinned(MANAGER_AGENT.id)}
            onChange={() => togglePin(MANAGER_AGENT.id)}
          />
        )}
      </Section>
      <Section title="Cross-machine configuration">
        <div className="text-xs leading-relaxed text-text-3">
          Carry Claude Code, Codex, and Gemini CLI preferences through your
          Aura account. Only <code>settings.json</code> and{" "}
          <code>config.toml</code> are eligible; API keys, tokens, passwords,
          OAuth state, and authentication files are stripped or never read.
        </div>
        {/* Whether we can reach the account at all is the fact both rows
            below depend on, so it is stated once above them — with a way to
            ask again, which this pane had no button for: the status was read
            once on mount and then went stale until you left and came back. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <ConnectionStatus
            state={syncStatus?.signedIn ? "connected" : "disconnected"}
            label={
              syncStatus?.signedIn
                ? "Signed in to Aura Cloud"
                : "Sign in to Aura Cloud to sync"
            }
            onRefresh={() => void refreshSyncStatus()}
          />
        </div>
        <div className="mt-2.5">
          <KeyValueTable
            rows={[
              {
                key: "local",
                label: "This machine",
                mono: !!syncStatus?.localFiles.length,
                value: syncStatus?.localFiles.length
                  ? syncStatus.localFiles.join(" · ")
                  : "No supported config files found",
              },
              {
                key: "remote",
                label: "Cloud copy",
                value: !syncStatus?.signedIn
                  ? "Not synced"
                  : syncStatus.remoteUpdatedAt
                    ? `${syncStatus.remoteFiles.length} file${
                        syncStatus.remoteFiles.length === 1 ? "" : "s"
                      } · ${syncStatus.remoteSourceDevice ?? "unknown device"} · ${new Date(
                        syncStatus.remoteUpdatedAt,
                      ).toLocaleString()}`
                    : "Not uploaded yet",
              },
            ]}
          />
        </div>
        {syncError && (
          <div className="mt-2 text-xs text-red" role="alert">
            {syncError}
          </div>
        )}
        {syncMessage && (
          <div className="mt-2 text-xs text-green">{syncMessage}</div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            disabled={!syncStatus?.signedIn || syncBusy !== null}
            onClick={() => void pushAgentConfigs()}
          >
            {syncBusy === "push" ? (
              <AsciiSpinner className="text-xs leading-none" />
            ) : (
              <Upload size={12} />
            )}
            Upload this machine
          </Button>
          <Button
            variant="secondary"
            size="xs"
            disabled={
              !syncStatus?.signedIn ||
              !syncStatus.remoteUpdatedAt ||
              syncBusy !== null
            }
            onClick={() => void pullAgentConfigs()}
          >
            {syncBusy === "pull" ? (
              <AsciiSpinner className="text-xs leading-none" />
            ) : (
              <Download size={12} />
            )}
            Apply cloud copy
          </Button>
        </div>
      </Section>
      {editing && (
        <AgentEditor
          entry={editing}
          onCancel={() => setEditing(null)}
          onSave={async (entry) => {
            await api.settingsAgentsTomlUpsert(entry);
            setEditing(null);
            await reload();
            await reloadProviders();
          }}
        />
      )}
    </>
  );
}

/** Shortens a home-directory path to `~/…` so it stays readable in a narrow
 *  row. The webview has no HOME, so this reads the shape out of the path
 *  itself and leaves anything else untouched. Cosmetic only — the row's
 *  title attribute always carries the real path. */
function tildePath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

/** The endless-update-nag explainer. Shown only when a newer copy of the
 *  agent exists but nothing can reach it — the case where the CLI's own
 *  "please update" prompt can never clear, because the update lands in a
 *  folder the shell looks past or has never been told about. */
function ShadowedInstallNotice({ health }: { health: AgentInstallHealth }) {
  const running = health.running;
  const newer = health.shadowed.find((s) => s.version === health.newest_version);
  // Installed, but only where the shell can't reach it — the row above would
  // otherwise just say "not found" and leave the user hunting for a copy
  // that is sitting right there.
  if (!running && health.shadowed.length > 0) {
    const found = health.shadowed[0];
    const dir = found.path.slice(0, found.path.lastIndexOf("/")) || "/";
    return (
      <div className="mt-1.5 rounded-md border border-amber/30 bg-amber/5 px-2 py-1.5 text-[10.5px] leading-relaxed text-text-2">
        {health.bin} is installed at{" "}
        <span className="font-mono text-amber" title={found.path}>
          {tildePath(found.path)}
        </span>
        , but your shell never searches that folder, so nothing can run it. Add{" "}
        <span className="font-mono">{tildePath(dir)}</span> to your PATH, or reinstall it into a
        folder that is already there.
      </div>
    );
  }
  if (!running || !newer) return null;
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  return (
    <div className="mt-1.5 rounded-md border border-amber/30 bg-amber/5 px-2 py-1.5 text-[10.5px] leading-relaxed text-text-2">
      <div>
        This machine runs{" "}
        <span className="font-mono text-amber">{running.version ?? "an unknown version"}</span> of{" "}
        {health.bin}, but <span className="font-mono text-amber">{newer.version}</span> is already
        installed
        {newer.on_path
          ? " further down the list of folders your shell searches"
          : " in a folder your shell never searches"}
        . That is why {health.bin} keeps asking you to update and the update never sticks.
      </div>
      <div className="mt-1 font-mono text-text-4" title={`${running.path}\n${newer.path}`}>
        runs {tildePath(running.path)} · newer copy {tildePath(newer.path)}
      </div>
      <div className="mt-1">
        Install it into <span className="font-mono">{tildePath(dirOf(running.path))}</span> instead,
        or put <span className="font-mono">{tildePath(dirOf(newer.path))}</span> ahead of it in your
        PATH.
      </div>
    </div>
  );
}

function AgentRow({
  descriptor,
  install,
  isTomlDeclared,
  tomlEntry,
  pinned,
  onTogglePin,
  onEdit,
  onRemove,
}: {
  descriptor: AgentDescriptor;
  install: AgentInstallHealth | undefined;
  isTomlDeclared: boolean;
  tomlEntry: AgentsTomlEntry | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  onEdit: (entry: AgentsTomlEntry) => void;
  onRemove: () => void;
}) {
  // `pty` was true of all ten agents in the registry and `stream` of one:
  // a column of flags that never varies is not information, and these are
  // engine words besides. They belong to the row, not to the reader, so
  // they moved into its tooltip alongside the id and the binary Aura runs.
  const caps = [
    descriptor.capabilities.stream && "streams its output as it works",
    descriptor.capabilities.pty && "runs in a real terminal",
    descriptor.capabilities.resume && "can reopen a past session",
  ].filter(Boolean) as string[];
  // A `--version` that begins or ends by naming the tool is naming it a
  // second time on a row that is already called that: `claude --version`
  // answers "2.1.220 (Claude Code)", `codex --version` answers
  // "codex-cli 0.128.0".
  const version = descriptor.version
    ?.replace(/\s*\(([^)]+)\)\s*$/, (m, inner: string) =>
      inner.trim().toLowerCase() === descriptor.label.toLowerCase() ? "" : m,
    )
    .replace(/^(\S+)\s+(?=\d)/, (m, first: string) =>
      first.toLowerCase().replace(/-cli$/, "") === descriptor.id.toLowerCase()
        ? ""
        : m,
    )
    .trim();
  const detail = [
    descriptor.available
      ? `Aura runs: ${descriptor.bin}`
      : `Aura looks for “${descriptor.bin}” on this machine and doesn’t find it.`,
    `Known to Aura as: ${descriptor.id}`,
    caps.length > 0 ? `It ${caps.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="py-2">
    <div className="flex items-center gap-2.5" title={detail}>
      <AgentIcon agentId={descriptor.id} label={descriptor.label} size={16} />
      <span
        className={`min-w-0 truncate text-base ${
          descriptor.available ? "text-text-1" : "text-text-3"
        }`}
      >
        {descriptor.label}
      </span>
      {/* One fact each, and it is the one that differs between rows: a found
          agent proves it by naming its version; a missing one says so in a
          word. The green/grey dot that used to carry this said it in a
          colour nobody had been taught. */}
      {descriptor.available
        ? version && (
            <span className="shrink-0 text-xs text-text-4">{version}</span>
          )
        : (
          <span className="shrink-0 text-xs text-text-4">Not installed</span>
        )}
      {isTomlDeclared && (
        <span
          className="shrink-0 text-xs text-text-4"
          title="You declared this one yourself, in ~/.aura/agents.toml"
        >
          Yours
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {isTomlDeclared && tomlEntry && (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onEdit(tomlEntry)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={onRemove}
              className="text-red hover:text-red"
            >
              Remove
            </Button>
          </>
        )}
        {/* Only offered for agents actually on this machine — putting one
            Aura cannot start at the top of the menu is an invitation to a
            failure. */}
        {descriptor.available && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={
              pinned
                ? `${descriptor.label} leads the New-tab menu`
                : `Put ${descriptor.label} at the top of the New-tab menu`
            }
            title={
              pinned
                ? `${descriptor.label} leads the New-tab menu. Click to unpin it.`
                : `Put ${descriptor.label} at the top of the New-tab menu`
            }
            className="rounded p-1 transition-colors hover:bg-state-hover"
            style={{
              color: pinned ? "var(--color-blue)" : "var(--color-text-4)",
            }}
          >
            <Pin size={13} className={pinned ? "fill-current" : undefined} />
          </button>
        )}
      </div>
    </div>
    {install?.stale && <ShadowedInstallNotice health={install} />}
    </div>
  );
}

function AgentEditor({
  entry,
  onCancel,
  onSave,
}: {
  entry: AgentsTomlEntry;
  onCancel: () => void;
  onSave: (entry: AgentsTomlEntry) => void;
}) {
  const [draft, setDraft] = useState<AgentsTomlEntry>(entry);
  const [argsText, setArgsText] = useState(
    (draft.args ?? []).join(" "),
  );
  const isNew = !entry.id;
  const apply = () => {
    onSave({
      ...draft,
      args: tokenize(argsText),
      supports_stream: !!draft.supports_stream,
      supports_pty: !!draft.supports_pty,
      supports_resume: !!draft.supports_resume,
    });
  };
  const saveDisabled = !draft.id.trim() || !draft.bin.trim();
  return (
    <FullscreenOverlay
      onClose={onCancel}
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={apply}
            disabled={saveDisabled}
          >
            {isNew ? "Add agent" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center px-6 py-12 sm:py-16">
        <div className="flex w-full max-w-[640px] flex-col gap-8">
          <div>
            <h1 className="text-xl font-medium leading-7 text-text-1">
              {isNew ? "New coding agent" : `Edit ${entry.label || entry.id}`}
            </h1>
            <p className="mt-1.5 text-base leading-relaxed text-text-3">
              Declare a command-line coding agent Aura can drive. Saved to{" "}
              <code className="font-mono text-text-2">~/.aura/agents.toml</code>{" "}. Aura launches it exactly like the built-in providers.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                label="ID"
                htmlFor="ae-id"
                description="Stable, lowercase. Examples: kimi, devstral."
              >
                <Input
                  id="ae-id"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  disabled={!isNew}
                  placeholder="kimi"
                  className="font-mono"
                />
              </FormField>
              <FormField
                label="Label"
                htmlFor="ae-label"
                description="The friendly name shown in the agent picker."
              >
                <Input
                  id="ae-label"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="Kimi"
                />
              </FormField>
            </div>

            <FormField
              label="Binary"
              htmlFor="ae-bin"
              description="Path or PATH-resolvable name. E.g. /opt/kimi or just kimi."
            >
              <Input
                id="ae-bin"
                value={draft.bin}
                onChange={(e) => setDraft({ ...draft, bin: e.target.value })}
                placeholder="kimi"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Args"
              htmlFor="ae-args"
              description="Tokens, space-separated. Use {prompt} for the message and optional {resume} for a session id."
            >
              <Input
                id="ae-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="chat --prompt {prompt}"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Capabilities"
              description="What this agent's CLI supports. Aura adapts how it drives the process."
            >
              <div className="divide-y divide-line-soft rounded-lg bg-bg-content px-3.5 shadow-[var(--shadow-field)]">
                <Toggle
                  label="Streaming output"
                  hint="The CLI streams tokens as it generates, instead of one final block."
                  value={!!draft.supports_stream}
                  onChange={(v) => setDraft({ ...draft, supports_stream: v })}
                />
                <Toggle
                  label="Interactive terminal (PTY)"
                  hint="Runs as a full TUI inside a pseudo-terminal."
                  value={!!draft.supports_pty}
                  onChange={(v) => setDraft({ ...draft, supports_pty: v })}
                />
                <Toggle
                  label="Resume sessions"
                  hint="Can pick up a previous session by id."
                  value={!!draft.supports_resume}
                  onChange={(v) => setDraft({ ...draft, supports_resume: v })}
                />
              </div>
            </FormField>
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function blankEntry(): AgentsTomlEntry {
  return {
    id: "",
    label: "",
    bin: "",
    args: [],
    supports_stream: false,
    supports_pty: true,
    supports_resume: false,
  };
}

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
