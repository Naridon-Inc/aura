//! Which cloud computer a sent task goes to.
//!
//! A box is handed a member's agent sign-in only for work the member sent to
//! that box (`dispatch_place_id`, settable by a person token only). So every
//! path that sends work "to the cloud" from the member's own machine names the
//! box: the desktop's send, `aura a2a-task create --dispatch`, the offer leg
//! of `aura loop cloud-sync`, and the MCP `aura_a2a_task_create`, which sends
//! to `auto` unless told otherwise.
//!
//! `auto` means the box that answered most recently: one that is online now,
//! else the one heard from last, so work sent while the box sleeps is waiting
//! for it when it wakes. An org with no box gets no dispatch, and the task
//! waits on the board, `submitted`, until its member sends it to one.
//!
//! The other half is [`pull_takes`]: which rows a machine's cloud-sync pull may
//! claim. A box takes only its own work, so a task sent nowhere is never run
//! on a box's own setup just because the box happened to look first.
//!
//! A box claims, and later reports, with its own machine credential naming a
//! member ([`claim_as`]): the one it acts for, or else the member who made the
//! task. With the person login saved on the box, the server could not tell a
//! box from that person's laptop, so it neither checked the claim nor recorded
//! the run against the box.

use serde_json::Value;

/// What the caller asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Send it nowhere in particular.
    Nowhere,
    /// The org's most recently live box.
    Auto,
    /// This place id.
    Place(String),
}

impl Target {
    /// `None` or `none` → nowhere, `auto` → pick, anything else must be a uuid.
    pub fn parse(raw: Option<&str>) -> Result<Target, String> {
        match raw.map(str::trim) {
            None | Some("") | Some("none") => Ok(Target::Nowhere),
            Some("auto") => Ok(Target::Auto),
            Some(id) if uuid::Uuid::parse_str(id).is_ok() => Ok(Target::Place(id.to_string())),
            Some(other) => Err(format!("--dispatch must be a place id, 'auto' or 'none', got '{other}'")),
        }
    }
}

/// The dispatch an MCP create asked for, taken out of its arguments.
///
/// An agent creating cloud work over MCP rarely knows a place id, and work it
/// leaves unsent sits on the board forever, so leaving `dispatch` out means
/// `auto`: the org's box when it has one, nowhere when it has none. A call
/// that already names `dispatch_place_id` keeps it as sent.
pub fn mcp_target(args: &mut serde_json::Map<String, Value>) -> Result<Target, String> {
    let asked = args.remove("dispatch");
    let named = args
        .get("dispatch_place_id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    if named {
        return Ok(Target::Nowhere);
    }
    match asked {
        None | Some(Value::Null) => Ok(Target::Auto),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Target::Auto),
        Some(Value::String(s)) => Target::parse(Some(&s)).map_err(|e| e.replacen("--dispatch", "dispatch", 1)),
        Some(other) => Err(format!("dispatch must be a place id, 'auto' or 'none', got {other}")),
    }
}

/// The place id to send to, asking the board for the org's boxes when `auto`.
pub fn resolve(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    target: &Target,
) -> Result<Option<String>, String> {
    match target {
        Target::Nowhere => Ok(None),
        Target::Place(id) => Ok(Some(id.clone())),
        Target::Auto => {
            let url = format!("{}/api/v2/runners", base.trim_end_matches('/'));
            let rows = crate::recall_get(client, &url, token)?;
            Ok(pick(rows.as_array().map(Vec::as_slice).unwrap_or(&[])))
        }
    }
}

/// Online boxes first, then the most recent heartbeat. Revoked rows never.
fn pick(rows: &[Value]) -> Option<String> {
    let mut boxes: Vec<(bool, &str, &str)> = rows
        .iter()
        .filter(|r| r.get("status").and_then(Value::as_str) != Some("revoked"))
        .filter_map(|r| {
            let id = r.get("id").and_then(Value::as_str)?;
            let online = r.get("online").and_then(Value::as_bool).unwrap_or(false);
            let seen = r.get("last_heartbeat_at").and_then(Value::as_str).unwrap_or("");
            Some((online, seen, id))
        })
        .collect();
    // RFC 3339 timestamps from one server sort as strings.
    boxes.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(a.1)));
    boxes.first().map(|(_, _, id)| id.to_string())
}

/// May this machine's cloud-sync pull claim `row` and run it?
///
/// `place` is this box's place id, or `None` on a laptop (no runner token).
/// `member` is who the box is acting for, when it is.
///
/// - A box takes a task a member sent to it, and, when nobody sent the task
///   anywhere, one it made itself. A task sent to another box is that box's;
///   a task sent nowhere waits for its member to send it.
/// - A box acting for one member does not take a task another member sent
///   it: that run needs the other member's sign-in. The member is compared
///   when it is named by id; a GitHub login is left to the server's check.
/// - A laptop is its member's own machine and keeps taking work sent nowhere,
///   but never a task a member sent to a box.
///
/// The server refuses a box's claim on the same terms; this keeps the box
/// from saving a local node for a task it was never going to be given.
pub fn pull_takes(row: &Value, place: Option<&str>, member: Option<&str>) -> bool {
    let field = |key: &str| row.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let theirs = || match member.filter(|m| uuid::Uuid::parse_str(m).is_ok()) {
        Some(m) => field("created_by_user_id").is_some_and(|by| by.eq_ignore_ascii_case(m)),
        None => true,
    };
    match (place, field("dispatch_place_id")) {
        (Some(here), Some(sent_to)) => sent_to.eq_ignore_ascii_case(here) && theirs(),
        (Some(here), None) => field("created_on_place_id").is_some_and(|made_on| made_on.eq_ignore_ascii_case(here)),
        (None, Some(_)) => false,
        (None, None) => true,
    }
}

/// Who a box's claim of `row` names: the member it acts for, or else the
/// member who made the task, with the box's `runner` token. `None` on a
/// laptop (no runner token), which claims with its own sign-in.
pub fn claim_as(runner: Option<&str>, acting: Option<&str>, row: &Value) -> Option<(String, String)> {
    let runner = runner?;
    let made_by = || {
        row.get("created_by_user_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let member = acting.or_else(made_by)?;
    Some((runner.to_string(), member.to_string()))
}

/// The tag a pulled node carries naming the member its claim named, so the
/// report of how it went is sent as the same box and member, and closes the
/// run the claim opened on the box.
pub const CLAIMED_FOR_TAG: &str = "cloud:for:";

/// The member a node's claim named, from its tags.
pub fn claimed_for(tags: &[String]) -> Option<&str> {
    tags.iter()
        .find_map(|t| t.strip_prefix(CLAIMED_FOR_TAG))
        .filter(|m| !m.is_empty())
}

/// A request the server turned away: the line to show, and its reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub text: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

impl Refused {
    fn said(status: reqwest::StatusCode, body: &str) -> Refused {
        let said: Option<Value> = serde_json::from_str(body).ok();
        let part = |k: &str| said.as_ref().and_then(|v| v.get(k)).and_then(Value::as_str).map(str::to_string);
        Refused { text: refusal_text(status, body), reason: part("reason"), detail: part("detail") }
    }

    fn unsent(text: String) -> Refused {
        Refused { text, reason: None, detail: None }
    }

    /// Why this work can never run on a cloud computer as things stand, when
    /// that is why it was refused: its member has no cloud access. Waiting a
    /// cycle changes nothing, so the box says so on the board instead of
    /// asking again every few seconds.
    pub fn never_runs_here(&self) -> Option<String> {
        (self.reason.as_deref() == Some("no_cloud_grant")).then(|| {
            let detail = self.detail.as_deref().unwrap_or("its member has no cloud access in this team");
            format!("not run on a cloud computer: {detail}")
        })
    }
}

/// Send `body` to `url`'s task as this box, acting for `member`, with the
/// box's own machine credential.
pub fn patch_as_place(
    client: &reqwest::blocking::Client,
    url: &str,
    runner: &str,
    member: &str,
    body: &Value,
) -> Result<(), Refused> {
    let resp = client
        .patch(url)
        .header("Authorization", format!("Bearer {runner}"))
        .header(crate::push_credential::ACTING_MEMBER_HEADER, member)
        .json(body)
        .send()
        .map_err(|e| Refused::unsent(format!("reaching the board: {e}")))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    Err(Refused::said(status, &resp.text().unwrap_or_default()))
}

/// Claim `url`'s task as this box, acting for `member`, so the server checks
/// the claim against where the member sent it and the member's cloud access,
/// and records the run against this box. A box's human login would claim it
/// as that person's laptop.
pub fn claim_as_place(
    client: &reqwest::blocking::Client,
    url: &str,
    runner: &str,
    member: &str,
) -> Result<(), Refused> {
    patch_as_place(client, url, runner, member, &serde_json::json!({ "status": "working" }))
}

/// How the board ended a task this machine pulled and has not finished, or
/// `None` while the board still has it open.
///
/// `row` is the board's row, or `None` when the board no longer has it. A
/// task cancelled on the board, finished by another computer, rejected, or
/// deleted is over here too: left as a ready node it was tried again every
/// cycle. Returns the status to take and the reason to record.
pub fn board_ended(row: Option<&Value>) -> Option<(String, String)> {
    let Some(row) = row else {
        return Some((aura_loop::STATE_CANCELED.to_string(), "no longer on the board, so not run here".to_string()));
    };
    let status = row.get("status").and_then(Value::as_str).map(str::trim)?;
    if !aura_loop::is_terminal(status) {
        return None;
    }
    let why = match status {
        aura_loop::STATE_CANCELED => "canceled on the board, so not run here",
        aura_loop::STATE_REJECTED => "rejected on the board, so not run here",
        _ => "finished on the board by another computer, so not run here",
    };
    Some((status.to_string(), why.to_string()))
}

/// When an `auto` send was refused because the sender has no cloud access,
/// the server's reason; the create is then made again unsent, so the work is
/// on the board rather than lost. A send that named a computer keeps its
/// refusal: the member asked for that computer.
pub fn auto_lacks_access(target: &Target, status: u16, body: &str) -> Option<String> {
    if *target != Target::Auto || status != 403 {
        return None;
    }
    let said: Value = serde_json::from_str(body).ok()?;
    if said.get("reason").and_then(Value::as_str) != Some("no_cloud_grant") {
        return None;
    }
    Some(
        said.get("detail")
            .and_then(Value::as_str)
            .unwrap_or("you have no cloud access in this team")
            .to_string(),
    )
}

/// A refused request as one line: the status, and the server's reason when
/// it gave one.
fn refusal_text(status: reqwest::StatusCode, body: &str) -> String {
    let said: Option<Value> = serde_json::from_str(body).ok();
    let part = |k: &str| said.as_ref().and_then(|v| v.get(k)).and_then(Value::as_str).map(str::to_string);
    match (part("detail"), part("reason")) {
        (Some(detail), Some(reason)) => format!("{status}: {detail} ({reason})"),
        _ => status.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_mcp_create_goes_to_the_box_unless_it_says_otherwise() {
        let args = |v: Value| v.as_object().cloned().expect("an object");
        assert_eq!(mcp_target(&mut args(json!({"input": "x"}))), Ok(Target::Auto));
        assert_eq!(mcp_target(&mut args(json!({"dispatch": ""}))), Ok(Target::Auto));
        let mut none = args(json!({"input": "x", "dispatch": "none"}));
        assert_eq!(mcp_target(&mut none), Ok(Target::Nowhere));
        assert!(!none.contains_key("dispatch"), "the server never sees the choice");
        assert_eq!(mcp_target(&mut args(json!({"dispatch": A}))), Ok(Target::Place(A.into())));
        assert_eq!(
            mcp_target(&mut args(json!({"dispatch_place_id": A}))),
            Ok(Target::Nowhere),
            "an explicit place id is kept as sent"
        );
        assert!(mcp_target(&mut args(json!({"dispatch": "somewhere"}))).is_err());
        assert!(mcp_target(&mut args(json!({"dispatch": 3}))).is_err());
    }

    #[test]
    fn a_box_pulls_only_its_own_work_and_a_laptop_never_a_boxs() {
        let sent_here = json!({"dispatch_place_id": A});
        let sent_there = json!({"dispatch_place_id": B});
        let made_here = json!({"dispatch_place_id": null, "created_on_place_id": A});
        let made_there = json!({"created_on_place_id": B});
        let made_here_sent_there = json!({"dispatch_place_id": B, "created_on_place_id": A});
        let sent_nowhere = json!({"dispatch_place_id": null, "created_on_place_id": null});

        assert!(pull_takes(&sent_here, Some(A), None));
        assert!(pull_takes(&made_here, Some(A), None));
        assert!(!pull_takes(&sent_there, Some(A), None));
        assert!(!pull_takes(&made_there, Some(A), None));
        assert!(!pull_takes(&made_here_sent_there, Some(A), None), "the member's dispatch wins");
        assert!(!pull_takes(&sent_nowhere, Some(A), None), "work sent nowhere waits for its member");
        assert!(!pull_takes(&json!({}), Some(A), None), "an older server that sends no dispatch fields");

        assert!(pull_takes(&sent_nowhere, None, None));
        assert!(pull_takes(&json!({}), None, None));
        assert!(!pull_takes(&sent_here, None, None), "a laptop never claims a task sent to a box");
        assert!(!pull_takes(&sent_there, None, None));
        assert!(
            pull_takes(&json!({"dispatch_place_id": A.to_uppercase()}), Some(A), None),
            "ids compare without case"
        );
    }

    #[test]
    fn a_box_acting_for_one_member_leaves_anothers_task() {
        let avas = json!({"dispatch_place_id": A, "created_by_user_id": AVA});
        assert!(pull_takes(&avas, Some(A), Some(AVA)));
        assert!(!pull_takes(&avas, Some(A), Some(BEN)), "Ben's box does not claim Ava's run");
        assert!(pull_takes(&avas, Some(A), Some("ben-gh")), "a login is left to the server");
        let made_here = json!({"created_on_place_id": A, "created_by_user_id": AVA});
        assert!(pull_takes(&made_here, Some(A), Some(BEN)), "what the box made runs on its own setup");
    }

    #[test]
    fn a_box_claims_as_itself_naming_the_member_and_a_laptop_as_its_person() {
        let row = json!({"created_by_user_id": AVA});
        assert_eq!(claim_as(None, None, &row), None, "a laptop claims with its own sign-in");
        assert_eq!(claim_as(None, Some(BEN), &row), None);
        assert_eq!(claim_as(Some("rt"), None, &row), Some(("rt".into(), AVA.into())), "the member who made it");
        assert_eq!(claim_as(Some("rt"), Some(BEN), &row), Some(("rt".into(), BEN.into())), "the member it acts for");
        assert_eq!(claim_as(Some("rt"), None, &json!({})), None);

        let tags = vec!["cloud:pushed".to_string(), format!("{CLAIMED_FOR_TAG}{AVA}")];
        assert_eq!(claimed_for(&tags), Some(AVA));
        assert_eq!(claimed_for(&["cloud:pushed".to_string()]), None);
    }

    #[test]
    fn work_whose_member_has_no_cloud_access_is_said_once_not_retried() {
        let no_grant = json!({"reason": "no_cloud_grant", "detail": "the member who made this task has no cloud access"});
        let refused = Refused::said(reqwest::StatusCode::FORBIDDEN, &no_grant.to_string());
        assert_eq!(
            refused.never_runs_here().as_deref(),
            Some("not run on a cloud computer: the member who made this task has no cloud access")
        );
        let elsewhere = json!({"reason": "sent_elsewhere", "detail": "sent to a different computer"});
        assert_eq!(Refused::said(reqwest::StatusCode::CONFLICT, &elsewhere.to_string()).never_runs_here(), None);
        assert_eq!(Refused::unsent("reaching the board: timed out".into()).never_runs_here(), None);
    }

    #[test]
    fn an_auto_send_without_cloud_access_lands_unsent_but_a_named_one_is_refused() {
        let body = json!({"reason": "no_cloud_grant", "detail": "you have no cloud access in this team"}).to_string();
        assert_eq!(
            auto_lacks_access(&Target::Auto, 403, &body).as_deref(),
            Some("you have no cloud access in this team")
        );
        assert_eq!(auto_lacks_access(&Target::Place(A.into()), 403, &body), None);
        assert_eq!(auto_lacks_access(&Target::Auto, 400, &body), None);
        let other = json!({"reason": "unknown_place"}).to_string();
        assert_eq!(auto_lacks_access(&Target::Auto, 403, &other), None);
        assert_eq!(auto_lacks_access(&Target::Auto, 403, "Forbidden"), None);
    }

    #[test]
    fn a_task_the_board_ended_stops_here_and_an_open_one_does_not() {
        let ended = |row: Value| board_ended(Some(&row)).map(|(status, _)| status);
        assert_eq!(ended(json!({"status": "canceled"})).as_deref(), Some("canceled"));
        assert_eq!(ended(json!({"status": "rejected"})).as_deref(), Some("rejected"));
        assert_eq!(ended(json!({"status": "completed"})).as_deref(), Some("completed"));
        assert_eq!(ended(json!({"status": "failed"})).as_deref(), Some("failed"));
        assert_eq!(ended(json!({"status": "working"})), None, "still this box's to run");
        assert_eq!(ended(json!({"status": "submitted"})), None);
        assert_eq!(ended(json!({})), None, "a row that says nothing changes nothing");
        assert_eq!(
            board_ended(None),
            Some(("canceled".to_string(), "no longer on the board, so not run here".to_string()))
        );
        assert_eq!(
            board_ended(Some(&json!({"status": "canceled"}))).map(|(_, why)| why).as_deref(),
            Some("canceled on the board, so not run here")
        );
    }

    #[test]
    fn a_refused_claim_says_why() {
        let said = json!({"reason": "another_members", "detail": "sent here by a different member"});
        assert_eq!(
            refusal_text(reqwest::StatusCode::CONFLICT, &said.to_string()),
            "409 Conflict: sent here by a different member (another_members)"
        );
        assert_eq!(refusal_text(reqwest::StatusCode::CONFLICT, ""), "409 Conflict");
    }

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const AVA: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const BEN: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn a_dispatch_is_a_place_auto_or_nothing() {
        assert_eq!(Target::parse(None), Ok(Target::Nowhere));
        assert_eq!(Target::parse(Some("none")), Ok(Target::Nowhere));
        assert_eq!(Target::parse(Some(" auto ")), Ok(Target::Auto));
        assert_eq!(Target::parse(Some(A)), Ok(Target::Place(A.into())));
        assert!(Target::parse(Some("crew-box")).is_err());
    }

    #[test]
    fn auto_sends_to_the_box_that_answered_last() {
        let online_old = json!({"id": A, "online": true, "last_heartbeat_at": "2026-11-10T08:00:00Z"});
        let offline_new = json!({"id": B, "online": false, "last_heartbeat_at": "2026-11-10T09:00:00Z"});
        assert_eq!(pick(&[offline_new.clone(), online_old]), Some(A.into()), "online wins");

        let offline_old = json!({"id": A, "online": false, "last_heartbeat_at": "2026-11-09T08:00:00Z"});
        assert_eq!(pick(&[offline_old, offline_new]), Some(B.into()), "then the latest heartbeat");

        let revoked = json!({"id": A, "online": true, "status": "revoked"});
        assert_eq!(pick(&[revoked]), None);
        assert_eq!(pick(&[]), None);
    }
}
