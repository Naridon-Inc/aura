//! `aura acp-serve` with an engine: Aura in front of any ACP agent.
//!
//! The client talks to Aura; Aura relays the conversation to the engine
//! through the `aura acp-proxy` guard (snapshots, an intent per turn, the
//! gate on permission requests) and adds itself on top:
//!
//!   - `initialize` comes back introducing Aura, the engine named in the
//!     title and its own `agentInfo` kept under `_meta.aura.engine`;
//!   - every session is offered Aura's `/prove`, `/review` and `/impacts`
//!     alongside the engine's own commands, and those three are answered
//!     by Aura as local, cancellable turns the engine never sees;
//!   - everything else passes through as the proxy passes it.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aura_acp::registry::{self, Availability, Probe, Registry};
use serde_json::{json, Value};

use super::extract_prompt_text;
use super::local::{self, LocalTurns, Out};
use crate::acp_proxy::{self, Effects, Filter, Guard, LiveEffects, Step, To};

/// The agent Aura relays conversation to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Engine {
    /// Who rows are attributed to, and what the client is told sits behind
    /// Aura: the registry id, or the program's name.
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Which engine to run, if any: `-- <cmd>` first, then `--agent <id>`, then
/// `AURA_ACP_AGENT`. `Ok(None)` is tool-only mode.
pub(crate) fn resolve(agent: Option<&str>, cmd: &[String]) -> Result<Option<Engine>, String> {
    if let Some((program, args)) = cmd.split_first() {
        let label = Path::new(program)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| program.clone());
        return Ok(Some(Engine { label, program: program.clone(), args: args.to_vec(), env: BTreeMap::new() }));
    }
    let named = agent
        .map(str::to_string)
        .or_else(|| std::env::var("AURA_ACP_AGENT").ok())
        .filter(|a| !a.trim().is_empty());
    let Some(id) = named else { return Ok(None) };
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let which = |name: &str| registry::find_in_path(name, &path);
    from_registry(&id, &load_registry(&home), &Probe { home: &home, which: &which }).map(Some)
}

/// The registry the desktop app keeps fresh at `~/.aura/acp/registry.json`,
/// over the snapshot built in.
fn load_registry(home: &Path) -> Registry {
    let cached = std::fs::read_to_string(home.join(".aura").join("acp").join("registry.json"))
        .ok()
        .and_then(|raw| Registry::parse(&raw).ok());
    Registry::merged(cached)
}

/// Resolve `id` (a registry id like `gemini`, or Aura's own name for one
/// like `qwen`) to something runnable here.
pub(crate) fn from_registry(id: &str, reg: &Registry, probe: &Probe<'_>) -> Result<Engine, String> {
    let entry = reg
        .get(id)
        .or_else(|| registry::registry_ids_for(id).into_iter().find_map(|r| reg.get(r)))
        .ok_or_else(|| {
            let mut known: Vec<&str> = reg.agents.iter().map(|a| a.id.as_str()).collect();
            known.sort_unstable();
            format!("no ACP agent `{id}` in the registry. Known: {}", known.join(", "))
        })?;
    match registry::resolve(entry, probe) {
        Availability::Ready { launch } => Ok(Engine {
            label: launch.registry_id.clone(),
            program: launch.program.to_string_lossy().to_string(),
            args: launch.args,
            env: launch.env,
        }),
        Availability::Installable { .. } => Err(format!(
            "{} is not installed here. Install it from Settings → Agents in the Aura app, or put its CLI on PATH.",
            entry.name
        )),
        Availability::Unavailable { reason } => Err(reason),
    }
}

/// Serve the client on this process's stdio with `engine` behind Aura.
/// Returns the exit code: the engine's, or 127 when it could not start.
pub(crate) fn serve(engine: Engine) -> i32 {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aura acp-serve: cannot find the aura binary to record with: {e}");
            return 1;
        }
    };
    let child = match acp_proxy::spawn_with(&engine.program, &engine.args, &engine.env) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura acp-serve: failed to start {} (`{}`): {e}", engine.label, engine.program);
            return 127;
        }
    };
    let out: Out = Arc::new(Mutex::new(io::stdout()));
    let front = Front::new(Guard::new(LiveEffects::new(engine.label.clone(), exe)), LocalTurns::new(out.clone()), engine.label);
    match acp_proxy::relay(BufReader::new(io::stdin()), out, child, front) {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("aura acp-serve: {e}");
            1
        }
    }
}

/// Aura's layer over the proxy guard.
pub(crate) struct Front<E> {
    guard: Guard<E>,
    local: LocalTurns,
    engine: String,
    /// `initialize` requests waiting for the engine's answer.
    init: Vec<String>,
    /// `session/new` / `session/load` requests waiting for their answer,
    /// with the session a load names (a load's answer does not repeat it).
    opening: HashMap<String, Option<String>>,
    /// The engine's own commands, per session, as it last advertised them.
    engine_commands: HashMap<String, Vec<Value>>,
}

impl<E: Effects> Front<E> {
    pub(crate) fn new(guard: Guard<E>, local: LocalTurns, engine: String) -> Self {
        Self { guard, local, engine, init: Vec::new(), opening: HashMap::new(), engine_commands: HashMap::new() }
    }
}

impl<E: Effects + 'static> Filter for Front<E> {
    fn from_client(&mut self, frame: &str) -> Step {
        let Ok(msg) = serde_json::from_str::<Value>(frame.trim()) else {
            return self.guard.from_client(frame);
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let sid = msg.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        match (method, msg.get("id")) {
            ("session/prompt", Some(id)) => {
                if local::own_command(&extract_prompt_text(&msg)).is_some() {
                    self.local.start(id.clone(), sid, extract_prompt_text(&msg));
                    return Step { pass: false, extra: Vec::new() };
                }
            }
            ("session/cancel", None) if self.local.is_running(&sid) => {
                self.local.cancel(&sid);
                return Step { pass: false, extra: Vec::new() };
            }
            ("initialize", Some(id)) => self.init.push(id.to_string()),
            ("session/new", Some(id)) => {
                self.opening.insert(id.to_string(), None);
            }
            ("session/load", Some(id)) => {
                self.opening.insert(id.to_string(), Some(sid));
            }
            _ => {}
        }
        self.guard.from_client(frame)
    }

    fn from_agent(&mut self, frame: &str) -> Step {
        let mut step = self.guard.from_agent(frame);
        if !step.pass {
            return step;
        }
        let Ok(msg) = serde_json::from_str::<Value>(frame.trim()) else { return step };
        let is_response = msg.get("method").is_none();
        let id = msg.get("id").map(Value::to_string).unwrap_or_default();

        if is_response && !id.is_empty() {
            if let Some(i) = self.init.iter().position(|k| *k == id) {
                self.init.remove(i);
                if msg.get("result").is_some() {
                    step.pass = false;
                    step.extra.insert(0, To::Client(introduce(msg, &self.engine).to_string()));
                }
                return step;
            }
            if let Some(load_sid) = self.opening.remove(&id) {
                let sid = msg
                    .pointer("/result/sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(load_sid);
                if let (Some(sid), true) = (sid, msg.get("result").is_some()) {
                    let theirs = self.engine_commands.get(&sid).cloned().unwrap_or_default();
                    step.extra.push(To::Client(local::available_commands(&sid, &theirs).to_string()));
                }
                return step;
            }
        }

        if msg.get("method").and_then(Value::as_str) == Some("session/update")
            && msg.pointer("/params/update/sessionUpdate").and_then(Value::as_str) == Some("available_commands_update")
        {
            let sid = msg.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            let theirs = msg
                .pointer("/params/update/availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let merged = local::available_commands(&sid, &theirs);
            self.engine_commands.insert(sid, theirs);
            step.pass = false;
            step.extra.insert(0, To::Client(merged.to_string()));
        }
        step
    }
}

/// The engine's `initialize` answer, introducing Aura instead.
fn introduce(mut msg: Value, engine: &str) -> Value {
    let theirs = msg.pointer("/result/agentInfo").cloned().unwrap_or(Value::Null);
    let name = theirs
        .get("title")
        .or_else(|| theirs.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(engine)
        .to_string();
    if let Some(result) = msg.get_mut("result").and_then(Value::as_object_mut) {
        result.insert(
            "agentInfo".into(),
            json!({ "name": "aura", "title": format!("Aura · {name}"), "version": env!("CARGO_PKG_VERSION") }),
        );
        let meta = result.entry("_meta").or_insert_with(|| json!({}));
        if let Some(meta) = meta.as_object_mut() {
            meta.insert("aura".into(), json!({ "engine": theirs }));
        }
    }
    msg
}
