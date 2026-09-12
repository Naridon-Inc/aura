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
    /// Bytes still free on the volume the workspace lives on — the one an
    /// agent's copies, caches and build output land on. Zero when the
    /// volume could not be asked, which the UI reads as "unknown", never as
    /// "empty".
    pub disk_free_bytes: u64,
    /// That volume's size. Zero when unknown.
    pub disk_total_bytes: u64,
    /// The folder Aura keeps every agent's copy of a project in — the one
    /// that grows unwatched, and the one a "clean up" should open. Empty
    /// when HOME is unset.
    pub copies_root: String,
}

#[derive(Serialize)]
pub struct ProcessRow {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_mb: u64,
}

static SYS: Mutex<Option<System>> = Mutex::new(None);

/// `async` deliberately (UI-01): a non-async Tauri command runs ON the
/// macOS main thread, and this one walks the entire process table — a
/// multi-ms scan the popover polls every 2s, i.e. periodic NSWindow
/// jank at best and, stacked behind a busy runloop, part of a wedge at
/// worst. As `async` it runs on the runtime's thread pool; the renderer
/// awaits the same payload it always did.
///
/// `root` is the open workspace, whose volume the disk figures describe.
/// Without one the figures are for wherever Aura keeps its managed copies
/// (`~/.aura/worktrees`), which is where an agent's writes go.
#[tauri::command]
pub async fn resource_snapshot(root: Option<String>) -> Result<ResourceSnapshot, String> {
    let copies_root = crate::worktree::managed_root();
    let (disk_free_bytes, disk_total_bytes) =
        disk_figures(root.as_deref(), copies_root.as_deref());
    let copies_root = copies_root
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
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
        disk_free_bytes,
        disk_total_bytes,
        copies_root,
    })
}

/// `(free, total)` in bytes for the volume holding `root`, or the managed
/// copies root, or the home directory — the first that exists. `(0, 0)`
/// when none can be measured; the renderer treats zero as unknown.
///
/// Walks up from the path rather than requiring it to exist: a workspace
/// whose folder was just moved still sits on some volume, and its parent
/// answers for it.
fn disk_figures(root: Option<&str>, copies_root: Option<&std::path::Path>) -> (u64, u64) {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(r) = root.map(str::trim).filter(|r| !r.is_empty()) {
        candidates.push(std::path::PathBuf::from(r));
    }
    if let Some(c) = copies_root {
        candidates.push(c.to_path_buf());
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(std::path::PathBuf::from(home));
    }
    for start in candidates {
        let mut cursor: Option<&std::path::Path> = Some(start.as_path());
        while let Some(p) = cursor {
            if p.exists() {
                if let Some(figures) = volume_figures(p) {
                    return figures;
                }
                break;
            }
            cursor = p.parent();
        }
    }
    (0, 0)
}

/// Ask the OS about the volume at `path`. `statvfs` rather than a sysinfo
/// `Disks` walk: the crate is built with only its `system` feature here,
/// and one syscall on one path is all the question needs.
#[cfg(unix)]
fn volume_figures(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` is zeroable plain data, and the pointer we hand the
    // syscall points at a live local for the duration of the call.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    // Fragment size is the unit both counts are in; some filesystems report
    // 0 for it and mean the block size.
    let unit = if st.f_frsize > 0 { st.f_frsize } else { st.f_bsize } as u64;
    // `f_bavail` is what an unprivileged writer gets, which is what an agent
    // is; `f_bfree` counts the root-reserved slice too and would overstate it.
    let free = (st.f_bavail as u64).saturating_mul(unit);
    let total = (st.f_blocks as u64).saturating_mul(unit);
    Some((free, total))
}

#[cfg(not(unix))]
fn volume_figures(_path: &std::path::Path) -> Option<(u64, u64)> {
    None
}
