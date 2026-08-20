//! What the team shares on a place, and what never leaves the member it belongs
//! to.
//!
//! Two lists, and the split between them is the whole security argument of this
//! feature. [`SHARED`] is what a second member may start from: downloads,
//! toolchains, extracted crates, compiled binaries — things a package manager
//! fetched from a public place and would fetch again, byte for byte, for anybody
//! who asked. [`PRIVATE`] is what may not travel and, more sharply, what may not
//! be in the base *at all*: a key, a token, a sign-in, a name on a commit.
//!
//! ## Why sharing is an allow-list and refusing is a deny-list
//!
//! They fail in opposite directions, so they are written in opposite directions.
//! A tool that arrives and is missing from [`SHARED`] costs the second member a
//! download — slow, visible, harmless. A tool that arrives and is missing from a
//! *sharing* deny-list would put its credential in a directory every member of
//! the team copies from, and nobody would notice. So nothing is shared unless it
//! is named here, and [`PRIVATE`] is then the second fence: the base is checked
//! for every one of these before a single byte is branched, and a base that
//! holds one is refused rather than copied.
//!
//! ## Why some of the private ones live inside a shared one
//!
//! `~/.cargo` is the clearest case. Almost all of it is the crates.io cache —
//! the single biggest thing a second member would otherwise re-download — and
//! one file in it, `credentials.toml`, is a publish token. Excluding the whole
//! directory to protect one file would throw away the point; copying the whole
//! directory would hand the token over. So a nested private path is scrubbed
//! from the copy, and only from the copy: [`private_within`] is what the branch
//! script renders that from.
//!
//! ## The one list, asked from both directions
//!
//! Every row of [`super::super::place_toolchain::SCOPED`] — the tools a member
//! gets their own copy of — has to appear in exactly one of these two, and
//! `every_scoped_tool_is_classified` fails the build if a seventh arrives
//! unclassified. That is deliberate: adding a scoped tool is precisely the
//! moment somebody has to decide whether its directory is a cache the team may
//! share or a credential it may not, and a tool that silently defaulted either
//! way would be wrong half the time.

/// Something the team builds once and every member starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layer {
    /// Where it sits, relative to a home directory.
    pub under: &'static str,
    /// What a person calls the thing that put it there.
    pub tool: &'static str,
    /// What it holds — in the words of what a second member would otherwise
    /// have to fetch again, because that is the sentence a surface shows.
    pub holds: &'static str,
    /// Must this exist before the tool runs?
    ///
    /// Only true for the directories a tool falls back from when they are
    /// missing — npm's prefix is the reason this field exists, since a prefix
    /// pointing nowhere sends `npm install -g` back to `/usr/local`, which is
    /// the whole collision [`super::super::place_toolchain`] exists to stop.
    /// Made in the base for the same reason it is made in a member's home.
    pub make: bool,
}

/// Everything a member may branch from.
///
/// The order is the order a fresh box fills them in, which is also roughly the
/// order of how much a second member saves by not doing it again.
pub const SHARED: [Layer; 13] = [
    Layer {
        under: ".cargo",
        tool: "cargo",
        holds: "the crates it has already downloaded and the tools `cargo install` built",
        make: true,
    },
    Layer {
        under: ".rustup",
        tool: "rustup",
        holds: "the Rust toolchains it has already fetched",
        make: true,
    },
    Layer {
        under: ".npm",
        tool: "npm",
        holds: "npm's download cache",
        make: true,
    },
    Layer {
        under: ".npm-global",
        tool: "npm",
        holds: "the packages `npm install -g` put in this account",
        make: true,
    },
    Layer {
        under: ".local",
        tool: "pip",
        holds: "what pip, pnpm, go and gem installed for one account",
        make: true,
    },
    Layer {
        under: ".asdf",
        tool: "asdf",
        holds: "asdf's plugins and the versions it has built",
        make: false,
    },
    Layer {
        under: ".tool-versions",
        tool: "asdf",
        holds: "the versions asdf pins for the whole account",
        make: false,
    },
    Layer {
        under: ".proto",
        tool: "proto",
        holds: "proto's installed toolchains",
        make: false,
    },
    Layer {
        under: ".config/mise",
        tool: "mise",
        holds: "the versions mise pins for the whole account",
        make: false,
    },
    Layer {
        under: ".cache/mise",
        tool: "mise",
        holds: "the archives mise downloaded to build those versions from",
        make: false,
    },
    Layer {
        under: ".bun",
        tool: "bun",
        holds: "bun itself and what it installed globally",
        make: false,
    },
    Layer {
        under: ".gem",
        tool: "gem",
        holds: "the Ruby gems installed for this account",
        make: false,
    },
    Layer {
        under: "go",
        tool: "go",
        holds: "the Go module cache and the binaries `go install` built",
        make: false,
    },
];

/// Something that belongs to one person and must not be in a shared base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Secret {
    /// Where it would sit, relative to a home directory.
    pub under: &'static str,
    /// What it is, so a refusal names the thing rather than the path.
    pub holds: &'static str,
}

/// What may never be branched, and may never be in the base.
///
/// Two of these are not credentials and are here anyway. `.gitconfig` is a name
/// and an email: copied into a second member's home it puts the first member's
/// name on the second member's commits, which is the same bug as a shared token
/// wearing a friendlier face. And the agent CLIs keep a sign-in in a dotfile of
/// their own — `.claude.json` is an OAuth token in a member's home — so an
/// account that ever ran one is an account whose home cannot be shared.
///
/// The base never signs in to anything: nobody logs in as it, no key of anyone's
/// is installed for it, and the only thing that writes into it is the project's
/// own declared spec. So in practice this list is a check that stays green. It
/// exists for the day the spec's install step is `gh auth login`.
pub const PRIVATE: [Secret; 17] = [
    Secret {
        under: ".ssh",
        holds: "the keys that let somebody in as this account",
    },
    Secret {
        under: ".config/aura",
        holds: "a member's own runner token",
    },
    Secret {
        under: ".config/gh",
        holds: "the GitHub login a push would be made under",
    },
    Secret {
        under: ".config/gcloud",
        holds: "a Google Cloud sign-in",
    },
    Secret {
        under: ".kube",
        holds: "credentials for whichever clusters it names",
    },
    Secret {
        under: ".aws",
        holds: "a cloud account's access keys",
    },
    Secret {
        under: ".docker/config.json",
        holds: "a container registry login",
    },
    Secret {
        under: ".gitconfig",
        holds: "the name and email commits would be made under",
    },
    Secret {
        under: ".git-credentials",
        holds: "a git password stored in the clear",
    },
    Secret {
        under: ".netrc",
        holds: "logins for whichever hosts it names",
    },
    Secret {
        under: ".npmrc",
        holds: "an npm registry token",
    },
    Secret {
        under: ".pypirc",
        holds: "a Python package index token",
    },
    Secret {
        under: ".cargo/credentials.toml",
        holds: "a crates.io publish token",
    },
    Secret {
        under: ".cargo/credentials",
        holds: "a crates.io publish token",
    },
    Secret {
        under: ".claude.json",
        holds: "the Claude CLI's sign-in",
    },
    Secret {
        under: ".codex",
        holds: "the Codex CLI's sign-in",
    },
    Secret {
        under: ".gemini",
        holds: "the Gemini CLI's sign-in",
    },
];

/// The private paths that live inside one shared layer, and would therefore
/// come across with it unless they were taken back out.
///
/// Rendered into the branch script per layer rather than swept globally
/// afterwards, because a global sweep would delete the member's *own*
/// credentials out of a directory this call never touched.
pub fn private_within(layer: &Layer) -> Vec<Secret> {
    let prefix = format!("{}/", layer.under);
    PRIVATE
        .into_iter()
        .filter(|s| s.under.starts_with(&prefix))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::brain::place_toolchain::SCOPED;

    /// Where a path would end up for a home directory, so the assertions below
    /// can talk about whole paths rather than fragments.
    fn under(home: &str, rel: &str) -> String {
        format!("{}/{rel}", home.trim_end_matches('/'))
    }

    #[test]
    fn every_scoped_tool_is_classified() {
        // The decision this file exists to force. A tool that gets a member their
        // own copy is a tool whose directory is either a cache the team may share
        // or a credential it may not, and there is no third answer — so a seventh
        // row in `SCOPED` fails here until somebody says which.
        for s in SCOPED {
            let shared = SHARED.iter().any(|l| l.under == s.under);
            let private = PRIVATE.iter().any(|p| p.under == s.under);
            assert!(
                shared != private,
                "{} ({}) is {} — say whether the team may share it",
                s.var,
                s.under,
                if shared { "in both lists" } else { "in neither" }
            );
        }
    }

    #[test]
    fn the_github_login_is_the_one_scoped_tool_the_team_does_not_share() {
        // Named rather than left to the classification test, because it is the
        // one row whose answer is not obvious from what it costs: `.config/gh`
        // is small and would save nobody a download, and it holds the token a
        // push is made under. Sharing it would put every member's commits under
        // whoever authenticated first — the exact bug `place_git` exists to stop.
        assert!(PRIVATE.iter().any(|p| p.under == ".config/gh"));
        assert!(!SHARED.iter().any(|l| l.under == ".config/gh"));
    }

    #[test]
    fn nothing_is_shared_and_private_at_once() {
        for l in SHARED {
            assert!(
                !PRIVATE.iter().any(|p| p.under == l.under),
                "{} is on both lists",
                l.under
            );
        }
    }

    #[test]
    fn the_cargo_token_is_taken_back_out_of_the_cache_that_carries_it() {
        // The nesting that makes this feature worth having: `.cargo` is the
        // single biggest thing a second member would re-download, and one file
        // in it is a publish token. Dropping the directory to protect the file
        // throws the feature away; copying it whole hands the token over.
        let cargo = SHARED
            .into_iter()
            .find(|l| l.under == ".cargo")
            .expect(".cargo");
        let inside: Vec<&str> = private_within(&cargo).iter().map(|s| s.under).collect();
        assert!(inside.contains(&".cargo/credentials.toml"), "{inside:?}");
        assert!(inside.contains(&".cargo/credentials"), "{inside:?}");
    }

    #[test]
    fn a_layer_with_nothing_private_in_it_needs_no_scrubbing() {
        let rustup = SHARED
            .into_iter()
            .find(|l| l.under == ".rustup")
            .expect(".rustup");
        assert!(private_within(&rustup).is_empty());
    }

    #[test]
    fn every_path_is_one_word_under_a_home_and_cannot_climb_out_of_it() {
        // Each of these is spliced into a shell script that runs as root on
        // somebody's machine. A quote would end the quoting early, a space would
        // split one path into two, and `..` would be a directory nobody chose —
        // which for the private list means a scrub that deletes the wrong thing.
        for path in SHARED
            .iter()
            .map(|l| l.under)
            .chain(PRIVATE.iter().map(|p| p.under))
        {
            assert!(!path.is_empty(), "an empty path");
            assert!(!path.starts_with('/'), "{path} is not under a home");
            assert!(!path.contains(".."), "{path} climbs out of the home");
            assert!(
                path.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/')),
                "{path} has something a shell would act on in it"
            );
        }
    }

    #[test]
    fn two_members_branch_into_two_different_homes() {
        // The property W11 turns on, restated for the thing this file adds: the
        // base is one directory and what comes out of it lands in each member's
        // own home, so a warm start does not quietly re-merge the accounts that
        // `place_account` separated.
        for l in SHARED {
            assert_ne!(
                under("/home/mo", l.under),
                under("/home/ana", l.under),
                "{} would be one directory for both members",
                l.under
            );
        }
    }

    #[test]
    fn what_a_layer_holds_is_said_in_words_a_person_reads() {
        for l in SHARED {
            assert!(!l.holds.is_empty(), "{} says nothing about itself", l.under);
            for jargon in ["reflink", "hardlink", "inode", "chown", "$HOME"] {
                assert!(
                    !l.holds.contains(jargon),
                    "{} says {jargon:?} to a person",
                    l.under
                );
            }
        }
        for p in PRIVATE {
            assert!(!p.holds.is_empty(), "{} says nothing about itself", p.under);
        }
    }
}
