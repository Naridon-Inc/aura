// Aura-flavored Source Control TreeView.
//
// V2 keeps this as a simple TreeView (not a full vscode.SourceControl yet —
// that's V9). Two top-level groups:
//   • Changed files — `aura status --json` returns these.
//   • Pending intents — `aura intent pending --json` returns staged-but-
//     not-yet-committed intent log entries.
//
// Header has a "Save & Sync" command (mirrors aura-shell Stage 5C button).
// Click on a changed file opens the editor + (later in V5) the impact
// gutter decoration.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface ChangedFile { path: string; status: "M" | "A" | "D" | "?"; }
interface PendingIntent { id: string; message: string; ts: string; }

interface ScmDump {
  changed_files: ChangedFile[];
  pending_intents: PendingIntent[];
}

class SectionNode {
  readonly kind = "section" as const;
  constructor(public readonly id: "files" | "intents", public readonly label: string) {}
}

class FileNode {
  readonly kind = "file" as const;
  constructor(public readonly file: ChangedFile) {}
}

class IntentNode {
  readonly kind = "intent" as const;
  constructor(public readonly intent: PendingIntent) {}
}

type Node = SectionNode | FileNode | IntentNode;

export class SourceControlTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: ScmDump | null = null;

  constructor(private readonly cwdGetter: () => string | null) {}

  refresh() {
    this.cache = null;
    this._onDidChange.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.id === "files" ? "git-commit" : "book");
      item.contextValue = `aura.scm.${node.id}`;
      return item;
    }
    if (node.kind === "file") {
      const f = node.file;
      const item = new vscode.TreeItem(f.path, vscode.TreeItemCollapsibleState.None);
      item.description = statusLabel(f.status);
      item.iconPath = new vscode.ThemeIcon(statusIcon(f.status));
      item.command = {
        command: "vscode.open",
        title: "Open file",
        arguments: [vscode.Uri.file(absPath(this.cwdGetter(), f.path))],
      };
      return item;
    }
    const i = node.intent;
    const item = new vscode.TreeItem(i.message, vscode.TreeItemCollapsibleState.None);
    item.description = fmtAge(i.ts);
    item.iconPath = new vscode.ThemeIcon("book");
    item.tooltip = `${i.ts}\n${i.message}`;
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (!parent) {
      return [new SectionNode("files", "Changed files"), new SectionNode("intents", "Pending intents")];
    }
    if (parent.kind !== "section") return [];

    if (!this.cache) {
      try {
        this.cache = await aura.runJson<ScmDump>(["scm", "dump"], { cwd });
      } catch {
        this.cache = { changed_files: [], pending_intents: [] };
      }
    }
    if (parent.id === "files") return this.cache.changed_files.map((f) => new FileNode(f));
    return this.cache.pending_intents.map((i) => new IntentNode(i));
  }
}

function statusLabel(s: ChangedFile["status"]): string {
  switch (s) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    default:  return "untracked";
  }
}

function statusIcon(s: ChangedFile["status"]): string {
  switch (s) {
    case "M": return "diff-modified";
    case "A": return "diff-added";
    case "D": return "diff-removed";
    default:  return "diff-ignored";
  }
}

function fmtAge(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function absPath(cwd: string | null, rel: string): string {
  if (!cwd) return rel;
  if (rel.startsWith("/")) return rel;
  return `${cwd}/${rel}`;
}
