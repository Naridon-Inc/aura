// Manager webview panel.
//
// One panel per session, identified by sessionId. Reuses cached panels
// (focuses existing panel instead of creating a duplicate).
//
// The panel is a single HTML document with vanilla JS that:
//   • Renders chat at top, DAG in the middle, ribbon at the bottom.
//   • Receives state snapshots + event deltas via webview.postMessage.
//   • Sends user actions (send-chat, pause, resume, cancel, override)
//     back to the host, which dispatches them via auraClient CLI calls.
//
// We deliberately avoid bundling React in V3 — the surface is
// self-contained, ~400 lines of vanilla DOM, and the host already pays
// for VS Code's renderer. Future work can promote to a Vite-built bundle
// if the surface grows past ~1k LOC.

import * as vscode from "vscode";
import * as aura from "../auraClient";
import { ManagerStream, ManagerEvent } from "./managerStream";

interface ManagerSnapshot {
  session_id: string;
  status: string;
  objective: string;
  chat: Array<{ role: "user" | "manager"; text: string; at: number }>;
  waves: Array<{ id: number; tasks: Array<{ id: number; description: string; agent: string; status: string; depends_on: number[] }> }>;
  ribbon: Array<{ ts: string; kind: string; summary: string }>;
}

const panels = new Map<string, ManagerPanel>();

export async function openManagerPanel(ctx: vscode.ExtensionContext, cwd: string, sessionId: string): Promise<void> {
  const existing = panels.get(sessionId);
  if (existing) { existing.reveal(); return; }
  const p = new ManagerPanel(ctx, cwd, sessionId);
  panels.set(sessionId, p);
  await p.init();
}

export async function startManagerSession(cwd: string, objective: string): Promise<string | null> {
  // `aura manager start --objective …` returns { session_id } in --json mode.
  try {
    const r = await aura.runJson<{ session_id: string }>(["manager", "start", "--objective", objective], { cwd });
    return r.session_id;
  } catch (err) {
    vscode.window.showErrorMessage(`Aura manager start failed: ${(err as Error).message}`);
    return null;
  }
}

class ManagerPanel {
  private readonly panel: vscode.WebviewPanel;
  private stream: ManagerStream | null = null;

  constructor(
    ctx: vscode.ExtensionContext,
    private readonly cwd: string,
    private readonly sessionId: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "aura.manager",
      `Manager: ${sessionId.slice(0, 8)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon("organization");
    this.panel.onDidDispose(() => this.dispose(), null, ctx.subscriptions);
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  reveal() { this.panel.reveal(); }

  async init(): Promise<void> {
    await this.refreshSnapshot();
    this.startStream();
  }

  private dispose() {
    this.stream?.close();
    this.stream = null;
    panels.delete(this.sessionId);
  }

  private startStream() {
    this.stream = new ManagerStream(this.sessionId, this.cwd);
    this.stream.on("event", (e: ManagerEvent) => this.panel.webview.postMessage({ type: "event", event: e }));
    this.stream.on("error", (err: Error) => this.panel.webview.postMessage({ type: "error", message: err.message }));
    this.stream.on("exit", (_code: number) => this.panel.webview.postMessage({ type: "stream-exit" }));
    this.stream.start();
  }

  private async refreshSnapshot() {
    try {
      const snap = await aura.runJson<ManagerSnapshot>(["manager", "snapshot", "--session", this.sessionId], { cwd: this.cwd });
      this.panel.webview.postMessage({ type: "snapshot", data: snap });
    } catch (err) {
      this.panel.webview.postMessage({ type: "error", message: (err as Error).message });
    }
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
        await this.refreshSnapshot();
        break;
      case "send-chat":
        try {
          await aura.runText(["manager", "chat", "--session", this.sessionId, msg.text], { cwd: this.cwd });
          await this.refreshSnapshot();
        } catch (err) {
          vscode.window.showErrorMessage(`Manager chat failed: ${(err as Error).message}`);
        }
        break;
      case "pause":
      case "resume":
      case "cancel":
        try {
          await aura.runText(["manager", msg.type, "--session", this.sessionId], { cwd: this.cwd });
          await this.refreshSnapshot();
        } catch (err) {
          vscode.window.showErrorMessage(`Manager ${msg.type} failed: ${(err as Error).message}`);
        }
        break;
      case "task-action":
        // override: skip | rerun | reassign | take-over | complete-manual
        try {
          const args = ["manager", "override", "--session", this.sessionId, "--task", String(msg.taskId), "--mode", msg.mode];
          if (msg.agent) args.push("--agent", msg.agent);
          await aura.runText(args, { cwd: this.cwd });
          await this.refreshSnapshot();
        } catch (err) {
          vscode.window.showErrorMessage(`Manager override failed: ${(err as Error).message}`);
        }
        break;
    }
  }

  private html(): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${this.panel.webview.cspSource};`;
    return `<!doctype html><html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    :root { --gap: 10px; }
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .layout { display: grid; grid-template-rows: minmax(140px, 30%) minmax(180px, 1fr) minmax(120px, 25%); height: 100vh; gap: var(--gap); padding: var(--gap); box-sizing: border-box; }
    section { background: var(--vscode-panel-background, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 6px; display: flex; flex-direction: column; min-height: 0; }
    header.section-h { padding: 6px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; }
    .scroll { overflow: auto; padding: 8px 10px; flex: 1; }
    /* Chat */
    .turn { display: flex; margin-bottom: 8px; }
    .turn .bubble { padding: 6px 10px; border-radius: 8px; max-width: 75%; }
    .turn.user .bubble { margin-left: auto; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .turn.manager .bubble { margin-right: auto; background: var(--vscode-input-background); }
    .composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .composer input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 8px; border-radius: 4px; }
    .composer button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    /* DAG */
    .dag { display: flex; flex-direction: column; gap: 14px; }
    .wave { border-left: 2px solid var(--vscode-panel-border); padding-left: 12px; }
    .wave .wave-label { opacity: .65; font-size: 11px; margin-bottom: 6px; }
    .tasks { display: flex; flex-wrap: wrap; gap: 8px; }
    .task { padding: 8px 10px; border-radius: 6px; min-width: 180px; max-width: 320px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .task .desc { font-weight: 600; margin-bottom: 4px; }
    .task .meta { display: flex; gap: 6px; font-size: 11px; opacity: .75; }
    .task.status-pending  { border-left: 3px solid var(--vscode-charts-blue); }
    .task.status-running  { border-left: 3px solid var(--vscode-charts-yellow); }
    .task.status-done     { border-left: 3px solid var(--vscode-charts-green); }
    .task.status-failed   { border-left: 3px solid var(--vscode-charts-red); }
    .task.status-blocked  { border-left: 3px solid var(--vscode-charts-purple); }
    .task .actions { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
    .task .actions button { font-size: 10px; padding: 2px 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; }
    /* Ribbon */
    .ribbon-row { padding: 4px 0; font-size: 12px; opacity: .85; border-bottom: 1px dotted var(--vscode-panel-border); }
    .ribbon-row .ts { opacity: .55; margin-right: 6px; }
    .ribbon-row .kind { display: inline-block; min-width: 90px; opacity: .7; }
    .controls button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 3px; margin-left: 4px; cursor: pointer; font-size: 11px; }
    .empty { opacity: .55; padding: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="layout">
    <section>
      <header class="section-h"><span>Chat</span><span id="status-chip" class="empty">…</span></header>
      <div id="chat" class="scroll"><div class="empty">Loading session…</div></div>
      <div class="composer">
        <input id="chat-input" placeholder="Talk to Manager (Enter to send)" />
        <button id="chat-send">Send</button>
      </div>
    </section>
    <section>
      <header class="section-h">
        <span>Tasks</span>
        <span class="controls">
          <button onclick="vscode.postMessage({type:'pause'})">Pause</button>
          <button onclick="vscode.postMessage({type:'resume'})">Resume</button>
          <button onclick="vscode.postMessage({type:'cancel'})">Cancel</button>
        </span>
      </header>
      <div id="dag" class="scroll dag"><div class="empty">No tasks yet.</div></div>
    </section>
    <section>
      <header class="section-h"><span>Ribbon</span></header>
      <div id="ribbon" class="scroll"><div class="empty">No events yet.</div></div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let snap = null;
    function escape(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

    function renderChat() {
      const el = document.getElementById('chat');
      if (!snap || !snap.chat || snap.chat.length === 0) { el.innerHTML = '<div class="empty">No turns yet. Send a message below.</div>'; return; }
      el.innerHTML = snap.chat.map(t =>
        '<div class="turn ' + (t.role === 'user' ? 'user' : 'manager') + '"><div class="bubble">' + escape(t.text) + '</div></div>'
      ).join('');
      el.scrollTop = el.scrollHeight;
    }
    function renderDag() {
      const el = document.getElementById('dag');
      if (!snap || !snap.waves || snap.waves.length === 0) { el.innerHTML = '<div class="empty">No tasks yet.</div>'; return; }
      el.innerHTML = snap.waves.map(w =>
        '<div class="wave"><div class="wave-label">Wave ' + w.id + '</div><div class="tasks">' +
          w.tasks.map(t => {
            const cls = 'status-' + (t.status || 'pending').toLowerCase();
            return '<div class="task ' + cls + '">' +
              '<div class="desc">' + escape(t.description) + '</div>' +
              '<div class="meta"><span>#' + t.id + '</span><span>' + escape(t.agent || 'auto') + '</span><span>' + escape(t.status) + '</span></div>' +
              '<div class="actions">' +
                '<button onclick="taskAction(' + t.id + ', \\'skip\\')">Skip</button>' +
                '<button onclick="taskAction(' + t.id + ', \\'rerun\\')">Rerun</button>' +
                '<button onclick="taskAction(' + t.id + ', \\'take-over\\')">Take over</button>' +
              '</div>' +
            '</div>';
          }).join('') +
        '</div></div>'
      ).join('');
    }
    function renderRibbon() {
      const el = document.getElementById('ribbon');
      if (!snap || !snap.ribbon || snap.ribbon.length === 0) { el.innerHTML = '<div class="empty">No events yet.</div>'; return; }
      el.innerHTML = snap.ribbon.slice().reverse().map(r =>
        '<div class="ribbon-row"><span class="ts">' + escape(r.ts) + '</span><span class="kind">' + escape(r.kind) + '</span>' + escape(r.summary) + '</div>'
      ).join('');
    }
    function renderStatus() {
      document.getElementById('status-chip').textContent = snap?.status ?? '—';
    }
    function rerender() { renderStatus(); renderChat(); renderDag(); renderRibbon(); }

    function taskAction(id, mode) { vscode.postMessage({ type: 'task-action', taskId: id, mode }); }

    document.getElementById('chat-send').addEventListener('click', sendChat);
    document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    function sendChat() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'send-chat', text });
    }

    function applyEvent(e) {
      if (!snap) return;
      // The event-delta reducer mirrors aura-shell/src/lib/managerStore.ts.
      switch (e.type) {
        case 'ManagerSpeech':
          snap.chat = snap.chat || [];
          snap.chat.push({ role: 'manager', text: String(e.text ?? ''), at: Date.now() });
          break;
        case 'TaskDispatched':
        case 'TaskCompleted':
        case 'TaskFailed':
        case 'TaskStatus':
          for (const w of snap.waves) for (const t of w.tasks) if (t.id === e.task_id) t.status = e.status ?? t.status;
          break;
        case 'PlanReady':
          snap.waves = e.waves || snap.waves;
          break;
        case 'StatusChanged':
          snap.status = e.status ?? snap.status;
          break;
      }
      // Append every event to ribbon for visibility.
      snap.ribbon = snap.ribbon || [];
      snap.ribbon.push({ ts: new Date().toISOString(), kind: e.type, summary: e.summary || '' });
      rerender();
    }

    window.addEventListener('message', ev => {
      const m = ev.data;
      if (m?.type === 'snapshot') { snap = m.data; rerender(); }
      else if (m?.type === 'event') { applyEvent(m.event); }
      else if (m?.type === 'error') { document.getElementById('status-chip').textContent = '⚠ ' + (m.message || ''); }
      else if (m?.type === 'stream-exit') { document.getElementById('status-chip').textContent = (snap?.status ?? '') + ' (stream closed)'; }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const buf = new Uint8Array(16);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
