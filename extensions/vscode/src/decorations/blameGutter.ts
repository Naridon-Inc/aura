// Inline blame chip — renders "<author> · <relative date>" at end of
// the cursor's current line. Lazy: only fetches blame for the active
// file when the cursor settles for >300ms. No blame data ever loaded
// for files outside the user's focus.

import * as vscode from "vscode";
import * as aura from "../auraClient";

interface BlameLine { line: number; sha: string; author: string; ts: string; summary: string; }

export class BlameChipController {
  private readonly deco: vscode.TextEditorDecorationType;
  private cache = new Map<string, BlameLine[]>(); // key = file path
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly cwdGetter: () => string | null) {
    this.deco = vscode.window.createTextEditorDecorationType({
      after: { color: "var(--vscode-editorCodeLens-foreground)", margin: "0 0 0 24px" },
    });
  }

  attach(ctx: vscode.ExtensionContext) {
    const reschedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refreshActive(), 300);
    };
    ctx.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(reschedule),
      vscode.window.onDidChangeActiveTextEditor(reschedule),
      { dispose: () => this.dispose() },
    );
    reschedule();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deco.dispose();
  }

  private async refreshActive() {
    const ed = vscode.window.activeTextEditor;
    const cwd = this.cwdGetter();
    if (!ed || !cwd || ed.document.uri.scheme !== "file") return;
    const file = ed.document.uri.fsPath;
    let blame = this.cache.get(file);
    if (!blame) {
      try {
        const r = await aura.runJson<{ lines: BlameLine[] }>(["git", "blame", "--file", file], { cwd });
        blame = r.lines;
        this.cache.set(file, blame);
      } catch {
        return;
      }
    }
    const line = ed.selection.active.line;
    const entry = blame.find((b) => b.line === line + 1) ?? blame.find((b) => b.line === line);
    if (!entry) {
      ed.setDecorations(this.deco, []);
      return;
    }
    const text = `   ${entry.author}, ${fmtAge(entry.ts)} · ${entry.summary.slice(0, 64)}`;
    ed.setDecorations(this.deco, [{
      range: ed.document.lineAt(line).range,
      renderOptions: { after: { contentText: text } },
    }]);
  }

  invalidate(file: string) { this.cache.delete(file); }
}

function fmtAge(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
