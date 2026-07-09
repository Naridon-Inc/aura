#!/usr/bin/env node
// @aura/hello-world — bundled MCP server (aura.mcp.json `command`).
//
// The smallest real MCP server: newline-delimited JSON-RPC over stdio,
// one `echo` tool. No dependencies — plain node. Aura spawns it from
// the bundle directory (manifest-relative `args` resolve because the
// host sets cwd = install dir), does the standard MCP handshake
// (initialize → notifications/initialized → request), and tears it
// down after each call.
//
// Env demonstrates the broker contract: HELLO_PREFIX arrives verbatim
// from aura.mcp.json. A `${secrets:<key>}` reference would arrive
// already interpolated from the OS keychain — the value never exists
// on disk and this process is the first place it appears.

const PREFIX = process.env.HELLO_PREFIX || "Hello";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back, prefixed by HELLO_PREFIX.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back" },
      },
      required: ["text"],
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyErr(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) need no reply.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion:
          (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hello-world-mcp", version: "0.1.0" },
      });
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      if (name !== "echo") {
        replyErr(id, -32602, `unknown tool: ${name}`);
        return;
      }
      const text =
        params && params.arguments && typeof params.arguments.text === "string"
          ? params.arguments.text
          : "";
      reply(id, {
        content: [{ type: "text", text: `${PREFIX}, ${text || "world"}!` }],
      });
      return;
    }
    default:
      replyErr(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed line — skip; the host treats missing replies as timeout.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
