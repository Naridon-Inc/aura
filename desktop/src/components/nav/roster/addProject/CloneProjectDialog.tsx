// "Open GitHub project": paste a clone URL, choose where it goes, clone it, and
// open what arrived. The clone itself is the same `git_clone` command the
// first-run create page uses.

import { useEffect, useState, type KeyboardEvent } from "react";
import { api } from "../../../../lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { FailureBox, LocationField, PrimaryAction, WorkingLine } from "./ProjectDialogParts";
import {
  defaultProjectDir,
  isPrimaryChord,
  openCreatedProject,
  rememberProjectDir,
} from "./projectLocation";
import "./addProject.css";

export function CloneProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    let live = true;
    defaultProjectDir().then((d) => {
      if (live) setDir((cur) => cur || d);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const clone = async () => {
    setError(undefined);
    if (!url.trim()) {
      setError("Enter a repository URL");
      return;
    }
    if (!dir.trim()) {
      setError("Select a directory");
      return;
    }
    setBusy(true);
    try {
      const made = await api.gitClone(url.trim(), dir.trim());
      rememberProjectDir(dir);
      setUrl("");
      onOpenChange(false);
      openCreatedProject(made.root);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUrlKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isPrimaryChord(e) || busy || !url.trim() || !dir.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    void clone();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="ui-add-project-dialog">
        <DialogHeader>
          <DialogTitle>Clone GitHub repo</DialogTitle>
          <DialogDescription className="sr-only">Paste a clone URL.</DialogDescription>
        </DialogHeader>
        <div className="ui-add-project-body">
          <div className="ui-add-project-field">
            <Label htmlFor="git-url">Repository URL</Label>
            <Input
              id="git-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              onKeyDown={onUrlKey}
            />
          </div>
          <LocationField
            label="Location"
            value={dir}
            onChange={setDir}
            browseTitle="Choose where to clone the repository"
            disabled={busy}
          />
          {busy && <WorkingLine text="Cloning..." />}
          {error && <FailureBox message={error} />}
          <PrimaryAction
            label="Clone repo"
            busyLabel="Cloning..."
            busy={busy}
            disabled={busy || !url.trim() || !dir.trim()}
            onClick={() => void clone()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
