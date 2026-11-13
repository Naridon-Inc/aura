//! What gets sent: the method, the body, the headers — and what is never
//! printed back out.
//!
//! All of it is decided before the socket opens, so `--dry-run` shows the same
//! request that a real call makes rather than a description of one.

use std::io::Read;

/// A call, fully decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub url: String,
    /// Caller headers only. `Authorization` and `Accept` are added at send
    /// time from the resolved credential, so they cannot be half-set here.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// The method to use.
///
/// A body with no `-X` means POST, which is what every other HTTP client does
/// and what an agent writing `aura api /workspaces -d '{…}'` means. Spelling is
/// upper-cased so `-X post` works; an unknown word is refused rather than sent,
/// because a typo'd method is answered with a 405 whose text explains nothing.
pub fn method_for(explicit: Option<&str>, has_body: bool) -> Result<String, String> {
    const KNOWN: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    match explicit.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            let upper = m.to_ascii_uppercase();
            if KNOWN.contains(&upper.as_str()) {
                Ok(upper)
            } else {
                Err(format!(
                    "`{m}` is not an HTTP method — one of {}",
                    KNOWN.join(", ")
                ))
            }
        }
        None if has_body => Ok("POST".to_string()),
        None => Ok("GET".to_string()),
    }
}

/// Read the body the caller gave: inline JSON, `@path`, or `-` for stdin.
///
/// It is parsed before it is sent. The API speaks JSON, so a body that is not
/// JSON is a mistake this command can name — "unexpected character at line 3"
/// beats a 400 whose body is the server's own idea of what went wrong with a
/// request it could not read either.
pub fn body_from(
    arg: Option<&str>,
    read_file: &dyn Fn(&str) -> std::io::Result<String>,
    read_stdin: &dyn Fn() -> std::io::Result<String>,
) -> Result<Option<String>, String> {
    let Some(raw) = arg else {
        return Ok(None);
    };
    let text = if raw == "-" {
        read_stdin().map_err(|e| format!("could not read the body from stdin: {e}"))?
    } else if let Some(path) = raw.strip_prefix('@') {
        read_file(path).map_err(|e| format!("could not read {path}: {e}"))?
    } else {
        raw.to_string()
    };
    if text.trim().is_empty() {
        return Err("the body is empty — leave `-d` off to send no body at all".into());
    }
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("the body is not JSON: {e}"))?;
    Ok(Some(text))
}

/// Read the whole of stdin — the `-d -` case.
pub fn stdin_text() -> std::io::Result<String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

/// Parse `-H name: value` pairs.
///
/// `Authorization` is refused. Not because sending a different bearer is
/// illegitimate, but because one place in this CLI decides which credential
/// goes to which host (`cloud_endpoint`, via `resolve_auth`), and a header that
/// quietly beat it would be a second answer to that question — the kind that
/// ends with a production token on a staging host. The error names the lever
/// that does work.
pub fn headers_from(args: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(args.len());
    for raw in args {
        let (name, value) = raw
            .split_once(':')
            .ok_or_else(|| format!("`{raw}` is not a header — write it as `Name: value`"))?;
        let name = name.trim();
        if name.is_empty() {
            return Err(format!("`{raw}` has no header name"));
        }
        if name.eq_ignore_ascii_case("authorization") {
            return Err(
                "Aura sends the Authorization header itself — set AURA_API_KEY or AURA_CLOUD_TOKEN \
                 to send a different credential, so the token and the host it may reach stay \
                 decided in one place"
                    .into(),
            );
        }
        out.push((name.to_string(), value.trim().to_string()));
    }
    Ok(out)
}

/// Whether a header's *value* is withheld when the request is printed.
///
/// Matched on the name, so a credential the caller passed under some other
/// spelling is covered too. The test is deliberately broad: a header wrongly
/// withheld costs a line of `--help`; one wrongly printed ends up in a CI log
/// that outlives the key.
pub fn is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["auth", "token", "key", "secret", "cookie", "password"]
        .iter()
        .any(|needle| n.contains(needle))
}

/// A header as it is shown to a person: the name, and the value only when the
/// name says it is safe to show.
pub fn shown(name: &str, value: &str) -> String {
    if is_secret(name) {
        format!("{name}: <withheld>")
    } else {
        format!("{name}: {value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_file(_: &str) -> std::io::Result<String> {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such file",
        ))
    }
    fn no_stdin() -> std::io::Result<String> {
        Ok(String::new())
    }

    #[test]
    fn a_body_with_no_method_is_a_post() {
        assert_eq!(method_for(None, true).unwrap(), "POST");
        assert_eq!(method_for(None, false).unwrap(), "GET");
    }

    #[test]
    fn a_method_is_accepted_in_any_case() {
        assert_eq!(method_for(Some("delete"), false).unwrap(), "DELETE");
    }

    #[test]
    fn an_unknown_method_is_refused_before_the_server_sees_it() {
        let err = method_for(Some("GTE"), false).unwrap_err();
        assert!(err.contains("not an HTTP method"), "{err}");
    }

    #[test]
    fn an_inline_body_must_be_json() {
        let err = body_from(Some("{nope}"), &no_file, &no_stdin).unwrap_err();
        assert!(err.contains("not JSON"), "{err}");
        assert_eq!(
            body_from(Some("{\"a\":1}"), &no_file, &no_stdin).unwrap(),
            Some("{\"a\":1}".to_string())
        );
    }

    #[test]
    fn a_body_from_a_file_that_is_not_there_names_the_path() {
        let err = body_from(Some("@/tmp/none.json"), &no_file, &no_stdin).unwrap_err();
        assert!(err.contains("/tmp/none.json"), "{err}");
    }

    #[test]
    fn a_body_from_a_file_is_read_and_checked() {
        let read = |p: &str| Ok(format!("{{\"path\":\"{p}\"}}"));
        let got = body_from(Some("@body.json"), &read, &no_stdin).unwrap();
        assert_eq!(got, Some("{\"path\":\"body.json\"}".to_string()));
    }

    #[test]
    fn a_body_from_stdin_is_read_whole() {
        let stdin = || Ok("[1, 2]".to_string());
        assert_eq!(
            body_from(Some("-"), &no_file, &stdin).unwrap(),
            Some("[1, 2]".to_string())
        );
    }

    #[test]
    fn an_empty_body_is_a_mistake_rather_than_an_empty_post() {
        let err = body_from(Some("  "), &no_file, &no_stdin).unwrap_err();
        assert!(err.contains("leave `-d` off"), "{err}");
    }

    #[test]
    fn no_body_at_all_is_not_an_error() {
        assert_eq!(body_from(None, &no_file, &no_stdin).unwrap(), None);
    }

    #[test]
    fn headers_are_split_on_the_first_colon() {
        let got = headers_from(&["X-Trace: a:b:c".to_string()]).unwrap();
        assert_eq!(got, vec![("X-Trace".to_string(), "a:b:c".to_string())]);
    }

    #[test]
    fn a_header_without_a_colon_is_a_usage_error() {
        assert!(headers_from(&["X-Trace a".to_string()]).is_err());
        assert!(headers_from(&[": v".to_string()]).is_err());
    }

    #[test]
    fn the_authorization_header_is_refused_and_points_at_the_lever_that_works() {
        let err = headers_from(&["authorization: Bearer x".to_string()]).unwrap_err();
        assert!(err.contains("AURA_API_KEY"), "{err}");
    }

    #[test]
    fn a_credential_shaped_header_is_not_printed_back() {
        assert_eq!(shown("X-Api-Key", "abc"), "X-Api-Key: <withheld>");
        assert_eq!(shown("Cookie", "s=1"), "Cookie: <withheld>");
        assert_eq!(shown("X-Trace", "abc"), "X-Trace: abc");
    }
}
