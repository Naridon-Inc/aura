//! What a customer wrote down when they let Aura act in their cloud account.
//!
//! The managed arm's setup next door says which account *Aura* spends. This one
//! says which account *somebody else* has let Aura reach, and the difference is
//! the whole of the BYOC arm: the metal is theirs, the account is theirs, the
//! bill is theirs, and what Aura holds is a role in it that can do three things
//! ([`super::permissions`]).
//!
//! Read from `~/.aura/cloud-grants.json`, and — exactly as with managed mode —
//! **the absence of the file is the switch.** No file means nobody has granted
//! anything, which is the shipping default, and it is why the code below can be
//! whole while behaving on an ordinary install as though none of it were here.
//!
//! ## What is in the file, and what is not
//!
//! A role to assume, an external id to assume it with, a region and a name. No
//! access key: assuming the role is done with the credential this process was
//! already given, and if there is none then there is nothing to assume with and
//! it says so. The external id is the closest thing here to a secret — it is
//! what stops somebody else's Aura install being talked into acting on this
//! account — so it is checked for shape, kept out of every `Debug`, and never
//! put in a message.

use serde::{Deserialize, Serialize};

/// The one substrate a grant can name today. The same word the managed arm's
/// settings use, and deliberately the same constant, so a file that names a
/// cloud Aura cannot reach is refused by name rather than falling through to
/// the one it can.
pub use crate::provisioner::managed::settings::AWS_EC2;

/// The longest an external id may be. AWS's own ceiling is 1224; anything near
/// it is a paste rather than an id, and the cap is here so a hand-edited file
/// cannot put a whole document into a signed request.
const EXTERNAL_ID_MAX_LEN: usize = 1224;

/// The shortest one worth having. AWS accepts two characters; an id that short
/// is not a defence against anything, and a customer who typed one deserves to
/// be told before it is the only thing standing between two accounts.
const EXTERNAL_ID_MIN_LEN: usize = 16;

/// One account somebody has let Aura act in.
///
/// Deliberately **not** `Debug`, for the same reason [`Endpoint`] next door is
/// not: it holds the external id, and the one thing that must never happen to a
/// shared secret is being written down by something that was only trying to be
/// helpful. Leaving the derive off makes that a compile error rather than a
/// habit — see [`Granted`], which prints what a person needs and nothing else.
///
/// [`Endpoint`]: crate::provisioner::managed::aws::query::Endpoint
#[derive(Clone, PartialEq, Eq)]
pub struct Grant {
    /// What this account is called here — the name that goes into a machine's
    /// handle, so a row says which account it belongs to.
    pub name: String,
    /// Which cloud.
    pub substrate: String,
    /// Where the customer's machines are.
    pub region: String,
    /// The role Aura assumes. Public by nature: an ARN names a role, and knowing
    /// it gets nobody anything without both the trust policy and the id below.
    pub role_arn: String,
    /// The value Aura must present when it assumes the role, which the customer
    /// put in the role's trust policy. It is what makes the role Aura's to
    /// assume and nobody else's — the standing defence against a third party
    /// being talked into acting on an account it has no business in.
    pub external_id: String,
}

impl Grant {
    /// The account the role lives in, read out of its own ARN.
    ///
    /// Shown rather than stored: a second field for it is a second thing to keep
    /// in step with the ARN, and the ARN is the one the request is actually made
    /// against. A customer checking which account they granted is checking the
    /// one Aura will use.
    pub fn account(&self) -> &str {
        self.role_arn.split(':').nth(4).unwrap_or("")
    }
}

/// The file as written, before anything is checked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredGrants {
    #[serde(default)]
    pub grants: Vec<StoredGrant>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredGrant {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub substrate: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub role_arn: Option<String>,
    #[serde(default)]
    pub external_id: Option<String>,
}

/// What we found when we looked for grants.
///
/// Three answers rather than two, for the reason the managed arm's settings give:
/// "nobody has granted anything" and "somebody granted something and got it
/// wrong" send a person to different places, and folding them together hides
/// every typo behind "not available here".
pub enum Granted {
    /// Nobody has granted anything on this install.
    Absent,
    /// Something is written down and does not add up, and what is wrong with it.
    Broken(String),
    Ready(Vec<Grant>),
}

impl std::fmt::Debug for Granted {
    /// Hand-written so a `{:?}` — in a test failure, in a log line somebody adds
    /// next year — can never print an external id. What a person needs from one
    /// of these is which accounts are set up, and that is what it says.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Granted::Absent => f.write_str("Granted::Absent"),
            Granted::Broken(why) => write!(f, "Granted::Broken({why:?})"),
            Granted::Ready(grants) => {
                let named: Vec<&str> = grants.iter().map(|g| g.name.as_str()).collect();
                write!(f, "Granted::Ready({named:?})")
            }
        }
    }
}

/// Where the grants are kept, beside the managed setup and the machine book.
fn grants_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::cloud_session_sync::aura_dir()?.join("cloud-grants.json"))
}

/// Read what has been granted, if anything.
pub fn configured() -> Granted {
    let path = match grants_path() {
        Ok(p) => p,
        // No home directory to look in is not a broken grant — it is no grant.
        Err(_) => return Granted::Absent,
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => from_json(&raw),
        Err(_) => Granted::Absent,
    }
}

/// The grant of this name, or the reason there isn't one.
///
/// A sentence rather than an `Option`, because every caller is about to tell
/// somebody why a machine they can see will not sleep, and "no" on its own is
/// the answer that sends people to a search engine.
pub fn find(name: &str) -> Result<Grant, String> {
    let name = name.trim();
    match configured() {
        Granted::Absent => Err(format!(
            "this laptop has no record of the account {name:?} — the machine is marked as one \
             Aura may stop, and nothing here says how to reach that account"
        )),
        Granted::Broken(why) => Err(why),
        Granted::Ready(grants) => grants
            .into_iter()
            .find(|g| g.name == name)
            .ok_or_else(|| {
                format!(
                    "the machine is marked as belonging to the account {name:?}, and no account \
                     of that name is set up on this laptop"
                )
            }),
    }
}

/// The same decision, from the file's text — so every rule below can be proved
/// without writing into somebody's home directory.
pub fn from_json(raw: &str) -> Granted {
    // A blank file is somebody who made the file and has not filled it in.
    if raw.trim().is_empty() {
        return Granted::Absent;
    }
    let stored: StoredGrants = match serde_json::from_str(raw) {
        Ok(s) => s,
        Err(e) => {
            return Granted::Broken(format!(
                "the file listing the cloud accounts Aura may act in can't be read: {e}"
            ))
        }
    };
    // A file holding an empty list is the same state as no file: nobody has
    // granted anything. Reporting it as broken would send somebody looking for a
    // mistake in a file that is merely empty.
    if stored.grants.is_empty() {
        return Granted::Absent;
    }
    let mut ready = Vec::with_capacity(stored.grants.len());
    for one in stored.grants {
        match resolve(one) {
            Ok(grant) => ready.push(grant),
            Err(why) => return Granted::Broken(why),
        }
    }
    // Two accounts under one name would make a machine's handle ambiguous, and
    // the request would go to whichever came first in the file. That is a stop
    // sent to the wrong account, which is the failure the name exists to
    // prevent.
    for (n, grant) in ready.iter().enumerate() {
        if ready.iter().skip(n + 1).any(|other| other.name == grant.name) {
            return Granted::Broken(format!(
                "two cloud accounts are both called {:?} — a machine marked with that name \
                 could be stopped in either one",
                grant.name
            ));
        }
    }
    Granted::Ready(ready)
}

/// Turn one written grant into a usable one, or say what is missing.
///
/// Every message names the field as the file spells it, because the person
/// reading it has the file open.
fn resolve(stored: StoredGrant) -> Result<Grant, String> {
    let name = required(stored.name, "name")?;
    check_name(&name)?;
    let substrate = optional(stored.substrate).unwrap_or_else(|| AWS_EC2.to_string());
    if substrate != AWS_EC2 {
        return Err(format!(
            "the account {name:?} names a cloud called {substrate:?}, and the only one Aura \
             can stop and start machines in is {AWS_EC2:?}"
        ));
    }
    let role_arn = required(stored.role_arn, "role_arn")?;
    check_role_arn(&name, &role_arn)?;
    let external_id = required(stored.external_id, "external_id")?;
    check_external_id(&name, &external_id)?;
    Ok(Grant {
        name,
        substrate,
        region: required(stored.region, "region")?,
        role_arn,
        external_id,
    })
}

fn optional(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn required(value: Option<String>, field: &str) -> Result<String, String> {
    optional(value).ok_or_else(|| {
        format!(
            "one of the cloud accounts has no {field:?} — Aura can't act in an account without it"
        )
    })
}

/// Refuse a name that could not survive being written onto a machine's row.
///
/// The name is not decoration: it is half of the handle
/// (`grant:<name>/i-0abc…`), and the handle is split at the first `/`. A name
/// with a slash in it would produce a row that reads back as a different account
/// and a truncated machine, which is the one shape of mistake here that still
/// looks like a valid request.
fn check_name(name: &str) -> Result<(), String> {
    let usable = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(format!(
            "the account name {name:?} has characters Aura can't write onto a machine's record \
             — letters, digits, dashes, dots and underscores only"
        ))
    }
}

/// Refuse anything that is not the ARN of a role.
///
/// Checked here rather than left to the cloud because the failure the cloud
/// gives back is a signature error about a malformed request, which names none
/// of this — and because a user ARN pasted in place of a role's would be a
/// request to assume a person.
fn check_role_arn(name: &str, arn: &str) -> Result<(), String> {
    let parts: Vec<&str> = arn.split(':').collect();
    let shaped = parts.len() >= 6
        && parts[0] == "arn"
        && parts[2] == "iam"
        && parts[5].starts_with("role/")
        && !parts[4].trim().is_empty();
    if shaped {
        Ok(())
    } else {
        Err(format!(
            "the account {name:?} has a \"role_arn\" that isn't the name of a role — it should \
             look like \"arn:aws:iam::<account>:role/<name>\""
        ))
    }
}

/// Refuse an external id that would not do the job it is there for.
///
/// It is the standing defence against Aura being talked into acting on an
/// account by somebody who merely knows the role's name. Short, guessable or
/// pasted with a line break in it, it is not a defence — and the customer will
/// never find that out, because everything keeps working right up until it
/// matters. The message never repeats the value.
fn check_external_id(name: &str, id: &str) -> Result<(), String> {
    let complaint = format!("the account {name:?} has an \"external_id\" that");
    if id.len() < EXTERNAL_ID_MIN_LEN {
        return Err(format!(
            "{complaint} is too short to be worth having — it is the one thing stopping somebody \
             else's Aura from asking for this role, so make it at least {EXTERNAL_ID_MIN_LEN} \
             characters and unguessable"
        ));
    }
    if id.len() > EXTERNAL_ID_MAX_LEN {
        return Err(format!("{complaint} is far too long to be an id"));
    }
    if id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{complaint} has spaces or line breaks in it"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grant with everything filled in. The values are invented — a
    /// documentation account number, and an id that is plainly a fixture.
    fn full() -> serde_json::Value {
        serde_json::json!({
            "grants": [{
                "name": "acme-eu",
                "substrate": AWS_EC2,
                "region": "eu-central-1",
                "role_arn": "arn:aws:iam::000000000000:role/AuraLifecycle",
                "external_id": "fixture-external-id-not-a-real-one",
            }]
        })
    }

    fn ready(v: serde_json::Value) -> Vec<Grant> {
        match from_json(&v.to_string()) {
            Granted::Ready(grants) => grants,
            other => panic!("expected a usable grant, got {other:?}"),
        }
    }

    fn broken(v: serde_json::Value) -> String {
        match from_json(&v.to_string()) {
            Granted::Broken(why) => why,
            other => panic!("expected a complaint, got {other:?}"),
        }
    }

    /// Change one field of the single grant in the fixture.
    fn with(field: &str, value: serde_json::Value) -> serde_json::Value {
        let mut v = full();
        v["grants"][0][field] = value;
        v
    }

    #[test]
    fn no_file_and_an_empty_list_both_mean_nobody_granted_anything() {
        // The shipping default, and the state every install is in. It must not
        // read as a mistake, because it is not one.
        assert!(matches!(from_json(""), Granted::Absent));
        assert!(matches!(from_json("  \n "), Granted::Absent));
        assert!(matches!(from_json(r#"{"grants":[]}"#), Granted::Absent));
        // And a file that is not a file is a different answer entirely.
        assert!(matches!(from_json("{ not json"), Granted::Broken(_)));
    }

    #[test]
    fn a_whole_grant_reads_back_with_the_account_it_names() {
        let grants = ready(full());
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].name, "acme-eu");
        assert_eq!(grants[0].region, "eu-central-1");
        // Read out of the ARN rather than stored beside it, so what a customer
        // is shown is the account the request is actually made against.
        assert_eq!(grants[0].account(), "000000000000");
    }

    #[test]
    fn a_missing_field_is_named_in_the_complaint() {
        for field in ["name", "region", "role_arn", "external_id"] {
            let mut v = full();
            v["grants"][0]
                .as_object_mut()
                .expect("an object")
                .remove(field);
            let why = broken(v);
            assert!(why.contains(field), "{field} was missing and the complaint was: {why}");
        }
    }

    #[test]
    fn the_cloud_is_assumed_rather_than_demanded_and_a_wrong_one_is_refused_by_name() {
        // Left out, it is the one cloud there is a driver for. Named as
        // something else, it must not fall through to that driver — a stop sent
        // to the wrong cloud is a request against an account nobody chose.
        let mut v = full();
        v["grants"][0].as_object_mut().expect("an object").remove("substrate");
        assert_eq!(ready(v)[0].substrate, AWS_EC2);

        let why = broken(with("substrate", serde_json::json!("fly")));
        assert!(why.contains("fly"), "{why}");
        assert!(why.contains(AWS_EC2), "{why}");
    }

    #[test]
    fn a_name_that_could_not_survive_a_machines_record_is_refused() {
        // The sharp one is the slash: a handle is split at the first, so
        // "acme/eu" would read back as the account "acme" and a machine called
        // "eu/i-0abc…" — a request that still looks valid and names nothing
        // anybody meant.
        for bad in ["acme/eu", "acme eu", "acme:eu", "acme\neu"] {
            let why = broken(with("name", serde_json::json!(bad)));
            assert!(why.contains("letters, digits"), "{bad:?} was accepted: {why}");
        }
        for good in ["acme-eu", "acme_eu", "acme.eu", "Acme2"] {
            assert_eq!(ready(with("name", serde_json::json!(good)))[0].name, good);
        }
    }

    #[test]
    fn something_that_is_not_a_roles_name_is_refused_before_a_request_is_signed() {
        // A user ARN pasted in place of a role's is a request to assume a
        // person, and the cloud's own refusal is a signature error that names
        // none of this.
        for bad in [
            "AuraLifecycle",
            "arn:aws:iam::000000000000:user/mo",
            "arn:aws:ec2:eu-central-1:000000000000:instance/i-0abc1234",
            "arn:aws:iam:::role/AuraLifecycle",
        ] {
            let why = broken(with("role_arn", serde_json::json!(bad)));
            assert!(why.contains("name of a role"), "{bad:?} was accepted: {why}");
        }
        // The ordinary shape, and the one with a path in it that AWS also
        // issues — refusing that would refuse a role somebody legitimately made.
        for good in [
            "arn:aws:iam::000000000000:role/AuraLifecycle",
            "arn:aws:iam::000000000000:role/team/AuraLifecycle",
        ] {
            assert_eq!(ready(with("role_arn", serde_json::json!(good)))[0].role_arn, good);
        }
    }

    #[test]
    fn a_weak_external_id_is_refused_while_somebody_can_still_fix_it() {
        // It is the one thing stopping another Aura install from asking for this
        // role. Too short, it is not a defence — and nothing would ever go wrong
        // in a way the customer could see.
        let why = broken(with("external_id", serde_json::json!("abc")));
        assert!(why.contains("too short"), "{why}");
        // And the complaint never repeats the value, because complaints end up
        // in logs and screenshots.
        assert!(!why.contains("abc"), "the complaint quoted the id back: {why}");

        let why = broken(with("external_id", serde_json::json!("fixture-id-with a space")));
        assert!(why.contains("spaces or line breaks"), "{why}");
        assert!(broken(with("external_id", serde_json::json!("x".repeat(EXTERNAL_ID_MAX_LEN + 1))))
            .contains("far too long"));
    }

    #[test]
    fn two_accounts_of_one_name_are_refused_rather_than_raced() {
        // A machine's handle names an account by name. Two of them and the
        // request goes to whichever came first in the file, which is a stop
        // against the wrong company.
        let mut v = full();
        let twin = v["grants"][0].clone();
        v["grants"].as_array_mut().expect("a list").push(twin);
        let why = broken(v);
        assert!(why.contains("acme-eu"), "{why}");
        assert!(why.contains("stopped in either one"), "{why}");
    }

    #[test]
    fn nothing_that_prints_a_grant_can_print_its_external_id() {
        // The rule the missing `Debug` on `Grant` exists to keep, checked at the
        // one place a grant is printable at all. A `{:?}` in a test failure or a
        // log line somebody adds next year must not carry the secret with it.
        let grants = ready(full());
        let printed = format!("{:?}", Granted::Ready(grants.clone()));
        assert!(printed.contains("acme-eu"), "{printed}");
        assert!(
            !printed.contains(&grants[0].external_id),
            "printing the configured accounts printed a shared secret: {printed}"
        );
    }
}
