// PR Inbox TreeView. Buckets: Yours | Reviewing | Open | Drafts.
// Source: `aura pr list --json` (proxies cloud GET /api/v2/prs).
// Each row shows: number, title, author, risk chip color, unread count.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface PrSummary {
  number: number;
  title: string;
  author: string;
  bucket: "yours" | "reviewing" | "open" | "drafts";
  risk: "low" | "medium" | "high" | "unknown";
  unread_comments: number;
  url?: string;
}

class BucketNode {
  readonly kind = "bucket" as const;
  constructor(public readonly id: PrSummary["bucket"], public readonly label: string) {}
}

class PrNode {
  readonly kind = "pr" as const;
  constructor(public readonly pr: PrSummary) {}
}

type Node = BucketNode | PrNode;

const BUCKETS: BucketNode[] = [
  new BucketNode("yours",     "Yours"),
  new BucketNode("reviewing", "Reviewing"),
  new BucketNode("open",      "Open"),
  new BucketNode("drafts",    "Drafts"),
];

export class PrInboxTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: PrSummary[] | null = null;

  constructor(private readonly cwdGetter: () => string | null) {}

  refresh() { this.cache = null; this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "bucket") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("git-pull-request");
      return item;
    }
    const p = node.pr;
    const label = `#${p.number} · ${p.title}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${p.author} · ${riskGlyph(p.risk)}${p.unread_comments > 0 ? ` · ${p.unread_comments} new` : ""}`;
    item.tooltip = `#${p.number} ${p.title}\n${p.author}\nrisk: ${p.risk}${p.url ? `\n${p.url}` : ""}`;
    item.iconPath = new vscode.ThemeIcon(riskIcon(p.risk));
    item.command = { command: "aura.pr.openDetail", title: "Open PR detail", arguments: [p.number] };
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const cwd = this.cwdGetter();
    if (!cwd) return [];
    if (!parent) return BUCKETS;
    if (parent.kind !== "bucket") return [];
    if (!this.cache) {
      try {
        const r = await aura.runJson<{ prs: PrSummary[] }>(["pr", "list"], { cwd });
        this.cache = r.prs;
      } catch {
        this.cache = [];
      }
    }
    return this.cache.filter((p) => p.bucket === parent.id).map((p) => new PrNode(p));
  }
}

function riskGlyph(r: PrSummary["risk"]): string {
  switch (r) {
    case "low":    return "🟢";
    case "medium": return "🟡";
    case "high":   return "🔴";
    default:       return "⚪";
  }
}
function riskIcon(r: PrSummary["risk"]): string {
  switch (r) {
    case "low":    return "pass";
    case "medium": return "warning";
    case "high":   return "error";
    default:       return "git-pull-request";
  }
}
