//! `claude setup-token` on this computer, for a member signing in from the
//! web.
//!
//! It is a full-screen terminal app, so it gets a terminal of its own. Its
//! screen is read for the sign-in link, its code box, and the token. The link
//! goes to the cloud for the member to open; the code the member pastes comes
//! back and is typed in; the token goes back once, to be saved as that member.
//! The screen is never logged.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use super::screen;
use super::{pty, Desk, Outcome, Report, BEAT, SCREEN_CAP, TICK};

/// The code and the Enter that submits it go in apart: Claude Code's code
/// box takes a code and an Enter in one read as one burst of typing.
const CODE_SETTLE: Duration = Duration::from_millis(300);

/// Sign-ins already on this computer that must not stand in for the member's.
const NOT_THEIRS: [&str; 3] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

pub fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.arg("setup-token").env("TERM", "xterm-256color");
    for var in NOT_THEIRS {
        cmd.env_remove(var);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.current_dir(home);
    }
    cmd
}

fn code_shaped(code: &str) -> bool {
    !code.is_empty() && code.len() <= 512 && !code.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn type_code(run: &mut pty::Running, code: &str) -> std::io::Result<()> {
    run.type_in(code.as_bytes())?;
    std::thread::sleep(CODE_SETTLE);
    run.type_in(b"\r")
}

fn keep(buf: &mut Vec<u8>, chunk: &[u8]) {
    buf.extend_from_slice(chunk);
    if buf.len() > SCREEN_CAP {
        buf.drain(..buf.len() - SCREEN_CAP);
    }
}

pub fn run(desk: &dyn Desk, bin: &Path, deadline: Instant, running: &AtomicBool) -> Outcome {
    let mut term = match pty::in_terminal(command(bin)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::Missing,
        Err(_) => return Outcome::Failed(None),
    };
    let mut raw = Vec::new();
    // What Claude Code printed once the member's code went in: its answer.
    let mut after_code = Vec::new();
    let mut screen_now = String::new();
    let (mut url, mut asks, mut code_sent) = (None::<String>, false, false);
    let mut posted: Option<(Report, Instant)> = None;
    let outcome = loop {
        if !running.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break Outcome::Failed(None);
        }
        match term.output.recv_timeout(TICK) {
            Ok(chunk) => {
                keep(&mut raw, &chunk);
                screen_now = screen::strip_ansi(&String::from_utf8_lossy(&raw));
                if let Some(token) = screen::claude_token(&screen_now) {
                    break Outcome::Got(token);
                }
                if code_sent {
                    keep(&mut after_code, &chunk);
                    let answer = screen::strip_ansi(&String::from_utf8_lossy(&after_code));
                    if let Some(said) = screen::claude_code_refused(&answer) {
                        break Outcome::Failed(Some(said));
                    }
                } else {
                    asks = asks || screen::claude_asks_for_code(&screen_now);
                }
                if url.is_none() {
                    url = screen::link_to(&screen_now, screen::CLAUDE_HOSTS);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break Outcome::Failed(screen::stopped_because(&screen_now)),
        }
        let report = Report {
            phase: if url.is_some() || asks { "browser" } else { "starting" },
            url: url.clone(),
            code_prompt: (asks && !code_sent).then_some("required"),
            ..Report::default()
        };
        let due = match &posted {
            Some((last, at)) => *last != report || at.elapsed() >= BEAT,
            None => true,
        };
        if !due {
            continue;
        }
        match desk.report(&report) {
            Ok(next) => {
                posted = Some((report, Instant::now()));
                if next.stop {
                    break Outcome::Stopped;
                }
                if let Some(code) = next.code {
                    let code = code.trim();
                    if asks && !code_sent && code_shaped(code) && type_code(&mut term, code).is_ok() {
                        code_sent = true;
                    }
                }
            }
            // A missed beat is retried on the next one.
            Err(_) => posted = Some((report, Instant::now())),
        }
    };
    term.stop();
    drop(raw);
    drop(after_code);
    outcome
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{fake_cli, Scripted};
    use super::*;

    fn fake_token() -> String {
        format!("sk-ant-oat01-{}-FAKEfake0", "F4ke_".repeat(19))
    }

    const LINK: &str = "https://claude.ai/oauth/authorize?code=true&state=st";

    /// A fake `claude setup-token` whose code box reads like a full-screen
    /// app: raw keys, one read at a time. A code with its Enter in one read is
    /// taken as typing and never submitted.
    fn raw_code_box(after_good_code: &str) -> String {
        format!(
            r#"[ "$1" = "setup-token" ] || {{ echo "bad args: $*"; exit 3; }}
[ -z "$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY" ] || {{ echo "Error: a sign-in leaked in"; exit 6; }}
stty raw -echo
printf '\033[1mBrowser didn'"'"'t open? Use the url below to sign in\033[0m\r\n\033[2m{LINK}\033[0m\r\n\r\nPaste code here if prompted > '
typed=$(dd bs=4096 count=1 2>/dev/null)
case "$typed" in *"$(printf '\r')"*) printf '\r\n(burst taken as typing)\r\n'; sleep 30; exit 4 ;; esac
enter=$(dd bs=16 count=1 2>/dev/null)
[ "$enter" = "$(printf '\r')" ] || {{ printf 'no enter\r\n'; exit 5; }}
{after_good_code}
sleep 30"#
        )
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    #[test]
    fn the_token_comes_back_after_the_member_pastes_the_code() {
        let dir = tempfile::tempdir().unwrap();
        let t = fake_token();
        let bin = fake_cli(
            dir.path(),
            "claude",
            &raw_code_box(&format!(
                r#"[ "$typed" = "fake-code#st" ] || {{ printf 'wrong code\r\n'; exit 2; }}
printf '\r\n\033[32mYour OAuth token (valid for 1 year):\033[0m\r\n\r\n%s\r\n\r\nStore this token securely.\r\n' '{t}'"#
            )),
        );
        let desk = Scripted::pasting(" fake-code#st ");
        let out = run(&desk, &bin, deadline(), &AtomicBool::new(true));
        assert_eq!(out, Outcome::Got(t));
        let reports = desk.reports();
        let asked = reports.iter().find(|r| r.code_prompt.is_some()).expect("the code box was reported");
        assert_eq!((asked.phase, asked.url.as_deref(), asked.code_prompt), ("browser", Some(LINK), Some("required")));
        let given = desk.code_given_at().expect("the pasted code was handed over");
        assert!(reports[given..].iter().all(|r| r.code_prompt.is_none()), "never asks again once the code is in");
        assert!(reports.iter().all(|r| r.error.is_none() && r.code.is_none()));
    }

    #[test]
    fn a_code_claude_code_turns_down_ends_the_sign_in_in_its_words() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "claude", &raw_code_box(r#"printf '\r\nInvalid code. Try again.\r\n'"#));
        let desk = Scripted::pasting("wrong-code");
        let out = run(&desk, &bin, deadline(), &AtomicBool::new(true));
        assert_eq!(out, Outcome::Failed(Some("Invalid code. Try again".into())));
    }

    #[test]
    fn told_to_stop_it_stops_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "claude", &raw_code_box(""));
        let desk = Scripted::stopping_after(2);
        let t = Instant::now();
        assert_eq!(run(&desk, &bin, deadline(), &AtomicBool::new(true)), Outcome::Stopped);
        assert!(t.elapsed() < Duration::from_secs(10), "never waits out the sign-in");
    }

    #[test]
    fn no_claude_on_this_computer_says_so() {
        let desk = Scripted::pasting("x");
        let out = run(&desk, Path::new("/nonexistent/aura-test/claude"), deadline(), &AtomicBool::new(true));
        assert_eq!(out, Outcome::Missing);
    }

    #[test]
    fn a_sign_in_already_on_this_computer_never_stands_in() {
        let cmd = command(Path::new("claude"));
        for var in NOT_THEIRS {
            assert!(cmd.get_envs().any(|(k, v)| k == var && v.is_none()), "{var} is taken out");
        }
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), ["setup-token"]);
    }
}
