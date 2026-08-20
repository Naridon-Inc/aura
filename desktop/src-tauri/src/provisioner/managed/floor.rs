//! What a machine Aura made does the first time it comes up.
//!
//! A place is asked four things about itself — which agent CLIs it has, git,
//! tmux, and aura — and a box somebody built by hand answers all four because
//! `aura-runner/aws/bootstrap.sh` put them there. A box Aura made has to answer
//! the same four, identically, or the second place-mode is the first one with
//! things missing from it.
//!
//! ## One recipe, not two
//!
//! The steps are NOT written here. They are `aura-runner/aws/floor.sh`, the same
//! file bootstrap.sh runs, embedded verbatim by [`FLOOR`]. That is the whole
//! design of this module: a managed box and a hand-built box run the same text,
//! so a fix to one is a fix to both and there is nothing to keep in step.
//!
//! Restating those steps in Rust would have been easier to read and would have
//! drifted on the first change — and drift here is invisible. Nobody files "the
//! managed box has an older node"; they file "the agent won't start", months
//! later, on one kind of place.
//!
//! Embedding costs one thing worth naming: this crate no longer builds without
//! `aura-runner/aws/floor.sh` on disk. That is deliberate. A build that could
//! succeed with the recipe missing is a build that could ship a boot script that
//! does nothing.
//!
//! ## What this file actually decides
//!
//! Only the parameters. The floor reads five values out of its environment, and
//! this renders the `export` lines that set them — every one quoted with the
//! same quoter the remote command bodies use, so a login or a path is one word
//! to the shell whatever is in it.
//!
//! ## No secret is in here
//!
//! First-boot user data is readable from inside the machine by anything that can
//! reach the instance metadata service, so a runner token baked in would be a
//! credential handed to every process on the box. The token is delivered
//! afterwards, over the connection, the same way the connect wizard delivers one
//! to a box somebody brought.

use crate::cloudbox::script::word;

/// The recipe, as the machine will run it.
///
/// `include_str!` rather than a copy: see the module note. The path is long
/// because the file belongs to the runner rather than to the desktop — it is the
/// team's provisioning recipe, and the desktop is its second caller, not its
/// owner.
const FLOOR: &str = include_str!("../../../../../aura-runner/aws/floor.sh");

/// What a fresh machine needs to be told about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Floor {
    /// The login the work runs as.
    pub ssh_user: String,
    /// The agent CLIs to bring up holding, by binary name.
    pub agents: Vec<String>,
    /// Swap, in gigabytes.
    pub swap_gb: u32,
    /// Where the project will sit, when the request named one. `None` for an
    /// org-wide machine, which has no one checkout to make or to read a spec
    /// out of.
    pub project: Option<String>,
}

/// The script a machine runs on its first boot.
///
/// A shebang, the five parameters, and then the recipe. The parameters go first
/// because the floor reads each as `${NAME:-default}` — set here, ours win; left
/// out, its own defaults apply, which is what keeps it runnable by hand on a box
/// with nothing exported.
pub fn first_boot(floor: &Floor) -> String {
    let mut script = String::new();
    // Cloud-init only treats user data as a script when it starts with a
    // shebang. The recipe carries its own further down, which is then only a
    // comment — harmless, and worth leaving alone so the file stays runnable on
    // its own.
    script.push_str("#!/bin/bash\n");
    script.push_str(&format!("export AURA_FLOOR_USER={}\n", word(&floor.ssh_user)));
    script.push_str(&format!(
        "export AURA_FLOOR_AGENTS={}\n",
        word(&floor.agents.join(" "))
    ));
    script.push_str(&format!("export AURA_FLOOR_SWAP_GB={}\n", floor.swap_gb));
    if let Some(project) = &floor.project {
        script.push_str(&format!("export AURA_FLOOR_PROJECT={}\n", word(project)));
    }
    // AURA_FLOOR_SRC is deliberately never set. A machine Aura made has no dev
    // tree on it and no credential to fetch one with, so it takes the published
    // build — which is the one route to `aura` that needs nothing secret.
    script.push_str(FLOOR);
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::brain::place_contract::TOOLS;
    use crate::manager::brain::place_toolbox::{installable_agent_bins, AGENT_PACKAGES};

    fn asked(project: Option<&str>) -> Floor {
        Floor {
            ssh_user: "ubuntu".into(),
            agents: installable_agent_bins(),
            swap_gb: 8,
            project: project.map(str::to_string),
        }
    }

    #[test]
    fn a_fresh_machine_comes_up_holding_everything_a_place_is_asked_about() {
        // The acceptance criterion of this task, stated against the list the
        // question is actually asked from rather than against three literals: a
        // tool added to `TOOLS` is a tool `Capabilities` starts reporting on, and
        // a machine Aura made that did not install it would answer its own
        // question with "no" and look like a box somebody misconfigured.
        let script = first_boot(&asked(None));
        for tool in TOOLS {
            assert!(
                installs(&script, tool),
                "a machine Aura made comes up without {tool}, which a place is asked whether it has"
            );
        }
    }

    #[test]
    fn every_agent_the_app_can_fetch_is_one_a_fresh_machine_already_has() {
        // The other half of the same answer. The picker offers what a place
        // reports, so an agent Aura knows how to install and does not put on a
        // machine it made is an agent that exists on a box you brought and not on
        // one Aura built — a feature in one place-mode only, which is the one
        // thing this programme does not ship.
        let script = first_boot(&asked(None));
        for (bin, package) in AGENT_PACKAGES {
            assert!(
                script.contains(&format!("{bin})")),
                "the recipe has no way to install {bin}"
            );
            assert!(
                script.contains(package),
                "{bin} is named but its package {package} is not"
            );
        }
    }

    /// What a box somebody built by hand runs.
    ///
    /// Read only by the test below, and read at all so that "both sides run the
    /// same recipe" is a fact this suite checks rather than a claim a comment
    /// makes.
    const BOOTSTRAP: &str = include_str!("../../../../../aura-runner/aws/bootstrap.sh");

    #[test]
    fn a_box_built_by_hand_and_one_aura_made_are_brought_up_by_the_same_recipe() {
        // The acceptance criterion, stated where it can actually be checked
        // without booting anything. `capabilities()` is one `command -v` loop and
        // it does not know which kind of machine it is asking — so the two modes
        // can only answer differently if something PUT different things on them.
        // One recipe, run by both, is what makes that impossible.
        assert!(
            BOOTSTRAP.contains("floor.sh"),
            "the hand-built box no longer runs the shared recipe"
        );
        // And it hands over the same parameters this side does, rather than
        // having quietly grown its own spelling of them.
        for handed in ["AURA_FLOOR_AGENTS=", "AURA_FLOOR_SWAP_GB="] {
            assert!(BOOTSTRAP.contains(handed), "the hand-built box never sets {handed}");
        }
        // The steps themselves are somewhere else, which is the point: neither
        // this file nor that one installs anything.
        assert!(
            !BOOTSTRAP.contains("npm install -g"),
            "the hand-built box has grown a second copy of the agent install"
        );
    }

    #[test]
    fn the_recipe_is_the_one_the_team_already_runs_rather_than_a_second_copy() {
        // Not a style point, and the reason this file has almost nothing in it.
        // The proof is that what is embedded is the file bootstrap.sh runs —
        // checked by a marker only that file carries, so a well-meaning inlining
        // of "just these few steps" fails here rather than six months later on
        // one kind of machine.
        assert!(
            FLOOR.contains("aura-runner/aws/floor.sh"),
            "the embedded recipe is not the shared one"
        );
        assert!(
            first_boot(&asked(None)).contains(FLOOR),
            "the first boot is not the shared recipe"
        );
    }

    #[test]
    fn the_toolchain_comes_from_the_spec_the_project_declares() {
        // The reason the recipe is short. What the work needs — a rust version, a
        // database, the project's own setup — is declared in the checkout,
        // sealed and committed, so it is reviewable and visible from the repo. A
        // version pinned in a boot script is a version nobody reviews, and the
        // box drifts from the project with nobody able to see it.
        let script = first_boot(&asked(Some("/home/ubuntu/aura-sovereign")));
        assert!(
            script.contains("aura env apply"),
            "a fresh machine never applies the environment its project declares"
        );
        // Against the checkout's own settings file, so a machine with no project
        // on it yet skips the step rather than failing its boot.
        assert!(script.contains(".aura/settings.toml"), "{script}");
    }

    #[test]
    fn a_machine_for_every_project_has_no_one_project_to_bring_to_spec() {
        // `None` is not "the home directory". An org-wide machine drains every
        // project and holds no single checkout, so there is nothing to read a
        // spec out of and nothing to make.
        // Against the `export`, not the name: the recipe reads the variable
        // either way, so the question is whether this side SET one.
        let script = first_boot(&asked(None));
        assert!(!script.contains("export AURA_FLOOR_PROJECT="), "{script}");
    }

    #[test]
    fn what_the_machine_is_told_about_itself_is_one_word_each() {
        // Every one of these reaches the far side as a shell word. A login with a
        // space in it splits an argument; a path with a backtick runs a command.
        let script = first_boot(&Floor {
            ssh_user: "odd user".into(),
            agents: vec!["claude".into()],
            swap_gb: 8,
            project: Some("/home/odd user/a project".into()),
        });
        assert!(script.contains("export AURA_FLOOR_USER='odd user'"), "{script}");
        assert!(
            script.contains("export AURA_FLOOR_PROJECT='/home/odd user/a project'"),
            "{script}"
        );
    }

    #[test]
    fn the_first_boot_carries_no_secret() {
        // User data is readable from inside the machine by anything that can
        // reach the metadata service. A token in here is a token handed to every
        // process on the box.
        let script = first_boot(&asked(Some("/home/ubuntu/aura-sovereign"))).to_lowercase();
        for leak in ["token", "secret", "password", "aws_", "-----begin", "key_ref"] {
            assert!(!script.contains(leak), "the boot script says {leak:?}");
        }
    }

    #[test]
    fn the_script_is_something_a_machine_will_run() {
        // Cloud-init only treats user data as a script when it opens with a
        // shebang; without one the box boots, reports healthy, and has nothing on
        // it — which reads as "the image is broken" rather than as "we forgot a
        // line".
        assert!(first_boot(&asked(None)).starts_with("#!/bin/bash\n"));
    }

    /// Does the recipe put this tool on a machine?
    ///
    /// `git` and `tmux` arrive in the package list; `aura` has a step of its own,
    /// because there is no distribution package for it. Asked as one question so
    /// the test above can read straight off [`TOOLS`] rather than knowing which
    /// tool is fetched which way.
    fn installs(script: &str, tool: &str) -> bool {
        script
            .lines()
            .any(|l| l.contains("FLOOR_PACKAGES=") && l.contains(tool))
            || script.contains(&format!("command -v {tool} >/dev/null"))
    }
}
