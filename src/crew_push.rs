// Crew work, sent to the people who aren't at this laptop.
//
// The dependency graph under `.aura/a2a/` is the crew's real state: 99 nodes
// in this repo, 54 of them finished, each carrying the goal it delivered and
// the commit that delivered it. None of it has ever reached the console. The
// git-backed `aura crew sync` moves the graph between *checkouts* — peer to
// peer, over a branch — and that is the whole of it. A teammate who does not
// pull this branch, or who is looking at the web console rather than a clone,
// sees no crew work at all.
//
// The cloud half already exists on both ends. `a2a_tasks` is a real table
// with the same four rungs (`plan`/`wave`/`task`/`subtask`), the same
// lifecycle states, and a REST surface the CLI already speaks fluently in
// `aura a2a-task`. And the local node has carried a `remote_id` field —
// documented as *"Cloud A2A task id once mirrored"* — since it was written.
// Nothing ever set it. This is the writer that was missing, not a new idea.
//
// Mirroring, not moving: the local graph stays the source of truth and the
// runner keeps draining it exactly as before. What goes up is a shadow that
// the console can read, stamped back onto the node so a second run updates
// rather than duplicating.
//
// # Why a mirrored node is never left `submitted`
//
// Learned the hard way, on the first real run. `submitted` in the cloud store
// is not a description — it is a work queue. `aura runner` polls
// `/api/v2/a2a/tasks?status=submitted` and claims what it finds. Mirroring 42
// locally-queued nodes therefore did not show them to anybody; it handed them
// to a cloud runner, which dispatched an agent at each and marked 43 rows
// `failed` when they could not authenticate. Terminal states do not patch
// back (409), so those rows stayed wrong.
//
// So an unfinished node goes up as `input-required` — the one state that is
// neither terminal nor claimable — and its true local word travels in
// `metadata.local_status`. The distinction this file has to keep straight is
// that the command *describes* work; it does not *hand it over*.

use std::collections::HashMap;
use std::path::Path;

use aura_loop::{LoopGraph, LoopTask};
use serde_json::{json, Value};

/// What `aura crew push` was asked to do.
pub struct PushOpts {
    /// Only this crew's slice. `None` pushes every node.
    pub crew: Option<String>,
    /// Show what would go up, and send nothing.
    pub dry_run: bool,
    /// Machine-readable summary instead of the human lines.
    pub json: bool,
    /// Stop after this many nodes. Guards a first run against a graph that
    /// has been accumulating for months.
    pub limit: Option<usize>,
}

/// What one node's mirror attempt did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Outcome {
    Created,
    Updated,
    Unchanged,
    Failed,
}

/// The cloud's word for a local status.
///
/// The finished states are already spelled identically — the two stores were
/// modelled off the same A2A lifecycle. Everything unfinished collapses to
/// `input-required`, which is the only state that is neither terminal nor
/// claimable by a cloud runner. See the note at the top of this file for what
/// happens when a mirrored node is left `submitted`: it is not shown, it is
/// dispatched.
///
/// `working` is honest and safe — a runner claims from `submitted`, not from
/// `working` — so a node genuinely running under a local runner keeps its
/// word and shows as in-flight.
fn cloud_status(local: &str) -> &'static str {
    match local {
        "working" => "working",
        "completed" => "completed",
        "failed" => "failed",
        "canceled" => "canceled",
        "rejected" => "rejected",
        // `submitted`, `paused`, and anything a future runner invents: real
        // crew state, worth showing, and nobody else's to pick up.
        _ => "input-required",
    }
}

/// The kinds the server accepts. A node filed under anything else is sent as
/// a `task`, which is what the server would have defaulted to anyway.
fn cloud_kind(local: &str) -> &'static str {
    match local {
        "plan" => "plan",
        "wave" => "wave",
        "subtask" => "subtask",
        _ => "task",
    }
}

/// `acceptance_criteria` is required, non-empty, for every kind but `subtask`
/// — the server rejects the insert otherwise, and rightly: it is the oracle
/// the completed work gets judged against.
///
/// A node with none is sent as a `subtask` rather than being dropped or given
/// an invented criterion. It still reaches the console with its title, its
/// status and its commit; it simply does not claim to have been proved
/// against something it was never given.
fn kind_and_criteria(task: &LoopTask) -> (&'static str, Option<String>) {
    let ac = task
        .acceptance_criteria
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    match ac {
        Some(_) => (cloud_kind(&task.task_kind), ac),
        None => ("subtask", None),
    }
}

/// Parents before children, so a child's `parent_task_id` can name a row that
/// already exists. The cloud keys hierarchy by uuid, and the only place a
/// local parent id becomes a uuid is the parent's own `remote_id`.
///
/// A cycle, or a parent outside the pushed slice, leaves the child in the
/// tail of the order and unparented rather than dropped — its own work is
/// still worth showing.
fn parents_first(tasks: Vec<LoopTask>) -> Vec<LoopTask> {
    let ids: HashMap<&str, ()> = tasks.iter().map(|t| (t.id.as_str(), ())).collect();
    let mut depth: HashMap<String, usize> = HashMap::new();
    for t in &tasks {
        let mut d = 0usize;
        let mut cur = t.parent_task_id.clone();
        // Bounded by the node count: a cycle cannot outrun it.
        while let Some(p) = cur {
            if d > tasks.len() || !ids.contains_key(p.as_str()) {
                break;
            }
            d += 1;
            cur = tasks
                .iter()
                .find(|c| c.id == p)
                .and_then(|c| c.parent_task_id.clone());
        }
        depth.insert(t.id.clone(), d);
    }
    let mut out = tasks;
    out.sort_by(|a, b| {
        depth
            .get(&a.id)
            .cmp(&depth.get(&b.id))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    out
}

/// The create payload for one node.
///
/// Everything the cloud has a column for goes in its column; everything it
/// does not — the graph edges, the commit that closed the node, the board
/// card it came from, the place it was pinned to — goes in `metadata`, where
/// it survives the trip and stays readable, rather than being dropped because
/// the destination table has a narrower shape than the source.
fn create_body(task: &LoopTask, repo: Option<&str>, parent_remote: Option<&str>) -> Value {
    let (kind, criteria) = kind_and_criteria(task);
    let mut body = serde_json::Map::new();
    body.insert(
        "agent_kind".into(),
        json!(task.agent_kind.as_deref().unwrap_or("claude")),
    );
    // The console shows `input` as the work spec, so it carries the node's
    // full prompt. The title would read as a truncation of it.
    let input = if task.input.trim().is_empty() {
        task.title.clone()
    } else {
        task.input.clone()
    };
    body.insert("input".into(), json!(input));
    body.insert("task_kind".into(), json!(kind));
    // Where the work already is, stated at birth. Creating the row queued and
    // patching it a moment later leaves a window the runner poll really does
    // win — it did, once, on the run that taught this file the difference
    // between describing work and handing it over.
    body.insert("status".into(), json!(cloud_status(&task.status)));
    if let Some(ac) = criteria {
        body.insert("acceptance_criteria".into(), json!(ac));
    }
    if let Some(r) = repo {
        body.insert("repo".into(), json!(r));
    }
    if let Some(p) = parent_remote {
        body.insert("parent_task_id".into(), json!(p));
    }
    if let Some(b) = task.branch.as_deref().filter(|s| !s.trim().is_empty()) {
        body.insert("branch".into(), json!(b));
    }
    // `commit_sha` is a column on the cloud row, and the console reads THAT —
    // not `metadata.commit_sha`, and not the `{"commit_sha": …}` this file
    // also puts in `result`. Sending it only in those two places is why a
    // board of finished nodes rendered with no commit against any of them,
    // which reads as work that was marked done and never linked to anything.
    if let Some(sha) = task.commit_sha.as_deref().filter(|s| !s.trim().is_empty()) {
        body.insert("commit_sha".into(), json!(sha));
    }
    // The crew is how the console groups a run, so it travels as a tag even
    // when the graph has no other tags — otherwise 46 uncrewed nodes and 17
    // `place-plane` ones arrive looking identical.
    // A node with no `crew_id` is on the default crew, not on no crew — that
    // is what `crew_of` means everywhere else. Sending null instead left 46
    // nodes unbucketable, which is why the console listed six crews where the
    // app listed eight.
    let crew = aura_loop::crew_of(task);
    let mut tags = task.tags.clone();
    let tag = format!("crew:{crew}");
    if !tags.contains(&tag) {
        tags.push(tag);
    }
    if !tags.is_empty() {
        body.insert("tags".into(), json!(tags));
    }
    body.insert(
        "metadata".into(),
        json!({
            "aura_local_id": task.id,
            "title": task.title,
            // The word the local graph uses. `status` on the row is the
            // cloud's nearest safe equivalent, which for anything unfinished
            // is `input-required` — so without this the difference between a
            // queued node and a paused one would be lost in the trip.
            "local_status": task.status,
            "priority": task.priority,
            "depends_on": task.depends_on,
            "crew_id": crew,
            "place": task.place,
            "commit_sha": task.commit_sha,
            "board_task_id": task.board_task_id,
            "external_source": task.external_source,
            "external_id": task.external_id,
            "assignee": task.assignee,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
        }),
    );
    Value::Object(body)
}

/// The status patch, or `None` when the node is where a freshly created row
/// already sits and there is nothing to say.
fn status_body(task: &LoopTask) -> Option<Value> {
    let want = cloud_status(&task.status);
    if want == "submitted" {
        return None;
    }
    let mut body = serde_json::Map::new();
    body.insert("status".into(), json!(want));
    // The cloud has one state for everything unfinished, so `local_status`
    // is where the difference between queued, working and paused lives. An
    // update that moved `status` but left this behind is how a node could
    // read as working on the console and paused on the laptop.
    body.insert(
        "metadata".into(),
        json!({
            "local_status": task.status,
            "crew_id": aura_loop::crew_of(task),
            "commit_sha": task.commit_sha,
            "updated_at": task.updated_at,
        }),
    );
    // The column the console renders. `PATCH` COALESCEs it, so a node that
    // has not produced a commit yet leaves whatever is already there alone.
    if let Some(sha) = task.commit_sha.as_deref().filter(|s| !s.trim().is_empty()) {
        body.insert("commit_sha".into(), json!(sha));
    }
    if let Some(r) = task.result.as_ref() {
        body.insert("result".into(), r.clone());
    } else if let Some(sha) = task.commit_sha.as_deref().filter(|s| !s.is_empty()) {
        // A completed node with no structured result still delivered a
        // commit, and that is the one thing a reader wants from it.
        body.insert("result".into(), json!({ "commit_sha": sha }));
    }
    if let Some(e) = task.error_message.as_deref().filter(|s| !s.is_empty()) {
        body.insert("error_message".into(), json!(e));
    }
    Some(Value::Object(body))
}

/// Mirror one node to the cloud right after its status changed locally.
///
/// `aura crew push` has always been able to do this; nothing ever ran it. So
/// the graph moved on this laptop and the console kept showing the state it
/// was in the last time somebody remembered the command — which is exactly
/// what an audit of the three surfaces found: the same crew reported
/// different counts on the desktop, the CLI and the web.
///
/// Best-effort by design. Offline, logged out, or a server that says no all
/// end the same way: the local write already happened and stands on its own,
/// the next `aura crew push` reconciles, and the command the person ran does
/// not fail because a mirror did. `AURA_NO_CLOUD_MIRROR=1` turns it off.
pub fn mirror_one(repo_root: &Path, id: &str) {
    if std::env::var("AURA_NO_CLOUD_MIRROR").is_ok_and(|v| v != "0" && !v.is_empty()) {
        return;
    }
    let Ok((cloud_url, token)) = crate::recall_cloud_creds() else {
        return;
    };
    let graph = LoopGraph::at(repo_root);
    let Some(task) = graph.get(id) else { return };
    let base = cloud_url.trim_end_matches('/').to_string();
    let client = crate::cloud_http_client();

    if let Some(rid) = task.remote_id.as_deref() {
        let Some(body) = status_body(&task) else { return };
        let url = format!("{}/api/v2/a2a/tasks/{}", base, crate::a2a_safe_id(rid));
        let _ = crate::recall_patch(&client, &url, &token, &body);
        return;
    }

    // Never mirrored yet. Mint the row, then stamp the id back so the next
    // change patches it instead of minting a second one.
    let repo = crate::repo_slug::of_cwd();
    let parent_remote = task
        .parent_task_id
        .as_deref()
        .and_then(|p| graph.get(p))
        .and_then(|p| p.remote_id);
    let url = format!("{}/api/v2/a2a/tasks", base);
    let body = create_body(&task, Some(repo.as_str()), parent_remote.as_deref());
    let Ok(resp) = crate::recall_post(&client, &url, &token, &body) else {
        return;
    };
    let Some(rid) = resp.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return;
    };
    if let Some(mut fresh) = graph.get(id) {
        fresh.remote_id = Some(rid.to_string());
        let _ = graph.save(&fresh);
    }
    if let Some(body) = status_body(&task) {
        let purl = format!("{}/api/v2/a2a/tasks/{}", base, crate::a2a_safe_id(rid));
        let _ = crate::recall_patch(&client, &purl, &token, &body);
    }
}

/// Mirror the local crew graph into the cloud task store.
pub fn run(repo_root: &Path, opts: &PushOpts) -> Result<(), String> {
    let graph = LoopGraph::at(repo_root);
    let all = graph.list();
    if all.is_empty() {
        if opts.json {
            println!("{}", json!({ "pushed": 0, "note": "no local crew graph" }));
        } else {
            println!("No crew graph in this repo — nothing to push.");
        }
        return Ok(());
    }

    let mut tasks: Vec<LoopTask> = match opts.crew.as_deref() {
        Some(c) => all
            .into_iter()
            .filter(|t| t.crew_id.as_deref() == Some(c))
            .collect(),
        None => all,
    };
    if tasks.is_empty() {
        return Err(format!(
            "no nodes in crew '{}'",
            opts.crew.as_deref().unwrap_or("")
        ));
    }
    tasks = parents_first(tasks);
    if let Some(n) = opts.limit {
        tasks.truncate(n);
    }

    // The same name the intent log files this project under, so crew work
    // and the reasoning behind it land on one row in the console rather than
    // two spellings of the same project.
    let repo = crate::repo_slug::of_cwd();
    let repo_ref = Some(repo.as_str());

    if opts.dry_run {
        let new = tasks.iter().filter(|t| t.remote_id.is_none()).count();
        if opts.json {
            let rows: Vec<Value> = tasks
                .iter()
                .map(|t| {
                    json!({
                        "id": t.id,
                        "title": t.title,
                        "status": cloud_status(&t.status),
                        "kind": kind_and_criteria(t).0,
                        "crew_id": t.crew_id,
                        "action": if t.remote_id.is_none() { "create" } else { "update" },
                    })
                })
                .collect();
            println!(
                "{}",
                json!({ "repo": repo, "would_create": new,
                        "would_update": tasks.len() - new, "tasks": rows })
            );
        } else {
            println!(
                "Would mirror {} node(s) to {} — {} new, {} already mirrored.",
                tasks.len(),
                &repo,
                new,
                tasks.len() - new,
            );
            for t in &tasks {
                println!(
                    "  {} {:<9} {}",
                    if t.remote_id.is_none() { "+" } else { "~" },
                    cloud_status(&t.status),
                    t.title,
                );
            }
        }
        return Ok(());
    }

    let (cloud_url, token) = crate::recall_cloud_creds()?;
    let base = cloud_url.trim_end_matches('/').to_string();
    let client = crate::cloud_http_client();

    // Local id → cloud uuid, seeded with what previous runs already mirrored
    // so a child pushed today can still name a parent pushed last week.
    let mut remote: HashMap<String, String> = graph
        .list()
        .into_iter()
        .filter_map(|t| t.remote_id.map(|r| (t.id, r)))
        .collect();

    let mut counts: HashMap<Outcome, usize> = HashMap::new();
    let mut failures: Vec<String> = Vec::new();

    for task in &tasks {
        let parent_remote = task
            .parent_task_id
            .as_deref()
            .and_then(|p| remote.get(p))
            .cloned();

        let outcome = if let Some(rid) = task.remote_id.as_deref() {
            match status_body(task) {
                None => Outcome::Unchanged,
                Some(body) => {
                    let url = format!("{}/api/v2/a2a/tasks/{}", base, crate::a2a_safe_id(rid));
                    match crate::recall_patch(&client, &url, &token, &body) {
                        Ok(_) => Outcome::Updated,
                        // A row already in its terminal state refuses the
                        // transition, which means it is where we wanted it.
                        // Nothing to report and nothing to fix.
                        Err(_) => Outcome::Unchanged,
                    }
                }
            }
        } else {
            let url = format!("{}/api/v2/a2a/tasks", base);
            let body = create_body(task, repo_ref, parent_remote.as_deref());
            match crate::recall_post(&client, &url, &token, &body) {
                Err(e) => {
                    failures.push(format!("{}: {}", task.title, e));
                    Outcome::Failed
                }
                Ok(resp) => {
                    let rid = resp.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                    if rid.is_empty() {
                        failures.push(format!("{}: server returned no id", task.title));
                        Outcome::Failed
                    } else {
                        remote.insert(task.id.clone(), rid.to_string());
                        // Stamp it before the status patch. If the patch
                        // fails, the row still exists and the next run must
                        // update it rather than mint a duplicate.
                        if let Some(mut fresh) = graph.get(&task.id) {
                            fresh.remote_id = Some(rid.to_string());
                            let _ = graph.save(&fresh);
                        }
                        // The row was born in the right state, so this is
                        // only here to attach the result and any error text,
                        // which create has no columns for. A server that has
                        // not learned `status` on create yet still lands on
                        // its feet: the patch moves it the rest of the way.
                        if let Some(body) = status_body(task) {
                            let purl =
                                format!("{}/api/v2/a2a/tasks/{}", base, crate::a2a_safe_id(rid));
                            let _ = crate::recall_patch(&client, &purl, &token, &body);
                        }
                        Outcome::Created
                    }
                }
            }
        };
        *counts.entry(outcome).or_insert(0) += 1;
    }

    let n = |o: Outcome| counts.get(&o).copied().unwrap_or(0);
    if opts.json {
        println!(
            "{}",
            json!({
                "repo": repo,
                "created": n(Outcome::Created),
                "updated": n(Outcome::Updated),
                "unchanged": n(Outcome::Unchanged),
                "failed": n(Outcome::Failed),
                "errors": failures,
            })
        );
    } else {
        println!(
            "↑ crew push — {} created, {} updated, {} unchanged, {} failed ({})",
            n(Outcome::Created),
            n(Outcome::Updated),
            n(Outcome::Unchanged),
            n(Outcome::Failed),
            &repo,
        );
        for f in failures.iter().take(10) {
            println!("  ! {f}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, parent: Option<&str>) -> LoopTask {
        LoopTask {
            id: id.to_string(),
            title: format!("node {id}"),
            input: String::new(),
            acceptance_criteria: Some("it works".into()),
            task_kind: "task".into(),
            parent_task_id: parent.map(str::to_string),
            depends_on: vec![],
            status: "submitted".into(),
            priority: "medium".into(),
            agent_kind: None,
            place: None,
            branch: None,
            tags: vec![],
            commit_sha: None,
            result: None,
            error_message: None,
            assignee: None,
            lease: None,
            remote_id: None,
            board_task_id: None,
            external_source: None,
            external_id: None,
            crew_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn nothing_unfinished_is_mirrored_as_claimable_work() {
        // The regression this pins actually happened: 42 locally-queued nodes
        // went up as `submitted`, a cloud runner polled that exact status,
        // claimed 43 of them and failed every one. `submitted` is a work
        // queue, not a description, and a mirror must never write to it.
        for local in ["submitted", "paused", "brand-new-word", "ready"] {
            assert_ne!(
                cloud_status(local),
                "submitted",
                "{local} would be claimed by a cloud runner"
            );
        }
        assert_eq!(cloud_status("submitted"), "input-required");
        assert_eq!(cloud_status("paused"), "input-required");
    }

    #[test]
    fn work_that_finished_keeps_the_word_it_finished_with() {
        assert_eq!(cloud_status("completed"), "completed");
        assert_eq!(cloud_status("failed"), "failed");
        assert_eq!(cloud_status("canceled"), "canceled");
        // Safe to keep: a runner claims from `submitted`, never from
        // `working`, so an in-flight node shows as in-flight.
        assert_eq!(cloud_status("working"), "working");
    }

    #[test]
    fn the_true_local_word_survives_the_collapse() {
        // Queued and paused both land on `input-required`. Without this the
        // difference would be gone the moment it left the laptop.
        let mut t = node("t-1", None);
        t.status = "paused".into();
        assert_eq!(create_body(&t, None, None)["metadata"]["local_status"], "paused");
        t.status = "submitted".into();
        assert_eq!(
            create_body(&t, None, None)["metadata"]["local_status"],
            "submitted"
        );
    }

    #[test]
    fn a_node_without_criteria_goes_up_as_a_subtask() {
        // The server requires acceptance_criteria for plan/wave/task. The
        // alternatives were dropping the node or inventing an oracle for it;
        // neither is honest about work that was really done.
        let mut t = node("t-1", None);
        t.acceptance_criteria = None;
        assert_eq!(kind_and_criteria(&t).0, "subtask");
        assert_eq!(kind_and_criteria(&t).1, None);

        t.acceptance_criteria = Some("   ".into());
        assert_eq!(kind_and_criteria(&t).0, "subtask", "blank is not criteria");

        t.acceptance_criteria = Some("the gate passes".into());
        assert_eq!(kind_and_criteria(&t).0, "task");
    }

    #[test]
    fn parents_are_pushed_before_their_children() {
        // A child's parent_task_id can only be filled from the parent's
        // remote_id, which does not exist until the parent has gone up.
        let order = parents_first(vec![
            node("c", Some("b")),
            node("a", None),
            node("b", Some("a")),
        ]);
        assert_eq!(
            order.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn a_parent_cycle_terminates_instead_of_hanging() {
        // Nothing should mint this, but a hand-edited graph can, and a push
        // that spins forever is worse than one that files the pair oddly.
        let order = parents_first(vec![node("x", Some("y")), node("y", Some("x"))]);
        assert_eq!(order.len(), 2);
    }

    #[test]
    fn a_parent_outside_the_slice_does_not_drop_the_child() {
        // `--crew place-plane` can name a node whose parent lives in another
        // crew. The child is still that crew's work.
        let order = parents_first(vec![node("child", Some("elsewhere"))]);
        assert_eq!(order.len(), 1);
    }

    #[test]
    fn a_row_is_born_in_the_state_the_work_is_already_in() {
        // Not patched into it afterwards. The gap between the two calls is
        // long enough for a runner poll to claim the row.
        let mut t = node("t-1", None);
        assert_eq!(create_body(&t, None, None)["status"], "input-required");
        t.status = "completed".into();
        assert_eq!(create_body(&t, None, None)["status"], "completed");
    }

    #[test]
    fn the_crew_travels_as_a_tag() {
        // Without it, 46 uncrewed nodes and 17 place-plane ones arrive in the
        // console looking identical.
        let mut t = node("t-1", None);
        t.crew_id = Some("place-plane".into());
        let body = create_body(&t, Some("MHASK/aura-sovereign"), None);
        let tags = body["tags"].as_array().unwrap();
        assert!(tags.iter().any(|v| v == "crew:place-plane"));
        assert_eq!(body["repo"], "MHASK/aura-sovereign");
    }

    #[test]
    fn a_titles_only_node_still_carries_a_work_spec() {
        // `input` is what the console renders as the task. An empty one would
        // show a blank card.
        let t = node("t-1", None);
        let body = create_body(&t, None, None);
        assert_eq!(body["input"], "node t-1");
        assert!(body.get("repo").is_none(), "no repo identity, no repo claim");
    }

    #[test]
    fn what_the_cloud_has_no_column_for_travels_in_metadata() {
        let mut t = node("t-1", None);
        t.depends_on = vec!["t-0".into()];
        t.commit_sha = Some("4cbdaf44b".into());
        let body = create_body(&t, None, None);
        assert_eq!(body["metadata"]["commit_sha"], "4cbdaf44b");
        assert_eq!(body["metadata"]["depends_on"][0], "t-0");
        assert_eq!(body["metadata"]["aura_local_id"], "t-1");
    }

    /// The commit is the one thing on a finished node a reader goes looking
    /// for, and the console reads the row's own column rather than the
    /// metadata blob. Sending it only in metadata is how a board of 158
    /// pushed nodes rendered with no commit against a single one of them.
    #[test]
    fn a_commit_reaches_the_column_the_console_reads_not_only_metadata() {
        let mut t = node("t-1", None);
        t.commit_sha = Some("4cbdaf44b".into());
        assert_eq!(create_body(&t, None, None)["commit_sha"], "4cbdaf44b");

        t.status = "completed".into();
        assert_eq!(status_body(&t).unwrap()["commit_sha"], "4cbdaf44b");
    }

    /// `PATCH` COALESCEs the column, so an absent field keeps whatever the row
    /// already holds. Sending an empty string instead would blank a commit a
    /// previous push had linked.
    #[test]
    fn a_node_with_no_commit_claims_nothing_about_the_column() {
        let mut t = node("t-1", None);
        t.status = "working".into();
        t.commit_sha = Some("   ".into());
        assert!(create_body(&t, None, None).get("commit_sha").is_none());
        assert!(status_body(&t).unwrap().get("commit_sha").is_none());
    }

    #[test]
    fn a_queued_node_is_moved_off_the_queue_after_it_is_created() {
        // The server mints every row `submitted`. Leaving it there is what
        // got 43 nodes dispatched, so the create is always followed by a
        // patch that takes the row out of the runner's reach.
        let body = status_body(&node("t-1", None)).expect("queued must be patched");
        assert_eq!(body["status"], "input-required");
    }

    #[test]
    fn a_finished_node_carries_its_commit_when_it_has_no_other_result() {
        let mut t = node("t-1", None);
        t.status = "completed".into();
        t.commit_sha = Some("4cbdaf44b".into());
        let body = status_body(&t).unwrap();
        assert_eq!(body["status"], "completed");
        assert_eq!(body["result"]["commit_sha"], "4cbdaf44b");
    }
}
