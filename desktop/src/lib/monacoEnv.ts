// Monaco worker bootstrap. Must run before any Monaco code touches a model
// so the editor can find its language workers locally (Tauri ships offline,
// so we cannot use the default CDN loader).

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(_moduleId: string, label: string): Worker;
    };
  }
}

let installed = false;

export function installMonacoEnvironment(): void {
  if (installed) return;
  installed = true;
  // Point @monaco-editor/react at the monaco we already bundle, so <Editor>
  // initializes SYNCHRONOUSLY from the ESM bundle instead of doing an async
  // `loader.init()` round-trip. That round-trip resolves on a main-thread
  // continuation, which a busy event loop can starve indefinitely — e.g. an
  // `fs:changed` flood from a repo with a live `pgdata/` dir — leaving every
  // file tab stuck on Monaco's built-in "Loading…" fallback that never
  // mounts. Tauri is offline so the loader could never reach its CDN anyway;
  // the bundle is the only correct source. Must run before the first <Editor>
  // renders — installMonacoEnvironment() is called at module top-level in
  // every editor entry (MonacoEditor/DiffView/SplitDiff/…), which guarantees
  // that ordering.
  loader.config({ monaco });
  self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };
}
