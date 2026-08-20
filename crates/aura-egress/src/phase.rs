//! The split itself, as a value rather than as a convention.
//!
//! "Setup has the network and the agent does not" is the kind of rule that
//! survives exactly as long as everybody who touches the code remembers it.
//! Written down as a type it survives longer: the surfaces that start work
//! match on a [`Phase`], so a new way of starting an agent has to say which of
//! the two it is, and saying [`Phase::Agent`] is the same thing as being
//! confined — there is no separate switch to forget to set.
//!
//! It is `Serialize` because the frontend shows a person which half of a run
//! they are looking at, and a UI that restates the split in its own words is a
//! UI that can disagree with this one.

use serde::{Deserialize, Serialize};

/// Which half of a run this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Installing. Toolchains, packages, the project's own setup script.
    Setup,
    /// The model with a shell in it.
    Agent,
}

/// How far a phase can get off the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    /// Whatever the machine itself can reach. What installing is.
    Everything,
    /// The endpoints on this project's list, and no others.
    OnlyTheAllowlist,
}

impl Phase {
    /// Both of them, in the order they happen.
    pub const BOTH: [Phase; 2] = [Phase::Setup, Phase::Agent];

    /// The word this phase is filed under — in a journal name, in an event, in
    /// an argument.
    pub fn name(self) -> &'static str {
        match self {
            Phase::Setup => "setup",
            Phase::Agent => "agent",
        }
    }

    /// How far off the machine this phase gets.
    pub fn reach(self) -> Reach {
        match self {
            Phase::Setup => Reach::Everything,
            Phase::Agent => Reach::OnlyTheAllowlist,
        }
    }

    /// Does this phase run behind the wall?
    ///
    /// The one question every caller actually asks, kept as a method so the
    /// answer lives in one file. A place that starts work reads this rather
    /// than carrying its own boolean.
    pub fn is_confined(self) -> bool {
        matches!(self.reach(), Reach::OnlyTheAllowlist)
    }

    /// The sentence a person is shown.
    pub fn plainly(self) -> &'static str {
        match self {
            Phase::Setup => {
                "the setup phase, which has the network because installing is what a network is for"
            }
            Phase::Agent => {
                "the agent phase, which can reach only what this project declared, plus its own \
                 model and the remote this checkout came from"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_has_the_network_and_the_agent_does_not() {
        // The whole feature, in one assertion. If this ever reads the other way
        // round, everything else in this crate is decoration.
        assert_eq!(Phase::Setup.reach(), Reach::Everything);
        assert!(!Phase::Setup.is_confined());
        assert_eq!(Phase::Agent.reach(), Reach::OnlyTheAllowlist);
        assert!(Phase::Agent.is_confined());
    }

    #[test]
    fn a_phase_travels_as_the_word_it_is_filed_under() {
        // The frontend and the journal name it the same way, or the report is
        // about a phase nobody ran.
        for phase in Phase::BOTH {
            let wire = serde_json::to_string(&phase).expect("a phase");
            assert_eq!(wire, format!("\"{}\"", phase.name()));
            let back: Phase = serde_json::from_str(&wire).expect("a phase");
            assert_eq!(back, phase);
        }
    }

    #[test]
    fn setup_comes_first() {
        assert_eq!(Phase::BOTH, [Phase::Setup, Phase::Agent]);
    }
}
