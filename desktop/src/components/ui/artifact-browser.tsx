import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, FileCode2, Search, RefreshCw, Trash2, ChevronRight } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { AsciiSpinner } from "./ascii-spinner";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";
export interface ArtifactItem {
  id: string;
  title: string;
  description?: string;
  updated?: string;
  kind?: string;
  scope?: "workspace" | "team" | "community";
  preview?: ReactNode;
}
export function ArtifactBrowser({
  items,
  state = "ready",
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  onRefresh,
  onUnarchive,
  onOpen,
}: {
  items: ArtifactItem[];
  state?: "ready" | "loading" | "error" | "archived";
  error?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onRefresh?: () => void;
  onUnarchive?: () => void;
  onOpen: (item: ArtifactItem) => void;
}) {
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState("workspace");
  const scopeList = useRef<HTMLDivElement>(null);
  const scopeId = useId();
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (item.scope ?? "workspace") === scope &&
          `${item.title} ${item.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [items, query, scope],
  );
  return (
    <section className="ui-artifact-browser" aria-label="Artifact browser">
      <div className="ui-artifact-browser-toolbar">
        <Search size={14} />
        <input
          aria-label="Search artifacts"
          placeholder="Search artifacts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {onRefresh && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Refresh artifacts"
            disabled={state === "loading"}
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
      <div
        ref={scopeList}
        className="ui-artifact-scopes"
        role="tablist"
        aria-label="Artifact scope"
      >
        {["workspace", "team", "community"].map((key) => (
          <button
            key={key}
            id={`${scopeId}-${key}`}
            role="tab"
            aria-controls={`${scopeId}-panel`}
            aria-selected={scope === key}
            tabIndex={scope === key ? 0 : -1}
            onClick={() => setScope(key)}
            onKeyDown={(event) => {
              const scopes = ["workspace", "team", "community"];
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : (scopes.indexOf(scope) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                setScope(scopes[next]);
                scopeList.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }
            }}
          >
            {key === "workspace" ? "Workspace" : key === "team" ? "Team" : "Community"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${scopeId}-panel`} aria-labelledby={`${scopeId}-${scope}`}>
        {state === "loading" ? (
          <div className="ui-pattern-empty" role="status">
            <AsciiSpinner />
            Loading artifacts…
          </div>
        ) : state === "error" ? (
          <div className="ui-pattern-empty" role="alert">
            {error ?? "Could not load artifacts."}
            {onRefresh && (
              <Button size="sm" variant="outline" onClick={onRefresh}>
                Try again
              </Button>
            )}
          </div>
        ) : state === "archived" ? (
          <div className="ui-pattern-empty">
            <Box />
            <p>Unarchive this workspace to view its artifacts.</p>
            {onUnarchive && (
              <Button size="sm" onClick={onUnarchive}>
                Unarchive workspace
              </Button>
            )}
          </div>
        ) : !filtered.length ? (
          <div className="ui-pattern-empty">
            <Box />
            <p>{query ? "No matching artifacts" : "No artifacts yet"}</p>
            <small>
              {query ? "Try another search." : "Artifacts created in your chats appear here."}
            </small>
          </div>
        ) : (
          <div className="ui-artifact-browser-list">
            {filtered.map((item) => (
              <button className="ui-artifact-list-item" key={item.id} onClick={() => onOpen(item)}>
                {item.preview && <div className="ui-artifact-thumbnail">{item.preview}</div>}
                <div>
                  <FileCode2 size={16} />
                  <span>
                    {item.title}
                    {item.description && <small>{item.description}</small>}
                  </span>
                  <ChevronRight size={14} />
                </div>
                {item.updated && <time>{item.updated}</time>}
              </button>
            ))}
          </div>
        )}
        {state === "ready" && hasMore && onLoadMore && (
          <Button
            className="ui-artifact-load-more"
            size="sm"
            variant="ghost"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </section>
  );
}
export function ArtifactDeleteDialog({
  title,
  open,
  onOpenChange,
  onDelete,
  kind = "artifact",
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  kind?: "artifact" | "template";
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete {kind}?</AlertDialogTitle>
        <AlertDialogDescription>
          “{title}”{kind === "artifact" ? " and its versions" : ""} will be permanently deleted.
          This cannot be undone.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="ui-button-danger" onClick={onDelete}>
            <Trash2 />
            Delete {kind}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function ArtifactTemplateEditor({
  initialName = "",
  initialInstructions = "",
  open,
  onOpenChange,
  onSave,
}: {
  initialName?: string;
  initialInstructions?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (template: { name: string; instructions: string }) => void;
}) {
  const [name, setName] = useState(initialName),
    [instructions, setInstructions] = useState(initialInstructions);
  useEffect(() => {
    if (open) {
      setName(initialName);
      setInstructions(initialInstructions);
    }
  }, [open, initialName, initialInstructions]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Edit artifact template</DialogTitle>
        <DialogDescription>
          Set the name and instructions used to create this artifact.
        </DialogDescription>
        <label className="ui-form-field">
          Name
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="ui-form-field">
          Instructions
          <Textarea
            rows={6}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !instructions.trim()}
            onClick={() => {
              onSave({ name: name.trim(), instructions });
              onOpenChange(false);
            }}
          >
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
