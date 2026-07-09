// Subprocess driver for `aura manager events --session SID --follow`.
//
// The CLI emits one JSON object per line. We parse line-by-line with a
// rolling buffer (no JSON.parse on partial input) and forward typed
// events to the consumer.
//
// Lifecycle: start() spawns the child; close() SIGTERMs it. The consumer
// owns reconnect logic — we don't auto-restart, because the right answer
// depends on session state (cancelled = stop; transient = retry).

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolveAuraBin } from "../auraClient";

export interface ManagerEvent {
  type: string;
  [k: string]: unknown;
}

export class ManagerStream extends EventEmitter {
  private child: ChildProcess | null = null;
  private buf = "";

  constructor(public readonly sessionId: string, public readonly cwd: string) { super(); }

  start(): void {
    if (this.child) return;
    const bin = resolveAuraBin();
    if (!bin) { this.emit("error", new Error("aura binary not found")); return; }
    const child = spawn(bin, ["manager", "events", "--session", this.sessionId, "--follow", "--json"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Stream stderr lines as info — useful for debugging but never fatal.
      this.emit("stderr", chunk.toString("utf8"));
    });
    child.on("error", (err) => this.emit("error", err));
    child.on("exit", (code) => {
      this.child = null;
      this.emit("exit", code ?? -1);
    });
  }

  close(): void {
    if (!this.child) return;
    try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    this.child = null;
  }

  private onChunk(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as ManagerEvent;
        this.emit("event", evt);
      } catch (err) {
        this.emit("error", new Error(`bad manager event line: ${(err as Error).message}\n${line.slice(0, 200)}`));
      }
    }
  }
}
