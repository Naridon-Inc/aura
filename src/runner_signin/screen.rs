//! Reading what `claude setup-token` and `codex login --device-auth` print,
//! as a person would see it in a terminal.
//!
//! The same reading the desktop app does for a sign-in on a member's own
//! laptop (`aura-shell`'s `cmd_cloud_agent_signin::text`), here for one run
//! on a computer. Nothing here logs or returns more than the one thing asked
//! for.

use std::sync::OnceLock;

use regex::Regex;

/// Terminal output with its escape sequences taken out. Cursor moves that put
/// text somewhere else become a space or a line break, so words a TUI laid
/// out with them stay apart.
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
                            out.extend(std::iter::repeat_n(' ', n.clamp(1, 200)));
                        }
                        Some('A' | 'B' | 'E' | 'F' | 'H' | 'f' | 'J') => out.push('\n'),
                        _ => {}
                    }
                }
                Some(']') => {
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

pub const CLAUDE_HOSTS: &[&str] = &["claude.ai", "claude.com", "anthropic.com"];
pub const OPENAI_HOSTS: &[&str] = &["openai.com", "chatgpt.com"];

/// The first `https` link on screen whose host is one of `hosts` (or a
/// subdomain of one). Anything else the CLI printed is never passed on.
pub fn link_to(screen: &str, hosts: &[&str]) -> Option<String> {
    url_re().find_iter(screen).map(|m| m.as_str().trim_end_matches(['.', ',', ')'])).find_map(|u| {
        let parsed = reqwest::Url::parse(u).ok()?;
        let host = parsed.host_str()?.to_ascii_lowercase();
        let ok = parsed.scheme() == "https" && hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
        ok.then(|| u.to_string())
    })
}

/// Whether `claude setup-token` is asking for the code its sign-in page
/// shows. On a computer the member's browser can never hand the sign-in back
/// by itself, so any code box is one the member has to fill.
pub fn claude_asks_for_code(screen: &str) -> bool {
    let s = screen.to_ascii_lowercase();
    s.contains("paste code here") || s.contains("can't return the sign-in") || s.contains("cannot return the sign-in")
}

/// What Claude Code said when it turned down the code it was handed — read
/// only from what it printed after the code went in.
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

/// The agent's own last word on why it stopped, when it gave one: a short
/// line that carries no link and no token.
pub fn stopped_because(screen: &str) -> Option<String> {
    const SAID: [&str; 4] = ["error", "failed", "denied", "expired"];
    screen
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| {
            let l = l.to_ascii_lowercase();
            !l.contains("sk-ant") && !l.contains("http") && SAID.iter().any(|s| l.contains(s))
        })
        .map(|l| l.chars().take(160).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_token() -> String {
        format!("{CLAUDE_TOKEN_PREFIX}{}-FAKEfake0", "F4ke_".repeat(19))
    }

    #[test]
    fn colours_and_cursor_moves_come_out_and_words_stay_apart() {
        assert_eq!(strip_ansi("\x1b[1mPaste\x1b[0m\x1b[1Ccode\r\nhere"), "Paste code\nhere");
        assert_eq!(strip_ansi("a\x1b]0;title\x07b"), "ab");
    }

    #[test]
    fn the_token_is_found_whole_even_across_a_line_break() {
        let t = fake_token();
        assert_eq!(claude_token(&format!("Your OAuth token:\n\n{t}\n\nStore this token securely.")), Some(t.clone()));
        let (a, b) = t.split_at(40);
        assert_eq!(claude_token(&format!("{a}\n{b}\nStore")), Some(t));
        assert_eq!(claude_token("sk-ant-oat01-short\nword here"), None);
    }

    #[test]
    fn only_a_link_to_the_agent_s_own_site_is_passed_on() {
        let screen = "go to https://evil.example/claude.ai then https://claude.ai/oauth/authorize?code=true&state=st.";
        assert_eq!(link_to(screen, CLAUDE_HOSTS).as_deref(), Some("https://claude.ai/oauth/authorize?code=true&state=st"));
        assert_eq!(link_to("http://claude.ai/x", CLAUDE_HOSTS), None);
        assert_eq!(link_to("https://auth.openai.com/codex/device", OPENAI_HOSTS).as_deref(), Some("https://auth.openai.com/codex/device"));
    }

    #[test]
    fn a_code_box_is_seen_and_a_refusal_is_read_in_claude_code_s_words() {
        assert!(claude_asks_for_code("Paste code here if prompted >"));
        assert!(claude_asks_for_code("Paste code here >"));
        assert!(!claude_asks_for_code("Opening browser"));
        assert_eq!(claude_code_refused("\nInvalid code. Try again.\n").as_deref(), Some("Invalid code. Try again"));
        assert_eq!(claude_code_refused("https://claude.ai/error"), None);
    }

    #[test]
    fn the_device_code_is_read_from_codex_s_steps() {
        let screen = "1. Open https://auth.openai.com/codex/device\n2. Enter this one-time code\n\n   ABCD-1234\n";
        assert_eq!(codex_device_code(screen).as_deref(), Some("ABCD-1234"));
        assert_eq!(codex_device_code("ABCD-1234"), None, "only after Codex says so");
    }

    #[test]
    fn why_it_stopped_never_carries_a_link_or_a_token() {
        assert_eq!(stopped_because("ok\nError: device code expired\n").as_deref(), Some("Error: device code expired"));
        assert_eq!(stopped_because("error at https://auth.openai.com/x"), None);
        assert_eq!(stopped_because("all good"), None);
    }
}
