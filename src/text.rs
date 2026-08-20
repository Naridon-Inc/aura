//! Clipping text without panicking on the text people actually type.
//!
//! The pattern this replaces was everywhere: `if s.len() > 200 { &s[..200] }`.
//! It reads as "keep the first 200", and for English it is. `len()` is bytes,
//! though, and slicing a `str` at an index that lands inside a character is a
//! panic — not an error, not a truncated string, a panic. So any label built
//! that way is a crash waiting for the first person who writes in Japanese,
//! Arabic or Hindi, or who puts an emoji at the wrong offset.
//!
//! It is also wrong the other way: the same expression on a value shorter than
//! the cap (`&id[..8]` on a seven-character id) panics on the length.
//!
//! `clip` does what the byte-slice was meant to do — at most `max_bytes`,
//! ending on a character boundary, and whatever is there if that is less.

/// The leading part of `s` that fits in `max_bytes` without splitting a
/// character. Returns the whole string when it already fits, so callers keep
/// their own "did I cut anything" test and their own ellipsis.
pub fn clip(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn keeps_a_string_that_already_fits() {
        assert_eq!(clip("hello", 200), "hello");
        // The length case: `&id[..8]` on a short id used to panic here.
        assert_eq!(clip("abc", 8), "abc");
        assert_eq!(clip("", 8), "");
    }

    #[test]
    fn cuts_ascii_exactly_where_the_byte_slice_did() {
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("abcdef", 0), "");
    }

    #[test]
    fn does_not_split_a_multibyte_character() {
        // Three bytes each: cutting at 4 lands inside the second one, which is
        // exactly the panic this exists to remove.
        let s = "日本語";
        assert_eq!(clip(s, 4), "日");
        assert_eq!(clip(s, 6), "日本");
        assert_eq!(clip(s, 8), "日本");
        assert_eq!(clip(s, 9), "日本語");
    }

    #[test]
    fn does_not_split_an_emoji() {
        let s = "ok 🚀 go";
        assert!(clip(s, 5).is_char_boundary(clip(s, 5).len()));
        assert_eq!(clip(s, 5), "ok ");
    }

    #[test]
    fn is_always_a_prefix_that_fits() {
        for s in ["", "a", "日本語", "ok 🚀 go", "mixed ünïcode"] {
            for n in 0..20 {
                let out = clip(s, n);
                assert!(s.starts_with(out), "{out:?} is not a prefix of {s:?}");
                if s.len() > n {
                    assert!(out.len() <= n, "clip({s:?}, {n}) returned {out:?}");
                }
            }
        }
    }
}
