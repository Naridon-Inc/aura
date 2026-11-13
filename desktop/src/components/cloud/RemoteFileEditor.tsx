// One file of a project on a machine, in the same file view and editor the
// local workspace's file tab uses. Reads it over there when mounted, keeps
// what you type, and writes it back on ⌘S or the view's Save button.
//
// Saving is explicit, not on every keystroke: a write is a round trip to
// the machine, and a half-typed line is not something to send. The view's
// "Unsaved" mark says a save is owed; a write that fails keeps the buffer
// and offers the save again.

import { useCallback, useEffect, useState } from "react";

import type { FileContent } from "../../lib/api";
import * as work from "../../lib/place/workApi";
import { MonacoEditor as Editor } from "../MonacoEditor";
import { FilePreview } from "../ui/file-preview";
import "../ui/file-tab.css";
import "../ui/remote-work.css";

type Load =
  | { state: "loading" }
  | { state: "failed"; why: string }
  | { state: "loaded"; file: FileContent };

export function RemoteFileEditor({
  repoRoot,
  path,
  machineName,
}: {
  repoRoot: string;
  /** Local-spelled path under `repoRoot`; the wire re-roots it. */
  path: string;
  machineName: string;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped by "Try again" on a failed read, to ask the machine once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    work
      .readFile(path)
      .then((file) => {
        if (!live) return;
        setText(file.text);
        setSavedText(file.text);
        setLoad({ state: "loaded", file });
      })
      .catch((e) => {
        if (live) setLoad({ state: "failed", why: String(e) });
      });
    return () => {
      live = false;
    };
  }, [path, attempt]);

  const dirty = text !== savedText;

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await work.writeFile(path, text);
      setSavedText(text);
    } catch (e) {
      setSaveError(
        `Couldn't save ${path.split("/").pop()} to ${machineName}: ${String(e)}. Your changes are still here.`,
      );
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, path, text, machineName]);

  // ⌘S here, and only here — stopped before the window's own handler
  // saves the local editor's file underneath this workspace.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    },
    [save],
  );

  const rel = path.startsWith(repoRoot + "/")
    ? path.slice(repoRoot.length + 1)
    : path;

  // Not drawn as text until there is text, so the view's header offers no
  // copy of an empty buffer while it reads or after it could not.
  if (load.state === "loading") {
    return <FilePreview name={rel} kind="image" loading />;
  }

  if (load.state === "failed") {
    return (
      <FilePreview
        name={rel}
        kind="image"
        error={`${machineName} could not read ${rel}. ${load.why}`}
        onReload={() => setAttempt((n) => n + 1)}
      />
    );
  }

  const { file } = load;
  if (file.status !== "ok") {
    return (
      <FilePreview
        name={rel}
        kind="image"
        error={
          file.status === "binary"
            ? `${rel} is not a text file, so there is nothing to show as text.`
            : `${rel} is too large to open here (${Math.round(file.size / 1024)} KB). Open it in a terminal on ${machineName} instead.`
        }
      />
    );
  }

  return (
    <div className="ui-remote-file" onKeyDownCapture={onKeyDown}>
      <FilePreview
        name={rel}
        kind="text"
        content={text}
        editable
        dirty={dirty}
        saving={saving}
        saveError={saveError ?? undefined}
        onSave={() => void save()}
      >
        <div className="ui-file-tab-body">
          <Editor
            value={text}
            language={file.language}
            onChange={setText}
            filePath={path}
            repoRoot={repoRoot}
          />
        </div>
      </FilePreview>
    </div>
  );
}
