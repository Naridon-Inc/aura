//! A pair code as people type it: `AURA-K7QM-3XPT`, in any case, with or
//! without the dashes.
//!
//! The rules mirror the cloud's own parser (`aura-cloud/src/places/pair/code.rs`)
//! letter for letter, so `aura join` can tell a pair code from the older
//! mothership join token before anything is sent anywhere — and so a typo is
//! caught here, where it costs nothing, rather than spending one of the code's
//! five wrong tries.

/// The readable letters: no 0/O, 1/I/L.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUP: usize = 4;
const PREFIX: &str = "AURA";

/// A code that has the right shape. Whether it is a *live* code only the cloud
/// can say.
#[derive(Clone, PartialEq, Eq)]
pub struct PairCode {
    lookup: String,
    secret: String,
}

impl PairCode {
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.len() > 64 {
            return None;
        }
        let mut letters: String = raw
            .trim()
            .chars()
            .filter(|c| !matches!(c, '-' | ' ' | '\t' | '_'))
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if letters.len() == PREFIX.len() + 2 * GROUP && letters.starts_with(PREFIX) {
            letters.drain(..PREFIX.len());
        }
        if letters.len() != 2 * GROUP || !letters.bytes().all(|b| ALPHABET.contains(&b)) {
            return None;
        }
        // The cloud never hands out a code whose first half is `AURA`, so this
        // is the prefix and half a code.
        if letters.starts_with(PREFIX) {
            return None;
        }
        let (lookup, secret) = letters.split_at(GROUP);
        Some(PairCode { lookup: lookup.to_string(), secret: secret.to_string() })
    }

    /// The code as the cloud expects it.
    pub fn display(&self) -> String {
        format!("{PREFIX}-{}-{}", self.lookup, self.secret)
    }

    /// The public half. Names this machine's pending claim on disk; the secret
    /// half is never written anywhere.
    pub fn lookup(&self) -> &str {
        &self.lookup
    }
}

// The secret half never reaches a log line or a panic message.
impl std::fmt::Debug for PairCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PairCode({PREFIX}-{}-****)", self.lookup)
    }
}

/// True when `raw` is a pair code, or was plainly meant as one — `AURA-…`
/// with a letter missing or one too many. Either way it goes to the pair
/// path, which explains a mangled code in its own words instead of calling it
/// an invalid mothership token. A mothership token is base64 JSON (`eyJ…`)
/// and never starts with `AURA`.
pub fn looks_like_code(raw: &str) -> bool {
    if PairCode::parse(raw).is_some() {
        return true;
    }
    let t = raw.trim();
    t.len() <= 24 && t.get(..PREFIX.len()).is_some_and(|p| p.eq_ignore_ascii_case(PREFIX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_read_however_it_is_typed() {
        for typed in ["AURA-K7QM-3XPT", "aura-k7qm-3xpt", "K7QM-3XPT", "k7qm3xpt", " AURA K7QM 3XPT "] {
            let c = PairCode::parse(typed).unwrap_or_else(|| panic!("{typed} should parse"));
            assert_eq!(c.display(), "AURA-K7QM-3XPT");
            assert_eq!(c.lookup(), "K7QM");
        }
    }

    #[test]
    fn what_is_not_a_code_is_refused_before_it_is_sent() {
        for typed in [
            "",
            "AURA",
            "AURA-K7QM",
            "AURA-AB2C",
            "K7QM-3XP",
            "K7QM-3XPTQ",
            "K0QM-3XPT",
            "KIQM-3XPT",
            "eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tIiwidXNlciI6InBlZXIifQ==",
        ] {
            assert!(PairCode::parse(typed).is_none(), "{typed:?} should not parse");
        }
    }

    #[test]
    fn a_mothership_token_still_goes_the_old_way() {
        assert!(!looks_like_code("eyJ1cmwiOiJ3c3M6Ly9ob3N0OjQ0MyJ9"));
        assert!(looks_like_code("AURA-K7QM-3XPT"));
        assert!(looks_like_code("K7QM-3XPT"));
    }

    #[test]
    fn a_mangled_code_is_still_treated_as_a_code_so_it_is_explained_as_one() {
        assert!(looks_like_code("aura-k7qm-3xp"));
        assert!(looks_like_code("AURA-K7QM-3XPTT"));
        assert!(PairCode::parse("aura-k7qm-3xp").is_none());
    }

    #[test]
    fn debug_output_hides_the_secret_half() {
        let c = PairCode::parse("AURA-K7QM-3XPT").unwrap();
        let shown = format!("{c:?}");
        assert!(shown.contains("K7QM"));
        assert!(!shown.contains("3XPT"));
    }
}
