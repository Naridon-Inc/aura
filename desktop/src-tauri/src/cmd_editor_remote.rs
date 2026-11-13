//! Opening a workspace on a machine in a desktop editor, over that editor's
//! own SSH.
//!
//! VS Code and Cursor reach a folder on another computer through their
//! Remote-SSH extension, which dials with the system `ssh` and reads the
//! user's `~/.ssh/config` — it never sees the key the machine book holds. So a
//! link to the folder only works when that `ssh` would get in by itself: the
//! machine's key is one ssh tries without being told (`~/.ssh/id_ed25519` and
//! the rest, or one a `Host *` block names), or the user's own config has a
//! host that dials this machine with this key. Anything else would open an
//! editor window stuck asking for a password nobody has, so the caller gets
//! nothing and offers nothing.

use std::path::{Path, PathBuf};

/// The keys `ssh` tries when nothing names one.
const DEFAULT_KEYS: &[&str] = &[
    "id_rsa",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519",
    "id_ed25519_sk",
    "id_dsa",
];

/// A host or user an editor URI can carry as it is.
fn plain(s: &str) -> bool {
    !s.is_empty()
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn expand(path: &str, home: &Path) -> PathBuf {
    let p = path.trim().trim_matches('"');
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

/// One `Host` block of an ssh config: its patterns and the three settings
/// that decide where it dials and with what.
#[derive(Default)]
struct Block {
    patterns: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    keys: Vec<String>,
}

fn blocks(config: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    // Lines before the first `Host`, and inside a `Match`, belong to no block
    // this reads: a `Match` decides on things a file can't answer.
    let mut current: Option<Block> = None;
    for raw in config.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c == '=' || c.is_whitespace()) {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                out.extend(current.take());
                current = Some(Block {
                    patterns: value.split_whitespace().map(str::to_string).collect(),
                    ..Block::default()
                });
            }
            "match" => {
                out.extend(current.take());
            }
            "hostname" => {
                if let Some(b) = current.as_mut() {
                    b.host_name.get_or_insert_with(|| value.to_string());
                }
            }
            "user" => {
                if let Some(b) = current.as_mut() {
                    b.user.get_or_insert_with(|| value.to_string());
                }
            }
            "identityfile" => {
                if let Some(b) = current.as_mut() {
                    b.keys.push(value.to_string());
                }
            }
            _ => {}
        }
    }
    out.extend(current);
    out
}

/// The host to hand an editor's SSH so it reaches `user@host` with `key`, or
/// `None` when it couldn't get in by itself. PURE: the config text and home
/// folder are passed in.
pub fn editor_host(config: &str, host: &str, user: &str, key: &str, home: &Path) -> Option<String> {
    if !plain(host) || !plain(user) {
        return None;
    }
    let key = expand(key, home);
    let names_key = |b: &Block| b.keys.iter().any(|k| expand(k, home) == key);
    let all = blocks(config);
    // A host of the user's own that dials this machine with this key.
    for b in &all {
        let Some(alias) = b.patterns.iter().find(|p| plain(p)) else {
            continue;
        };
        if b.patterns.len() != 1 {
            continue;
        }
        let dials = b.host_name.as_deref().unwrap_or(alias).eq_ignore_ascii_case(host);
        let as_user = b.user.as_deref().map_or(true, |u| u == user);
        if dials && as_user && names_key(b) {
            return Some(match b.user {
                Some(_) => alias.clone(),
                None => format!("{user}@{alias}"),
            });
        }
    }
    // A key ssh tries anyway.
    let default = DEFAULT_KEYS.iter().any(|k| home.join(".ssh").join(k) == key);
    let everywhere = all
        .iter()
        .any(|b| b.patterns.iter().any(|p| p == "*") && names_key(b));
    (default || everywhere).then(|| format!("{user}@{host}"))
}

/// The host an editor's ssh should open this machine as, read off the book and
/// the user's own ssh config.
fn host_for(machine_id: &str) -> Option<String> {
    let m = crate::cmd_machines::find_machine(machine_id)?;
    let home = dirs::home_dir()?;
    let config = std::fs::read_to_string(home.join(".ssh").join("config")).unwrap_or_default();
    editor_host(&config, &m.host, &m.user, &m.key_path, &home)
}

/// A folder on the machine an editor link can name: absolute, going nowhere
/// above itself, one line.
fn folder_ok(folder: &str) -> bool {
    folder.starts_with('/')
        && !folder.split('/').any(|seg| seg == "..")
        && !folder.chars().any(char::is_control)
}

/// Which of VS Code and Cursor can open this machine's folders from here:
/// installed on this laptop, with the machine reachable by their own ssh.
/// Empty hides the choice.
#[tauri::command]
pub async fn machine_remote_editors(machine_id: String) -> Vec<String> {
    crate::blocking::run(move || {
        if host_for(&machine_id).is_none() {
            return Vec::new();
        }
        crate::cmd_editors::remote_editor_ids()
            .filter(|id| crate::cmd_editors::remote_capable(id))
            .map(str::to_string)
            .collect()
    })
    .await
}

/// Open `folder` on the machine in a Remote-SSH window of `editor_id`.
#[tauri::command]
pub async fn machine_open_in_editor(
    machine_id: String,
    editor_id: String,
    folder: String,
) -> Result<(), String> {
    crate::blocking::run(move || {
        if !folder_ok(&folder) {
            return Err(format!("{folder} isn't a folder an editor can open there."));
        }
        let host = host_for(&machine_id).ok_or_else(|| {
            "This machine signs in with a key only Aura holds, so an editor's own SSH can't reach it.".to_string()
        })?;
        crate::cmd_editors::open_remote(&editor_id, &host, &folder)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/mo")
    }

    #[test]
    fn a_default_key_opens_as_user_at_host() {
        let got = editor_host("", "1.2.3.4", "ubuntu", "/Users/mo/.ssh/id_ed25519", &home());
        assert_eq!(got.as_deref(), Some("ubuntu@1.2.3.4"));
    }

    #[test]
    fn a_key_only_aura_knows_is_not_offered() {
        assert_eq!(editor_host("", "1.2.3.4", "ubuntu", "/Users/mo/keys/box.pem", &home()), None);
    }

    #[test]
    fn the_users_own_host_for_this_machine_and_key_is_used() {
        let config = "Host *\n  ServerAliveInterval 30\n\nHost runner\n  HostName 1.2.3.4\n  User ubuntu\n  IdentityFile ~/keys/box.pem\n";
        let got = editor_host(config, "1.2.3.4", "ubuntu", "/Users/mo/keys/box.pem", &home());
        assert_eq!(got.as_deref(), Some("runner"));
    }

    #[test]
    fn a_host_with_no_user_is_given_the_machines() {
        let config = "Host runner\n  HostName=1.2.3.4\n  IdentityFile=\"/Users/mo/keys/box.pem\"\n";
        let got = editor_host(config, "1.2.3.4", "ubuntu", "/Users/mo/keys/box.pem", &home());
        assert_eq!(got.as_deref(), Some("ubuntu@runner"));
    }

    #[test]
    fn a_host_for_another_user_or_key_does_not_count() {
        let other_user = "Host runner\n  HostName 1.2.3.4\n  User root\n  IdentityFile ~/keys/box.pem\n";
        assert_eq!(editor_host(other_user, "1.2.3.4", "ubuntu", "~/keys/box.pem", &home()), None);
        let other_key = "Host runner\n  HostName 1.2.3.4\n  IdentityFile ~/keys/old.pem\n";
        assert_eq!(editor_host(other_key, "1.2.3.4", "ubuntu", "~/keys/box.pem", &home()), None);
    }

    #[test]
    fn a_key_every_host_uses_opens_as_user_at_host() {
        let config = "Host *\n  IdentityFile ~/keys/box.pem\n";
        let got = editor_host(config, "1.2.3.4", "ubuntu", "/Users/mo/keys/box.pem", &home());
        assert_eq!(got.as_deref(), Some("ubuntu@1.2.3.4"));
    }

    #[test]
    fn only_a_plain_absolute_folder_is_opened() {
        assert!(folder_ok("/home/ubuntu/app-feature"));
        assert!(folder_ok("/home/ubuntu/my app"));
        assert!(!folder_ok("home/ubuntu"));
        assert!(!folder_ok("/home/ubuntu/../root"));
        assert!(!folder_ok("/home/ubuntu/x\nrm"));
    }

    #[test]
    fn the_link_escapes_the_folder_and_keeps_the_host() {
        let got = crate::cmd_editors::remote_uri("vscode", "ubuntu@1.2.3.4", "/home/ubuntu/my app").unwrap();
        assert_eq!(got, "vscode://vscode-remote/ssh-remote+ubuntu@1.2.3.4/home/ubuntu/my%20app");
    }

    #[test]
    fn an_address_an_editor_uri_cant_carry_is_refused() {
        assert_eq!(editor_host("", "1.2.3.4/x", "ubuntu", "~/.ssh/id_rsa", &home()), None);
        assert_eq!(editor_host("", "1.2.3.4", "a b", "~/.ssh/id_rsa", &home()), None);
    }
}
