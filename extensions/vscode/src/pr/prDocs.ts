// Virtual document providers for `aura-pr-base:` and `aura-pr-head:`.
//
// vscode.diff(base, head, title) opens a side-by-side diff editor. We
// resolve each URI by shelling `aura pr file --pr N --path P --side base|head`,
// which returns the file contents at that revision (or empty for added/
// deleted files).

import * as vscode from "vscode";
import * as aura from "../auraClient";
import { PR_BASE_SCHEME, PR_HEAD_SCHEME } from "./prDetailPanel";

class PrSideProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly side: "base" | "head", private readonly cwdGetter: () => string | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cwd = this.cwdGetter();
    if (!cwd) return `// No workspace open.`;
    const path = decodeURIComponent(uri.path.replace(/^\//, ""));
    const params = new URLSearchParams(uri.query);
    const pr = params.get("pr");
    if (!pr) return "";
    try {
      return await aura.runText(["pr", "file", "--number", pr, "--path", path, "--side", this.side], { cwd });
    } catch {
      return "";
    }
  }
}

export function registerPrDocProviders(ctx: vscode.ExtensionContext, cwdGetter: () => string | null) {
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PR_BASE_SCHEME, new PrSideProvider("base", cwdGetter)),
    vscode.workspace.registerTextDocumentContentProvider(PR_HEAD_SCHEME, new PrSideProvider("head", cwdGetter)),
  );
}
