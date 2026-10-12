//! Rendering: `--json` prints the raw response; otherwise a few plain lines.
//!
//! Every renderer is `fn(&Value) -> String` so it is testable without a
//! terminal, and `emit` is the only place that prints.

use serde_json::Value;

use super::client::ApiError;

/// Print either the raw JSON or the human rendering.
pub fn emit<F: FnOnce(&Value) -> String>(json: bool, value: &Value, render: F) {
    if json {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into()));
    } else {
        println!("{}", render(value));
    }
}

pub fn print_error(e: &ApiError) {
    eprintln!("  ✗ {}", e.message());
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn opt_line(out: &mut String, label: &str, value: &str) {
    if !value.is_empty() {
        out.push_str(&format!("  {label:<10} {value}\n"));
    }
}

/// One workspace: id first (the thing every other verb needs), then what it
/// is for, then the intent that created it.
pub fn render_workspace(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<10} {}\n", "id", s(v, "id")));
    opt_line(&mut out, "status", s(v, "status"));
    opt_line(&mut out, "title", s(v, "objective"));
    opt_line(&mut out, "intent", s(v, "intent"));
    opt_line(&mut out, "agent", s(v, "agent"));
    opt_line(&mut out, "branch", s(v, "branch"));
    opt_line(&mut out, "model", s(v, "model"));
    opt_line(&mut out, "created", s(v, "created_at"));
    opt_line(&mut out, "active", s(v, "last_activity_at"));
    opt_line(&mut out, "ended", s(v, "ended_at"));
    out.trim_end().to_string()
}

/// Whose turn it is, in the order a person reads it: the word first, then the
/// sentence that says what the word was derived from, then the facts that let
/// a caller disbelieve it. `state` is printed verbatim because scripts match
/// on it — see `workspace_turn::Turn::label` on the server.
pub fn render_workspace_status(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<10} {}\n", "state", s(v, "state")));
    let summary = s(v, "summary");
    if !summary.is_empty() {
        out.push_str(&format!("  {:<10} {}\n", "", summary));
    }
    opt_line(&mut out, "name", s(v, "name"));
    // `waiting_on` is null for a closed workspace, and the absence is the
    // answer — don't print an empty row that reads like a missing value.
    let on = s(v, "waiting_on");
    if !on.is_empty() {
        out.push_str(&format!("  {:<10} {}\n", "next move", on));
    }
    if v.get("accepts_prompt").and_then(Value::as_bool) == Some(false) {
        out.push_str(&format!("  {:<10} {}\n", "prompts", "refused"));
    }
    if let Some(n) = v.get("messages").and_then(Value::as_i64) {
        out.push_str(&format!("  {:<10} {}\n", "messages", n));
    }
    opt_line(&mut out, "last said", s(v, "last_speaker"));
    opt_line(&mut out, "active", s(v, "last_activity_at"));
    opt_line(&mut out, "ended", s(v, "ended_at"));
    out.trim_end().to_string()
}

/// The caller's workspaces. `page` is `Some` only when the caller named a page
/// size: without one, the size is the server's default and this client has no
/// business restating a number it would then have to keep in step.
pub fn render_workspace_list(v: &Value, page: Option<&AskedPage<'_>>) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no workspaces".to_string(),
    };
    let mut out = String::new();
    for w in rows {
        let title = s(w, "objective");
        let intent = s(w, "intent");
        let what = if !intent.is_empty() {
            intent
        } else if !title.is_empty() {
            title
        } else {
            "(untitled)"
        };
        out.push_str(&format!("  {:<36}  {:<9}  {}\n", s(w, "id"), s(w, "status"), what));
    }
    if let Some(p) = page {
        asked_page_footer(&mut out, rows.len(), p);
    }
    out.trim_end().to_string()
}

pub fn render_prompt_ack(v: &Value) -> String {
    let mut out = format!("  queued  {}", s(v, "id"));
    let status = s(v, "status");
    if !status.is_empty() {
        out.push_str(&format!("  ({status})"));
    }
    out
}

pub fn render_messages(v: &Value) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no messages".to_string(),
    };
    let mut out = String::new();
    for m in rows {
        let body = s(m, "body");
        let mut lines = body.lines();
        let first = lines.next().unwrap_or("");
        out.push_str(&format!("  [{}] {:<9} {}\n", s(m, "created_at"), s(m, "role"), first));
        for l in lines {
            out.push_str(&format!("  {:<37}{}\n", "", l));
        }
    }
    out.trim_end().to_string()
}

/// The footer every paged listing ends with.
///
/// Printed only when there is more, and it prints the command rather than the
/// numbers: a reader who has to work out their own next offset usually gets it
/// wrong by one.
/// Say that a page is only a page, and say it as a command.
///
/// `next_hint` is the caller's own command with its arguments still on it —
/// id, `--status`, `--limit` — because a hint that drops the filter is worse
/// than no hint: it reads like the next page of what you asked for and is the
/// next page of something else.
fn page_footer(out: &mut String, v: &Value, next_hint: &str) {
    if v.get("has_more").and_then(Value::as_bool) != Some(true) {
        return;
    }
    let limit = v.get("limit").and_then(Value::as_i64).unwrap_or(0);
    let offset = v.get("offset").and_then(Value::as_i64).unwrap_or(0);
    out.push_str(&format!(
        "\n  more rows — {next_hint} --offset {}\n",
        offset + limit
    ));
}

/// The window a bare-array listing was asked for, so its footer can be drawn.
///
/// `workspace list` answers with a bare JSON array — no `limit`, no `offset`,
/// no `has_more` — and that shape is kept on purpose until item 11 changes it
/// as an announced break. So the renderer is handed the window the *caller*
/// asked for instead of reading it back off the response.
pub struct AskedPage<'a> {
    pub limit: i64,
    pub offset: i64,
    pub next_hint: &'a str,
}

/// The footer for a listing with no `has_more` to read.
///
/// Fullness stands in for it: a page that came back exactly as long as it was
/// allowed to be is the only page that *might* have more behind it. The guess
/// runs in one direction only — it can offer a next page that turns out empty,
/// and it can never hide rows that exist — so it is worded as a command to try
/// rather than as a fact about the list.
fn asked_page_footer(out: &mut String, rows: usize, page: &AskedPage<'_>) {
    if (rows as i64) < page.limit {
        return;
    }
    out.push_str(&format!(
        "\n  page is full — there may be more: {} --offset {}\n",
        page.next_hint,
        page.offset + page.limit
    ));
}

/// `items` out of a paged envelope, or the whole value when a server answered
/// with a bare array. Keeps the renderers working against either shape rather
/// than printing "no rows" at the first sign of a change.
fn items(v: &Value) -> Option<&Vec<Value>> {
    v.get("items").and_then(Value::as_array).or_else(|| v.as_array())
}

/// One project. Leads with the name, because the name is what
/// `workspace create --repo` takes.
pub fn render_project(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<12} {}\n", "project", s(v, "name")));
    opt_line(&mut out, "id", s(v, "id"));
    opt_line(&mut out, "branch", s(v, "default_branch"));
    if let Some(n) = v.get("workspaces").and_then(Value::as_i64) {
        out.push_str(&format!("  {:<12} {}\n", "workspaces", n));
    }
    opt_line(&mut out, "active", s(v, "last_activity_at"));
    opt_line(&mut out, "created", s(v, "created_at"));
    // Said out loud rather than left as a JSON flag: somebody reading this
    // wants to know why a project they never made is in their list.
    if v.get("implicit").and_then(Value::as_bool) == Some(true) {
        out.push_str(
            "\n  this project was not created by anyone — it is where\n  \
             workspaces opened without a project are kept\n",
        );
    }
    out.trim_end().to_string()
}

pub fn render_projects(v: &Value, next: &str) -> String {
    let rows = match items(v) {
        Some(r) if !r.is_empty() => r,
        _ => return "  no projects".to_string(),
    };
    let mut out = String::new();
    for p in rows {
        let n = p.get("workspaces").and_then(Value::as_i64).unwrap_or(0);
        let mark = if p.get("implicit").and_then(Value::as_bool) == Some(true) {
            "  (unfiled work)"
        } else {
            ""
        };
        out.push_str(&format!(
            "  {:<40}  {:>3} workspace{}  {}{}\n",
            s(p, "name"),
            n,
            if n == 1 { "" } else { "s" },
            s(p, "last_activity_at"),
            mark
        ));
    }
    page_footer(&mut out, v, next);
    out.trim_end().to_string()
}

/// A project's workspaces. Same row shape as `workspace list`, so a reader
/// learns one listing and not two.
pub fn render_paged_workspaces(v: &Value, next: &str) -> String {
    let rows = match items(v) {
        Some(r) if !r.is_empty() => r,
        _ => return "  no workspaces".to_string(),
    };
    let mut out = String::new();
    for w in rows {
        let title = s(w, "objective");
        let intent = s(w, "intent");
        let what = if !intent.is_empty() {
            intent
        } else if !title.is_empty() {
            title
        } else {
            "(untitled)"
        };
        out.push_str(&format!("  {:<36}  {:<9}  {}\n", s(w, "id"), s(w, "status"), what));
    }
    page_footer(&mut out, v, next);
    out.trim_end().to_string()
}

/// One message, sent or read back.
///
/// The first line carries the thing a retrying caller is actually asking: did
/// this create a message, or did it find the one I already sent? `(already
/// sent)` is printed rather than left to be inferred from a timestamp,
/// because a script that cannot tell the difference will send a third.
pub fn render_message(v: &Value) -> String {
    let mut out = String::new();
    let dup = v.get("duplicate").and_then(Value::as_bool) == Some(true);
    out.push_str(&format!(
        "  {}  {}{}\n",
        if dup { "already sent" } else { "sent" },
        s(v, "id"),
        if dup { "  (no second message was created)" } else { "" }
    ));
    opt_line(&mut out, "workspace", s(v, "workspace_id"));
    // The workspace's status after the send, so `message create` answers
    // "did it wake?" without a second call to `workspace status`.
    opt_line(&mut out, "state", s(v, "workspace_status"));
    opt_line(&mut out, "key", s(v, "message_id"));
    opt_line(&mut out, "model", s(v, "model"));
    opt_line(&mut out, "at", s(v, "created_at"));
    let text = s(v, "text");
    if !text.is_empty() {
        for (i, l) in text.lines().enumerate() {
            out.push_str(&format!("  {:<10} {}\n", if i == 0 { "text" } else { "" }, l));
        }
    }
    out.trim_end().to_string()
}

/// One section: id first, because filing a workspace needs it and a create is
/// usually the call right before a move.
pub fn render_section(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<10} {}\n", "id", s(v, "id")));
    opt_line(&mut out, "name", s(v, "name"));
    opt_line(&mut out, "emoji", s(v, "emoji"));
    let n = v.get("workspace_count").and_then(|c| c.as_i64()).unwrap_or(0);
    opt_line(&mut out, "holds", &format!("{n}"));
    out.trim_end().to_string()
}

/// The caller's sections, in sidebar order, with the emoji leading because
/// that is how people recognise them. The count is of the caller's own
/// workspaces in each — a section is personal, so an org-wide count would be
/// a number nobody can act on.
pub fn render_sections(v: &Value) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no sections".to_string(),
    };
    let mut out = String::new();
    for sec in rows {
        let emoji = s(sec, "emoji");
        let label = if emoji.is_empty() {
            s(sec, "name").to_string()
        } else {
            format!("{emoji} {}", s(sec, "name"))
        };
        let n = sec.get("workspace_count").and_then(|c| c.as_i64()).unwrap_or(0);
        out.push_str(&format!(
            "  {:<36}  {:<24}  {}\n",
            s(sec, "id"),
            label,
            match n {
                1 => "1 workspace".to_string(),
                n => format!("{n} workspaces"),
            }
        ));
    }
    out.trim_end().to_string()
}

/// What a delete did. Leads with the unfiling rather than the deletion,
/// because the workspaces are the part the reader cares about not having lost.
pub fn render_deleted_section(v: &Value) -> String {
    let n = v.get("unfiled").and_then(|c| c.as_i64()).unwrap_or(0);
    let name = s(v, "name");
    if n == 0 {
        return format!("  deleted {name} — it was empty");
    }
    format!(
        "  deleted {name} — {n} workspace{} unfiled, none deleted",
        if n == 1 { "" } else { "s" }
    )
}

/// Where a workspace landed, in words, so the move is confirmed without the
/// reader having to turn a section id back into a name.
pub fn render_moved_workspace(v: &Value) -> String {
    let id = s(v, "id");
    match s(v, "section") {
        "" => format!("  {id} is no longer in a section"),
        name => format!("  {id} → {name}"),
    }
}

pub fn render_models(v: &Value) -> String {
    let rows = match v.get("models").and_then(|m| m.as_array()) {
        Some(r) if !r.is_empty() => r,
        _ => return "  no models".to_string(),
    };
    let mut out = String::new();
    for m in rows {
        let available = m.get("available").and_then(|a| a.as_bool()).unwrap_or(false);
        out.push_str(&format!(
            "  {:<32} {:<10} {:<8} {}\n",
            s(m, "id"),
            s(m, "provider"),
            s(m, "tier"),
            if available { "key configured" } else { "no key" }
        ));
    }
    let default = s(v, "default_provider");
    if !default.is_empty() {
        out.push_str(&format!("  default provider: {default}\n"));
    }
    let catalog = s(v, "catalog_url");
    if !catalog.is_empty() {
        out.push_str(&format!("  full catalog: {catalog}\n"));
    }
    out.trim_end().to_string()
}

pub fn render_whoami(v: &Value) -> String {
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    let org = v.get("org").cloned().unwrap_or(Value::Null);
    let key = v.get("key").cloned().unwrap_or(Value::Null);
    let mut out = String::new();
    let login = s(&user, "login");
    let user_line = if login.is_empty() {
        s(&user, "id").to_string()
    } else {
        format!("{login} ({})", s(&user, "id"))
    };
    out.push_str(&format!("  {:<10} {}\n", "user", user_line));
    out.push_str(&format!("  {:<10} {} ({})\n", "org", s(&org, "slug"), s(&org, "name")));
    let kind = s(&key, "kind");
    let label = s(&key, "label");
    let key_line = if label.is_empty() {
        kind.to_string()
    } else {
        format!("{kind} \"{label}\"")
    };
    out.push_str(&format!("  {:<10} {}\n", "key", key_line));
    let unrestricted = key.get("unrestricted").and_then(|u| u.as_bool()).unwrap_or(false);
    let scopes: Vec<&str> = key
        .get("scopes")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let scope_line = if unrestricted {
        "unrestricted (a person's token)".to_string()
    } else if scopes.is_empty() {
        "none".to_string()
    } else {
        scopes.join(", ")
    };
    out.push_str(&format!("  {:<10} {}\n", "scopes", scope_line));
    opt_line(&mut out, "agent", s(&key, "agent"));
    opt_line(&mut out, "token", s(v, "token_source"));
    opt_line(&mut out, "origin", s(v, "origin"));
    out.trim_end().to_string()
}

// ─── Routines ───────────────────────────────────────────────────────────────

/// One trigger, in the words it was asked for rather than as its stored json:
/// `schedule Mon–Fri at 09:00 UTC`, not `{"days":[1,2,3,4,5],…}`.
pub fn describe_trigger(t: &Value) -> String {
    let config = t.get("config").cloned().unwrap_or(Value::Null);
    match s(t, "kind") {
        "schedule" => {
            let days: Vec<i64> = config
                .get("days")
                .and_then(|d| d.as_array())
                .map(|a| a.iter().filter_map(|d| d.as_i64()).collect())
                .unwrap_or_default();
            format!(
                "schedule   {} at {} {}",
                describe_days(&days),
                s(&config, "at"),
                match s(&config, "tz") {
                    "" => "UTC",
                    tz => tz,
                }
            )
        }
        "webhook" => {
            let filters = config
                .get("filters")
                .and_then(|f| f.as_object())
                .map(|m| {
                    let mut parts: Vec<String> = m
                        .iter()
                        .map(|(field, spec)| {
                            let op = match s(spec, "op") {
                                "" => "is",
                                op => op,
                            };
                            format!("{field} {op} {}", s(spec, "value"))
                        })
                        .collect();
                    parts.sort();
                    parts.join(", ")
                })
                .unwrap_or_default();
            if filters.is_empty() {
                "webhook    any event".to_string()
            } else {
                format!("webhook    {filters}")
            }
        }
        other => format!("{other}  {config}"),
    }
}

/// A weekday set as a person would say it. The common runs get their names
/// back — a routine listed as `1,2,3,4,5` is one nobody can check at a glance.
fn describe_days(days: &[i64]) -> String {
    const NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let mut sorted: Vec<i64> = days.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    match sorted.as_slice() {
        [1, 2, 3, 4, 5] => "Mon–Fri".to_string(),
        [6, 7] => "weekends".to_string(),
        [1, 2, 3, 4, 5, 6, 7] => "every day".to_string(),
        rest => rest
            .iter()
            .filter_map(|d| NAMES.get((*d as usize).saturating_sub(1)))
            .copied()
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// One routine in full, triggers included.
///
/// The webhook URL appears here only on the call that minted it, because that
/// is the only call that has it — afterwards the server holds a hash and
/// cannot print it again. The line says so, so a reader who skipped the
/// release notes still learns it from the output they are looking at.
pub fn render_routine(v: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("  {:<10} {}\n", "id", s(v, "id")));
    opt_line(&mut out, "name", s(v, "name"));
    opt_line(&mut out, "repo", s(v, "repo"));
    opt_line(&mut out, "agent", s(v, "agent"));
    opt_line(&mut out, "model", s(v, "model"));
    opt_line(&mut out, "effort", s(v, "effort"));
    out.push_str(&format!(
        "  {:<10} {}\n",
        "state",
        if v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true) {
            "enabled"
        } else {
            "disabled"
        }
    ));
    let runs = v.get("run_count").and_then(|c| c.as_i64()).unwrap_or(0);
    opt_line(&mut out, "runs", &format!("{runs}"));
    opt_line(&mut out, "last run", s(v, "last_fired_at"));

    if let Some(triggers) = v.get("triggers").and_then(|t| t.as_array()) {
        if triggers.is_empty() {
            // Worth saying out loud: a routine with no trigger is a saved
            // prompt that will never run on its own, which is a reasonable
            // thing to have and a terrible thing to think you have by mistake.
            out.push_str(&format!(
                "  {:<10} none — this routine only runs when you run it\n",
                "triggers"
            ));
        } else {
            for (i, t) in triggers.iter().enumerate() {
                let label = if i == 0 { "triggers" } else { "" };
                out.push_str(&format!("  {label:<10} {}\n", describe_trigger(t)));
            }
        }
    }

    let prompt = s(v, "prompt");
    if !prompt.is_empty() {
        out.push_str(&format!("  {:<10} {}\n", "prompt", first_line(prompt)));
    }

    if let Some(url) = v.get("webhook_url").and_then(|u| u.as_str()) {
        out.push('\n');
        out.push_str("  webhook (shown once — the server keeps only a hash):\n");
        out.push_str(&format!("    {url}\n"));
        if let Some(secret) = v.get("webhook_secret").and_then(|s| s.as_str()) {
            out.push_str(&format!(
                "    or POST to /hooks/routine/{} with header X-Aura-Routine-Secret: {secret}\n",
                s(v, "id")
            ));
        }
    } else if v
        .get("webhook_configured")
        .and_then(|w| w.as_bool())
        .unwrap_or(false)
    {
        out.push_str("  webhook    configured — `aura routine rotate-secret` for a new URL\n");
    }
    out.trim_end().to_string()
}

/// A prompt's first line, shortened. The whole body belongs in `--json`; a
/// list that wrapped a paragraph per row would hide the ids underneath it.
fn first_line(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    let mut out: String = line.chars().take(70).collect();
    if line.chars().count() > 70 || prompt.lines().count() > 1 {
        out.push('…');
    }
    out
}

pub fn render_routines(v: &Value) -> String {
    let rows = match v.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return "  no routines".to_string(),
    };
    let mut out = String::new();
    for r in rows {
        let triggers = r
            .get("triggers")
            .and_then(|t| t.as_array())
            .map(|a| {
                a.iter()
                    .map(|t| s(t, "kind").to_string())
                    .collect::<Vec<_>>()
                    .join("+")
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "manual".to_string());
        let state = if r.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true) {
            ""
        } else {
            "  (disabled)"
        };
        out.push_str(&format!(
            "  {:<36}  {:<24}  {}{}\n",
            s(r, "id"),
            s(r, "name"),
            triggers,
            state
        ));
    }
    out.trim_end().to_string()
}

/// What a fire did — or, just as often, why it did not. A `fired: false` is a
/// normal answer here, so the reason is the headline rather than a footnote.
pub fn render_fired_routine(v: &Value) -> String {
    let name = s(v, "routine");
    if v.get("fired").and_then(|f| f.as_bool()).unwrap_or(false) {
        let mut out = format!("  {name} ran\n");
        opt_line(&mut out, "workspace", s(v, "workspace_id"));
        opt_line(&mut out, "run", s(v, "run_id"));
        return out.trim_end().to_string();
    }
    match s(v, "reason") {
        "" => format!("  {name} did not run"),
        why => format!("  {name} did not run — {why}"),
    }
}

pub fn render_rotated_secret(v: &Value) -> String {
    let mut out = format!(
        "  new webhook for {} — the old URL no longer works\n",
        s(v, "name")
    );
    out.push_str("  shown once; the server keeps only a hash:\n");
    out.push_str(&format!("    {}\n", s(v, "webhook_url")));
    out.trim_end().to_string()
}

/// What a routine delete did, said precisely: the run log goes with the
/// definition, the work does not. An earlier draft of this line read "4 runs
/// kept", which was wrong — the `routine_runs` rows cascade — and a reader who
/// believed it would go looking for a history that is not there.
pub fn render_deleted_routine(v: &Value) -> String {
    let runs = v.get("runs").and_then(|c| c.as_i64()).unwrap_or(0);
    let name = s(v, "name");
    if runs == 0 {
        return format!("  deleted {name} — it had never run");
    }
    format!(
        "  deleted {name} — it had run {runs} time{}; those workspaces are untouched",
        if runs == 1 { "" } else { "s" }
    )
}
