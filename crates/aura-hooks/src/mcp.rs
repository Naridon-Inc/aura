//! Telling an agent where Aura's tools are.
//!
//! Two files, because there are two ways a Claude session starts and they
//! read different config. One the app passes explicitly with `--mcp-config`;
//! the other Claude finds on its own by being run inside the repo. A session
//! started from a plain terminal only ever sees the second, which is exactly
//! the case the desktop-only wiring used to miss.

use std::path::Path;

/// Write `~/.aura/shell-mcp-config.json` — the config the app hands Claude as
/// `--mcp-config` — and return its path.
///
/// Rewritten every time rather than created-if-absent, so a moved `aura`
/// binary or a changed argument list is picked up instead of being pinned by
/// whatever the first launch happened to see. `None` on filesystem failure, in
/// which case the spawn falls back to the user's own global config.
pub fn ensure_shell_mcp_config() -> Option<String> {
    let mut path = crate::aura_home()?;
    let _ = std::fs::create_dir_all(&path);
    path.push("shell-mcp-config.json");

    let body = serde_json::json!({ "mcpServers": { SERVER_NAME: aura_server() } });
    std::fs::write(&path, serde_json::to_string_pretty(&body).ok()?).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Declare the aura MCP server in `<repo_root>/.mcp.json`, so *any* Claude
/// session opened in this repo loads `aura_log_intent`, `aura_snapshot` and
/// the rest — including one started from a plain terminal that never went
/// near the desktop app.
///
/// Merge-safe: other servers the user declared are preserved and only the
/// `aura` entry is added or refreshed. Returns false without writing if
/// `mcpServers` exists but isn't an object — that is a hand-written file in a
/// shape we don't understand, and overwriting it would lose their work.
///
/// The file is kept out of `git status` through `.git/info/exclude`, written
/// on the same repo-open pass.
pub fn ensure_repo_mcp_json(repo_root: &str) -> bool {
    let path = Path::new(repo_root).join(".mcp.json");

    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let serde_json::Value::Object(servers_map) = servers else {
        return false;
    };
    servers_map.insert(SERVER_NAME.to_string(), aura_server());
    if SERVER_NAME != LEGACY_SERVER_NAME {
        servers_map
            .retain(|name, v| name != LEGACY_SERVER_NAME || !is_legacy_aura_server(v));
    }

    match serde_json::to_string_pretty(&serde_json::Value::Object(root)) {
        Ok(s) => std::fs::write(&path, s).is_ok(),
        Err(_) => false,
    }
}

/// What the server is called wherever Aura declares it.
///
/// One name, in one place, because the name is not private: it prefixes every
/// tool the agent sees (`mcp__aura-vcs__aura_log_intent`), the transcript
/// renderers strip exactly this prefix, and CLAUDE.md documents it. It is
/// `aura-vcs` rather than `aura` because that is what `aura init` has always
/// written and what the great majority of repos already carry.
pub const SERVER_NAME: &str = "aura-vcs";

/// A name Aura used to write for the same server, from the desktop app only.
///
/// Left behind, it is not a stale entry that does nothing — it is a *second,
/// working* copy: Claude starts two `aura mcp` processes and shows every tool
/// twice under two prefixes, doubling the tool schemas in the context window
/// of every session in the repo. So re-wiring collapses it.
const LEGACY_SERVER_NAME: &str = "aura";

/// The server entry both files carry, so they cannot describe Aura
/// differently.
fn aura_server() -> serde_json::Value {
    // An absolute path where we can find one: the agent inherits whatever
    // shell init it was started under, and a bare `aura` only resolves if
    // that init happened to put it on PATH.
    let bin = which_aura().unwrap_or_else(|| "aura".to_string());
    serde_json::json!({ "command": bin, "args": ["mcp"] })
}

/// Is this entry Aura's own server under the old name? Deliberately narrow:
/// it must run a binary called `aura` with exactly `mcp`, so a server someone
/// happened to name `aura` that runs something else is not touched.
fn is_legacy_aura_server(v: &serde_json::Value) -> bool {
    let runs_aura = v
        .get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c == "aura" || c.ends_with("/aura"));
    let mcp_only = v
        .get("args")
        .and_then(|a| a.as_array())
        .is_some_and(|a| a.len() == 1 && a[0] == "mcp");
    runs_aura && mcp_only
}

/// Absolute path to the `aura` on PATH, if there is one.
pub fn which_aura() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/which")
        .arg("aura")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_repo_gets_the_aura_server() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert!(ensure_repo_mcp_json(&root));

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v["mcpServers"][SERVER_NAME]["args"][0], "mcp");
    }

    #[test]
    fn another_server_in_the_file_survives() {
        // The whole reason this merges rather than writes: people declare
        // their own servers here, and losing them would be silent.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"mine":{"command":"my-server"}},"other":42}"#,
        )
        .unwrap();

        assert!(ensure_repo_mcp_json(&dir.path().to_string_lossy()));

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v["mcpServers"]["mine"]["command"], "my-server");
        assert_eq!(v["other"], 42);
        assert!(v["mcpServers"][SERVER_NAME].is_object());
    }

    #[test]
    fn stamping_twice_leaves_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert!(ensure_repo_mcp_json(&root));
        let first = std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap();
        assert!(ensure_repo_mcp_json(&root));
        assert_eq!(first, std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap());
    }

    #[test]
    fn the_old_name_for_our_own_server_is_collapsed() {
        // Two writers used to name the same server differently, so a repo set
        // up by both carried both — two `aura mcp` processes and every tool
        // listed twice under two prefixes, in every session in the repo.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"aura":{"command":"/opt/bin/aura","args":["mcp"]}}}"#,
        )
        .unwrap();

        assert!(ensure_repo_mcp_json(&dir.path().to_string_lossy()));

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert!(v["mcpServers"]["aura"].is_null(), "the duplicate survived");
        assert!(v["mcpServers"][SERVER_NAME].is_object());
    }

    #[test]
    fn a_server_that_merely_shares_the_old_name_is_not_ours_to_remove() {
        // The prune is by what the entry runs, not by what it is called. A
        // server someone named `aura` that starts something else is theirs.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"aura":{"command":"node","args":["my-aura-server.js"]}}}"#,
        )
        .unwrap();

        assert!(ensure_repo_mcp_json(&dir.path().to_string_lossy()));

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v["mcpServers"]["aura"]["command"], "node");
        assert!(v["mcpServers"][SERVER_NAME].is_object());
    }

    #[test]
    fn a_hand_written_shape_we_dont_understand_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let hand_written = r#"{"mcpServers":"see the other file"}"#;
        std::fs::write(dir.path().join(".mcp.json"), hand_written).unwrap();

        assert!(!ensure_repo_mcp_json(&dir.path().to_string_lossy()));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap(),
            hand_written,
        );
    }
}
