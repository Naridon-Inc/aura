//! Reading a box's answers back.
//!
//! The far side is a shell, so what comes back is lines of text produced by
//! programs that were written before we existed and are entitled to say
//! something we didn't plan for. Every parser here therefore skips what it
//! cannot read rather than failing the whole list: one odd row must not be able
//! to hide the four good ones above it.

use super::domain::{BoxProject, BoxSession};
use super::script::{basename, FIELD_SEP};

/// An option tmux never had is an empty string, not an absent field — so
/// "unset" and "set to nothing" arrive identically and both mean the same
/// thing here.
fn opt(v: &str) -> Option<String> {
    let t = v.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Which agent CLIs the box actually has — one binary name per line, as
/// `probe_agents` printed them. We only trust names that are plausibly binary
/// names (the same charset the probe was allowed to ask about); anything else
/// is shell noise that slipped into stdout and is skipped, not offered.
pub fn installed(stdout: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let name = line.trim_end_matches('\r').trim();
        if super::script::is_bin_name(name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The sessions running on a box.
///
/// Sessions started before any of this existed carry no `@aura_*` options at
/// all. They are still listed: something is running over there, and a list that
/// quietly omitted it would be worse than one that admits it knows little. They
/// read as `shell`, which is exactly what attaching one gives you.
pub fn sessions(stdout: &str) -> Vec<BoxSession> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FIELD_SEP).collect();
        if f.len() < 9 {
            continue;
        }
        let name = f[0].trim();
        if name.is_empty() {
            continue;
        }
        let project = f[1].trim().to_string();
        let title = match opt(f[5]) {
            Some(t) => t,
            // Fall back to the directory, then to the session's own name. Never
            // to a blank row: a session you can't name is one you won't click.
            None if !project.is_empty() => basename(&project).to_string(),
            None => name.to_string(),
        };
        out.push(BoxSession {
            name: name.to_string(),
            project,
            kind: opt(f[2]).unwrap_or_else(|| "shell".into()),
            agent: opt(f[3]),
            branch: opt(f[4]),
            title,
            created_at: f[6].trim().parse().unwrap_or(0),
            activity_at: f[7].trim().parse().unwrap_or(0),
            attached: f[8].trim().parse().unwrap_or(0),
        });
    }
    // Busiest first — a session that said something a minute ago is the one you
    // came here to look at.
    out.sort_by(|a, b| b.activity_at.cmp(&a.activity_at));
    out
}

/// The projects a box holds.
pub fn projects(stdout: &str) -> Vec<BoxProject> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FIELD_SEP).collect();
        if f.len() < 4 {
            continue;
        }
        let path = f[0].trim().to_string();
        if !path.starts_with('/') {
            continue;
        }
        out.push(BoxProject {
            name: basename(&path).to_string(),
            path,
            remote: opt(f[1]),
            branch: opt(f[2]),
            dirty: f[3].trim().parse().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(fields: &[&str]) -> String {
        fields.join(&FIELD_SEP.to_string())
    }

    #[test]
    fn installed_reads_the_binary_names_the_box_printed() {
        // One per line, as `probe_agents` emits via `command -v`.
        let got = installed("claude\ngemini\r\npi\n");
        assert_eq!(got, vec!["claude", "gemini", "pi"]);
    }

    #[test]
    fn installed_skips_shell_noise_that_isnt_a_binary_name() {
        // A stray banner line or a path with slashes is not an agent id.
        let got = installed("claude\n/usr/bin/env: bad\n\n  gemini  \n");
        assert_eq!(got, vec!["claude", "gemini"]);
    }

    #[test]
    fn installed_of_nothing_is_empty_not_a_panic() {
        assert!(installed("").is_empty());
    }

    #[test]
    fn a_full_row_reads_back_everything_we_stamped() {
        let s = sessions(&row(&[
            "aura-agent-naridon-k3f9",
            "/home/ubuntu/naridon",
            "agent",
            "claude",
            "fix/login",
            "Fix the login redirect",
            "1754300000",
            "1754300600",
            "2",
        ]));
        assert_eq!(s.len(), 1);
        let a = &s[0];
        assert_eq!(a.name, "aura-agent-naridon-k3f9");
        assert_eq!(a.project, "/home/ubuntu/naridon");
        assert_eq!(a.kind, "agent");
        assert_eq!(a.agent.as_deref(), Some("claude"));
        assert_eq!(a.branch.as_deref(), Some("fix/login"));
        assert_eq!(a.title, "Fix the login redirect");
        assert_eq!(a.created_at, 1_754_300_000);
        assert_eq!(a.activity_at, 1_754_300_600);
        assert_eq!(a.attached, 2);
    }

    #[test]
    fn a_session_from_before_any_of_this_is_still_listed() {
        // Every session the old shell path opened looks like this. Hiding them
        // would mean the box is running work the app swears isn't there.
        let s = sessions(&row(&[
            "aura-remote-1", "", "", "", "", "", "1754300000", "1754300001", "0",
        ]));
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].kind, "shell");
        assert_eq!(s[0].agent, None);
        assert_eq!(s[0].title, "aura-remote-1");
    }

    #[test]
    fn a_session_with_no_title_is_named_after_its_directory() {
        let s = sessions(&row(&[
            "aura-shell-x", "/home/ubuntu/naridon", "shell", "", "", "",
            "1754300000", "1754300001", "0",
        ]));
        assert_eq!(s[0].title, "naridon");
    }

    #[test]
    fn the_one_you_were_just_using_comes_first() {
        let out = sessions(&format!(
            "{}\n{}",
            row(&["a", "/p", "shell", "", "", "Older", "1", "100", "0"]),
            row(&["b", "/p", "shell", "", "", "Newer", "1", "900", "0"]),
        ));
        assert_eq!(out.iter().map(|s| &*s.name).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn no_tmux_server_is_an_empty_list_not_a_failure() {
        // The normal state of a box nobody is using.
        assert!(sessions("").is_empty());
        assert!(sessions("\n  \n").is_empty());
    }

    #[test]
    fn one_unreadable_row_does_not_hide_the_good_ones() {
        let out = sessions(&format!(
            "tmux: unknown option\n{}\nhalf\ta\trow\n",
            row(&["ok", "/p", "shell", "", "", "Fine", "1", "2", "0"]),
        ));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "ok");
    }

    #[test]
    fn a_number_the_box_did_not_send_is_zero_not_a_dropped_row() {
        let s = sessions(&row(&[
            "a", "/p", "shell", "", "", "T", "notanumber", "", "many",
        ]));
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].created_at, 0);
        assert_eq!(s[0].attached, 0);
    }

    #[test]
    fn projects_come_back_named_after_their_directory() {
        let p = projects(&format!(
            "{}\n{}",
            row(&[
                "/home/ubuntu/naridon",
                "https://github.com/Uniskool/naridon.git",
                "main",
                "3"
            ]),
            row(&["/home/ubuntu/aura-src", "", "feat/x", "0"]),
        ));
        assert_eq!(p.len(), 2);
        // Sorted by name, so the list doesn't reshuffle between reads.
        assert_eq!(p[0].name, "aura-src");
        assert_eq!(p[0].remote, None);
        assert_eq!(p[1].name, "naridon");
        assert_eq!(p[1].dirty, 3);
        assert_eq!(p[1].branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_relative_path_is_not_a_project() {
        // Only ever a sign the loop printed something we didn't mean it to.
        assert!(projects("naridon\t\tmain\t0").is_empty());
    }
}
