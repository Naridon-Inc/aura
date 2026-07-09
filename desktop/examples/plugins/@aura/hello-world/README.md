# @aura/hello-world

The smallest possible Aura native plugin — no build step, no SDK,
written straight against the bridge wire protocol so you can see every
envelope that crosses the sandbox boundary.

## What it does

- **Worker** (`worker.js`): subscribes to `aura.ui.*`, counts boots in
  the plugin KV store, toasts on startup, answers the `/hello` slash
  command by reading `aura.status`, answers `/hello-mcp` by calling the
  bundled MCP server's `echo` tool, and reacts to its rail-tile click.
- **Panel** (`panel.html`): a right-rail tab rendered in a sandboxed
  srcdoc iframe (opaque origin, scripts only) with two buttons that
  exercise `ui.toast` and `aura.status` through the bridge.
- **MCP server** (`aura.mcp.json` + `mcp-server.js`): a bundled,
  dependency-free stdio MCP server with one `echo` tool. It shows up in
  Settings → MCP servers with a "plugin" badge, is callable by any
  agent in the app, and is reachable from the worker via `mcp.call`.

## Install (local dev)

Plugins live under `~/.aura/plugins/<scope>/<name>/` with the manifest
at the root:

```sh
mkdir -p ~/.aura/plugins/@aura
cp -R "$(pwd)" ~/.aura/plugins/@aura/hello-world
```

Then in the app: **Settings → Plugins → Rescan** (or restart). The
plugin appears in the list; enabling it spawns the worker, adds the
`/hello` slash command to the composer, a "Hello" rail tile, and a
"Hello" right-rail tab.

## Security model (what you get, and don't)

- The worker is a blob Worker: no DOM, no Tauri IPC. The panel is a
  null-origin iframe: no shell DOM/storage. `postMessage` envelopes to
  the host bridge are the only channel either has.
- Every `call` is ACL-checked against the `capabilities` array in
  `aura.plugin.json` — first in the renderer bridge, then re-derived
  and re-checked in Rust for `fs:read` / `net:fetch` / `storage:kv`
  before any OS access. A method you didn't declare returns
  `capability_denied`.
- `fs:read` scopes are repo-relative globs (`fs:read:src/**`) with a
  built-in denylist (`.git`, `.env*`, ssh keys). `net:fetch` scopes are
  per-host (`net:fetch:api.github.com`), https-only, with host
  credentials and cookies stripped.
- `mcp:call:<tool>` lets the worker invoke ONE named tool — and only on
  the MCP server bundled in this same plugin directory. Routing is
  host-decided (pluginId → its own `aura.mcp.json` id); a plugin cannot
  address other servers, and the host verifies the call envelope's
  `target` equals the tool actually invoked.

## Bundled MCP server (`aura.mcp.json`)

Any plugin bundle may ship an MCP server next to its plugin manifest:

```json
{
  "schema": "https://aura.dev/schemas/plugin@1",
  "id": "@aura/hello-world-mcp",
  "version": "0.1.0",
  "engines": { "aura": ">=0.17.0" },
  "command": "node",
  "args": ["mcp-server.js"],
  "env": { "HELLO_PREFIX": "Hello" },
  "capabilities": [],
  "tools": ["echo"]
}
```

- The server is unioned into the app's MCP system at read time — it is
  never copied into `~/.aura/mcp/`. Enable/disable in Settings → MCP
  servers (or Settings → Plugins); env/remove are managed by the bundle.
- `args` are resolved relative to the bundle directory (the host spawns
  the child with `cwd` = the install dir), so `mcp-server.js` needs no
  absolute path.
- `tools` is the allowlist the worker can target via `mcp:call:<tool>`.

### Secrets (`${secrets:key}`)

Real servers need API keys. Never put them in `env` literally — declare
them and reference them:

```json
// aura.plugin.json
"secrets": [
  { "id": "api_key", "title": "Example API key",
    "url": "https://example.com/settings/tokens" }
]

// aura.mcp.json
"env": { "EXAMPLE_API_KEY": "${secrets:api_key}" },
"capabilities": ["secrets:api_key"]
```

- Values live in the OS keychain (service `aura-plugin-secrets`,
  account `<bundle>/<key>`), entered via Settings → Plugins → the
  bundle's secrets editor. Write-only: the UI reports set/unset, never
  values.
- Interpolation happens only at child-spawn time, in memory — the value
  never touches disk or the renderer. A `${secrets:key}` reference
  without the matching `secrets:key` capability, or with no stored
  value, fails the spawn with an error naming the key.

## Protocol cheat-sheet

```
host → plugin   {v:1, kind:"handshake/hello", pluginId, hostVersion}
plugin → host   {v:1, kind:"handshake/ready", pluginId, sdkVersion}
plugin → host   {v:1, kind:"call", id, method:"ui.toast", target?, args}
host → plugin   {v:1, kind:"result", id, ok:true, value} | {ok:false, error}
host → plugin   {v:1, kind:"event", channel:"aura.ui.slash", payload}
subscribe       call method "host.event.subscribe" args {channel:"aura.ui"}
```

Method names are `family.verb`; the matching capability is
`family:verb[:scope]`. Channel subscriptions match by prefix —
`aura.ui` covers `aura.ui.slash`, `aura.ui.tile-click`,
`aura.ui.pill-click`.

For `mcp.call` the envelope `target` is the tool name and must equal
`args.tool` — see `onSlashMcp` in `worker.js`:

```js
const res = await call("mcp.call", { tool: "echo", args: { text } }, "echo");
// res = { text: "Hello, …!", raw: {...} }
```
