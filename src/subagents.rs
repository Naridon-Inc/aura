//! Who actually did the work, when the work was done by somebody else.
//!
//! # What was missing
//!
//! An agent that fans work out to sub-agents is the normal shape of a long
//! session now — this repo's own transcripts hold 3,958 sub-agent runs across
//! 80 projects, 311 of them under a single session. Every file one of those
//! workers edits reaches Aura, because the post-tool-use hook fires inside a
//! sub-agent exactly as it does on the main thread. But it reached us
//! *anonymous*: the hook read `session_id` and nothing else, so a worker's
//! edits were filed under the parent session as though the parent had typed
//! them. Twenty files changed, one session, no answer to "which of the nine
//! things running did this".
//!
//! The identity was on the wire the whole time. Claude Code puts `agent_id` and
//! `agent_type` on the base hook payload — its own schema says *"present only
//! when the hook fires from within a subagent … use this field to distinguish
//! subagent calls from main-thread calls"* — and writes each worker's
//! transcript to its own file with a sidecar naming what it was for:
//!
//! ```text
//! ~/.claude/projects/<project>/
//!     <session>.jsonl                       ← the parent's transcript
//!     <session>/subagents/
//!         agent-<agentId>.jsonl             ← one worker's transcript
//!         agent-<agentId>.meta.json         ← what it was, and who sent it
//! ```
//!
//! # Why this module reads that layout rather than keeping its own copy
//!
//! The sidecar already holds everything a reader wants — the agent type, the
//! one-line description the parent wrote when it spawned the worker, the
//! parent agent it was spawned from, and how deep the chain goes. Writing a
//! second copy into `.aura/` would put a per-person, per-machine log into a
//! tracked directory and leave two records to disagree. So the durable copy is
//! the cloud's (pushed when a worker stops), and locally this indexes what is
//! already on disk.
//!
//! Nothing here fails loudly. It runs from a hook and from status output; a
//! missing directory or a sidecar from a newer Claude means "no runs known",
//! never an error.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// One sub-agent run, as Claude Code recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    /// Claude's own id for the worker — the same value the hook payload calls
    /// `agent_id`, so an intent row logged mid-run joins to this record.
    pub agent_id: String,
    /// Which kind of agent it was: `Explore`, `general-purpose`, `fork`, or a
    /// name from the project's own `.claude/agents/`.
    pub agent_type: String,
    /// The three-to-five word description the parent wrote when it spawned the
    /// worker. The single most useful field here — it is the only place the
    /// *purpose* of a run is written down in the parent's own words.
    pub description: String,
    /// The worker that spawned this one, when it was not the main thread.
    /// Present on nested runs only, and it is what makes the chain of command
    /// reconstructable rather than a flat list.
    pub parent_agent_id: Option<String>,
    /// 1 for a worker the main thread spawned, 2 for a worker spawned by a
    /// worker, and so on. Observed as deep as 3 in this repo.
    pub spawn_depth: u32,
    /// The model the run resolved to, when the spawn pinned one.
    pub model: Option<String>,
    /// A fork inherits the parent's context instead of starting fresh, which
    /// changes how its transcript should be read — the first turn is a
    /// continuation, not a brief.
    pub is_fork: bool,
    /// Set when the run was given its own git worktree, so its commits can be
    /// found later.
    pub worktree_branch: Option<String>,
    /// The worker's own transcript.
    pub transcript: PathBuf,
    /// When the transcript was last written, as a unix timestamp. Used for
    /// ordering; the transcript's own timestamps are authoritative for a turn.
    pub last_write: Option<u64>,
}

impl Run {
    /// The shape pushed to the cloud and printed by `aura subagents --json`.
    ///
    /// One shape, two readers, so a field can never mean one thing on the wire
    /// and another on the terminal.
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::json!({
            "agent_id": self.agent_id,
            "agent_type": self.agent_type,
            "description": self.description,
            "spawn_depth": self.spawn_depth,
            "is_fork": self.is_fork,
        });
        if let Some(p) = &self.parent_agent_id {
            v["parent_agent_id"] = Value::String(p.clone());
        }
        if let Some(m) = &self.model {
            v["model"] = Value::String(m.clone());
        }
        if let Some(b) = &self.worktree_branch {
            v["worktree_branch"] = Value::String(b.clone());
        }
        if let Some(t) = self.last_write {
            v["last_write"] = Value::from(t);
        }
        v
    }
}

/// Where a session's sub-agent transcripts live, given the parent transcript.
///
/// Claude names the directory after the transcript file with the extension
/// dropped — `<session>.jsonl` and `<session>/subagents/` are siblings. Derived
/// from the path the hook handed us rather than rebuilt from the session id and
/// a guessed project directory, because the project directory is the cwd with
/// its separators mangled and that encoding is not ours to reimplement.
pub fn dir_of(parent_transcript: &Path) -> Option<PathBuf> {
    let parent = parent_transcript.parent()?;
    let stem = parent_transcript.file_stem()?;
    let dir = parent.join(stem).join("subagents");
    dir.is_dir().then_some(dir)
}

/// True when `transcript` is itself a sub-agent's transcript rather than a
/// session's.
///
/// The `SubagentStop` hook hands us the worker's file directly, and the two
/// paths must not be confused: reading a worker's file as a parent would look
/// for `subagents/` under it and find nothing, and reading a parent's file as a
/// worker would attribute a whole session to one worker.
pub fn is_subagent_transcript(transcript: &Path) -> bool {
    transcript
        .parent()
        .and_then(Path::file_name)
        .map(|n| n == "subagents")
        .unwrap_or(false)
}

/// Every sub-agent run recorded under a session, oldest write first.
///
/// Ordered by when each transcript was last written so a reader sees the run
/// order rather than the filesystem's, which is the id — and an id is a hash.
pub fn runs_of(parent_transcript: &Path) -> Vec<Run> {
    let Some(dir) = dir_of(parent_transcript) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut runs: Vec<Run> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .filter_map(|p| one(&p))
        .collect();
    runs.sort_by(|a, b| {
        a.last_write
            .cmp(&b.last_write)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    runs
}

/// Read one run from its transcript path.
///
/// The sidecar beside it carries the identity. A transcript with no sidecar is
/// still a run — an older Claude wrote no sidecar, and half a record beats
/// dropping the work — so the type falls back to `subagent` and the
/// description to empty rather than the whole run disappearing.
pub fn one(agent_transcript: &Path) -> Option<Run> {
    if !agent_transcript.is_file() {
        return None;
    }
    let agent_id = agent_id_of(agent_transcript)?;
    let meta = meta_beside(agent_transcript).unwrap_or_else(|| serde_json::json!({}));

    let string = |key: &str| {
        meta.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    Some(Run {
        agent_id,
        agent_type: string("agentType").unwrap_or_else(|| "subagent".to_string()),
        description: string("description").unwrap_or_default(),
        parent_agent_id: string("parentAgentId"),
        // Absent means "spawned by the main thread", which is depth 1. A
        // sidecar that omits it is old, not confused about its own depth.
        spawn_depth: meta
            .get("spawnDepth")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .min(u32::MAX as u64) as u32,
        model: string("model"),
        is_fork: meta
            .get("isFork")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        worktree_branch: string("worktreeBranch"),
        transcript: agent_transcript.to_path_buf(),
        last_write: fs::metadata(agent_transcript)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    })
}

/// The worker id out of `agent-<id>.jsonl`.
///
/// Taken from the filename rather than the first row of the transcript so a
/// zero-byte or half-written file — which is what a run that has only just
/// started looks like — still identifies itself.
fn agent_id_of(agent_transcript: &Path) -> Option<String> {
    let stem = agent_transcript.file_stem()?.to_str()?;
    let id = stem.strip_prefix("agent-").unwrap_or(stem);
    (!id.is_empty()).then(|| id.to_string())
}

/// The `.meta.json` sidecar for a worker transcript, if Claude wrote one.
fn meta_beside(agent_transcript: &Path) -> Option<Value> {
    let stem = agent_transcript.file_stem()?.to_str()?;
    let path = agent_transcript
        .parent()?
        .join(format!("{stem}.meta.json"));
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Publish one finished run to the cloud, so the console can show who did what.
///
/// Best-effort by contract: this is called from a stop hook, which must exit 0
/// whatever the network is doing. A server too old to know the route is the
/// same as being offline — the local transcripts remain the record either way,
/// and the next release's backfill can reach them.
pub fn push(session_id: &str, run: &Run, last_message: Option<&str>, repo_root: &Path) -> bool {
    let Some((base, token)) = cloud() else {
        return false;
    };

    let mut body = run.to_json();
    body["session_id"] = Value::String(session_id.to_string());
    body["repo_full_name"] = Value::String(crate::repo_slug::of_cwd());
    if let Some(branch) = branch_of(repo_root) {
        body["branch"] = Value::String(branch);
    }
    if let Some(msg) = last_message.map(str::trim).filter(|s| !s.is_empty()) {
        // What the worker reported back. Bounded here rather than at the
        // server, because the caller is a hook reading a field Claude sizes
        // for a terminal, and a 200 KB report is not a summary.
        let mut msg = msg.to_string();
        if msg.len() > MAX_LAST_MESSAGE {
            let mut end = MAX_LAST_MESSAGE;
            while end > 0 && !msg.is_char_boundary(end) {
                end -= 1;
            }
            msg.truncate(end);
            msg.push_str("\n\n… truncated");
        }
        body["last_message"] = Value::String(msg);
    }

    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
    else {
        return false;
    };

    client
        .post(format!("{base}/api/v2/subagent-runs"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// How much of a worker's closing report is worth storing.
const MAX_LAST_MESSAGE: usize = 4_000;

/// Same precedence as every other push: what you signed in to, then the
/// override, then production.
fn cloud() -> Option<(String, String)> {
    let config = crate::config::ConfigManager::load();
    let token = crate::cloud_endpoint::token(config.cloud_api_token.as_deref())?;
    let url = crate::cloud_endpoint::origin_or_public(config.cloud_url.as_deref());
    Some((url, token))
}

fn branch_of(repo_root: &Path) -> Option<String> {
    let head = git2::Repository::open(repo_root).ok()?;
    let name = head.head().ok()?.shorthand()?.to_string();
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary Claude-shaped project directory: a parent transcript with a
    /// `subagents/` directory beside it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-sub-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sess-1").join("subagents")).unwrap();
        fs::write(dir.join("sess-1.jsonl"), "{}\n").unwrap();
        dir
    }

    fn worker(dir: &Path, id: &str, meta: Option<&str>) -> PathBuf {
        let subs = dir.join("sess-1").join("subagents");
        let t = subs.join(format!("agent-{id}.jsonl"));
        fs::write(&t, "{}\n").unwrap();
        if let Some(m) = meta {
            fs::write(subs.join(format!("agent-{id}.meta.json")), m).unwrap();
        }
        t
    }

    #[test]
    fn the_subagent_directory_is_a_sibling_of_the_transcript() {
        let dir = scratch("sibling");
        assert_eq!(
            dir_of(&dir.join("sess-1.jsonl")),
            Some(dir.join("sess-1").join("subagents"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_with_no_workers_has_no_directory_and_that_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("aura-sub-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("solo.jsonl"), "{}\n").unwrap();
        assert_eq!(dir_of(&dir.join("solo.jsonl")), None);
        assert!(runs_of(&dir.join("solo.jsonl")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_carries_the_purpose_its_parent_wrote_for_it() {
        let dir = scratch("purpose");
        let t = worker(
            &dir,
            "a01",
            Some(r#"{"agentType":"Explore","description":"Verify telemetry","toolUseId":"toolu_1","parentAgentId":"a5e","spawnDepth":2,"model":"opus"}"#),
        );
        let run = one(&t).expect("a worker with a sidecar is a run");
        assert_eq!(run.agent_id, "a01");
        assert_eq!(run.agent_type, "Explore");
        assert_eq!(run.description, "Verify telemetry");
        assert_eq!(run.parent_agent_id.as_deref(), Some("a5e"));
        assert_eq!(run.spawn_depth, 2);
        assert_eq!(run.model.as_deref(), Some("opus"));
        assert!(!run.is_fork);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_worker_whose_sidecar_is_missing_is_still_a_run() {
        // Older Claude builds wrote no sidecar. Half a record beats losing the
        // work entirely, so the type falls back and the id — which comes from
        // the filename — still joins to the intents that worker logged.
        let dir = scratch("nosidecar");
        let t = worker(&dir, "a02", None);
        let run = one(&t).expect("a worker without a sidecar is still a run");
        assert_eq!(run.agent_id, "a02");
        assert_eq!(run.agent_type, "subagent");
        assert_eq!(run.description, "");
        assert_eq!(run.spawn_depth, 1, "no sidecar means spawned by the session");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sidecar_itself_is_never_mistaken_for_a_run() {
        // `read_dir` sees `agent-x.jsonl` and `agent-x.meta.json` alike; only
        // the transcript is a run, or every worker would be counted twice.
        let dir = scratch("sidecar-not-a-run");
        worker(&dir, "a03", Some(r#"{"agentType":"fork","description":"d","spawnDepth":1,"isFork":true}"#));
        let runs = runs_of(&dir.join("sess-1.jsonl"));
        assert_eq!(runs.len(), 1);
        assert!(runs[0].is_fork);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workers_own_transcript_is_told_apart_from_a_sessions() {
        // The stop hook hands us the worker's file and the session hook hands
        // us the parent's; reading either as the other misfiles a whole run.
        let dir = scratch("which-file");
        let t = worker(&dir, "a04", None);
        assert!(is_subagent_transcript(&t));
        assert!(!is_subagent_transcript(&dir.join("sess-1.jsonl")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn runs_are_ordered_by_when_they_ran_not_by_their_ids() {
        let dir = scratch("order");
        let first = worker(&dir, "zzz", None);
        let second = worker(&dir, "aaa", None);
        // Ids are hashes, so sorting by name is sorting by nothing. Force a
        // gap rather than trusting two writes to land in different seconds.
        let now = std::time::SystemTime::now();
        let earlier = now - std::time::Duration::from_secs(600);
        filetime_set(&first, earlier);
        filetime_set(&second, now);

        let runs = runs_of(&dir.join("sess-1.jsonl"));
        assert_eq!(
            runs.iter().map(|r| r.agent_id.as_str()).collect::<Vec<_>>(),
            vec!["zzz", "aaa"],
            "oldest run first, whatever the ids sort like"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn filetime_set(path: &Path, at: std::time::SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(at).unwrap();
    }

    #[test]
    fn the_wire_shape_omits_what_it_does_not_know() {
        // A flat run has no parent, no model and no worktree; sending nulls
        // for them would make "spawned by the main thread" and "we lost the
        // parent" the same value on the other side.
        let dir = scratch("wire");
        let t = worker(&dir, "a05", Some(r#"{"agentType":"general-purpose","description":"Map the routes","spawnDepth":1}"#));
        let json = one(&t).unwrap().to_json();
        assert_eq!(json["agent_type"], "general-purpose");
        assert_eq!(json["description"], "Map the routes");
        assert!(json.get("parent_agent_id").is_none());
        assert!(json.get("model").is_none());
        assert!(json.get("worktree_branch").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
