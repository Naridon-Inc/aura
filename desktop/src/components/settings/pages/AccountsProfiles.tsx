import { useCallback, useEffect, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { api, type AgentProfile, type GitProfile, type WorkspaceBinding } from "../../../lib/api";
import { SettingsActions, SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { Section } from "../kit";
import { shortPath } from "../../../lib/paths";
import { askConfirm } from "../../ui/ask";
import { GitProfileEditor } from "./IdentityGit";

// Accounts and git identities. Two stacks share this module, shown on the
// Account and Git pages respectively:
//   • Agent profiles  — named ~/.aura/agent-profiles/<name>/ dirs swapped
//     in as HOME for the child PTY. Lets the user run multiple Claude
//     accounts side-by-side.
//   • Git profiles    — named {user_name,user_email,signing_key?} bound
//     to the current workspace. PTY spawn injects GIT_AUTHOR_* /
//     GIT_COMMITTER_* env so the agent's commits carry the right
//     identity without touching .git/config.
//
// The binding is workspace-scoped (per-repo file wins, then global
// path-map fallback) — set here so it persists across reopens.

export function AccountsProfiles({
  repoRoot,
  part,
}: {
  repoRoot: string;
  /** Account shows agent logins; Git shows the identities commits carry. */
  part: "account" | "git";
}) {
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [gitProfiles, setGitProfiles] = useState<GitProfile[]>([]);
  const [binding, setBinding] = useState<WorkspaceBinding>({});
  const [bindingScope, setBindingScope] = useState<"repo" | "global">("repo");
  const [newAgentName, setNewAgentName] = useState("");
  const [editingGit, setEditingGit] = useState<GitProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [aps, gps, b] = await Promise.all([
        api.agentProfileList(),
        api.gitProfileList(),
        repoRoot ? api.workspaceProfileGet(repoRoot) : Promise.resolve({} as WorkspaceBinding),
      ]);
      setAgentProfiles(aps);
      setGitProfiles(gps);
      setBinding(b ?? {});
      if (b?.source === "global") setBindingScope("global");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repoRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createAgentProfile() {
    const name = newAgentName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.agentProfileCreate(name);
      setNewAgentName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAgentProfile(name: string) {
    if (
      !(await askConfirm({
        title: `Delete profile "${name}"?`,
        body: `This removes ~/.aura/agent-profiles/${name}/. Every agent sign-in kept inside it (Claude tokens, Gemini config, and the rest) goes with it. You'll have to sign those agents in again.`,
        confirmLabel: "Delete profile",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      await api.agentProfileDelete(name);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGitProfile(p: GitProfile) {
    setBusy(true);
    setError(null);
    try {
      await api.gitProfileUpsert(p);
      setEditingGit(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGitProfile(id: string) {
    if (
      !(await askConfirm({
        title: `Delete git profile "${id}"?`,
        body: "The name and email it commits under are forgotten. This can't be undone.",
        confirmLabel: "Delete profile",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      await api.gitProfileDelete(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveBinding(next: WorkspaceBinding) {
    if (!repoRoot) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await api.workspaceProfileSet(repoRoot, next, bindingScope);
      setBinding(resolved ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const where = (
    <SettingsRow
      title="Where to save"
      description={
        binding.source === "repo"
          ? "Saved with the repository, so it travels to anyone who clones it."
          : binding.source === "global"
            ? "Saved on this computer only. Your teammates keep their own."
            : "Nothing saved for this repository yet."
      }
      control={
        <Select
          aria-label="Where to save"
          value={bindingScope}
          onChange={(v) => setBindingScope(v === "global" ? "global" : "repo")}
          options={[
            { value: "repo", label: "With the repository" },
            { value: "global", label: "Only on this computer" },
          ]}
        />
      }
    />
  );

  const workspace = repoRoot && (
    <Section title={`This workspace · ${shortPath(repoRoot)}`}>
      {part === "git" ? (
        <SettingsRow
          title="Git identity"
          description="The name and email this workspace's agents commit under."
          control={
            <Select
              aria-label="Git identity"
              // An identity deleted since it was picked no longer applies:
              // commits fall back to this computer's, so say that, not blank.
              value={
                binding.git_profile_id && gitProfiles.some((p) => p.id === binding.git_profile_id)
                  ? binding.git_profile_id
                  : "__none__"
              }
              onChange={(v) =>
                void saveBinding({ ...binding, git_profile_id: v === "__none__" ? null : v })
              }
              options={[
                // The thing that ends up on your commits, not the mechanism.
                { value: "__none__", label: "This computer's git identity" },
                ...gitProfiles.map((p) => ({ value: p.id, label: `${p.label} · ${p.user_email}` })),
              ]}
            />
          }
        />
      ) : (
        <SettingsRow
          title="Default agent profile"
          description="Which sign-ins this workspace's agents use."
          control={
            <Select
              aria-label="Default agent profile"
              value={binding.agent_profile_name ?? "__none__"}
              onChange={(v) =>
                void saveBinding({ ...binding, agent_profile_name: v === "__none__" ? null : v })
              }
              options={[
                // Agents sign in as they already are.
                { value: "__none__", label: "Your normal agent logins" },
                ...agentProfiles.map((p) => ({ value: p.name, label: p.label ?? p.name })),
              ]}
            />
          }
        />
      )}
      {where}
    </Section>
  );

  if (part === "account")
    return (
      <>
        {error && <SettingsError>{error}</SettingsError>}
        {workspace}
        <Section
          title="Agent profiles"
          description="Separate agent sign-ins, so you can run more than one account side by side."
        >
          {agentProfiles.length === 0 && <SettingsEmpty>No profiles yet.</SettingsEmpty>}
          {agentProfiles.map((p) => (
            <SettingsRow
              key={p.name}
              title={p.label ?? p.name}
              description={<code>~/.aura/agent-profiles/{p.name}</code>}
              control={
                <Button
                  size="sm"
                  variant="outlineDestructive"
                  onClick={() => void deleteAgentProfile(p.name)}
                  disabled={busy}
                >
                  Delete
                </Button>
              }
            />
          ))}
          <SettingsRow
            title="New profile"
            htmlFor="new-agent-profile"
            control={
              <SettingsActions>
                <Input
                  id="new-agent-profile"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  // What belongs here, not the field's own name.
                  placeholder="work, personal, a client's name…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createAgentProfile();
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void createAgentProfile()}
                  disabled={!newAgentName.trim() || busy}
                >
                  Create profile
                </Button>
              </SettingsActions>
            }
          />
        </Section>
      </>
    );

  return (
    <>
      {error && <SettingsError>{error}</SettingsError>}
      {workspace}
      <Section
        title="Git identities"
        description="Named identities a workspace can commit under without touching its git config."
      >
        {gitProfiles.length === 0 && <SettingsEmpty>No git profiles yet.</SettingsEmpty>}
        {gitProfiles.map((p) => (
          <SettingsRow
            key={p.id}
            title={p.label}
            description={
              <>
                {p.user_name} &lt;{p.user_email}&gt;
                {p.signing_key && <code> · key {p.signing_key}</code>}
              </>
            }
            control={
              <SettingsActions>
                <Button size="sm" variant="outline" onClick={() => setEditingGit(p)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outlineDestructive"
                  onClick={() => void deleteGitProfile(p.id)}
                  disabled={busy}
                >
                  Delete
                </Button>
              </SettingsActions>
            }
          />
        ))}
        {editingGit ? (
          <GitProfileEditor
            initial={editingGit}
            existingIds={new Set(gitProfiles.map((p) => p.id))}
            onCancel={() => setEditingGit(null)}
            onSave={(p) => void saveGitProfile(p)}
            busy={busy}
          />
        ) : (
          <SettingsRow
            title="Add git identity"
            description="A name, an email and, if you sign commits, a key."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setEditingGit({ id: "", label: "", user_name: "", user_email: "", signing_key: null })
                }
              >
                Add
              </Button>
            }
          />
        )}
      </Section>
    </>
  );
}
