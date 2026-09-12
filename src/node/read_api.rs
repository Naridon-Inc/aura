//! The node's read API — what it holds, answered to whoever can prove they may
//! ask.
//!
//! `smart_http.rs` is about being git: every route there exists to hand a
//! request to `git http-backend` or to keep the ref-log honest around a push.
//! These routes are a different job — they answer questions *about* the node
//! rather than serving objects from it — so they live in their own file and are
//! merged into the same router.
//!
//! They are mounted under `/.aura/node/…`. A leading dot cannot appear in a
//! repo id ([`NodeStore::is_valid_id`] permits only ascii alphanumerics, `-`
//! and `_`), so this prefix can never collide with a hosted repository's path.
//! That is a structural guarantee rather than a bet on nobody naming a repo
//! `api`.
//!
//! **Every route here requires a token, always.** `/healthz` answers "ok" to
//! anyone because a liveness probe reveals nothing; a list of the repositories
//! a node holds, of who pushed what and when, or of the tokens its operator
//! issued, reveals a great deal. The gate is deliberately independent of the
//! node's git-auth policy: `--public-read` opens *clones* to the world, which
//! is a considered decision about published code, and must not silently also
//! open an inventory of everything else the node has. `--require-auth` being
//! off likewise only means the operator is on loopback and does not want to
//! juggle tokens for `git push`; it is not consent to publish the node's
//! contents. So these routes ask for the same signed capability token in every
//! configuration.
//!
//! The token must be **node-wide** (`*` scope) with `read`. A token scoped to
//! one repo authorizes that repo, and enumerating every other repo on the box
//! is not something a single-repo grant should buy.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};

use super::{auth, report, tokens, NodeStore};

/// Default and maximum page sizes for the ref-log route. A node's log is
/// append-only and unbounded, so an unpaginated read would eventually be a
/// request that never finishes.
const REFLOG_PAGE_DEFAULT: usize = 100;
const REFLOG_PAGE_MAX: usize = 1000;

pub fn routes() -> Router<Arc<NodeStore>> {
    Router::new()
        .route("/.aura/node/summary", get(summary))
        .route("/.aura/node/repos", get(repos))
        .route("/.aura/node/reflog", get(reflog))
        .route("/.aura/node/tokens", get(token_list))
}

/// What the node is, in one object: enough for a console to render a header
/// without four round-trips.
#[derive(Debug, Serialize)]
struct Summary {
    node_id: String,
    key_id: String,
    name: String,
    version: String,
    url: Option<String>,
    repos: usize,
    reflog_entries: usize,
    tokens: usize,
}

async fn summary(State(store): State<Arc<NodeStore>>, headers: HeaderMap) -> Response {
    if let Err(resp) = authorize_node_read(&store, &headers) {
        return resp;
    }
    let state = match report::load_state(store.root()) {
        Ok(s) => s,
        Err(e) => return server_error(&e),
    };
    let vkey = match store.node_verifying_key() {
        Ok(k) => k,
        Err(e) => return server_error(&e),
    };
    let logs = report::read_reflogs(&store);
    let entries: usize = logs.values().map(Vec::len).sum();
    let token_count = match tokens::load(store.root()) {
        Ok(l) => l.tokens.len(),
        Err(e) => return server_error(&e),
    };

    Json(Summary {
        node_id: report::node_id(&vkey),
        key_id: vkey.key_id(),
        // The same fallback the report uses, so the console and the cloud never
        // disagree about what this node is called.
        name: state.name.clone().unwrap_or_else(|| "aura-node".to_string()),
        version: env!("CARGO_PKG_VERSION").to_string(),
        url: state.url.clone(),
        repos: logs.len(),
        reflog_entries: entries,
        tokens: token_count,
    })
    .into_response()
}

#[derive(Debug, Serialize)]
struct ReposBody {
    repos: Vec<report::RepoRow>,
}

async fn repos(State(store): State<Arc<NodeStore>>, headers: HeaderMap) -> Response {
    if let Err(resp) = authorize_node_read(&store, &headers) {
        return resp;
    }
    let logs = report::read_reflogs(&store);
    Json(ReposBody {
        repos: report::gather_repos(&store, &logs),
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
struct ReflogQuery {
    /// Restrict to one repo id.
    repo: Option<String>,
    /// Page size.
    limit: Option<usize>,
    /// Skip this many of the newest entries — the cursor for "next page".
    offset: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ReflogBody {
    entries: Vec<report::ReflogRow>,
    /// Total matching entries, so a caller knows whether another page exists.
    total: usize,
    limit: usize,
    offset: usize,
}

async fn reflog(
    State(store): State<Arc<NodeStore>>,
    headers: HeaderMap,
    Query(q): Query<ReflogQuery>,
) -> Response {
    if let Err(resp) = authorize_node_read(&store, &headers) {
        return resp;
    }
    if let Some(repo) = &q.repo {
        if !NodeStore::is_valid_id(repo) {
            return (StatusCode::BAD_REQUEST, "invalid repo id").into_response();
        }
    }
    let logs = report::read_reflogs(&store);
    // No high-water filtering here: the read route is a view of the whole log,
    // not the incremental feed the cloud report is.
    let mut rows = report::gather_reflog(&logs, &Default::default(), usize::MAX);
    if let Some(repo) = &q.repo {
        rows.retain(|r| &r.repo == repo);
    }
    // Newest first, which is the order a log is read in.
    rows.reverse();

    let total = rows.len();
    let limit = q.limit.unwrap_or(REFLOG_PAGE_DEFAULT).clamp(1, REFLOG_PAGE_MAX);
    let offset = q.offset.unwrap_or(0);
    let entries = rows.into_iter().skip(offset).take(limit).collect();

    Json(ReflogBody {
        entries,
        total,
        limit,
        offset,
    })
    .into_response()
}

#[derive(Debug, Serialize)]
struct TokensBody {
    tokens: Vec<report::TokenRow>,
}

async fn token_list(State(store): State<Arc<NodeStore>>, headers: HeaderMap) -> Response {
    if let Err(resp) = authorize_node_read(&store, &headers) {
        return resp;
    }
    // Metadata only — see `super::tokens`. There is nothing here to redact
    // because there is nothing replayable stored in the first place.
    match report::gather_tokens(store.root()) {
        Ok(tokens) => Json(TokensBody { tokens }).into_response(),
        Err(e) => server_error(&e),
    }
}

/// The gate every route above shares: a valid, unexpired, unrevoked capability
/// token signed by this node's key, scoped to the whole node, granting `read`.
///
/// `Err(resp)` is the response to return instead of the data. A missing or
/// unverifiable token is a 401 so a caller knows to present one; a valid token
/// that is merely too narrow, or that has been revoked, is a 403 — re-prompting
/// would not change the answer.
fn authorize_node_read(store: &NodeStore, headers: &HeaderMap) -> Result<(), Response> {
    let vkey = store
        .node_verifying_key()
        .map_err(|e| server_error(&format!("node key: {e}")))?;

    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(auth::token_from_authorization);
    let Some(token) = presented else {
        return Err(challenge("authentication required"));
    };
    // The error from token parsing is about the token's shape, never its bytes,
    // so it is safe to hand back to the caller.
    let claims = auth::CapabilityToken::parse_and_verify(&token, &vkey)
        .map_err(|e| challenge(&format!("invalid token: {e}")))?;

    let now = chrono::Utc::now().timestamp();
    if claims.is_expired(now) {
        return Err(challenge("token has expired"));
    }
    if claims.repo_id != auth::SCOPE_ALL || !claims.has_cap(auth::CAP_READ) {
        return Err(forbidden(
            "this route needs a node-wide read token — mint one with \
             `aura node token --all-repos --read`",
        ));
    }
    let token_id = tokens::token_id(&token);
    if tokens::load(store.root())
        .map(|l| l.is_revoked(&token_id))
        .unwrap_or(false)
    {
        return Err(forbidden("this token has been revoked"));
    }
    // Reads count as use. Without this a token that only ever drives the
    // console would read as "never used" forever, and an operator deciding
    // which tokens are safe to revoke would be deciding on a lie.
    tokens::touch_used(store.root(), &token_id, now);
    Ok(())
}

/// A 401 that names `Bearer`. These are API routes rather than git's, so there
/// is no reason to ask a caller for HTTP Basic credentials here.
fn challenge(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            axum::http::header::WWW_AUTHENTICATE,
            "Bearer realm=\"aura-node\"",
        )],
        msg.to_string(),
    )
        .into_response()
}

fn forbidden(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, msg.to_string()).into_response()
}

fn server_error(msg: &str) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, msg.to_string()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::auth::{normalize_caps, CapabilityToken, SCOPE_ALL};
    use aura_attestation::SigningKey;
    use base64::Engine;

    fn store() -> (tempfile::TempDir, Arc<NodeStore>) {
        let dir = tempfile::tempdir().unwrap();
        let store = NodeStore::new(dir.path().to_path_buf()).unwrap();
        // Materialize the key so every helper below signs with the same one.
        let _ = store.node_signing_key().unwrap();
        (dir, Arc::new(store))
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        h
    }

    fn node_wide_read(store: &NodeStore) -> String {
        let key = store.node_signing_key().unwrap();
        CapabilityToken::new(SCOPE_ALL, normalize_caps(false, true), now(), 3_600)
            .issue(&key)
            .unwrap()
    }

    fn now() -> i64 {
        chrono::Utc::now().timestamp()
    }

    #[test]
    fn an_unauthenticated_caller_is_refused() {
        let (_dir, store) = store();
        let err = authorize_node_read(&store, &HeaderMap::new()).unwrap_err();
        assert_eq!(err.status(), StatusCode::UNAUTHORIZED);
        assert!(err.headers().contains_key(axum::http::header::WWW_AUTHENTICATE));
    }

    #[test]
    fn a_garbage_or_foreign_token_is_refused() {
        let (_dir, store) = store();
        assert_eq!(
            authorize_node_read(&store, &bearer("not-a-token"))
                .unwrap_err()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        // A perfectly well-formed token signed by somebody else's key.
        let attacker = SigningKey::generate();
        let wire = CapabilityToken::new(SCOPE_ALL, normalize_caps(false, true), now(), 3_600)
            .issue(&attacker)
            .unwrap();
        assert_eq!(
            authorize_node_read(&store, &bearer(&wire)).unwrap_err().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn a_repo_scoped_token_cannot_enumerate_the_node() {
        let (_dir, store) = store();
        let key = store.node_signing_key().unwrap();
        let wire = CapabilityToken::new("just-one-repo", normalize_caps(true, false), now(), 3_600)
            .issue(&key)
            .unwrap();
        let err = authorize_node_read(&store, &bearer(&wire)).unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn an_expired_token_is_refused() {
        let (_dir, store) = store();
        let key = store.node_signing_key().unwrap();
        // Issued an hour ago with a one-second life.
        let wire = CapabilityToken::new(SCOPE_ALL, normalize_caps(false, true), now() - 3_600, 1)
            .issue(&key)
            .unwrap();
        assert_eq!(
            authorize_node_read(&store, &bearer(&wire)).unwrap_err().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn a_revoked_token_is_refused_even_though_it_still_verifies() {
        let (dir, store) = store();
        let wire = node_wide_read(&store);
        let key = store.node_signing_key().unwrap();
        let claims = CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();
        tokens::record_issue(dir.path(), &wire, "console", &claims).unwrap();

        authorize_node_read(&store, &bearer(&wire)).expect("valid before revocation");
        tokens::revoke(dir.path(), &tokens::token_id(&wire)).unwrap();
        let err = authorize_node_read(&store, &bearer(&wire)).unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_node_wide_read_token_is_accepted_over_bearer_or_basic() {
        let (_dir, store) = store();
        let wire = node_wide_read(&store);
        authorize_node_read(&store, &bearer(&wire)).expect("bearer must be accepted");

        // git's own channel: Basic auth with the token as the password.
        let mut h = HeaderMap::new();
        let b64 = base64::engine::general_purpose::STANDARD
            .encode(format!("x-access-token:{wire}"));
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Basic {b64}").parse().unwrap(),
        );
        authorize_node_read(&store, &h).expect("basic must be accepted");
    }

    #[tokio::test]
    async fn every_route_refuses_an_unauthenticated_caller() {
        let (_dir, store) = store();
        // Each handler is checked directly, because the gate is only worth
        // anything if every route actually calls it.
        assert_eq!(
            summary(State(store.clone()), HeaderMap::new()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            repos(State(store.clone()), HeaderMap::new()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            reflog(
                State(store.clone()),
                HeaderMap::new(),
                Query(ReflogQuery {
                    repo: None,
                    limit: None,
                    offset: None,
                })
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            token_list(State(store.clone()), HeaderMap::new()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn an_authorized_caller_gets_the_node_summary() {
        let (_dir, store) = store();
        let headers = bearer(&node_wide_read(&store));
        let resp = summary(State(store.clone()), headers).await;
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
