//! `codex login`, in a Codex home that exists for one sign-in.
//!
//! The home is a fresh 0700 temporary directory and the credential store is
//! forced to a file, so the member's own Codex sign-in on this computer (and
//! their keychain) is never read or changed. Codex's browser sign-in comes
//! first; if it can't start its local sign-in server, the device-code sign-in
//! runs instead. Once Codex says it is signed in, its `auth.json` is read,
//! checked to be a ChatGPT sign-in, and the directory is removed.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};

use super::{text, Fail, Flow, Got, Phase};

/// What the member may need to do in ChatGPT before a device-code sign-in works.
const DEVICE_HINT: &str =
    "If ChatGPT says device codes are off, turn on device code sign-in for Codex in ChatGPT Settings → Security, then try again.";

/// The config override that keeps the sign-in in `$CODEX_HOME/auth.json`.
const FILE_STORE: &str = r#"cli_auth_credentials_store="file""#;

const SCREEN_CAP: usize = 64 * 1024;

pub(crate) async fn run(flow: &Flow, bin: &Path) -> Result<Got, Fail> {
    let home = tempfile::Builder::new()
        .prefix("aura-codex-signin-")
        .tempdir()
        .map_err(|e| Fail::Message(format!("Couldn't make a place for Codex to sign in: {e}")))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| Fail::Message(format!("Couldn't make a place for Codex to sign in: {e}")))?;
    }
    match login(flow, bin, home.path(), false).await {
        Err(Fail::PortBusy) => {
            flow.set(|s| s.url = None);
            login(flow, bin, home.path(), true).await.map_err(|e| match e {
                Fail::Message(m) => Fail::Message(format!("{m} {DEVICE_HINT}")),
                other => other,
            })?;
        }
        other => other?,
    }
    let raw = std::fs::read_to_string(home.path().join("auth.json"))
        .map_err(|_| Fail::Message("Codex finished without saving a sign-in. Try again.".into()))?;
    let checked = chatgpt_auth(&raw);
    drop(raw);
    let _ = home.close();
    let (value, account) = checked?;
    Ok(Got { name: "codex_chatgpt_auth", value, account })
}

async fn login(flow: &Flow, bin: &Path, home: &Path, device: bool) -> Result<(), Fail> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["-c", FILE_STORE, "login"]);
    if device {
        cmd.arg("--device-auth");
    }
    cmd.env("CODEX_HOME", home)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| Fail::Message(format!("Codex couldn't start its sign-in: {e}")))?;
    let mut out = BufReader::new(child.stdout.take().expect("piped")).lines();
    let mut err = BufReader::new(child.stderr.take().expect("piped")).lines();
    let (mut out_open, mut err_open) = (true, true);
    let mut screen = String::new();

    let take = |line: String, screen: &mut String| {
        screen.push_str(&text::strip_ansi(&line));
        screen.push('\n');
        if screen.len() > SCREEN_CAP {
            let cut = screen.len() - SCREEN_CAP;
            let cut = (cut..screen.len()).find(|i| screen.is_char_boundary(*i)).unwrap_or(screen.len());
            screen.drain(..cut);
        }
        let url = text::link_to(screen, text::OPENAI_HOSTS);
        if device {
            if let Some(code) = text::codex_device_code(screen) {
                flow.set(|s| {
                    s.phase = Phase::DeviceCode;
                    s.code = Some(code);
                    s.url = url;
                });
            }
        } else if url.is_some() {
            flow.set(|s| {
                s.phase = Phase::Browser;
                s.url = url;
            });
        }
    };

    let status = loop {
        tokio::select! {
            l = out.next_line(), if out_open => match l {
                Ok(Some(l)) => take(l, &mut screen),
                _ => out_open = false,
            },
            l = err.next_line(), if err_open => match l {
                Ok(Some(l)) => take(l, &mut screen),
                _ => err_open = false,
            },
            st = child.wait() => break st,
            _ = flow.cancelled() => {
                let _ = child.kill().await;
                return Err(Fail::Cancelled);
            }
        }
    };
    // Whatever it printed on its way out.
    let drain = Duration::from_millis(300);
    while out_open {
        match tokio::time::timeout(drain, out.next_line()).await {
            Ok(Ok(Some(l))) => take(l, &mut screen),
            _ => out_open = false,
        }
    }
    while err_open {
        match tokio::time::timeout(drain, err.next_line()).await {
            Ok(Ok(Some(l))) => take(l, &mut screen),
            _ => err_open = false,
        }
    }

    match status {
        Ok(st) if st.success() => Ok(()),
        _ if flow.is_cancelled() => Err(Fail::Cancelled),
        _ if !device && text::codex_port_busy(&screen) => Err(Fail::PortBusy),
        _ => Err(Fail::Message(stopped_early(&screen))),
    }
}

fn stopped_early(screen: &str) -> String {
    let said = screen
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("error") || l.contains("failed") || l.contains("denied") || l.contains("expired")
        })
        .map(|l| l.chars().take(160).collect::<String>());
    match said {
        Some(l) => format!("Codex stopped before it finished signing in: {l}."),
        None => "Codex stopped before it finished signing in.".into(),
    }
}

/// The saved form of a Codex `auth.json` — one line of the same JSON — and
/// the account it is for. Refused unless it carries ChatGPT's three tokens.
pub(crate) fn chatgpt_auth(raw: &str) -> Result<(String, Option<String>), Fail> {
    let not_it = || Fail::Message("Codex didn't sign in with a ChatGPT plan. Try again.".into());
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|_| not_it())?;
    if v.get("auth_mode").and_then(|m| m.as_str()).is_some_and(|m| m.eq_ignore_ascii_case("apikey")) {
        return Err(Fail::Message("Codex signed in with an API key, not a ChatGPT plan. Use an API key instead.".into()));
    }
    for t in ["id_token", "access_token", "refresh_token"] {
        let ok = v.pointer(&format!("/tokens/{t}")).and_then(|x| x.as_str()).is_some_and(|x| !x.trim().is_empty());
        if !ok {
            return Err(not_it());
        }
    }
    let account = account(&v);
    let compact = serde_json::to_string(&v).map_err(|_| not_it())?;
    Ok((compact, account))
}

/// `email · Plan` from the id token's claims. Display only; not verified.
fn account(v: &serde_json::Value) -> Option<String> {
    use base64::Engine as _;
    let jwt = v.pointer("/tokens/id_token")?.as_str()?;
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let email = claims.get("email")?.as_str()?.trim();
    if email.is_empty() || email.len() > 254 {
        return None;
    }
    let plan = claims
        .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty() && p.len() <= 32 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    Some(match plan {
        Some(p) => {
            let mut c = p.chars();
            let first: String = c.next().map(|f| f.to_ascii_uppercase()).into_iter().collect();
            format!("{email} · {first}{}", c.as_str())
        }
        None => email.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{drive, Agent};
    use super::*;
    use std::sync::Arc;

    /// What a fake Codex writes as its sign-in.
    fn auth_json(mode: &str) -> String {
        use base64::Engine as _;
        let b64 = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        let claims = r#"{"email":"member@example.test","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#;
        let id = format!("{}.{}.fake-sig", b64(r#"{"alg":"none"}"#), b64(claims));
        format!(
            "{{\n  \"auth_mode\": \"{mode}\",\n  \"OPENAI_API_KEY\": null,\n  \"tokens\": {{\n    \"id_token\": \"{id}\",\n    \"access_token\": \"fake-access\",\n    \"refresh_token\": \"fake-refresh\",\n    \"account_id\": \"acct-fake\"\n  }}\n}}\n"
        )
    }

    /// A fake `codex` that checks it was asked for a file-store login in a
    /// home of its own, records that home, and behaves as `browser` and
    /// `device` say.
    fn fake_codex(dir: &Path, browser: &str, device: &str) -> std::path::PathBuf {
        let seen = dir.join("codex-home-seen");
        fake_cli(
            dir,
            "codex",
            &format!(
                r#"[ "$1" = "-c" ] && [ "$2" = '{FILE_STORE}' ] && [ "$3" = "login" ] || {{ echo "bad args: $*" >&2; exit 3; }}
[ -n "$CODEX_HOME" ] && [ "$CODEX_HOME" != "$HOME/.codex" ] || {{ echo "no private home" >&2; exit 4; }}
[ -z "$OPENAI_API_KEY" ] || {{ echo "api key leaked in" >&2; exit 5; }}
echo "$CODEX_HOME" > '{seen}'
if [ "$4" = "--device-auth" ]; then
{device}
else
{browser}
fi"#,
                seen = seen.display()
            ),
        )
    }

    fn write_auth(json: &str) -> String {
        format!("cat > \"$CODEX_HOME/auth.json\" <<'EOF'\n{json}EOF")
    }

    fn seen_home(dir: &Path) -> std::path::PathBuf {
        std::path::PathBuf::from(std::fs::read_to_string(dir.join("codex-home-seen")).unwrap().trim())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_browser_sign_in_is_saved_and_its_home_removed() {
        let dir = tempfile::tempdir().unwrap();
        let browser = format!(
            "echo 'Starting local login server on http://localhost:1455.'\necho 'If your browser did not open, navigate to this URL to authenticate:'\necho ''\necho 'https://auth.openai.com/oauth/authorize?client_id=fake&state=s'\nsleep 1\n{}\necho 'Successfully logged in'",
            write_auth(&auth_json("chatgpt"))
        );
        let bin = fake_codex(dir.path(), &browser, "exit 9");
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Codex, bin, saver));
        let s = wait_for(&flow, |s| s.phase == Phase::Browser).await;
        assert_eq!(s.url.as_deref(), Some("https://auth.openai.com/oauth/authorize?client_id=fake&state=s"));
        let s = wait_for(&flow, |s| s.phase == Phase::Connected).await;
        run.await.unwrap();
        assert_eq!(s.account.as_deref(), Some("member@example.test · Plus"));
        let saved = saved.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].0, "codex_chatgpt_auth");
        assert!(!saved[0].1.contains('\n'));
        let v: serde_json::Value = serde_json::from_str(&saved[0].1).unwrap();
        assert_eq!(v["tokens"]["refresh_token"], "fake-refresh");
        assert!(!seen_home(dir.path()).exists(), "the sign-in's Codex home is removed");
        assert!(!serde_json::to_string(&s).unwrap().contains("fake-refresh"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_busy_sign_in_port_falls_back_to_a_device_code() {
        let dir = tempfile::tempdir().unwrap();
        let device = format!(
            "printf 'Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-12EFG\\033[0m\\n'\nsleep 1\n{}\necho 'Successfully logged in'",
            write_auth(&auth_json("chatgpt"))
        );
        let bin = fake_codex(dir.path(), "echo 'Error: Port 127.0.0.1:1455 is already in use' >&2; exit 1", &device);
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Codex, bin, saver));
        let s = wait_for(&flow, |s| s.phase == Phase::DeviceCode).await;
        assert_eq!(s.code.as_deref(), Some("ABCD-12EFG"));
        assert_eq!(s.url.as_deref(), Some("https://auth.openai.com/codex/device"));
        wait_for(&flow, |s| s.phase == Phase::Connected).await;
        run.await.unwrap();
        assert_eq!(saved.lock().unwrap()[0].0, "codex_chatgpt_auth");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_api_key_sign_in_is_not_saved_as_a_chatgpt_plan() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), &format!("{}\necho 'Successfully logged in'", write_auth(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-fake"}
"#)), "exit 9");
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        drive(flow.clone(), Agent::Codex, bin, saver).await;
        let s = flow.status();
        assert_eq!(s.phase, Phase::Failed);
        assert!(s.error.unwrap().contains("API key"));
        assert!(saved.lock().unwrap().is_empty());
        assert!(!seen_home(dir.path()).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_device_sign_in_says_what_to_turn_on() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(
            dir.path(),
            "echo 'Failed to cancel previous login server' >&2; exit 1",
            "echo 'Error: device code request failed with status 403' >&2; exit 1",
        );
        let (saver, _) = recording_saver();
        let flow = Arc::new(Flow::default());
        drive(flow.clone(), Agent::Codex, bin, saver).await;
        let e = flow.status().error.unwrap();
        assert!(e.contains("status 403"), "{e}");
        assert!(e.contains("Settings → Security"), "{e}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_stops_codex_and_removes_its_home() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), "echo 'https://auth.openai.com/oauth/authorize?x=1'\nsleep 30", "exit 9");
        let (saver, saved) = recording_saver();
        let flow = Arc::new(Flow::default());
        let run = tokio::spawn(drive(flow.clone(), Agent::Codex, bin, saver));
        wait_for(&flow, |s| s.phase == Phase::Browser).await;
        flow.cancel();
        tokio::time::timeout(Duration::from_secs(5), run).await.expect("stopped").unwrap();
        assert_eq!(flow.status().phase, Phase::Cancelled);
        assert!(saved.lock().unwrap().is_empty());
        assert!(!seen_home(dir.path()).exists());
    }

    #[test]
    fn only_a_chatgpt_sign_in_with_its_tokens_is_kept() {
        let (v, account) = chatgpt_auth(&auth_json("chatgpt")).unwrap();
        assert!(!v.contains('\n'));
        assert_eq!(account.as_deref(), Some("member@example.test · Plus"));
        assert!(chatgpt_auth("{}").is_err());
        assert!(chatgpt_auth("not json").is_err());
        assert!(chatgpt_auth(r#"{"tokens":{"id_token":"a","access_token":"b"}}"#).is_err());
        let (_, none) = chatgpt_auth(r#"{"tokens":{"id_token":"a","access_token":"b","refresh_token":"c"}}"#).unwrap();
        assert_eq!(none, None);
    }
}
