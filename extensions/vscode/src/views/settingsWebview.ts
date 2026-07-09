// Settings webview — five tabs (General / Keys / Policy / Agents / Telemetry).
//
// V2 ships a minimal version: the panel surfaces current values from
// auraClient and forwards edits back as `aura config set …` CLI calls.
// Most of the actual UI polish (palettes, swatches, sliders) lives in the
// aura-shell SettingsDialog — the VS Code version focuses on parity rather
// than visual fidelity.

import * as vscode from "vscode";
import * as aura from "../auraClient";
import { AuraSubcommandMissingError } from "../auraClient";
import * as auth from "../auth";

interface AgentDescriptor {
  id: string;
  label: string;
  available: boolean;
  version?: string;
  bin?: string;
}

interface SnapshotData {
  agents: AgentDescriptor[];
  cloudTokenSet: boolean;
  cloudBaseUrl: string;
  binPath: string;
}

export class SettingsWebviewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly cwdGetter: () => string | null,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    view.webview.options = { enableScripts: true };

    const refresh = async () => {
      const data = await this.loadSnapshot();
      view.webview.postMessage({ type: "snapshot", data });
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          await refresh();
          break;
        case "set-token":
          await auth.promptForCloudToken(this.ctx);
          await refresh();
          break;
        case "clear-token":
          await auth.clearCloudToken(this.ctx);
          await refresh();
          break;
        case "set-bin-path": {
          const v = await vscode.window.showInputBox({ title: "Aura — bin path", value: msg.value ?? "" });
          if (typeof v === "string") {
            await vscode.workspace.getConfiguration("aura").update("binPath", v, vscode.ConfigurationTarget.Global);
            aura.clearAuraBinCache();
            await refresh();
          }
          break;
        }
        case "open-vscode-settings":
          void vscode.commands.executeCommand("workbench.action.openSettings", "aura");
          break;
        case "reload-agents":
          // Hits the CLI registry reload (Stage 4A).
          try {
            const cwd = this.cwdGetter() ?? process.cwd();
            await aura.runText(["agents", "reload"], { cwd });
            await refresh();
          } catch (err) {
            if (err instanceof AuraSubcommandMissingError) {
              vscode.window.showInformationMessage("Aura: `agents` subcommand not in this CLI version. Provider registry lives downstream — list above is provided by the extension's MCP/PATH probe.");
            } else {
              vscode.window.showErrorMessage(`Aura agents reload failed: ${(err as Error).message}`);
            }
          }
          break;
      }
    });

    view.webview.html = wrap();
  }

  private async loadSnapshot(): Promise<SnapshotData> {
    const cwd = this.cwdGetter() ?? process.cwd();
    let agents: AgentDescriptor[] = [];
    try {
      const r = await aura.runJson<{ agents: AgentDescriptor[] }>(["agents", "list"], { cwd });
      agents = r.agents;
    } catch {
      // CLI may not support `agents list` (open-source aura). Fall back to
      // a static probe of well-known agent binaries on PATH so the panel
      // still reflects what's actually installed.
      agents = await probeAgents();
    }
    return {
      agents,
      cloudTokenSet: !!(await auth.getCloudToken(this.ctx)),
      cloudBaseUrl: auth.cloudBaseUrl(),
      binPath: aura.resolveAuraBin() ?? "",
    };
  }
}

// Static fallback when `aura agents list` isn't available. Probes the
// same candidate names + extended PATH dirs that aura-agents would.
async function probeAgents(): Promise<AgentDescriptor[]> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = os.homedir();
  const PATH = (process.env.PATH ?? "").split(path.delimiter);
  const extra = [
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(home, ".cargo/bin"), path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"), path.join(home, "bin"),
  ];
  const probe = (names: string[]): { available: boolean; bin?: string } => {
    for (const dir of [...PATH, ...extra]) {
      if (!dir) continue;
      for (const n of names) {
        const p = path.join(dir, n);
        try { if (fs.statSync(p).isFile()) return { available: true, bin: p }; } catch { /* keep looking */ }
      }
    }
    return { available: false };
  };
  const known: Array<{ id: string; label: string; names: string[] }> = [
    { id: "claude", label: "Claude Code",  names: ["claude"] },
    { id: "gemini", label: "Gemini CLI",   names: ["gemini"] },
    { id: "codex",  label: "Codex",        names: ["codex"] },
    { id: "cursor", label: "Cursor Agent", names: ["cursor-agent", "cursor"] },
    { id: "kimi",   label: "Kimi-Coder",   names: ["kimi", "kimi-cli", "kimi-coder", "moonshot"] },
  ];
  return known.map((k) => ({ id: k.id, label: k.label, ...probe(k.names) }));
}

function wrap(): string {
  // The HTML is a single static skeleton; data is injected via postMessage
  // so we don't need to re-render the iframe on every change.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 8px 12px; }
    h3 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; opacity: .65; letter-spacing: .04em; }
    .row { display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .row:last-child { border-bottom: none; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .agent { display:flex; align-items:center; gap:8px; padding: 4px 0; }
    .agent .badge { font-size: 11px; opacity:.7; }
    .agent.ok    .badge { color: var(--vscode-charts-green); }
    .agent.miss  .badge { color: var(--vscode-charts-red); }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: .8; }
    .empty { opacity: .6; }
  </style></head><body>
    <div id="root"><p class="empty">Loading…</p></div>
    <script>
      const vscode = acquireVsCodeApi();
      function escape(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
      function render(d) {
        const agents = d.agents.length === 0
          ? '<p class="empty">No agents detected. Set <code>aura.binPath</code> if needed.</p>'
          : d.agents.map(a => '<div class="agent ' + (a.available ? 'ok' : 'miss') + '">'
              + '<strong>' + escape(a.label) + '</strong>'
              + ' <span class="badge">' + (a.available ? '✓' : '✗') + (a.version ? ' v' + escape(a.version) : '') + '</span>'
              + (a.bin ? ' <code>' + escape(a.bin) + '</code>' : '')
              + '</div>').join('');
        document.getElementById('root').innerHTML = ''
          + '<h3>Aura binary</h3>'
          + '<div class="row"><span><code>' + (escape(d.binPath) || '(auto-detected from PATH)') + '</code></span>'
          +   '<button class="secondary" onclick="vscode.postMessage({type:\\'set-bin-path\\', value: ' + JSON.stringify(d.binPath) + '})">Edit</button></div>'
          + '<h3>Cloud</h3>'
          + '<div class="row"><span>Base URL: <code>' + escape(d.cloudBaseUrl) + '</code></span></div>'
          + '<div class="row"><span>Token: ' + (d.cloudTokenSet ? '••••••••' : '<em class="empty">not set</em>') + '</span>'
          +   (d.cloudTokenSet
                ? '<button class="secondary" onclick="vscode.postMessage({type:\\'clear-token\\'})">Clear</button>'
                : '<button onclick="vscode.postMessage({type:\\'set-token\\'})">Set</button>') + '</div>'
          + '<h3>Agents</h3>' + agents
          + '<div class="row"><span></span><button class="secondary" onclick="vscode.postMessage({type:\\'reload-agents\\'})">Reload providers</button></div>'
          + '<h3>Other</h3>'
          + '<div class="row"><span>Open full VS Code settings</span><button class="secondary" onclick="vscode.postMessage({type:\\'open-vscode-settings\\'})">Open</button></div>';
      }
      window.addEventListener('message', e => { if (e.data?.type === 'snapshot') render(e.data.data); });
      vscode.postMessage({ type: 'ready' });
    </script>
  </body></html>`;
}
