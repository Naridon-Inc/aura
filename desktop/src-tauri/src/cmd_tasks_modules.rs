//! Plane-parity Modules (epics that span cycles) — per-repo CRUD over
//! a JSON file at `<repoRoot>/.aura/tasks/task_modules.json`.
//!
//! In Plane's vocabulary a Module is a longer-lived container than a
//! Cycle: tasks belong to one Module (a feature, a workstream) and
//! can flow through many Cycles inside that Module's lifetime. Aura's
//! existing `Task::is_epic` + `parent_id` mechanism stays — Modules
//! sit alongside it as a flat catalog so the sidebar can offer a
//! "click to filter" surface without forcing every workstream to be
//! modelled as an epic-task.
//!
//! Commands:
//!   - `tasks_modules_list`
//!   - `tasks_modules_upsert` (create-or-replace by id)
//!   - `tasks_modules_delete` (detaches tasks pointing at the module)
//!   - `tasks_module_assign` (membership; mirrored on Task::module_id)
//!   - `tasks_module_unassign`

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Plane-style module = long-lived workstream container.
///
/// `status` is one of `planned | in_progress | completed`. Distinct
/// from the Cycle ladder (`planned | active | completed`) because
/// "in_progress" reads more naturally for a multi-cycle feature.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Module {
    /// Stable slug — also the value stored on `Task::module_id` and
    /// the routing key the sidebar uses. Generated client-side from
    /// the name; updates by sending the same `id` to upsert.
    pub id: String,
    /// Human label rendered on the module pill + sidebar entry.
    pub name: String,
    /// Free-text purpose / scope. Surfaced in the module detail view
    /// (OO.5 territory; OO.4 just persists the field).
    #[serde(default)]
    pub description: String,
    /// Optional owning member handle. Mirrors `TeamMember::handle` so
    /// the avatar can be looked up without a join table.
    #[serde(default)]
    pub lead_id: Option<String>,
    /// One of `planned | in_progress | completed`. Validator below
    /// rejects anything else.
    pub status: String,
    /// Explicit membership list. Kept in sync with `Task::module_id`
    /// by `tasks_module_assign` / `tasks_module_unassign`; the heal
    /// pass in `cmd_tasks::backfill_ontology` clears `module_id` on
    /// tasks whose module was deleted.
    #[serde(default)]
    pub task_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct ModuleFile {
    #[serde(default)]
    modules: Vec<Module>,
}

fn modules_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("task_modules.json")
}

fn load_modules(repo_root: &Path) -> Result<ModuleFile, String> {
    let p = modules_path(repo_root);
    if !p.exists() {
        return Ok(ModuleFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_modules(repo_root: &Path, file: &ModuleFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&modules_path(repo_root), file)
}

/// Idempotent first-touch: ensures the modules file exists on disk so
/// `cmd_tasks::backfill_ontology` can call us safely from inside the
/// `tasks_list` heal without racing on a missing parent dir.
fn ensure_modules_file(repo_root: &Path) -> Result<ModuleFile, String> {
    let p = modules_path(repo_root);
    if !p.exists() {
        let empty = ModuleFile::default();
        save_modules(repo_root, &empty)?;
        return Ok(empty);
    }
    load_modules(repo_root)
}

/// Cross-module wrapper for `cmd_tasks` — same first-touch behaviour
/// but doesn't leak the private `ModuleFile` type.
pub fn ensure_modules_file_initialized(repo_root: &Path) -> Result<(), String> {
    ensure_modules_file(repo_root).map(|_| ())
}

/// Public read for the heal pass in `cmd_tasks`. Returns the set of
/// module ids that exist on disk so the heal can clear dangling
/// `Task::module_id` pointers.
pub fn known_module_ids(repo_root: &Path) -> Result<Vec<String>, String> {
    Ok(load_modules(repo_root)?
        .modules
        .into_iter()
        .map(|m| m.id)
        .collect())
}

/// Sync-callable mirror used by `cmd_tasks::tasks_create` when the
/// caller set `module_id` at create time. Mirror of the cycles
/// helper of the same name. Caller must have validated existence.
pub fn mirror_assign_task(
    repo_root: &Path,
    module_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let mut file = ensure_modules_file(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for m in file.modules.iter_mut() {
        if m.id == module_id {
            if !m.task_ids.contains(&task_id.to_string()) {
                m.task_ids.push(task_id.to_string());
                m.updated_at = now.clone();
                mutated = true;
            }
        } else {
            let before = m.task_ids.len();
            m.task_ids.retain(|t| t != task_id);
            if m.task_ids.len() != before {
                m.updated_at = now.clone();
                mutated = true;
            }
        }
    }
    if mutated {
        save_modules(repo_root, &file)?;
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

const VALID_STATUSES: [&str; 3] = ["planned", "in_progress", "completed"];

fn validate_status(s: &str) -> Result<(), String> {
    if VALID_STATUSES.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "invalid module status {:?} — must be one of {:?}",
            s, VALID_STATUSES
        ))
    }
}

#[derive(Deserialize)]
pub struct ModuleInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub lead_id: Option<String>,
    /// `planned | in_progress | completed`. Defaults to `planned`
    /// when omitted so the frontend can skip it on first create.
    #[serde(default = "default_module_status")]
    pub status: String,
}

fn default_module_status() -> String {
    "planned".into()
}

#[tauri::command]
pub async fn tasks_modules_list(repo_root: String) -> Result<Vec<Module>, String> {
    Ok(ensure_modules_file(Path::new(&repo_root))?.modules)
}

/// Create-or-replace by id. Membership is preserved across updates —
/// re-saving the module metadata does not nuke its task pointers;
/// assign/unassign own that mutation.
#[tauri::command]
pub async fn tasks_modules_upsert(
    repo_root: String,
    input: ModuleInput,
) -> Result<Module, String> {
    let root = Path::new(&repo_root);
    validate_status(&input.status)?;
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("module id is required".into());
    }
    if input.name.trim().is_empty() {
        return Err("module name is required".into());
    }
    let mut file = ensure_modules_file(root)?;
    let now = now_iso();
    let mut updated: Option<Module> = None;
    for m in file.modules.iter_mut() {
        if m.id == id {
            m.name = input.name.clone();
            m.description = input.description.clone();
            m.lead_id = input.lead_id.clone();
            m.status = input.status.clone();
            m.updated_at = now.clone();
            updated = Some(m.clone());
            break;
        }
    }
    if updated.is_none() {
        let module = Module {
            id,
            name: input.name,
            description: input.description,
            lead_id: input.lead_id,
            status: input.status,
            task_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        file.modules.push(module.clone());
        updated = Some(module);
    }
    save_modules(root, &file)?;
    updated.ok_or_else(|| "module vanished".into())
}

/// Delete a module. Tasks pointing at the deleted module have their
/// `Task::module_id` cleared so they don't dangle in module filters.
#[tauri::command]
pub async fn tasks_modules_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = ensure_modules_file(root)?;
    let before = file.modules.len();
    file.modules.retain(|m| m.id != id);
    if file.modules.len() == before {
        return Err(format!("module not found: {}", id));
    }
    save_modules(root, &file)?;
    crate::cmd_tasks::detach_module(root, &id)?;
    Ok(())
}

/// Append a task to a module's membership list and mirror the pointer
/// onto `Task::module_id`. Idempotent and exclusive — assigning to a
/// new module removes from the previous one in the same write.
#[tauri::command]
pub async fn tasks_module_assign(
    repo_root: String,
    module_id: String,
    task_id: String,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let file = ensure_modules_file(root)?;
    if !file.modules.iter().any(|m| m.id == module_id) {
        return Err(format!("module not found: {}", module_id));
    }
    mirror_assign_task(root, &module_id, &task_id)?;
    crate::cmd_tasks::set_task_module(root, &task_id, Some(&module_id))?;
    Ok(())
}

/// Remove a task from a module. Clears `Task::module_id`. No-op when
/// the task isn't in the membership list so the frontend can call
/// defensively without reading state first.
#[tauri::command]
pub async fn tasks_module_unassign(
    repo_root: String,
    module_id: String,
    task_id: String,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = ensure_modules_file(root)?;
    let now = now_iso();
    let mut mutated = false;
    for m in file.modules.iter_mut() {
        if m.id == module_id {
            let before = m.task_ids.len();
            m.task_ids.retain(|t| t != &task_id);
            if m.task_ids.len() != before {
                m.updated_at = now.clone();
                mutated = true;
            }
        }
    }
    if mutated {
        save_modules(root, &file)?;
    }
    crate::cmd_tasks::set_task_module(root, &task_id, None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo4-modules-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn validate_status_accepts_canonical() {
        assert!(validate_status("planned").is_ok());
        assert!(validate_status("in_progress").is_ok());
        assert!(validate_status("completed").is_ok());
        assert!(validate_status("active").is_err());
        assert!(validate_status("").is_err());
    }

    #[test]
    fn ensure_modules_file_creates_on_first_touch() {
        let repo = tmp_repo("ensure");
        assert!(!modules_path(&repo).exists());
        let file = ensure_modules_file(&repo).unwrap();
        assert!(file.modules.is_empty());
        assert!(modules_path(&repo).exists());
    }

    #[test]
    fn module_input_defaults_status_to_planned() {
        let raw = serde_json::json!({
            "id": "m1",
            "name": "Module 1"
        });
        let parsed: ModuleInput = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.status, "planned");
        assert!(parsed.description.is_empty());
        assert!(parsed.lead_id.is_none());
    }

    #[test]
    fn known_module_ids_returns_just_ids() {
        let repo = tmp_repo("ids");
        let mut f = ensure_modules_file(&repo).unwrap();
        let now = now_iso();
        for id in ["alpha", "beta"] {
            f.modules.push(Module {
                id: id.into(),
                name: id.into(),
                description: String::new(),
                lead_id: None,
                status: "planned".into(),
                task_ids: Vec::new(),
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }
        save_modules(&repo, &f).unwrap();
        let ids = known_module_ids(&repo).unwrap();
        assert_eq!(ids, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn upsert_round_trip_preserves_membership() {
        let repo = tmp_repo("roundtrip");
        let mut f = ensure_modules_file(&repo).unwrap();
        let now = now_iso();
        f.modules.push(Module {
            id: "m1".into(),
            name: "Module 1".into(),
            description: "purpose".into(),
            lead_id: Some("owner".into()),
            status: "planned".into(),
            task_ids: vec!["task_a".into(), "task_b".into()],
            created_at: now.clone(),
            updated_at: now,
        });
        save_modules(&repo, &f).unwrap();
        let mut file = ensure_modules_file(&repo).unwrap();
        for m in file.modules.iter_mut() {
            if m.id == "m1" {
                m.name = "Renamed".into();
                m.status = "in_progress".into();
            }
        }
        save_modules(&repo, &file).unwrap();
        let reloaded = load_modules(&repo).unwrap();
        let m = &reloaded.modules[0];
        assert_eq!(m.name, "Renamed");
        assert_eq!(m.status, "in_progress");
        assert_eq!(m.task_ids, vec!["task_a".to_string(), "task_b".to_string()]);
        assert_eq!(m.lead_id.as_deref(), Some("owner"));
    }
}
