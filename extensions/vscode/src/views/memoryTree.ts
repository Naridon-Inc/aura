// Memory TreeView — project memory keys + recent sessions.
//
// Click a memory key → open a virtual document `aura-memory://<key>` so
// the user can edit the body in a normal editor. Save writes back via
// `aura memory write`.
//
// Click a session → run `aura session show <id> --json` and dump the
// summary into a virtual document.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface MemoryKey { key: string; bytes: number; updated_at: string; }
interface SessionRow { id: string; title: string; agent: string; updated_at: string; }

class SectionNode {
  readonly kind = "section" as const;
  constructor(public readonly id: "memory" | "sessions", public readonly label: string) {}
}

class MemoryNode {
  readonly kind = "memory" as const;
  constructor(public readonly entry: MemoryKey) {}
}

class SessionNode {
  readonly kind = "session" as const;
  constructor(public readonly entry: SessionRow) {}
}

type Node = SectionNode | MemoryNode | SessionNode;

export class MemoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly cwdGetter: () => string | null) {}

  refresh() { this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.id === "memory" ? "database" : "comment-discussion");
      return item;
    }
    if (node.kind === "memory") {
      const item = new vscode.TreeItem(node.entry.key, vscode.TreeItemCollapsibleState.None);
      item.description = `${node.entry.bytes}B`;
      item.tooltip = `${node.entry.key}\nUpdated ${node.entry.updated_at}`;
      item.iconPath = new vscode.ThemeIcon("symbol-key");
      item.command = {
        command: "aura.memory.openKey",
        title: "Open memory key",
        arguments: [node.entry.key],
      };
      return item;
    }
    const item = new vscode.TreeItem(node.entry.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.entry.agent} · ${node.entry.updated_at}`;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.command = {
      command: "aura.session.open",
      title: "Open session",
      arguments: [node.entry.id],
    };
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (!parent) {
      return [new SectionNode("memory", "Project memory"), new SectionNode("sessions", "Recent sessions")];
    }
    if (parent.kind !== "section") return [];
    if (parent.id === "memory") {
      try {
        const r = await aura.runJson<{ keys: MemoryKey[] }>(["memory", "list"], { cwd });
        return r.keys.map((k) => new MemoryNode(k));
      } catch { return []; }
    }
    try {
      const r = await aura.runJson<{ sessions: SessionRow[] }>(["session", "list"], { cwd });
      return r.sessions.map((s) => new SessionNode(s));
    } catch { return []; }
  }
}
