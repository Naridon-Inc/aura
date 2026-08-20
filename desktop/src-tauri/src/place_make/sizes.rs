//! How big a machine, said in what it is for rather than in what it is.
//!
//! The sizes are [`MachineClass`], which the plan turns into the substrate's
//! own word for a shape — and that word is the one thing an admin must never be
//! shown. `t4g.large` is a fact about Amazon's catalogue: it does not say
//! whether one person's agent will fit on it, it goes stale the day the
//! substrate is swapped for Firecracker, and the person picking is deciding how
//! many teammates will be working on the box, not which processor family.
//!
//! So the offer is written here, once, and travels to the surface as data. The
//! alternative — a picker that hard-codes four labels — is two lists that drift
//! apart, and the day a class is added or a bill changes, the app is confidently
//! describing a size that no longer exists.

use serde::Serialize;

use crate::provisioner::MachineClass;

/// One size, as it is offered.
#[derive(Debug, Clone, Serialize)]
pub struct Size {
    /// The token the surface sends back. Lowercase and stable — it is the wire,
    /// not the label, so rewording the title never changes what gets made.
    pub id: &'static str,
    pub title: &'static str,
    /// What it is for, in one line. What fits on it, not what it is made of.
    pub detail: &'static str,
    /// Whether this is the one to select when nothing has been chosen.
    pub suggested: bool,
}

/// The size a request gets when it does not ask for one.
///
/// The same class [`crate::provisioner`]'s plan falls back to. Spelled here as
/// well because this is the value the SURFACE pre-selects, and the two agreeing
/// is what stops "I left it on the default" and "I sent no size at all" from
/// producing two different machines and two different bills.
const SUGGESTED: MachineClass = MachineClass::Medium;

/// Every size on offer, largest last.
///
/// Four, because [`MachineClass`] has four and this list is not allowed to be
/// shorter: a class the app cannot ask for is a class that exists in the seam
/// and nowhere a person can reach, which is the same as it not existing while
/// still being something to maintain.
pub const SIZES: [Size; 4] = [
    Size {
        id: "small",
        title: "Small",
        detail: "One person, one project at a time. Editing, tests, light builds.",
        suggested: matches!(SUGGESTED, MachineClass::Small),
    },
    Size {
        id: "medium",
        title: "Medium",
        detail: "A couple of people, or one person running agents while they work.",
        suggested: matches!(SUGGESTED, MachineClass::Medium),
    },
    Size {
        id: "large",
        title: "Large",
        detail: "A small team on one box, or builds that take a while.",
        suggested: matches!(SUGGESTED, MachineClass::Large),
    },
    Size {
        id: "xlarge",
        title: "Extra large",
        detail: "A team plus several agents at once. The most it can do, and the most it costs.",
        suggested: matches!(SUGGESTED, MachineClass::XLarge),
    },
];

/// Which class a surface asked for.
///
/// An unrecognised id is refused rather than quietly defaulted. A picker that
/// sent `"huge"` and got a medium machine would bill somebody for a size they
/// did not choose and give them a box they did not ask for, and neither of
/// those shows up as an error anywhere.
pub fn class_of(id: &str) -> Result<MachineClass, String> {
    match id.trim().to_ascii_lowercase().as_str() {
        "small" => Ok(MachineClass::Small),
        "medium" => Ok(MachineClass::Medium),
        "large" => Ok(MachineClass::Large),
        "xlarge" => Ok(MachineClass::XLarge),
        other => Err(format!(
            "There is no machine size called {other:?}. Pick one of the sizes on offer."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list and the seam have to hold the same number of sizes. A class
    /// added to the seam without a line here is one the app cannot ask for; a
    /// line here without a class is a picker option that fails on click.
    #[test]
    fn every_size_on_offer_is_a_size_the_seam_can_make() {
        for size in SIZES {
            class_of(size.id).unwrap_or_else(|why| panic!("{}: {why}", size.id));
        }
        // The other direction — every class is offered — read off the ids,
        // since a `MachineClass` cannot be enumerated at runtime.
        let offered: Vec<&str> = SIZES.iter().map(|s| s.id).collect();
        assert_eq!(offered, ["small", "medium", "large", "xlarge"]);
    }

    #[test]
    fn exactly_one_size_is_suggested() {
        assert_eq!(SIZES.iter().filter(|s| s.suggested).count(), 1);
    }

    /// The default the surface pre-selects and the default the plan falls back
    /// to are the same size. If they part company, choosing nothing and leaving
    /// the default alone make two different machines.
    #[test]
    fn the_suggested_size_is_the_one_a_request_without_one_gets() {
        let suggested = SIZES.iter().find(|s| s.suggested).expect("one is");
        assert_eq!(class_of(suggested.id).unwrap(), SUGGESTED);
    }

    #[test]
    fn a_size_nobody_offers_is_refused_rather_than_rounded() {
        let refused = class_of("huge").unwrap_err();
        assert!(refused.contains("huge"), "{refused}");
        assert!(class_of("").is_err(), "an empty size is not a size");
    }

    /// The substrate's vocabulary is the plan's business. A label here that
    /// named an instance family would go stale the day the driver is swapped,
    /// and it answers a question nobody picking a machine is asking.
    #[test]
    fn no_size_is_described_in_the_clouds_own_words() {
        for size in SIZES {
            let said = format!("{} {}", size.title, size.detail).to_ascii_lowercase();
            for jargon in ["t4g", "vcpu", "ec2", "instance", "arm64", "gib"] {
                assert!(!said.contains(jargon), "{}: said {jargon:?}", size.id);
            }
        }
    }
}
