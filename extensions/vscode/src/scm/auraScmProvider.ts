// Aura SourceControl provider.
//
// Registers a vscode.SourceControl with id "aura" alongside Git. The
// inputBox is treated as the **intent**, not a commit message —
// accepting it calls `aura log-intent` and then `aura save`. The two
// resource groups mirror our SCM Tree:
//
//   • changed  — files modified since the last snapshot (`aura status`).
//   • intents  — pending intent log entries that haven't yet been
//                committed.
//
// Quick-diff: a TextDocumentContentProvider on `aura-snapshot:` URIs
// returns the last-snapshot body for the file, so VS Code's gutter
// shows AST-aware diff dots — diverging from "what git knows" by
// using the snapshot baseline instead.

import * as path from "node:path";
import * as vscode from "vscode";
import * as aura from "../auraClient";

interface ScmDump {
  changed_files: Array<{ path: string; status: "M" | "A" | "D" | "?" }>;
  pending_intents: Array<{ id: string; message: string; ts: string }>;
}

const SNAP_SCHEME = "aura-snapshot";

class AuraQuickDiffProvider implements vscode.QuickDiffProvider, vscode.TextDocumentContentProvider {
  constructor(private readonly cwdGetter: () => string | null) {}

  provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    if (uri.scheme !== "file") return null;
    return uri.with({ scheme: SNAP_SCHEME, query: `t=${Date.now()}` });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cwd = this.cwdGetter();
    if (!cwd) return "";
    const filePath = uri.fsPath || decodeURIComponent(uri.path);
    try {
      return await aura.runText(["snapshot", "show", "--file", filePath], { cwd });
    } catch {
      return "";
    }
  }
}

export function registerAuraScm(ctx: vscode.ExtensionContext, cwdGetter: () => string | null): void {
  const cwd = cwdGetter();
  const root = cwd ? vscode.Uri.file(cwd) : vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;

  const scm = vscode.scm.createSourceControl("aura", "Aura", root);
  scm.acceptInputCommand = { command: "aura.scm.acceptIntent", title: "Save & Sync" };
  scm.inputBox.placeholder = "Intent — describe why (this is logged, then `aura save` runs)";

  const changedGroup = scm.createResourceGroup("aura.changed", "Changed Files");
  const intentsGroup = scm.createResourceGroup("aura.intents", "Pending Intents");
  changedGroup.hideWhenEmpty = true;
  intentsGroup.hideWhenEmpty = true;

  const quickDiff = new AuraQuickDiffProvider(cwdGetter);
  scm.quickDiffProvider = quickDiff;

  ctx.subscriptions.push(
    scm,
    vscode.workspace.registerTextDocumentContentProvider(SNAP_SCHEME, quickDiff),

    vscode.commands.registerCommand("aura.scm.acceptIntent", async () => {
      const cwd = cwdGetter();
      if (!cwd) return;
      const text = scm.inputBox.value.trim();
      if (!text) {
        vscode.window.showWarningMessage("Aura: intent is required before Save & Sync.");
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Aura: logging intent + saving…" },
        async () => {
          try {
            await aura.logIntent(cwd, text);
            await aura.runText(["save"], { cwd });
            scm.inputBox.value = "";
            await refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Aura save failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand("aura.scm.providerRefresh", () => refresh()),
  );

  // Re-fetch on file save to keep the changed group accurate.
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
    vscode.workspace.onDidCreateFiles(() => refresh()),
    vscode.workspace.onDidDeleteFiles(() => refresh()),
  );

  async function refresh() {
    const cwd = cwdGetter();
    if (!cwd) {
      changedGroup.resourceStates = [];
      intentsGroup.resourceStates = [];
      return;
    }
    let dump: ScmDump;
    try {
      dump = await aura.runJson<ScmDump>(["scm", "dump"], { cwd });
    } catch {
      // CLI may not have `scm dump --json` yet; degrade gracefully.
      changedGroup.resourceStates = [];
      intentsGroup.resourceStates = [];
      return;
    }
    changedGroup.resourceStates = dump.changed_files.map((f) => {
      const abs = path.isAbsolute(f.path) ? f.path : path.join(cwd, f.path);
      const uri = vscode.Uri.file(abs);
      const original = uri.with({ scheme: SNAP_SCHEME, query: `t=${Date.now()}` });
      const state: vscode.SourceControlResourceState = {
        resourceUri: uri,
        decorations: { tooltip: tooltipFor(f.status) },
        command: {
          command: "vscode.diff",
          title: "Open snapshot diff",
          arguments: [original, uri, `${path.basename(abs)} (Aura snapshot)`],
        },
      };
      return state;
    });
    intentsGroup.resourceStates = dump.pending_intents.map((i) => ({
      resourceUri: vscode.Uri.parse(`aura-intent:/${encodeURIComponent(i.id)}`),
      decorations: { tooltip: i.message },
      command: { command: "noop", title: "" },
    }));
  }

  void refresh();
}

function tooltipFor(status: "M" | "A" | "D" | "?"): string {
  switch (status) {
    case "M": return "Modified since last snapshot";
    case "A": return "Added";
    case "D": return "Deleted";
    default:  return "Untracked";
  }
}
