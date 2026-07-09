"use strict";
// The stdio wire: one JSON object per line, both directions.
//
//   • stdout  = the protocol channel (host → Aura). Every `send()` writes exactly
//     one line; `JSON.stringify` escapes embedded newlines, so a message never
//     spans lines.
//   • stdin   = Aura → host. `onLine()` parses one message per line.
//   • stderr  = logs/diagnostics only. The Rust side forwards stderr to
//     `ext-host:log`, never the protocol — so stdout stays clean.
//
// Keeping the framing this trivial is deliberate: the Rust transport
// (`cmd_ext_host.rs`) does line splitting, and the frontend runtime treats each
// `ext-host:msg` as a parsed message. No length-prefixing, no partial frames.

const readline = require("readline");

/** Write one protocol message to stdout (host → Aura). */
function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    logErr("send failed: " + (e && e.message));
  }
}

/** Emit a diagnostic line on stderr (surfaced as `ext-host:log`). */
function logErr(...args) {
  try {
    process.stderr.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
  } catch {
    // stderr is best-effort; never throw out of a logger.
  }
}

/** Read messages from stdin, one parsed JSON object per line. A bad line is
 *  logged and skipped, never fatal. When stdin closes (parent gone) we exit so
 *  the OS reaps every language server we spawned (they're our children). */
function onLine(handler) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch (e) {
      logErr("bad json line: " + (e && e.message));
      return;
    }
    Promise.resolve()
      .then(() => handler(msg))
      .catch((e) => logErr("handler error: " + ((e && e.stack) || e)));
  });
  rl.on("close", () => process.exit(0));
}

module.exports = { send, logErr, onLine };
