//! The questions an ACP agent asks in the middle of a turn, put to the
//! person through Aura's one prompt queue (the same cards that approve a
//! Claude tool call): tool permission, form and URL elicitation, sign-in.
//!
//! Every agent request stays open here until the person answers, the turn
//! is cancelled, or the turn ends; each one gets exactly one reply.

use crate::cmd_permission::{emit_prompt, PendingPrompt, PermissionDecision, PermissionRegistry, PermissionResponse};
use aura_acp::elicit::{self, Answer, Elicitation};
use aura_acp::permission::{self, PermissionOption};
use aura_acp::profile::{is_unsafe_auth_env, AuthKind, AuthMethod};
use aura_acp::registry::{Launch, LaunchSource};
use aura_acp::RpcError;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

/// The tool names the chat renders as ACP cards.
pub(super) const SIGN_IN: &str = "AcpSignIn";
pub(super) const ELICIT_FORM: &str = "AcpElicitation";
pub(super) const ELICIT_URL: &str = "AcpOpenUrl";

/// A reply that is ready to go back to the agent.
pub(super) struct Reply {
    pub remote: Value,
    pub result: Result<Value, RpcError>,
}

#[derive(Clone, Copy, PartialEq)]
enum Waiting {
    Permission,
    Elicitation,
}

struct Open {
    remote: Value,
    local: String,
    kind: Waiting,
}

pub(super) struct Gate {
    app: AppHandle,
    channel: String,
    open: Vec<Open>,
    tx: mpsc::UnboundedSender<Reply>,
    pub replies: mpsc::UnboundedReceiver<Reply>,
    tasks: JoinSet<()>,
    shown: Vec<String>,
}

fn ask(app: &AppHandle, channel: &str, prompt_id: &str, tool: &str, input: Value) -> oneshot::Receiver<PermissionResponse> {
    let meta = PendingPrompt {
        prompt_id: prompt_id.to_string(),
        channel: channel.to_string(),
        tool_name: tool.to_string(),
        input,
        ts: chrono::Utc::now().timestamp(),
    };
    let rx = app.state::<PermissionRegistry>().enqueue(meta.clone());
    emit_prompt(app, &meta);
    rx
}

fn close_card(app: &AppHandle, prompt_id: &str) {
    app.state::<PermissionRegistry>().cancel_prompt(prompt_id);
    let _ = app.emit("permission:closed", json!({ "prompt_id": prompt_id }));
}

/// The option the person picked, matched by exact id; a bare Allow / Deny
/// falls back to the first option of exactly the matching once-kind.
pub(super) fn permission_reply(options: &[PermissionOption], response: Option<PermissionResponse>) -> Value {
    let Some(r) = response else { return permission::cancelled() };
    let selected = r.updated_input.as_ref().and_then(|i| i.get("_acp_option_id")).and_then(Value::as_str);
    let fallback = match r.decision {
        PermissionDecision::Allow => "allow_once",
        PermissionDecision::AllowAlways => "allow_always",
        PermissionDecision::Deny => "reject_once",
    };
    permission::outcome(options, selected, fallback)
}

/// `[{name, selected, text}]` as the elicitation card sends it.
pub(super) fn answers(input: Option<&Value>) -> Vec<(String, Answer)> {
    input
        .and_then(|i| i.get("_acp_answers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?.to_string();
            let selected = a
                .get("selected")
                .and_then(Value::as_array)
                .map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let text = a.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
            Some((name, Answer { selected, text }))
        })
        .collect()
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:@%+,".contains(&b)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// A terminal sign-in as one shell line: the agent's own program with the
/// method's arguments. Env the launch-safety rules hold back (PATH, loader
/// and interpreter hooks, proxies, TLS trust) is left out and named instead.
pub(super) fn terminal_command(launch: &Launch, args: &[String], env: &std::collections::BTreeMap<String, String>) -> (String, Vec<String>) {
    let mut blocked = Vec::new();
    let mut parts = Vec::new();
    for (k, v) in launch.env.iter().chain(env.iter()) {
        if is_unsafe_auth_env(k) || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            blocked.push(k.clone());
        } else {
            parts.push(format!("{k}={}", shell_quote(v)));
        }
    }
    parts.push(shell_quote(&launch.program.to_string_lossy()));
    // A uvx launch is `uvx --from <pkg> <name> …`; keep the package part.
    if launch.source == LaunchSource::Uvx {
        parts.extend(launch.args.iter().take(3).map(|a| shell_quote(a)));
    }
    parts.extend(args.iter().map(|a| shell_quote(a)));
    blocked.sort();
    blocked.dedup();
    (parts.join(" "), blocked)
}

pub(super) fn sign_in_input(agent: &str, detail: &str, launch: &Launch, methods: &[AuthMethod]) -> Value {
    let rows: Vec<Value> = methods
        .iter()
        .map(|m| {
            let (command, blocked) = match &m.kind {
                AuthKind::Terminal { args, env } => {
                    let (c, b) = terminal_command(launch, args, env);
                    (Some(c), b)
                }
                AuthKind::Agent => (None, Vec::new()),
            };
            json!({
                "id": m.id,
                "name": m.name,
                "description": m.description,
                "terminal": m.is_terminal(),
                "command": command,
                "blocked_env": blocked,
            })
        })
        .collect();
    json!({ "agent": agent, "detail": detail, "methods": rows })
}

/// What the person chose on the sign-in card.
#[derive(Debug, PartialEq)]
pub(super) enum SignIn {
    /// Sign in over the protocol with this method.
    Method(String),
    /// They are signing in from a terminal the card opened.
    InTerminal,
    Declined,
}

pub(super) fn sign_in_choice(methods: &[AuthMethod], response: Option<PermissionResponse>) -> SignIn {
    let Some(r) = response else { return SignIn::Declined };
    if matches!(r.decision, PermissionDecision::Deny) {
        return SignIn::Declined;
    }
    let picked = r.updated_input.as_ref().and_then(|i| i.get("_acp_method_id")).and_then(Value::as_str);
    match picked.and_then(|id| methods.iter().find(|m| m.id == id)) {
        Some(m) if m.is_terminal() => SignIn::InTerminal,
        Some(m) => SignIn::Method(m.id.clone()),
        None => SignIn::Declined,
    }
}

/// Put one elicitation to the person and wait for the ACP result. A form
/// that does not validate is asked again with the problem on it, until it
/// does or is declined; a link is opened in the browser once they agree.
/// Shared by the chat and by every hosted brain, so a form looks and
/// behaves the same wherever the agent asks it.
async fn answer_elicitation(app: AppHandle, channel: String, prompt_id: String, req: Elicitation) -> Value {
    match req {
        Elicitation::Form { message, fields, .. } => {
            let mut input = json!({ "mode": "form", "message": message, "fields": fields, "error": null });
            let mut rx = ask(&app, &channel, &prompt_id, ELICIT_FORM, input.clone());
            loop {
                let Some(resp) = rx.await.ok() else { return elicit::cancel() };
                if matches!(resp.decision, PermissionDecision::Deny) {
                    return elicit::decline();
                }
                match elicit::content(&fields, &answers(resp.updated_input.as_ref())) {
                    Ok(content) => return elicit::accept(Some(content)),
                    Err(problem) => {
                        input["error"] = json!(problem);
                        rx = ask(&app, &channel, &prompt_id, ELICIT_FORM, input.clone());
                    }
                }
            }
        }
        Elicitation::Url { url, host, suspicious, message, .. } => {
            let input = json!({ "mode": "url", "url": url, "host": host, "suspicious": suspicious, "message": message });
            let rx = ask(&app, &channel, &prompt_id, ELICIT_URL, input);
            match rx.await.ok() {
                None => elicit::cancel(),
                Some(resp) if matches!(resp.decision, PermissionDecision::Deny) => elicit::decline(),
                Some(_) => match app.opener().open_url(&url, None::<String>) {
                    Ok(()) => elicit::accept(None),
                    Err(e) => {
                        eprintln!("[acp] could not open {host}: {e}");
                        elicit::cancel()
                    }
                },
            }
        }
    }
}

/// [`answer_elicitation`] for a hosted brain's agent, straight from the
/// request's params. A request that cannot be shown is the agent's error.
pub(crate) async fn elicit_for_brain(app: AppHandle, channel: String, params: &Value) -> Result<Value, RpcError> {
    let req = Elicitation::parse(params)?;
    let prompt_id = format!("elicit-{}", uuid::Uuid::new_v4());
    Ok(answer_elicitation(app, channel, prompt_id, req).await)
}

impl Gate {
    pub fn new(app: AppHandle, channel: &str) -> Self {
        let (tx, replies) = mpsc::unbounded_channel();
        Gate { app, channel: channel.to_string(), open: Vec::new(), tx, replies, tasks: JoinSet::new(), shown: Vec::new() }
    }

    fn track(&mut self, remote: Value, local: String, kind: Waiting) {
        self.open.push(Open { remote, local, kind });
    }

    /// `session/request_permission`.
    pub fn permission(&mut self, remote: Value, params: &Value) {
        let options = PermissionOption::parse_list(params);
        let local = format!("perm-{}", uuid::Uuid::new_v4());
        let tool = params.pointer("/toolCall/title").and_then(Value::as_str).unwrap_or("Agent action");
        let input = json!({ "action": params["toolCall"], "_acp_options": params["options"] });
        let rx = ask(&self.app, &self.channel, &local, tool, input);
        self.track(remote.clone(), local, Waiting::Permission);
        let tx = self.tx.clone();
        self.tasks.spawn(async move {
            let outcome = permission_reply(&options, rx.await.ok());
            let _ = tx.send(Reply { remote, result: Ok(permission::result(outcome)) });
        });
    }

    /// `elicitation/create`. A malformed request is answered at once.
    pub fn elicitation(&mut self, remote: Value, params: &Value) -> Option<Reply> {
        let req = match Elicitation::parse(params) {
            Ok(r) => r,
            Err(e) => return Some(Reply { remote, result: Err(e) }),
        };
        let local = format!("elicit-{}", uuid::Uuid::new_v4());
        let (app, channel, tx) = (self.app.clone(), self.channel.clone(), self.tx.clone());
        let (id, r) = (local.clone(), remote.clone());
        self.tasks.spawn(async move {
            let reply = answer_elicitation(app, channel, id, req).await;
            let _ = tx.send(Reply { remote: r, result: Ok(reply) });
        });
        self.track(remote, local, Waiting::Elicitation);
        None
    }

    /// Put up the sign-in card. The card is closed with the turn.
    pub fn sign_in(&mut self, input: Value) -> oneshot::Receiver<PermissionResponse> {
        let local = format!("signin-{}", uuid::Uuid::new_v4());
        let rx = ask(&self.app, &self.channel, &local, SIGN_IN, input);
        self.shown.push(local);
        rx
    }

    /// Mark a reply as sent. False when the request was already answered
    /// (a cancel got there first), so the caller must not reply again.
    pub fn resolve(&mut self, remote: &Value) -> bool {
        let Some(i) = self.open.iter().position(|o| &o.remote == remote) else { return false };
        let o = self.open.remove(i);
        close_card(&self.app, &o.local);
        true
    }

    /// The turn was cancelled: every open request gets its cancelled reply.
    pub fn cancel_all(&mut self) -> Vec<Reply> {
        self.tasks.abort_all();
        std::mem::take(&mut self.open)
            .into_iter()
            .map(|o| {
                close_card(&self.app, &o.local);
                let result = match o.kind {
                    Waiting::Permission => permission::result(permission::cancelled()),
                    Waiting::Elicitation => elicit::cancel(),
                };
                Reply { remote: o.remote, result: Ok(result) }
            })
            .collect()
    }

    /// The turn is over: take down every card it put up.
    pub fn close(&mut self) {
        self.tasks.abort_all();
        for o in std::mem::take(&mut self.open) {
            close_card(&self.app, &o.local);
        }
        for id in std::mem::take(&mut self.shown) {
            close_card(&self.app, &id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn opts() -> Vec<PermissionOption> {
        PermissionOption::parse_list(&json!({"options": [
            {"optionId": "scope-session", "name": "Always", "kind": "allow_always"},
            {"optionId": "no", "name": "No", "kind": "reject_once"}
        ]}))
    }

    fn resp(decision: PermissionDecision, input: Option<Value>) -> Option<PermissionResponse> {
        Some(PermissionResponse { decision, updated_input: input })
    }

    #[test]
    fn a_bare_allow_never_becomes_an_always_grant() {
        assert_eq!(permission_reply(&opts(), resp(PermissionDecision::Allow, None)), json!({"outcome": "cancelled"}));
        assert_eq!(
            permission_reply(&opts(), resp(PermissionDecision::Allow, Some(json!({"_acp_option_id": "scope-session"})))),
            json!({"outcome": "selected", "optionId": "scope-session"})
        );
        assert_eq!(
            permission_reply(&opts(), resp(PermissionDecision::Allow, Some(json!({"_acp_option_id": "forged"})))),
            json!({"outcome": "cancelled"})
        );
        assert_eq!(permission_reply(&opts(), resp(PermissionDecision::Deny, None)), json!({"outcome": "selected", "optionId": "no"}));
        assert_eq!(permission_reply(&opts(), None), json!({"outcome": "cancelled"}));
    }

    #[test]
    fn card_answers_parse() {
        let a = answers(Some(&json!({"_acp_answers": [{"name": "env", "selected": ["prod"], "text": ""}, {"text": "no name"}]})));
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].0, "env");
        assert_eq!(a[0].1.selected, vec!["prod".to_string()]);
    }

    fn launch(source: LaunchSource, args: &[&str]) -> Launch {
        Launch {
            registry_id: "kimi".into(),
            program: PathBuf::from("/Users/me/My Tools/kimi"),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::from([("KIMI_HOME".to_string(), "/x y".to_string())]),
            source,
        }
    }

    #[test]
    fn terminal_sign_in_reruns_the_agent_and_holds_back_unsafe_env() {
        let env = BTreeMap::from([("NODE_OPTIONS".to_string(), "--require evil".to_string())]);
        let (cmd, blocked) = terminal_command(&launch(LaunchSource::Path, &["acp"]), &["--login".into()], &env);
        assert_eq!(cmd, "KIMI_HOME='/x y' '/Users/me/My Tools/kimi' --login");
        assert_eq!(blocked, vec!["NODE_OPTIONS".to_string()]);
        let (uvx, _) = terminal_command(&launch(LaunchSource::Uvx, &["--from", "pkg==1", "pkg", "acp"]), &["login".into()], &BTreeMap::new());
        assert!(uvx.ends_with("--from pkg==1 pkg login"), "{uvx}");
    }

    #[test]
    fn sign_in_choice_matches_offered_methods_only() {
        let methods = vec![
            AuthMethod { id: "cursor_login".into(), name: "Cursor".into(), description: None, kind: AuthKind::Agent },
            AuthMethod { id: "login".into(), name: "Terminal".into(), description: None, kind: AuthKind::Terminal { args: vec![], env: BTreeMap::new() } },
        ];
        let pick = |id: &str| resp(PermissionDecision::Allow, Some(json!({"_acp_method_id": id})));
        assert_eq!(sign_in_choice(&methods, pick("cursor_login")), SignIn::Method("cursor_login".into()));
        assert_eq!(sign_in_choice(&methods, pick("login")), SignIn::InTerminal);
        assert_eq!(sign_in_choice(&methods, pick("other")), SignIn::Declined);
        assert_eq!(sign_in_choice(&methods, resp(PermissionDecision::Deny, None)), SignIn::Declined);
        let input = sign_in_input("Kimi", "signed out", &launch(LaunchSource::Path, &["acp"]), &methods);
        assert_eq!(input["methods"][1]["command"], json!("KIMI_HOME='/x y' '/Users/me/My Tools/kimi'"));
        assert_eq!(input["methods"][0]["terminal"], json!(false));
    }
}
