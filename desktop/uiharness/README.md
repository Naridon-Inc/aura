# uiharness — headless UI driver for aura-shell

Drives the **real** aura-shell frontend (the Vite dev app at
`http://localhost:1420`) inside its **own** headless Chrome so an agent can
screenshot and click-test surfaces **without touching your physical mouse or
keyboard**. The Tauri desktop webview (WKWebView) can't be Playwright-driven and
native automation (osascript / System Events) steals your real cursor — this
sidesteps both by running a separate browser process that only sees its own
synthetic page events.

## How it works

- `shim.js` is injected (via `addInitScript`) **before** the app bundle loads and
  stands in for `window.__TAURI_INTERNALS__`. It answers `invoke(cmd, …)` from
  per-command handlers fed by `data.json` fixtures, plus a permissive `[]`
  default so the rest of the app boots. Unmocked commands are recorded on
  `window.__AURA_INVOKE_LOG__`.
  - **Critical:** the shim resolves on a *macrotask* (`setTimeout`), never the
    same microtask tick. Real Tauri IPC has latency; an instant-resolving mock
    turns any `while (running) { await invoke(…) }` poll loop into a tight
    synchronous microtask spin that pins the renderer (screenshots/evaluate hang
    with no error). The 1ms defer mimics the real bridge.
- `drive.mjs` launches system Chrome (`channel: "chrome"`, `headless: true`),
  seeds localStorage past onboarding (`aura.onboarding.complete=1`, opens the
  repo as `aura.lastWorkspace`, Build rail), runs scenarios, writes PNGs to
  `shots/`, and prints a console/page-error + unmocked-invoke report. It
  force-exits so a wedged browser can never leave a zombie node process.
- `data.json` holds the fixtures (symbols, content hits, intents, goals ledger,
  Crew `ready_view`). Scope is UI/flow only — real backend correctness (e.g. the
  git-grep symbol search) is verified separately at the shell.

## Run

```sh
cd aura-shell/uiharness
npm install            # one-time: pulls playwright-core (uses system Chrome, no download)
node drive.mjs all     # or: boot | palette | crew
```

Screenshots land in `shots/` (gitignored). Requires the Vite dev server running
(`cd aura-shell && npm run dev`).
