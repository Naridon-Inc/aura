// Five status-bar chips polled on a single timer.
//
// Order (left of the right cluster, in declaration order):
//   1. strict mode       — 🔒 Strict / 🔓 Lax  (locked vs unlocked)
//   2. intents today     — 🧠 N intents
//   3. audit unacked     — ⚠ N audit
//   4. live sync         — ⇅ pending↑ / pending↓ / pushers
//   5. cost today        — 💲 $X.XX
//
// Failure mode: if the call throws (e.g. no aura binary, repo not init'd),
// the chip hides itself rather than showing a stack trace. The chip
// reappears once the next poll succeeds.

import * as vscode from "vscode";
import * as aura from "./auraClient";

interface ChipBundle {
  strict: vscode.StatusBarItem;
  intents: vscode.StatusBarItem;
  audit: vscode.StatusBarItem;
  liveSync: vscode.StatusBarItem;
  cost: vscode.StatusBarItem;
}

export function createStatusBar(ctx: vscode.ExtensionContext): {
  refresh: (cwd: string | null) => Promise<void>;
  startPolling: (cwdGetter: () => string | null) => void;
  dispose: () => void;
} {
  const chips: ChipBundle = {
    // Higher priority = further left within the right cluster.
    strict:   make(105, "aura.openSettings"),
    intents:  make(104, "aura.logIntent"),
    audit:    make(103, "aura.refreshStatus"),
    liveSync: make(102, "aura.refreshStatus"),
    cost:     make(101, "aura.refreshStatus"),
  };
  for (const c of Object.values(chips)) ctx.subscriptions.push(c);

  let timer: NodeJS.Timeout | null = null;

  async function refresh(cwd: string | null) {
    if (!cwd) {
      hideAll(chips);
      return;
    }
    // Each chip refreshed in parallel; failures are isolated.
    await Promise.all([
      safe(() => aura.status(cwd), (s) => {
        if (!s) { chips.strict.hide(); return; }
        chips.strict.text = s.strict_mode ? "$(lock) Strict" : "$(unlock) Lax";
        chips.strict.tooltip = s.strict_mode_locked ? "Strict mode is locked (passcode required to disable)." : "Strict mode toggle.";
        chips.strict.show();
      }),
      safe(() => aura.intentsToday(cwd), (r) => {
        if (!r) { chips.intents.hide(); return; }
        chips.intents.text = `$(book) ${r.count} intents`;
        chips.intents.tooltip = `Intents logged today (since ${r.since_iso}). Click to add one.`;
        chips.intents.show();
      }),
      safe(() => aura.auditUnacked(cwd), (r) => {
        if (!r) { chips.audit.hide(); return; }
        if (r.count === 0) { chips.audit.hide(); return; }
        chips.audit.text = `$(warning) ${r.count} audit`;
        chips.audit.tooltip = "Unacknowledged audit events (--no-verify, hook failures, …). Click to refresh.";
        chips.audit.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        chips.audit.show();
      }),
      safe(() => aura.liveSyncStatus(cwd), (r) => {
        if (!r) { chips.liveSync.hide(); return; }
        if (r.pending_outbound === 0 && r.pending_inbound === 0 && r.active_pushers === 0) {
          chips.liveSync.hide();
          return;
        }
        const parts: string[] = [];
        if (r.pending_outbound > 0) parts.push(`↑${r.pending_outbound}`);
        if (r.pending_inbound > 0) parts.push(`↓${r.pending_inbound}`);
        if (r.active_pushers > 0) parts.push(`${r.active_pushers}p`);
        chips.liveSync.text = `$(sync) ${parts.join(" ")}`;
        chips.liveSync.tooltip = "Aura Live Sync — function-body pushes/pulls.";
        chips.liveSync.show();
      }),
      safe(() => aura.usageToday(cwd), (r) => {
        if (!r) { chips.cost.hide(); return; }
        chips.cost.text = `$(credit-card) $${r.total_cost_usd.toFixed(2)}`;
        chips.cost.tooltip = `Today: ${r.total_input_tokens.toLocaleString()} in / ${r.total_output_tokens.toLocaleString()} out tokens`;
        chips.cost.show();
      }),
    ]);
  }

  function startPolling(cwdGetter: () => string | null) {
    if (timer) clearInterval(timer);
    const seconds = vscode.workspace.getConfiguration("aura").get<number>("statusBarPollSeconds") ?? 30;
    const ms = Math.max(5, seconds) * 1000;
    timer = setInterval(() => { void refresh(cwdGetter()); }, ms);
    void refresh(cwdGetter());
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, startPolling, dispose };
}

function make(priority: number, command: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
  item.command = command;
  return item;
}

function hideAll(chips: ChipBundle) {
  for (const c of Object.values(chips)) c.hide();
}

async function safe<T>(thunk: () => Promise<T>, render: (v: T | null) => void): Promise<void> {
  try {
    const v = await thunk();
    render(v);
  } catch {
    render(null);
  }
}
