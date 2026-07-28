//! `GenericCliProvider` — the plumbing that lets `~/.aura/agents.toml`
//! declare a brand-new agent without recompiling. Each TOML entry is a
//! template: bin path + arg patterns per mode, with `{prompt}` and
//! `{resume}` placeholders the loader expands at invoke time.
//!
//! This is also the migration path for vendors that ship a wildly
//! different argv shape — power users override the compiled-in entry
//! by declaring a new entry with the same `id`, and `Registry::push`
//! replaces it.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenericProviderConfig {
    pub id: String,
    pub label: String,
    pub bin: String,
    /// Default arg template, used when no mode-specific override is set.
    /// Tokens: `{prompt}`, `{resume}`. `{resume}` expands to nothing
    /// when `resume_session_id` is None.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub args_oneshot: Option<Vec<String>>,
    #[serde(default)]
    pub args_stream: Option<Vec<String>>,
    #[serde(default)]
    pub args_pty: Option<Vec<String>>,
    #[serde(default)]
    pub classifier_prefs: Vec<ClassifierPref>,
    #[serde(default)]
    pub cost_per_1k_in: Option<f64>,
    #[serde(default)]
    pub cost_per_1k_out: Option<f64>,
    #[serde(default)]
    pub supports_stream: bool,
    #[serde(default)]
    pub supports_pty: bool,
    #[serde(default)]
    pub supports_resume: bool,
    #[serde(default)]
    pub stdout_is_stream_json: bool,
    /// Extra env vars to set on every spawn.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifierPref {
    pub keyword: String,
    pub score: i32,
}

pub struct GenericCliProvider {
    cfg: GenericProviderConfig,
    /// Built once at construction so `classifier_prefs()` can return a
    /// borrowed slice with the right lifetime.
    prefs_cache: Vec<(String, i32)>,
    prefs_view: Vec<(&'static str, i32)>,
}

impl GenericCliProvider {
    pub fn new(cfg: GenericProviderConfig) -> Self {
        let prefs_cache: Vec<(String, i32)> = cfg
            .classifier_prefs
            .iter()
            .map(|p| (p.keyword.clone(), p.score))
            .collect();
        // Leak each keyword to obtain a `&'static str`. This is fine —
        // providers live for the process lifetime, and the leak budget
        // is bounded by the number of entries in agents.toml (tens, not
        // millions). Avoids needing a self-referential struct.
        let prefs_view: Vec<(&'static str, i32)> = prefs_cache
            .iter()
            .map(|(kw, score)| (Box::leak(kw.clone().into_boxed_str()) as &'static str, *score))
            .collect();
        Self {
            cfg,
            prefs_cache,
            prefs_view,
        }
    }

    fn pick_template(&self, mode: InvokeMode) -> &[String] {
        match mode {
            InvokeMode::OneShot => self.cfg.args_oneshot.as_deref(),
            InvokeMode::StreamJson => self.cfg.args_stream.as_deref(),
            InvokeMode::PtyRepl => self.cfg.args_pty.as_deref(),
        }
        .unwrap_or(&self.cfg.args)
    }
}

impl AgentProvider for GenericCliProvider {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn label(&self) -> &str {
        &self.cfg.label
    }

    fn bin_name(&self) -> &str {
        &self.cfg.bin
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            stream: self.cfg.supports_stream,
            pty: self.cfg.supports_pty,
            resume: self.cfg.supports_resume,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        match (self.cfg.cost_per_1k_in, self.cfg.cost_per_1k_out) {
            (Some(i), Some(o)) => Some(CostPer1k {
                input_usd: i,
                output_usd: o,
            }),
            _ => None,
        }
    }

    fn classifier_prefs(&self) -> &[(&str, i32)] {
        &self.prefs_view
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        let template = self.pick_template(req.mode);
        // An empty template is meaningful for the interactive REPL: many CLIs
        // (Aider, Amp…) take the prompt in their own TUI, so `<bin>` with no
        // args is the correct launch. For the headless modes
        // an empty template means we have no verified way to pass the prompt —
        // surface that as a plain, user-facing hint rather than spawning a bin
        // that would silently ignore it.
        if template.is_empty() {
            let env: Vec<(String, String)> =
                self.cfg.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            return match req.mode {
                InvokeMode::PtyRepl => Ok(Invocation {
                    bin: self.cfg.bin.clone(),
                    args: vec![],
                    env,
                    stdout_is_stream_json: false,
                }),
                InvokeMode::OneShot | InvokeMode::StreamJson => Err(format!(
                    "{} is an interactive CLI — open it in a terminal tab instead of the chat stream.",
                    self.cfg.label
                )),
            };
        }
        let mut args: Vec<String> = Vec::with_capacity(template.len());
        for tok in template {
            if tok == "{prompt}" {
                args.push(req.plan_steered_prompt());
            } else if tok == "{resume}" {
                if let Some(sid) = req.resume_session_id {
                    args.push(sid.into());
                }
                // else: drop the placeholder entirely
            } else {
                args.push(tok.clone());
            }
        }
        let env: Vec<(String, String)> =
            self.cfg.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        Ok(Invocation {
            bin: self.cfg.bin.clone(),
            args,
            env,
            stdout_is_stream_json: self.cfg.stdout_is_stream_json,
        })
    }
}

// Silence "field never read" — `prefs_cache` keeps the source strings
// alive so `prefs_view`'s `&'static str` references remain valid for
// the provider's lifetime even after Box::leak (technically the leaked
// allocation is the keep-alive, but holding the cache mirrors the
// invariant for clarity and debug printing).
impl GenericCliProvider {
    #[allow(dead_code)]
    fn _keep_cache(&self) -> &[(String, i32)] {
        &self.prefs_cache
    }
}
