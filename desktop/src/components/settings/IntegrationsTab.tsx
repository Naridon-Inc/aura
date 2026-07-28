// Settings → Integrations pane.
//
// Surface: Jira connect / disconnect (identity card, cloud sites list,
// mirrors, people-matching) and Linear connect / disconnect (identity
// card — single workspace, no mirror UI yet). Both share the same
// connect/cancel/disconnect plumbing and the "didn't open?" fallback
// link. Additional providers slot in below with the same card shape.
//
// Configuration values (client_id, client_secret, callback) live in
// `~/.aura/integrations.toml` outside the repo — Aura never asks the
// user to paste them into a textbox. This card just shows the
// connection state for whatever's already configured.

import { useCallback, useEffect, useMemo, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  ExternalLink,
  FolderInput,
  LinkIcon,
  Plug,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Trash2,
  Unlink,
  Users,
  X,
} from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  integrationsApi,
  type BeadsImportOutcome,
  type BeadsPreview,
  type ConnectionStatus,
  type JiraProject,
  type JiraUserLink,
  type MirrorSummary,
  type ReconcileSuggestion,
  type SyncOutcome,
} from "../../lib/integrationsApi";
import { api, type TeamMember } from "../../lib/api";
import { pickPath } from "../../lib/nativeDialog";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

type Props = {
  /** Active repo root — used as the target for mirror bindings created
   *  from this settings pane. Must be an Aura repo (contains `.aura/`)
   *  or the mirror-set call fails fast. */
  repoRoot: string;
};

// Atlassian rejects exact-match redirects with port wildcards; the
// loopback port comes from `~/.aura/integrations.toml` and the Rust
// side fails fast if it's already in use. This message text appears
// inline whenever a connect attempt errors with "bind …" so the user
// has a one-shot pointer to the fix.
const PORT_BIND_HINT =
  "Another process is using the loopback port. Edit `redirect_uri` " +
  "in ~/.aura/integrations.toml AND in the Atlassian developer console " +
  "(Authorization tab), then retry.";

export function IntegrationsTab({ repoRoot }: Props) {
  const [statuses, setStatuses] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const rows = await integrationsApi.list();
      setStatuses(rows);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Surface the authorize URL the Rust side emits, so the user can
  // click it manually if the system browser didn't pop up. Both Jira
  // and Linear emit their own event; either one sets the same fallback
  // slot (only one flow is ever open at a time). Cleared once the flow
  // resolves or the user cancels.
  useEffect(() => {
    const stops: UnlistenFn[] = [];
    for (const ev of [
      "aura:integrations:jira:auth_url",
      "aura:integrations:linear:auth_url",
    ]) {
      void listen<string>(ev, (e) => setFallbackUrl(e.payload)).then((u) =>
        stops.push(u),
      );
    }
    return () => {
      for (const s of stops) s();
    };
  }, []);

  const connect = useCallback(
    async (kind: "jira" | "linear") => {
      setBusyKind(kind);
      setError(null);
      try {
        const next =
          kind === "jira"
            ? await integrationsApi.jiraConnect()
            : await integrationsApi.linearConnect();
        setStatuses((prev) => upsertStatus(prev, next));
        setFallbackUrl(null);
      } catch (e) {
        const msg = String(e);
        // Promote the most-common operator error (port collision) to a
        // hint inline below the button instead of a raw error blob.
        if (msg.includes("bind 127.0.0.1")) {
          setError(`${msg}\n\n${PORT_BIND_HINT}`);
        } else {
          setError(msg);
        }
      } finally {
        setBusyKind(null);
      }
    },
    [],
  );

  const disconnect = useCallback(
    async (kind: "jira" | "linear") => {
      setBusyKind(kind);
      setError(null);
      try {
        if (kind === "jira") {
          await integrationsApi.jiraDisconnect();
        } else {
          await integrationsApi.linearDisconnect();
        }
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyKind(null);
      }
    },
    [refresh],
  );

  // Cancel fires the cancel signal Rust-side; the pending connect
  // promise will then reject with "connect cancelled" and that
  // catch-block clears busyKind. We don't await anything here so the
  // button stays clickable even if Rust takes a tick to respond.
  const cancel = useCallback(async (kind: "jira" | "linear") => {
    setError(null);
    try {
      if (kind === "jira") {
        await integrationsApi.jiraCancel();
      } else {
        await integrationsApi.linearCancel();
      }
      setFallbackUrl(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const jira = useMemo(
    () => statuses.find((s) => s.kind === "jira") ?? null,
    [statuses],
  );
  const linear = useMemo(
    () => statuses.find((s) => s.kind === "linear") ?? null,
    [statuses],
  );

  return (
    <div>
      <div className="flex items-start gap-3 mb-6">
        <div className="w-8 h-8 rounded-md bg-bg-2 flex items-center justify-center text-text-3">
          <Plug className="w-4 h-4" />
        </div>
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold text-text-1 leading-tight">
            Integrations
          </h2>
          <p className="text-[12px] text-text-4 mt-0.5">
            Sync tasks two-way with external trackers. Credentials are read
            from{" "}
            <code className="text-text-3 px-1 py-px rounded bg-bg-2/60">
              ~/.aura/integrations.toml
            </code>{" "}
            — never committed to the repo.
          </p>
        </div>
      </div>

      {loading && (
        <div className="text-[12px] text-text-4 flex items-center gap-2">
          <AsciiSpinner />
          Loading integrations…
        </div>
      )}

      {!loading && (
        <JiraCard
          status={jira}
          repoRoot={repoRoot}
          busy={busyKind === "jira"}
          onConnect={() => connect("jira")}
          onCancel={() => cancel("jira")}
          onDisconnect={() => disconnect("jira")}
          onStatusUpdate={(next) => setStatuses((prev) => upsertStatus(prev, next))}
          onError={setError}
        />
      )}

      {!loading && (
        <div className="mt-3">
          <LinearCard
            status={linear}
            busy={busyKind === "linear"}
            onConnect={() => connect("linear")}
            onCancel={() => cancel("linear")}
            onDisconnect={() => disconnect("linear")}
          />
        </div>
      )}

      {!loading && (
        <div className="mt-3">
          <BeadsCard repoRoot={repoRoot} onError={setError} />
        </div>
      )}

      {fallbackUrl && (busyKind === "jira" || busyKind === "linear") && (
        <div className="mt-3 text-[12px] text-text-4 flex items-center gap-2">
          <span>Browser didn't open?</span>
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onExternalAnchorClick}
            className="text-text-2 hover:text-text-1 inline-flex items-center gap-1 hover:underline"
          >
            Open authorize URL <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 p-3 rounded-md border border-red/30 bg-red/5 text-[12px] text-red whitespace-pre-wrap"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function upsertStatus(
  prev: ConnectionStatus[],
  next: ConnectionStatus,
): ConnectionStatus[] {
  const idx = prev.findIndex((s) => s.kind === next.kind);
  if (idx === -1) return [...prev, next];
  const out = prev.slice();
  out[idx] = next;
  return out;
}

function JiraCard({
  status,
  repoRoot,
  busy,
  onConnect,
  onCancel,
  onDisconnect,
  onStatusUpdate,
  onError,
}: {
  status: ConnectionStatus | null;
  repoRoot: string;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onStatusUpdate: (next: ConnectionStatus) => void;
  onError: (msg: string | null) => void;
}) {
  const connected = status?.connected === true;
  return (
    <section className="rounded-lg bg-bg-0 shadow-[var(--shadow-card)] overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2.5 border-b border-line-soft">
        <JiraGlyph />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-1">Jira</div>
          <div className="text-[11px] text-text-4">
            Atlassian Cloud · OAuth 2.0 (3LO) · two-way sync
          </div>
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent-green bg-accent-green/10 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3" /> Connected
          </span>
        ) : (
          <span className="text-[11px] text-text-4">Not connected</span>
        )}
      </header>

      <div className="p-3 text-[12px] text-text-3 space-y-3">
        {connected && status?.identity && (
          <div className="flex items-center gap-3">
            {status.identity.avatar_url ? (
              <img
                src={status.identity.avatar_url}
                alt=""
                className="w-7 h-7 rounded-full border border-line-soft"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-bg-2 flex items-center justify-center text-[10px] uppercase text-text-3">
                {initials(status.identity.display_name)}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-text-1 text-[12px] truncate">
                {status.identity.display_name}
              </div>
              {status.identity.email && (
                <div className="text-text-4 text-[11px] truncate">
                  {status.identity.email}
                </div>
              )}
            </div>
          </div>
        )}

        {connected && status?.sites && status.sites.length > 0 && (
          <div>
            <div className="text-text-4 text-[10.5px] uppercase tracking-wide mb-1">
              Sites ({status.sites.length})
            </div>
            <ul className="space-y-1">
              {status.sites.map((s) => (
                <li
                  key={s.cloud_id}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <LinkIcon className="w-3 h-3 text-text-4 flex-shrink-0" />
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onExternalAnchorClick}
                    className="text-text-2 hover:text-text-1 hover:underline truncate"
                  >
                    {s.name}
                  </a>
                  <span className="text-text-5 text-[11px] truncate">
                    {s.url.replace(/^https?:\/\//, "")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {connected && status?.sites && status.sites.length > 0 && (
          <MirrorsSection
            sites={status.sites}
            mirrors={status.mirrors ?? []}
            autoMirrorRepoRoot={status.auto_mirror_repo_root ?? null}
            repoRoot={repoRoot}
            onStatusUpdate={onStatusUpdate}
            onError={onError}
          />
        )}

        {connected && (
          <div className="pt-1 border-t border-line-soft/60">
            <PeopleSection repoRoot={repoRoot} onError={onError} />
          </div>
        )}

        {connected && status?.expires_at && (
          <div className="text-[11px] text-text-4">
            Token refreshes in {formatExpiry(status.expires_at)}.
          </div>
        )}

        {!connected && (
          <p className="text-text-4 text-[12px]">
            Connect Aura to your Atlassian site to mirror Jira issues into
            Tasks (status, assignee, priority, labels, comments).
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              disabled={busy}
            >
              {busy ? (
                <AsciiSpinner className="text-[11px] leading-none" />
              ) : (
                <Unlink className="w-3 h-3" />
              )}
              Disconnect
            </Button>
          ) : (
            <>
              <Button
                variant="default"
                size="sm"
                onClick={onConnect}
                disabled={busy}
              >
                {busy ? (
                  <AsciiSpinner className="text-[11px] leading-none" />
                ) : (
                  <Plug className="w-3 h-3" />
                )}
                {busy ? "Connecting…" : "Connect Jira"}
              </Button>
              {busy && (
                // Cancel sits beside Connect while a flow is open. Aborts
                // the loopback listener so the next attempt can rebind
                // the port without waiting for the 5-minute server-side
                // timeout (Atlassian error pages never redirect back).
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onCancel}
                >
                  <X className="w-3 h-3" />
                  Cancel
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Linear connection card. Simpler than Jira: one workspace per token,
// no cloud-sites list, no per-project mirror picker (Linear issue import
// lands in a later wave). W1 shows connection state + the signed-in
// identity, and lets the user connect / cancel / disconnect. Uses the
// same one-call OAuth plumbing as Jira via the parent's callbacks.
function LinearCard({
  status,
  busy,
  onConnect,
  onCancel,
  onDisconnect,
}: {
  status: ConnectionStatus | null;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}) {
  const connected = status?.connected === true;
  return (
    <section className="rounded-lg bg-bg-0 shadow-[var(--shadow-card)] overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2.5 border-b border-line-soft">
        <LinearGlyph />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-1">Linear</div>
          <div className="text-[11px] text-text-4">
            Linear workspace · OAuth 2.0 · issue sync
          </div>
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent-green bg-accent-green/10 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3" /> Connected
          </span>
        ) : (
          <span className="text-[11px] text-text-4">Not connected</span>
        )}
      </header>

      <div className="p-3 text-[12px] text-text-3 space-y-3">
        {connected && status?.identity && (
          <div className="flex items-center gap-3">
            {status.identity.avatar_url ? (
              <img
                src={status.identity.avatar_url}
                alt=""
                className="w-7 h-7 rounded-full border border-line-soft"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-bg-2 flex items-center justify-center text-[10px] uppercase text-text-3">
                {initials(status.identity.display_name)}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-text-1 text-[12px] truncate">
                {status.identity.display_name}
              </div>
              {status.identity.email && (
                <div className="text-text-4 text-[11px] truncate">
                  {status.identity.email}
                </div>
              )}
            </div>
          </div>
        )}

        {!connected && (
          <p className="text-text-4 text-[12px]">
            Connect Aura to your Linear workspace to bring issues into Tasks.
            You'll approve access once in the browser — Aura never sees your
            password.
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              disabled={busy}
            >
              {busy ? (
                <AsciiSpinner className="text-[11px] leading-none" />
              ) : (
                <Unlink className="w-3 h-3" />
              )}
              Disconnect
            </Button>
          ) : (
            <>
              <Button
                variant="default"
                size="sm"
                onClick={onConnect}
                disabled={busy}
              >
                {busy ? (
                  <AsciiSpinner className="text-[11px] leading-none" />
                ) : (
                  <Plug className="w-3 h-3" />
                )}
                {busy ? "Connecting…" : "Connect Linear"}
              </Button>
              {busy && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onCancel}
                >
                  <X className="w-3 h-3" />
                  Cancel
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// One mirror = (site, project) → local repo binding. The picker is
// per-site so multi-site users can mirror projects from each Atlassian
// instance independently. Project lists are lazy-loaded on first focus
// of the dropdown — keeping the initial settings render cheap.
function MirrorsSection({
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
    const ok = window.confirm(
      `Re-pull every issue for ${mirrors.length} mirrored project${
        mirrors.length === 1 ? "" : "s"
      }?\n\nUse this when parent/epic links or other fields look wrong — it clears the incremental cache and walks each project from scratch. Existing tasks keep their IDs.`,
    );
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
        className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px] cursor-pointer transition-colors ${
          autoOn
            ? "border-accent-green/40 bg-accent-green/5"
            : "border-line-soft bg-bg-2/30 hover:bg-bg-2/50"
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
          <div className="text-text-1 text-[12px]">
            Auto-mirror every project into this repo
          </div>
          <div className="text-text-4 text-[11px] mt-0.5">
            {autoOn ? (
              <>
                On — {mirrors.length} project{mirrors.length === 1 ? "" : "s"}{" "}
                across {sites.length} site{sites.length === 1 ? "" : "s"}. New
                Jira projects appear here within 5&nbsp;min.
              </>
            ) : (
              <>
                Off — pick projects manually below, or flip this on to import
                everything (and keep it in sync with upstream).
              </>
            )}
          </div>
        </div>
        {busyOp === "auto-mirror" && (
          <AsciiSpinner className="text-[12px] leading-none mt-0.5" />
        )}
      </label>

      <div className="flex items-center justify-between">
        <div className="text-text-4 text-[10.5px] uppercase tracking-wide">
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
                <AsciiSpinner className="text-[11px] leading-none" />
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
                <AsciiSpinner className="text-[11px] leading-none" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Sync now
            </Button>
          </div>
        )}
      </div>

      {mirrors.length === 0 && (
        <div className="text-[11px] text-text-4">
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
                className="flex items-center gap-2 text-[12px] bg-bg-2/40 px-2 py-1.5 rounded border border-line-soft/60"
              >
                <span className="px-1.5 py-0.5 rounded bg-[#2684FF]/15 text-[#2684FF] text-[10px] font-mono">
                  {m.project_key}
                </span>
                <span className="text-text-2 truncate">{m.project_name}</span>
                <span className="text-text-5 text-[11px] truncate flex-1">
                  → {shortRepoRoot(m.repo_root)}
                </span>
                {lastSyncedAt ? (
                  <span
                    className="text-[10.5px] text-text-4"
                    title={`Last sync: ${new Date(lastSyncedAt * 1000).toLocaleString()}`}
                  >
                    {created}c · {updated}u
                    {errors > 0 && (
                      <span className="text-red"> · {errors}e</span>
                    )}{" "}
                    · {timeAgo(lastSyncedAt)}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-text-5">never synced</span>
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
                    <AsciiSpinner className="text-[11px] leading-none" />
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
              className="flex items-center gap-2 text-[12px]"
            >
              <span className="text-text-4 text-[11px] truncate min-w-[6rem]">
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
                className="flex-1 bg-bg-2/60 border border-line-soft rounded px-2 py-1 text-text-2 text-[12px]"
              >
                <option value="">
                  {loadingSite === s.cloud_id
                    ? "Loading projects…"
                    : "Choose project to mirror…"}
                </option>
                {available.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.name}
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
                  <AsciiSpinner className="text-[11px] leading-none" />
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

// People matching — every imported Jira card carries whoever it's assigned to
// on Jira. Their name rarely lines up with your teammates by itself, so this
// section ties each Jira person to a real teammate: ones with a matching email
// link themselves, and for the rest Aura suggests the most likely teammate
// which you confirm with one click. Nothing is merged automatically — picking
// the wrong person is painful to undo, so the human always says yes.
function PeopleSection({
  repoRoot,
  onError,
}: {
  repoRoot: string;
  onError: (msg: string | null) => void;
}) {
  const [links, setLinks] = useState<JiraUserLink[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [suggestions, setSuggestions] = useState<
    Record<string, ReconcileSuggestion>
  >({});
  const [manualPick, setManualPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [rows, team] = await Promise.all([
        integrationsApi.jiraUsersList(repoRoot),
        api.teamLoad(repoRoot).catch(() => null),
      ]);
      setLinks(rows);
      setMembers(team?.members ?? []);
    } catch (e) {
      onError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const unresolved = useMemo(
    () => links.filter((l) => l.status === "unresolved"),
    [links],
  );
  const resolved = useMemo(
    () => links.filter((l) => l.status === "resolved"),
    [links],
  );

  const pickableMembers = useMemo(
    () => members.filter((m) => m.handle.trim().length > 0),
    [members],
  );
  const nameForHandle = useCallback(
    (handle?: string | null) => {
      if (!handle) return null;
      const m = pickableMembers.find((x) => x.handle === handle);
      return m?.name?.trim() || handle;
    },
    [pickableMembers],
  );

  const runReconcile = useCallback(async () => {
    setReconciling(true);
    setNote(null);
    onError(null);
    try {
      const rows = await integrationsApi.jiraUsersReconcile(repoRoot);
      const map: Record<string, ReconcileSuggestion> = {};
      for (const r of rows) map[r.account_id] = r;
      setSuggestions(map);
    } catch (e) {
      onError(String(e));
    } finally {
      setReconciling(false);
    }
  }, [repoRoot, onError]);

  const link = useCallback(
    async (accountId: string, handle: string) => {
      if (!handle) return;
      setBusy(`link:${accountId}`);
      setNote(null);
      onError(null);
      try {
        const result = await integrationsApi.jiraUsersLink({
          repoRoot,
          accountId,
          handle,
        });
        setSuggestions((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        setManualPick((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        const who = nameForHandle(handle) ?? handle;
        setNote(
          result.tasks_updated > 0
            ? `Matched to ${who} · updated ${result.tasks_updated} card${
                result.tasks_updated === 1 ? "" : "s"
              }.`
            : `Matched to ${who}.`,
        );
        await load();
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onError, load, nameForHandle],
  );

  const unlink = useCallback(
    async (accountId: string) => {
      setBusy(`unlink:${accountId}`);
      setNote(null);
      onError(null);
      try {
        await integrationsApi.jiraUsersUnlink({ repoRoot, accountId });
        await load();
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onError, load],
  );

  if (loading) {
    return (
      <div className="pt-2 text-[11px] text-text-4 flex items-center gap-2">
        <AsciiSpinner /> Loading people…
      </div>
    );
  }

  // Nothing imported yet — keep the section quiet rather than show an empty box.
  if (links.length === 0) {
    return (
      <div className="pt-2">
        <div className="flex items-center gap-2 text-text-4 text-[10.5px] uppercase tracking-wide mb-1">
          <Users className="w-3 h-3" /> People
        </div>
        <p className="text-[11px] text-text-4">
          Once you sync a project, the people assigned on those Jira cards show
          up here so you can match them to your teammates.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-2 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-4 text-[10.5px] uppercase tracking-wide">
          <Users className="w-3 h-3" /> People ({resolved.length}/{links.length}{" "}
          matched)
        </div>
        {unresolved.length > 0 && (
          <button
            type="button"
            onClick={runReconcile}
            disabled={reconciling}
            className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded border border-line text-text-2 hover:text-text-1 hover:bg-bg-2 disabled:opacity-50"
            title="Let Aura suggest the most likely teammate for each unmatched Jira person. You confirm each one."
          >
            {reconciling ? (
              <AsciiSpinner className="text-[11px] leading-none" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {reconciling ? "Asking Aura…" : "Match with Aura"}
          </button>
        )}
      </div>

      {unresolved.length > 0 && (
        <p className="text-[11px] text-text-4">
          {unresolved.length} Jira{" "}
          {unresolved.length === 1 ? "person isn't" : "people aren't"} matched to
          a teammate yet. Until then their Jira name shows on the card.
        </p>
      )}

      {unresolved.length > 0 && (
        <ul className="space-y-1.5">
          {unresolved.map((l) => {
            const s = suggestions[l.account_id];
            const picked = manualPick[l.account_id] ?? "";
            const linkBusy = busy === `link:${l.account_id}`;
            const suggestedName =
              s?.suggested_handle != null
                ? nameForHandle(s.suggested_handle)
                : null;
            return (
              <li
                key={l.account_id}
                className="rounded border border-line-soft/60 bg-bg-2/40 px-2.5 py-2 text-[12px] space-y-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-[#2684FF]/15 text-[#2684FF] text-[10px]">
                    Jira
                  </span>
                  <span className="text-text-1 truncate">
                    {l.display_name || l.account_id}
                  </span>
                  {l.email && (
                    <span className="text-text-5 text-[11px] truncate">
                      {l.email}
                    </span>
                  )}
                </div>

                {s?.suggested_handle && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-text-3">
                      Looks like{" "}
                      <span className="text-text-1">
                        {suggestedName ?? s.suggested_handle}
                      </span>
                      <span className="text-text-5">
                        {" "}
                        · {Math.round((s.confidence ?? 0) * 100)}% sure
                      </span>
                    </span>
                    <Button
                      size="xs"
                      onClick={() => link(l.account_id, s.suggested_handle!)}
                      disabled={linkBusy}
                    >
                      {linkBusy ? (
                        <AsciiSpinner className="text-[11px] leading-none" />
                      ) : (
                        <LinkIcon className="w-3 h-3" />
                      )}
                      Match
                    </Button>
                  </div>
                )}

                {s && !s.suggested_handle && (
                  <div className="text-[11px] text-text-4">{s.reason}</div>
                )}

                <div className="flex items-center gap-2">
                  <Select
                    value={picked}
                    onChange={(v) =>
                      setManualPick((prev) => ({
                        ...prev,
                        [l.account_id]: v,
                      }))
                    }
                    placeholder="Pick a teammate by hand…"
                    options={pickableMembers.map((m) => ({
                      value: m.handle,
                      label: `${m.name?.trim() || m.handle}${
                        m.email ? ` · ${m.email}` : ""
                      }`,
                    }))}
                    className="flex-1 text-[12px]"
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => link(l.account_id, picked)}
                    disabled={!picked || linkBusy}
                  >
                    {linkBusy ? (
                      <AsciiSpinner className="text-[11px] leading-none" />
                    ) : (
                      <LinkIcon className="w-3 h-3" />
                    )}
                    Match
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {resolved.length > 0 && (
        <ul className="space-y-1">
          {resolved.map((l) => {
            const unlinkBusy = busy === `unlink:${l.account_id}`;
            return (
              <li
                key={l.account_id}
                className="flex items-center gap-2 text-[12px] px-2 py-1"
              >
                <CheckCircle2 className="w-3 h-3 text-accent-green flex-shrink-0" />
                <span className="text-text-2 truncate">
                  {l.display_name || l.account_id}
                </span>
                <span className="text-text-5">→</span>
                <span className="text-text-1 truncate">
                  {nameForHandle(l.handle) ?? l.handle}
                </span>
                <span className="text-text-5 text-[10.5px] flex-1">
                  {l.via === "email"
                    ? "matched by email"
                    : l.via === "brain"
                      ? "matched by Aura"
                      : "matched by you"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => unlink(l.account_id)}
                  disabled={unlinkBusy}
                  className="text-text-4 hover:text-red"
                  title="Unmatch — sends this Jira person back to the list above"
                >
                  {unlinkBusy ? (
                    <AsciiSpinner className="text-[11px] leading-none" />
                  ) : (
                    <Unlink className="w-3 h-3" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {note && (
        <div className="text-[11px] text-accent-green flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3" /> {note}
        </div>
      )}
    </div>
  );
}

function shortRepoRoot(path: string): string {
  // Trim a leading $HOME so the mirror row stays readable on long
  // absolute paths. Tilde-substitution is purely cosmetic — the actual
  // mirror stores the full path.
  if (typeof window !== "undefined") {
    // No HOME access in the renderer; fall back to last 2 segments.
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function timeAgo(unixSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unixSecs);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

// Beads import card. Beads is a local, git-native tracker — there's no
// account to connect, no sign-in, no network. You point at a folder that
// has a Beads tracker in it and bring its issues onto your board. We show
// a count first ("Found 42 issues") so nothing lands unexpectedly, then a
// one-click bring-in that's safe to run twice (re-running updates the same
// cards instead of making copies).
function BeadsCard({
  repoRoot,
  onError,
}: {
  repoRoot: string;
  onError: (msg: string | null) => void;
}) {
  const [source, setSource] = useState<string>("");
  const [preview, setPreview] = useState<BeadsPreview | null>(null);
  const [outcome, setOutcome] = useState<BeadsImportOutcome | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  const choose = useCallback(async () => {
    onError(null);
    try {
      const picked = await pickPath({
        directory: true,
        title: "Choose a folder with a Beads tracker (.beads)",
        defaultPath: repoRoot || undefined,
      });
      if (typeof picked !== "string") return;
      setSource(picked);
      setOutcome(null);
      setPreview(null);
      setBusy("preview");
      const p = await integrationsApi.beadsPreview(picked);
      setPreview(p);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }, [repoRoot, onError]);

  const runImport = useCallback(async () => {
    if (!source) return;
    onError(null);
    setBusy("import");
    try {
      const result = await integrationsApi.beadsImport({ repoRoot, source });
      setOutcome(result);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }, [source, repoRoot, onError]);

  return (
    <section className="rounded-lg bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <div className="flex items-start gap-3">
        <BeadsGlyph />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-text-1">Beads</h3>
            <span className="text-[10px] uppercase tracking-wide text-text-4 px-1.5 py-px rounded bg-bg-2">
              Local
            </span>
          </div>
          <p className="text-[12px] text-text-4 mt-0.5">
            Bring issues from a Beads tracker onto this board. Everything stays
            on your machine — no sign-in. Safe to run again later: it updates the
            same cards instead of making copies.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={choose}
              disabled={busy !== null}
            >
              {busy === "preview" ? (
                <AsciiSpinner className="text-[12px] leading-none" />
              ) : (
                <FolderInput className="w-3.5 h-3.5" />
              )}
              Choose folder…
            </Button>
            {preview && (
              <Button
                size="sm"
                onClick={runImport}
                disabled={busy !== null || preview.total === 0}
              >
                {busy === "import" ? (
                  <AsciiSpinner className="text-[12px] leading-none" />
                ) : (
                  <LinkIcon className="w-3.5 h-3.5" />
                )}
                Bring in {preview.total} issue{preview.total === 1 ? "" : "s"}
              </Button>
            )}
          </div>

          {source && (
            <p className="mt-2 text-[11px] text-text-4 truncate" title={source}>
              From: <code className="text-text-3">{source}</code>
            </p>
          )}

          {preview && !outcome && (
            <p className="mt-1 text-[11px] text-text-4">
              Found <span className="text-text-2">{preview.total}</span> issue
              {preview.total === 1 ? "" : "s"} ({preview.open} open ·{" "}
              {preview.closed} done
              {preview.with_dependencies > 0
                ? ` · ${preview.with_dependencies} with dependencies`
                : ""}
              ).
            </p>
          )}

          {outcome && (
            <div className="mt-2 text-[11px] flex items-start gap-1.5 text-accent-green">
              <CheckCircle2 className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              <span className="text-text-3">
                Brought in <span className="text-text-1">{outcome.created}</span>{" "}
                new · updated{" "}
                <span className="text-text-1">{outcome.updated}</span>
                {outcome.links > 0 ? ` · linked ${outcome.links} dependency` : ""}
                {outcome.links > 1 ? "s" : ""}
                {outcome.skipped > 0 ? ` · skipped ${outcome.skipped}` : ""}.
              </span>
            </div>
          )}

          {outcome && outcome.errors.length > 0 && (
            <ul className="mt-1.5 text-[11px] text-amber/90 space-y-0.5">
              {outcome.errors.slice(0, 5).map((e, i) => (
                <li key={i} className="truncate" title={e}>
                  • {e}
                </li>
              ))}
              {outcome.errors.length > 5 && (
                <li className="text-text-4">
                  …and {outcome.errors.length - 5} more
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// Tiny inline glyph for Beads — three dots on a thread, evoking beads on a
// string. Kept inline to avoid shipping an asset.
function BeadsGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-amber/10 grid place-items-center text-amber">
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
        <path
          d="M3 12h18"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
        />
        <circle cx="6" cy="12" r="2.4" />
        <circle cx="12" cy="12" r="2.4" />
        <circle cx="18" cy="12" r="2.4" />
      </svg>
    </div>
  );
}

// Tiny Jira-blue triangle glyph — kept inline so we don't need to
// ship Atlassian SVG assets (and to dodge trademark friction for OSS).
function JiraGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-[#2684FF]/10 grid place-items-center text-[#2684FF]">
      <svg
        viewBox="0 0 24 24"
        className="w-4 h-4"
        fill="currentColor"
        aria-hidden
      >
        <path d="M11.53 2L5.06 8.47a2 2 0 0 0 0 2.83l6.47 6.47a.5.5 0 0 0 .71 0L18.71 11.3a2 2 0 0 0 0-2.83L12.24 2a.5.5 0 0 0-.71 0Zm.36 9.18a3.18 3.18 0 0 1 3.18 3.18V18a3.18 3.18 0 1 1-6.36 0v-3.64a3.18 3.18 0 0 1 3.18-3.18Z" />
      </svg>
    </div>
  );
}

// Tiny Linear glyph — the signature three-bar mark in Linear's purple.
// Kept inline (no shipped asset) to match the Jira/Beads glyphs.
function LinearGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-[#5e6ad2]/12 grid place-items-center text-[#5e6ad2]">
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
        <rect x="3" y="5" width="18" height="2.6" rx="1.3" />
        <rect x="6" y="10.7" width="15" height="2.6" rx="1.3" />
        <rect x="9" y="16.4" width="12" height="2.6" rx="1.3" />
      </svg>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

function formatExpiry(expiresAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = expiresAt - now;
  if (delta < 60) return "under a minute";
  if (delta < 3600) return `${Math.round(delta / 60)} min`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h`;
  return `${Math.round(delta / 86400)} d`;
}
