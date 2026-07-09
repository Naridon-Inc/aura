// JSON-RPC over stdio bridge to the `aura-mcp` binary.
//
// MCP framing: each message is a JSON-RPC 2.0 envelope, length-prefixed
// with `Content-Length: N\r\n\r\n` headers (same wire format as LSP).
// Responses are matched to requests by `id`.
//
// Lifecycle: spawn() launches the binary, sends `initialize`, and
// holds the child until dispose() (or extension deactivation). The
// process is kept alive across commands so we don't pay startup
// cost on every snapshot / log-intent call.

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
};

function probeMcpBin(): string | null {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".cargo/bin"),
    path.join(os.homedir(), ".local/bin"),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ];
  for (const dir of dirs) {
    const p = path.join(dir, "aura-mcp");
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function resolveMcpBin(): string | null {
  const fromCfg = vscode.workspace.getConfiguration("aura").get<string>("mcpBinPath");
  if (fromCfg && fromCfg.trim().length > 0) return fromCfg;
  return probeMcpBin();
}

export class AuraMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private readonly bin: string;
  private readonly cwd: string;
  private initialized = false;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.cwd = cwd;
  }

  static tryCreate(cwd: string): AuraMcpClient | null {
    const bin = resolveMcpBin();
    if (!bin) return null;
    return new AuraMcpClient(bin, cwd);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.bin, [], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Best-effort surface errors; MCP protocol noise is fine on stderr.
      console.error("[aura-mcp]", chunk.toString("utf8").trim());
    });
    this.child.on("exit", (code) => {
      const err = new Error(`aura-mcp exited unexpectedly (code ${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aura-vscode", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  dispose() {
    if (!this.child) return;
    try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    this.child = null;
    this.initialized = false;
  }

  /** Call a registered MCP tool by name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized) await this.start();
    return this.request("tools/call", { name, arguments: args });
  }

  // --- internals ---

  private onChunk(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Drop the corrupt prefix and resync.
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const total = sep + 4 + len;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(sep + 4, total).toString("utf8");
      this.buffer = this.buffer.subarray(total);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string) {
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(body) as JsonRpcResponse; } catch { return; }
    if (typeof msg.id !== "number") return; // Notifications ignored.
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`MCP ${pending.method}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) throw new Error("aura-mcp not started");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.send(req);
    return promise;
  }

  private notify(method: string, params: unknown) {
    if (!this.child) return;
    const env = { jsonrpc: "2.0", method, params };
    const json = JSON.stringify(env);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  private send(req: JsonRpcRequest) {
    if (!this.child) return;
    const json = JSON.stringify(req);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
}
