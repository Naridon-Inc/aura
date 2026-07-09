// Sentinel inbox TreeView. `aura msg list --json` returns recent
// messages; we render them grouped by status (unread | read | archived).
//
// Click a message → open virtual document `aura-msg://<id>` with full
// body. Reply via `aura.sentinel.reply` command.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface MsgRow { id: string; from: string; subject: string; body: string; ts: string; read: boolean; archived?: boolean; }

class GroupNode { readonly kind = "group" as const; constructor(public readonly id: "unread" | "read" | "archived", public readonly label: string) {} }
class MsgNode { readonly kind = "msg" as const; constructor(public readonly msg: MsgRow) {} }
type Node = GroupNode | MsgNode;

const GROUPS: GroupNode[] = [
  new GroupNode("unread", "Unread"),
  new GroupNode("read",   "Read"),
  new GroupNode("archived", "Archived"),
];

export class SentinelTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: MsgRow[] | null = null;

  constructor(private readonly cwdGetter: () => string | null) {}

  refresh() { this.cache = null; this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.id === "unread" ? "mail" : node.id === "read" ? "mail-read" : "archive");
      return item;
    }
    const m = node.msg;
    const item = new vscode.TreeItem(m.subject || `(no subject)`, vscode.TreeItemCollapsibleState.None);
    item.description = `${m.from} · ${fmtAge(m.ts)}`;
    item.tooltip = `${m.from} → ${m.subject}\n${m.body}`;
    item.iconPath = new vscode.ThemeIcon(m.read ? "mail-read" : "mail");
    item.command = { command: "aura.sentinel.openMessage", title: "Open", arguments: [m.id] };
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (!parent) return GROUPS;
    if (parent.kind !== "group") return [];
    if (!this.cache) {
      try {
        const r = await aura.runJson<{ messages: MsgRow[] }>(["msg", "list"], { cwd });
        this.cache = r.messages;
      } catch {
        this.cache = [];
      }
    }
    return this.cache
      .filter((m) => parent.id === "unread" ? !m.read && !m.archived
                   : parent.id === "read"   ? m.read && !m.archived
                                            : !!m.archived)
      .map((m) => new MsgNode(m));
  }

  async findMessage(id: string): Promise<MsgRow | null> {
    if (!this.cache) await this.getChildren(GROUPS[0]); // hydrate
    return this.cache?.find((m) => m.id === id) ?? null;
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
