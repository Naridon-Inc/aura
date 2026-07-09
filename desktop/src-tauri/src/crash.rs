// Local crashlytics — captures panics from any thread in the shell
// process, augments them with the most-recent Manager session id +
// last 20 ribbon events, and writes a JSON report to
// ~/.aura/aura-shell-crashes/<timestamp_ms>.json. Frontend mounts a
// recovery toast on launch that scans this dir.
//
// Zero network. All open-source: relies on std::panic + serde_json.

use serde::Serialize;
use std::fs;
use std::panic;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct CrashReport {
    timestamp_ms: u64,
    panic_message: String,
    location: Option<String>,
    thread: Option<String>,
    backtrace: String,
    app_version: &'static str,
    last_active_session: Option<ActiveSession>,
}

#[derive(Serialize)]
struct ActiveSession {
    id: String,
    objective: String,
    status: String,
    last_ribbon: Vec<serde_json::Value>,
}

pub fn install_panic_hook() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Err(e) = write_crash_report(info) {
            eprintln!("[crash.rs] failed to write crash report: {e}");
        }
        prev(info);
    }));
}

fn write_crash_report(info: &panic::PanicHookInfo<'_>) -> std::io::Result<()> {
    let dir = crashes_dir();
    fs::create_dir_all(&dir)?;
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let panic_message = if let Some(s) = info.payload().downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "(non-string panic payload)".to_string()
    };

    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    let thread = std::thread::current().name().map(String::from);
    let backtrace = format!("{}", std::backtrace::Backtrace::force_capture());

    let report = CrashReport {
        timestamp_ms,
        panic_message,
        location,
        thread,
        backtrace,
        app_version: env!("CARGO_PKG_VERSION"),
        last_active_session: find_active_session(),
    };

    let path = dir.join(format!("{timestamp_ms}.json"));
    let json =
        serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{\"err\":\"serialize\"}".into());
    fs::write(path, json)
}

fn crashes_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".aura").join("aura-shell-crashes")
}

fn sessions_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("manager-sessions"))
}

fn find_active_session() -> Option<ActiveSession> {
    let dir = sessions_dir()?;
    let entries = fs::read_dir(&dir).ok()?;

    let mut best: Option<(u64, PathBuf)> = None;
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mtime = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if best.as_ref().map(|(m, _)| mtime > *m).unwrap_or(true) {
            best = Some((mtime, path));
        }
    }

    let (_, path) = best?;
    let raw = fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    let objective = v
        .get("objective")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let status = v
        .get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let last_ribbon: Vec<serde_json::Value> = v
        .get("ribbon")
        .and_then(|x| x.as_array())
        .map(|arr| {
            let n = arr.len();
            let start = n.saturating_sub(20);
            arr[start..].to_vec()
        })
        .unwrap_or_default();

    Some(ActiveSession {
        id,
        objective,
        status,
        last_ribbon,
    })
}

// ---- Tauri commands ----

#[derive(Serialize)]
pub struct CrashSummary {
    pub path: String,
    pub timestamp_ms: u64,
    pub panic_message: String,
    pub location: Option<String>,
    pub session_id: Option<String>,
}

#[tauri::command]
pub fn aura_crash_reports_list() -> Vec<CrashSummary> {
    let dir = crashes_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(x) => x,
            Err(_) => continue,
        };
        out.push(CrashSummary {
            path: path.to_string_lossy().to_string(),
            timestamp_ms: v.get("timestamp_ms").and_then(|x| x.as_u64()).unwrap_or(0),
            panic_message: v
                .get("panic_message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            location: v
                .get("location")
                .and_then(|x| x.as_str())
                .map(String::from),
            session_id: v
                .get("last_active_session")
                .and_then(|x| x.get("id"))
                .and_then(|x| x.as_str())
                .map(String::from),
        });
    }
    out.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    out
}

#[tauri::command]
pub fn aura_crash_report_read(path: String) -> Result<String, String> {
    let dir = crashes_dir();
    let p = std::path::Path::new(&path);
    if !p.starts_with(&dir) {
        return Err("path outside crash dir".to_string());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn aura_crash_reports_clear(before_ts_ms: u64) -> Result<usize, String> {
    let dir = crashes_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    let mut removed = 0usize;
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok());
        if let Some(ts) = stem {
            if ts <= before_ts_ms && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}
