// Intent Inspector — stated-vs-actual side-by-side for the most recent
// commits with intent log entries.
//
// Data: `aura intent-vs-actual <sha> --json` returns
//   { stated, actual_summary, ast_delta, alignment_score }.
// The list of recent commits comes from `aura intent recent --json`.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface IntentRow { sha: string; ts: string; intent: string; }
interface VsActual { stated: string; actual_summary: string; ast_delta: string; alignment_score: number; }

let active: vscode.WebviewPanel | null = null;

export async function openInspectorPanel(ctx: vscode.ExtensionContext, cwd: string): Promise<void> {
  if (active) { active.reveal(); refreshList(active, cwd); return; }
  const panel = vscode.window.createWebviewPanel(
    "aura.inspector",
    "Aura — Intent Inspector",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon("eye");
  panel.onDidDispose(() => { if (active === panel) active = null; }, null, ctx.subscriptions);
  panel.webview.html = html();
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === "ready") refreshList(panel, cwd);
    else if (m?.type === "pick") {
      try {
        const r = await aura.runJson<VsActual>(["intent-vs-actual", m.sha], { cwd });
        panel.webview.postMessage({ type: "detail", sha: m.sha, data: r });
      } catch (err) {
        panel.webview.postMessage({ type: "detail-error", sha: m.sha, message: (err as Error).message });
      }
    }
  });
  active = panel;
}

async function refreshList(panel: vscode.WebviewPanel, cwd: string) {
  try {
    const r = await aura.runJson<{ rows: IntentRow[] }>(["intent", "recent"], { cwd });
    panel.webview.postMessage({ type: "list", rows: r.rows });
  } catch (err) {
    panel.webview.postMessage({ type: "error", message: (err as Error).message });
  }
}

function html(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}
    .layout{display:grid;grid-template-columns:280px 1fr;gap:1px;background:var(--vscode-panel-border);height:100vh;}
    section{background:var(--vscode-editor-background);overflow:auto;}
    .row{padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);}
    .row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);}
    .ts{opacity:.6;font-size:11px;}
    .panel{padding:14px;}
    .banner{padding:8px 12px;border-radius:4px;margin-bottom:12px;font-weight:600;}
    .banner.green{background:color-mix(in srgb,var(--vscode-charts-green) 18%,transparent);}
    .banner.amber{background:color-mix(in srgb,var(--vscode-charts-yellow) 18%,transparent);}
    .banner.red{background:color-mix(in srgb,var(--vscode-charts-red) 18%,transparent);}
    .columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
    .col h4{margin:0 0 6px;font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.04em;}
    pre{background:var(--vscode-editorWidget-background);padding:10px;border-radius:4px;font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;}
    .empty{opacity:.55;padding:14px;}
  </style></head><body>
    <div class="layout">
      <section><div id="list"><p class="empty">Loading…</p></div></section>
      <section class="panel"><div id="detail"><p class="empty">Pick a commit on the left.</p></div></section>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      function escape(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
      let rows=[];let active=null;
      function render(){
        document.getElementById('list').innerHTML=rows.length===0?'<p class="empty">No intents yet.</p>':rows.map(r=>'<div class="row '+(active===r.sha?'active':'')+'" onclick="pick(\\''+r.sha+'\\')"><div>'+escape(r.intent)+'</div><div class="ts">'+escape(r.sha.slice(0,7))+' · '+escape(r.ts)+'</div></div>').join('');
      }
      function pick(sha){active=sha;render();vscode.postMessage({type:'pick',sha});}
      function bannerClass(score){return score>=0.75?'green':score>=0.45?'amber':'red';}
      function bannerLabel(score){return score>=0.75?'✓ Aligned':score>=0.45?'⚠ Drift':'✗ Diverged — possible intent poisoning';}
      window.addEventListener('message',ev=>{
        const m=ev.data;
        if(m.type==='list'){rows=m.rows||[];if(!active&&rows[0])active=rows[0].sha;render();if(active)vscode.postMessage({type:'pick',sha:active});}
        else if(m.type==='detail'){
          const d=m.data;
          document.getElementById('detail').innerHTML='<div class="banner '+bannerClass(d.alignment_score)+'">'+bannerLabel(d.alignment_score)+' · score '+(d.alignment_score*100|0)+'%</div>'
            +'<div class="columns">'
              +'<div class="col"><h4>Stated intent</h4><pre>'+escape(d.stated||'')+'</pre></div>'
              +'<div class="col"><h4>Actual change</h4><pre>'+escape(d.actual_summary||'')+'</pre></div>'
            +'</div>'
            +'<h4 style="margin-top:14px">AST delta</h4><pre>'+escape(d.ast_delta||'')+'</pre>';
        }
        else if(m.type==='detail-error'){document.getElementById('detail').innerHTML='<p>Error: '+escape(m.message)+'</p>';}
        else if(m.type==='error'){document.getElementById('list').innerHTML='<p>Error: '+escape(m.message)+'</p>';}
      });
      vscode.postMessage({type:'ready'});
    </script>
  </body></html>`;
}
