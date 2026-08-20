//! What to ask the cloud for, worked out before anything is asked.
//!
//! One request in, one plan out, no IO. That split is the point: everything a
//! human argues about — how big a machine a class means, where a project's
//! checkout lands, how much swap it comes up with — is decided here, in a pure
//! function, where it can be read and asserted. The driver below is then only
//! the translation of a plan into somebody else's API, and a failure there is
//! genuinely about the cloud rather than about a decision we buried in it.
//!
//! The shape follows `aura-runner/aws/provision.sh` and its `bootstrap.sh`,
//! which is the recipe that already works: an ARM Ubuntu image and a gp3 root
//! volume big enough for a cold build. Reusing that shape rather than inventing
//! one is deliberate — a managed box that diverged from the box the team already
//! runs would fail in ways nobody has seen before.
//!
//! The reuse is literal for the first boot: what the machine RUNS is
//! [`super::floor`], which embeds the team's own recipe. This file decides only
//! the handful of values that recipe is parameterised by, which is the part
//! worth arguing about here.

use crate::cloudbox::script::is_abs_path;
use crate::manager::brain::place_toolbox::installable_agent_bins;
use crate::provisioner::domain::{
    MachineClass, ProvisionError, ProvisionSpec, ProvisionStep, Result,
};

use super::floor::{self, Floor};
use super::settings::ManagedSettings;

/// The size a request gets when it does not ask for one.
///
/// The recipe's own `t4g.large`. Small enough to be an unremarkable bill and
/// big enough that the first thing anybody does on a fresh box — build the
/// project — does not fall over, which is the failure that makes a machine feel
/// broken rather than modest.
const DEFAULT_CLASS: MachineClass = MachineClass::Medium;

/// Swap laid down on first boot, in gigabytes.
///
/// Not a luxury: an 8 GB box with no swap wedges partway through a cold Rust
/// build, and the machine stays "running" while nothing on it answers — which
/// is the worst shape a failure can take, because every surface above says the
/// place is fine.
const SWAP_GB: u32 = 8;

/// Everything the driver needs to make one machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    /// What it is called on the board, and the name tagged on the machine so
    /// somebody looking at the cloud's own console sees the same word.
    pub name: String,
    pub region: String,
    pub image_id: String,
    /// The substrate's word for the size, resolved from the class.
    pub instance_type: String,
    pub disk_gb: u32,
    pub ssh_user: String,
    pub key_pair: String,
    /// Copied through to the machine's record — a reference to the key, never
    /// the key.
    pub key_ref: String,
    pub security_group: String,
    /// Where the project's checkout will sit, when the request named a project.
    pub repo_path: Option<String>,
    /// The agent CLIs the machine comes up holding, by binary name.
    ///
    /// Read off [`installable_agent_bins`] rather than chosen here, because the
    /// picker offers what a place REPORTS: an agent the app knows how to fetch
    /// and a fresh machine did not get is a feature that exists on a box you
    /// brought and not on one Aura made.
    pub agents: Vec<String>,
    /// The script the machine runs on its first boot.
    pub user_data: String,
}

/// The substrate's name for a class.
///
/// 64-bit ARM throughout, matching the image the recipe builds against. Mixing
/// an ARM size with an x86 image is the one mistake here that produces a
/// perfectly clear cloud-side error nobody can act on, so the two are pinned
/// together in prose in [`super::settings::ManagedSettings::image_id`] and
/// never chosen independently.
fn instance_type(class: MachineClass) -> &'static str {
    match class {
        MachineClass::Small => "t4g.medium",
        MachineClass::Medium => "t4g.large",
        MachineClass::Large => "t4g.xlarge",
        MachineClass::XLarge => "t4g.2xlarge",
    }
}

/// Work out what to make. The one step that can fail without touching a cloud.
pub fn plan_for(spec: &ProvisionSpec, settings: &ManagedSettings) -> Result<LaunchPlan> {
    let name = spec.machine_name()?;
    let repo_path = checkout_path(spec.repo.as_deref(), &settings.home)?;
    let ssh_user = settings.ssh_user.clone();
    let agents = installable_agent_bins();

    Ok(LaunchPlan {
        user_data: floor::first_boot(&Floor {
            ssh_user: ssh_user.clone(),
            agents: agents.clone(),
            swap_gb: SWAP_GB,
            project: repo_path.clone(),
        }),
        name,
        region: settings.region.clone(),
        image_id: settings.image_id.clone(),
        instance_type: instance_type(spec.class.unwrap_or(DEFAULT_CLASS)).to_string(),
        disk_gb: settings.disk_gb,
        ssh_user,
        key_pair: settings.key_pair.clone(),
        key_ref: settings.key_ref.clone(),
        security_group: settings.security_group.clone(),
        repo_path,
        agents,
    })
}

/// Where a project's checkout lands on the box.
///
/// A request with no project is an org-wide machine that drains every project,
/// and it gets no checkout path at all — `None` rather than the home directory,
/// because a place whose `repo_path` is `$HOME` claims to have a project there
/// and every surface that opens a shell "in the repo" lands in a directory with
/// no repo in it.
///
/// The directory is the repo's own half of `owner/name`, and it is checked
/// rather than trusted. It becomes a path on a machine and a word in a boot
/// script, and `..` in either of those is a directory somewhere it was never
/// meant to be.
fn checkout_path(repo: Option<&str>, home: &str) -> Result<Option<String>> {
    let Some(repo) = repo.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let dir = repo.rsplit('/').next().unwrap_or("").trim();
    let usable = !dir.is_empty()
        && dir != "."
        && dir != ".."
        && dir
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !usable {
        return Err(refused(format!(
            "{repo:?} isn't a project name a folder can be made from — a project is \
             written owner/name"
        )));
    }
    let path = format!("{}/{dir}", home.trim_end_matches('/'));
    if !is_abs_path(&path) {
        return Err(refused(format!(
            "{path:?} isn't somewhere a project can be kept on a machine"
        )));
    }
    Ok(Some(path))
}

fn refused(detail: String) -> ProvisionError {
    ProvisionError::Step {
        step: ProvisionStep::Plan,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioner::domain::ProvisionKind;

    fn settings() -> ManagedSettings {
        ManagedSettings {
            substrate: super::super::settings::AWS_EC2.to_string(),
            region: "eu-central-1".into(),
            image_id: "ami-0123456789abcdef0".into(),
            ssh_user: "ubuntu".into(),
            key_pair: "aura-managed".into(),
            key_ref: "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b".into(),
            security_group: "aura-managed".into(),
            home: "/home/ubuntu".into(),
            disk_gb: 40,
        }
    }

    fn spec(name: &str, repo: Option<&str>, class: Option<MachineClass>) -> ProvisionSpec {
        ProvisionSpec {
            kind: ProvisionKind::Managed,
            name: name.into(),
            repo: repo.map(str::to_string),
            class,
        }
    }

    #[test]
    fn a_request_with_no_size_gets_the_one_the_recipe_uses() {
        // Not the smallest. A box that cannot finish the first build anybody
        // runs on it reads as broken, and the difference in bill between these
        // two sizes is smaller than one support conversation.
        let plan = plan_for(&spec("crew-box", None, None), &settings()).unwrap();
        assert_eq!(plan.instance_type, "t4g.large");
    }

    #[test]
    fn every_size_maps_to_one_the_image_can_boot() {
        // All four are 64-bit ARM, like the image. An x86 size against an ARM
        // image fails at launch with a message about architectures that names
        // nothing the person did.
        for class in [
            MachineClass::Small,
            MachineClass::Medium,
            MachineClass::Large,
            MachineClass::XLarge,
        ] {
            assert!(
                instance_type(class).starts_with("t4g."),
                "{class:?} is not an ARM size"
            );
        }
    }

    #[test]
    fn a_project_gets_a_folder_named_after_it() {
        let plan = plan_for(
            &spec("crew-box", Some("MHASK/aura-sovereign"), None),
            &settings(),
        )
        .unwrap();
        assert_eq!(plan.repo_path.as_deref(), Some("/home/ubuntu/aura-sovereign"));
        // And the machine is told where it goes, so the recipe makes it — owned
        // by the login that will work in it, since a directory root owns is a
        // directory every later write fails in.
        assert!(
            plan.user_data
                .contains("export AURA_FLOOR_PROJECT=/home/ubuntu/aura-sovereign"),
            "{}",
            plan.user_data
        );
    }

    #[test]
    fn a_machine_for_every_project_has_no_one_project_folder() {
        // `None`, not the home directory. A place whose repo_path is $HOME
        // tells every surface there is a project there, and the shells that
        // open "in the repo" land in a directory with no repo in it.
        let plan = plan_for(&spec("crew-box", None, None), &settings()).unwrap();
        assert_eq!(plan.repo_path, None);
        assert!(!plan.user_data.contains("export AURA_FLOOR_PROJECT="));
    }

    #[test]
    fn a_project_name_that_would_escape_its_home_is_refused() {
        // The name becomes a path on a machine and a word in a boot script.
        // `..` in either is a directory somewhere nobody chose, and a space or
        // a semicolon is a second command.
        for hostile in ["owner/..", "owner/.", "owner/", "owner/a b", "owner/x;rm -rf /"] {
            let refused = plan_for(&spec("crew-box", Some(hostile), None), &settings());
            let Err(ProvisionError::Step { step, detail }) = refused else {
                panic!("{hostile:?} was accepted as a project name");
            };
            assert_eq!(step, ProvisionStep::Plan);
            assert!(!detail.is_empty());
        }
    }

    #[test]
    fn a_project_folder_is_always_under_the_home_it_was_given() {
        // Only the repo's own half of `owner/name` becomes a directory, so a
        // slug that tries to climb lands where every other project does.
        let plan = plan_for(&spec("crew-box", Some("../../etc"), None), &settings()).unwrap();
        assert_eq!(plan.repo_path.as_deref(), Some("/home/ubuntu/etc"));
    }

    #[test]
    fn an_unnamed_machine_is_refused_before_a_cloud_is_asked_for_anything() {
        // The same refusal the BYO arm makes, from the same rule on the spec —
        // which is the point of it living there rather than in either backend.
        assert!(matches!(
            plan_for(&spec("   ", None, None), &settings()),
            Err(ProvisionError::MissingName)
        ));
    }

    #[test]
    fn the_first_boot_carries_no_secret() {
        // A boot script is readable from inside the machine by anything that
        // can reach the metadata service. A token in here is a token handed to
        // every process on the box.
        let plan = plan_for(
            &spec("crew-box", Some("MHASK/aura-sovereign"), None),
            &settings(),
        )
        .unwrap();
        let lowered = plan.user_data.to_lowercase();
        for leak in ["token", "secret", "password", "aws_", "-----begin", "key_ref"] {
            assert!(!lowered.contains(leak), "the boot script says {leak:?}");
        }
        // And the key reference itself, which is not a secret, still has no
        // reason to be on the box.
        assert!(!plan.user_data.contains(&settings().key_ref));
    }

    #[test]
    fn the_first_boot_is_the_recipe_a_hand_built_box_runs() {
        // What is actually on the machine is proved in `floor`, against the same
        // lists the app reads a place's capabilities from. What is proved HERE is
        // the one thing this file decides about it: that the plan reaches for
        // that recipe rather than carrying a second, shorter one of its own,
        // which is how the two ways of coming by a machine start to differ.
        let plan = plan_for(&spec("crew-box", None, None), &settings()).unwrap();
        assert!(
            plan.user_data
                .contains("aura-runner/aws/floor.sh"),
            "{}",
            plan.user_data
        );
        // The machine is told who it is for and how much swap to lay down. A box
        // with no swap does not slow down under memory pressure, it stops, and
        // the cloud goes on reporting it as running.
        assert!(plan.user_data.contains("export AURA_FLOOR_USER=ubuntu"));
        assert!(plan.user_data.contains(&format!("export AURA_FLOOR_SWAP_GB={SWAP_GB}")));
    }

    #[test]
    fn a_fresh_machine_is_told_to_hold_every_agent_the_app_can_offer() {
        // The picker offers what a place REPORTS. An agent Aura knows how to
        // fetch and does not put on a machine it made is a feature that exists on
        // a box you brought and not on one Aura built.
        let plan = plan_for(&spec("crew-box", None, None), &settings()).unwrap();
        assert_eq!(plan.agents, installable_agent_bins());
        assert!(
            plan.user_data
                .contains(&format!("export AURA_FLOOR_AGENTS='{}'", plan.agents.join(" "))),
            "{}",
            plan.user_data
        );
    }

    #[test]
    fn the_plan_carries_the_reference_and_not_a_key() {
        let plan = plan_for(&spec("crew-box", None, None), &settings()).unwrap();
        assert_eq!(plan.key_ref, settings().key_ref);
        assert_eq!(plan.key_pair, "aura-managed");
        // Two fields because they answer to two systems — the substrate is told
        // the launch name, the row records the reference.
        assert_ne!(plan.key_ref, plan.key_pair);
    }

    #[test]
    fn a_typed_name_is_the_one_the_machine_is_tagged_with() {
        // Same trim as the board will poll for. Tagged with the untrimmed one,
        // the machine exists and nothing ever finds it by name.
        let plan = plan_for(&spec("  crew-box  ", None, None), &settings()).unwrap();
        assert_eq!(plan.name, "crew-box");
    }
}
