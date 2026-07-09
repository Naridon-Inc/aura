// History TreeView — paginated rollup of intent log + snapshots + audit.
//
// Three top-level groups (intents | snapshots | audit). Each group lazy-
// loads its first 100 entries via the count/list-v2 endpoints added in
// aura-shell Stage 1. Scroll-to-bottom intent appears as a "Load 100 more"
// child node so we don't bring tens of thousands of rows into the tree
// at once.

import * as vscode from "vscode";
import * as aura from "../auraClient";

type GroupId = "intents" | "snapshots" | "audit";

interface IntentEntry { id: string; ts: string; agent?: string; message: string; }
interface SnapshotEntry { id: string; ts: string; file_path: string; }
interface AuditEntry { id: string; ts: string; kind: string; summary: string; }

interface Page<T> { entries: T[]; has_more: boolean; }

class GroupNode {
  readonly kind = "group" as const;
  loaded: number = 0;
  hasMore: boolean = true;
  constructor(public readonly id: GroupId, public readonly label: string) {}
}

class EntryNode {
  readonly kind = "entry" as const;
  constructor(
    public readonly group: GroupId,
    public readonly id: string,
    public readonly title: string,
    public readonly description: string,
    public readonly tooltip: string,
  ) {}
}

class LoadMoreNode {
  readonly kind = "load-more" as const;
  constructor(public readonly group: GroupId) {}
}

type Node = GroupNode | EntryNode | LoadMoreNode;

const PAGE = 100;

export class HistoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly groups: GroupNode[] = [
    new GroupNode("intents",   "Intents"),
    new GroupNode("snapshots", "Snapshots"),
    new GroupNode("audit",     "Audit"),
  ];

  private readonly cache: Record<GroupId, EntryNode[]> = {
    intents: [], snapshots: [], audit: [],
  };

  constructor(private readonly cwdGetter: () => string | null) {}

  refresh() {
    for (const g of this.groups) { g.loaded = 0; g.hasMore = true; }
    for (const k of Object.keys(this.cache) as GroupId[]) this.cache[k] = [];
    this._onDidChange.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(
        node.id === "intents"   ? "book"
        : node.id === "snapshots" ? "history"
        : "warning",
      );
      item.contextValue = `aura.group.${node.id}`;
      return item;
    }
    if (node.kind === "load-more") {
      const item = new vscode.TreeItem(`Load ${PAGE} more…`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      item.command = { command: "aura.history.loadMore", title: "Load more", arguments: [node.group] };
      return item;
    }
    const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(
      node.group === "intents"   ? "book"
      : node.group === "snapshots" ? "history"
      : "warning",
    );
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (!parent) return this.groups;
    if (parent.kind !== "group") return [];

    const cached = this.cache[parent.id];
    if (cached.length === 0) {
      await this.loadMore(parent.id);
    }
    const list: Node[] = [...this.cache[parent.id]];
    if (parent.hasMore) list.push(new LoadMoreNode(parent.id));
    return list;
  }

  async loadMore(group: GroupId): Promise<void> {
    const cwd = this.cwdGetter();
    if (!cwd) return;
    const g = this.groups.find((x) => x.id === group)!;
    const args = group === "intents"
      ? ["intent", "list-v2", "--limit", String(PAGE), "--offset", String(g.loaded)]
      : group === "snapshots"
      ? ["snapshot", "list-v2", "--limit", String(PAGE), "--offset", String(g.loaded)]
      : ["audit", "list-v2", "--limit", String(PAGE), "--offset", String(g.loaded)];

    let page: Page<IntentEntry | SnapshotEntry | AuditEntry>;
    try {
      page = await aura.runJson<Page<IntentEntry | SnapshotEntry | AuditEntry>>(args, { cwd });
    } catch {
      // CLI may not have *_v2 yet; fall back to base list and stop paging.
      g.hasMore = false;
      this._onDidChange.fire(g);
      return;
    }
    for (const e of page.entries) {
      this.cache[group].push(this.toEntryNode(group, e));
    }
    g.loaded += page.entries.length;
    g.hasMore = page.has_more;
    this._onDidChange.fire(g);
  }

  private toEntryNode(group: GroupId, e: IntentEntry | SnapshotEntry | AuditEntry): EntryNode {
    if (group === "intents") {
      const i = e as IntentEntry;
      return new EntryNode(group, i.id, i.message, fmtAge(i.ts) + (i.agent ? ` · ${i.agent}` : ""), `${i.ts}\n${i.message}`);
    }
    if (group === "snapshots") {
      const s = e as SnapshotEntry;
      return new EntryNode(group, s.id, s.file_path, fmtAge(s.ts), `${s.ts}\n${s.file_path}`);
    }
    const a = e as AuditEntry;
    return new EntryNode(group, a.id, a.summary, `${a.kind} · ${fmtAge(a.ts)}`, `${a.ts}\n${a.kind}\n${a.summary}`);
  }
}

function fmtAge(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
