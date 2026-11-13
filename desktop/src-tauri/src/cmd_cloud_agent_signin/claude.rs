//! `claude setup-token`, run in a terminal of its own.
//!
//! It is a full-screen terminal app, so it gets a real PTY — a very wide one,
//! so the token it prints is never wrapped. Its screen is read for three
//! things: the sign-in link, whether it is asking for the code the sign-in page
//! shows, and the token. The token is the only thing kept, and only long
//! enough to save it; the screen is never logged.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use super::{text, Fail, Flow, Got, Phase};

/// How much of the screen is kept to read from.
const SCREEN_CAP: usize = 256 * 1024;

pub(crate) async fn run(flow: Arc<Flow>, bin: PathBuf) -> Result<Got, Fail> {
    let f = flow.clone();
    let token = tokio::task::spawn_blocking(move || read_token(&f, &bin))
        .await
        .map_err(|e| Fail::Message(format!("Claude Code's sign-in stopped: {e}")))??;
    Ok(Got { name: "claude_code_oauth_token", value: token, account: None })
}

fn opened(e: impl std::fmt::Display) -> Fail {
    Fail::Message(format!("Claude Code couldn't start its sign-in: {e}"))
}

fn read_token(flow: &Flow, bin: &Path) -> Result<String, Fail> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 50, cols: 1000, pixel_width: 0, pixel_height: 0 })
        .map_err(opened)?;
    let mut cmd = CommandBuilder::new(bin);
    cmd.arg("setup-token");
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(opened)?;
    drop(pair.slave);
    if let Ok(mut k) = flow.killer.lock() {
        *k = Some(child.clone_killer());
    }
    let writer = pair.master.take_writer().map_err(opened)?;
    if let Ok(mut i) = flow.input.lock() {
        *i = Some(writer);
    }
    let mut reader = pair.master.try_clone_reader().map_err(opened)?;
    if flow.is_cancelled() {
        let _ = child.kill();
        return Err(Fail::Cancelled);
    }

    let mut raw: Vec<u8> = Vec::new();
    // What Claude Code printed once the member's code went in: its answer.
    let mut after_code: Vec<u8> = Vec::new();
    let mut refused: Option<String> = None;
    let mut buf = [0u8; 8192];
    let mut screen = String::new();
    let token = loop {
        match reader.read(&mut buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => break None,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > SCREEN_CAP {
                    raw.drain(..raw.len() - SCREEN_CAP);
                }
                screen = text::strip_ansi(&String::from_utf8_lossy(&raw));
                if let Some(t) = text::claude_token(&screen) {
                    break Some(t);
                }
                if flow.code_sent.load(Ordering::SeqCst) {
                    after_code.extend_from_slice(&buf[..n]);
                    if after_code.len() > SCREEN_CAP {
                        after_code.drain(..after_code.len() - SCREEN_CAP);
                    }
                    refused = text::claude_code_refused(&text::strip_ansi(&String::from_utf8_lossy(&after_code)));
                    if refused.is_some() {
                        break None;
                    }
                }
                let url = text::link_to(&screen, text::CLAUDE_HOSTS);
                let prompt = if flow.code_sent.load(Ordering::SeqCst) { None } else { text::claude_code_prompt(&screen) };
                if url.is_some() || prompt.is_some() {
                    flow.set(|s| {
                        s.phase = Phase::Browser;
                        if url.is_some() {
                            s.url = url;
                        }
                        if prompt.is_some() {
                            s.code_prompt = prompt;
                        }
                    });
                }
            }
        }
    };
    // Once the token is on screen it is already good; the CLI only waits for
    // a key press after that.
    let _ = child.kill();
    // Our end of the terminal closes before anything waits on Claude Code. A
    // process killed with output still unread on its terminal cannot finish
    // exiting — macOS holds it until that output drains — so waiting on it
    // with the terminal still open never returns, and the token would never
    // be saved.
    drop(reader);
    if let Ok(mut i) = flow.input.lock() {
        *i = None;
    }
    drop(pair.master);
    // Reaped off to the side: the sign-in is done either way.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    drop(raw);
    drop(after_code);
    match (token, refused) {
        (Some(t), _) => Ok(t),
        (None, _) if flow.is_cancelled() => Err(Fail::Cancelled),
        (None, Some(said)) => Err(Fail::Message(format!(
            "Claude Code didn't take that code ({said}). Start again and copy the whole code from the sign-in page."
        ))),
        (None, None) => Err(Fail::Message(stopped_early(&screen))),
    }
}

/// Why Claude Code stopped, in its own words when it gave any.
fn stopped_early(screen: &str) -> String {
    let said = screen
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.to_ascii_lowercase().contains("error") || l.to_ascii_lowercase().contains("failed"))
        .map(|l| l.chars().take(160).collect::<String>());
    match said {
        Some(l) => format!("Claude Code stopped before it finished signing in: {l}"),
        None => "Claude Code stopped before it finished signing in. Try again.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{drive, Agent, CodePrompt, Phase};
    use super::*;

    fn fake_token() -> String {
        format!("sk-ant-oat01-{}-FAKEfake0", "F4ke_".repeat(19))
    }

    /// A fake `claude setup-token` whose code box reads like a full-screen
    /// app: raw keys, one read at a time. A code with its Enter in the same
    /// read is taken as typing and never submitted — the way the real one
    /// leaves a sign-in hanging.
    fn raw_code_box(after_good_code: &str) -> String {
        format!(
            r#"[ "$1" = "setup-token" ] || {{ echo "bad args: $*"; exit 3; }}
stty raw -echo
printf '\033[1mBrowser didn'"'"'t open? Use the url below to sign in\033[0m\r\n\033[2mhttps://claude.ai/oauth/authorize?code=true&state=st\033[0m\r\n\r\nPaste code here if prompted > '
typed=$(dd bs=4096 count=1 2>/dev/null)
case "$typed" in *"$(printf '\r')"*) printf '\r\n(burst taken as typing)\r\n'; sleep 30; exit 4 ;; esac
enter=$(dd bs=16 count=1 2>/dev/null)
[ "$enter" = "$(printf '\r')" ] || {{ printf 'no enter\r\n'; exit 5; }}
{after_good_code}
sleep 30"#
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_is_saved_after_the_member_pastes_the_code() {
        // Claude Code is started in $HOME. A parallel test that borrowed HOME
        // and then deleted it would make that spawn fail with ENOENT, so
        // these tests hold HOME for themselves while Claude Code runs.
        let _home = crate::test_home::borrow();
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
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Claude, bin, saver));
        let s = wait_for(&flow, |s| s.code_prompt.is_some()).await;
        assert_eq!(s.phase, Phase::Browser);
        assert_eq!(s.code_prompt, Some(CodePrompt::Optional));
        assert_eq!(s.url.as_deref(), Some("https://claude.ai/oauth/authorize?code=true&state=st"));
        flow.send_code("  fake-code#st \n").await.unwrap();
        assert_eq!(flow.status().code_prompt, None, "the field goes once the code is in");
        let s = wait_for(&flow, |s| s.phase.is_over()).await;
        assert_eq!(s.phase, Phase::Connected, "{s:?}");
        run.await.unwrap();
        assert_eq!(saved.lock().unwrap().as_slice(), &[("claude_code_oauth_token".to_string(), t.clone())]);
        let shown = serde_json::to_string(&s).unwrap();
        assert!(!shown.contains("sk-ant"), "the renderer never sees the token");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_is_saved_while_claude_code_keeps_drawing() {
        let _home = crate::test_home::borrow();
        // After the token, the real CLI keeps redrawing its screen until a key
        // is pressed. Nothing reads that once the token is in hand, so the
        // terminal fills up behind it.
        let dir = tempfile::tempdir().unwrap();
        let t = fake_token();
        let bin = fake_cli(
            dir.path(),
            "claude",
            &format!(
                r#"printf 'Your OAuth token (valid for 1 year):\r\n\r\n%s\r\n\r\n' '{t}'
line=$(printf '%0900d' 0)
while :; do printf '%s\r\n' "$line"; done"#
            ),
        );
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Claude, bin, saver));
        let s = wait_for(&flow, |s| s.phase.is_over()).await;
        assert_eq!(s.phase, Phase::Connected, "{s:?}");
        tokio::time::timeout(std::time::Duration::from_secs(5), run).await.expect("the sign-in ends").unwrap();
        assert_eq!(saved.lock().unwrap().as_slice(), &[("claude_code_oauth_token".to_string(), t)]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_code_claude_code_turns_down_ends_the_sign_in_in_its_words() {
        let _home = crate::test_home::borrow();
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(
            dir.path(),
            "claude",
            &raw_code_box(
                r#"printf '\r\n\033[31mInvalid code. Please make sure the full code was copied\033[0m\r\nPress Enter to retry.\r\n'"#,
            ),
        );
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Claude, bin, saver));
        wait_for(&flow, |s| s.code_prompt.is_some()).await;
        flow.send_code("half-a-code").await.unwrap();
        let s = tokio::time::timeout(std::time::Duration::from_secs(10), wait_for(&flow, |s| s.phase.is_over()))
            .await
            .expect("a refused code ends the sign-in instead of leaving it waiting");
        run.await.unwrap();
        assert_eq!(s.phase, Phase::Failed);
        let e = s.error.unwrap();
        assert!(e.contains("Invalid code. Please make sure the full code was copied"), "{e}");
        assert!(saved.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sign_in_that_fails_says_so_and_saves_nothing() {
        let _home = crate::test_home::borrow();
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "claude", r#"printf 'OAuth error: fake failure\r\n'; exit 1"#);
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        drive(flow.clone(), Agent::Claude, bin, saver).await;
        let s = flow.status();
        assert_eq!(s.phase, Phase::Failed);
        assert!(s.error.unwrap().contains("OAuth error: fake failure"));
        assert!(saved.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_stops_claude_code_and_saves_nothing() {
        let _home = crate::test_home::borrow();
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(
            dir.path(),
            "claude",
            r#"printf 'Use the URL below to sign in\r\nhttps://claude.ai/oauth/authorize?x=1\r\n'; read never"#,
        );
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Claude, bin, saver));
        wait_for(&flow, |s| s.phase == Phase::Browser).await;
        flow.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), run).await.expect("stopped").unwrap();
        assert_eq!(flow.status().phase, Phase::Cancelled);
        assert!(saved.lock().unwrap().is_empty());
    }
}
