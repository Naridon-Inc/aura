"use strict";
// A Language Server Protocol JSON-RPC client over a child process's stdio.
//
// This is pure transport: Content-Length framing (LSP's `base protocol`),
// request/response correlation by integer id, fire-and-forget notifications, and
// a hook for server→client notifications (the one we care about is
// `textDocument/publishDiagnostics`). It answers the handful of server→client
// REQUESTS that would otherwise stall a server (configuration, capability
// (un)registration, progress create, applyEdit) with safe defaults.
//
// It knows nothing about VS Code or Monaco — `languageclient-shim.js` drives it.

const { logErr } = require("./protocol");

class LspClient {
  /** @param child a spawned ChildProcess (stdio: pipe/pipe/pipe)
   *  @param onNotify (method, params) => void for server→client notifications */
  constructor(child, onNotify) {
    this.child = child;
    this.onNotify = onNotify;
    this.seq = 0;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.buf = Buffer.alloc(0);
    this.contentLength = -1;
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stdout.on("error", (e) => logErr("lsp stdout error: " + (e && e.message)));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = this.buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return; // header not complete yet
        const header = this.buf.slice(0, headerEnd).toString("ascii");
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        this.contentLength = m ? parseInt(m[1], 10) : 0;
        this.buf = this.buf.slice(headerEnd + 4);
      }
      if (this.buf.length < this.contentLength) return; // body not complete yet
      const body = this.buf.slice(0, this.contentLength).toString("utf8");
      this.buf = this.buf.slice(this.contentLength);
      this.contentLength = -1;
      if (!body) continue;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        logErr("lsp parse: " + (e && e.message));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(new Error((msg.error && msg.error.message) || "LSP error"));
        else p.resolve(msg.result);
      }
      return;
    }
    // Server→client request (has both method AND id): answer with a safe default.
    if (msg.method && msg.id !== undefined) {
      this._answerServerRequest(msg);
      return;
    }
    // Server→client notification.
    if (msg.method) {
      try {
        this.onNotify(msg.method, msg.params);
      } catch (e) {
        logErr("lsp notify cb: " + (e && e.message));
      }
    }
  }

  _answerServerRequest(msg) {
    const reply = (result) => this._write({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "workspace/configuration": {
        // We have no per-section settings store yet → one empty object per item,
        // which servers read as "use defaults".
        const items = Array.isArray(msg.params && msg.params.items) ? msg.params.items : [];
        reply(items.map(() => ({})));
        return;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        reply(null);
        return;
      case "workspace/applyEdit":
        reply({ applied: false });
        return;
      case "window/showMessageRequest":
        reply(null);
        return;
      default:
        reply(null);
        return;
    }
  }

  _write(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    try {
      this.child.stdin.write(Buffer.concat([header, body]));
    } catch (e) {
      logErr("lsp write: " + (e && e.message));
    }
  }

  request(method, params, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("LSP request timed out: " + method));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  dispose() {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      try {
        p.reject(new Error("LSP client disposed"));
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}

module.exports = { LspClient };
