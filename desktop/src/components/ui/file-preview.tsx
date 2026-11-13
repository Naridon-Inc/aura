import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Save, X } from "lucide-react";
import { Button } from "./button";
import { AsciiSpinner } from "./ascii-spinner";
import { FileChangedBanner } from "./file-changed-banner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";
export type FilePreviewKind = "text" | "image" | "pdf" | "video" | "audio" | "html";
export function FilePreview({
  name,
  kind,
  content = "",
  url,
  loading,
  error,
  saveError,
  editable,
  dirty,
  saving,
  externalChange,
  onChange,
  onSave,
  onReload,
  onKeepEdits,
  onDiscardEdits,
  onClose,
  actions,
  children,
}: {
  name: string;
  kind: FilePreviewKind;
  content?: string;
  url?: string;
  loading?: boolean;
  error?: string;
  editable?: boolean;
  dirty?: boolean;
  saving?: boolean;
  saveError?: string;
  /** The file changed on disk under unsaved edits: shows the strip that
   *  asks whether to keep them or discard them. */
  externalChange?: boolean;
  onChange?: (content: string) => void;
  onSave?: () => void;
  onReload?: () => void;
  onKeepEdits?: () => void;
  onDiscardEdits?: () => void;
  onClose?: () => void;
  /** The host's own controls, drawn in the header before Save and close. */
  actions?: ReactNode;
  /** The host's own body (an editor, a diff, a rendered page) in place of
   *  the kind's built-in one. Loading and error states still come first. */
  children?: ReactNode;
}) {
  const [confirm, setConfirm] = useState(false),
    [failed, setFailed] = useState(false),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  useEffect(() => {
    setFailed(false);
    setCopied(false);
    setCopyError(false);
  }, [name, kind, url, content]);
  return (
    <section className="ui-file-view">
      <header>
        <span>{name}</span>
        {dirty && <small>Unsaved</small>}
        {kind === "text" && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Copy file content"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(content);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        )}
        {actions}
        {editable && onSave && (
          <Button size="xs" variant="outline" disabled={!dirty || saving} onClick={onSave}>
            <Save />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        {onClose && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Close file"
            onClick={() => (dirty ? setConfirm(true) : onClose())}
          >
            <X />
          </Button>
        )}
      </header>
      {externalChange && onKeepEdits && onDiscardEdits && (
        <FileChangedBanner onKeep={onKeepEdits} onDiscard={onDiscardEdits} />
      )}
      {saveError && (
        <div className="ui-session-banner" role="alert">
          {saveError}
          {onSave && (
            <Button size="xs" variant="outline" disabled={saving} onClick={onSave}>
              Retry save
            </Button>
          )}
        </div>
      )}
      {copyError && (
        <div className="ui-session-banner" role="status">
          Could not copy this file. Select its text to copy manually.
        </div>
      )}
      {loading ? (
        <div className="ui-pattern-empty">
          <AsciiSpinner />
          Loading file…
        </div>
      ) : error || failed ? (
        <div className="ui-pattern-empty" role="alert">
          {error ?? "Could not display or copy this file."}
          {onReload && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFailed(false);
                onReload();
              }}
            >
              Try again
            </Button>
          )}
        </div>
      ) : children !== undefined ? (
        children
      ) : kind === "text" ? (
        editable && onChange ? (
          <textarea
            className="ui-file-editor"
            aria-label={`Edit ${name}`}
            value={content}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <pre className="ui-file-source">{content}</pre>
        )
      ) : kind === "html" ? (
        <iframe title={name} srcDoc={content} sandbox="allow-scripts" />
      ) : !url ? (
        <div className="ui-pattern-empty">File unavailable</div>
      ) : kind === "image" ? (
        <img className="ui-file-image" src={url} alt={name} onError={() => setFailed(true)} />
      ) : kind === "pdf" ? (
        <object type="application/pdf" data={url} aria-label={name}>
          <a href={url} download={name}>
            Download PDF
          </a>
        </object>
      ) : kind === "video" ? (
        <video src={url} controls onError={() => setFailed(true)} />
      ) : (
        <audio src={url} controls onError={() => setFailed(true)} />
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your changes to {name} have not been saved.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
