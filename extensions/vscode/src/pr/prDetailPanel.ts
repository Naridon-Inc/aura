// PR Detail webview panel.
//
// Layout: file tree (left) | diff (middle, rendered server-side as unified
// patch text) | threads + semantic findings (right). The diff itself uses
// VS Code's vscode.diff command rather than an in-webview DiffView, so
// the user gets full editor affordances (Cmd-Click, search, fold).
//
// V4 keeps the panel as a thin index — clicking a file opens the diff in
// the active column via vscode.diff with two URIs:
//   • aura-pr-base://<repo>?pr=<n>&path=<file>
//   • aura-pr-head://<repo>?pr=<n>&path=<file>
// Both are virtual documents fetched via auraClient.

import * as vscode from "vscode";
import * as aura from "../auraClient";
import { AuraSubcommandMissingError } from "../auraClient";

// Several rich-PR operations (detail / comment / approve / merge) depend on
// `aura pr` subcommands that not every CLI build ships. Rather than surface a
// raw clap "unrecognized subcommand" dump, we translate that one failure mode
// into a clear, honest sentence so the panel never lies about what it can do.
function friendlyPrError(err: unknown): string {
  if (err instanceof AuraSubcommandMissingError) {
    return "This Aura CLI build doesn't support rich PR actions yet. Use `aura pr review` / `aura pr status`, or open the PR on GitHub.";
  }
  return (err as Error).message;
}

export interface PrFile { path: string; status: "M" | "A" | "D"; additions: number; deletions: number; risk?: "low" | "medium" | "high"; }
export interface PrComment { id: string; file?: string; line?: number; author: string; body: string; created_at: string; resolved: boolean; }
export interface PrFinding { kind: string; file: string; line?: number; message: string; severity: "info" | "warning" | "error"; }

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  author: string;
  base_branch: string;
  head_branch: string;
  state: "open" | "closed" | "merged" | "draft";
  risk_score: number;
  risk_label: "low" | "medium" | "high";
  files: PrFile[];
  comments: PrComment[];
  findings: PrFinding[];
  invariant_violations?: Array<{ file: string; line: number; invariant: string }>;
  unverified_nodes?: Array<{ name: string; file: string }>;
  url?: string;
}

const panels = new Map<number, PrDetailPanel>();

export async function openPrDetail(ctx: vscode.ExtensionContext, cwd: string, pr: number): Promise<void> {
  const existing = panels.get(pr);
  if (existing) { existing.reveal(); return; }
  const p = new PrDetailPanel(ctx, cwd, pr);
  panels.set(pr, p);
  await p.init();
}

export const PR_BASE_SCHEME = "aura-pr-base";
export const PR_HEAD_SCHEME = "aura-pr-head";

class PrDetailPanel {
  private readonly panel: vscode.WebviewPanel;
  private detail: PrDetail | null = null;

  constructor(ctx: vscode.ExtensionContext, private readonly cwd: string, private readonly pr: number) {
    this.panel = vscode.window.createWebviewPanel(
      "aura.prDetail",
      `PR #${pr}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon("git-pull-request");
    this.panel.onDidDispose(() => panels.delete(this.pr), null, ctx.subscriptions);
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  reveal() { this.panel.reveal(); }

  async init() { await this.refresh(); }

  private async refresh() {
    try {
      this.detail = await aura.runJson<PrDetail>(["pr", "detail", "--number", String(this.pr)], { cwd: this.cwd });
      this.panel.webview.postMessage({ type: "snapshot", data: this.detail });
    } catch (err) {
      this.panel.webview.postMessage({ type: "error", message: friendlyPrError(err) });
    }
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":     await this.refresh(); break;
      case "open-file": await this.openDiff(msg.path); break;
      case "post-comment": await this.postComment(msg.file, msg.line, msg.body); break;
      case "reply-comment": await this.replyComment(msg.id, msg.body); break;
      case "resolve":  await this.resolveComment(msg.id); break;
      case "approve":  await this.action(["pr", "approve", "--number", String(this.pr)]); break;
      case "request-changes": await this.action(["pr", "request-changes", "--number", String(this.pr), "--body", msg.body ?? ""]); break;
      case "merge": {
        const strategy = await vscode.window.showQuickPick(["squash", "merge", "rebase"], { title: `Merge PR #${this.pr}` });
        if (!strategy) return;
        await this.action(["pr", "merge", "--number", String(this.pr), "--strategy", strategy]);
        break;
      }
      case "convert-to-plan":
        await vscode.commands.executeCommand("aura.openManager", undefined);
        // The Manager open flow prompts for objective; user can paste comment body.
        break;
    }
  }

  private async action(args: string[]) {
    try {
      await aura.runText(args, { cwd: this.cwd });
      await this.refresh();
      vscode.window.showInformationMessage(`Aura: ${args.join(" ")}`);
    } catch (err) {
      vscode.window.showErrorMessage(friendlyPrError(err));
    }
  }

  private async postComment(file: string, line: number, body: string) {
    try {
      await aura.runText(["pr", "comment", "--number", String(this.pr), "--file", file, "--line", String(line), "--body", body], { cwd: this.cwd });
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(friendlyPrError(err));
    }
  }
  private async replyComment(id: string, body: string) {
    try {
      await aura.runText(["pr", "comment", "--reply", id, "--body", body], { cwd: this.cwd });
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(friendlyPrError(err));
    }
  }
  private async resolveComment(id: string) {
    try {
      await aura.runText(["pr", "comment", "--resolve", id], { cwd: this.cwd });
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(friendlyPrError(err));
    }
  }

  private async openDiff(file: string) {
    const baseUri = vscode.Uri.parse(`${PR_BASE_SCHEME}:/${encodeURIComponent(file)}?pr=${this.pr}`);
    const headUri = vscode.Uri.parse(`${PR_HEAD_SCHEME}:/${encodeURIComponent(file)}?pr=${this.pr}`);
    await vscode.commands.executeCommand("vscode.diff", baseUri, headUri, `${file} — PR #${this.pr}`, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  private html(): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${this.panel.webview.cspSource};`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
    html,body{height:100%;margin:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}
    .layout{display:grid;grid-template-columns:240px 1fr 320px;gap:1px;background:var(--vscode-panel-border);height:100vh;}
    section{background:var(--vscode-editor-background);overflow:auto;}
    .header{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;justify-content:space-between;align-items:center;background:var(--vscode-editor-background);position:sticky;top:0;}
    .title{font-weight:600;}
    .meta{opacity:.7;font-size:12px;}
    .files{padding:8px 0;}
    .file{padding:6px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:6px;}
    .file:hover{background:var(--vscode-list-hoverBackground);}
    .file .delta{opacity:.7;font-size:11px;font-variant-numeric:tabular-nums;}
    .file.M{border-left:3px solid var(--vscode-charts-yellow);}
    .file.A{border-left:3px solid var(--vscode-charts-green);}
    .file.D{border-left:3px solid var(--vscode-charts-red);}
    .body{padding:10px 14px;}
    .findings ul,.threads ul{list-style:none;padding:0;margin:0;}
    .finding,.thread{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);}
    .finding.warning{border-left:3px solid var(--vscode-charts-yellow);}
    .finding.error{border-left:3px solid var(--vscode-charts-red);}
    .finding.info{border-left:3px solid var(--vscode-charts-blue);}
    .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:6px;}
    .badge.low{background:color-mix(in srgb,var(--vscode-charts-green) 18%,transparent);}
    .badge.medium{background:color-mix(in srgb,var(--vscode-charts-yellow) 18%,transparent);}
    .badge.high{background:color-mix(in srgb,var(--vscode-charts-red) 18%,transparent);}
    .actions{display:flex;gap:6px;margin-top:8px;}
    button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;}
    button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
    .empty{opacity:.6;padding:14px;}
    textarea{width:100%;min-height:60px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px;border-radius:3px;}
    .convert{font-size:11px;opacity:.85;cursor:pointer;color:var(--vscode-textLink-foreground);}
    </style></head><body>
    <div class="layout">
      <section><div class="header"><span class="title">Files</span></div><div id="files" class="files"><div class="empty">Loading…</div></div></section>
      <section>
        <div class="header"><span class="title" id="pr-title">PR…</span><span class="meta" id="pr-meta"></span></div>
        <div class="body" id="pr-body"></div>
        <div class="actions">
          <button onclick="vscode.postMessage({type:'approve'})">Approve</button>
          <button class="secondary" onclick="reqChanges()">Request changes</button>
          <button class="secondary" onclick="vscode.postMessage({type:'merge'})">Merge…</button>
        </div>
      </section>
      <section>
        <div class="header"><span class="title">Findings &amp; Threads</span></div>
        <div class="findings"><ul id="findings"></ul></div>
        <div class="threads"><ul id="threads"></ul></div>
      </section>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      function escape(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
      let detail=null;
      function render(d){
        detail=d;
        document.getElementById('pr-title').textContent='#'+d.number+' · '+d.title;
        document.getElementById('pr-meta').textContent=d.author+' · '+d.base_branch+' ← '+d.head_branch+' · '+d.state;
        document.getElementById('pr-body').innerHTML='<span class="badge '+d.risk_label+'">risk '+d.risk_label+'</span> '+escape(d.body||"");
        document.getElementById('files').innerHTML=d.files.map(f=>'<div class="file '+f.status+'" onclick="openFile(\\''+f.path.replace(/'/g,"\\\\'")+'\\')"><span>'+escape(f.path)+'</span><span class="delta">+'+f.additions+' −'+f.deletions+'</span></div>').join('') || '<div class="empty">No files.</div>';
        document.getElementById('findings').innerHTML=d.findings.map(f=>'<li class="finding '+f.severity+'"><div>'+escape(f.message)+'</div><div class="meta">'+escape(f.file)+(f.line?':'+f.line:'')+'</div></li>').join('') || '<li class="empty">No findings.</li>';
        document.getElementById('threads').innerHTML=d.comments.map(c=>'<li class="thread"><div class="meta">'+escape(c.author)+(c.file?' · '+escape(c.file)+(c.line?':'+c.line:''):'')+(c.resolved?' · resolved':'')+'</div><div>'+escape(c.body)+'</div><div class="actions"><span class="convert" onclick="convert(\\''+c.id+'\\')">Convert to plan</span></div></li>').join('') || '<li class="empty">No comments.</li>';
      }
      function openFile(p){vscode.postMessage({type:'open-file',path:p});}
      function convert(id){
        const c = (detail?.comments || []).find(x => x.id === id);
        if (c) navigator.clipboard?.writeText(c.body).catch(()=>{});
        vscode.postMessage({type:'convert-to-plan',id});
      }
      function reqChanges(){const b=prompt('Reason for requesting changes:');if(b)vscode.postMessage({type:'request-changes',body:b});}
      window.addEventListener('message',e=>{const m=e.data;if(m.type==='snapshot')render(m.data);else if(m.type==='error')document.getElementById('pr-body').textContent='Error: '+m.message;});
      vscode.postMessage({type:'ready'});
    </script></body></html>`;
  }
}

function randomNonce(): string {
  const buf = new Uint8Array(16);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
