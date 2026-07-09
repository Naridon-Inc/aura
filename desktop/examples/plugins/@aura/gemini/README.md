# @aura/gemini

A full-surface **Commons mini-app**: chat with Google Gemini without leaving
Aura. It is the reference implementation for **host-side credential
injection** — the pattern that lets a sandboxed plugin call an authenticated
API while *never holding the credential itself*.

## Why this app exists

Mini-apps (a Gmail client, a Gemini chat, a Reddit reader) are useless if they
can't call a real, authenticated API. But handing an API key to sandboxed,
third-party plugin code is exactly what you must never do. Aura resolves this
with a host-side seam:

```
   sandbox (app.html)                host (Rust net proxy)
   ───────────────────              ──────────────────────
   net.fetch({ url: …,      ─────▶   capability check: net:fetch:<host> ?
              body })                resolve secret from OS keychain
                                     append  ?key=<secret>   (netAuth)
                            ◀─────   response (no secret in it)
```

The app calls `net.fetch` with **no key**. The manifest's `netAuth` binding
tells the host to attach the key as the `key` query param, resolving it from
the keychain. The key is never in the HTML, never in `storage.kv`, never
crosses the postMessage bridge.

## The manifest, annotated

```jsonc
"capabilities": [
  "net:fetch:generativelanguage.googleapis.com", // may reach ONLY this host
  "secrets:gemini_api_key",                       // may have this secret injected
  "storage:kv"                                     // may persist its own chat
],
"secrets": [
  { "id": "gemini_api_key", "title": "Google AI Studio API key",
    "url": "https://aistudio.google.com/app/apikey" }
],
"netAuth": [
  { "host": "generativelanguage.googleapis.com",
    "secret": "gemini_api_key",
    "inject": { "kind": "query", "name": "key", "template": "${secret}" } }
],
"contributes": {
  "apps": [ { "id": "chat", "title": "Gemini", "entry": "app.html", "icon": "✦" } ]
}
```

Every `netAuth` binding is validated **fail-closed at scan time**: the secret
must be declared in `secrets` *and* granted by a `secrets:<id>` capability,
and the host must be granted by a `net:fetch:<host>` capability. A plugin can
never ship a binding that smuggles a credential to a host or key the user
never approved.

## Try it

1. Get a key from <https://aistudio.google.com/app/apikey>.
2. Install/enable this bundle, then set the key in **Settings → Plugins →
   Gemini** (stored in the OS keychain as `@aura/gemini/gemini_api_key`).
3. Open **Commons → Apps → Gemini**. It opens as a full editor tab.

Without a key, the app shows a friendly prompt instead of failing silently —
`net.fetch` rejects because the host can't resolve the secret, and the key
never leaves the keychain regardless.

## Files

| File              | Role                                                        |
| ----------------- | ----------------------------------------------------------- |
| `aura.plugin.json`| manifest — capabilities, `secrets`, `netAuth`, the `app`    |
| `app.html`        | the sandboxed mini-app (UI + `net.fetch`/`storage.kv` calls)|
| `worker.js`       | tiny activation worker (holds nothing; just completes handshake) |
