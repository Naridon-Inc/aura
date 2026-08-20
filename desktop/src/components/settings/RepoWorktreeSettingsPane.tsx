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

import { useCallback, useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { LoadingState } from "../ui/state";

import {
  api,
  repoWorktreeSettingsGet,
  repoWorktreeSettingsSet,
  type GitBranchRich,
  type RepoWorktreeSettings,
} from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Field, PaneIntro, Section, SelectField } from "./kit";

const EMPTY: RepoWorktreeSettings = {
  setup: null,
  run: null,
  archive: null,
  base: null,
  copyFiles: [],
  namedScripts: [],
};

// Trim a textarea draft down to a stored value: blank → null, so an empty
// box round-trips to the all-null "nothing configured" shape the backend
// hands back rather than an empty string the next load would dirty-check.
function nullable(text: string): string | null {
  const t = text.trim();
  return t.length > 0 ? t : null;
}

export function RepoWorktreeSettingsPane({ repoRoot }: { repoRoot: string }) {
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
      };
      await repoWorktreeSettingsSet(repoRoot, payload);
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
      <PaneIntro text="When you hand work to an agent it gets its own private copy of this project, so its edits never touch your live files. These settings control how those copies are made and run." />

      {loading ? (
        <LoadingState label="Loading this project's settings…" className="px-0 py-3" />
      ) : (
        <>
          {loadError && (
            <div className="mb-3 text-sm text-red" role="alert">
              Couldn't load these settings: {loadError}
            </div>
          )}

          <Section title="Scripts">
            <Field
              label="Startup script"
              hint="Runs once when an agent's copy is first created (e.g. install dependencies)."
            >
              <Textarea
                value={form.setup ?? ""}
                onChange={(e) => patch({ setup: e.target.value })}
                spellCheck={false}
                rows={3}
                placeholder="npm install"
                className="font-mono text-sm"
              />
            </Field>
            <Field
              label="Run script"
              hint="How to start the app inside a copy (e.g. npm run dev)."
            >
              <Textarea
                value={form.run ?? ""}
                onChange={(e) => patch({ run: e.target.value })}
                spellCheck={false}
                rows={3}
                placeholder="npm run dev"
                className="font-mono text-sm"
              />
            </Field>
            <Field
              label="Archive script"
              hint="Runs when a copy is cleaned up."
            >
              <Textarea
                value={form.archive ?? ""}
                onChange={(e) => patch({ archive: e.target.value })}
                spellCheck={false}
                rows={3}
                placeholder="docker compose down"
                className="font-mono text-sm"
              />
            </Field>
            <Field
              label="Named scripts"
              hint="Extra commands you can launch by name from the project header."
            >
              <div className="flex flex-col gap-2">
                {form.namedScripts.map((script, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={script.name}
                      onChange={(event) => updateNamedScript(index, "name", event.target.value)}
                      placeholder="Dev"
                      className="w-32"
                    />
                    <Input
                      value={script.command}
                      onChange={(event) => updateNamedScript(index, "command", event.target.value)}
                      placeholder="npm run dev"
                      className="flex-1 font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${script.name || "script"}`}
                      onClick={() => removeNamedScript(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" size="sm" onClick={addNamedScript}>
                  <Plus className="h-3.5 w-3.5" />
                  Add script
                </Button>
              </div>
            </Field>
          </Section>

          <Section title="New copies">
            <Field
              label="Start new copies from"
              // "Blank = current branch" outlived the text input it was
              // written for. There is no blank to leave any more — the first
              // option in the list IS "Current branch" — so the hint asked for
              // something the control cannot do.
              hint="The branch a new copy starts from. Current branch means whatever you have checked out when the copy is made."
            >
              <SelectField
                value={form.base || "__current__"}
                onChange={(v) => patch({ base: v === "__current__" ? null : v })}
                options={branchOptions}
                widthClass="w-full"
                placeholder="Current branch"
              />
            </Field>

            <CopyFilesField
              files={form.copyFiles}
              onAdd={addCopyFile}
              onRemove={removeCopyFile}
            />
          </Section>

          <div className="mt-1 flex items-center gap-3">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <>
                  <AsciiSpinner className="text-sm leading-none" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
            {saved && !saveError && (
              <span className="flex items-center gap-1 text-sm text-accent-green">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
            {saveError && (
              <span className="text-sm text-red" role="alert">
                Couldn't save: {saveError}
              </span>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ── Files-to-copy editor ──────────────────────────────────────────────────
// An editable list of out-of-git filenames (chips + add row). Files like
// `.env` aren't committed but an agent's copy still needs them to run, so
// this seeds them into each fresh copy. A one-tap "Add .env" affordance
// covers the overwhelmingly common case.
function CopyFilesField({
  files,
  onAdd,
  onRemove,
}: {
  files: string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    onAdd(draft);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-1.5 py-3">
      <span className="text-sm font-medium text-text-2">
        Files to copy into each new copy
      </span>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span
              key={f}
              className="inline-flex items-center gap-1.5 rounded-md border border-line-soft bg-bg-2 px-2 py-1 text-sm text-text-1"
            >
              <span className="font-mono">{f}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${f}`}
                onClick={() => onRemove(f)}
                className="h-auto w-auto text-text-4 hover:text-red"
              >
                <X className="h-3 w-3" />
              </Button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder=".env"
          spellCheck={false}
          className="h-7 flex-1 font-mono text-sm"
        />
        <Button
          variant="subtle"
          size="sm"
          onClick={commit}
          disabled={!draft.trim()}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
        {!files.includes(".env") && (
          <Button variant="ghost" size="sm" onClick={() => onAdd(".env")}>
            Add .env
          </Button>
        )}
      </div>

      {/* "Supports .env*" ended the sentence on a bare asterisk, which reads
          as a footnote marker with no footnote. It is a wildcard, and saying
          so costs one clause. */}
      <span className="text-sm leading-snug text-text-4">
        Files like .env that aren't in git but an agent's copy needs to run. End
        a name with * to match a family — .env* also brings .env.local.
      </span>
    </div>
  );
}
