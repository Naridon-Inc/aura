// Knowledge TreeView — team knowledge entries (search + upvote).
//
// Top item is a "🔍 Search…" virtual node that, when clicked, runs an
// input-box flow and refreshes the list with `aura know query <q>`.
// Default view shows top-N entries from `aura know list`.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface KnowEntry { id: string; title: string; preview: string; upvotes: number; author: string; ts: string; }

class SearchNode { readonly kind = "search" as const; constructor(public readonly query: string | null) {} }
class EntryNode { readonly kind = "entry" as const; constructor(public readonly entry: KnowEntry) {} }

type Node = SearchNode | EntryNode;

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private query: string | null = null;

  constructor(private readonly cwdGetter: () => string | null) {}

  setQuery(q: string | null) {
    this.query = q;
    this._onDidChange.fire();
  }

  refresh() { this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "search") {
      const item = new vscode.TreeItem(node.query ? `Search: "${node.query}"` : "Search…", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("search");
      item.command = { command: "aura.knowledge.search", title: "Search knowledge", arguments: [] };
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.title, vscode.TreeItemCollapsibleState.None);
    item.description = `↑${e.upvotes} · ${e.author}`;
    item.tooltip = `${e.title}\n\n${e.preview}\n\nby ${e.author} · ${e.ts}`;
    item.iconPath = new vscode.ThemeIcon("book");
    item.command = { command: "aura.knowledge.openEntry", title: "Open entry", arguments: [e.id] };
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (parent) return [];
    const search = new SearchNode(this.query);
    const args = this.query ? ["know", "query", this.query] : ["know", "list"];
    try {
      const r = await aura.runJson<{ entries: KnowEntry[] }>(args, { cwd });
      return [search, ...r.entries.map((e) => new EntryNode(e))];
    } catch {
      return [search];
    }
  }
}
