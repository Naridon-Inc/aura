// Which Jira project mirrors into which Aura repo. The one part of a tracker
// connection that is per-repository rather than per-machine, which is why it
// takes the active repo root as a prop and sits under the list, not in it.

import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plug, RefreshCw } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { askConfirm } from "../../ui/ask";
import { SettingsActions, SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { SettingsServiceTitle } from "../../ui/settings-services-row";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import { shortPath } from "../../../lib/paths";
import {
  integrationsApi,
  type ConnectionStatus,
  type JiraProject,
  type MirrorSummary,
  type SyncOutcome,
} from "../../../lib/integrationsApi";
import { timeAgo } from "./trackerParts";

type Site = NonNullable<ConnectionStatus["sites"]>[number];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// One mirror = (site, project) → local repo binding. The picker is
// per-site so multi-site users can mirror projects from each Atlassian
// instance independently. Project lists are lazy-loaded the first time a
// site's picker is touched — keeping the initial settings render cheap.
export function MirrorsSection({
  sites,
  mirrors,
  autoMirrorRepoRoot,
  repoRoot,
  onStatusUpdate,
}: {
  sites: Site[];
  mirrors: MirrorSummary[];
  autoMirrorRepoRoot: string | null;
  repoRoot: string;
  onStatusUpdate: (next: ConnectionStatus) => void;
}) {
  const autoOn = !!autoMirrorRepoRoot;
  // Cache projects per cloud_id so re-opening the picker is instant
  // and switching between sites doesn't re-fetch a list we already have.
  const [projectsBySite, setProjectsBySite] = useState<Record<string, JiraProject[]>>({});
  const [loadingSite, setLoadingSite] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Record<string, string>>({});
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [recentSync, setRecentSync] = useState<Record<string, SyncOutcome>>({});
  // The section keeps its own error so a failed mirror shows next to the
  // controls that caused it, not up on the Jira row.
  const [error, setError] = useState<string | null>(null);

  const remember = useCallback((outcomes: SyncOutcome[]) => {
    setRecentSync((prev) => {
      const next = { ...prev };
      for (const o of outcomes) next[o.project_key] = o;
      return next;
    });
  }, []);

  // Subscribe to background-poller emissions so the last-sync line
  // updates without waiting for a settings refresh. Keyed by project_key
  // so it renders even if the user hasn't touched the project picker.
  useEffect(() => {
    let stop: UnlistenFn | null = null;
    void listen<SyncOutcome[]>("aura:integrations:jira:synced", (e) => remember(e.payload)).then(
      (unlisten) => {
        stop = unlisten;
      },
    );
    return () => {
      if (stop) stop();
    };
  }, [remember]);

  /** Run one operation with the busy key set and the error cleared first. */
  const run = useCallback(async (op: string, work: () => Promise<void>) => {
    setBusyOp(op);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyOp(null);
    }
  }, []);

  const ensureProjects = useCallback(
    async (cloudId: string) => {
      if (projectsBySite[cloudId] || loadingSite === cloudId) return;
      setLoadingSite(cloudId);
      setError(null);
      try {
        const rows = await integrationsApi.jiraProjects(cloudId);
        setProjectsBySite((prev) => ({ ...prev, [cloudId]: rows }));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingSite(null);
      }
    },
    [projectsBySite, loadingSite],
  );

  const handleMirror = (cloudId: string) => {
    const projectKey = selectedProject[cloudId];
    if (!projectKey) return;
    const project = projectsBySite[cloudId]?.find((p) => p.key === projectKey);
    if (!project) return;
    void run(`mirror:${cloudId}:${projectKey}`, async () => {
      const next = await integrationsApi.jiraMirrorSet({
        cloudId,
        projectKey,
        projectName: project.name,
        repoRoot,
      });
      onStatusUpdate(next);
      setSelectedProject((prev) => ({ ...prev, [cloudId]: "" }));
    });
  };

  const handleUnmirror = (m: MirrorSummary) =>
    void run(`unmirror:${m.cloud_id}:${m.project_key}`, async () => {
      onStatusUpdate(
        await integrationsApi.jiraMirrorUnset({ cloudId: m.cloud_id, projectKey: m.project_key }),
      );
    });

  const handleAutoMirrorToggle = (turnOn: boolean) =>
    void run("auto-mirror", async () => {
      onStatusUpdate(
        turnOn
          ? await integrationsApi.jiraAutoMirrorEnable(repoRoot)
          : await integrationsApi.jiraAutoMirrorDisable(),
      );
    });

  const handleSyncAll = () =>
    void run("sync:all", async () => remember(await integrationsApi.jiraSyncNow({ repoRoot })));

  const handleBackfill = async () => {
    // Confirm because this can be a long-running full re-pull and
    // generates upstream API load against the user's Jira quota.
    const ok = await askConfirm({
      title: `Re-pull every issue for ${plural(mirrors.length, "mirrored project")}?`,
      body: "Use this when parent/epic links or other fields look wrong. It clears the incremental cache and walks each project from scratch. Existing tasks keep their IDs.",
      confirmLabel: "Re-pull everything",
    });
    if (!ok) return;
    void run("backfill:all", async () => remember(await integrationsApi.jiraBackfill({ repoRoot })));
  };

  const syncing = busyOp === "sync:all" || busyOp === "backfill:all";

  return (
    <SettingsSection title="Jira projects">
      <SettingsRow
        title="Auto-mirror every project into this repo"
        htmlFor="jira-auto-mirror"
        description={
          autoOn
            ? `On · ${plural(mirrors.length, "project")} across ${plural(sites.length, "site")}. New Jira projects appear here within 5 min.`
            : "Off. Pick projects manually below, or turn this on to import everything and keep it in sync with Jira."
        }
        control={
          <SettingsActions>
            {busyOp === "auto-mirror" && <AsciiSpinner />}
            <Switch
              id="jira-auto-mirror"
              checked={autoOn}
              disabled={busyOp === "auto-mirror"}
              onCheckedChange={handleAutoMirrorToggle}
            />
          </SettingsActions>
        }
      />

      {sites.map((s) => (
        <SiteRow
          key={s.cloud_id}
          site={s}
          autoOn={autoOn}
          projects={(projectsBySite[s.cloud_id] ?? []).filter(
            (p) => !mirrors.some((m) => m.cloud_id === s.cloud_id && m.project_key === p.key),
          )}
          loading={loadingSite === s.cloud_id}
          selected={selectedProject[s.cloud_id] ?? ""}
          busy={busyOp === `mirror:${s.cloud_id}:${selectedProject[s.cloud_id] ?? ""}`}
          onWant={() => void ensureProjects(s.cloud_id)}
          onSelect={(key) => setSelectedProject((prev) => ({ ...prev, [s.cloud_id]: key }))}
          onMirror={() => handleMirror(s.cloud_id)}
        />
      ))}

      {mirrors.length === 0 ? (
        <SettingsEmpty>
          No projects mirrored yet. Pick a project above to import its issues into
          this repo's Tasks.
        </SettingsEmpty>
      ) : (
        <>
          {mirrors.map((m) => (
            <MirrorRow
              key={`${m.cloud_id}:${m.project_key}`}
              mirror={m}
              outcome={recentSync[m.project_key]}
              busy={busyOp === `unmirror:${m.cloud_id}:${m.project_key}`}
              onRemove={() => handleUnmirror(m)}
            />
          ))}
          <SettingsRow
            title="Sync mirrored projects"
            description="Pull what changed in Jira onto this repo's Tasks. Re-sync from scratch clears the incremental cache and re-pulls every issue — use it when parent or epic links look wrong."
            control={
              <SettingsActions>
                <Button variant="outline" size="sm" onClick={() => void handleBackfill()} disabled={syncing}>
                  {busyOp === "backfill:all" ? <AsciiSpinner /> : <RefreshCw />}
                  Re-sync from scratch
                </Button>
                <Button variant="outline" size="sm" onClick={handleSyncAll} disabled={syncing} title={`Sync every mirror targeting ${repoRoot}`}>
                  {busyOp === "sync:all" ? <AsciiSpinner /> : <RefreshCw />}
                  Sync now
                </Button>
              </SettingsActions>
            }
          />
        </>
      )}

      {error && <SettingsError>{error}</SettingsError>}
    </SettingsSection>
  );
}

/** One Atlassian site: where it lives, and — unless auto-mirror already
 *  takes every project — a picker for the next one to mirror. */
function SiteRow({
  site,
  autoOn,
  projects,
  loading,
  selected,
  busy,
  onWant,
  onSelect,
  onMirror,
}: {
  site: Site;
  autoOn: boolean;
  projects: JiraProject[];
  loading: boolean;
  selected: string;
  busy: boolean;
  onWant: () => void;
  onSelect: (key: string) => void;
  onMirror: () => void;
}) {
  return (
    <SettingsRow
      title={
        <a
          className="ui-settings-service-link"
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onExternalAnchorClick}
        >
          {site.name}
        </a>
      }
      description={site.url.replace(/^https?:\/\//, "")}
      control={
        autoOn ? null : (
          <SettingsActions>
            {/* The picker loads this site's projects the first time it is
                touched, by pointer or keyboard, so opening settings never
                waits on Jira. */}
            <span onPointerDownCapture={onWant} onFocus={onWant}>
              <Select
                aria-label={`Project to mirror from ${site.name}`}
                value={selected}
                onChange={onSelect}
                placeholder={loading ? "Loading projects…" : "Choose a project to mirror…"}
                options={projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))}
              />
            </span>
            <Button size="sm" onClick={onMirror} disabled={!selected || busy}>
              {busy ? <AsciiSpinner /> : <Plug />}
              Mirror
            </Button>
          </SettingsActions>
        )
      }
    />
  );
}

/** A mirrored project: which repo it lands in and how its last sync went. */
function MirrorRow({
  mirror: m,
  outcome,
  busy,
  onRemove,
}: {
  mirror: MirrorSummary;
  outcome: SyncOutcome | undefined;
  busy: boolean;
  onRemove: () => void;
}) {
  const lastSyncedAt = outcome?.synced_at ?? m.last_synced_at ?? null;
  const created = outcome?.created ?? m.last_sync_created ?? 0;
  const updated = outcome?.updated ?? m.last_sync_updated ?? 0;
  const errors = outcome?.errors.length ?? m.last_sync_errors ?? 0;
  const sync = lastSyncedAt
    ? `Synced ${timeAgo(lastSyncedAt)} · ${created} created · ${updated} updated${
        errors > 0 ? ` · ${plural(errors, "error")}` : ""
      }`
    : "Never synced";

  return (
    <SettingsRow
      title={
        <SettingsServiceTitle mark={<Badge variant="outline">{m.project_key}</Badge>}>
          {m.project_name}
        </SettingsServiceTitle>
      }
      description={
        <span
          title={lastSyncedAt ? `Last sync: ${new Date(lastSyncedAt * 1000).toLocaleString()}` : undefined}
        >
          → {shortPath(m.repo_root)} · {sync}
        </span>
      }
      control={
        <Button variant="outlineDestructive" size="sm" onClick={onRemove} disabled={busy}>
          {busy && <AsciiSpinner />}
          Remove
        </Button>
      }
    />
  );
}
