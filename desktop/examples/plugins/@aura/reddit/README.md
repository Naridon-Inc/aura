# @aura/reddit

A full-surface **Commons mini-app**: browse Reddit without leaving Aura. It is
the reference implementation for an **unauthenticated public API** — the
counterpart to [`@aura/gemini`](../gemini/README.md), which demonstrates
host-side credential injection.

## Why this app exists

Not every useful mini-app needs a secret. Reddit's public listing endpoints
(`/r/<sub>/<sort>.json`) return JSON to anyone. This app shows the *minimum*
surface a mini-app needs to pull real, live content into Aura:

```
   sandbox (app.html)                host (Rust net proxy)
   ───────────────────              ──────────────────────
   net.fetch({ url:                 capability check: net:fetch:www.reddit.com ?
     www.reddit.com/r/…/hot.json,   forward request headers (incl. User-Agent)
     headers: [[user-agent, …]] })  server-side fetch (no CORS, no cookies)
                            ◀─────   response JSON (truncated past the body cap)
```

No `secrets`, no `netAuth`. The app simply calls `net.fetch` and the host
allows it **only** because `www.reddit.com` is covered by the
`net:fetch:www.reddit.com` capability. Any other host is denied in the bridge
and re-denied in Rust.

## The manifest, annotated

```jsonc
"capabilities": [
  "net:fetch:www.reddit.com", // may reach ONLY this host
  "storage:kv"                // may persist its last subreddit + favorites
],
"contributes": {
  "apps": [ { "id": "reader", "title": "Reddit", "entry": "app.html", "icon": "👽" } ]
}
```

Reddit asks API clients to send a descriptive `User-Agent`. The app sets one in
its `net.fetch` call; the host forwards request headers verbatim (minus the few
it manages — `host`, `connection`, `content-length`, `cookie`). Anonymous
requests can be rate-limited (HTTP 429) — the app surfaces that as a friendly
message rather than failing silently.

## Sandbox honesty

The mini-app iframe is `sandbox="allow-scripts"` with **no** `allow-popups` and
**no** `allow-same-origin`, so a post can't open a browser window. Clicking a
post **expands it inline** — selftext, image preview, and a copyable permalink —
which is the correct behavior for an opaque-origin sandbox. Remote images
(`i.redd.it`, preview CDNs) still load as plain `<img>` elements.

## Try it

1. Install/enable this bundle.
2. Open **Commons → Apps → Reddit**. It opens as a full editor tab.
3. Type a subreddit, pick a sort, and ⭐ the ones you read often — your last
   subreddit and favorites persist via `storage.kv`.

## Files

| File              | Role                                                        |
| ----------------- | ----------------------------------------------------------- |
| `aura.plugin.json`| manifest — capabilities, the `app` (no secrets, no netAuth) |
| `app.html`        | the sandboxed reader (UI + `net.fetch`/`storage.kv` calls)  |
| `worker.js`       | tiny activation worker (holds nothing; completes handshake) |
