//! Anonymous product telemetry → PostHog (EU).
//!
//! We do NOT use the PostHog JS SDK / autocapture. Every event is a
//! hand-built JSON payload POSTed to PostHog's capture API from here, so
//! code, file paths, prompts, repo names — anything sensitive — physically
//! cannot leave: we only ever put a fixed, audited set of scalar fields on
//! the wire. This keeps product analytics fully compatible with Aura's
//! sovereignty promise (which is about *code* — code never goes).
//!
//! Identity / attribution
//! ----------------------
//! `distinct_id` is the per-install anonymous UUID from `~/.aura/device.json`
//! (`device_id`) — stable for the life of the install, never per-session,
//! never regenerated, never derived from anything personal. One install ==
//! one PostHog person, so DAU/WAU/MAU, "new users == new installs", and
//! retention cohorts all compute correctly. We force person processing on
//! (`$process_person_profile: true`) and `$set` a small, PII-free set of
//! person properties each launch so PostHog's unique-user math populates.
//!
//! Consent
//! -------
//! Nothing is sent until the user has answered the first-run consent prompt
//! (`telemetry_consent_decided`). Two independent switches:
//!   * `telemetry_enabled`        — anonymous product analytics (usage/flows)
//!   * `telemetry_crash_enabled`  — crash / error reports
//! Both default ON *in the prompt*, but we never transmit before the prompt
//! is answered.
//!
//! Key
//! ---
//! The PostHog public write-only ingestion token is resolved at runtime from
//! `AURA_POSTHOG_KEY` (env), else baked at build time via
//! `option_env!("AURA_POSTHOG_KEY")` (release builds export it from
//! `~/.aura-posthog.env`). Absent → telemetry is a silent no-op. The token is
//! kept out of the open-source tree on purpose.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use crate::cloud_session_sync::{aura_dir, read_credentials};

/// Default PostHog host for the EU region.
const DEFAULT_HOST: &str = "https://eu.i.posthog.com";

/// Resolve the PostHog ingestion token: runtime env wins (handy for dev /
/// smoke tests), else the build-time baked value, else none.
fn posthog_key() -> Option<String> {
    if let Ok(k) = std::env::var("AURA_POSTHOG_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    option_env!("AURA_POSTHOG_KEY")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolve the PostHog host (region). Env override, else build-time, else EU.
fn posthog_host() -> String {
    if let Ok(h) = std::env::var("AURA_POSTHOG_HOST") {
        let h = h.trim().trim_end_matches('/').to_string();
        if !h.is_empty() {
            return h;
        }
    }
    option_env!("AURA_POSTHOG_HOST")
        .map(str::trim)
        .map(|s| s.trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_HOST)
        .to_string()
}

/// `dev` for debug builds, `release` otherwise — lets growth charts exclude
/// developer noise without a separate project.
fn release_channel() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

// ── Consent (persisted in ~/.aura/credentials.json) ───────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct TelemetryConsent {
    /// Has the user answered the first-run consent prompt at all?
    pub decided: bool,
    /// Anonymous product analytics (usage counts + flows).
    pub product: bool,
    /// Crash / error reports.
    pub crash: bool,
}

fn read_bool(map: &Map<String, Value>, key: &str, default: bool) -> bool {
    map.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// Read current consent. Defaults: undecided; product/crash both true (the
/// prompt's pre-checked state) — but `decided=false` blocks all sending until
/// the user actually answers.
pub fn consent() -> TelemetryConsent {
    let map = read_credentials().unwrap_or_default();
    // Self-heal so the first-run prompt can never nag forever. The gate is the
    // explicit `telemetry_consent_decided` marker, but older builds (and the
    // Settings → Privacy toggle, which wrote `telemetry_enabled` alone) could
    // leave a telemetry preference on disk WITHOUT that marker — so the prompt
    // reappeared on every launch/update even though the user had already
    // chosen. Treat the presence of ANY explicit telemetry preference as a
    // decision: a fresh install (no telemetry keys at all) still gets asked
    // exactly once.
    let decided = read_bool(&map, "telemetry_consent_decided", false)
        || map.contains_key("telemetry_enabled")
        || map.contains_key("telemetry_crash_enabled");
    TelemetryConsent {
        decided,
        product: read_bool(&map, "telemetry_enabled", true),
        crash: read_bool(&map, "telemetry_crash_enabled", true),
    }
}

fn write_consent(product: bool, crash: bool) -> Result<(), String> {
    let path = aura_dir()?.join("credentials.json");
    let mut map = read_credentials().unwrap_or_default();
    map.insert("telemetry_consent_decided".into(), Value::Bool(true));
    map.insert("telemetry_enabled".into(), Value::Bool(product));
    map.insert("telemetry_crash_enabled".into(), Value::Bool(crash));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ── Event emission ────────────────────────────────────────────────────────

/// Build the property bag every event carries. `extra` (caller-supplied, a
/// JSON object of safe scalars) is merged last. `set_person` adds a one-time
/// person `$set` so PostHog builds/updates the person profile.
fn base_properties(extra: Option<Value>, set_person: bool, signed_in: bool) -> Value {
    let mut props = Map::new();
    props.insert("app_version".into(), json!(env!("CARGO_PKG_VERSION")));
    props.insert("os".into(), json!(std::env::consts::OS));
    props.insert("arch".into(), json!(std::env::consts::ARCH));
    props.insert("release_channel".into(), json!(release_channel()));
    props.insert("$lib".into(), json!("aura-shell-rust"));
    // Force person processing so unique-user / retention math populates even
    // for these anonymous (never-logged-in) installs.
    props.insert("$process_person_profile".into(), json!(true));

    if set_person {
        props.insert(
            "$set".into(),
            json!({
                "app_version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "release_channel": release_channel(),
                "signed_in": signed_in,
            }),
        );
        props.insert(
            "$set_once".into(),
            json!({ "first_app_version": env!("CARGO_PKG_VERSION") }),
        );
    }

    if let Some(Value::Object(extra)) = extra {
        for (k, v) in extra {
            // Never let a caller smuggle in person-merge or identity fields.
            if k == "distinct_id" || k == "$set" || k == "$set_once" {
                continue;
            }
            props.insert(k, v);
        }
    }
    Value::Object(props)
}

/// Whether the cloud account token is present — sent only as a boolean
/// `signed_in` person property (never the token, email, or name).
fn is_signed_in() -> bool {
    read_credentials()
        .ok()
        .and_then(|m| m.get("cloud_api_token").and_then(|v| v.as_str()).map(str::to_string))
        .map(|t| !t.is_empty())
        .unwrap_or(false)
}

/// Fire one event. Best-effort, non-blocking: spawns a detached task and
/// returns immediately. Silently no-ops when there's no key or no consent.
/// `respect` is the consent lever this event needs (product vs crash).
fn emit(event: &str, extra: Option<Value>, set_person: bool, lever: ConsentLever) {
    let c = consent();
    if !c.decided {
        return;
    }
    let allowed = match lever {
        ConsentLever::Product => c.product,
        ConsentLever::Crash => c.crash,
    };
    if !allowed {
        return;
    }
    let Some(key) = posthog_key() else {
        return;
    };
    let distinct_id = match crate::cmd_device::load_or_create_device() {
        Ok(d) if !d.device_id.trim().is_empty() => d.device_id,
        _ => return,
    };
    let signed_in = is_signed_in();
    let host = posthog_host();
    let payload = json!({
        "api_key": key,
        "event": event,
        "distinct_id": distinct_id,
        "properties": base_properties(extra, set_person, signed_in),
    });

    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let url = format!("{host}/capture/");
        let _ = client.post(&url).json(&payload).send().await;
    });
}

#[derive(Clone, Copy)]
enum ConsentLever {
    Product,
    Crash,
}

/// Internal helper for other Rust modules to record a product event.
pub fn track(event: &str, extra: Option<Value>) {
    emit(event, extra, false, ConsentLever::Product);
}

// ── Crash report forwarding (offline queue) ───────────────────────────────
//
// The panic hook (crash.rs) can't safely do async network I/O mid-panic, so
// it only writes a local JSON report. On the *next* launch we forward any
// not-yet-sent reports as `error` events (gated on crash consent), tracking
// what's been sent in a small sidecar set so we never double-report.

fn crashes_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("aura-shell-crashes"))
}

fn sent_index_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("telemetry-sent-crashes.json"))
}

fn read_sent_index() -> BTreeSet<u64> {
    let Some(path) = sent_index_path() else {
        return BTreeSet::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return BTreeSet::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_sent_index(set: &BTreeSet<u64>) {
    if let Some(path) = sent_index_path() {
        if let Ok(json) = serde_json::to_string(set) {
            let _ = fs::write(path, json);
        }
    }
}

/// Forward new crash reports as anonymous `error` events. Sends only the
/// panic message, the (Aura-internal) source location, the crashing thread
/// name, and the app version — never the full backtrace, and never any user
/// data (the local report stays on disk for the in-app recovery toast).
fn flush_pending_crashes() {
    let c = consent();
    if !c.decided || !c.crash {
        return;
    }
    let Some(dir) = crashes_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut sent = read_sent_index();
    let mut newly = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let ts = match path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok())
        {
            Some(t) => t,
            None => continue,
        };
        if sent.contains(&ts) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let extra = json!({
            "source": "app",
            "message": v.get("panic_message").and_then(|x| x.as_str()).unwrap_or(""),
            "location": v.get("location").and_then(|x| x.as_str()),
            "thread": v.get("thread").and_then(|x| x.as_str()),
            "crash_app_version": v.get("app_version").and_then(|x| x.as_str()),
        });
        // Emit under `crash` so the event lines up with the CLI's crash reports
        // and reads naturally on a PostHog dashboard. Keep the original `error`
        // event as a back-compat alias so any query already built on it (and the
        // historical series) doesn't go dark.
        emit("crash", Some(extra.clone()), false, ConsentLever::Crash);
        emit("error", Some(extra), false, ConsentLever::Crash);
        newly.push(ts);
    }
    if !newly.is_empty() {
        sent.extend(newly);
        // Bound the index so it can't grow forever on a crash-looping install.
        while sent.len() > 500 {
            if let Some(&oldest) = sent.iter().next() {
                sent.remove(&oldest);
            } else {
                break;
            }
        }
        write_sent_index(&sent);
    }
}

/// Called once from the app `.setup()` hook. Records the `app_opened` event
/// (with the per-launch person `$set`) and forwards any pending crash reports.
pub fn on_startup() {
    emit("app_opened", None, true, ConsentLever::Product);
    flush_pending_crashes();
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn telemetry_consent_get() -> Result<TelemetryConsent, String> {
    Ok(consent())
}

/// Persist the user's consent choice and mark it decided. Returns the new
/// state. If product analytics was just turned on for the first time, record
/// an `app_opened` so the install is counted from this launch.
#[tauri::command]
pub async fn telemetry_set_consent(product: bool, crash: bool) -> Result<TelemetryConsent, String> {
    write_consent(product, crash)?;
    let c = consent();
    if c.product {
        emit("app_opened", None, true, ConsentLever::Product);
    }
    flush_pending_crashes();
    Ok(c)
}

/// Record a product event from the frontend. `event` is a namespaced verb
/// (e.g. `feature_used`); `props` an optional object of safe scalars (e.g.
/// `{ "feature": "crew_run" }`). No-op without product consent / key.
#[tauri::command]
pub async fn telemetry_track(event: String, props: Option<Value>) -> Result<(), String> {
    let event = event.trim();
    if event.is_empty() {
        return Ok(());
    }
    track(event, props);
    Ok(())
}
