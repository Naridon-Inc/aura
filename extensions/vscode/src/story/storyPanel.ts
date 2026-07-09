// Story webview — per-file timeline of intents, snapshots, agent edits,
// and review findings. Mirrors aura-shell StoryPane.
//
// Data: `aura story --file <path> --json` returns a unified timeline
// with per-event source attribution (claude / gemini / codex / human).

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface StoryEvent { ts: string; source: string; kind: string; summary: string; details?: string; }

let active: vscode.WebviewPanel | null = null;

export async function openStoryPanel(ctx: vscode.ExtensionContext, cwd: string, filePath: string): Promise<void> {
  if (active) {
    active.title = `Story: ${filePath.split("/").pop()}`;
    active.reveal();
    sendSnapshot(active, cwd, filePath);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "aura.story",
    `Story: ${filePath.split("/").pop()}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon("history");
  panel.onDidDispose(() => { if (active === panel) active = null; }, null, ctx.subscriptions);
  panel.webview.html = html();
  panel.webview.onDidReceiveMessage((m) => { if (m?.type === "ready") sendSnapshot(panel, cwd, filePath); });
  active = panel;
}

async function sendSnapshot(panel: vscode.WebviewPanel, cwd: string, filePath: string) {
  try {
    const r = await aura.runJson<{ events: StoryEvent[] }>(["story", "--file", filePath], { cwd });
    panel.webview.postMessage({ type: "snapshot", events: r.events });
  } catch (err) {
    panel.webview.postMessage({ type: "error", message: (err as Error).message });
  }
}

function html(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px;}
    .event{border-left:3px solid var(--vscode-panel-border);padding:8px 12px;margin-bottom:6px;}
    .event.claude{border-color:#d97757;}
    .event.gemini{border-color:#4285f4;}
    .event.codex{border-color:#a371f7;}
    .event.cursor{border-color:#22c55e;}
    .event.kimi{border-color:#f97316;}
    .event.human{border-color:var(--vscode-charts-foreground);}
    .ts{opacity:.55;font-size:11px;}
    .src{display:inline-block;padding:1px 6px;border-radius:3px;background:var(--vscode-button-secondaryBackground);font-size:11px;margin-right:6px;}
    .empty{opacity:.55;}
  </style></head><body>
    <div id="root"><p class="empty">Loading story…</p></div>
    <script>
      const vscode = acquireVsCodeApi();
      function escape(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
      function render(events){
        if(!events||events.length===0){document.getElementById('root').innerHTML='<p class="empty">No story for this file yet. Log intent + snapshot to start the timeline.</p>';return;}
        document.getElementById('root').innerHTML=events.map(e=>'<div class="event '+escape((e.source||'').toLowerCase())+'"><div class="ts">'+escape(e.ts)+'</div><span class="src">'+escape(e.source||'?')+'</span><strong>'+escape(e.kind)+'</strong> — '+escape(e.summary)+(e.details?'<div style="opacity:.75;margin-top:4px">'+escape(e.details)+'</div>':'')+'</div>').join('');
      }
      window.addEventListener('message',ev=>{const m=ev.data;if(m.type==='snapshot')render(m.events);else if(m.type==='error')document.getElementById('root').innerHTML='<p>Error: '+escape(m.message)+'</p>';});
      vscode.postMessage({type:'ready'});
    </script>
  </body></html>`;
}
