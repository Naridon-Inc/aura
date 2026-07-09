//! Saved prompts — `~/.aura/prompts.json`.
//!
//! Reusable prompt library accessible from the agent Composer via the
//! `/p <name>` slash command. Each entry has a short name, optional
//! agent pin (so a prompt tailored to claude won't appear when the
//! active tab is gemini), the prompt body, and an optional one-line
//! description used in the picker UI.
//!
//! Storage is a flat JSON array under `~/.aura/prompts.json`. Cross-
//! machine sync is left to the user's dotfile/sync setup; the file is
//! plain JSON so it survives the round-trip.
//!
//! Design crib note: the *concept* of a per-shell saved-prompt library
//! is well-trodden (every modern terminal — Warp, Wave, Tabby — ships
//! something similar). This module is a clean-room implementation: the
//! schema, storage, and Tauri surface were designed for Aura's slash-
//! command + Composer flow without reading any specific other project's
//! source. We pin agent identity per entry because Aura's agent picker
//! is dynamic (claude, gemini, codex, cursor, manager, …) — that twist
//! is Aura-native.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPrompt {
    /// Stable id (UUID v4). Generated server-side on first save so the
    /// renderer doesn't need to know about uuid.
    pub id: String,
    /// Short user-facing name. Used as the picker label and the
    /// `/p <name>` argument. Must be non-empty + unique-ish (we don't
    /// enforce uniqueness; collisions just mean the picker shows two
    /// rows with the same label — user picks by description).
    pub name: String,
    /// Optional one-line summary shown under the name in the picker.
    #[serde(default)]
    pub description: String,
    /// The prompt body. Inserted verbatim into the Composer when the
    /// user picks this entry. May contain `{{var}}` placeholders that
    /// the Composer will highlight + tab-cycle through (Stage 2 work,
    /// not implemented in this commit — body is inserted as-is).
    pub body: String,
    /// Optional agent id pin (`"claude"`, `"gemini"`, …). When set,
    /// the picker filters this entry out unless the active tab's
    /// agent matches. `None` = available to every agent.
    #[serde(default)]
    pub agent: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    /// Times this prompt has been picked. Drives "most-used" sort in
    /// the picker.
    #[serde(default)]
    pub usage_count: u64,
}

#[derive(Default)]
pub struct PromptStore {
    write_lock: Mutex<()>,
}

impl PromptStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn store_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("prompts.json");
    Some(p)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_all() -> Vec<SavedPrompt> {
    let Some(path) = store_path() else {
        return vec![];
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return vec![];
    };
    serde_json::from_str::<Vec<SavedPrompt>>(&raw).unwrap_or_default()
}

fn write_all(entries: &[SavedPrompt]) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tempfile: {e}"))?;
        f.write_all(body.as_bytes())
            .map_err(|e| format!("write tempfile: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn prompts_list(
    state: tauri::State<'_, PromptStore>,
    agent: Option<String>,
) -> Result<Vec<SavedPrompt>, String> {
    let _guard = state.write_lock.lock().unwrap();
    let mut all = read_all();
    if let Some(want) = agent.as_deref() {
        all.retain(|p| p.agent.as_deref().map(|a| a == want).unwrap_or(true));
    }
    all.sort_by(|a, b| {
        b.usage_count
            .cmp(&a.usage_count)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    Ok(all)
}

#[tauri::command]
pub async fn prompts_save(
    state: tauri::State<'_, PromptStore>,
    id: Option<String>,
    name: String,
    description: Option<String>,
    body: String,
    agent: Option<String>,
) -> Result<SavedPrompt, String> {
    if name.trim().is_empty() {
        return Err("name required".into());
    }
    if body.trim().is_empty() {
        return Err("body required".into());
    }
    let _guard = state.write_lock.lock().unwrap();
    let mut all = read_all();
    let now = now_secs();
    let entry = if let Some(id) = id {
        if let Some(found) = all.iter_mut().find(|p| p.id == id) {
            found.name = name.clone();
            found.description = description.unwrap_or_default();
            found.body = body.clone();
            found.agent = agent.clone();
            found.updated_at = now;
            found.clone()
        } else {
            SavedPrompt {
                id,
                name,
                description: description.unwrap_or_default(),
                body,
                agent,
                created_at: now,
                updated_at: now,
                usage_count: 0,
            }
        }
    } else {
        let new = SavedPrompt {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            description: description.unwrap_or_default(),
            body,
            agent,
            created_at: now,
            updated_at: now,
            usage_count: 0,
        };
        all.push(new.clone());
        new
    };
    write_all(&all)?;
    Ok(entry)
}

#[tauri::command]
pub async fn prompts_delete(
    state: tauri::State<'_, PromptStore>,
    id: String,
) -> Result<(), String> {
    let _guard = state.write_lock.lock().unwrap();
    let mut all = read_all();
    all.retain(|p| p.id != id);
    write_all(&all)
}

/// Bumps `usage_count` + `updated_at` so the picker can rank
/// most-used first. Called by the Composer on every successful pick.
#[tauri::command]
pub async fn prompts_record_use(
    state: tauri::State<'_, PromptStore>,
    id: String,
) -> Result<(), String> {
    let _guard = state.write_lock.lock().unwrap();
    let mut all = read_all();
    if let Some(found) = all.iter_mut().find(|p| p.id == id) {
        found.usage_count = found.usage_count.saturating_add(1);
        found.updated_at = now_secs();
        write_all(&all)?;
    }
    Ok(())
}
