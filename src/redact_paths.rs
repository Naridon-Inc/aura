//! Taking the host out of a payload that leaves the machine.
//!
//! A handover is a dense context block an agent emits so the next one can
//! resume, and pushing it to the cloud makes it team-visible. It is assembled
//! from real work, so it is full of real paths: the repo root, the files
//! touched, whatever a tool printed. On 2026-08-23 the Console's Handovers
//! panel was showing rows whose `repo` attribute read
//! `/private/var/folders/qn/…/T/.tmprfGGpe/` — a temp directory, complete
//! with the randomness that identifies one run on one machine. A real run
//! carries worse: `/Users/<name>/…` is a person's name, and an absolute path
//! is a map of someone's disk.
//!
//! The useful half of a path is the tail — which repo, which file. The
//! identifying half is the prefix. So this rewrites the prefix and keeps the
//! rest: `~` for a home directory, `<temp>` for a temporary one. Nobody
//! reading a handover needed to know which uid owns the checkout.
//!
//! Applied where the payload is *sent*, not where it is rendered — a
//! redaction that only runs in one client is not a redaction.

/// Rewrite absolute host paths in `text` so it can leave the machine.
///
/// Order matters: temp directories are matched before home, because on macOS
/// a temp directory is not under home but on Windows it is.
pub fn redact_local_paths(text: &str) -> String {
    redact_with_home(text, home_dir().as_deref())
}

/// The rewrite itself, with the home directory passed in rather than read
/// from the environment — so the tests can pin one without mutating the
/// process (which is `unsafe` since the 2024 edition, and would race any
/// other test reading `HOME`).
pub fn redact_with_home(text: &str, home: Option<&str>) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < text.len() {
        if !text.is_char_boundary(i) {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        if let Some((matched, replacement)) = match_prefix(rest, home) {
            out.push_str(replacement);
            i += matched;
            continue;
        }
        // Copy one whole character, never a byte, or a multi-byte char would
        // be split into invalid UTF-8.
        let ch_len = char_len(bytes[i]);
        out.push_str(&text[i..(i + ch_len).min(text.len())]);
        i += ch_len;
    }
    out
}

fn char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// The current user's home directory, if we can name it. Absent in a stripped
/// daemon environment, which is fine — the pattern rules below still catch
/// the shapes that matter.
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(|h| h.trim_end_matches(['/', '\\']).to_string())
        .filter(|h| h.len() > 1)
}

/// If `rest` starts with a host path we know how to anonymise, return how
/// many bytes to consume and what to write instead.
fn match_prefix(rest: &str, home: Option<&str>) -> Option<(usize, &'static str)> {
    // macOS per-user temp: /private/var/folders/<a>/<b>/T  or /var/folders/…
    for base in ["/private/var/folders/", "/var/folders/"] {
        if let Some(tail) = rest.strip_prefix(base) {
            // Consume up to and including the `/T` segment when it is there,
            // otherwise the two opaque segments that identify the user.
            let consumed = base.len() + temp_folder_span(tail);
            return Some((consumed, "<temp>"));
        }
    }
    // Windows temp lives *under* the profile, so the pair has to be matched
    // as one unit — see the home rules below. On its own it is still a temp
    // directory.
    for base in ["\\AppData\\Local\\Temp", "/AppData/Local/Temp"] {
        if rest.starts_with(base) {
            return Some((base.len(), "<temp>"));
        }
    }
    if rest.starts_with("/tmp/") || rest == "/tmp" {
        return Some(("/tmp".len(), "<temp>"));
    }
    if let Some(h) = home {
        if rest.starts_with(h) {
            let after = &rest[h.len()..];
            // Only a whole segment: /Users/mo must not swallow /Users/mona.
            if after.is_empty() || after.starts_with('/') || after.starts_with('\\') {
                // On Windows the temp directory is inside the profile, so
                // the pair is one match — otherwise this returns `~` and the
                // next pass appends `<temp>`, naming `~<temp>\\…`.
                for temp in ["\\AppData\\Local\\Temp", "/AppData/Local/Temp"] {
                    if after.starts_with(temp) {
                        return Some((h.len() + temp.len(), "<temp>"));
                    }
                }
                return Some((h.len(), "~"));
            }
        }
    }
    // Someone else's home, or ours in a process with no HOME set.
    for base in ["/Users/", "/home/", "C:\\Users\\", "C:/Users/"] {
        if let Some(tail) = rest.strip_prefix(base) {
            let name = tail
                .split(['/', '\\'])
                .next()
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let consumed = base.len() + name.len();
            let after = &rest[consumed..];
            // A Windows temp path is a profile path. Rewriting the profile
            // half first and the temp half second would leave `~<temp>\\…`,
            // naming a directory that never existed.
            for temp in ["\\AppData\\Local\\Temp", "/AppData/Local/Temp"] {
                if after.starts_with(temp) {
                    return Some((consumed + temp.len(), "<temp>"));
                }
            }
            return Some((consumed, "~"));
        }
    }
    None
}

/// How much of a `/var/folders/` tail belongs to the anonymous prefix:
/// `<a>/<b>/T` when the `T` is there, else the two opaque segments.
fn temp_folder_span(tail: &str) -> usize {
    let mut consumed = 0usize;
    for (n, seg) in tail.split('/').enumerate() {
        if n >= 3 {
            break;
        }
        // n == 2 is the per-purpose letter: T (temp) or C (cache).
        if n == 2 && seg.len() != 1 {
            break;
        }
        consumed += seg.len() + if n == 0 { 0 } else { 1 };
        if n == 2 {
            break;
        }
    }
    consumed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed home, so assertions don't depend on who is running the suite.
    const HOME: &str = "/Users/mo";

    fn redact(text: &str) -> String {
        redact_with_home(text, Some(HOME))
    }

    #[test]
    fn the_reported_temp_path_stops_naming_one_run_on_one_machine() {
        // Verbatim from the Console's Handovers panel, 2026-08-23.
        let got = redact(
            r#"<aura_semantic_context repo="/private/var/folders/qn/8xk_2p1n0dq/T/.tmprfGGpe/">"#,
        );
        assert_eq!(
            got,
            r#"<aura_semantic_context repo="<temp>/.tmprfGGpe/">"#,
            "the opaque per-user segments must go; the run's own folder may stay"
        );
    }

    #[test]
    fn a_home_path_keeps_the_repo_and_loses_the_person() {
                    assert_eq!(
                redact("/Users/mo/Documents/New Git/aura-cli/src/sync.rs"),
                "~/Documents/New Git/aura-cli/src/sync.rs"
            );
    }

    #[test]
    fn someone_elses_home_is_redacted_too() {
        // A teammate's path can arrive in a pasted log; HOME won't match it.
                    assert_eq!(
                redact("/Users/priya/work/app/main.rs"),
                "~/work/app/main.rs"
            );
            assert_eq!(redact("/home/ubuntu/repo/x"), "~/repo/x");
    }

    #[test]
    fn a_longer_username_is_not_swallowed_by_a_shorter_one() {
        // /Users/mo must not match the start of /Users/mona.
                    assert_eq!(
                redact("/Users/mona/repo/x"),
                "~/repo/x",
                "mona is redacted as a user, not as mo plus 'na'"
            );
    }

    #[test]
    fn windows_paths_are_covered() {
                    assert_eq!(
                redact(r"C:\Users\Ashiq\src\aura\main.rs"),
                r"~\src\aura\main.rs"
            );
            assert_eq!(
                redact(r"C:/Users/Ashiq/src/aura"),
                "~/src/aura"
            );
    }

    #[test]
    fn a_windows_temp_path_is_one_match_not_two() {
        // The temp directory is inside the profile. Rewriting the profile
        // half and then the temp half would leave `~<temp>\…` — a path that
        // never existed, and one a reader would have to decode.
        assert_eq!(
            redact(r"C:\Users\Ashiq\AppData\Local\Temp\aura-1\repo"),
            r"<temp>\aura-1\repo"
        );
        // Same when the profile happens to be the running user's own home.
        assert_eq!(
            redact_with_home(
                r"C:\Users\Ashiq\AppData\Local\Temp\aura-1",
                Some(r"C:\Users\Ashiq")
            ),
            r"<temp>\aura-1"
        );
    }

    #[test]
    fn unix_tmp_is_covered() {
                    assert_eq!(redact("/tmp/aura-test-9/repo"), "<temp>/aura-test-9/repo");
    }

    #[test]
    fn several_paths_in_one_payload_are_all_rewritten() {
                    let got = redact(
                "read /Users/mo/a.rs then wrote /tmp/b.rs and /home/ci/c.rs",
            );
            assert_eq!(got, "read ~/a.rs then wrote <temp>/b.rs and ~/c.rs");
    }

    #[test]
    fn a_relative_path_is_left_alone() {
        // The tail is the useful half; nothing here identifies a machine.
                    let s = "aura-cli/src/sync.rs and ./scripts/build.sh";
            assert_eq!(redact(s), s);
    }

    #[test]
    fn a_url_is_not_mangled() {
                    let s = "https://github.com/Naridon-Inc/aura/blob/main/src/lib.rs";
            assert_eq!(redact(s), s);
    }

    #[test]
    fn non_ascii_survives_the_rewrite() {
        // The scanner walks bytes; splitting a multi-byte char would produce
        // invalid UTF-8 and panic on the slice.
                    assert_eq!(
                redact("résumé → /Users/mo/naïve/файл.rs"),
                "résumé → ~/naïve/файл.rs"
            );
    }

    #[test]
    fn redacting_twice_changes_nothing_the_second_time() {
                    let once = redact("/Users/mo/x /tmp/y");
            assert_eq!(redact(&once), once);
    }

    #[test]
    fn an_empty_payload_is_fine() {
        assert_eq!(redact(""), "");
    }
}
