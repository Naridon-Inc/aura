// "Copies & scripts" — per-project settings for the isolated copies an agent
// works in. When you hand a job to an agent it gets its own private copy of
// your project so its edits never touch your live files; this pane configures
// how those copies are made: the script that runs once when a copy is first
// created (install deps), how to start the app inside one, what to run when a
// copy is cleaned up, which branch new copies start from, and the out-of-git
// files (like `.env`) that have to be seeded in for the app to actually run.
//
// Plain language throughout — the audience is non-engineers. We say "a copy of
// your project" rather than "worktree", "when an agent starts" rather than
// "lease/checkout". The pane reads its initial state from the backend on mount,
// edits a local draft, and writes the whole settings object back on Save. The
// two backend commands are wrapped in lib/api.ts (`repoWorktreeSettingsGet` /
// `repoWorktreeSettingsSet`); until the Rust side ships they simply reject, and
// the load/save error lines surface that honestly rather than swallowing it.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import {
  api,
  repoWorktreeSettingsGet,
  repoWorktreeSettingsSet,
  type GitBranchRich,
  type RepoWorktreeSettings,
} from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { SettingsActions, SettingsError, SettingsIntro } from "../ui/settings-blocks";
import { type RepoSection } from "./nav";
import { RepoActionsRows, RepoMiscRows, RepoScriptsRows } from "./repo/RepoSectionRows";
import { REPO_SCRIPTS_CHANGED } from "../terminal/terminalStrip";

const EMPTY: RepoWorktreeSettings = {
  setup: null,
  run: null,
  archive: null,
  base: null,
  copyFiles: [],
  namedScripts: [],
  copyFilesIncludeBinaries: false,
  reviewInstructions: null,
  prInstructions: null,
  conflictInstructions: null,
  ghHost: null,
};

// Trim a textarea draft down to a stored value: blank → null, so an empty
// box round-trips to the all-null "nothing configured" shape the backend
// hands back rather than an empty string the next load would dirty-check.
function nullable(text: string): string | null {
  const t = text.trim();
  return t.length > 0 ? t : null;
}

export function RepoWorktreeSettingsPane({
  repoRoot,
  section,
  landing,
}: {
  repoRoot: string;
  /** Which of the repository's pages to draw. Save writes every page's settings. */
  section: RepoSection;
  /** A row that is yours rather than the repo's (where a new copy opens),
   *  drawn first among the new-copy settings it belongs with. */
  landing?: ReactNode;
}) {
  const [form, setForm] = useState<RepoWorktreeSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Branches for the "start new copies from" picker. Best-effort: if the
  // call fails we just drop to the blank/current-branch option rather than
  // blocking the rest of the pane (never a fake list).
  const [branches, setBranches] = useState<GitBranchRich[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await repoWorktreeSettingsGet(repoRoot);
      setForm({
        setup: s.setup ?? null,
        run: s.run ?? null,
        archive: s.archive ?? null,
        base: s.base ?? null,
        copyFiles: Array.isArray(s.copyFiles) ? s.copyFiles : [],
        namedScripts: Array.isArray(s.namedScripts) ? s.namedScripts : [],
        copyFilesIncludeBinaries: s.copyFilesIncludeBinaries === true,
        reviewInstructions: s.reviewInstructions ?? null,
        prInstructions: s.prInstructions ?? null,
        conflictInstructions: s.conflictInstructions ?? null,
        ghHost: s.ghHost ?? null,
      });
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    api
      .gitBranchesRich(repoRoot)
      .then((rows) => {
        if (alive) setBranches(rows);
      })
      .catch(() => {
        if (alive) setBranches([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Editing anything clears a lingering "Saved" tick so it never lies about
  // the current draft being persisted.
  function patch(next: Partial<RepoWorktreeSettings>) {
    setForm((f) => ({ ...f, ...next }));
    setSaved(false);
  }

  function addCopyFile(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setForm((f) =>
      f.copyFiles.includes(trimmed)
        ? f
        : { ...f, copyFiles: [...f.copyFiles, trimmed] },
    );
    setSaved(false);
  }

  function removeCopyFile(name: string) {
    setForm((f) => ({
      ...f,
      copyFiles: f.copyFiles.filter((c) => c !== name),
    }));
    setSaved(false);
  }

  function addNamedScript() {
    setForm((current) => ({
      ...current,
      namedScripts: [
        ...current.namedScripts,
        { name: `Script ${current.namedScripts.length + 1}`, command: "" },
      ],
    }));
    setSaved(false);
  }

  function updateNamedScript(index: number, field: "name" | "command", value: string) {
    setForm((current) => ({
      ...current,
      namedScripts: current.namedScripts.map((script, row) =>
        row === index ? { ...script, [field]: value } : script,
      ),
    }));
    setSaved(false);
  }

  function removeNamedScript(index: number) {
    setForm((current) => ({
      ...current,
      namedScripts: current.namedScripts.filter((_, row) => row !== index),
    }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const payload: RepoWorktreeSettings = {
        setup: nullable(form.setup ?? ""),
        run: nullable(form.run ?? ""),
        archive: nullable(form.archive ?? ""),
        base: nullable(form.base ?? ""),
        copyFiles: form.copyFiles,
        namedScripts: form.namedScripts
          .map((script) => ({
            name: script.name.trim(),
            command: script.command.trim(),
          }))
          .filter((script) => script.name && script.command),
        copyFilesIncludeBinaries: form.copyFilesIncludeBinaries === true,
        reviewInstructions: nullable(form.reviewInstructions ?? ""),
        prInstructions: nullable(form.prInstructions ?? ""),
        conflictInstructions: nullable(form.conflictInstructions ?? ""),
        ghHost: nullable(form.ghHost ?? ""),
      };
      await repoWorktreeSettingsSet(repoRoot, payload);
      // The terminal panel's Setup and Run tabs read these; let them re-read.
      window.dispatchEvent(new CustomEvent(REPO_SCRIPTS_CHANGED, { detail: { repoRoot } }));
      setForm(payload);
      setSaved(true);
      // Let live consumers (the header Run/Setup button) re-read without a
      // project reswitch.
      window.dispatchEvent(new CustomEvent("aura:worktree-settings-saved"));
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Branch options: a blank "current branch" default plus every branch the
  // repo reports. Remotes are labelled so picking `origin/main` reads clearly.
  const branchOptions = [
    { value: "__current__", label: "Current branch" },
    ...branches.map((b) => ({
      value: b.name,
      label: b.isRemote ? `${b.name} (remote)` : b.name,
    })),
  ];

  return (
    <>
      {section === "scripts" && (
        <SettingsIntro>
          When you hand work to an agent it gets its own private copy of this repository, so its
          edits never touch your live files. These scripts run in those copies.
        </SettingsIntro>
      )}

      {loading ? (
        <p className="ui-settings-status" role="status">
          <AsciiSpinner />
          Loading this repository's settings…
        </p>
      ) : (
        <>
          {loadError && <SettingsError>Couldn't load these settings: {loadError}</SettingsError>}

          {section === "scripts" && <RepoScriptsRows form={form} patch={patch} />}
          {section === "actions" && (
            <RepoActionsRows
              form={form}
              patch={patch}
              onAddScript={addNamedScript}
              onChangeScript={updateNamedScript}
              onRemoveScript={removeNamedScript}
            />
          )}
          {section === "misc" && (
            <RepoMiscRows
              repoRoot={repoRoot}
              form={form}
              patch={patch}
              landing={landing}
              branchOptions={branchOptions}
              onAddCopyFile={addCopyFile}
              onRemoveCopyFile={removeCopyFile}
            />
          )}

          {saveError && <SettingsError>Couldn't save: {saveError}</SettingsError>}
          <SettingsActions>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <>
                  <AsciiSpinner />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
            {saved && !saveError && (
              <span className="ui-settings-status">
                <Check size={14} />
                Saved
              </span>
            )}
          </SettingsActions>
        </>
      )}
    </>
  );
}
