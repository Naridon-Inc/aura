import { useState } from "react";
import {
  ArtifactBrowser,
  ArtifactDeleteDialog,
  ArtifactTemplateEditor,
  type ArtifactItem,
} from "../artifact-browser";
import { ArtifactView } from "../artifact";
import { FilePreview, type FilePreviewKind } from "../file-preview";
import { Select } from "../select";
import { Button } from "../button";
const initialArtifacts: ArtifactItem[] = [
  {
    id: "menu",
    title: "Command menu",
    description: "Interactive workspace navigation",
    updated: "2 minutes ago",
  },
  {
    id: "plan",
    title: "Implementation plan",
    description: "Review, build, and verify",
    updated: "12 minutes ago",
  },
  { id: "team", title: "Team template", description: "Shared workspace template", scope: "team" },
  {
    id: "community",
    title: "Getting started",
    description: "Community example",
    scope: "community",
  },
];
const html =
  '<html><body style="background:#141110;color:#eae8e6;font:14px system-ui;padding:24px"><h2>Command menu</h2><input placeholder="Search commands" style="background:#2c2826;color:inherit;border:1px solid #766f6b;padding:10px;border-radius:6px"><p>Workspace navigation preview</p></body></html>';
const imageUrl =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#211e1c"/><text x="32" y="132" fill="#eae8e6" font-size="24" font-family="sans-serif">Workspace preview</text></svg>',
  );
export function ArtifactPatternPreview() {
  const [state, setState] = useState<"ready" | "loading" | "error" | "archived">("ready"),
    [items, setItems] = useState(initialArtifacts);
  const [embedded, setEmbedded] = useState("available"),
    [fileState, setFileState] = useState("ready");
  const [templateValue, setTemplateValue] = useState({
      name: "Workspace overview",
      instructions: "Create a concise overview of the workspace.",
    }),
    [deleteTemplate, setDeleteTemplate] = useState(false);
  const [selected, setSelected] = useState<ArtifactItem>(),
    [deleting, setDeleting] = useState(false),
    [template, setTemplate] = useState(false);
  const [kind, setKind] = useState<FilePreviewKind>("text"),
    [text, setText] = useState("export const title = 'Workspace';"),
    [saved, setSaved] = useState(text),
    [openFile, setOpenFile] = useState(true),
    [notice, setNotice] = useState("");
  return (
    <div className="lab-pattern-stack">
      <div className="lab-pattern-controls">
        <Select
          aria-label="Artifact list state"
          value={state}
          onChange={(next) => setState(next as typeof state)}
          options={["ready", "loading", "error", "archived"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => setItems(items.length ? [] : initialArtifacts)}
        >
          {items.length ? "Show empty list" : "Restore artifacts"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTemplate(true)}>
          Edit template
        </Button>
        <Button size="sm" variant="outlineDestructive" onClick={() => setDeleteTemplate(true)}>
          Delete template
        </Button>
        <Select
          aria-label="Embedded artifact state"
          value={embedded}
          onChange={setEmbedded}
          options={["available", "loading", "missing"].map((value) => ({ value, label: value }))}
        />
      </div>
      <div className="lab-pattern-two-columns">
        <ArtifactBrowser
          items={items}
          state={state}
          onRefresh={() => {
            setState("ready");
            setItems(initialArtifacts);
          }}
          onUnarchive={() => setState("ready")}
          onOpen={setSelected}
          hasMore
          onLoadMore={() =>
            setItems([
              ...items,
              {
                id: crypto.randomUUID(),
                title: "Earlier artifact",
                description: "Loaded from preview history",
              },
            ])
          }
        />
        <div>
          {selected ? (
            <>
              <ArtifactView
                key={selected.id}
                title={selected.title}
                loading={embedded === "loading"}
                error={embedded === "missing" ? "This artifact is no longer available." : undefined}
                onRetry={() => setEmbedded("available")}
                versions={[
                  {
                    label: "Version 1",
                    content: html.replace("Workspace navigation preview", "Initial version"),
                  },
                  { label: "Version 2", content: html },
                ]}
              />
              <Button size="xs" variant="outlineDestructive" onClick={() => setDeleting(true)}>
                Delete artifact
              </Button>
            </>
          ) : (
            <div className="ui-pattern-empty">Select an artifact to inspect its versions.</div>
          )}
        </div>
      </div>
      <div className="lab-pattern-controls">
        <Select
          aria-label="File preview kind"
          value={kind}
          onChange={(next) => {
            setKind(next as FilePreviewKind);
            setOpenFile(true);
          }}
          options={["text", "image", "html", "pdf", "video", "audio"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Select
          aria-label="File state"
          value={fileState}
          onChange={setFileState}
          options={["ready", "loading", "error", "save-error", "external-change"].map((value) => ({
            value,
            label: value,
          }))}
        />
        {!openFile && (
          <Button size="sm" variant="outline" onClick={() => setOpenFile(true)}>
            Reopen file
          </Button>
        )}
      </div>
      {openFile && (
        <FilePreview
          key={kind}
          name={kind === "text" ? "App.tsx" : `preview.${kind}`}
          kind={kind}
          content={kind === "html" ? html : text}
          loading={fileState === "loading"}
          error={fileState === "error" ? "Could not load this file." : undefined}
          saveError={
            fileState === "save-error"
              ? "File update failed. Your local changes are preserved."
              : undefined
          }
          externalChange={fileState === "external-change"}
          onReload={() => setFileState("ready")}
          onKeepEdits={() => setFileState("ready")}
          onDiscardEdits={() => setFileState("ready")}
          url={
            kind === "image"
              ? imageUrl
              : kind === "pdf"
                ? new URL("./preview-document.pdf", import.meta.url).href
                : kind === "video"
                  ? new URL("./preview-media.mp4", import.meta.url).href
                  : kind === "audio"
                    ? new URL("./preview-media.wav", import.meta.url).href
                    : undefined
          }
          editable={kind === "text"}
          dirty={text !== saved}
          onChange={setText}
          onSave={() => {
            setFileState("ready");
            setSaved(text);
            setNotice("File saved in preview.");
          }}
          onClose={() => setOpenFile(false)}
        />
      )}
      <ArtifactDeleteDialog
        title={selected?.title ?? ""}
        open={deleting}
        onOpenChange={setDeleting}
        onDelete={() => {
          setItems(items.filter((item) => item.id !== selected?.id));
          setSelected(undefined);
          setNotice("Preview artifact removed.");
        }}
      />
      <ArtifactTemplateEditor
        open={template}
        onOpenChange={setTemplate}
        initialName={templateValue.name}
        initialInstructions={templateValue.instructions}
        onSave={(value) => {
          setTemplateValue(value);
          setNotice(`Template saved: ${value.name}`);
        }}
      />
      <ArtifactDeleteDialog
        kind="template"
        title={templateValue.name}
        open={deleteTemplate}
        onOpenChange={setDeleteTemplate}
        onDelete={() => {
          setTemplateValue({ name: "", instructions: "" });
          setNotice("Preview template removed.");
        }}
      />
      <output className="lab-pattern-output" aria-live="polite">
        {notice || "Choose an artifact or edit the sample file."}
      </output>
    </div>
  );
}
