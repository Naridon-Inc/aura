// "Quick start": name a project, choose its parent folder and a starting
// point, and it is made and opened. Every template is one the backend already
// builds — an empty repository through `git_init`, the two starters through
// `scaffold_template` — each committed once so the project has a history.

import { useEffect, useState, type KeyboardEvent } from "react";
import { FileCode2, FileText, FolderGit2, type LucideIcon } from "lucide-react";
import { api, type NewRepo } from "../../../../lib/api";
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
  projectSlug,
  rememberProjectDir,
} from "./projectLocation";
import "./addProject.css";

type TemplateId = "empty" | "minimal" | "node-ts";

const TEMPLATES: { value: TemplateId; label: string; description: string; icon: LucideIcon }[] = [
  { value: "empty", label: "Empty", description: "Blank Git repo", icon: FolderGit2 },
  { value: "minimal", label: "Minimal", description: "README and .gitignore", icon: FileText },
  { value: "node-ts", label: "Node + TypeScript", description: "tsconfig and src/index.ts", icon: FileCode2 },
];

const DEFAULT_NAME = "aura-playground";

function make(template: TemplateId, dir: string, name: string): Promise<NewRepo> {
  return template === "empty"
    ? api.gitInit(dir, name)
    : api.scaffoldTemplate(dir, name, template);
}

export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [dir, setDir] = useState("");
  const [template, setTemplate] = useState<TemplateId>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const slug = projectSlug(name.trim());
  const unusable = name.trim().length > 0 && slug.length === 0;

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

  const create = async () => {
    setError(undefined);
    if (!slug) {
      setError("Enter a project name");
      return;
    }
    if (!dir.trim()) {
      setError("Select a directory");
      return;
    }
    setBusy(true);
    try {
      const made = await make(template, dir.trim(), slug);
      rememberProjectDir(dir);
      setName("");
      onOpenChange(false);
      openCreatedProject(made.root);
    } catch (e) {
      setError(`Couldn't create project: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isPrimaryChord(e) || busy || !slug || !dir.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    void create();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="ui-add-project-dialog">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>Create a local folder with a Git repo, and open it.</DialogDescription>
        </DialogHeader>
        <div className="ui-add-project-body">
          <div className="ui-add-project-field">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              onKeyDown={onNameKey}
            />
            {slug ? (
              <p className="ui-add-project-hint">
                Creates folder and repo <code>{slug}</code>
              </p>
            ) : unusable ? (
              <p className="ui-add-project-hint" data-error>
                Name must include letters or numbers.
              </p>
            ) : null}
          </div>
          <LocationField
            label="Parent folder"
            value={dir}
            onChange={setDir}
            browseTitle="Choose where to create the project"
            disabled={busy}
          />
          <div className="ui-add-project-field">
            <Label>Template</Label>
            <div className="ui-add-project-templates" role="radiogroup" aria-label="Template">
              {TEMPLATES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={template === t.value}
                  data-selected={template === t.value || undefined}
                  className="ui-add-project-template"
                  onClick={() => setTemplate(t.value)}
                  disabled={busy}
                >
                  <span className="ui-add-project-template-icon">
                    <t.icon size={24} />
                  </span>
                  <span className="ui-add-project-template-text">
                    <span className="ui-add-project-template-label">{t.label}</span>
                    <span className="ui-add-project-template-note">{t.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {busy && <WorkingLine text="Creating project..." />}
          {error && <FailureBox message={error} />}
          <PrimaryAction
            label="Create"
            busyLabel="Creating..."
            busy={busy}
            disabled={busy || !slug || !dir.trim()}
            onClick={() => void create()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
