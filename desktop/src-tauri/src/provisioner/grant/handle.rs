//! Which account a lifecycle request is made in, written on the machine's row.
//!
//! A row's handle used to answer one question — *what* to name in a stop or a
//! start — because there was only ever one account to name it in: Aura's own.
//! A grant adds a second, and the two are not interchangeable. The same
//! `i-0abc…` means one machine in Aura's account and, quite possibly, a
//! different customer's machine in theirs; sending a stop to the wrong one is
//! not an error message, it is somebody else's box going down.
//!
//! So a handle that belongs to a granted account says so: `grant:<name>/i-0abc…`.
//! One string, because the machine book already has exactly one field for "the
//! handle Aura may name" and a second field beside it is how a row ends up
//! carrying a handle and an account that disagree. The `grant:` prefix is the
//! same shape `managed:` already uses in `key_path` for the same reason — a
//! reference that says which system is meant to resolve it.
//!
//! Nothing here reaches anything. Reading a handle is a question about a string
//! that a surface asks while drawing a row, so it must cost a `split` and not a
//! file read: whether the named grant is still *configured* is asked later, by
//! the one call that is about to spend it, and it is answered with a sentence.

/// What marks a handle as belonging to an account somebody granted Aura.
const PREFIX: &str = "grant:";

/// What separates the grant's name from the machine's own handle.
///
/// A slash, and the grant's name is refused if it contains one
/// ([`super::settings`]), so the split is unambiguous from the left. An
/// instance id may not contain one either, but that is the substrate's rule and
/// not ours to rely on — hence splitting once, at the first.
const SEPARATOR: char = '/';

/// The handle to write on a machine reachable through a grant.
pub fn qualify(grant: &str, instance: &str) -> String {
    format!("{PREFIX}{}{SEPARATOR}{}", grant.trim(), instance.trim())
}

/// The grant and the machine a qualified handle names, or `None` if it names no
/// grant at all — which is the ordinary shape for a machine Aura made in its
/// own account.
pub fn parse(handle: &str) -> Option<(&str, &str)> {
    let rest = handle.trim().strip_prefix(PREFIX)?;
    let (grant, instance) = rest.split_once(SEPARATOR)?;
    let (grant, instance) = (grant.trim(), instance.trim());
    // Half a handle is not a handle. `grant:/i-0abc` names no account and
    // `grant:acme/` names no machine, and either one sent onward would be a
    // request built around an empty string.
    if grant.is_empty() || instance.is_empty() {
        return None;
    }
    Some((grant, instance))
}

/// Does this handle name an account somebody granted Aura a role in?
///
/// The question every surface drawing a row asks, and the reason it is spelled
/// here rather than as a `starts_with` at each call site: `grant:` alone is not
/// a handle, and a surface that checked only the prefix would offer a Sleep
/// button for a row whose handle is half-written.
pub fn is_granted(handle: &str) -> bool {
    parse(handle).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_granted_handle_says_which_account_it_belongs_to() {
        // The whole reason the prefix exists. Without it the same instance id
        // would be sent to whichever account happened to be configured, and on
        // a laptop with both set up that is a stop against the wrong company's
        // machine.
        let written = qualify("acme-eu", "i-0123456789abcdef0");
        assert_eq!(written, "grant:acme-eu/i-0123456789abcdef0");
        assert_eq!(
            parse(&written),
            Some(("acme-eu", "i-0123456789abcdef0")),
            "a handle Aura wrote could not be read back"
        );
    }

    #[test]
    fn a_machine_aura_made_names_no_grant() {
        // The ordinary managed handle, unchanged and unqualified — which is what
        // keeps every row written before grants existed reading exactly as it
        // did.
        assert_eq!(parse("i-0123456789abcdef0"), None);
        assert!(!is_granted("i-0123456789abcdef0"));
    }

    #[test]
    fn half_a_handle_is_not_a_handle() {
        // Each of these would otherwise become a request built around an empty
        // string: an account with no name to look up, or a machine with no id
        // to stop.
        for broken in ["grant:", "grant:acme-eu", "grant:/i-0abc1234", "grant:acme-eu/", "grant:/"] {
            assert_eq!(parse(broken), None, "{broken:?} was read as a handle");
            assert!(!is_granted(broken), "{broken:?} was offered as sleepable");
        }
    }

    #[test]
    fn the_machines_own_handle_survives_the_trip_whole() {
        // The instance is split off at the FIRST separator, so anything the
        // substrate puts after one arrives intact rather than truncated. A
        // truncated id is the worst shape of failure here: it is still a
        // plausible-looking handle, and it names a different machine.
        assert_eq!(
            parse("grant:acme-eu/proj/i-0abc1234"),
            Some(("acme-eu", "proj/i-0abc1234"))
        );
    }

    #[test]
    fn a_typed_handle_is_trimmed_before_it_becomes_an_identity() {
        // Grants are written into a file by hand, and a trailing space would
        // produce a grant name that never matches the one configured — a place
        // that offers to sleep and then says the account was never set up.
        assert_eq!(
            parse("  grant: acme-eu / i-0123456789abcdef0  "),
            Some(("acme-eu", "i-0123456789abcdef0"))
        );
        assert_eq!(qualify("  acme-eu  ", "  i-0abc1234  "), "grant:acme-eu/i-0abc1234");
    }
}
