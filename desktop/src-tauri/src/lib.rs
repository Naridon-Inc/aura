//! Aura desktop shell — Tauri 2 entry point.
// build-marker: v0.2.3-icon-fix-20260516
//!
//! Each `cmd_*` module groups one slice of the IPC surface so the invoke
//! handler stays declarative. Adding a new command = add a `#[tauri::command]`
//! in the right module + register it in `generate_handler!` below.
//!
//! W1: aura_status (engine smoke test)
//! W2: cmd_files — list_dir / read_file / write_file / git_status / git_diff

mod agent_event_listener;
mod agent_mutation_guard;
mod aurawatch_agentcli;
mod aurawatch_inference;
mod cli_bridge;
mod fs_atomic;
mod cmd_agent_auth;
mod cmd_agent_history;
mod cmd_agent_skills;
mod cmd_brain;
mod cmd_brain_chat;
mod cmd_agent_pty;
mod cmd_agent_stream;
mod cmd_agent_versions;
mod cmd_agents;
mod cmd_atlas;
mod cmd_aura;
mod cmd_aura_fs;
mod cmd_aurawatch;
mod cmd_browser;
mod cmd_capture;
mod cmd_carryover;
mod cmd_change_note;
mod cmd_commons_app;
mod cmd_changes;
mod cmd_cloud_auth;
mod cmd_cloud_billing;
mod cmd_kg;
mod cmd_chat_export;
mod cmd_claude_sessions;
mod cmd_claude_usage;
mod cmd_conflicts;
mod cmd_daemon;
mod cmd_device;
mod cmd_doctor_cli;
mod cmd_ext_host;
mod cmd_files;
mod cmd_integrations;
mod cmd_lane;
mod cmd_loop;
mod cmd_manager;
mod cmd_mcp_servers;
mod cmd_meta_plane;
mod integrations;
mod mcp_http_transport;
mod mcp_oauth;
mod cmd_memory;
mod cmd_models;
mod cmd_modes;
mod cmd_op;
mod cmd_orchestrator;
mod cmd_permission;
mod cmd_clips;
mod cmd_profiles;
mod clips_watch;
mod cloud_inbox;
mod cloud_session_sync;
mod cmd_lounge;
mod cmd_permission_socket;
mod cmd_plugin;
mod cmd_plugin_proxy;
mod cmd_plugin_realtime;
mod cmd_plugin_secrets;
mod cmd_projects;
mod cmd_prompts;
mod cmd_repo_settings;
mod cmd_prs;
mod cmd_native_term;
mod cmd_pty;
mod cmd_search;
mod cmd_sentinel;
mod cmd_notes;
mod cmd_note_folders;
mod cmd_notes_sync;
mod cmd_page_comments;
mod cmd_openai_compat;
mod cmd_settings;
mod cmd_settings_prefs;
mod cmd_terminal_profiles;
mod cmd_soundboard;
mod cmd_taste;
mod cmd_tasks;
mod cmd_tasks_activity;
mod cmd_tasks_sync;
mod cmd_tasks_bulk;
mod cmd_tasks_comments;
mod cmd_tasks_cycles;
mod cmd_tasks_modules;
mod cmd_tasks_relations;
mod cmd_team;
mod cmd_team_notes;
mod cmd_identity;
mod notify;
mod cmd_dialog;
mod cmd_team_upload;
mod cmd_vsix;
mod cmd_watcher;
mod cmd_window;
mod cmd_workspace_launch;
mod cmd_automations;
mod cmd_mission;
mod cmd_remote;
mod cmd_remote_relay;
mod cmd_resources;
mod cmd_zones;
mod crash;
mod hud;
mod manager;
mod menu;
mod tray;
mod op_log;
mod plugin_exchange;
mod plugin_host;
mod telemetry;
pub mod pty_daemon;
mod secret_store;
pub mod spawn_dir;
mod worktree;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use aura_blockstore::{BlockFilter, BlockStore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Set the moment the user picks a *real* quit (menu-bar "Quit Aura" or
/// ⌘Q). While false, closing the main window's red button only hides it to
/// the menu bar so the always-on-top HUD keeps working — see the
/// `on_window_event` handler in `run()`.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Tear the app down for good. Called from the tray's "Quit Aura" item.
pub fn request_quit(app: &AppHandle<Wry>) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[derive(Serialize)]
struct AuraStatus {
    db_path: String,
    initialized: bool,
    block_count: Option<usize>,
    schema_version: Option<i64>,
    channel: &'static str,
}

#[tauri::command]
async fn aura_status() -> AuraStatus {
    let db_path = default_db_path();
    let path_str = db_path.to_string_lossy().into_owned();

    if !db_path.exists() {
        return AuraStatus {
            db_path: path_str,
            initialized: false,
            block_count: None,
            schema_version: None,
            channel: "shell-w2",
        };
    }

    match BlockStore::open(&db_path) {
        Ok(store) => {
            let count = store
                .list_blocks(&BlockFilter::default())
                .map(|v| v.len())
                .unwrap_or(0);
            AuraStatus {
                db_path: path_str,
                initialized: true,
                block_count: Some(count),
                schema_version: Some(aura_blockstore::SCHEMA_USER_VERSION as i64),
                channel: "shell-w2",
            }
        }
        Err(_) => AuraStatus {
            db_path: path_str,
            initialized: false,
            block_count: None,
            schema_version: None,
            channel: "shell-w2",
        },
    }
}

fn default_db_path() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        p.push(".aura");
        p.push("store.db");
        p
    } else {
        PathBuf::from(".aura/store.db")
    }
}

/// GUI apps on macOS launched from Finder/Dock don't inherit the user's
/// shell PATH, so spawning `claude`/`gemini`/`ollama` fails with "binary
/// missing in PATH" even when those tools work fine in a terminal. Fix:
/// before any subprocess spawn, exec the user's login shell once and
/// adopt its PATH. No-op on Linux/Windows where launchers inherit env.
#[cfg(target_os = "macos")]
fn fix_path_for_gui_macos() {
    use std::process::Command;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(out) = Command::new(&shell).args(["-ilc", "echo $PATH"]).output() else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        return;
    }
    let current = std::env::var("PATH").unwrap_or_default();
    // Merge: prefer login PATH order, append any GUI-only entries we don't
    // already have so we don't accidentally drop /usr/bin etc.
    let mut seen: std::collections::HashSet<&str> = p.split(':').collect();
    let mut merged = p.clone();
    for seg in current.split(':') {
        if !seg.is_empty() && !seen.contains(seg) {
            merged.push(':');
            merged.push_str(seg);
            seen.insert(seg);
        }
    }
    std::env::set_var("PATH", merged);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture panics from any thread into ~/.aura/aura-shell-crashes/<ts>.json
    // before the renderer dies. Frontend reads them on next launch.
    crash::install_panic_hook();

    #[cfg(target_os = "macos")]
    fix_path_for_gui_macos();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(cmd_pty::PtyRegistry::new())
        .manage(cmd_agent_pty::AgentPtyRegistry::new())
        .manage(cmd_ext_host::ExtHostState::new())
        .manage(agent_mutation_guard::GuardRegistry::new())
        .manage(agent_mutation_guard::EditorWriteTracker::new())
        .manage(cmd_daemon::DaemonHandle::new())
        .manage(cmd_watcher::WatcherRegistry::new())
        .manage(cmd_aura::AuraLiveRegistry::new())
        .manage(cmd_aurawatch::WatchRegistry::new())
        .manage(cmd_agent_stream::ChildRegistry::new())
        .manage(cmd_permission::PermissionRegistry::new())
        .manage(cli_bridge::BridgeRegistry::new())
        .manage(cmd_manager::ManagerRuntime::new())
        .manage(cmd_projects::ProjectRegistryHandle::new())
        .manage(cmd_prompts::PromptStore::new())
        .manage(std::sync::Arc::new(agent_event_listener::AgentEventListenerState::default()))
        .manage(std::sync::Arc::new(agent_event_listener::GateRegistry::new()))
        .manage(cmd_agent_versions::AgentVersionStore::new())
        .manage(cmd_remote::RemoteState::default())
        .manage(cmd_remote_relay::RemoteRelayState::default())
        .manage(cmd_plugin::build_state(None))
        .manage(cmd_openai_compat::OpenAiCompatRegistry::new())
        .manage(cmd_brain_chat::BrainStreamRegistry::new())
        .manage(cmd_browser::BrowserManager::new())
        .manage(cmd_native_term::NativeTermManager::new())
        .manage(std::sync::Arc::new(
            crate::manager::dispatcher::DispatcherState::new(),
        ))
        .setup(|app| {
            // Native menubar — built once at startup and attached to the
            // app so every window picks it up. `install_handler` emits
            // `menu:<id>` events the React side listens to.
            let m = menu::build(app)?;
            app.set_menu(m)?;
            menu::install_handler(app.handle());
            // Menu-bar (tray) presence + the ⌘⇧A floating HUD. The tray
            // keeps Aura resident in the menu bar so the always-on-top HUD
            // can be summoned even when the main window is hidden; the
            // global shortcut is registered from Rust so it fires
            // regardless of which app is focused. Both degrade gracefully
            // (warn + continue) so a tray/shortcut failure never blocks
            // the rest of startup.
            if let Err(e) = tray::build(app) {
                tracing::warn!(error = %e, "menu-bar tray init failed");
            }
            // Seed the HUD master switch from persisted Settings BEFORE the
            // ⌘⇧A shortcut is live, so a user who turned the HUD off stays off
            // across restarts (the tray + shortcut register unconditionally;
            // the gate lives in hud::toggle/show).
            hud::seed_enabled(cmd_settings_prefs::load_app_settings().hud.enabled);
            hud::register_shortcut(app);
            // macOS window vibrancy: give the MAIN window a frosted
            // NSVisualEffectView backing so the translucent sidebar column
            // reads as live desktop-blur glass, while editor/chat/diff panes
            // keep solid backgrounds. The React side flags
            // `document.documentElement.vibrancy` (main window + macOS only) so
            // styles.css punches the shell wrappers transparent. If the frost
            // or that class is absent, the opaque shell simply covers it —
            // the window can never render black or see-through.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                hud::apply_main_window_vibrancy(&win);
            }
            // Boot the UNIX-socket server that the aura-shell-mcp shim
            // talks to. Single listener for the whole shell — every
            // claude process spawned via cmd_agent_stream points at it.
            cmd_permission_socket::start(app.handle().clone());
            // Stash the app handle on the Manager runtime so sessions
            // re-loaded from disk after a restart can spawn their own
            // tick loops without requiring an active Tauri command.
            app.state::<cmd_manager::ManagerRuntime>()
                .set_app(app.handle().clone());
            // Watch the user's screenshot output dir (macOS default
            // ~/Desktop, plus the configured location if different)
            // and copy any new system screenshot into ~/.aura/clips/
            // automatically. Saves the user from "screenshot, then
            // paste into Aura" — the file just appears in the tray
            // ready to drag.
            clips_watch::start(app.handle().clone());
            // Boot the loopback HTTP listener for the OSC 777 fallback
            // channel (T2.3). Bind happens in tokio so this returns
            // immediately; the URL appears on the managed state once
            // bound, and `cmd_agent_pty::agent_pty_open` reads it
            // lazily per spawn.
            {
                let app_for_listener = app.handle().clone();
                let state = app
                    .state::<std::sync::Arc<agent_event_listener::AgentEventListenerState>>()
                    .inner()
                    .clone();
                let gates = app
                    .state::<std::sync::Arc<agent_event_listener::GateRegistry>>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    agent_event_listener::spawn(app_for_listener, state, gates).await;
                });
            }
            // Jira pull-mirror background poller. Wakes every 5 min, runs
            // `integrations_jira_sync_now` across every configured
            // mirror, and emits `aura:integrations:jira:synced` so the
            // settings tab can refresh its "Last synced" chip without a
            // user-triggered refetch. Errors are logged at warn level
            // and never surfaced to the renderer — the user-driven
            // "Sync now" button is the canonical surface for diagnosis.
            {
                let app_for_poller = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Brief warmup so a fresh launch doesn't race the
                    // keychain unlock / state-file write that the first
                    // OAuth flow performs.
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    loop {
                        // Auto-discovery pass — only fires when the user
                        // turned on auto-mirror. Picks up newly-created
                        // Jira projects so they start syncing on the
                        // *next* cycle (this cycle's `sync_now` already
                        // covers their backlog of issues).
                        if let Err(e) =
                            cmd_integrations::integrations_jira_auto_discover_tick().await
                        {
                            tracing::warn!(error = %e, "jira auto-discovery skipped");
                        }
                        match cmd_integrations::integrations_jira_sync_now(None).await {
                            Ok(outcomes) if !outcomes.is_empty() => {
                                let _ = app_for_poller
                                    .emit("aura:integrations:jira:synced", &outcomes);
                            }
                            Ok(_) => { /* nothing to sync — quiet */ }
                            Err(e) => tracing::warn!(error = %e, "jira poll cycle failed"),
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    }
                });
            }
            // Anonymous product telemetry: record this launch and forward any
            // crash reports queued from a previous run. Fully consent-gated and
            // key-gated inside telemetry::on_startup — a no-op until the user
            // has answered the first-run prompt (and a no-op forever in builds
            // with no PostHog key baked in).
            telemetry::on_startup();

            // Automations scheduler: a single restart-safe background task that
            // fires each enabled "When → do that" recipe across the user's open
            // projects while Aura is on. Runs through the same real Crew / notes
            // / tasks / reviewer paths the rest of the app uses.
            cmd_automations::spawn_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            aura_status,
            cmd_automations::automations_list,
            cmd_automations::automation_create,
            cmd_automations::automation_update,
            cmd_automations::automation_delete,
            cmd_automations::automation_run_now,
            cmd_automations::automation_set_enabled,
            cmd_mission::mission_state,
            cmd_atlas::read_atlas,
            cmd_files::list_dir,
            cmd_files::read_file,
            cmd_files::read_file_base64,
            cmd_files::write_file,
            cmd_files::fs_create_file,
            cmd_files::fs_create_folder,
            cmd_files::fs_rename,
            cmd_files::fs_delete,
            cmd_files::fs_reveal_in_finder,
            cmd_files::fs_find_files,
            cmd_search::fs_grep_content,
            cmd_search::fs_replace_in_files,
            cmd_search::fs_grep_symbol,
            cmd_search::app_bundle_location,
            cmd_files::git_status,
            cmd_files::git_diff,
            cmd_files::git_diff_at_commit,
            cmd_files::git_diff_base,
            cmd_files::home_dir,
            cmd_files::current_dir,
            cmd_files::git_branch,
            cmd_files::git_branches,
            cmd_files::git_branches_rich,
            cmd_files::git_checkout,
            cmd_files::git_create_branch,
            cmd_files::git_remote_origin,
            cmd_files::git_last_commit_age,
            cmd_files::git_show_head,
            cmd_files::git_blame_lines,
            cmd_files::git_stage,
            cmd_files::git_unstage,
            cmd_files::git_commit,
            cmd_files::git_discard,
            cmd_files::git_status_v2,
            cmd_files::git_commit_file_stats,
            cmd_files::git_show_commit,
            cmd_files::git_worktree_list,
            cmd_files::git_worktree_add,
            cmd_files::git_worktree_rebase,
            cmd_files::git_worktree_remove,
            cmd_files::git_branch_diff_files,
            cmd_files::git_branch_diff_file,
            cmd_files::git_merge_branch,
            cmd_files::git_push,
            cmd_files::git_pull,
            cmd_files::git_fetch,
            cmd_files::git_sync,
            cmd_files::git_clone,
            cmd_files::git_init,
            cmd_files::scaffold_template,
            cmd_files::git_ahead_behind,
            cmd_window::window_set_traffic_light_position,
            cmd_window::window_set_traffic_lights_hidden,
            cmd_dialog::dialog_pick,
            cmd_commons_app::commons_app_fetch,
            worktree::worktree_resolve_ref,
            worktree::worktree_create_managed,
            worktree::worktree_remove_managed,
            worktree::worktree_resolve_path,
            cmd_workspace_launch::workspace_launch,
            cmd_lane::lane_spawn,
            cmd_lane::lane_list,
            cmd_lane::lane_discard,
            cmd_agent_versions::agents_versions_get,
            pty_daemon::pty_daemon_ping,
            pty_daemon::pty_daemon_enabled,
            cmd_agents::agent_discover,
            cmd_agents::agents_list,
            cmd_agents::agents_reload,
            cmd_agent_skills::agent_skills_list,
            cmd_agents::agent_send,
            cmd_agents::agent_send_streaming,
            cmd_agent_pty::agent_pty_open,
            cmd_agent_pty::agent_pty_list,
            cmd_agent_pty::agent_pty_send_prompt,
            cmd_agent_pty::agent_pty_write,
            cmd_agent_pty::agent_pty_resize,
            cmd_agent_pty::agent_pty_replay,
            cmd_agent_pty::agent_pty_replay_bytes,
            cmd_agent_pty::agent_pty_title,
            cmd_agent_pty::agent_pty_history,
            cmd_agent_pty::agent_pty_is_alive,
            cmd_agent_pty::agent_pty_idle_status,
            cmd_agent_pty::agent_pty_close,
            cmd_agent_pty::pty_list_alive,
            cmd_agent_pty::pty_pre_relaunch_signal,
            cmd_profiles::agent_profile_list,
            cmd_profiles::agent_profile_create,
            cmd_profiles::agent_profile_delete,
            cmd_profiles::git_profile_list,
            cmd_profiles::git_profile_upsert,
            cmd_profiles::git_profile_delete,
            cmd_profiles::workspace_profile_get,
            cmd_profiles::workspace_profile_set,
            cmd_agent_stream::agent_stream_send,
            cmd_agent_stream::agent_stream_interrupt,
            cmd_permission::permission_respond,
            cmd_permission::permission_list_pending,
            cmd_chat_export::chat_export_to_claude_code,
            cmd_chat_export::chat_export_for_agent,
            cmd_claude_sessions::claude_list_sessions,
            cmd_claude_sessions::claude_load_session,
            cmd_claude_sessions::claude_session_watch,
            cmd_claude_sessions::claude_session_unwatch,
            cmd_claude_usage::claude_usage_snapshot,
            cmd_agent_history::agent_history_preroll,
            cmd_pty::pty_open,
            cmd_pty::pty_write,
            cmd_pty::pty_resize,
            cmd_pty::pty_close,
            cmd_pty::pty_replay_bytes,
            cmd_pty::pty_recent_commands,
            cmd_pty::pty_list_alive_plain,
            cmd_pty::scrollback::pty_scrollback_save,
            cmd_pty::scrollback::pty_scrollback_load,
            cmd_pty::scrollback::pty_scrollback_prune,
            cmd_terminal_profiles::terminal_profile_list,
            cmd_terminal_profiles::terminal_profile_get,
            cmd_terminal_profiles::terminal_profile_default,
            cmd_terminal_profiles::terminal_profile_set_default,
            cmd_aura::aura_recent_blocks,
            cmd_aura::aura_cli,
            cmd_capture::aura_capture_status,
            cmd_aura::aura_live_start,
            cmd_aura::aura_live_stop,
            cmd_aura::aura_live_status,
            cmd_aura::aura_live_peers,
            cmd_aura::aura_radar,
            cmd_aura::aura_log_intent,
            cmd_aura::aura_intent_recent,
            cmd_aura::aura_intent_coverage,
            cmd_aura::aura_intent_attribute,
            cmd_aura::aura_intent_split,
            cmd_aura::aura_intent_merge,
            cmd_aura::aura_strict_mode,
            cmd_aura::aura_snapshot,
            cmd_op::aura_op_recent,
            cmd_op::aura_undo_last,
            cmd_aura_fs::aura_list_waves,
            cmd_aura_fs::aura_read_impacts,
            cmd_aura_fs::aura_resolve_impact,
            cmd_aura_fs::aura_list_snapshots,
            cmd_aura_fs::aura_read_orchestrate,
            cmd_aura_fs::aura_list_conflicts,
            cmd_conflicts::aura_conflicts_list,
            cmd_conflicts::aura_conflicts_record,
            cmd_conflicts::aura_conflicts_resolve,
            cmd_changes::aura_changes_resolve,
            cmd_changes::aura_changes_list,
            cmd_change_note::aura_change_note,
            cmd_kg::aura_kg_build,
            cmd_kg::aura_kg_load,
            cmd_aura_fs::git_diff_stats,
            cmd_aura_fs::git_diff_stats_per_file,
            cmd_aura_fs::cli_detect,
            cmd_doctor_cli::aura_cli_version_check,
            cmd_doctor_cli::aura_cli_install_bundled,
            cmd_doctor_cli::aura_doctor_json,
            cmd_agent_auth::claude_auth_status,
            cmd_agent_auth::claude_auth_login,
            cmd_agent_auth::claude_auth_logout,
            cmd_agent_auth::codex_auth_status,
            cmd_agent_auth::codex_auth_login,
            cmd_agent_auth::codex_auth_login_api_key,
            cmd_agent_auth::open_macos_privacy_pane,
            cmd_aura_fs::aura_read_intent_log,
            cmd_aura_fs::aura_read_intent_log_v2,
            cmd_aura_fs::aura_count_intents_today,
            cmd_aura_fs::aura_count_snapshots_today,
            cmd_aura_fs::aura_list_snapshots_v2,
            cmd_aura_fs::aura_read_audit_log_v2,
            cmd_aura_fs::aura_count_audit_unacked,
            cmd_aura_fs::aura_usage_summary,
            cmd_aura_fs::git_recent_commits,
            cmd_aura_fs::git_commit_graph,
            cmd_aura_fs::git_contributors,
            cmd_aura_fs::aura_semantic_outline,
            cmd_tasks::tasks_list,
            cmd_tasks::tasks_create,
            cmd_tasks::tasks_update,
            cmd_tasks::tasks_delete,
            cmd_tasks::tasks_upsert_external,
            cmd_tasks_sync::tasks_sync_poll,
            cmd_mcp_servers::mcp_servers_discover_agents,
            cmd_mcp_servers::mcp_servers_import_discovered,
            cmd_tasks::sprints_list,
            cmd_tasks::sprints_create,
            cmd_tasks::sprints_update,
            cmd_tasks::sprints_delete,
            cmd_tasks::tasks_mint_bead,
            cmd_tasks::task_views_list,
            cmd_tasks::task_views_upsert,
            cmd_tasks::task_views_delete,
            cmd_tasks::task_views_rename,
            cmd_tasks::task_states_list,
            cmd_tasks::task_states_upsert,
            cmd_tasks::task_states_delete,
            cmd_tasks::task_labels_list,
            cmd_tasks::task_labels_upsert,
            cmd_tasks::task_labels_delete,
            // OO.4 — Plane-style Cycles + Modules registered here so the
            // backend matches the OO.4 frontend wrappers + the new
            // OO.5 features can reach them. The OO.4 commit itself
            // shipped the `.rs` files but missed the registration.
            cmd_tasks_cycles::tasks_cycles_list,
            cmd_tasks_cycles::tasks_cycles_upsert,
            cmd_tasks_cycles::tasks_cycles_delete,
            cmd_tasks_cycles::tasks_cycle_assign,
            cmd_tasks_cycles::tasks_cycle_unassign,
            cmd_tasks_cycles::tasks_cycle_close,
            cmd_tasks_modules::tasks_modules_list,
            cmd_tasks_modules::tasks_modules_upsert,
            cmd_tasks_modules::tasks_modules_delete,
            cmd_tasks_modules::tasks_module_assign,
            cmd_tasks_modules::tasks_module_unassign,
            // OO.5 — Plane-parity Relations + sub-issues + activity
            // log + comments + bulk operations. Activity is emitted
            // implicitly from cmd_tasks / cmd_tasks_comments /
            // cmd_tasks_relations / cmd_tasks_bulk — `tasks_activity_*`
            // is the read surface for that append-only log.
            cmd_tasks::tasks_subtree,
            cmd_tasks_relations::tasks_relations_list,
            cmd_tasks_relations::tasks_relations_create,
            cmd_tasks_relations::tasks_relations_delete,
            cmd_tasks_relations::tasks_relations_for_task,
            cmd_tasks_activity::tasks_activity_list,
            cmd_tasks_activity::tasks_activity_clear,
            cmd_tasks_comments::tasks_comments_list,
            cmd_tasks_comments::tasks_comments_create,
            cmd_tasks_comments::tasks_comments_update,
            cmd_tasks_comments::tasks_comments_delete,
            cmd_tasks_bulk::tasks_bulk_state_change,
            cmd_tasks_bulk::tasks_bulk_assign,
            cmd_tasks_bulk::tasks_bulk_label,
            cmd_tasks_bulk::tasks_bulk_archive,
            cmd_tasks_bulk::tasks_bulk_delete,
            cmd_notes::notes_list,
            cmd_notes::notes_read,
            cmd_notes::notes_write,
            cmd_notes::notes_delete,
            cmd_notes::notes_backlinks,
            cmd_notes::notes_search,
            cmd_notes::notes_archive,
            cmd_notes::notes_set_parent,
            cmd_note_folders::note_folders_list,
            cmd_note_folders::note_folder_create,
            cmd_note_folders::note_folder_rename,
            cmd_note_folders::note_folder_set_color,
            cmd_note_folders::note_folder_reorder,
            cmd_note_folders::note_folder_delete,
            cmd_note_folders::note_set_folder,
            cmd_page_comments::page_comments_list,
            cmd_page_comments::page_comments_add,
            cmd_page_comments::page_comments_resolve,
            cmd_page_comments::page_comments_delete,
            cmd_notes_sync::pages_sync_poll,
            cmd_brain::brain_list_descriptors,
            cmd_brain::brain_get_settings,
            cmd_brain::brain_set_active,
            cmd_brain::brain_set_auto_route,
            cmd_brain::brain_keychain_set,
            cmd_brain::brain_keychain_delete,
            cmd_brain::brain_keychain_has,
            cmd_brain::brain_upsert_provider,
            cmd_brain::brain_remove_provider,
            cmd_brain::manager_list_brains,
            cmd_brain::aura_pro_is_signed_in,
            cmd_brain::aura_pro_quota,
            cmd_models::agent_models_list,
            cmd_brain_chat::brain_active_info,
            cmd_brain_chat::brain_chat_turn,
            cmd_carryover::brain_carryover,
            cmd_brain_chat::brain_chat_cancel,
            cmd_browser::browser_open,
            cmd_browser::browser_navigate,
            cmd_browser::browser_set_bounds,
            cmd_browser::browser_show,
            cmd_browser::browser_hide,
            cmd_browser::browser_back,
            cmd_browser::browser_forward,
            cmd_browser::browser_reload,
            cmd_browser::browser_close,
            cmd_browser::browser_extract,
            cmd_browser::browser_eval,
            cmd_browser::browser_eval_read,
            cmd_browser::browser_reparent,
            cmd_native_term::native_term_open,
            cmd_native_term::native_term_set_bounds,
            cmd_native_term::native_term_write,
            cmd_native_term::native_term_scroll,
            cmd_native_term::native_term_focus,
            cmd_native_term::native_term_select,
            cmd_native_term::native_term_copy,
            cmd_native_term::native_term_close,
            cmd_orchestrator::orchestrator_dispatch_wave,
            cmd_orchestrator::orchestrator_lane_status,
            cmd_orchestrator::orchestrator_cancel_lane,
            cmd_orchestrator::orchestrator_list_active,
            cmd_orchestrator::orchestrator_wave_status,
            cmd_team::team_load,
            cmd_team::team_sync_collaborators,
            cmd_team::repo_github_owner,
            cmd_repo_settings::repo_worktree_settings_get,
            cmd_repo_settings::repo_worktree_settings_set,
            cmd_team::team_identity,
            cmd_team::team_claim,
            cmd_identity::identity_status,
            cmd_identity::identity_status_all,
            cmd_team::team_set_admin,
            cmd_team::team_transfer_admin,
            cmd_team::identity_override_get,
            cmd_team::identity_override_set,
            cmd_team::identity_override_clear,
            cmd_team::team_alias_add,
            // NOTE(oo5-prep): `team_alias_remove` and
            // `canonical_handle_for_email` are referenced here but the
            // function bodies live on the in-flight `feat/ii9-identity-
            // aliases` branch — registering them in the OO.4 commit
            // before they exist broke `cargo build`. Re-add them when
            // II.9 lands the implementations.
            cmd_team::team_status_get,
            cmd_team::team_status_set,
            cmd_team::team_voice_set,
            cmd_team::team_channel_create,
            cmd_team::team_channel_update,
            cmd_team::team_channel_member_add,
            cmd_team::team_channel_member_remove,
            cmd_team::team_channel_admin_set,
            cmd_team::team_channel_tab_add,
            cmd_team::team_channel_tab_remove,
            cmd_team::team_channel_delete,
            cmd_team::chat_list,
            cmd_team::chat_send,
            cmd_team::chat_thread,
            cmd_team::chat_outbox_status,
            cmd_team::chat_resend,
            cmd_team::chat_subscribe_since,
            cmd_team::chat_outbox_drain_kickoff,
            cmd_team::chat_doctor,
            cmd_team::cloud_room_token,
            cmd_team_notes::channel_notes_read,
            cmd_team_notes::channel_notes_write,
            cmd_team_notes::team_notes_read,
            cmd_team_notes::team_notes_write,
            cmd_team_notes::notes_feed_list,
            cmd_team_notes::notes_feed_add,
            cmd_team_notes::notes_feed_delete,
            cmd_team_upload::chat_upload_attachment,
            cmd_soundboard::soundboard_list,
            cmd_soundboard::soundboard_upload,
            cmd_soundboard::soundboard_read,
            cmd_soundboard::soundboard_delete,
            cmd_cloud_auth::cloud_auth_start,
            cmd_cloud_auth::cloud_auth_poll,
            cmd_cloud_auth::cloud_auth_status,
            cmd_cloud_auth::cloud_auth_logout,
            cmd_cloud_auth::cloud_pair_create,
            cmd_cloud_billing::cloud_billing_usage_by_member,
            cmd_device::device_identity,
            cmd_device::device_identity_for_repo,
            cmd_device::device_update,
            cmd_device::device_room_id,
            cmd_device::aura_global_room_id,
            cmd_daemon::daemon_status,
            cmd_daemon::daemon_spawn,
            cmd_daemon::daemon_list_sessions,
            cmd_daemon::daemon_open_session,
            cmd_daemon::daemon_close_session,
            cmd_daemon::daemon_handover,
            cmd_daemon::daemon_claim_zone,
            cmd_daemon::daemon_send_message,
            cmd_daemon::daemon_list_blocks,
            cmd_sentinel::sentinel_inbox,
            cmd_sentinel::sentinel_agents,
            cmd_sentinel::sentinel_send,
            cmd_sentinel::sentinel_mark_read,
            cmd_zones::zone_list,
            cmd_zones::zone_claim,
            cmd_zones::zone_release,
            cmd_zones::aura_zones_json,
            cmd_taste::aura_taste_rules,
            cmd_resources::resource_snapshot,
            cmd_watcher::watch_repo,
            cmd_watcher::unwatch_repo,
            agent_mutation_guard::agent_guard_start,
            agent_mutation_guard::agent_guard_stop,
            agent_mutation_guard::agent_guard_revert_from_snapshot,
            agent_mutation_guard::agent_guard_accept_with_intent,
            agent_mutation_guard::agent_guard_self_heal_nudge,
            agent_mutation_guard::agent_guard_intent_covers,
            cmd_aurawatch::aurawatch_start,
            cmd_aurawatch::aurawatch_stop,
            cmd_aurawatch::aurawatch_set_mode,
            cmd_aurawatch::aurawatch_set_backend,
            cmd_aurawatch::aurawatch_status,
            cmd_aurawatch::aurawatch_detect,
            cmd_aurawatch::aurawatch_nudge_accept,
            cmd_aurawatch::aurawatch_nudge_dismiss,
            cmd_manager::manager_start,
            cmd_manager::manager_chat_start,
            cmd_manager::manager_import_agent_session,
            cmd_manager::manager_fork_session,
            cmd_loop::loop_ready_view,
            cmd_loop::loop_sync_board,
            cmd_loop::loop_run_native,
            cmd_loop::loop_set_status,
            cmd_meta_plane::meta_plane_log,
            cmd_meta_plane::meta_plane_verify,
            cmd_loop::loop_pause,
            cmd_loop::loop_resume,
            cmd_loop::loop_runs,
            cmd_loop::loop_crews,
            cmd_loop::loop_crew_spawn,
            cmd_loop::loop_plan_goal,
            cmd_loop::loop_plan_order,
            cmd_loop::loop_review,
            cmd_loop::loop_attach_targets,
            cmd_manager::manager_status,
            cmd_manager::manager_memory_health,
            cmd_manager::manager_subagent_monitor,
            cmd_manager::manager_list,
            cmd_manager::manager_load_transcript,
            cmd_manager::manager_session_changeset,
            cmd_manager::manager_resume,
            cmd_manager::manager_pause,
            cmd_manager::manager_cancel,
            cmd_manager::manager_override,
            cmd_manager::manager_complete_manual,
            cmd_manager::manager_preview_prompt,
            cmd_manager::manager_append_chat,
            cmd_manager::manager_chat,
            cmd_manager::manager_chat_edit_resend,
            cmd_manager::manager_answer_question,
            cmd_manager::manager_decide_plan,
            cmd_manager::manager_approve_plan,
            cmd_manager::manager_brain_info,
            cmd_manager::manager_brain_detect,
            cmd_manager::manager_set_brain_override,
            cmd_manager::manager_set_tasks,
            cmd_manager::manager_rate_task,
            cmd_manager::manager_override_todo_agent,
            cmd_projects::projects_register,
            cmd_projects::projects_list,
            cmd_projects::projects_get,
            cmd_prompts::prompts_list,
            cmd_prompts::prompts_save,
            cmd_prompts::prompts_delete,
            cmd_prompts::prompts_record_use,
            cmd_prs::pr_list,
            cmd_prs::aura_review_json,
            cmd_prs::pr_whoami,
            cmd_prs::pr_labels_list,
            cmd_prs::pr_labels_set,
            cmd_prs::pr_detail,
            cmd_prs::pr_comments_list,
            cmd_prs::pr_comment_post,
            cmd_prs::pr_comment_post_issue,
            cmd_prs::pr_comment_reply,
            cmd_prs::pr_comment_resolve,
            cmd_prs::pr_reaction_add,
            cmd_prs::pr_reaction_remove,
            cmd_prs::pr_approve,
            cmd_prs::pr_request_changes,
            cmd_prs::pr_comment_review,
            cmd_prs::pr_merge,
            cmd_prs::pr_stack,
            cmd_settings::settings_load,
            cmd_settings::settings_set_provider_key,
            cmd_settings::settings_set_active_provider,
            cmd_settings::settings_set_telemetry,
            cmd_settings::settings_set_dev_mode,
            cmd_settings::settings_set_local_embeddings,
            cmd_settings::settings_set_worktree_base,
            cmd_settings::settings_disable_strict_unlocked,
            cmd_settings::settings_agents_toml_list,
            cmd_settings::settings_agents_toml_upsert,
            cmd_settings::settings_agents_toml_remove,
            cmd_settings::settings_telemetry_show,
            cmd_settings::settings_telemetry_clear,
            cmd_settings_prefs::settings_prefs_load,
            cmd_settings_prefs::settings_prefs_save,
            cmd_clips::clips_list,
            cmd_clips::clips_save_image,
            cmd_clips::clips_save_file,
            cmd_clips::clips_read_dataurl,
            cmd_clips::clips_copy_image_to_os,
            cmd_clips::clips_remove,
            cmd_clips::clips_clear,
            cmd_remote::remote_start,
            cmd_remote::remote_stop,
            cmd_remote::remote_status,
            cmd_remote::remote_set_snapshot,
            cmd_remote_relay::remote_relay_start,
            cmd_remote_relay::remote_relay_stop,
            cmd_remote_relay::remote_relay_status,
            cmd_memory::aura_memory_view,
            cmd_memory::aura_memory_write_entry,
            cmd_memory::aura_memory_import_claude_code,
            cmd_memory::aura_memory_forget_entry,
            cmd_memory::aura_session_list,
            cmd_memory::aura_session_read,
            crash::aura_crash_reports_list,
            crash::aura_crash_report_read,
            crash::aura_crash_reports_clear,
            telemetry::telemetry_consent_get,
            telemetry::telemetry_set_consent,
            telemetry::telemetry_track,
            cmd_plugin::plugin_list,
            cmd_plugin::plugin_rescan,
            cmd_plugin::plugin_enable,
            cmd_plugin::plugin_disable,
            cmd_plugin::plugin_contributes,
            cmd_plugin_secrets::plugin_secrets_status,
            cmd_plugin_secrets::plugin_secret_set,
            cmd_plugin_secrets::plugin_secret_clear,
            cmd_plugin_proxy::plugin_asset_read,
            cmd_plugin_proxy::plugin_proxy_fs_read,
            cmd_plugin_proxy::plugin_proxy_net_fetch,
            cmd_plugin_proxy::plugin_kv_get,
            cmd_plugin_proxy::plugin_kv_set,
            plugin_exchange::plugin_exchange_publish,
            plugin_exchange::plugin_exchange_poll,
            plugin_exchange::plugin_exchange_list,
            plugin_exchange::plugin_exchange_install,
            plugin_exchange::plugin_exchange_trust,
            plugin_exchange::plugin_exchange_unpublish,
            cmd_plugin_realtime::plugin_rt_send,
            cmd_plugin_realtime::plugin_rt_poll,
            cmd_vsix::vsix_search,
            cmd_vsix::vsix_browse,
            cmd_vsix::vsix_preview_contributes,
            cmd_vsix::vsix_install,
            cmd_vsix::vsix_install_file,
            cmd_vsix::vsix_list,
            cmd_vsix::vsix_read_text,
            cmd_vsix::vsix_set_enabled,
            cmd_vsix::vsix_remove,
            cmd_ext_host::ext_host_start,
            cmd_ext_host::ext_host_send,
            cmd_ext_host::ext_host_status,
            cmd_ext_host::ext_host_stop,
            cmd_lounge::lounge_react,
            cmd_lounge::lounge_reactions,
            cmd_openai_compat::openai_compat_profiles_list,
            cmd_openai_compat::openai_compat_profile_save,
            cmd_openai_compat::openai_compat_profile_remove,
            cmd_openai_compat::openai_compat_test,
            cmd_openai_compat::openai_compat_chat,
            cmd_openai_compat::openai_compat_cancel,
            cmd_mcp_servers::mcp_servers_list,
            cmd_mcp_servers::mcp_servers_add,
            cmd_mcp_servers::mcp_servers_remove,
            cmd_mcp_servers::mcp_servers_toggle,
            cmd_mcp_servers::mcp_servers_update_env,
            cmd_mcp_servers::mcp_servers_auth_run,
            cmd_mcp_servers::mcp_servers_oauth_start,
            cmd_mcp_servers::mcp_servers_oauth_clear,
            cmd_mcp_servers::mcp_servers_update_url,
            cmd_mcp_servers::mcp_tools_list,
            cmd_mcp_servers::mcp_tool_invoke,
            cmd_integrations::integrations_jira_connect,
            cmd_integrations::integrations_jira_cancel,
            cmd_integrations::integrations_jira_status,
            cmd_integrations::integrations_jira_disconnect,
            cmd_integrations::integrations_jira_projects,
            cmd_integrations::integrations_jira_mirror_set,
            cmd_integrations::integrations_jira_mirror_unset,
            cmd_integrations::integrations_jira_sync_now,
            cmd_integrations::integrations_jira_backfill,
            cmd_integrations::integrations_jira_auto_mirror_enable,
            cmd_integrations::integrations_jira_auto_mirror_disable,
            cmd_integrations::integrations_list,
            cmd_integrations::integrations_beads_preview,
            cmd_integrations::integrations_beads_import,
            cmd_integrations::integrations_jira_users_list,
            cmd_integrations::integrations_jira_users_reconcile,
            cmd_integrations::integrations_jira_users_link,
            cmd_integrations::integrations_jira_users_unlink,
            cmd_modes::modes_marketplace_list,
            cmd_modes::modes_marketplace_refresh,
            cmd_modes::modes_install_from_url,
            cmd_modes::modes_list_installed,
            cmd_modes::modes_uninstall,
            cmd_modes::modes_edit,
            cmd_modes::modes_publish_to_gist,
            cmd_modes::modes_search,
            cmd_modes::modes_enable,
            cmd_modes::modes_disable,
            cmd_modes::modes_check_updates,
            cmd_modes::modes_validate_yaml,
            agent_event_listener::agent_gate_resolve,
            hud::hud_toggle,
            hud::hud_show,
            hud::hud_hide,
            hud::hud_resize,
            hud::hud_set_mode,
            hud::hud_set_opacity,
            hud::hud_set_enabled,
            hud::hud_workspace_menu,
            hud::hud_agents_menu,
            hud::hud_menu,
        ])
        .on_window_event(|window, event| {
            // Menu-bar-app behaviour: the main window's red close button
            // hides it instead of quitting, so the app stays resident and
            // the always-on-top HUD keeps publishing/receiving. A real
            // quit (tray "Quit Aura" or ⌘Q) flips `QUITTING` first and
            // exits at the app level without ever issuing CloseRequested
            // here. Popout/HUD windows close normally.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !QUITTING.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            } else if window.label() == hud::HUD_LABEL {
                // Persist wherever the user drags the HUD so it reopens there
                // next summon (kept per-monitor by `reveal`).
                if let tauri::WindowEvent::Moved(_) = event {
                    hud::on_hud_moved(window);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tear down PTY children on shutdown so coding-agent CLIs
            // don't outlive the shell. ExitRequested fires when the user
            // ⌘Q's or closes the last window; Exit fires after the
            // runtime's last cleanup step. We kill on both — kill_all
            // is idempotent.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(reg) = app.try_state::<cmd_agent_pty::AgentPtyRegistry>() {
                    reg.kill_all();
                }
                // Plain terminals too. Daemon-backed plain sessions are
                // intentionally left running — surviving a restart is the
                // whole point of the daemon — so this only reaps
                // in-process children.
                if let Some(reg) = app.try_state::<cmd_pty::PtyRegistry>() {
                    reg.kill_all();
                }
            }
        });
}
