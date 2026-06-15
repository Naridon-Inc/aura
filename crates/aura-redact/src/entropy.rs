//! The Shannon-entropy pass: catch random-looking secrets that carry no known
//! prefix (raw API keys, base64 payloads, hex blobs) and so slip past the
//! pattern pass.
//!
//! The hard part isn't the entropy maths — it's *not* eating the high-entropy
//! strings that legitimately live in source: git SHAs, UUIDs, content hashes,
//! long camelCase identifiers, minified blobs. The pass leans on three guards,
//! all configurable via [`crate::RedactionConfig`]:
//!
//! 1. **Length floor** (`entropy_min_len`) — short tokens are never secrets
//!    worth the false-positive risk.
//! 2. **Entropy threshold** (`entropy_threshold`, bits/char) — a 40-char hex
//!    SHA sits near 4.0; the conservative 4.5 default clears it. base64/random
//!    keys run 4.5–6.0.
//! 3. **Mixed-character guard** (`entropy_require_mixed`) — a real generated
//!    secret almost always mixes letter case with digits (or base64 symbols).
//!    Requiring that mix spares all-lowercase hex hashes and prose words while
//!    still catching `aB3xK9...`. The strict profile drops this guard.

use std::collections::HashMap;

use crate::config::RedactionConfig;

/// Delimiters we split on to find candidate tokens. We replace each with a
/// space, then split on whitespace — so `key="aB3..xZ",` yields the bare token.
/// Kept deliberately wide (code punctuation + quotes) so a secret wedged in a
/// JSON/TOML/env line is isolated rather than analysed as part of a long line.
const DELIMITERS: &[char] = &[
    ' ', '\t', '\n', '\r', '(', ')', '{', '}', '[', ']', '<', '>', ',', ';', ':', '=', '"', '\'',
    '`', '|', '\\', '+', '*', '!', '?', '#', '@', '&', '^', '~',
];

/// Run the entropy pass over `text`, replacing each token that looks like a
/// high-entropy secret with `placeholder`. Returns the scrubbed text and the
/// number of distinct tokens redacted (for the [`crate::RedactionReport`]).
///
/// Skips the work entirely when [`RedactionConfig::entropy`] is off.
pub fn scrub(text: &str, cfg: &RedactionConfig, placeholder: &str) -> (String, usize) {
    if !cfg.entropy {
        return (text.to_string(), 0);
    }

    // Tokenise a delimiter-normalised copy, then redact the originals out of the
    // real text so surrounding punctuation is preserved.
    let mut tokenizable = text.to_string();
    for &d in DELIMITERS {
        tokenizable = tokenizable.replace(d, " ");
    }

    let mut result = text.to_string();
    let mut redacted = 0usize;
    let mut seen: HashMap<&str, ()> = HashMap::new();

    for token in tokenizable.split_whitespace() {
        if seen.contains_key(token) {
            continue;
        }
        if !is_secret(token, cfg) {
            continue;
        }
        seen.insert(token, ());
        // `replace` rewrites every occurrence; dedup above keeps the count of
        // *distinct* secrets, which is what the report wants to show.
        result = result.replace(token, placeholder);
        redacted += 1;
    }

    (result, redacted)
}

/// Decide whether one token is a high-entropy secret under `cfg`'s thresholds
/// and guards. Public within the crate so the facade can expose a single-token
/// check and tests can target the decision directly.
pub fn is_secret(token: &str, cfg: &RedactionConfig) -> bool {
    if token.chars().count() < cfg.entropy_min_len {
        return false;
    }
    // A secret is one opaque run of token characters. Anything with internal
    // structure (a dotted version, a path segment) was already split by the
    // delimiter pass; a token that still holds a '.' or '/' is almost certainly
    // a hostname or version, not a key.
    if !token.chars().all(is_token_char) {
        return false;
    }
    if cfg.entropy_require_mixed && !is_mixed(token) {
        return false;
    }
    shannon_entropy(token) >= cfg.entropy_threshold
}

/// The character class a contiguous secret is made of: base64 / base64url /
/// hex alphabets — letters, digits, and the `_` `-` symbols that key formats
/// use. A `.` or `/` deliberately is NOT a token char (see [`is_secret`]).
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Whether a token mixes character classes the way a generated secret does:
/// at least one letter AND (a digit OR a base64 symbol). All-hex lowercase
/// hashes, all-lower prose, and all-digit ids therefore don't qualify under the
/// guard — exactly the false positives we want to spare.
fn is_mixed(token: &str) -> bool {
    let mut has_lower = false;
    let mut has_upper = false;
    let mut has_digit = false;
    let mut has_sym = false;
    for c in token.chars() {
        if c.is_ascii_lowercase() {
            has_lower = true;
        } else if c.is_ascii_uppercase() {
            has_upper = true;
        } else if c.is_ascii_digit() {
            has_digit = true;
        } else if c == '_' || c == '-' {
            has_sym = true;
        }
    }
    let has_letter = has_lower || has_upper;
    // Letter + (digit or symbol), or both cases present (camel/Pascal secrets
    // with no digit, e.g. base64 of binary). Pure single-class runs fail.
    (has_letter && (has_digit || has_sym)) || (has_lower && has_upper)
}

/// Shannon entropy of `s` in bits per character: `H = -Σ p_i·log2(p_i)`.
/// Higher means less predictable — random keys approach `log2(alphabet)`.
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut freq: HashMap<char, usize> = HashMap::new();
    for c in s.chars() {
        *freq.entry(c).or_insert(0) += 1;
    }
    let len = s.chars().count() as f64;
    let mut entropy = 0.0;
    for &count in freq.values() {
        let p = count as f64 / len;
        entropy -= p * p.log2();
    }
    entropy
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RedactionConfig;

    #[test]
    fn redacts_random_mixed_key() {
        let cfg = RedactionConfig::default();
        let (out, n) = scrub("key = aB3xK9pLmQ7rT2vW8zY4nC6dF1gH5jK", &cfg, "[SECRET]");
        assert!(out.contains("[SECRET]"), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn preserves_git_sha_under_default() {
        // 40-char lowercase hex SHA: high-ish entropy but all-lower, no mix.
        let cfg = RedactionConfig::default();
        let sha = "e56a4797c73fce4639ed4957b074a18a07b3922c";
        let (out, n) = scrub(&format!("commit {sha}"), &cfg, "[SECRET]");
        assert!(out.contains(sha), "SHA should survive default profile: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn preserves_short_tokens() {
        let cfg = RedactionConfig::default();
        let (out, n) = scrub("id = aB3xK9", &cfg, "[SECRET]");
        assert_eq!(n, 0);
        assert!(out.contains("aB3xK9"));
    }

    #[test]
    fn preserves_camelcase_identifier() {
        // Long identifier, mixed case, but low entropy (English morphemes).
        let cfg = RedactionConfig::default();
        let ident = "getUserAuthenticationTokenFromRequestHeaders";
        let (out, n) = scrub(&format!("call {ident}()"), &cfg, "[SECRET]");
        assert!(out.contains(ident), "identifier should survive: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn strict_profile_catches_all_lower_hex_blob() {
        // Strict drops the mixed guard + lowers the bar, so a realistic
        // random-looking hex blob (~3.97 bits/char) is caught. Default would
        // spare it (all-lowercase fails the mixed guard).
        let cfg = RedactionConfig::strict();
        let blob = "9f3c1a7e0b6d4582ace7193f5d8b2c40e1a9f76b";
        let (out, n) = scrub(&format!("hash {blob}"), &cfg, "[SECRET]");
        assert!(out.contains("[SECRET]"), "strict should catch: {out}");
        assert_eq!(n, 1);

        // And the conservative default leaves the same all-lower hex alone.
        let (out_def, n_def) = scrub(&format!("hash {blob}"), &RedactionConfig::default(), "[SECRET]");
        assert!(out_def.contains(blob), "default should spare hex: {out_def}");
        assert_eq!(n_def, 0);
    }

    #[test]
    fn entropy_off_is_noop() {
        let mut cfg = RedactionConfig::default();
        cfg.entropy = false;
        let s = "key = aB3xK9pLmQ7rT2vW8zY4nC6dF1gH5jK";
        let (out, n) = scrub(s, &cfg, "[SECRET]");
        assert_eq!(out, s);
        assert_eq!(n, 0);
    }
}
