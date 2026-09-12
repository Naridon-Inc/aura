// Which Jira project mirrors into which Aura repo. The one part of a tracker
// connection that is per-repository rather than per-machine, which is why it
// takes the active repo root as a prop.

import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plug, RefreshCw, Trash2 } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { askConfirm } from "../../ui/ask";
import { shortPath } from "../../../lib/paths";
import {
  integrationsApi,
  type ConnectionStatus,
  type JiraProject,
  type MirrorSummary,
  type SyncOutcome,
} from "../../../lib/integrationsApi";
import { timeAgo } from "./trackerParts";

// One mirror = (site, project) → local repo binding. The picker is
// per-site so multi-site users can mirror projects from each Atlassian
// instance independently. Project lists are lazy-loaded on first focus
// of the dropdown — keeping the initial settings render cheap.
export function MirrorsSection({
  sites,
  mirrors,
  autoMirrorRepoRoot,
  repoRoot,
  onStatusUpdate,
  onError,
}: {
  sites: NonNullable<ConnectionStatus["sites"]>;
  mirrors: MirrorSummary[];
  autoMirrorRepoRoot: string | null;
  repoRoot: string;
  onStatusUpdate: (next: ConnectionStatus) => void;
  onError: (msg: string | null) => void;
}) {
  const autoOn = !!autoMirrorRepoRoot;
  // Cache projects per cloud_id so re-opening the dropdown is instant
  // and switching between sites doesn't re-fetch a list we already have.
  const [projectsBySite, setProjectsBySite] = useState<
    Record<string, JiraProject[]>
  >({});
  const [loadingSite, setLoadingSite] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<
    Record<string, string>
  >({});
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [recentSync, setRecentSync] = useState<Record<string, SyncOutcome>>({});

  // Subscribe to background-poller emissions so the last-sync chip
  // updates without waiting for a settings refresh. Keyed by project_key
  // so the chip renders even if the user hasn't expanded the project picker.
  useEffect(() => {
    let stop: UnlistenFn | null = null;
    void listen<SyncOutcome[]>("aura:integrations:jira:synced", (e) => {
      setRecentSync((prev) => {
        const next = { ...prev };
        for (const o of e.payload) next[o.project_key] = o;
        return next;
      });
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => {
      if (stop) stop();
    };
  }, []);

  const ensureProjects = useCallback(
    async (cloudId: string) => {
      if (projectsBySite[cloudId]) return;
      setLoadingSite(cloudId);
      onError(null);
      try {
        const rows = await integrationsApi.jiraProjects(cloudId);
        setProjectsBySite((prev) => ({ ...prev, [cloudId]: rows }));
      } catch (e) {
        onError(String(e));
      } finally {
        setLoadingSite(null);
      }
    },
    [projectsBySite, onError],
  );

  const handleMirror = useCallback(
    async (cloudId: string) => {
      const projectKey = selectedProject[cloudId];
      if (!projectKey) return;
      const project = projectsBySite[cloudId]?.find((p) => p.key === projectKey);
      if (!project) return;
      setBusyOp(`mirror:${cloudId}:${projectKey}`);
      onError(null);
      try {
        const next = await integrationsApi.jiraMirrorSet({
          cloudId,
          projectKey,
          projectName: project.name,
          repoRoot,
        });
        onStatusUpdate(next);
        setSelectedProject((prev) => ({ ...prev, [cloudId]: "" }));
      } catch (e) {
        onError(String(e));
      } finally {
        setBusyOp(null);
      }
    },
    [selectedProject, projectsBySite, repoRoot, onStatusUpdate, onError],
  );

  const handleUnmirror = useCallback(
    async (m: MirrorSummary) => {
      setBusyOp(`unmirror:${m.cloud_id}:${m.project_key}`);
      onError(null);
      try {
        const next = await integrationsApi.jiraMirrorUnset({
          cloudId: m.cloud_id,
          projectKey: m.project_key,
        });
        onStatusUpdate(next);
      } catch (e) {
        onError(String(e));
      } finally {
        setBusyOp(null);
      }
    },
    [onStatusUpdate, onError],
  );

  const handleAutoMirrorToggle = useCallback(
    async (turnOn: boolean) => {
      setBusyOp("auto-mirror");
      onError(null);
      try {
        const next = turnOn
          ? await integrationsApi.jiraAutoMirrorEnable(repoRoot)
          : await integrationsApi.jiraAutoMirrorDisable();
        onStatusUpdate(next);
      } catch (e) {
        onError(String(e));
      } finally {
        setBusyOp(null);
      }
    },
    [repoRoot, onStatusUpdate, onError],
  );

  const handleSyncAll = useCallback(async () => {
    setBusyOp("sync:all");
    onError(null);
    try {
      const outcomes = await integrationsApi.jiraSyncNow({ repoRoot });
      setRecentSync((prev) => {
        const next = { ...prev };
        for (const o of outcomes) next[o.project_key] = o;
        return next;
      });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyOp(null);
    }
  }, [repoRoot, onError]);

  const handleBackfill = useCallback(async () => {
    // Confirm because this can be a long-running full re-pull and
    // generates upstream API load against the user's Jira quota.
    const ok = await askConfirm({
      title: `Re-pull every issue for ${mirrors.length} mirrored project${
        mirrors.length === 1 ? "" : "s"
      }?`,
      body: "Use this when parent/epic links or other fields look wrong. It clears the incremental cache and walks each project from scratch. Existing tasks keep their IDs.",
      confirmLabel: "Re-pull everything",
    });
    if (!ok) return;
    setBusyOp("backfill:all");
    onError(null);
    try {
      const outcomes = await integrationsApi.jiraBackfill({ repoRoot });
      setRecentSync((prev) => {
        const next = { ...prev };
        for (const o of outcomes) next[o.project_key] = o;
        return next;
      });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyOp(null);
    }
  }, [repoRoot, mirrors.length, onError]);

  return (
    <div className="space-y-3">
      <label
        className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm cursor-pointer transition-colors ${
          autoOn
            ? "border-accent-green/40 bg-accent-green/5"
            : "border-line-soft bg-bg-2/30 hover:bg-state-hover"
        }`}
        title="When on, every Jira project on every site mirrors into this repo. New projects appear automatically within 5 min."
      >
        <input
          type="checkbox"
          checked={autoOn}
          disabled={busyOp === "auto-mirror"}
          onChange={(e) => void handleAutoMirrorToggle(e.target.checked)}
          className="mt-0.5 accent-emerald-500"
        />
        <div className="flex-1 min-w-0">
          <div className="text-text-1 text-sm">
            Auto-mirror every project into this repo
          </div>
          <div className="text-text-4 text-xs mt-0.5">
            {autoOn ? (
              <>
                On · {mirrors.length} project{mirrors.length === 1 ? "" : "s"}{" "}
                across {sites.length} site{sites.length === 1 ? "" : "s"}. New
                Jira projects appear here within 5&nbsp;min.
              </>
            ) : (
              <>
                Off. Pick projects manually below, or flip this on to import
                everything (and keep it in sync with upstream).
              </>
            )}
          </div>
        </div>
        {busyOp === "auto-mirror" && (
          <AsciiSpinner className="text-sm leading-none mt-0.5" />
        )}
      </label>

      <div className="flex items-center justify-between">
        <div className="text-text-4 text-xs font-medium">
          Mirrored projects ({mirrors.length})
        </div>
        {mirrors.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleBackfill}
              disabled={busyOp === "sync:all" || busyOp === "backfill:all"}
              title="Clear the incremental cache and re-pull every issue. Use when parent/epic links or other fields look wrong."
            >
              {busyOp === "backfill:all" ? (
                <AsciiSpinner className="text-xs leading-none" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Re-sync from scratch
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleSyncAll}
              disabled={busyOp === "sync:all" || busyOp === "backfill:all"}
              title={`Sync every mirror targeting ${repoRoot}`}
            >
              {busyOp === "sync:all" ? (
                <AsciiSpinner className="text-xs leading-none" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Sync now
            </Button>
          </div>
        )}
      </div>

      {mirrors.length === 0 && (
        <div className="text-xs text-text-4">
          No projects mirrored yet. Pick a project below to import its issues
          into this repo's Tasks.
        </div>
      )}

      {mirrors.length > 0 && (
        <ul className="space-y-1">
          {mirrors.map((m) => {
            const outcome = recentSync[m.project_key];
            const lastSyncedAt =
              outcome?.synced_at ?? m.last_synced_at ?? null;
            const created = outcome?.created ?? m.last_sync_created ?? 0;
            const updated = outcome?.updated ?? m.last_sync_updated ?? 0;
            const errors =
              outcome?.errors.length ?? m.last_sync_errors ?? 0;
            const isBusy = busyOp === `unmirror:${m.cloud_id}:${m.project_key}`;
            return (
              <li
                key={`${m.cloud_id}:${m.project_key}`}
                className="flex items-center gap-2 text-sm bg-bg-2/40 px-2 py-1.5 rounded border border-line-soft/60"
              >
                <span className="px-1.5 py-0.5 rounded bg-[#2684FF]/15 text-[#2684FF] text-2xs font-mono">
                  {m.project_key}
                </span>
                <span className="text-text-2 truncate">{m.project_name}</span>
                <span className="text-text-5 text-xs truncate flex-1">
                  → {shortPath(m.repo_root)}
                </span>
                {lastSyncedAt ? (
                  <span
                    className="text-xs text-text-4"
                    title={`Last sync: ${new Date(lastSyncedAt * 1000).toLocaleString()}`}
                  >
                    {created}c · {updated}u
                    {errors > 0 && (
                      <span className="text-red"> · {errors}e</span>
                    )}{" "}
                    · {timeAgo(lastSyncedAt)}
                  </span>
                ) : (
                  <span className="text-xs text-text-5">never synced</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleUnmirror(m)}
                  disabled={isBusy}
                  className="text-text-4 hover:text-red"
                  title="Remove mirror"
                >
                  {isBusy ? (
                    <AsciiSpinner className="text-xs leading-none" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={`space-y-2 pt-1 ${autoOn ? "hidden" : ""}`}>
        {sites.map((s) => {
          const available = (projectsBySite[s.cloud_id] ?? []).filter(
            (p) =>
              !mirrors.some(
                (m) => m.cloud_id === s.cloud_id && m.project_key === p.key,
              ),
          );
          const selected = selectedProject[s.cloud_id] ?? "";
          const opKey = `mirror:${s.cloud_id}:${selected}`;
          return (
            <div
              key={s.cloud_id}
              className="flex items-center gap-2 text-sm"
            >
              <span className="text-text-4 text-xs truncate min-w-[6rem]">
                {s.name}
              </span>
              <select
                value={selected}
                onFocus={() => ensureProjects(s.cloud_id)}
                onChange={(e) =>
                  setSelectedProject((prev) => ({
                    ...prev,
                    [s.cloud_id]: e.target.value,
                  }))
                }
                className="flex-1 bg-bg-2/60 border border-line-soft rounded px-2 py-1 text-text-2 text-sm"
              >
                <option value="">
                  {loadingSite === s.cloud_id
                    ? "Loading projects…"
                    : "Choose project to mirror…"}
                </option>
                {available.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
              <Button
                variant="default"
                size="xs"
                onClick={() => handleMirror(s.cloud_id)}
                disabled={!selected || busyOp === opKey}
              >
                {busyOp === opKey ? (
                  <AsciiSpinner className="text-xs leading-none" />
                ) : (
                  <Plug className="w-3 h-3" />
                )}
                Mirror
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
