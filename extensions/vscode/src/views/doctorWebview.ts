// Doctor webview — `aura doctor --json` output rendered as a structured
// panel mirroring aura-shell DoctorDialog. Sections: Hooks, Sessions,
// Snapshots, Shadow branch, Strict mode. Each item gets a tone (ok|warn|fail)
// + remediation hint.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface DoctorItem { id: string; title: string; tone: "ok" | "warn" | "fail"; detail: string; remediation?: string; }
interface DoctorReport { items: DoctorItem[]; ran_at: string; }

export class DoctorWebviewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly cwdGetter: () => string | null) {}

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    view.webview.options = { enableScripts: true };
    const refresh = async () => {
      const cwd = this.cwdGetter();
      if (!cwd) {
        view.webview.html = wrap(`<p class="empty">Open a folder to run Aura Doctor.</p>`);
        return;
      }
      try {
        const r = await aura.runJson<DoctorReport>(["doctor"], { cwd });
        view.webview.html = wrap(renderReport(r));
      } catch (err) {
        view.webview.html = wrap(`<p class="error">Doctor failed: ${escape((err as Error).message)}</p>`);
      }
    };
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "refresh") void refresh();
    });
    void refresh();
  }
}

function renderReport(r: DoctorReport): string {
  const rows = r.items.map((i) => `
    <li class="item ${i.tone}">
      <div class="title">${escape(i.title)}</div>
      <div class="detail">${escape(i.detail)}</div>
      ${i.remediation ? `<div class="remediation">→ ${escape(i.remediation)}</div>` : ""}
    </li>
  `).join("");
  return `
    <div class="header">
      <span>Doctor — ${escape(r.ran_at)}</span>
      <button onclick="vscode.postMessage({type:'refresh'})">Refresh</button>
    </div>
    <ul class="items">${rows || `<li class="empty">No issues. Healthy repo.</li>`}</ul>
  `;
}

function wrap(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 8px 12px; }
    .header { display:flex; justify-content:space-between; align-items:center; padding-bottom:8px; border-bottom:1px solid var(--vscode-panel-border); }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
    ul.items { list-style: none; padding: 0; margin: 8px 0; }
    li.item { padding: 8px 10px; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid; }
    li.item.ok   { border-color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 6%, transparent); }
    li.item.warn { border-color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 6%, transparent); }
    li.item.fail { border-color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 6%, transparent); }
    .title { font-weight: 600; }
    .detail { opacity: .85; margin-top: 2px; }
    .remediation { font-style: italic; opacity: .7; margin-top: 4px; }
    .empty { opacity: .6; }
    .error { color: var(--vscode-errorForeground); }
  </style></head><body>
    <script>const vscode = acquireVsCodeApi();</script>
    ${body}
  </body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
