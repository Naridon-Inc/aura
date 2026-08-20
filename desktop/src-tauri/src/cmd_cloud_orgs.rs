//! Picking which org you are acting as, and everything that follows from it.
//!
//! Three commands, and they are deliberately the same three questions the
//! account menu asks in order: what can I be, make me that, and what do I have
//! now that I am. The domain — what an org is, which one is recorded, how it
//! travels on the wire — lives next door in [`crate::cloud_org`]; this file is
//! the one place that talks to the server about it.
//!
//! ## One endpoint, because only one of them can answer
//!
//! `GET /api/v2/repos` (`orgs::list_user_repos`) walks every repo the caller
//! can see across every org they belong to and tags each row with `org_id`,
//! `org_slug` and `org_name`. Every other org route is `/orgs/{slug}/…`, which
//! can only tell you about an org you have already named — and the name is the
//! question. So the list of orgs is derived from the list of repos, which has
//! the pleasant side effect that the count beside each org is real rather than
//! a second call.
//!
//! ## Switching writes the choice down, then re-files the machine book
//!
//! Nothing here is a session: the choice lands in `~/.aura/credentials.json`
//! and outlives the process, so the app comes back up as whoever you last were.
//! And while we have a cross-org repo list in hand — the only moment we ever do
//! — the machine book is filed under the orgs its boxes belong to, which is
//! what lets the fleet page's places follow the switch rather than only its
//! projects.

use std::collections::HashMap;
use std::time::Duration;

// No `OrgScoped` here on purpose — this is the one module whose whole job is to
// read *across* orgs, so the one request it makes deliberately goes unstamped.
use crate::cloud_org::{active_org, orgs_from_repos, CloudOrg, CloudRepo};
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// Reads only, and every one of them is a page load somebody is waiting on.
const CLOUD_TIMEOUT: Duration = Duration::from_secs(10);

/// Every org this account can act as, with the repos it holds.
///
/// Errors — rather than answering with an empty list — when signed out or when
/// the cloud can't be reached. "You belong to no orgs" is impossible (every
/// signup owns one), so an empty list could only ever mean "we couldn't ask",
/// and a switcher that renders that as a bare empty menu is a switcher that
/// tells the user their teams are gone.
///
/// Self-healing on the way past: a credentials file written by the pairing
/// exchange carries a slug and no id, and the id is what runner rows are
/// matched on. Whatever we resolve here is written back, so the next read has
/// both and the guess in `orgs_from_repos` happens exactly once per install.
#[tauri::command]
pub async fn cloud_orgs() -> Result<Vec<CloudOrg>, String> {
    let repos = fetch_repos().await?;
    let creds = read_credentials()?;
    let orgs = orgs_from_repos(&repos, &active_org(&creds));
    settle(&orgs, &repos, &creds);
    Ok(orgs)
}

/// Act as `slug` from now on.
///
/// Returns the refreshed list with the tick moved, so the menu that called this
/// redraws off the answer rather than asking again — and so a caller can tell a
/// switch that landed from one that silently didn't.
///
/// A slug that isn't one of yours is refused. Writing it anyway would leave the
/// app sending an org header the server will reject on every subsequent call,
/// with nothing on screen to explain why everything stopped working.
#[tauri::command]
pub async fn cloud_org_switch(slug: String) -> Result<Vec<CloudOrg>, String> {
    let slug = slug.trim().to_string();
    if slug.is_empty() {
        return Err("Pick an org to switch to.".into());
    }
    let repos = fetch_repos().await?;
    let creds = read_credentials()?;
    let mut orgs = orgs_from_repos(&repos, &active_org(&creds));
    let Some(want) = orgs.iter().find(|o| o.slug == slug).cloned() else {
        return Err(format!(
            "{slug} isn't one of your orgs — you may have been removed from it."
        ));
    };
    crate::cloud_org::remember_org(&want)?;
    for org in orgs.iter_mut() {
        org.current = org.slug == want.slug;
    }
    // The book's boxes are filed by org here rather than on the next list, so
    // the places on screen have already moved by the time this returns.
    crate::cmd_machines::file_machines_by_org(&repo_orgs(&repos));
    Ok(orgs)
}

/// The projects the org you are acting as can see.
///
/// The same rows `cloud_orgs` counts, narrowed to the one you picked — which is
/// the whole point of picking. Repos in your *other* orgs are not filtered out
/// as noise; they belong to a different hat and are one switch away.
#[tauri::command]
pub async fn cloud_repos() -> Result<Vec<CloudRepo>, String> {
    let repos = fetch_repos().await?;
    let creds = read_credentials()?;
    let orgs = orgs_from_repos(&repos, &active_org(&creds));
    let Some(current) = orgs.into_iter().find(|o| o.current) else {
        return Ok(repos);
    };
    Ok(repos
        .into_iter()
        .filter(|r| r.org_slug == current.slug)
        .collect())
}

/// Every repo this account can see, each tagged with the org that holds it.
///
/// The one cross-org read there is, offered to the rest of the app under a name
/// that says what it answers rather than which endpoint it happens to call.
/// [`crate::manager::brain::place_projects`] is the second reader: an org place
/// narrows the projects it found on its disk against these rows, and doing it
/// off a second, org-scoped call would only ever return the org you already
/// named — leaving "belongs to mhask" indistinguishable from "belongs to nobody".
pub(crate) async fn visible_repos() -> Result<Vec<CloudRepo>, String> {
    fetch_repos().await
}

/// `GET /api/v2/repos`, parsed into rows we can group.
///
/// The server answers `{"repos": [...]}` on success and `{"error": "..."}` with
/// a 200 on a database fault, so a bare parse would read a failure as "you have
/// no repos" — which the caller would then render as "you have no orgs".
async fn fetch_repos() -> Result<Vec<CloudRepo>, String> {
    let creds = read_credentials()?;
    let token = cloud_token(&creds)
        .ok_or_else(|| "Sign in to Aura Cloud to choose which org you're working in.".to_string())?;
    let origin = cloud_origin(&creds);
    let url = format!("{origin}/api/v2/repos");

    let client = reqwest::Client::builder()
        .timeout(CLOUD_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    // Deliberately NOT `.org_scoped()`. This is the one read whose whole value
    // is that it crosses orgs, and the day the server starts honouring the
    // header is the day a scoped call here would answer with only the org you
    // are already in — leaving the switcher a list of one and no way out of it.
    // Every other aura-cloud call in the app carries the header; this one is
    // the question, not an answer under it.
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("Aura Cloud said HTTP {status}: {body}"));
    }
    parse_repos(&body)
}

/// Read the rows out of the endpoint's envelope.
///
/// Kept apart from the request so the shape — including the 200-with-an-error
/// case — is pinned by tests rather than by a live server.
fn parse_repos(body: &str) -> Result<Vec<CloudRepo>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("parse /repos: {e}"))?;
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(format!("Aura Cloud couldn't list your projects: {err}"));
    }
    let rows = parsed
        .get("repos")
        .and_then(|v| v.as_array())
        .or_else(|| parsed.as_array())
        .ok_or_else(|| "Aura Cloud sent a project list this build can't read.".to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let s = |k: &str| {
                row.get(k)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
            };
            Some(CloudRepo {
                id: s("id")?,
                full_name: s("full_name").unwrap_or_default(),
                org_id: s("org_id").unwrap_or_default(),
                org_slug: s("org_slug")?,
                org_name: s("org_name").unwrap_or_default(),
            })
        })
        .collect())
}

/// `owner/name` → the slug of the org that holds it.
fn repo_orgs(repos: &[CloudRepo]) -> HashMap<String, String> {
    repos
        .iter()
        .filter(|r| !r.full_name.is_empty() && !r.org_slug.is_empty())
        .map(|r| (r.full_name.clone(), r.org_slug.clone()))
        .collect()
}

/// Write down what we just learned, quietly.
///
/// Two backfills, both best-effort: the credentials file gains the id (and
/// name) behind a slug it only half knew, and the machine book gains the org
/// each box's project belongs to. Neither is worth failing a read over — the
/// list in the user's hand is correct either way, and the next read tries
/// again.
fn settle(orgs: &[CloudOrg], repos: &[CloudRepo], creds: &serde_json::Map<String, serde_json::Value>) {
    let active = active_org(creds);
    if let Some(current) = orgs.iter().find(|o| o.current) {
        let known = active.slug.as_deref() == Some(current.slug.as_str())
            && active.id.as_deref() == Some(current.id.as_str())
            && active.name.as_deref() == Some(current.name.as_str());
        if !known && !current.id.is_empty() {
            let _ = crate::cloud_org::remember_org(current);
        }
    }
    crate::cmd_machines::file_machines_by_org(&repo_orgs(repos));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint's real shape, trimmed. Two orgs, one of them holding two
    /// repos — the case the whole switcher exists for.
    const BODY: &str = r#"{"repos":[
      {"id":"r1","full_name":"Naridon-Inc/aura","default_branch":"main",
       "org_id":"o1","org_slug":"naridon","org_name":"Naridon",
       "session_count":3,"review_count":1,"last_activity_at":"2026-08-01T18:41:28Z"},
      {"id":"r2","full_name":"Naridon-Inc/aura-web","default_branch":"main",
       "org_id":"o1","org_slug":"naridon","org_name":"Naridon",
       "session_count":0,"review_count":0,"last_activity_at":"2026-07-30T10:00:00Z"},
      {"id":"r3","full_name":"mhask/notes","default_branch":"master",
       "org_id":"o2","org_slug":"mhask","org_name":"mhask team",
       "session_count":1,"review_count":0,"last_activity_at":"2026-07-29T09:00:00Z"}
    ]}"#;

    #[test]
    fn the_endpoints_rows_parse_with_their_extra_fields_ignored() {
        let repos = parse_repos(BODY).expect("the /repos shape");
        assert_eq!(repos.len(), 3);
        assert_eq!(repos[0].org_slug, "naridon");
        assert_eq!(repos[2].full_name, "mhask/notes");
    }

    #[test]
    fn two_orgs_come_out_of_one_cross_org_read() {
        let repos = parse_repos(BODY).unwrap();
        let orgs = orgs_from_repos(&repos, &crate::cloud_org::ActiveOrg::default());
        assert_eq!(orgs.len(), 2);
        assert_eq!(
            orgs.iter().find(|o| o.slug == "naridon").unwrap().repo_count,
            2
        );
    }

    #[test]
    fn a_two_hundred_carrying_an_error_is_a_failure_not_an_empty_account() {
        // The server returns `{"error": …}` with a 200 on a database fault. Read
        // as rows that would be "you have no orgs", which is never true — every
        // signup owns one — and would render as the user's teams vanishing.
        let e = parse_repos(r#"{"error":"Database not configured"}"#).unwrap_err();
        assert!(e.contains("Database not configured"), "{e}");
    }

    #[test]
    fn a_body_that_isnt_a_project_list_says_so_rather_than_reading_as_empty() {
        let e = parse_repos(r#"{"something":"else"}"#).unwrap_err();
        assert!(e.contains("can't read"), "{e}");
    }

    #[test]
    fn a_bare_array_is_accepted_too() {
        // The dashboard routes are not uniform about the envelope, and a list
        // that arrives unwrapped is still a list.
        let repos =
            parse_repos(r#"[{"id":"r1","full_name":"a/b","org_id":"o","org_slug":"s"}]"#).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].org_name, "");
    }

    #[test]
    fn a_row_with_no_org_is_dropped_rather_than_grouped_under_a_blank() {
        let repos = parse_repos(r#"{"repos":[{"id":"r1","full_name":"a/b"}]}"#).unwrap();
        assert!(repos.is_empty(), "a repo with no org cannot be filed");
    }

    #[test]
    fn the_machine_book_is_filed_by_repo_name_not_by_id() {
        // Ids are server-side; the only handle a local checkout has on a cloud
        // repo is the `owner/name` its git remote resolves to.
        let map = repo_orgs(&parse_repos(BODY).unwrap());
        assert_eq!(map.get("Naridon-Inc/aura").map(String::as_str), Some("naridon"));
        assert_eq!(map.get("mhask/notes").map(String::as_str), Some("mhask"));
    }
}
