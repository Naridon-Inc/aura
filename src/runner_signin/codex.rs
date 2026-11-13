//! `codex login --device-auth` on this computer, for a member signing in
//! from the web.
//!
//! A computer's own sign-in server is out of the member's reach, so the
//! device-code sign-in is the way in: Codex prints a link and a one-time code,
//! the member enters the code on that page, and Codex saves the sign-in. It
//! runs in a Codex home that exists for this one sign-in — a fresh 0700
//! directory with the credential store forced to a file — so this computer's
//! own Codex sign-in is never read or changed. Its `auth.json` goes back once,
//! to be saved as the member, and the directory is removed.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use super::screen;
use super::{pty, Desk, Outcome, Report, BEAT, SCREEN_CAP, TICK};

/// The config override that keeps the sign-in in `$CODEX_HOME/auth.json`.
const FILE_STORE: &str = r#"cli_auth_credentials_store="file""#;

/// Sign-ins already on this computer that must not stand in for the member's.
const NOT_THEIRS: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/// The most of `auth.json` read back.
const AUTH_CAP: u64 = 64 * 1024;

pub fn command(bin: &Path, home: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(["-c", FILE_STORE, "login", "--device-auth"]).env("CODEX_HOME", home);
    for var in NOT_THEIRS {
        cmd.env_remove(var);
    }
    cmd
}

fn private_home() -> std::io::Result<tempfile::TempDir> {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::Builder::new().prefix("aura-codex-signin-").tempdir()?;
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700))?;
    Ok(home)
}

fn read_auth(home: &Path) -> Option<String> {
    use std::io::Read;
    let mut raw = String::new();
    std::fs::File::open(home.join("auth.json")).ok()?.take(AUTH_CAP).read_to_string(&mut raw).ok()?;
    (!raw.trim().is_empty()).then_some(raw)
}

pub fn run(desk: &dyn Desk, bin: &Path, deadline: Instant, running: &AtomicBool) -> Outcome {
    let Ok(home) = private_home() else { return Outcome::Failed(None) };
    let mut proc = match pty::on_pipes(command(bin, home.path())) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::Missing,
        Err(_) => return Outcome::Failed(None),
    };
    let mut screen_now = String::new();
    let (mut url, mut code) = (None::<String>, None::<String>);
    let mut posted: Option<(Report, Instant)> = None;
    let mut exited: Option<bool> = None;
    let outcome = loop {
        if !running.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break Outcome::Failed(None);
        }
        match proc.output.recv_timeout(TICK) {
            Ok(chunk) => {
                screen_now.push_str(&screen::strip_ansi(&String::from_utf8_lossy(&chunk)));
                if screen_now.len() > SCREEN_CAP {
                    let cut = screen_now.len() - SCREEN_CAP;
                    let cut = (cut..screen_now.len()).find(|i| screen_now.is_char_boundary(*i)).unwrap_or(0);
                    screen_now.drain(..cut);
                }
                code = code.or_else(|| screen::codex_device_code(&screen_now));
                url = url.or_else(|| screen::link_to(&screen_now, screen::OPENAI_HOSTS));
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Both pipes closed: what it printed on its way out is all in.
            Err(RecvTimeoutError::Disconnected) => {
                let end = Instant::now() + Duration::from_secs(2);
                while exited.is_none() && Instant::now() < end {
                    exited = proc.exited();
                    std::thread::sleep(Duration::from_millis(20));
                }
                break match exited {
                    Some(true) => match read_auth(home.path()) {
                        Some(raw) => Outcome::Got(raw),
                        None => Outcome::Failed(Some("Codex finished without saving a sign-in".into())),
                    },
                    _ => Outcome::Failed(screen::stopped_because(&screen_now)),
                };
            }
        }
        if exited.is_none() {
            exited = proc.exited();
        }
        let report = Report {
            phase: if code.is_some() { "device_code" } else { "starting" },
            url: if code.is_some() { url.clone() } else { None },
            code: code.clone(),
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
            Ok(next) if next.stop => break Outcome::Stopped,
            _ => posted = Some((report, Instant::now())),
        }
    };
    proc.stop();
    let _ = home.close();
    outcome
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{fake_cli, Scripted};
    use super::*;

    const DEVICE_STEPS: &str = r#"[ "$*" = '-c cli_auth_credentials_store="file" login --device-auth' ] || { echo "bad args: $*"; exit 3; }
[ -n "$CODEX_HOME" ] && [ "$(stat -f %Lp "$CODEX_HOME" 2>/dev/null || stat -c %a "$CODEX_HOME")" = 700 ] || { echo "Error: not a private home"; exit 4; }
printf '\033[1mFollow these steps to sign in with ChatGPT using device code authorization:\033[0m\n'
printf '1. Open this link in your browser and sign in\n   https://auth.openai.com/codex/device\n'
printf '2. Enter this one-time code (expires in 15 minutes)\n   \033[94mABCD-1234\033[0m\n'
"#;

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    #[test]
    fn the_device_code_is_shown_and_the_sign_in_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let script = format!(
            "{DEVICE_STEPS}sleep 1\nprintf '%s' '{{\"auth_mode\":\"chatgpt\",\"tokens\":{{\"id_token\":\"a.b.c\",\"access_token\":\"fake\",\"refresh_token\":\"fake\"}}}}' > \"$CODEX_HOME/auth.json\"\necho 'Successfully logged in'\n"
        );
        let bin = fake_cli(dir.path(), "codex", &script);
        let desk = Scripted::pasting("unused");
        let Outcome::Got(raw) = run(&desk, &bin, deadline(), &AtomicBool::new(true)) else { panic!("signed in") };
        assert!(raw.starts_with("{\"auth_mode\":\"chatgpt\""));
        let shown = desk.reports().into_iter().find(|r| r.phase == "device_code").expect("the code was reported");
        assert_eq!(shown.code.as_deref(), Some("ABCD-1234"));
        assert_eq!(shown.url.as_deref(), Some("https://auth.openai.com/codex/device"));
        assert_eq!(shown.code_prompt, None, "nothing is pasted back for Codex");
    }

    #[test]
    fn a_sign_in_that_fails_says_why_without_its_link() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "codex", &format!("{DEVICE_STEPS}echo 'Error: device code expired'\nexit 1\n"));
        let desk = Scripted::pasting("unused");
        let out = run(&desk, &bin, deadline(), &AtomicBool::new(true));
        assert_eq!(out, Outcome::Failed(Some("Error: device code expired".into())));
    }

    #[test]
    fn told_to_stop_it_stops_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "codex", &format!("{DEVICE_STEPS}sleep 30\n"));
        let desk = Scripted::stopping_after(2);
        let t = Instant::now();
        assert_eq!(run(&desk, &bin, deadline(), &AtomicBool::new(true)), Outcome::Stopped);
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_sign_in_already_on_this_computer_never_stands_in() {
        let cmd = command(Path::new("codex"), Path::new("/tmp/h"));
        for var in NOT_THEIRS {
            assert!(cmd.get_envs().any(|(k, v)| k == var && v.is_none()), "{var} is taken out");
        }
        assert!(cmd.get_envs().any(|(k, v)| k == "CODEX_HOME" && v == Some(std::ffi::OsStr::new("/tmp/h"))));
    }
}
