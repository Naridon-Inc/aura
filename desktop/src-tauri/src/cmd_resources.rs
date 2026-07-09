// Resource Usage popover backend. One Tauri command — `resource_snapshot`
// — that returns total system CPU + memory + this app's footprint plus a
// per-process breakdown for anything in the `aura-` family (so the UI
// can show shell + pty-daemon + spawned agents distinctly).
//
// We keep a long-lived `System` behind a Mutex so `cpu_usage` deltas are
// meaningful across calls. Tauri serializes commands, but the renderer
// can spam this; cheap clone + short-lived lock means it's still ~ms.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

#[derive(Serialize)]
pub struct ResourceSnapshot {
    /// CPU % across all cores (0.0..=100.0).
    pub cpu_percent: f32,
    /// Total RAM in use system-wide (MB).
    pub used_memory_mb: u64,
    /// Total system RAM (MB).
    pub total_memory_mb: u64,
    /// This app's memory share of total system RAM (%).
    pub app_share_percent: f32,
    /// Sum of memory across the aura family processes (MB).
    pub aura_memory_mb: u64,
    /// Per-process rows the UI renders as a tree (main app + agents).
    pub processes: Vec<ProcessRow>,
}

#[derive(Serialize)]
pub struct ProcessRow {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_mb: u64,
}

static SYS: Mutex<Option<System>> = Mutex::new(None);

#[tauri::command]
pub fn resource_snapshot() -> Result<ResourceSnapshot, String> {
    let mut guard = SYS.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let refresh = RefreshKind::new()
            .with_processes(ProcessRefreshKind::new().with_cpu().with_memory())
            .with_cpu(sysinfo::CpuRefreshKind::new().with_cpu_usage())
            .with_memory(sysinfo::MemoryRefreshKind::new().with_ram());
        *guard = Some(System::new_with_specifics(refresh));
    }
    let sys = guard.as_mut().expect("init");
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cpu().with_memory(),
    );

    let total_kb = sys.total_memory();
    let used_kb = sys.used_memory();
    let total_mb = total_kb / 1024 / 1024;
    let used_mb = used_kb / 1024 / 1024;

    // Average CPU across logical cores. sysinfo reports per-core usage;
    // we average rather than sum so the % stays 0..100 regardless of
    // how many cores the host has.
    let cpu = if sys.cpus().is_empty() {
        0.0
    } else {
        sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len() as f32
    };

    // Pick out aura-family processes. We match on argv[0] basename so
    // we catch the shell, the pty daemon, the mcp companion, and any
    // spawned agent CLIs (claude, gemini, codex, cursor-agent).
    let mut rows: Vec<ProcessRow> = Vec::new();
    let mut aura_total_kb: u64 = 0;
    let self_pid = std::process::id();
    let mut self_kb = 0u64;
    for (pid, p) in sys.processes() {
        let name = p.name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_self = pid.as_u32() == self_pid;
        let is_aura = lower.starts_with("aura-")
            || lower.contains("aura_shell")
            || lower == "claude"
            || lower == "gemini"
            || lower == "codex"
            || lower == "cursor-agent";
        if !is_self && !is_aura {
            continue;
        }
        let mem_kb = p.memory();
        if is_self {
            self_kb = mem_kb;
        }
        aura_total_kb += mem_kb;
        rows.push(ProcessRow {
            pid: pid.as_u32(),
            name,
            cpu_percent: p.cpu_usage(),
            memory_mb: mem_kb / 1024 / 1024,
        });
    }
    rows.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb));

    let app_share = if total_kb == 0 { 0.0 } else { (self_kb as f32 / total_kb as f32) * 100.0 };

    Ok(ResourceSnapshot {
        cpu_percent: cpu,
        used_memory_mb: used_mb,
        total_memory_mb: total_mb,
        app_share_percent: app_share,
        aura_memory_mb: aura_total_kb / 1024 / 1024,
        processes: rows,
    })
}
