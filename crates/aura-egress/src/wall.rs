//! The default-deny half: nothing leaves this process except to loopback.
//!
//! Two mechanisms, because there are two kinds of machine and neither of them
//! can hold the other's. What they have in common is the only thing that
//! matters: after either one is up, the work has exactly one way out — the
//! broker on loopback — and the broker holds the list.
//!
//! | | how | what it costs |
//! |---|---|---|
//! | macOS | `sandbox-exec`, a profile denying `network*` | nothing: no root, no daemon, no lasting change to the machine |
//! | Linux | `nftables`, dropping for one Unix group | root once, to add the group and the table |
//!
//! The macOS filter cannot express a host — `sandbox-exec` accepts `*` or
//! `localhost` in a network address and rejects anything else — which settled
//! the design for both: neither wall knows a hostname, both walls only know
//! "loopback or nothing", and the names live one layer up where they can be
//! compared against what the work actually asked for.
//!
//! ## UDP
//!
//! Both walls drop it wholesale, and that is aimed at one thing in particular.
//! HTTP/3 is QUIC is UDP on 443, and a client that speaks it goes *around* an
//! HTTP proxy without noticing — the allowlist would still be there, correct,
//! and consulted about nothing. So on Linux `udp dport 443` is dropped by a
//! rule of its own, ahead of the general one, so the counter reads plainly in
//! `nft list ruleset`; on macOS the profile permits TCP and never mentions UDP,
//! which denies it by construction. DNS goes with it, and is not missed: the
//! work resolves nothing itself, because everything it reaches it reaches by
//! name *through the broker*.

/// The shell that decides which of the two walls a machine can hold.
///
/// Prints `seatbelt`, `netfilter`, or nothing at all — and nothing at all is the
/// answer that matters, because it is the one that means an agent must not be
/// started here unconfined.
///
/// It is a snippet rather than a function because both callers need it as text
/// on a far-away machine: the guard script asks it about the machine it is
/// running on, and the app asks it over ssh *before* delivering a guard, so a
/// place that cannot hold the wall is found out while somebody is still looking
/// at the screen. Two spellings of this question would be two answers, and the
/// disagreement would surface as an agent that refused to start for reasons the
/// surface had just said would not happen.
pub const WHICH: &str = "if [ \"$(uname -s)\" = 'Darwin' ] && command -v sandbox-exec >/dev/null 2>&1; then \
     printf 'seatbelt'; \
     elif command -v nft >/dev/null 2>&1 && command -v sg >/dev/null 2>&1 && \
     { [ \"$(id -u)\" = '0' ] || sudo -n true 2>/dev/null; }; then printf 'netfilter'; fi";

/// The Unix group whose sockets Linux drops.
///
/// One group for every run on the machine rather than one per session: what the
/// group buys is "this process may not leave except by loopback", which is the
/// same sentence for every confined run. The *list* differs per run and is held
/// by that run's own broker, so nothing about the wall has to.
pub const GROUP: &str = "aura-egress";

/// The nftables table, named so a person reading `nft list ruleset` on their own
/// machine knows what put it there.
pub const TABLE: &str = "aura_egress";

/// The seatbelt profile that leaves one way out.
///
/// `(allow default)` first, because this is an *egress* wall and nothing else:
/// the work is supposed to read and write the repository it was pointed at, and
/// a profile that also took the filesystem away would be a different feature
/// wearing this one's clothes. Then `(deny network*)`, then the single hole.
/// Order is the whole thing — seatbelt takes the last rule that matches, so the
/// allow has to come after the deny.
pub fn seatbelt_profile() -> String {
    "(version 1)\n\
     ;; Aura: the agent phase of a run. Everything but the network is left\n\
     ;; alone; the network is default-deny with one way off this machine, and\n\
     ;; that way out is a proxy holding this project's allowlist.\n\
     (allow default)\n\
     (deny network*)\n\
     ;; Local IPC — the pty, the tmux server, the system resolver. None of it\n\
     ;; leaves the machine.\n\
     (allow network-outbound (remote unix-socket))\n\
     (allow network-bind (local ip \"localhost:*\"))\n\
     ;; Loopback, which is where the broker is — and also the dev server the\n\
     ;; work was told to run its own tests against. The same reach the Linux\n\
     ;; wall gives with `oif \"lo\" accept`, for the same reason: a run that\n\
     ;; cannot talk to its own machine is a run that cannot test anything.\n\
     ;; It is a TCP hole. UDP is never allowed at all, so QUIC — which would\n\
     ;; have gone around the proxy without noticing it — cannot start.\n\
     (allow network-outbound (remote tcp \"localhost:*\"))\n"
        .to_string()
}

/// The nftables ruleset that drops everything but loopback for one group.
///
/// `gid` is written into the rules as given, so the caller may pass a shell
/// variable — the group is created on the machine and its number is not
/// knowable from here.
///
/// The first two lines are the replace idiom: naming a table creates it if it is
/// absent, so the delete that follows always has something to delete and a
/// second run of the same script does not stack a second copy of the rules.
///
/// `policy accept` is deliberate and is the reason this is safe to install on a
/// machine somebody else owns: every rule is scoped to one group, so a run of
/// this cannot take the box off the network. The drop at the end is *the group's*
/// drop, not the chain's.
pub fn nft_ruleset(gid: &str) -> String {
    format!(
        "table inet {TABLE}\n\
         delete table inet {TABLE}\n\
         table inet {TABLE} {{\n\
         \x20 chain out {{\n\
         \x20   type filter hook output priority 0; policy accept;\n\
         \x20   meta skgid {gid} oif \"lo\" accept\n\
         \x20   meta skgid {gid} udp dport 443 log prefix \"aura-egress quic: \" drop\n\
         \x20   meta skgid {gid} meta l4proto udp log prefix \"aura-egress udp: \" drop\n\
         \x20   meta skgid {gid} log prefix \"aura-egress: \" drop\n\
         \x20 }}\n\
         }}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_denies_before_it_allows() {
        let profile = seatbelt_profile();
        let deny = profile.find("(deny network*)").expect("a denial");
        let allow = profile
            .find("(allow network-outbound (remote tcp \"localhost:*\"))")
            .expect("the one hole");
        // Seatbelt takes the last matching rule. The other order is a profile
        // that reads like this one and permits everything.
        assert!(deny < allow, "{profile}");
    }

    #[test]
    fn the_profile_has_no_way_off_the_machine_at_all() {
        let profile = seatbelt_profile();
        let outbound: Vec<&str> = profile
            .lines()
            .filter(|l| l.contains("allow network-outbound"))
            .collect();
        assert_eq!(outbound.len(), 2, "{profile}");
        // A unix socket does not leave the machine, and neither does loopback.
        // Those are the only two things permitted, so the broker — which is on
        // loopback — is the only route to anywhere else.
        assert!(outbound[0].contains("unix-socket"));
        assert!(outbound[1].contains("tcp \"localhost:*\""));
        assert!(
            !profile.contains("udp"),
            "udp was allowed somewhere: {profile}"
        );
    }

    #[test]
    fn the_loopback_hole_is_the_same_hole_the_other_wall_leaves() {
        // Both walls allow all of loopback rather than one port. Not laziness:
        // the work is told to run its own tests, and a dev server on 5173 is
        // loopback too. A macOS run that could not reach it and a Linux run
        // that could would be the same feature behaving two ways.
        let profile = seatbelt_profile();
        assert!(profile.contains("tcp \"localhost:*\""), "{profile}");
        assert!(nft_ruleset("7").contains("oif \"lo\" accept"));
    }

    #[test]
    fn the_profile_leaves_everything_that_is_not_the_network_alone() {
        // The work is *supposed* to edit the repository it was pointed at.
        let profile = seatbelt_profile();
        assert!(profile.contains("(allow default)"));
        assert!(!profile.contains("deny file"));
    }

    #[test]
    fn every_rule_is_scoped_to_the_group() {
        // The rule that forgot `meta skgid` is the rule that takes somebody's
        // box off the internet. There is no acceptable version of that.
        let rules = nft_ruleset("1042");
        for line in rules
            .lines()
            .map(str::trim)
            .filter(|l| l.ends_with("accept") || l.ends_with("drop"))
        {
            assert!(line.contains("meta skgid 1042"), "unscoped rule: {line}");
        }
        assert!(rules.contains("policy accept"), "{rules}");
    }

    #[test]
    fn quic_is_dropped_by_a_rule_of_its_own_before_the_general_one() {
        let rules = nft_ruleset("$AURA_EGRESS_GID");
        let quic = rules.find("udp dport 443").expect("a quic rule");
        let udp = rules.find("meta l4proto udp").expect("a udp rule");
        let all = rules.rfind("drop").expect("the last drop");
        // nftables takes the first rule that matches. QUIC first so its counter
        // reads on its own; all UDP next; everything else last.
        assert!(quic < udp && udp < all, "{rules}");
    }

    #[test]
    fn loopback_is_the_only_thing_the_group_may_reach() {
        let rules = nft_ruleset("7");
        let accepts: Vec<&str> = rules
            .lines()
            .map(str::trim)
            .filter(|l| l.ends_with("accept") && l.starts_with("meta"))
            .collect();
        assert_eq!(accepts, vec!["meta skgid 7 oif \"lo\" accept"], "{rules}");
    }

    #[test]
    fn a_second_run_replaces_the_table_rather_than_stacking_on_it() {
        let rules = nft_ruleset("7");
        let mut lines = rules.lines();
        assert_eq!(lines.next(), Some("table inet aura_egress"));
        assert_eq!(lines.next(), Some("delete table inet aura_egress"));
    }
}
