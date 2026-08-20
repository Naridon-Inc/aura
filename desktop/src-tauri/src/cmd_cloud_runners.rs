//! cmd_cloud_runners — "is my always-on machine actually there?", answered by
//! the only party that knows.
//!
//! Until now the desktop inferred runner liveness from LOCAL evidence: a
//! `runner:`-prefixed lease sitting in this checkout's loop graph, or a
//! `runner.env` on this disk (see `cmd_mission::host_facts`). That reads true
//! for a runner running on your own Mac and false for the case the feature is
//! actually for — a box in another datacenter. A remote runner that is up,
//! heartbeating and simply has nothing to do holds no lease and drops no file
//! here, so the app called it absent and the Connect wizard span until it timed
//! out on a machine that had been online the whole time.
//!
//! The cloud already tracks it properly: every `aura runner serve` heartbeats
//! into the runner registry, and `GET /api/v2/runners` returns each machine with
//! an `online` flag the server derives from the last beat. This module proxies
//! that read. Same pattern as `cmd_cloud_billing`: the token stays in
//! `~/.aura/credentials.json` and never reaches the renderer.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::cloud_org::{active_org, OrgScoped};
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// One machine on the user's runner board.
///
/// Mirrors the registry row rather than reshaping it, so a field the server
/// adds later arrives without a schema change here. Everything the server can
/// legitimately leave null is `Option` — a row exists from the moment a token
/// is minted, which is before the box has ever reported a version or a beat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudRunner {
    pub id: String,
    /// Which org registered it. The registry has always carried this; the
    /// desktop simply threw it away, which is why a board showed every org's
    /// machines at once with no way to say which was which.
    #[serde(default)]
    pub org_id: Option<String>,
    /// Friendly board name, e.g. `aura-runner`.
    pub name: String,
    /// Which agent CLIs this box can run (`["claude"]`, …).
    #[serde(default)]
    pub agent_kinds: Vec<String>,
    /// Aura version installed on the box. `None` until it first beats.
    pub version: Option<String>,
    /// `idle` | `busy` | `offline` — the server's word, shown in plain
    /// language by the UI, never raw.
    #[serde(default)]
    pub status: String,
    pub last_heartbeat_at: Option<String>,
    /// What it said it was doing on its last beat.
    pub current_task: Option<String>,
    /// The account that registered it, as a user id.
    ///
    /// The registry has always carried this and the desktop has always dropped
    /// it, which is why a board of shared machines could not say whose they
    /// were. An id is not a name — [`crate::place_roster`] resolves it against
    /// the org's member roster — but it is the only handle the registry holds,
    /// and an unresolved one still separates "you added this" from "somebody
    /// else did".
    #[serde(default)]
    pub created_by: Option<String>,
    /// When it was registered, as the server wrote it (RFC 3339). `None` on a
    /// row from a server that doesn't send it.
    #[serde(default)]
    pub created_at: Option<String>,
    /// The server's verdict on liveness, derived from beat recency. We take it
    /// as given rather than re-deriving a timeout the server owns.
    #[serde(default)]
    pub online: bool,
}

/// `GET /api/v2/runners` — every machine registered on the signed-in account.
///
/// Ordered the way the question is asked: live machines first, then the most
/// recently seen. Rows that have never heartbeated sort last — they're a
/// registration that never came up, and burying them keeps a board that has one
/// working box from looking like a graveyard.
///
/// Errors (signed out, cloud unreachable) surface as `Err` on purpose. An empty
/// list means "you have no machines", and a caller that can't tell that apart
/// from "we couldn't ask" will tell the user something false.
///
/// Narrowed to the org you are acting as, the same way the machine book is —
/// the two are the same board seen from two sides, and a runner belonging to a
/// client's org has no business on screen while you are working as yourself.
#[tauri::command]
pub async fn cloud_runners() -> Result<Vec<CloudRunner>, String> {
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "not signed in to Aura cloud".to_string())?;
    let origin = cloud_origin(&creds);
    let url = format!("{origin}/api/v2/runners");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    let mut runners: Vec<CloudRunner> =
        serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))?;
    runners = in_org(runners, active_org(&creds).id.as_deref());
    runners.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| b.last_heartbeat_at.cmp(&a.last_heartbeat_at))
    });
    Ok(runners)
}

/// Keep the rows that belong to the org we're acting as.
///
/// Matched on the org id rather than the slug because the id is what the
/// registry row carries; the slug never reaches this endpoint. Two rows are
/// kept regardless: one that names no org (an older server, a row written
/// before the column) and every row when we don't know which org we are in —
/// in both cases the honest answer is "we can't tell", and a board that hides
/// a machine it cannot classify is a board that loses machines.
fn in_org(runners: Vec<CloudRunner>, org_id: Option<&str>) -> Vec<CloudRunner> {
    let Some(org_id) = org_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return runners;
    };
    runners
        .into_iter()
        .filter(|r| {
            r.org_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_none_or(|o| o == org_id)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry row we actually get back, trimmed to one live + one that
    /// was registered and never started.
    const BODY: &str = r#"[
      {"id":"dead","org_id":"o","repo_id":null,"name":"aura-runner","agent_kinds":["claude"],
       "version":null,"status":"offline","last_heartbeat_at":null,"current_task":null,
       "created_by":"u","created_at":"2026-07-17T12:07:29Z","online":false},
      {"id":"live","org_id":"o","repo_id":null,"name":"aura-runner","agent_kinds":["claude"],
       "version":"0.19.26","status":"idle","last_heartbeat_at":"2026-08-01T18:41:28Z",
       "current_task":"drained 0 project(s)","created_by":"u",
       "created_at":"2026-07-17T18:04:27Z","online":true}
    ]"#;

    #[test]
    fn a_registry_row_parses_with_its_unknown_fields_ignored() {
        let rows: Vec<CloudRunner> = serde_json::from_str(BODY).expect("registry shape");
        assert_eq!(rows.len(), 2);
        let live = rows.iter().find(|r| r.online).expect("one is online");
        assert_eq!(live.version.as_deref(), Some("0.19.26"));
        assert_eq!(live.agent_kinds, vec!["claude"]);
        assert_eq!(live.current_task.as_deref(), Some("drained 0 project(s)"));
        // Who put it there. Thrown away until the roster needed to say whose a
        // machine is; the registry has sent it all along.
        assert_eq!(live.created_by.as_deref(), Some("u"));
    }

    /// A server that doesn't send it — and the row still stands. "We don't know
    /// who added this" is an answer the roster can print; a parse error would
    /// take the whole org half of the list down with it.
    #[test]
    fn a_row_with_no_author_still_parses() {
        let rows: Vec<CloudRunner> = serde_json::from_str(TWO_ORGS).expect("registry shape");
        assert!(rows.iter().all(|r| r.created_by.is_none()));
    }

    #[test]
    fn the_live_machine_sorts_above_one_that_never_checked_in() {
        // The sort is what stops four abandoned registrations from hiding the
        // one box that works.
        let mut rows: Vec<CloudRunner> = serde_json::from_str(BODY).expect("registry shape");
        rows.sort_by(|a, b| {
            b.online
                .cmp(&a.online)
                .then_with(|| b.last_heartbeat_at.cmp(&a.last_heartbeat_at))
        });
        assert_eq!(rows[0].id, "live");
        assert_eq!(rows[1].id, "dead");
    }

    /// Two orgs' boards, and only one of them is yours right now.
    const TWO_ORGS: &str = r#"[
      {"id":"mine","org_id":"o1","name":"aura-runner","agent_kinds":[],"version":null,
       "status":"idle","last_heartbeat_at":null,"current_task":null,"online":true},
      {"id":"theirs","org_id":"o2","name":"client-box","agent_kinds":[],"version":null,
       "status":"idle","last_heartbeat_at":null,"current_task":null,"online":true},
      {"id":"unfiled","name":"old-box","agent_kinds":[],"version":null,
       "status":"idle","last_heartbeat_at":null,"current_task":null,"online":true}
    ]"#;

    #[test]
    fn the_board_shows_the_org_you_are_acting_as() {
        let rows: Vec<CloudRunner> = serde_json::from_str(TWO_ORGS).unwrap();
        let kept = in_org(rows, Some("o1"));
        let ids: Vec<&str> = kept.iter().map(|r| r.id.as_str()).collect();
        // The other org's box is gone; a row that names no org stays, because
        // "we can't tell" must not read as "not yours".
        assert_eq!(ids, ["mine", "unfiled"]);
    }

    #[test]
    fn not_knowing_which_org_we_are_in_shows_the_whole_board() {
        let rows: Vec<CloudRunner> = serde_json::from_str(TWO_ORGS).unwrap();
        assert_eq!(in_org(rows.clone(), None).len(), 3);
        assert_eq!(in_org(rows, Some("  ")).len(), 3);
    }
}
