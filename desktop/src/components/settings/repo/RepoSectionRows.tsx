import { type ReactNode } from "react";

import { type RepoWorktreeSettings } from "../../../lib/api";
import { SettingsField } from "../../ui/settings-controls";
import { RepoIconRow } from "../../repo-icon/RepoIconRow";
import { CopyFilesRow, NamedScriptsRow } from "./ScriptLists";

// The rows of a repository's three settings pages. The pane that holds them
// loads the repository's settings, keeps the draft and saves it whole.

interface RepoRowsProps {
  form: RepoWorktreeSettings;
  patch: (next: Partial<RepoWorktreeSettings>) => void;
}

const text = (value: string | boolean | number) => String(value);

export function RepoScriptsRows({ form, patch }: RepoRowsProps) {
  return (
    <div className="ui-settings-scripts">
      <SettingsField
        title="Startup script"
        description="Runs once when an agent's copy is first created (e.g. install dependencies)."
        type="textarea"
        value={form.setup ?? ""}
        onChange={(v) => patch({ setup: text(v) })}
        placeholder="npm install"
      />
      <SettingsField
        title="Run script"
        description="How to start the app inside a copy (e.g. npm run dev)."
        type="textarea"
        value={form.run ?? ""}
        onChange={(v) => patch({ run: text(v) })}
        placeholder="npm run dev"
      />
      <SettingsField
        title="Archive script"
        description="Runs when a copy is cleaned up."
        type="textarea"
        value={form.archive ?? ""}
        onChange={(v) => patch({ archive: text(v) })}
        placeholder="docker compose down"
      />
    </div>
  );
}

export function RepoActionsRows({
  form,
  patch,
  onAddScript,
  onChangeScript,
  onRemoveScript,
}: RepoRowsProps & {
  onAddScript: () => void;
  onChangeScript: (index: number, field: "name" | "command", value: string) => void;
  onRemoveScript: (index: number) => void;
}) {
  return (
    <>
      <NamedScriptsRow
        scripts={form.namedScripts}
        onAdd={onAddScript}
        onChange={onChangeScript}
        onRemove={onRemoveScript}
      />
      <SettingsField
        title="How the agent should review this repo"
        description="Added to every review the agent runs here. Say what to look for, what to ignore, and what always blocks."
        type="textarea"
        value={form.reviewInstructions ?? ""}
        onChange={(v) => patch({ reviewInstructions: text(v) })}
        placeholder="Flag any database change without a migration. Ignore formatting-only diffs."
      />
      <SettingsField
        title="How to write pull requests here"
        description="Added when the agent opens a pull request: title style, what the description must include, who to tag."
        type="textarea"
        value={form.prInstructions ?? ""}
        onChange={(v) => patch({ prInstructions: text(v) })}
        placeholder="Start the title with the ticket id. Link the design doc in the description."
      />
      <SettingsField
        title="How to resolve conflicts here"
        description="Added when the agent resolves merge conflicts: which side wins for which files, what to never merge by hand."
        type="textarea"
        value={form.conflictInstructions ?? ""}
        onChange={(v) => patch({ conflictInstructions: text(v) })}
        placeholder="Generated files under gen/ always take the main branch's version."
      />
    </>
  );
}

export function RepoMiscRows({
  repoRoot,
  form,
  patch,
  landing,
  branchOptions,
  onAddCopyFile,
  onRemoveCopyFile,
}: RepoRowsProps & {
  repoRoot: string;
  /** Where a new copy opens: yours rather than the repository's. */
  landing?: ReactNode;
  branchOptions: { value: string; label: string }[];
  onAddCopyFile: (name: string) => void;
  onRemoveCopyFile: (name: string) => void;
}) {
  return (
    <>
      <RepoIconRow repoRoot={repoRoot} />
      {landing}
      <SettingsField
        title="Start new copies from"
        // There is no blank to leave: the first option IS "Current
        // branch", so the description names it instead of asking for
        // an empty box the control cannot hold.
        description="The branch a new copy starts from. Current branch means whatever you have checked out when the copy is made."
        type="select"
        value={form.base || "__current__"}
        onChange={(v) => patch({ base: v === "__current__" ? null : text(v) })}
        options={branchOptions}
      />
      <CopyFilesRow files={form.copyFiles} onAdd={onAddCopyFile} onRemove={onRemoveCopyFile} />
      <SettingsField
        title="Copy binary files too"
        description="Off, files that look binary (images, archives, anything over 20 MB) are left out of the copy and noted in the log. Turn this on if a copy genuinely needs them."
        type="switch"
        value={form.copyFilesIncludeBinaries === true}
        onChange={(v) => patch({ copyFilesIncludeBinaries: v === true })}
      />
      <SettingsField
        title="GitHub host"
        description="Leave empty for github.com. Set your company's GitHub Enterprise address (for example github.mycompany.com) so pull requests and checks for this repository come from there."
        type="text"
        value={form.ghHost ?? ""}
        onChange={(v) => patch({ ghHost: text(v) })}
        placeholder="github.com"
      />
    </>
  );
}
