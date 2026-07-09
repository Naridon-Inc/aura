// Live Sync watcher.
//
// Spawns `aura live-sync watch --json --follow` and listens for events
// emitted line-by-line on stdout. Three event kinds we surface today:
//
//   • presence — { kind:"presence", file, line, user, color }
//   • zone-claim / zone-release — { kind:"zone", file, claimed_by, op:"claim"|"release" }
//   • impact   — { kind:"impact", id, file, line, summary, severity }
//
// The watcher is a singleton (one per workspace). It owns three
// vscode.TextEditorDecorationType instances (presence pip, zone tint,
// impact gutter) and re-applies them when active editors change.

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveAuraBin } from "../auraClient";

export interface LiveEvent {
  kind: "presence" | "zone" | "impact" | string;
  [k: string]: unknown;
}

interface PresenceMark { file: string; line: number; user: string; color: string; ts: number; }
interface ZoneMark     { file: string; claimedBy: string; }
interface ImpactMark   { id: string; file: string; line: number; severity: string; summary: string; }

const PRESENCE_TTL_MS = 60_000;

export class LiveSyncWatcher extends EventEmitter {
  private child: ChildProcess | null = null;
  private buf = "";
  private readonly presences = new Map<string, PresenceMark[]>(); // key = file
  private readonly zones     = new Map<string, ZoneMark>();        // key = file
  private readonly impacts   = new Map<string, ImpactMark[]>();    // key = file

  private readonly presenceDeco: vscode.TextEditorDecorationType;
  private readonly zoneDeco:     vscode.TextEditorDecorationType;
  private readonly impactDeco:   vscode.TextEditorDecorationType;

  constructor(private readonly cwd: string) {
    super();
    this.presenceDeco = vscode.window.createTextEditorDecorationType({
      after: { contentText: " ●", color: "var(--vscode-editorInfo-foreground)" },
      isWholeLine: false,
    });
    this.zoneDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: "color-mix(in srgb, var(--vscode-charts-purple) 12%, transparent)",
      isWholeLine: true,
      gutterIconPath: undefined,
      overviewRulerColor: "var(--vscode-charts-purple)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.impactDeco = vscode.window.createTextEditorDecorationType({
      gutterIconPath: undefined,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: "var(--vscode-charts-yellow)",
      isWholeLine: true,
      overviewRulerColor: "var(--vscode-charts-yellow)",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  start(): void {
    if (this.child) return;
    const bin = resolveAuraBin();
    if (!bin) { this.emit("error", new Error("aura binary not found")); return; }
    const child = spawn(bin, ["live-sync", "watch", "--json", "--follow"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk));
    child.stderr?.on("data", () => { /* swallow */ });
    child.on("exit", () => { this.child = null; this.emit("exit"); });
    child.on("error", (err) => this.emit("error", err));
    // Periodically prune expired presence markers and reapply decorations.
    const interval = setInterval(() => { this.prune(); this.applyAll(); }, 5000);
    this.once("exit", () => clearInterval(interval));
  }

  stop(): void {
    if (this.child) { try { this.child.kill("SIGTERM"); } catch { /* ignore */ } }
    this.child = null;
    this.presenceDeco.dispose();
    this.zoneDeco.dispose();
    this.impactDeco.dispose();
  }

  applyTo(editor: vscode.TextEditor) {
    const file = relPath(this.cwd, editor.document.uri.fsPath);
    const presences = this.presences.get(file) ?? [];
    const presenceRanges = presences.map((p) => new vscode.Range(p.line, 0, p.line, 0));
    editor.setDecorations(this.presenceDeco, presenceRanges);

    const zone = this.zones.get(file);
    editor.setDecorations(this.zoneDeco, zone ? [new vscode.Range(0, 0, editor.document.lineCount, 0)] : []);

    const impacts = this.impacts.get(file) ?? [];
    editor.setDecorations(this.impactDeco, impacts.map((i) => ({
      range: new vscode.Range(i.line, 0, i.line, 0),
      hoverMessage: `**${i.severity}** — ${i.summary}`,
    })));
  }

  applyAll() {
    for (const ed of vscode.window.visibleTextEditors) this.applyTo(ed);
  }

  private prune() {
    const now = Date.now();
    for (const [file, marks] of this.presences) {
      const fresh = marks.filter((m) => now - m.ts < PRESENCE_TTL_MS);
      if (fresh.length === 0) this.presences.delete(file);
      else this.presences.set(file, fresh);
    }
  }

  private onChunk(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as LiveEvent;
        this.handle(evt);
      } catch { /* ignore malformed line */ }
    }
  }

  private handle(e: LiveEvent) {
    if (e.kind === "presence" && typeof e.file === "string" && typeof e.line === "number") {
      const arr = this.presences.get(e.file) ?? [];
      const filtered = arr.filter((p) => p.user !== e.user);
      filtered.push({ file: e.file, line: e.line, user: String(e.user ?? ""), color: String(e.color ?? "blue"), ts: Date.now() });
      this.presences.set(e.file, filtered);
      this.applyAll();
    } else if (e.kind === "zone" && typeof e.file === "string") {
      if (e.op === "release") this.zones.delete(e.file);
      else this.zones.set(e.file, { file: e.file, claimedBy: String(e.claimed_by ?? "") });
      this.applyAll();
    } else if (e.kind === "impact" && typeof e.id === "string" && typeof e.file === "string") {
      const arr = this.impacts.get(e.file) ?? [];
      arr.push({ id: e.id, file: e.file, line: typeof e.line === "number" ? e.line : 0, severity: String(e.severity ?? "info"), summary: String(e.summary ?? "") });
      this.impacts.set(e.file, arr);
      this.applyAll();
      this.emit("impact", e);
    }
  }
}

function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  return r.startsWith("..") ? abs : r;
}
