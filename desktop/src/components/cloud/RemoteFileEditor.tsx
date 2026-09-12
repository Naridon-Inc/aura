// One file of a project on a machine, in the same editor the local
// workspace uses. Reads it over there when mounted, keeps what you type,
// and writes it back on ⌘S or the Save button.
//
// Saving is explicit, not on every keystroke: a write is a round trip to
// the machine, and a half-typed line is not something to send. The dirty
// mark on the button says a save is owed.

import { useCallback, useEffect, useState } from "react";

import type { FileContent } from "../../lib/api";
import * as work from "../../lib/place/workApi";
import { MonacoEditor as Editor } from "../MonacoEditor";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

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
  }, [path]);

  const dirty = text !== savedText;

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await work.writeFile(path, text);
      setSavedText(text);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, path, text]);

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

  if (load.state === "loading") {
    return (
      <div className="px-4 py-3 text-sm text-text-3">
        <AsciiSpinner /> Reading {rel} from {machineName}…
      </div>
    );
  }

  if (load.state === "failed") {
    return (
      <div className="px-4 py-3 text-sm text-text-3">
        <div className="text-text-2">{machineName} could not read {rel}.</div>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">
          {load.why}
        </pre>
      </div>
    );
  }

  const { file } = load;
  if (file.status !== "ok") {
    return (
      <div className="px-4 py-3 text-sm text-text-3">
        {file.status === "binary"
          ? `${rel} is not a text file, so there is nothing to show as text.`
          : `${rel} is too large to open here (${Math.round(file.size / 1024)} KB). Open it in a terminal on ${machineName} instead.`}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDown}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-3" title={path}>
          {rel}
          {dirty && <span className="ml-1 text-text-4">●</span>}
        </span>
        {saveError && (
          <span className="truncate text-xs text-danger" title={saveError}>
            {saveError}
          </span>
        )}
        <Button
          size="sm"
          variant={dirty ? "default" : "secondary"}
          disabled={!dirty || saving}
          onClick={() => void save()}
          title={`Write the file back to ${machineName} (⌘S)`}
        >
          {saving ? <AsciiSpinner /> : dirty ? "Save" : "Saved"}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          value={text}
          language={file.language}
          onChange={setText}
          filePath={path}
          repoRoot={repoRoot}
        />
      </div>
    </div>
  );
}
