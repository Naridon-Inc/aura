//! Exactly what Aura asks for in somebody else's cloud account, and why.
//!
//! A customer is being asked to hand a company standing permission inside their
//! own account. The only honest way to ask is to say precisely what will be
//! used and precisely what will not, in terms they can check against the policy
//! they are about to write — so the list is data rather than prose, it is
//! rendered into the document they paste, and the same list is what the code
//! actually spends. A README that drifted from the code would be worse than no
//! README, because it would be believed.
//!
//! ## The shape of the ask
//!
//! Three actions. Aura stops a machine nobody is using and starts it again when
//! somebody wants it, and to do either it has to be able to see what the machine
//! is doing. That is the whole of it, and it is the whole of it because the
//! grant exists to close ONE asymmetry — a box you brought could not sleep — and
//! not to make Aura an administrator of your account.
//!
//! ## What is deliberately absent, and why that matters more
//!
//! [`WITHHELD`] is not decoration and it is not a to-do list. Every entry is a
//! permission that would have made some part of this module simpler and was
//! refused, and each one names the harm. A reviewer reading [`NEEDED`] alone
//! learns what Aura can do; a reviewer reading both learns what it *cannot*,
//! which is the half that decides whether the ask is reasonable. The two lists
//! are asserted against each other below, so a permission cannot quietly move
//! from one to the other without a test failing.
//!
//! ## The tag is the customer's own switch
//!
//! The two actions that change a machine are conditioned on a tag the customer
//! puts on the machines they are opting in ([`TAG_KEY`] = [`TAG_VALUE`]).
//! That way the blast radius is not "every instance in the account" but "the
//! ones they marked", and revoking Aura's reach over one box is removing a tag
//! rather than editing a policy. `DescribeInstances` is not conditioned, because
//! it cannot be: it is a list action and AWS evaluates it against the whole
//! account, which is a limitation of the API rather than a decision made here —
//! and it is why the read is the only unconditioned thing in the document.

use serde::Serialize;

/// The tag a customer puts on the machines they are letting Aura stop and start.
pub const TAG_KEY: &str = "aura:lifecycle";

/// What that tag has to say.
pub const TAG_VALUE: &str = "allow";

/// One permission Aura asks for, in the cloud's own spelling, with the reason
/// stated in the customer's terms rather than in ours.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Permission {
    /// The action as the policy document spells it.
    pub action: &'static str,
    /// What Aura does with it, in a sentence a person can weigh.
    pub why: &'static str,
    /// Whether the customer's tag limits it. False only where the cloud offers
    /// no way to limit it, which is a fact worth showing rather than hiding.
    pub limited_to_tagged: bool,
}

/// One permission Aura deliberately does not ask for, and what it would cost the
/// customer if it did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Withheld {
    pub action: &'static str,
    /// Why Aura will not have it — the harm, not the policy.
    pub why_not: &'static str,
}

/// Everything the grant is for.
///
/// Three, in the order they happen: find the machine, stop it, start it.
pub const NEEDED: [Permission; 3] = [
    Permission {
        action: "ec2:DescribeInstances",
        why: "Find the machine you connected, by the address you typed, and read back \
              whether it is running, stopping or stopped. Aura reads this before it \
              stops anything and while it waits for a machine to come back — a stop \
              sent without looking is a stop sent to whatever used to be there.",
        // A list action: the cloud evaluates it against the account rather than
        // against one machine, so a tag condition on it would refuse every call
        // rather than narrow one.
        limited_to_tagged: false,
    },
    Permission {
        action: "ec2:StopInstances",
        why: "Stop a machine nobody has used for a while, so it stops costing you \
              compute. The disk stays exactly as it was — this is the same stop you \
              would press in your own console, not a delete.",
        limited_to_tagged: true,
    },
    Permission {
        action: "ec2:StartInstances",
        why: "Start it again the moment anything reaches it, so nobody has to know it \
              was ever stopped.",
        limited_to_tagged: true,
    },
];

/// Everything the grant deliberately is not.
///
/// Each of these would have made something here shorter. None of them is
/// necessary to stop a machine and start it again, and that is the test any
/// addition to [`NEEDED`] has to pass.
pub const WITHHELD: [Withheld; 5] = [
    Withheld {
        action: "ec2:RunInstances",
        why_not: "Aura does not make machines in your account under this grant — the \
                  boxes are ones you already run. A role that could launch one could \
                  spend your money without anybody asking you first.",
    },
    Withheld {
        action: "ec2:TerminateInstances",
        why_not: "Sleeping is reversible and ending a machine is not. A role that could \
                  end one could take a disk, the work that had not been pushed yet, and \
                  the toolchain somebody spent an afternoon installing.",
    },
    Withheld {
        action: "ec2:AuthorizeSecurityGroupIngress",
        why_not: "What is allowed to reach your machines is your decision. Aura never \
                  opens a way in, not even to fix a box it cannot reach.",
    },
    Withheld {
        action: "ec2:CreateKeyPair",
        why_not: "Creating a key pair is the one call that hands back private key \
                  material, and Aura has no use for yours: your own key opens these \
                  boxes, and Aura only stops and starts them.",
    },
    Withheld {
        action: "iam:*",
        why_not: "Nothing here reads or changes who can do what in your account. A role \
                  that could edit permissions could widen its own.",
    },
];

/// The permission document, as the customer pastes it.
///
/// Rendered from [`NEEDED`] rather than written out beside it, so the policy a
/// customer attaches and the calls Aura makes cannot drift: adding an action to
/// the list changes the document, and adding one to the document is impossible
/// without the list. Two statements because the two halves are scoped
/// differently, and collapsing them would have meant scoping the pair by the
/// weaker of the two.
pub fn permission_policy() -> String {
    let reads: Vec<&str> = NEEDED
        .iter()
        .filter(|p| !p.limited_to_tagged)
        .map(|p| p.action)
        .collect();
    let changes: Vec<&str> = NEEDED
        .iter()
        .filter(|p| p.limited_to_tagged)
        .map(|p| p.action)
        .collect();
    // Built up rather than written inline because the key is the tag's name and
    // the tag's name is a constant — a document with the key typed out would be
    // one more place for the tag to be renamed in.
    let mut tagged = serde_json::Map::new();
    tagged.insert(format!("ec2:ResourceTag/{TAG_KEY}"), serde_json::json!(TAG_VALUE));
    let document = serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AuraSeesWhichMachinesAreRunning",
                "Effect": "Allow",
                "Action": reads,
                // Unconditioned because the cloud offers no way to condition a
                // list action, not because a narrower read was not wanted.
                "Resource": "*"
            },
            {
                "Sid": "AuraStopsAndStartsTheOnesYouMarked",
                "Effect": "Allow",
                "Action": changes,
                "Resource": "*",
                "Condition": { "StringEquals": tagged }
            }
        ]
    });
    serde_json::to_string_pretty(&document)
        .expect("a document built from constants in this file is serialisable")
}

/// The whole ask, as one thing a surface can draw.
///
/// Both lists together, because showing one without the other is how a
/// reasonable ask reads as an unreasonable one — or, worse, the other way round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ask {
    pub needed: Vec<Permission>,
    pub withheld: Vec<Withheld>,
    pub tag_key: &'static str,
    pub tag_value: &'static str,
    /// The document to paste, rendered from `needed`.
    pub policy: String,
    /// What the customer still has to decide, said plainly. The trust half of a
    /// role names Aura's own principal and the shared external id, and neither
    /// is something this process may invent on their behalf.
    pub note: String,
}

pub fn ask() -> Ask {
    Ask {
        needed: NEEDED.to_vec(),
        withheld: WITHHELD.to_vec(),
        tag_key: TAG_KEY,
        tag_value: TAG_VALUE,
        policy: permission_policy(),
        note: format!(
            "Put this on a role in your own account, tag the machines you want Aura to be \
             able to stop with {TAG_KEY}={TAG_VALUE}, and have the role trust Aura with an \
             external id you both hold. Aura can then stop an idle box and start it again \
             — and nothing else in your account."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_document_is_built_from_the_list_that_is_actually_spent() {
        // The claim the whole file rests on: what a customer grants and what
        // Aura calls are the same list. A document written out by hand beside
        // the list is a document that is right on the day it is written.
        let policy = permission_policy();
        for permission in NEEDED {
            assert!(
                policy.contains(permission.action),
                "{} is asked for in code and missing from the document",
                permission.action
            );
        }
    }

    #[test]
    fn nothing_withheld_appears_in_the_document() {
        // The half that stops the ask growing quietly. A permission moved from
        // one list to the other without anybody deciding to would land here.
        let policy = permission_policy();
        for refused in WITHHELD {
            // `iam:*` is a family rather than one action, so the wildcard is
            // matched on its prefix.
            let named = refused.action.trim_end_matches('*');
            assert!(
                !policy.contains(named),
                "{} is refused in one list and granted in the document",
                refused.action
            );
        }
    }

    #[test]
    fn a_permission_is_never_in_both_lists() {
        for asked in NEEDED {
            for refused in WITHHELD {
                assert_ne!(
                    asked.action, refused.action,
                    "{} is asked for and refused at the same time",
                    asked.action
                );
            }
        }
    }

    #[test]
    fn aura_cannot_make_or_end_a_machine_in_somebody_elses_account() {
        // The boundary this grant is defined by, pinned rather than described.
        // Sleep needs neither, and a grant that carried either would be a grant
        // that could spend a customer's money or take their disk.
        let policy = permission_policy();
        for never in ["RunInstances", "TerminateInstances", "CreateKeyPair", "iam:"] {
            assert!(!policy.contains(never), "the ask includes {never}:\n{policy}");
        }
        // And it is refused on the record, with the harm named — so a reviewer
        // reads why rather than having to notice an absence.
        for never in ["ec2:RunInstances", "ec2:TerminateInstances"] {
            let entry = WITHHELD
                .iter()
                .find(|w| w.action == never)
                .unwrap_or_else(|| panic!("{never} is not refused anywhere on the record"));
            assert!(!entry.why_not.trim().is_empty());
        }
    }

    #[test]
    fn the_two_actions_that_change_a_machine_are_limited_to_the_tagged_ones() {
        // The customer's own switch. Without the condition the ask is "every
        // instance in the account", which is a different product.
        let policy: serde_json::Value =
            serde_json::from_str(&permission_policy()).expect("a readable document");
        let statements = policy["Statement"].as_array().expect("statements");
        let changing = statements
            .iter()
            .find(|s| s["Action"].as_array().is_some_and(|a| a.iter().any(|x| x == "ec2:StopInstances")))
            .expect("a statement that stops machines");
        assert_eq!(
            changing["Condition"]["StringEquals"][format!("ec2:ResourceTag/{TAG_KEY}")],
            serde_json::json!(TAG_VALUE),
            "stopping a machine is not limited to the ones the customer marked"
        );
        assert!(
            changing["Action"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x == "ec2:StartInstances")),
            "starting is scoped differently from stopping, so revoking one leaves the other"
        );
    }

    #[test]
    fn the_read_says_out_loud_that_it_could_not_be_narrowed() {
        // An unconditioned statement in a least-privilege document has to be
        // explained where somebody will see it, or it reads as carelessness.
        let read = NEEDED
            .iter()
            .find(|p| p.action == "ec2:DescribeInstances")
            .expect("the read");
        assert!(!read.limited_to_tagged);
        for changing in NEEDED.iter().filter(|p| p.action != "ec2:DescribeInstances") {
            assert!(
                changing.limited_to_tagged,
                "{} changes a machine and is not limited to the tagged ones",
                changing.action
            );
        }
    }

    #[test]
    fn every_permission_says_why_in_words_a_customer_can_weigh() {
        // The ask is shown to somebody deciding whether to grant it. A list of
        // action names is not a decision anybody can make.
        for permission in NEEDED {
            assert!(
                permission.why.len() > 40,
                "{} is asked for without a reason anybody could weigh",
                permission.action
            );
            for jargon in ["microVM", "egress", "provisioner", "seam", "AST"] {
                assert!(!permission.why.contains(jargon), "{}: {}", permission.action, permission.why);
            }
        }
        for refused in WITHHELD {
            assert!(refused.why_not.len() > 40, "{} is refused without saying why", refused.action);
        }
    }

    #[test]
    fn the_ask_carries_both_halves_and_the_document() {
        let ask = ask();
        assert_eq!(ask.needed.len(), NEEDED.len());
        assert_eq!(ask.withheld.len(), WITHHELD.len());
        assert_eq!(ask.tag_key, TAG_KEY);
        assert!(ask.policy.contains("ec2:StopInstances"), "{}", ask.policy);
        // And it says what Aura will not decide for them. The trust half of a
        // role names Aura's own principal and a shared external id; guessing
        // either would be guessing at who may act in their account.
        assert!(ask.note.contains("external id"), "{}", ask.note);
    }
}
