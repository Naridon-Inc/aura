// Provenance Replay webview — scrubber over signed manifest chain.
//
// Data shape from `aura manifest list --json`:
//   { manifests: [{ sha, ts, signer_email, ca, intent_hash, ast_hash, verified }] }
// We render a horizontal timeline; clicking a pin shows signature
// details. Verifying re-runs `aura prove --signature <sha>`.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface Manifest {
  sha: string;
  ts: string;
  signer_email?: string;
  ca?: string;
  intent_hash?: string;
  ast_hash?: string;
  verified?: boolean;
}

let active: vscode.WebviewPanel | null = null;

export async function openReplayPanel(ctx: vscode.ExtensionContext, cwd: string): Promise<void> {
  if (active) { active.reveal(); refresh(active, cwd); return; }
  const panel = vscode.window.createWebviewPanel(
    "aura.replay",
    "Aura — Provenance Replay",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon("verified");
  panel.onDidDispose(() => { if (active === panel) active = null; }, null, ctx.subscriptions);
  panel.webview.html = html();
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === "ready") refresh(panel, cwd);
    else if (m?.type === "verify") {
      try {
        const r = await aura.runJson<{ ok: boolean }>(["prove", "--signature", m.sha], { cwd });
        panel.webview.postMessage({ type: "verify-result", sha: m.sha, ok: !!r.ok });
      } catch (err) {
        panel.webview.postMessage({ type: "verify-result", sha: m.sha, ok: false, message: (err as Error).message });
      }
    }
  });
  active = panel;
}

async function refresh(panel: vscode.WebviewPanel, cwd: string) {
  try {
    const r = await aura.runJson<{ manifests: Manifest[] }>(["manifest", "list"], { cwd });
    panel.webview.postMessage({ type: "snapshot", manifests: r.manifests });
  } catch (err) {
    panel.webview.postMessage({ type: "error", message: (err as Error).message });
  }
}

function html(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px;}
    .timeline{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:14px;}
    .pin{padding:6px 10px;border-radius:14px;border:1px solid var(--vscode-panel-border);cursor:pointer;font-size:11px;}
    .pin.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
    .pin.verified{border-color:var(--vscode-charts-green);}
    .pin.unverified{border-color:var(--vscode-charts-red);}
    .panel{padding:8px 0;}
    .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted var(--vscode-panel-border);font-size:12px;}
    .row .k{opacity:.65;}
    code{font-family:var(--vscode-editor-font-family);font-size:12px;}
    .empty{opacity:.55;}
    button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 10px;border-radius:3px;cursor:pointer;}
  </style></head><body>
    <div id="timeline" class="timeline empty">Loading…</div>
    <div id="panel" class="panel"><p class="empty">Pick a manifest above.</p></div>
    <script>
      const vscode = acquireVsCodeApi();
      function escape(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
      let manifests=[];let active=null;
      function render(){
        if(manifests.length===0){document.getElementById('timeline').innerHTML='<p class="empty">No signed manifests yet. Commit on a tracked branch to start the chain.</p>';return;}
        document.getElementById('timeline').classList.remove('empty');
        document.getElementById('timeline').innerHTML=manifests.map(m=>{
          const cls=(active===m.sha?'active ':'')+(m.verified===true?'verified':m.verified===false?'unverified':'');
          return '<div class="pin '+cls+'" onclick="pick(\\''+m.sha+'\\')">'+escape(m.sha.slice(0,7))+' · '+escape(m.ts.slice(0,10))+'</div>';
        }).join('');
        const m=manifests.find(x=>x.sha===active);
        document.getElementById('panel').innerHTML=m?(
          '<div class="row"><span class="k">SHA</span><code>'+escape(m.sha)+'</code></div>'
          +'<div class="row"><span class="k">Signer</span><span>'+escape(m.signer_email||'(unsigned)')+'</span></div>'
          +'<div class="row"><span class="k">CA</span><span>'+escape(m.ca||'(none)')+'</span></div>'
          +'<div class="row"><span class="k">Intent hash</span><code>'+escape(m.intent_hash||'')+'</code></div>'
          +'<div class="row"><span class="k">AST hash</span><code>'+escape(m.ast_hash||'')+'</code></div>'
          +'<div class="row"><span class="k">Status</span><span>'+(m.verified===true?'✓ verified':m.verified===false?'✗ failed':'(not verified)')+'</span></div>'
          +'<div style="margin-top:10px"><button onclick="verify(\\''+m.sha+'\\')">Verify</button></div>'
        ):'<p class="empty">Pick a manifest above.</p>';
      }
      function pick(sha){active=sha;render();}
      function verify(sha){vscode.postMessage({type:'verify',sha});}
      window.addEventListener('message',ev=>{
        const m=ev.data;
        if(m.type==='snapshot'){manifests=m.manifests||[];if(!active&&manifests[0])active=manifests[0].sha;render();}
        else if(m.type==='verify-result'){const t=manifests.find(x=>x.sha===m.sha);if(t){t.verified=!!m.ok;render();}}
        else if(m.type==='error'){document.getElementById('timeline').textContent='Error: '+m.message;}
      });
      vscode.postMessage({type:'ready'});
    </script>
  </body></html>`;
}
