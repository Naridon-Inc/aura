import { useCallback, useEffect, useState } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsError, SettingsStatusLine } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { api, type PendingGrant, type SettingsView } from "../../../lib/api";
import { Row, Section } from "../kit";

export type PackDescriptor = {
  id: string;
  label: string;
  description: string;
  rule_count: number;
  category: string;
  /** Whether every rule in this pack is already in the repo's
   *  `production.aura.json` — answered by `aura policy list --json`, which
   *  reads the file. The pane used to keep this in a Set it seeded empty, so
   *  a fully-covered repo showed seven `install` buttons. */
  installed: boolean;
};

export function GrantsSection({ repoRoot }: { repoRoot: string }) {
  const [grants, setGrants] = useState<PendingGrant[] | null>(null);
  // A take-back that fails leaves the permission live, so it must say so
  // rather than look like a button that did nothing.
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!repoRoot) return;
    try {
      setGrants(await api.auraGrantsPending(repoRoot));
    } catch {
      // A repository with no grant store is the normal case, and the
      // command already answers it with an empty list — anything else
      // here is a read failure worth showing as "nothing" rather than
      // as an error the reader cannot act on.
      setGrants([]);
    }
  }, [repoRoot]);
  useEffect(() => {
    void load();
    // They expire in minutes, so a pane left open would otherwise show a
    // permission that lapsed while it was being read.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const live = (grants ?? []).filter((g) => g.expires_in > 0);
  return (
    <Section title="One-off permissions">
      {live.length === 0 ? (
        <Row
          label="None right now"
          description="Nobody has allowed an agent to delete anything, throw away uncommitted work, or overwrite the shared history. When someone does, it appears here until it is used or runs out."
        >
          {null}
        </Row>
      ) : (
        live.map((g) => (
          <Row
            key={g.id}
            label={`${grantVerb(g.operation)} — ${g.target}`}
            description={`Allowed by ${g.issued_by}. ${remainingText(g.expires_in)}, or until it is used once.`}
          >
            <Button
              variant="outlineDestructive"
              size="sm"
              onClick={async () => {
                setRevokeError(null);
                try {
                  await api.auraGrantRevoke(repoRoot, g.id);
                } catch (e) {
                  setRevokeError(`Couldn't take back this permission, so it still stands: ${e instanceof Error ? e.message : String(e)}`);
                }
                await load();
              }}
            >
              Take back
            </Button>
          </Row>
        ))
      )}
      {revokeError && <SettingsError>{revokeError}</SettingsError>}
    </Section>
  );
}

/// The operation in the words a person would use for it. Unknown values
/// pass through rather than being flattened into "something", because a
/// permission whose name Aura does not recognise is the one a reader
/// most needs to see verbatim.
function grantVerb(op: string): string {
  if (op === "delete") return "Delete";
  if (op === "reset") return "Throw away uncommitted work";
  if (op === "force-push") return "Overwrite the shared history";
  return op;
}

function remainingText(secs: number): string {
  if (secs < 90) return `${secs} seconds left`;
  const mins = Math.floor(secs / 60);
  if (mins < 90) return `${mins} minutes left`;
  return `${Math.floor(mins / 60)} hours left`;
}

// Worktree base-path override. Default is ~/.aura/worktrees; teams with
// external SSDs or repository-adjacent layouts can point Aura elsewhere
// so per-task worktrees land in a project-organised location.
export function WorktreesSection({
  view,
  onChanged,
}: {
  view: SettingsView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = view.worktree_base_path;
  async function pick() {
    setBusy(true);
    try {
      const { pickPath } = await import("../../../lib/nativeDialog");
      const picked = await pickPath({
        directory: true,
        multiple: false,
        title: "Choose parallel-copy base folder",
        defaultPath: current ?? undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        await api.settingsSetWorktreeBase(picked);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      await api.settingsSetWorktreeBase("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Parallel copies">
      <Row
        label="Base folder"
        description="Where Aura keeps your parallel copies. Each task gets its own folder here, so agents can work side by side without stepping on each other. Pick any folder you can write to — Aura creates it the first time it’s needed."
      >
        <SettingsActions>
          <code className="ui-settings-path" title={current ?? "~/.aura/worktrees"}>
            {current ?? "~/.aura/worktrees (default)"}
          </code>
          {current && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              Reset
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={pick} disabled={busy}>
            Choose…
          </Button>
        </SettingsActions>
      </Row>
    </Section>
  );
}

// Pre-built rule packs from `aura policy list --json` (OWASP, style guides
// and the like), expressed as Aura's structured invariant rules rather than
// prose. Install shells `aura policy add <id>`, which merges into
// production.aura.json.
export function TemplatesSection({ repoRoot }: { repoRoot: string }) {
  const [packs, setPacks] = useState<PackDescriptor[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Which packs this repo already has is read off `production.aura.json` by
  // the CLI, not remembered here — a Set seeded empty made every pack look
  // uninstalled on open, however many were already merged.
  const load = useCallback(async () => {
    try {
      const res = await api.auraCli(repoRoot, ["policy", "list", "--json"]);
      const out = res.stdout.trim();
      if (!out) {
        setError(res.stderr.trim() || `exit ${res.status}`);
        // Otherwise the spinner runs under the error message forever.
        setPacks([]);
        return;
      }
      setPacks(JSON.parse(out) as PackDescriptor[]);
    } catch (e) {
      setError(String(e));
      setPacks([]);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (pack: PackDescriptor) => {
    setBusy(pack.id);
    setError(null);
    setToast(null);
    try {
      const res = await api.auraCli(repoRoot, ["policy", "add", pack.id]);
      if (res.status !== 0) {
        setError(res.stderr.trim() || `exit ${res.status}`);
      } else {
        setToast(`${pack.label} merged into production.aura.json`);
        setTimeout(() => setToast(null), 3000);
        // Re-read rather than assume: `policy add` can no-op on an unknown
        // id, and the file is the authority on what this repo enforces.
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      title="Rule template library"
      description={
        <>
          Pre-built invariant packs. Install merges into{" "}
          <code>production.aura.json</code> at the repo root. Packs layer
          additively, so install several to compose.
        </>
      }
    >
      {error && <SettingsError>{error}</SettingsError>}
      {toast && <SettingsStatusLine text={toast} />}
      {packs === null ? (
        <div className="ui-settings-status" role="status">
          <AsciiSpinner />
          Loading rule packs…
        </div>
      ) : (
        packs.map((p) => (
          <SettingsRow
            key={p.id}
            title={p.label}
            description={p.description}
            help={`${p.category} · ${p.rule_count} rules`}
            control={
              p.installed ? (
                // Not a button. Installing a pack that's already in full is a
                // no-op now that the merge dedupes, so offering "re-install"
                // was offering nothing.
                <Badge variant="highlight">Installed</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === p.id}
                  onClick={() => install(p)}
                  title={`aura policy add ${p.id}`}
                >
                  {busy === p.id ? <AsciiSpinner /> : "Install"}
                </Button>
              )
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
