//! `git-remote-aura` — the transport that makes `aura://` a real git remote.
//!
//! This is the shared implementation of the git remote helper. It is compiled
//! into two places from this single file:
//!   * the standalone `git-remote-aura` binary (`src/bin/git_remote_aura.rs`,
//!     which `#[path]`-includes this file), for `cargo install`; and
//!   * the main `aura` binary, which dispatches here when it is invoked under
//!     the name `git-remote-aura` (a busybox-style multi-call symlink created by
//!     `aura node install-helper`). That way the helper is available wherever
//!     `aura` is, including the app bundle, without shipping a second binary.
//!
//! Git discovers the helper on `PATH` when it sees a URL whose scheme is `aura`
//! (e.g. `git clone aura://node.example/<repo-id>`) and invokes it as a
//! [remote helper]: `git-remote-aura <remote> <url>`. Rather than reimplement
//! the remote-helper protocol, we rewrite the `aura://` URL to the node's
//! **smart-HTTP** URL and `exec()` git's own `git-remote-http`, which already
//! speaks the protocol perfectly and inherits our exact stdio.
//!
//! Scheme resolution (see [`resolve_aura_url`]):
//!   * loopback hosts (`localhost`, `127.0.0.1`, `::1`) → `http://`, with the
//!     node default port `9419` filled in when the URL omits one;
//!   * every other host → `https://`;
//!   * `AURA_REMOTE_INSECURE=1` forces `http://` (same default-port fill) for a
//!     plain-HTTP remote node during testing.
//!
//! [remote helper]: https://git-scm.com/docs/gitremote-helpers

use std::process::Command;

/// The default port an `aura node serve` binds when none is written in the URL.
/// Kept in sync with `aura node serve --addr` (aura-cli/src/node/mod.rs).
const DEFAULT_NODE_PORT: u16 = 9419;

/// Run the remote helper: read `<remote> <url>` from argv, resolve the URL, and
/// hand off to `git-remote-http`. Never returns — it either `exec`s the backend
/// or exits with a diagnostic.
pub fn run() -> ! {
    // git invokes: `git-remote-aura <remote> [<url>]`. When the second argument
    // is omitted the remote *is* the URL (an anonymous remote), per the
    // remote-helper contract.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (remote, raw_url) = match args.as_slice() {
        [remote, url, ..] => (remote.as_str(), url.as_str()),
        [only] => (only.as_str(), only.as_str()),
        [] => {
            eprintln!(
                "git-remote-aura: expected `<remote> <url>` from git — this is a git remote \
                 helper, not meant to be run directly. Try `git clone aura://<host>/<repo-id>`."
            );
            std::process::exit(2);
        }
    };

    let insecure = env_flag("AURA_REMOTE_INSECURE");
    let http_url = match resolve_aura_url(raw_url, insecure) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("git-remote-aura: {e}");
            std::process::exit(2);
        }
    };

    let backend = match git_remote_http_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("git-remote-aura: {e}");
            std::process::exit(2);
        }
    };

    delegate(&backend, remote, &http_url);
}

/// Locate git's own `git-remote-http` helper via `git --exec-path`.
fn git_remote_http_path() -> Result<String, String> {
    let out = Command::new("git")
        .arg("--exec-path")
        .output()
        .map_err(|e| format!("could not run git (is it installed and on PATH?): {e}"))?;
    if !out.status.success() {
        return Err("`git --exec-path` failed — is git installed?".to_string());
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let candidate = std::path::Path::new(&dir).join("git-remote-http");
    if candidate.exists() {
        return Ok(candidate.to_string_lossy().into_owned());
    }
    Err(format!(
        "git-remote-http not found (looked in {dir}) — it ships with a standard git install and \
         is required to speak smart-HTTP to the Aura node"
    ))
}

/// Replace this process with `git-remote-http <remote> <http_url>`, so git's
/// helper inherits our stdio and drives the exchange git already started. On
/// success this never returns; on non-Unix platforms we spawn-and-wait and
/// propagate the child's exit code.
#[cfg(unix)]
fn delegate(backend: &str, remote: &str, http_url: &str) -> ! {
    use std::os::unix::process::CommandExt;
    let err = Command::new(backend).arg(remote).arg(http_url).exec();
    // exec only returns on failure.
    eprintln!("git-remote-aura: failed to exec {backend}: {err}");
    std::process::exit(1);
}

#[cfg(not(unix))]
fn delegate(backend: &str, remote: &str, http_url: &str) -> ! {
    match Command::new(backend).arg(remote).arg(http_url).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("git-remote-aura: failed to run {backend}: {e}");
            std::process::exit(1);
        }
    }
}

/// Read an environment variable as a boolean flag. Truthy values (case
/// insensitive): `1`, `true`, `yes`, `on`.
fn env_flag(name: &str) -> bool {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

/// Rewrite an `aura://` URL to the underlying smart-HTTP URL the Aura node
/// serves. Preserves any userinfo and path; picks `http` vs `https` from the
/// host (loopback → http) unless `insecure` forces `http`; fills the default
/// node port when the URL omits one on an `http` target.
pub fn resolve_aura_url(url: &str, insecure: bool) -> Result<String, String> {
    let rest = url
        .strip_prefix("aura://")
        .ok_or_else(|| format!("not an aura:// URL: {url}"))?;

    // Split authority from the path at the first '/'. `aura://host/foo` →
    // authority `host`, path `/foo`; `aura://host` → authority `host`, path ``.
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err(format!("aura:// URL has no host: {url}"));
    }

    // Peel optional `userinfo@` (keep it verbatim for the rewritten URL).
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(i) => (&authority[..=i], &authority[i + 1..]),
        None => ("", authority),
    };
    if hostport.is_empty() {
        return Err(format!("aura:// URL has no host: {url}"));
    }

    let (host, has_port) = split_host_port(hostport);
    let use_http = insecure || is_loopback_host(host);
    let scheme = if use_http { "http" } else { "https" };

    // On an http target with no explicit port, target the node default so
    // `aura://localhost/<id>` reaches a dev `aura node serve`.
    let hostport = if use_http && !has_port {
        format!("{hostport}:{DEFAULT_NODE_PORT}")
    } else {
        hostport.to_string()
    };

    Ok(format!("{scheme}://{userinfo}{hostport}{path}"))
}

/// Extract the host from a `host`, `host:port`, `[ipv6]`, or `[ipv6]:port`
/// authority, and report whether an explicit port was present.
fn split_host_port(hostport: &str) -> (&str, bool) {
    if let Some(close) = hostport.strip_prefix('[').and_then(|_| hostport.find(']')) {
        // Bracketed IPv6 literal: `[::1]` or `[::1]:9419`.
        let host = &hostport[1..close];
        let has_port = hostport[close + 1..].starts_with(':');
        return (host, has_port);
    }
    match hostport.rfind(':') {
        // A trailing `:<digits>` is a port; anything else is part of the host.
        Some(i) if hostport[i + 1..].chars().all(|c| c.is_ascii_digit()) && i + 1 < hostport.len() => {
            (&hostport[..i], true)
        }
        _ => (hostport, false),
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_becomes_http_with_default_port() {
        assert_eq!(
            resolve_aura_url("aura://localhost/abc123", false).unwrap(),
            "http://localhost:9419/abc123"
        );
        assert_eq!(
            resolve_aura_url("aura://127.0.0.1/abc123", false).unwrap(),
            "http://127.0.0.1:9419/abc123"
        );
    }

    #[test]
    fn explicit_port_is_preserved() {
        assert_eq!(
            resolve_aura_url("aura://127.0.0.1:9431/abc123", false).unwrap(),
            "http://127.0.0.1:9431/abc123"
        );
    }

    #[test]
    fn remote_host_becomes_https() {
        assert_eq!(
            resolve_aura_url("aura://node.example.com/repo-id", false).unwrap(),
            "https://node.example.com/repo-id"
        );
        assert_eq!(
            resolve_aura_url("aura://node.example.com:8443/repo-id", false).unwrap(),
            "https://node.example.com:8443/repo-id"
        );
    }

    #[test]
    fn insecure_flag_forces_http_for_remote_host() {
        assert_eq!(
            resolve_aura_url("aura://node.example.com/repo-id", true).unwrap(),
            "http://node.example.com:9419/repo-id"
        );
        assert_eq!(
            resolve_aura_url("aura://node.example.com:8080/repo-id", true).unwrap(),
            "http://node.example.com:8080/repo-id"
        );
    }

    #[test]
    fn userinfo_is_preserved() {
        assert_eq!(
            resolve_aura_url("aura://tok@node.example.com/repo-id", false).unwrap(),
            "https://tok@node.example.com/repo-id"
        );
    }

    #[test]
    fn ipv6_loopback_and_ports() {
        assert_eq!(
            resolve_aura_url("aura://[::1]/abc", false).unwrap(),
            "http://[::1]:9419/abc"
        );
        assert_eq!(
            resolve_aura_url("aura://[::1]:9431/abc", false).unwrap(),
            "http://[::1]:9431/abc"
        );
    }

    #[test]
    fn trailing_dotgit_and_nested_path_pass_through() {
        assert_eq!(
            resolve_aura_url("aura://localhost:9431/abc.git", false).unwrap(),
            "http://localhost:9431/abc.git"
        );
        assert_eq!(
            resolve_aura_url("aura://localhost:9431/abc/info/refs", false).unwrap(),
            "http://localhost:9431/abc/info/refs"
        );
    }

    #[test]
    fn rejects_non_aura_and_hostless() {
        assert!(resolve_aura_url("http://localhost/abc", false).is_err());
        assert!(resolve_aura_url("aura:///abc", false).is_err());
    }

    #[test]
    fn split_host_port_cases() {
        assert_eq!(split_host_port("host"), ("host", false));
        assert_eq!(split_host_port("host:80"), ("host", true));
        assert_eq!(split_host_port("[::1]"), ("::1", false));
        assert_eq!(split_host_port("[::1]:80"), ("::1", true));
        assert_eq!(split_host_port("host:"), ("host:", false));
    }
}
