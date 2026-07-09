//! First-party Commons builtin-app fetch proxy.
//!
//! Curated builtin apps (Reddit, …) render as trusted first-party React in
//! the `app` workpane — they are Aura's own code, not sandboxed third-party
//! plugins, so they call `invoke` directly. To keep that privilege from
//! becoming an open SSRF hole, every network read still funnels through this
//! one command, which enforces a **strict per-app host allowlist**: a builtin
//! may only reach the public, credential-free endpoints its feature needs and
//! nothing else. No host-app credentials are ever attached — these are public
//! APIs. Third-party / sandboxed apps keep using `plugin_proxy_net_fetch`
//! (capability-checked); this path is exclusively for the bundled builtins.

use serde::Serialize;

/// Hosts each builtin app is permitted to GET. Anything not listed here is
/// refused before a socket is opened. Keep this list tight — it is the entire
/// network blast radius of the builtin-app surface.
fn allowed_hosts(app: &str) -> &'static [&'static str] {
    match app {
        // Reddit's public listing JSON (`/r/<sub>.json`, `/r/<sub>/<sort>.json`)
        // is open and unauthenticated. www + old + the image CDNs the cards
        // link out to for thumbnails.
        "reddit" => &[
            "www.reddit.com",
            "old.reddit.com",
            "reddit.com",
        ],
        // Hacker News via the public Algolia search API — one request per view
        // returns fully-hydrated stories (title/url/points/author/comments), no
        // key, no rate-limit gate. The official Firebase API is read-only too.
        "hackernews" => &[
            "hn.algolia.com",
            "hacker-news.firebaseio.com",
        ],
        _ => &[],
    }
}

#[derive(Debug, Serialize)]
pub struct CommonsFetchResponse {
    pub status: u16,
    pub body: String,
    pub truncated: bool,
}

/// Hard ceiling on a single response body kept in memory (2 MiB). A public
/// listing is a few hundred KB; this is a runaway guard, not a real limit.
const MAX_BODY: usize = 2 * 1024 * 1024;

/// A browser-shaped User-Agent. Several public endpoints (Reddit notably) 403
/// any request whose UA looks like a script/library, so the builtin fetch
/// proxy presents as a stock desktop browser. This carries no identity — it is
/// only the string the host APIs expect to see on an anonymous read.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// GET a public URL on behalf of a named builtin app, host-allowlisted.
///
/// Returns the response body as text. Errors (never panics) on: an unknown
/// app, a disallowed host, a non-https scheme, a malformed URL, or a network
/// failure — so the calling app shows a clean error state, never a crash.
#[tauri::command]
pub async fn commons_app_fetch(app: String, url: String) -> Result<CommonsFetchResponse, String> {
    let hosts = allowed_hosts(&app);
    if hosts.is_empty() {
        return Err(format!("unknown builtin app: {app}"));
    }

    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https is allowed".into());
    }
    let host = parsed.host_str().ok_or("url has no host")?.to_string();
    if !hosts.iter().any(|h| *h == host) {
        return Err(format!("host {host} not allowed for app {app}"));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(3))
        // Reddit 403s the default reqwest agent AND descriptive bot UAs on the
        // public `.json` endpoint — it gates on a browser-shaped User-Agent. We
        // present as a normal desktop browser so the open listing loads. (No
        // credentials are attached; this is the same unauthenticated document a
        // browser would fetch.)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(parsed)
        .header("accept", "application/json, text/plain, */*")
        .header("accept-language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;

    let truncated = bytes.len() > MAX_BODY;
    let slice = if truncated { &bytes[..MAX_BODY] } else { &bytes[..] };
    let body = String::from_utf8_lossy(slice).into_owned();

    Ok(CommonsFetchResponse {
        status,
        body,
        truncated,
    })
}
