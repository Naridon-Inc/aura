// Read-side virtual document provider for `aura-memory:` URIs.
//
// We register this with vscode.workspace.registerTextDocumentContentProvider
// so the URI resolves to the current memory body. Writes go through a
// FileSystemProvider (omitted in V2 — V2 ships read-only edit-via-input-box;
// V3 will promote to a full FSP that lets the user save with ⌘S).

import * as vscode from "vscode";
import * as aura from "../auraClient";

export const MEMORY_SCHEME = "aura-memory";

export class MemoryDocsProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly cwdGetter: () => string | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cwd = this.cwdGetter();
    if (!cwd) return "// No workspace folder open.";
    const key = uri.path.replace(/^\//, "");
    try {
      const r = await aura.runJson<{ key: string; body: string }>(["memory", "read", key], { cwd });
      return r.body;
    } catch (err) {
      return `// Failed to read memory key '${key}': ${(err as Error).message}`;
    }
  }

  reload(uri: vscode.Uri) { this._onDidChange.fire(uri); }
}

export function memoryUri(key: string): vscode.Uri {
  return vscode.Uri.parse(`${MEMORY_SCHEME}:/${encodeURIComponent(key)}`);
}
