use crate::session::SessionManager;

/// Recognized OpenCode environment variables
const OPENCODE_ENV_VARS: &[&str] = &[
    "OPENCODE_SESSION",
    "OPENCODE_PROJECT",
    "OPENCODE_VERSION",
];

/// Detect if OpenCode is running in the current environment
pub fn detect_opencode() -> Option<OpenCodeInfo> {
    // Method 1: Check environment variables
    for var in OPENCODE_ENV_VARS {
        if std::env::var(var).is_ok() {
            return Some(OpenCodeInfo {
                detection_method: "env_var".to_string(),
                version: std::env::var("OPENCODE_VERSION").ok(),
                session_id: std::env::var("OPENCODE_SESSION").ok(),
                project: std::env::var("OPENCODE_PROJECT").ok(),
            });
        }
    }

    // Method 2: Check if opencode process is running
    if let Some(info) = detect_opencode_process() {
        return Some(info);
    }

    // Method 3: Check for .opencode directory or config
    if std::path::Path::new(".opencode").exists()
        || std::path::Path::new(".opencode.json").exists()
    {
        return Some(OpenCodeInfo {
            detection_method: "config_file".to_string(),
            version: None,
            session_id: None,
            project: std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
        });
    }

    None
}

/// Information about a detected OpenCode instance
#[derive(Debug, Clone)]
pub struct OpenCodeInfo {
    pub detection_method: String,
    pub version: Option<String>,
    pub session_id: Option<String>,
    pub project: Option<String>,
}

/// Start an Aura session bridged to OpenCode
pub fn bridge_opencode_session(info: &OpenCodeInfo) -> String {
    let agent_id = format!(
        "opencode{}",
        info.version
            .as_ref()
            .map(|v| format!("/{}", v))
            .unwrap_or_default()
    );
    let session = SessionManager::start_session(&agent_id);

    if let Some(ref project) = info.project {
        SessionManager::set_first_prompt(&format!("OpenCode session in {}", project));
    }

    session.session_id
}

/// Detect opencode process via sysinfo
fn detect_opencode_process() -> Option<OpenCodeInfo> {
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    for (_pid, process) in sys.processes() {
        let name = process.name().to_string_lossy().to_lowercase();
        if name.contains("opencode") {
            return Some(OpenCodeInfo {
                detection_method: "process".to_string(),
                version: None,
                session_id: None,
                project: process
                    .cwd()
                    .map(|p| p.to_string_lossy().to_string()),
            });
        }
    }

    None
}

/// Generate wrapper script content for `aura wrap opencode`
pub fn generate_wrapper_script() -> String {
    r#"#!/bin/bash
# Aura-OpenCode Integration Wrapper
# Usage: aura wrap opencode [opencode-args...]
#
# This wraps OpenCode inside an Aura session context,
# enabling semantic tracking even without native hook support.

set -e

# Start Aura session
SESSION_ID=$(aura status --json 2>/dev/null | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)
if [ -z "$SESSION_ID" ]; then
    echo "[Aura] Starting new session for OpenCode..."
fi

# Export Aura context for OpenCode to discover
export AURA_SESSION_ACTIVE=1
export AURA_AGENT="opencode"

# Set up file watcher to capture edits
aura daemon &
AURA_DAEMON_PID=$!

# Trap to end session on exit
cleanup() {
    kill $AURA_DAEMON_PID 2>/dev/null || true
    echo "[Aura] Session ended. Run 'aura status' to see tracked changes."
}
trap cleanup EXIT

# Launch OpenCode with all passed arguments
opencode "$@"
"#
    .to_string()
}
