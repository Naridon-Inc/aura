// Entry point for the aura-vscode extension.
//
// V1 scope:
//   • Status-bar chips (strict / intents / audit / live sync / cost).
//   • Activity-bar container with placeholder views — V2 fills these in.
//   • Commands: review, openManager, openInbox, snapshot, logIntent,
//     prove, rewind, openStory, openReplay, openSettings, refreshStatus.
//   • MCP bridge — lazily started on first command that needs a tool call.
//   • Cloud token storage.
//
// What V1 does NOT do (later stages):
//   • Manager / PR / Story / Replay / Inspector webviews.
//   • SCM provider, blame/impact decorations, code lenses.
//   • LSP server.

import * as path from "node:path";
import * as vscode from "vscode";
import * as aura from "./auraClient";
import { AuraSubcommandMissingError } from "./auraClient";
import { AuraMcpClient } from "./mcp/auraMcpClient";
import { createStatusBar } from "./statusBar";
import { promptForCloudToken, getCloudToken } from "./auth";
import { HistoryTreeProvider } from "./views/historyTree";
import { SourceControlTreeProvider } from "./views/sourceControlAura";
import { MemoryTreeProvider } from "./views/memoryTree";
import { KnowledgeTreeProvider } from "./views/knowledgeTree";
import { DoctorWebviewProvider } from "./views/doctorWebview";
import { SettingsWebviewProvider } from "./views/settingsWebview";
import { MemoryDocsProvider, MEMORY_SCHEME, memoryUri } from "./views/memoryDocs";
import { openManagerPanel, startManagerSession } from "./manager/managerPanel";
import { PrInboxTreeProvider } from "./pr/prInboxTree";
import { openPrDetail } from "./pr/prDetailPanel";
import { registerPrDocProviders } from "./pr/prDocs";
import { SentinelTreeProvider } from "./sentinel/sentinelTree";
import { LiveSyncWatcher } from "./liveSync/liveSyncWatcher";
import { IntentLensProvider } from "./codelens/intentLens";
import { BlameChipController } from "./decorations/blameGutter";
import { openStoryPanel } from "./story/storyPanel";
import { openReplayPanel } from "./studio/replayPanel";
import { openInspectorPanel } from "./studio/inspectorPanel";
import { registerAuraScm } from "./scm/auraScmProvider";

let statusBar: ReturnType<typeof createStatusBar> | null = null;
let mcp: AuraMcpClient | null = null;

function reportError(label: string, err: unknown) {
  if (err instanceof AuraSubcommandMissingError) {
    vscode.window.showInformationMessage(`Aura: \`${err.args.join(" ")}\` not in this CLI version. Skipping.`);
  } else {
    vscode.window.showErrorMessage(`${label}: ${(err as Error).message}`);
  }
}

/** Run `aura enable` for the active repo with progress + a friendly result.
 *  Shared by the palette command and the first-run gate. Returns true on
 *  success so the caller can refresh dependent UI. */
async function runEnable(out: vscode.OutputChannel): Promise<boolean> {
  const root = activeRepoRoot();
  if (!root) {
    vscode.window.showWarningMessage("Aura: open a folder first, then enable capture.");
    return false;
  }
  if (!aura.resolveAuraBin()) {
    const pick = await vscode.window.showWarningMessage(
      "Aura CLI not found on PATH. Install it, or point `aura.binPath` at the binary.",
      "Open settings",
    );
    if (pick === "Open settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "aura.binPath");
    }
    return false;
  }
  try {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Aura: enabling semantic capture…" },
      () => aura.enable(root),
    );
    out.appendLine(summary.trimEnd());
    const pick = await vscode.window.showInformationMessage(
      "Aura capture is on — every commit now records a semantic checkpoint (no MCP needed).",
      "Show output",
    );
    if (pick === "Show output") out.show(true);
    statusBar?.refresh(root);
    return true;
  } catch (err) {
    reportError("Aura enable failed", err);
    return false;
  }
}

function activeRepoRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  // V1: pick the first workspace folder. Multi-root resolution lives in V2
  // when SCM provider needs per-folder routing.
  return folders[0].uri.fsPath;
}

async function ensureMcp(cwd: string): Promise<AuraMcpClient | null> {
  if (mcp) return mcp;
  const client = AuraMcpClient.tryCreate(cwd);
  if (!client) {
    vscode.window.showWarningMessage("Aura MCP binary not found. Install `aura-mcp` or set `aura.mcpBinPath`.");
    return null;
  }
  await client.start();
  mcp = client;
  return mcp;
}

export async function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Aura");
  ctx.subscriptions.push(out);

  // ---- Status bar ----
  statusBar = createStatusBar(ctx);
  statusBar.startPolling(() => activeRepoRoot());

  // ---- Activity-bar views ----
  const cwd = () => activeRepoRoot();
  const historyTree   = new HistoryTreeProvider(cwd);
  const scmTree       = new SourceControlTreeProvider(cwd);
  const memoryTree    = new MemoryTreeProvider(cwd);
  const knowledgeTree = new KnowledgeTreeProvider(cwd);
  const prInboxTree   = new PrInboxTreeProvider(cwd);
  const sentinelTree  = new SentinelTreeProvider(cwd);
  const doctorView    = new DoctorWebviewProvider(cwd);
  const settingsView  = new SettingsWebviewProvider(ctx, cwd);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("aura.history",       historyTree),
    vscode.window.registerTreeDataProvider("aura.sourceControl", scmTree),
    vscode.window.registerTreeDataProvider("aura.memory",        memoryTree),
    vscode.window.registerTreeDataProvider("aura.knowledge",     knowledgeTree),
    vscode.window.registerTreeDataProvider("aura.prInbox",       prInboxTree),
    vscode.window.registerTreeDataProvider("aura.sentinel",      sentinelTree),
    vscode.window.registerWebviewViewProvider("aura.doctor",     doctorView),
    vscode.window.registerWebviewViewProvider("aura.settings",   settingsView),
  );

  registerPrDocProviders(ctx, cwd);

  // ---- V9: SCM provider ----
  registerAuraScm(ctx, cwd);

  // ---- V5: CodeLens + blame chip ----
  const intentLens = new IntentLensProvider();
  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, intentLens),
  );
  const blame = new BlameChipController(cwd);
  blame.attach(ctx);

  // ---- Live Sync watcher (auto-start when a workspace is open) ----
  let watcher: LiveSyncWatcher | null = null;
  function startWatcher() {
    const root = activeRepoRoot();
    if (!root) return;
    if (watcher) return;
    watcher = new LiveSyncWatcher(root);
    watcher.on("impact", (e: { summary?: string; file?: string }) => {
      vscode.window.showWarningMessage(`Aura impact: ${e.summary ?? ""} (${e.file ?? ""})`);
    });
    watcher.on("error", (err: Error) => {
      out.appendLine(`[live-sync] ${err.message}`);
    });
    watcher.start();
  }
  function stopWatcher() {
    if (!watcher) return;
    watcher.stop();
    watcher = null;
  }
  startWatcher();
  ctx.subscriptions.push({ dispose: stopWatcher });
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => watcher?.applyAll()),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) watcher?.applyTo(ed); }),
  );

  // Memory keys open as virtual editors (read-only in V2; FSP write in V3).
  const memoryDocs = new MemoryDocsProvider(cwd);
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(MEMORY_SCHEME, memoryDocs),
  );

  // Refresh on workspace folder change so cold-open onto a fresh repo
  // hydrates the chips immediately rather than on the next poll tick.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void statusBar?.refresh(activeRepoRoot());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aura.binPath")) aura.clearAuraBinCache();
      if (e.affectsConfiguration("aura.statusBarPollSeconds")) {
        statusBar?.startPolling(() => activeRepoRoot());
      }
    }),
  );

  // ---- Commands ----
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aura.refreshStatus", () => statusBar?.refresh(activeRepoRoot())),

    // Frictionless capture: `aura enable` / `aura disable` straight from the
    // palette. No MCP server, no cloud token — just installs/removes the git
    // hooks so every commit records a semantic checkpoint.
    vscode.commands.registerCommand("aura.enable", () => runEnable(out)),
    vscode.commands.registerCommand("aura.disable", async () => {
      const root = activeRepoRoot();
      if (!root) { vscode.window.showWarningMessage("Aura: no workspace folder."); return; }
      try {
        const summary = await aura.disable(root);
        out.appendLine(summary.trimEnd());
        vscode.window.showInformationMessage("Aura capture disabled — your semantic history stays in git.");
        statusBar?.refresh(root);
      } catch (err) {
        reportError("Aura disable failed", err);
      }
    }),

    vscode.commands.registerCommand("aura.snapshot", async () => {
      const cwd = activeRepoRoot();
      const ed = vscode.window.activeTextEditor;
      if (!cwd) { vscode.window.showWarningMessage("Aura: no workspace folder."); return; }
      if (!ed) { vscode.window.showWarningMessage("Aura: no active file to snapshot."); return; }
      try {
        await aura.snapshotFile(cwd, ed.document.uri.fsPath);
        vscode.window.setStatusBarMessage(`Aura: snapshot saved (${path.basename(ed.document.uri.fsPath)})`, 3000);
      } catch (err) {
        reportError("Aura snapshot failed", err);
      }
    }),

    vscode.commands.registerCommand("aura.logIntent", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) { vscode.window.showWarningMessage("Aura: no workspace folder."); return; }
      const msg = await vscode.window.showInputBox({
        title: "Aura — log intent",
        prompt: "Describe what you're about to do (or what you just did).",
        ignoreFocusOut: true,
      });
      if (!msg) return;
      try {
        await aura.logIntent(cwd, msg);
        await statusBar?.refresh(cwd);
        vscode.window.setStatusBarMessage("Aura: intent logged", 3000);
      } catch (err) {
        reportError("Aura log-intent failed", err);
      }
    }),

    vscode.commands.registerCommand("aura.prove", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      const goal = await vscode.window.showInputBox({
        title: "Aura — prove goal",
        prompt: "What behavior do you want to verify? (e.g. \"User can authenticate via OAuth\")",
        ignoreFocusOut: true,
      });
      if (!goal) return;
      try {
        const r = await aura.prove(cwd, goal);
        out.show(true);
        out.appendLine("--- aura prove ---");
        out.appendLine(JSON.stringify(r, null, 2));
      } catch (err) {
        reportError("Aura prove failed", err);
      }
    }),

    vscode.commands.registerCommand("aura.rewind", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      const node = await vscode.window.showInputBox({
        title: "Aura — rewind node",
        prompt: "Function or class name to revert to last safe state.",
        ignoreFocusOut: true,
      });
      if (!node) return;
      try {
        await aura.rewindNode(cwd, node);
        vscode.window.showInformationMessage(`Aura: rewound \`${node}\``);
      } catch (err) {
        reportError("Aura rewind failed", err);
      }
    }),

    // ---- V2 view commands ----
    vscode.commands.registerCommand("aura.history.refresh",   () => historyTree.refresh()),
    vscode.commands.registerCommand("aura.history.loadMore",  (group) => historyTree.loadMore(group)),
    vscode.commands.registerCommand("aura.scm.refresh",       () => scmTree.refresh()),
    vscode.commands.registerCommand("aura.scm.saveAndSync",   () => saveAndSync(activeRepoRoot(), scmTree, statusBar)),
    vscode.commands.registerCommand("aura.memory.refresh",    () => memoryTree.refresh()),
    vscode.commands.registerCommand("aura.memory.openKey",    async (key: string) => {
      const uri = memoryUri(key);
      memoryDocs.reload(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("aura.memory.write", async (key?: string) => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      const k = key ?? await vscode.window.showInputBox({ title: "Aura — memory key", prompt: "Key (e.g. project.notes)" });
      if (!k) return;
      const body = await vscode.window.showInputBox({ title: `Aura — write memory '${k}'`, prompt: "Body (single line; multi-line via openKey + edit)" });
      if (typeof body !== "string") return;
      try {
        await aura.runText(["memory", "write", k, body], { cwd });
        memoryTree.refresh();
        memoryDocs.reload(memoryUri(k));
      } catch (err) {
        reportError("Aura memory write failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.session.open", async (id: string) => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      try {
        const text = await aura.runText(["session", "show", id], { cwd });
        const doc = await vscode.workspace.openTextDocument({ content: text, language: "markdown" });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        reportError("Aura session show failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.knowledge.refresh", () => knowledgeTree.refresh()),
    vscode.commands.registerCommand("aura.knowledge.search",  async () => {
      const q = await vscode.window.showInputBox({ title: "Aura — search knowledge", placeHolder: "Empty to clear" });
      knowledgeTree.setQuery(q && q.trim() ? q.trim() : null);
    }),
    vscode.commands.registerCommand("aura.knowledge.openEntry", async (id: string) => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      try {
        const text = await aura.runText(["know", "get", id], { cwd });
        const doc = await vscode.workspace.openTextDocument({ content: text, language: "markdown" });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        reportError("Aura know get failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.knowledge.new", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      const title = await vscode.window.showInputBox({ title: "New knowledge — title" });
      if (!title) return;
      const body = await vscode.window.showInputBox({ title: "New knowledge — body" });
      if (typeof body !== "string") return;
      try {
        await aura.runText(["know", "store", title, body], { cwd });
        knowledgeTree.refresh();
      } catch (err) {
        reportError("Aura know store failed", err);
      }
    }),

    // ---- Stubs for later stages ----
    // ---- Sentinel ----
    vscode.commands.registerCommand("aura.sentinel.refresh", () => sentinelTree.refresh()),
    vscode.commands.registerCommand("aura.sentinel.send", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      const to = await vscode.window.showInputBox({ title: "Sentinel — to", prompt: "Recipient (user, team, or @everyone)" });
      if (!to) return;
      const subject = await vscode.window.showInputBox({ title: "Sentinel — subject" });
      if (!subject) return;
      const body = await vscode.window.showInputBox({ title: "Sentinel — body" });
      if (typeof body !== "string") return;
      try {
        await aura.runText(["msg", "send", "--to", to, "--subject", subject, "--body", body], { cwd });
        sentinelTree.refresh();
      } catch (err) {
        reportError("Sentinel send failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.sentinel.openMessage", async (id: string) => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      try {
        const text = await aura.runText(["msg", "show", id], { cwd });
        const doc = await vscode.workspace.openTextDocument({ content: text, language: "markdown" });
        await vscode.window.showTextDocument(doc, { preview: false });
        // Mark as read.
        try { await aura.runText(["msg", "mark-read", id], { cwd }); sentinelTree.refresh(); } catch { /* tolerate */ }
      } catch (err) {
        reportError("Sentinel open failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.sentinel.reply", async (id: string) => {
      const cwd = activeRepoRoot();
      if (!cwd || !id) return;
      const body = await vscode.window.showInputBox({ title: `Reply to ${id}` });
      if (!body) return;
      try {
        await aura.runText(["msg", "reply", id, "--body", body], { cwd });
        sentinelTree.refresh();
      } catch (err) {
        reportError("Sentinel reply failed", err);
      }
    }),

    // ---- Live Sync + Zone claim ----
    vscode.commands.registerCommand("aura.liveSync.start", () => startWatcher()),
    vscode.commands.registerCommand("aura.liveSync.stop",  () => stopWatcher()),
    vscode.commands.registerCommand("aura.zone.claim",   async () => {
      const cwd = activeRepoRoot();
      const ed = vscode.window.activeTextEditor;
      if (!cwd || !ed) return;
      const rel = path.relative(cwd, ed.document.uri.fsPath);
      try {
        await aura.runText(["zone", "claim", rel], { cwd });
        vscode.window.setStatusBarMessage(`Aura: zone claimed (${rel})`, 3000);
      } catch (err) {
        reportError("Aura zone claim failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.zone.release", async () => {
      const cwd = activeRepoRoot();
      const ed = vscode.window.activeTextEditor;
      if (!cwd || !ed) return;
      const rel = path.relative(cwd, ed.document.uri.fsPath);
      try {
        await aura.runText(["zone", "release", rel], { cwd });
        vscode.window.setStatusBarMessage(`Aura: zone released (${rel})`, 3000);
      } catch (err) {
        reportError("Aura zone release failed", err);
      }
    }),

    vscode.commands.registerCommand("aura.pr.refresh", () => prInboxTree.refresh()),
    vscode.commands.registerCommand("aura.pr.openDetail", async (n?: number) => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      let pr = n;
      if (typeof pr !== "number") {
        const text = await vscode.window.showInputBox({ title: "Aura — open PR", prompt: "PR number" });
        if (!text) return;
        pr = parseInt(text, 10);
        if (Number.isNaN(pr)) return;
      }
      await openPrDetail(ctx, cwd, pr);
    }),
    vscode.commands.registerCommand("aura.openInbox", async () => {
      // Reveal the PR Inbox tree.
      await vscode.commands.executeCommand("workbench.view.extension.aura");
      await vscode.commands.executeCommand("aura.prInbox.focus");
    }),

    vscode.commands.registerCommand("aura.review", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      try {
        const r = await aura.runJson<unknown>(["pr-review", "--base", "main"], { cwd });
        out.show(true);
        out.appendLine("--- aura pr-review ---");
        out.appendLine(JSON.stringify(r, null, 2));
      } catch (err) {
        reportError("Aura review failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.openManager", async (sessionId?: string) => {
      const cwd = activeRepoRoot();
      if (!cwd) { vscode.window.showWarningMessage("Aura: open a workspace folder first."); return; }
      let sid = sessionId;
      if (!sid) {
        // Pick from active sessions, or start a new one.
        let active: Array<{ session_id: string; objective: string; status: string }> = [];
        try {
          const r = await aura.runJson<{ sessions: typeof active }>(["manager", "list"], { cwd });
          active = r.sessions;
        } catch {
          active = [];
        }
        const items: vscode.QuickPickItem[] = [
          { label: "$(add) New session…", description: "Start a fresh Manager objective", alwaysShow: true },
          ...active.map((s) => ({ label: s.objective || s.session_id, description: `${s.status} · ${s.session_id.slice(0, 8)}` })),
        ];
        const pick = await vscode.window.showQuickPick(items, { title: "Aura — open Manager session" });
        if (!pick) return;
        if (pick.label.startsWith("$(add)") || pick.label.startsWith("New session")) {
          const obj = await vscode.window.showInputBox({ title: "Manager — objective", prompt: "What do you want the Manager to coordinate?", ignoreFocusOut: true });
          if (!obj) return;
          sid = (await startManagerSession(cwd, obj)) ?? undefined;
          if (!sid) return;
        } else {
          sid = active.find((s) => (s.objective || s.session_id) === pick.label)?.session_id;
        }
      }
      if (!sid) return;
      await openManagerPanel(ctx, cwd, sid);
    }),
    vscode.commands.registerCommand("aura.openStory", async () => {
      const cwd = activeRepoRoot();
      const ed = vscode.window.activeTextEditor;
      if (!cwd) return;
      const target = ed?.document.uri.fsPath;
      if (!target) { vscode.window.showWarningMessage("Aura: open a file to view its story."); return; }
      await openStoryPanel(ctx, cwd, target);
    }),
    vscode.commands.registerCommand("aura.prove.symbol", async (name?: string) => {
      const cwd = activeRepoRoot();
      if (!cwd || !name) return;
      try {
        const r = await aura.prove(cwd, name);
        out.show(true);
        out.appendLine(`--- aura prove ${name} ---`);
        out.appendLine(JSON.stringify(r, null, 2));
      } catch (err) {
        reportError("Aura prove failed", err);
      }
    }),
    vscode.commands.registerCommand("aura.openReplay", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      await openReplayPanel(ctx, cwd);
    }),
    vscode.commands.registerCommand("aura.openInspector", async () => {
      const cwd = activeRepoRoot();
      if (!cwd) return;
      await openInspectorPanel(ctx, cwd);
    }),
    vscode.commands.registerCommand("aura.openSettings", async () => {
      // Two-stage settings: V1 just ensures cloud token + offers binary path.
      const existing = await getCloudToken(ctx);
      const choice = await vscode.window.showQuickPick(
        [
          { label: existing ? "Re-enter cloud token" : "Set cloud token", id: "token" },
          { label: "Open VS Code Aura settings", id: "vs" },
        ],
        { title: "Aura — settings" },
      );
      if (!choice) return;
      if (choice.id === "token") await promptForCloudToken(ctx);
      if (choice.id === "vs") void vscode.commands.executeCommand("workbench.action.openSettings", "aura");
    }),
  );

  // ---- MCP lazy bring-up ----
  // We don't start MCP at activation: not every Aura repo wants it
  // running. The first command that needs a tool call triggers it.
  ctx.subscriptions.push({
    dispose: () => mcp?.dispose(),
  });

  // ---- First-run gate: offer one-click, no-MCP capture ----
  // The adoption story mirrors `entire enable`: if this repo isn't capturing
  // yet, lead with a single "Enable Aura" action that runs `aura enable` (git
  // hooks only — no MCP server, no token). We re-offer per repo, not just once
  // globally, so opening a fresh project still surfaces the gate; but we never
  // nag a repo that already captures.
  {
    const root = activeRepoRoot();
    const captures = root ? aura.isCaptureEnabled(root) : false;
    const offeredKey = root ? `aura.enableOffered:${root}` : "aura.enableOffered";

    if (root && !captures && !ctx.globalState.get(offeredKey)) {
      void ctx.globalState.update(offeredKey, true);
      const action = await vscode.window.showInformationMessage(
        "Turn on Aura semantic capture for this repo? One command, no MCP server — every commit records what changed, why, and by which agent, straight into git.",
        "Enable Aura", "Not now",
      );
      if (action === "Enable Aura") {
        await runEnable(out);
      }
    } else if (!ctx.globalState.get("aura.welcomed")) {
      // Already capturing (or no folder yet): a quiet one-time hello, no nag.
      void ctx.globalState.update("aura.welcomed", true);
      const action = await vscode.window.showInformationMessage(
        "Aura is active. Run `Aura: Log Intent` or open the Aura activity bar.",
        "Open settings", "Dismiss",
      );
      if (action === "Open settings") {
        void vscode.commands.executeCommand("aura.openSettings");
      }
    }
  }

  out.appendLine(`[aura-vscode] activated. bin=${aura.resolveAuraBin() ?? "(not found)"} root=${activeRepoRoot() ?? "(none)"}`);

  // V1 returns nothing; V2+ may return an extension API for tests.
  void ensureMcp;
}

export function deactivate() {
  statusBar?.dispose();
  statusBar = null;
  mcp?.dispose();
  mcp = null;
}

async function saveAndSync(
  cwd: string | null,
  scmTree: { refresh: () => void },
  status: ReturnType<typeof createStatusBar> | null,
): Promise<void> {
  if (!cwd) { vscode.window.showWarningMessage("Aura: no workspace folder."); return; }
  // Pre-flight: ask for intent if there's no pending entry. The CLI itself
  // does the same check; we surface it here for a smoother UX.
  let pendingIntent = "";
  try {
    const pending = await aura.runJson<{ entries: Array<{ id: string }> }>(["intent", "pending"], { cwd });
    if (pending.entries.length === 0) {
      const m = await vscode.window.showInputBox({
        title: "Aura — log intent for this save",
        prompt: "Describe what you're about to commit.",
        ignoreFocusOut: true,
      });
      if (!m) return;
      pendingIntent = m;
    }
  } catch {
    // intent pending --json not available; fall through and let `aura save` prompt.
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Aura: Save & Sync", cancellable: false },
    async () => {
      try {
        if (pendingIntent) await aura.logIntent(cwd, pendingIntent);
        const out = await aura.runText(["save"], { cwd });
        vscode.window.showInformationMessage(`Aura: saved.\n${out.split("\n").slice(0, 3).join(" · ")}`);
        scmTree.refresh();
        await status?.refresh(cwd);
      } catch (err) {
        reportError("Aura save failed", err);
      }
    },
  );
}
