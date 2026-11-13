//! Reading what `claude setup-token` and `codex login` print.
//!
//! Both are read as a screen, not a protocol: the text is what a person would
//! see in a terminal, with the colours and cursor moves taken out. Nothing here
//! logs or returns more than the one thing asked for.

use std::sync::OnceLock;

use regex::Regex;

/// Terminal output with its escape sequences taken out. Cursor moves that put
/// text somewhere else become a space or a line break, so words a TUI laid out
/// with them stay apart.
pub fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.next() {
                Some('[') => {
                    let mut params = String::new();
                    let mut fin = None;
                    for p in it.by_ref() {
                        if ('\x40'..='\x7e').contains(&p) {
                            fin = Some(p);
                            break;
                        }
                        params.push(p);
                    }
                    match fin {
                        Some('C') => {
                            let n: usize = params.trim_start_matches('?').parse().unwrap_or(1);
                            out.extend(std::iter::repeat(' ').take(n.clamp(1, 200)));
                        }
                        Some('A' | 'B' | 'E' | 'F' | 'H' | 'f' | 'J') => out.push('\n'),
                        _ => {}
                    }
                }
                Some(']') => {
                    // OSC: up to BEL or ST.
                    while let Some(p) = it.next() {
                        if p == '\x07' {
                            break;
                        }
                        if p == '\x1b' && it.peek() == Some(&'\\') {
                            it.next();
                            break;
                        }
                    }
                }
                Some('P' | 'X' | '^' | '_') => {
                    while let Some(p) = it.next() {
                        if p == '\x1b' && it.peek() == Some(&'\\') {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => {
                if it.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

const CLAUDE_TOKEN_PREFIX: &str = "sk-ant-oat01-";
/// Shorter than any real token `setup-token` prints, and longer than any
/// prefix of one cut off at a line end.
const CLAUDE_TOKEN_MIN: usize = 80;

fn token_chars(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The long-lived token `claude setup-token` prints once it has signed in. A
/// token cut by a line break is joined back, but only while it is still too
/// short to be whole, so a word on the next line is never glued on.
pub fn claude_token(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(at) = line.find(CLAUDE_TOKEN_PREFIX) else { continue };
        let rest = &line[at..];
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(rest.len());
        let mut token = rest[..end].to_string();
        let mut next = i + 1;
        while token.len() < CLAUDE_TOKEN_MIN && rest[end..].trim().is_empty() {
            match lines.get(next).map(|l| l.trim()) {
                Some(l) if token_chars(l) => token.push_str(l),
                _ => break,
            }
            next += 1;
        }
        if token.len() >= CLAUDE_TOKEN_MIN {
            return Some(token);
        }
    }
    None
}

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https://[^\s"'<>]+"#).expect("static regex"))
}

/// The first `https` link on screen whose host is one of `hosts` (or a
/// subdomain of one). Anything else the CLI printed is never offered to open.
pub fn link_to(screen: &str, hosts: &[&str]) -> Option<String> {
    url_re().find_iter(screen).map(|m| m.as_str().trim_end_matches(['.', ',', ')'])).find_map(|u| {
        let parsed = url::Url::parse(u).ok()?;
        let host = parsed.host_str()?.to_ascii_lowercase();
        let ok = parsed.scheme() == "https" && hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
        ok.then(|| u.to_string())
    })
}

pub const CLAUDE_HOSTS: &[&str] = &["claude.ai", "claude.com", "anthropic.com"];
pub const OPENAI_HOSTS: &[&str] = &["openai.com", "chatgpt.com"];

/// Whether `claude setup-token` is asking for the code the sign-in page shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodePrompt {
    /// The browser may hand the sign-in back by itself; a code is a fallback.
    Optional,
    /// The browser cannot hand it back; the member pastes the code.
    Required,
}

pub fn claude_code_prompt(screen: &str) -> Option<CodePrompt> {
    let s = screen.to_ascii_lowercase();
    if s.contains("can't return the sign-in") || s.contains("cannot return the sign-in") {
        return Some(CodePrompt::Required);
    }
    if s.contains("paste code here if prompted") {
        return Some(CodePrompt::Optional);
    }
    if s.contains("paste code here") {
        return Some(CodePrompt::Required);
    }
    None
}

/// What Claude Code said when it turned down the code it was handed — read
/// only from what it printed after the code went in. None while it has not
/// refused.
pub fn claude_code_refused(after_code: &str) -> Option<String> {
    const SAID: [&str; 5] = ["invalid code", "not from this sign-in", "try again", "failed", "error"];
    after_code
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| {
            let l = l.to_ascii_lowercase();
            !l.contains("sk-ant") && !l.contains("http") && SAID.iter().any(|s| l.contains(s))
        })
        .map(|l| l.trim_end_matches('.').chars().take(160).collect())
}

/// The one-time code `codex login --device-auth` asks the member to enter: the
/// first code-shaped line after it says so.
pub fn codex_device_code(screen: &str) -> Option<String> {
    let mut after = false;
    for line in screen.lines() {
        let t = line.trim();
        if t.to_ascii_lowercase().contains("one-time code") {
            after = true;
            continue;
        }
        if after && !t.is_empty() {
            let ok = (6..=24).contains(&t.len())
                && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
                && t.chars().any(|c| c.is_ascii_alphanumeric());
            if ok {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// `codex login` could not start its sign-in server on this computer, which
/// is when the device-code sign-in is the way in instead.
pub fn codex_port_busy(screen: &str) -> bool {
    let s = screen.to_ascii_lowercase();
    s.contains("already in use") || s.contains("failed to cancel previous login server") || s.contains("address in use")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_token() -> String {
        format!("{CLAUDE_TOKEN_PREFIX}{}-FAKEfake0", "F4ke_".repeat(19))
    }

    #[test]
    fn colours_and_cursor_moves_come_out_and_words_stay_apart() {
        let raw = "\x1b[1mUse\x1b[22m\x1b[1Cthe\x1b[3CURL\r\n\x1b]0;title\x07\x1b[2K\x1b[1Gnext\x1b[?25l";
        assert_eq!(strip_ansi(raw), "Use the   URL\nnext");
        assert_eq!(strip_ansi("a\rb"), "a\nb");
    }

    #[test]
    fn the_token_is_found_whole_and_nothing_else_is_taken() {
        let t = fake_token();
        let screen = format!(
            "Your OAuth token (valid for 1 year):\n\n{t}\n\nStore this token securely.\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\n"
        );
        assert_eq!(claude_token(&screen).as_deref(), Some(t.as_str()));
        assert_eq!(claude_token("export CLAUDE_CODE_OAUTH_TOKEN=<token>"), None);
        assert_eq!(claude_token("sk-ant-oat01-short"), None);
    }

    #[test]
    fn a_token_cut_by_a_line_break_is_joined_but_a_following_word_is_not() {
        let t = fake_token();
        let (a, b) = t.split_at(40);
        assert_eq!(claude_token(&format!("{a}\n{b}\nDone\n")).as_deref(), Some(t.as_str()));
        assert_eq!(claude_token(&format!("{t}\nDone\n")).as_deref(), Some(t.as_str()));
        assert_eq!(claude_token(&format!("{a}\nStore this token\n")), None);
    }

    #[test]
    fn only_a_link_to_the_sign_in_site_is_offered() {
        let screen = "Browser didn't open? Use the url below to sign in\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\n";
        assert_eq!(link_to(screen, CLAUDE_HOSTS).as_deref(), Some("https://claude.ai/oauth/authorize?code=true&client_id=x&state=y"));
        assert_eq!(link_to("go to https://claude.ai.evil.test/x", CLAUDE_HOSTS), None);
        assert_eq!(link_to("go to http://claude.ai/x", CLAUDE_HOSTS), None);
        assert_eq!(link_to("go to https://platform.claude.com/x.", CLAUDE_HOSTS).as_deref(), Some("https://platform.claude.com/x"));
        assert_eq!(link_to("visit https://auth.openai.com/codex/device", OPENAI_HOSTS).as_deref(), Some("https://auth.openai.com/codex/device"));
    }

    #[test]
    fn a_paste_prompt_is_told_apart_from_an_optional_one() {
        assert_eq!(claude_code_prompt("Paste code here if prompted > "), Some(CodePrompt::Optional));
        assert_eq!(
            claude_code_prompt("The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\nPaste code here > "),
            Some(CodePrompt::Required)
        );
        assert_eq!(claude_code_prompt("Paste code here > "), Some(CodePrompt::Required));
        assert_eq!(claude_code_prompt("Opening browser"), None);
    }

    #[test]
    fn the_device_code_is_read_from_codex_s_steps() {
        let screen = strip_ansi(
            "Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12EFG\x1b[0m\n\n\x1b[90mDevice codes are a common phishing target. Never share this code.\x1b[0m\n",
        );
        assert_eq!(codex_device_code(&screen).as_deref(), Some("ABCD-12EFG"));
        assert_eq!(link_to(&screen, OPENAI_HOSTS).as_deref(), Some("https://auth.openai.com/codex/device"));
        assert_eq!(codex_device_code("no code here"), None);
    }

    #[test]
    fn a_refused_code_is_read_in_claude_code_s_words() {
        let after = "\n  ****************\n\n  Invalid code. Please make sure the full code was copied\n  Press Enter to retry.\n";
        assert_eq!(
            claude_code_refused(after).as_deref(),
            Some("Invalid code. Please make sure the full code was copied")
        );
        assert_eq!(
            claude_code_refused("OAuth error: Failed to exchange authorization code for access token. Please try again.")
                .as_deref(),
            Some("OAuth error: Failed to exchange authorization code for access token. Please try again")
        );
        assert_eq!(claude_code_refused("  ****************\n  Paste code here if prompted > "), None);
        assert_eq!(claude_code_refused("error at https://claude.ai/oauth/authorize?x=1"), None, "a link is not a refusal");
        assert_eq!(claude_code_refused("failed sk-ant-oat01-abc"), None, "a token is never repeated");
    }

    #[test]
    fn a_busy_sign_in_port_is_recognised() {
        assert!(codex_port_busy("Error: Port 127.0.0.1:1455 is already in use"));
        assert!(codex_port_busy("Failed to cancel previous login server"));
        assert!(!codex_port_busy("Starting local login server on http://localhost:1455."));
    }
}
