//! Git smart-HTTP for the Aura node, bridged to `git http-backend`.
//!
//! Rather than reimplement ref advertisement and packfile negotiation, every
//! git request is handed to `git http-backend` — git's own CGI smart-HTTP
//! server — with the CGI environment it expects. That makes the wire behavior
//! byte-for-byte git's, so a stock `git clone` / `git fetch` / `git push`
//! against `http://<node>/<repo-id>` Just Works.
//!
//! We add exactly two things on top of raw http-backend: (1) strict repo-id
//! validation (the id is a path segment under the data root, so it must not be
//! able to escape via `..` or a separator), and (2) auto-init on push, so the
//! first `git push` to a fresh repo id creates its bare repo.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};

use super::{auth, mirror, tokens, NodeStore};

/// Verify the system git exposes `git-http-backend` before we advertise the
/// node as up. Checked once at startup so a misconfigured host fails loudly
/// instead of 500-ing every clone.
pub fn ensure_http_backend() -> Result<(), Box<dyn std::error::Error>> {
    let out = Command::new("git")
        .arg("--exec-path")
        .output()
        .map_err(|e| format!("git not found on PATH: {e}"))?;
    if !out.status.success() {
        return Err("`git --exec-path` failed — is git installed?".into());
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let candidate = std::path::Path::new(&dir).join("git-http-backend");
    if candidate.exists() {
        return Ok(());
    }
    Err(format!(
        "git-http-backend not found (looked in {dir}) — the node needs git's smart-HTTP backend, \
         which ships with a standard git install"
    )
    .into())
}

pub fn router(store: Arc<NodeStore>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        // The node's own read API — what it holds, for the operator and the
        // console. It lives under `/.aura/node/…`, a prefix no repo id can
        // reach, and carries its own always-on token gate; see `read_api`.
        .merge(super::read_api::routes())
        .route("/{*path}", any(git_cgi))
        .with_state(store)
}

/// Everything the blocking CGI invocation needs, extracted from the request so
/// the blocking work can move to a worker thread.
struct CgiRequest {
    method: String,
    path_info: String,
    query: String,
    content_type: Option<String>,
    /// The request's `Content-Encoding`, forwarded so `git http-backend` knows
    /// to inflate a compressed body. Git gzips an upload-pack request once it
    /// is large enough, which in practice means any repository with a real
    /// number of refs — so dropping this header breaks cloning exactly the
    /// repositories worth hosting.
    content_encoding: Option<String>,
    /// The client's `Git-Protocol` header. Without it every connection
    /// negotiates with protocol v0, so a clone advertises every ref on the
    /// server instead of only the ones it was asked about.
    git_protocol: Option<String>,
    body: Bytes,
}

async fn git_cgi(
    State(store): State<Arc<NodeStore>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = uri.path().trim_start_matches('/');
    if raw == "healthz" {
        return "ok".into_response();
    }

    // First path segment is the repo id (with or without a trailing `.git`);
    // the remainder is the git endpoint (info/refs, git-upload-pack, …).
    let (repo_seg, rest) = match raw.split_once('/') {
        Some((r, rest)) => (r, rest),
        None => (raw, ""),
    };
    let repo = repo_seg.strip_suffix(".git").unwrap_or(repo_seg);
    if !NodeStore::is_valid_id(repo) {
        return (StatusCode::BAD_REQUEST, "invalid repo id").into_response();
    }

    // Aura-native routes (not git smart-HTTP) are served here, before we hand
    // off to git http-backend. Today: the signed, tamper-evident ref-log.
    if let Some(sub) = rest.strip_prefix("aura/") {
        return aura_route(&store, repo, sub);
    }

    let query = uri.query().unwrap_or("").to_string();

    // Decide whether this is a push (receive-pack) request; if so, create the
    // repo on first use. Reads (upload-pack) of a missing repo 404 naturally.
    let is_receive = rest == "git-receive-pack"
        || (rest == "info/refs" && query.contains("service=git-receive-pack"));

    // Capability-token gate (P2b). Off by default (loopback dev flow); when the
    // operator ran with --require-auth, push always needs a `push` token and
    // read needs a `read` token unless --public-read. The Aura ref-log route
    // handled above is deliberately left open — it's meant to be publicly
    // verifiable. We check auth BEFORE auto-init so an unauthorized push can't
    // even create a repo.
    if store.require_auth() {
        let gated = is_receive || !store.public_read();
        if gated {
            let need = if is_receive { auth::CAP_PUSH } else { auth::CAP_READ };
            if let Err(resp) = authorize_request(&store, repo, need, &headers) {
                return resp;
            }
        }
    }

    // A mirror follows its upstream, so anything pushed here would be reset by
    // the next sync. Refusing is the only honest answer: a push that appears to
    // succeed and then vanishes costs someone their work and their afternoon.
    if is_receive {
        if let Some(path) = store.repo_path(repo) {
            if mirror::is_mirror(&path) {
                let upstream = mirror::read(&path)
                    .ok()
                    .flatten()
                    .map(|c| c.upstream)
                    .unwrap_or_else(|| "its upstream".to_string());
                return (
                    StatusCode::FORBIDDEN,
                    format!(
                        "{repo} is a mirror of {upstream} — it follows that repository, so a push \
                         here would be overwritten by the next sync. Push to {upstream} instead, \
                         or run `aura node mirror remove {repo}` to make this an ordinary repo."
                    ),
                )
                    .into_response();
            }
        }
    }

    if is_receive {
        if let Err(e) = store.open_or_init(repo) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
        }
    } else if !store.exists(repo) {
        return (StatusCode::NOT_FOUND, "no such repo").into_response();
    }

    // Snapshot refs before a push so the post-push diff records exactly what
    // moved into the signed ref-log. `wait_with_output` guarantees receive-pack
    // has fully committed before we take the "after" snapshot, so no TOCTOU.
    let before = if is_receive {
        store.snapshot_refs(repo).unwrap_or_default()
    } else {
        BTreeMap::new()
    };

    let header_str = |name: &str| -> Option<String> {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let content_type = header_str("content-type");
    let content_encoding = header_str("content-encoding");
    let git_protocol = header_str("git-protocol");

    let req = CgiRequest {
        method: method.as_str().to_string(),
        path_info: format!("/{repo}.git/{rest}"),
        query,
        content_type,
        content_encoding,
        git_protocol,
        body,
    };

    let repo_owned = repo.to_string();
    let store2 = store.clone();
    match tokio::task::spawn_blocking(move || run_http_backend(&store2, req)).await {
        Ok(Ok(resp)) => {
            // After a successful push, keep HEAD pointing at a real branch so
            // clones can check out (mirrors a real host's default-branch pick),
            // then record the refs that moved into the signed ref-log.
            if is_receive && resp.status().is_success() {
                let _ = store.fixup_head(&repo_owned);
                record_reflog(&store, &repo_owned, &before);
                // Bridged repo? Forward the accepted refs downstream
                // (GitHub et al) off the request path — the push already
                // succeeded and is ref-logged, so a slow or failing
                // downstream must never delay or fail this response. The
                // outcome lands on the bridge record either way.
                if let Some(path) = store.repo_path(&repo_owned) {
                    if super::bridge::is_bridge(&path) {
                        let store3 = store.clone();
                        let repo3 = repo_owned.clone();
                        tokio::task::spawn_blocking(move || {
                            super::bridge::forward_after_push(&store3, &repo3);
                        });
                    }
                }
            }
            resp
        }
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, format!("git http-backend: {e}"))
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("task join: {e}")).into_response(),
    }
}

/// Invoke `git http-backend` with the CGI environment and translate its CGI
/// output back into an HTTP response. Runs on a blocking worker; feeds the
/// request body on a separate thread so a large packfile push can't deadlock
/// against http-backend's stdout.
fn run_http_backend(store: &NodeStore, req: CgiRequest) -> Result<Response, String> {
    let mut cmd = Command::new("git");
    cmd.arg("http-backend")
        .env("GIT_PROJECT_ROOT", store.root())
        // Export every repo under the root without requiring a per-repo
        // `git-daemon-export-ok` marker — the node's data dir is dedicated.
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", &req.method)
        .env("PATH_INFO", &req.path_info)
        .env("QUERY_STRING", &req.query)
        .env("CONTENT_LENGTH", req.body.len().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ct) = &req.content_type {
        cmd.env("CONTENT_TYPE", ct);
    }
    // CGI passes request headers through as `HTTP_*`; http-backend reads this
    // one to decide whether to inflate stdin before parsing pkt-lines.
    if let Some(ce) = &req.content_encoding {
        cmd.env("HTTP_CONTENT_ENCODING", ce);
    }
    // http-backend reads the negotiated protocol version from `GIT_PROTOCOL`,
    // not from an `HTTP_`-prefixed name, so it is set explicitly.
    if let Some(gp) = &req.git_protocol {
        cmd.env("GIT_PROTOCOL", gp);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;

    // Feed stdin from a thread so we never block writing the request while
    // http-backend is blocked writing its response.
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let body = req.body.clone();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&body);
        // stdin dropped here → EOF to http-backend.
    });

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait: {e}"))?;
    let _ = writer.join();

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exited {}: {}",
            output.status.code().unwrap_or(-1),
            err.trim()
        ));
    }

    parse_cgi_response(output.stdout)
}

/// Split a CGI payload into its header block and body, then build an HTTP
/// response. CGI headers are CRLF-delimited and terminated by a blank line; we
/// also accept LF-only in case of an unusual backend build.
fn parse_cgi_response(out: Vec<u8>) -> Result<Response, String> {
    let (head, body) = match find_header_break(&out) {
        Some((split, body_start)) => (&out[..split], out[body_start..].to_vec()),
        // No header block at all — treat the whole thing as a 200 body.
        None => (&[][..], out.clone()),
    };

    let head_str = String::from_utf8_lossy(head);
    let mut status = StatusCode::OK;
    let mut builder = Response::builder();

    for line in head_str.split("\r\n").flat_map(|l| l.split('\n')) {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("Status") {
            // "Status: 404 Not Found" → 404
            if let Some(code) = value.split_whitespace().next() {
                if let Ok(n) = code.parse::<u16>() {
                    status = StatusCode::from_u16(n).unwrap_or(StatusCode::OK);
                }
            }
        } else {
            builder = builder.header(key, value);
        }
    }

    builder
        .status(status)
        .body(Body::from(body))
        .map_err(|e| format!("build response: {e}"))
}

/// Find the `\r\n\r\n` (or `\n\n`) that ends the CGI header block. Returns
/// `(header_end_index, body_start_index)`.
fn find_header_break(buf: &[u8]) -> Option<(usize, usize)> {
    if let Some(i) = find_subslice(buf, b"\r\n\r\n") {
        return Some((i, i + 4));
    }
    if let Some(i) = find_subslice(buf, b"\n\n") {
        return Some((i, i + 2));
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Enforce the capability-token policy for a git request. `Ok(())` lets the
/// request proceed; `Err(resp)` is the response to return instead. A missing or
/// invalid token → 401 with a Basic-auth challenge, which is how stock git
/// carries the token (it retries with the URL/credential-helper creds); a valid
/// token that simply lacks the needed scope → 403 (no point re-prompting).
fn authorize_request(
    store: &NodeStore,
    repo: &str,
    need_cap: &str,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let vkey = store.node_verifying_key().map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("node key: {e}")).into_response()
    })?;

    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(auth::token_from_authorization);

    let Some(token) = presented else {
        return Err(auth_challenge("authentication required"));
    };
    let tok = match auth::CapabilityToken::parse_and_verify(&token, &vkey) {
        Ok(t) => t,
        Err(e) => return Err(auth_challenge(&format!("invalid token: {e}"))),
    };
    // Refuse for the *specific* reason, so a caller can tell "your token ran
    // out" from "your token was never for this" from "your token cannot do
    // this". `authorizes()` collapses all three into one bool; a person staring
    // at a failed `git push` needs to know which. All three are 403, not a 401
    // re-prompt: the token verified, so re-presenting the same one would only
    // loop — a fresh token has to be minted (`aura node token`).
    //
    // A capability token is self-contained and verified offline, so the node has
    // no revocation list: "revoked" is enforced one step upstream, at mint time,
    // where `aura node token` reads only *live* cloud grants and bounds the
    // token's TTL by the grant's own expiry — so a revoked grant yields no new
    // token, and any token it already yielded lapses on its own.
    let now = chrono::Utc::now().timestamp();
    if tok.is_expired(now) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("token expired at {} (now {now})", tok.exp),
        )
            .into_response());
    }
    if tok.repo_id != auth::SCOPE_ALL && tok.repo_id != repo {
        return Err((
            StatusCode::FORBIDDEN,
            format!("token is scoped to repo '{}', not '{repo}'", tok.repo_id),
        )
            .into_response());
    }
    if !tok.has_cap(need_cap) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("token does not grant '{need_cap}' on repo '{repo}'"),
        )
            .into_response());
    }

    // A capability token is self-certifying, which is exactly what makes it
    // cheap to verify and impossible to withdraw by cryptography alone. The
    // node's token ledger is the withdrawal mechanism: an id the operator has
    // revoked is refused here even though the signature is still perfectly
    // good. A token the ledger has never heard of is honoured — see
    // `super::tokens` for why absence must not deny.
    let token_id = tokens::token_id(&token);
    if tokens::load(store.root())
        .map(|l| l.is_revoked(&token_id))
        .unwrap_or(false)
    {
        return Err((
            StatusCode::FORBIDDEN,
            "this token has been revoked".to_string(),
        )
            .into_response());
    }
    tokens::touch_used(store.root(), &token_id, now);
    Ok(())
}

/// A 401 that asks stock git for HTTP Basic credentials — the channel git uses
/// to carry the capability token.
fn auth_challenge(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            axum::http::header::WWW_AUTHENTICATE,
            "Basic realm=\"aura\", charset=\"UTF-8\"",
        )],
        msg.to_string(),
    )
        .into_response()
}

/// Handle an Aura-native route under `/<repo>/aura/…`. Currently serves the
/// signed ref-log as NDJSON so any client can fetch and verify it.
fn aura_route(store: &NodeStore, repo: &str, sub: &str) -> Response {
    match sub.trim_end_matches('/') {
        "reflog" => {
            if !store.exists(repo) {
                return (StatusCode::NOT_FOUND, "no such repo").into_response();
            }
            let Some(git_dir) = store.repo_path(repo) else {
                return (StatusCode::BAD_REQUEST, "invalid repo id").into_response();
            };
            let path = super::reflog::reflog_path(&git_dir);
            let ndjson = [(axum::http::header::CONTENT_TYPE, "application/x-ndjson")];
            match std::fs::read(&path) {
                Ok(bytes) => (ndjson, bytes).into_response(),
                // No pushes yet → an empty (but valid) log.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    (ndjson, Vec::<u8>::new()).into_response()
                }
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("read ref-log: {e}"),
                )
                    .into_response(),
            }
        }
        _ => (StatusCode::NOT_FOUND, "unknown aura route").into_response(),
    }
}

/// After a successful push, diff the before/after ref snapshots and append one
/// signed ref-log entry per change. Best-effort + logged: the push already
/// landed in git, so a ref-log failure must not fail the request, but it is
/// surfaced on stderr because a missing entry weakens the tamper-evidence.
fn record_reflog(store: &NodeStore, repo: &str, before: &BTreeMap<String, String>) {
    let after = match store.snapshot_refs(repo) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("aura node: ref-log snapshot failed for {repo}: {e}");
            return;
        }
    };
    let changes = NodeStore::diff_ref_snapshots(before, &after);
    if changes.is_empty() {
        return;
    }
    let key = match store.node_signing_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("aura node: ref-log skipped for {repo}: {e}");
            return;
        }
    };
    let Some(git_dir) = store.repo_path(repo) else {
        return;
    };
    let ts = chrono::Utc::now().timestamp();
    match super::reflog::append_changes(&git_dir, repo, &changes, ts, &key) {
        Ok(entries) => {
            for e in &entries {
                eprintln!(
                    "aura node: ref-log {repo} {} {}→{}",
                    e.reference,
                    short_oid(&e.old),
                    short_oid(&e.new),
                );
            }
        }
        Err(e) => eprintln!("aura node: ref-log append failed for {repo}: {e}"),
    }
}

fn short_oid(oid: &str) -> &str {
    if oid.len() >= 8 {
        &oid[..8]
    } else {
        oid
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_and_body() {
        let cgi = b"Status: 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope".to_vec();
        let resp = parse_cgi_response(cgi).unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "text/plain"
        );
    }

    #[test]
    fn defaults_to_200_without_status() {
        let cgi =
            b"Content-Type: application/x-git-upload-pack-advertisement\r\n\r\n\x00\x01".to_vec();
        let resp = parse_cgi_response(cgi).unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[test]
    fn header_break_prefers_crlf() {
        assert_eq!(find_header_break(b"A: b\r\n\r\nbody"), Some((4, 8)));
        assert_eq!(find_header_break(b"A: b\n\nbody"), Some((4, 6)));
        assert_eq!(find_header_break(b"no break here"), None);
    }

    // ─── Capability-token gate (P2b) ────────────────────────────────────────
    //
    // The node enforces `repo:push` (and `read`) offline against a signed
    // capability token. These drive `authorize_request` directly with a store
    // whose signing key we hold, so we can mint the exact token each case needs
    // and read the refusal it produces.

    use axum::http::header::AUTHORIZATION;

    /// A serving store with a real node key and auth required.
    fn gated_store() -> (tempfile::TempDir, NodeStore) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = NodeStore::new(dir.path().to_path_buf()).unwrap();
        store.load_key().unwrap();
        store.set_auth(true, false);
        (dir, store)
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        h
    }

    /// Mint a wire token signed by the store's own node key.
    fn mint(store: &NodeStore, repo: &str, caps: Vec<String>, ttl_secs: i64) -> String {
        let key = store.node_signing_key().unwrap();
        let now = chrono::Utc::now().timestamp();
        auth::CapabilityToken::new(repo, caps, now, ttl_secs)
            .issue(&key)
            .unwrap()
    }

    /// Run the gate and return (status, body-text) — Ok folds to 200/"".
    async fn gate(store: &NodeStore, repo: &str, cap: &str, headers: &HeaderMap) -> (StatusCode, String) {
        match authorize_request(store, repo, cap, headers) {
            Ok(()) => (StatusCode::OK, String::new()),
            Err(resp) => {
                let status = resp.status();
                let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                    .await
                    .unwrap();
                (status, String::from_utf8_lossy(&bytes).to_string())
            }
        }
    }

    #[tokio::test]
    async fn a_valid_push_token_passes_the_gate() {
        let (_d, store) = gated_store();
        let token = mint(&store, "repo-a", auth::normalize_caps(true, false), 3_600);
        let (status, _) = gate(&store, "repo-a", auth::CAP_PUSH, &bearer(&token)).await;
        assert_eq!(status, StatusCode::OK, "a valid push token was refused");
    }

    #[tokio::test]
    async fn a_missing_token_is_challenged() {
        let (_d, store) = gated_store();
        let (status, _) = gate(&store, "repo-a", auth::CAP_PUSH, &HeaderMap::new()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "a header-less push was not challenged");
    }

    #[tokio::test]
    async fn a_garbage_token_is_challenged_not_forbidden() {
        let (_d, store) = gated_store();
        // A well-formed-looking but unverifiable token is a 401 (re-prompt), not
        // a 403 — git should get a chance to supply a real credential.
        let (status, body) = gate(&store, "repo-a", auth::CAP_PUSH, &bearer("auracap1.abc.def")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("invalid token"), "the challenge did not say why: {body}");
    }

    #[tokio::test]
    async fn an_expired_token_says_so() {
        let (_d, store) = gated_store();
        // ttl of 1s, minted "now"; by the time authorize runs it is at/after exp
        // for a token whose exp we force into the past.
        let key = store.node_signing_key().unwrap();
        let now = chrono::Utc::now().timestamp();
        let token = auth::CapabilityToken::new("repo-a", auth::normalize_caps(true, false), now - 100, 10)
            .issue(&key)
            .unwrap();
        let (status, body) = gate(&store, "repo-a", auth::CAP_PUSH, &bearer(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("expired"), "an expired token was not named as expired: {body}");
    }

    #[tokio::test]
    async fn a_token_for_another_repo_says_so() {
        let (_d, store) = gated_store();
        let token = mint(&store, "repo-a", auth::normalize_caps(true, false), 3_600);
        let (status, body) = gate(&store, "repo-b", auth::CAP_PUSH, &bearer(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("scoped to repo 'repo-a'"), "wrong-repo refusal was unclear: {body}");
    }

    #[tokio::test]
    async fn a_read_token_cannot_push() {
        let (_d, store) = gated_store();
        // read-only token, asked for push.
        let token = mint(&store, "repo-a", auth::normalize_caps(false, true), 3_600);
        let (status, body) = gate(&store, "repo-a", auth::CAP_PUSH, &bearer(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("does not grant 'push'"), "missing-cap refusal was unclear: {body}");
        // …but the same token reads fine.
        let (status, _) = gate(&store, "repo-a", auth::CAP_READ, &bearer(&token)).await;
        assert_eq!(status, StatusCode::OK, "a read token could not read");
    }
}
