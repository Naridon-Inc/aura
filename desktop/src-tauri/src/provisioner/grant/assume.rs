//! Asking a customer's account for the role they granted, and holding what it
//! hands back for as long as it is good for.
//!
//! This is the moment the whole arm turns on. Everything else here is a name, a
//! shape or a document; this is the one call that crosses into somebody else's
//! account, and what comes back is a set of credentials that expire — good for
//! exactly the three actions in [`super::permissions`] and for fifteen minutes.
//!
//! ## What makes the role Aura's to assume, and nobody else's
//!
//! Two halves, and the customer holds both. The role's trust policy names Aura's
//! own principal, so a stranger cannot ask for it; and it requires an **external
//! id** that Aura must present, so a stranger who has somehow talked Aura into
//! making the request on their behalf still cannot, because they do not know the
//! id. That second half is the standing defence against the confused deputy —
//! the failure where the party with the permission is persuaded to spend it for
//! somebody who has none — and it is why [`super::settings`] refuses a weak one
//! rather than letting the customer find out the hard way.
//!
//! The credential doing the asking is the one this process was already given,
//! the same one the managed arm spends on Aura's own account. A desktop with
//! none cannot assume anything, and says so in a sentence rather than signing an
//! empty request and reporting the 403 it gets back.
//!
//! ## Why anything is held at all
//!
//! A wake is two calls to the customer's account and a sleep sweep is one per
//! machine. Assuming the role afresh for each would triple the traffic against
//! somebody else's account and put a line in their audit log for every poll,
//! which is a poor way to behave in a house you were let into. So the answer is
//! kept until shortly before it expires and then asked for again. Nothing is
//! written to disk: these are credentials, they are short-lived on purpose, and
//! a copy that outlived the process would be a copy that outlived its usefulness.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::aws_sigv4::AwsCredentials;
use crate::provisioner::managed::aws::parse;
use crate::provisioner::managed::aws::query::{credentials_from_environment, Endpoint, Query};

use super::settings::Grant;

/// The name SigV4 signs an STS request under.
const STS_SERVICE: &str = "sts";

/// STS's own API version, which is not EC2's. It has been this for the life of
/// the service, and the shapes read below are this version's.
const STS_API_VERSION: &str = "2011-06-15";

/// What the session is called in the customer's own audit log.
///
/// A constant and a plain word on purpose. Every action Aura takes in their
/// account is attributed to this name in their CloudTrail, so a customer
/// wondering who stopped a machine at 2am gets an answer they can read rather
/// than a random id.
const SESSION_NAME: &str = "aura-lifecycle";

/// How long a session is asked for, in seconds.
///
/// AWS's own minimum, and deliberately so: a role's `MaxSessionDuration` can
/// refuse a long ask and cannot refuse this one, so a customer who hardened
/// their role does not find that Aura stopped working. Fifteen minutes is also
/// far more than any single sleep or wake needs.
const SESSION_SECONDS: u32 = 900;

/// How near the end of a session to stop using it, in seconds.
///
/// A request signed a second before expiry arrives after it, and the refusal
/// looks like a permissions problem rather than a clock. Renewing a minute early
/// costs one extra call an hour and removes the whole class.
const REFRESH_MARGIN_SECONDS: i64 = 60;

/// A set of temporary credentials, and the moment they stop working.
struct Lease {
    creds: AwsCredentials,
    /// Unix seconds.
    until: i64,
}

/// Credentials good for acting in the account this grant names.
pub(super) async fn credentials_for(grant: &Grant) -> Result<AwsCredentials, String> {
    if let Some(held) = still_good(&grant.name) {
        return Ok(held);
    }
    let ours = credentials_from_environment().map_err(|_| {
        format!(
            "Aura has no cloud credentials of its own on this computer, so there is nothing for \
             the account {:?} to recognise. The account is set up correctly; this copy of Aura \
             is the half that isn't.",
            grant.name
        )
    })?;
    let sts = Endpoint::for_service(STS_SERVICE, &grant.region, host_for(&grant.region), ours);
    let answer = sts.call(assume(grant)).await.map_err(|refused| {
        // The account's own sentence, kept whole. It is the one that says
        // whether the trust policy names the wrong principal, the external id
        // does not match, or the role was deleted — and no paraphrase of ours
        // would tell those three apart.
        format!(
            "the account {:?} didn't let Aura in: {refused}",
            grant.name
        )
    })?;
    let lease = read_lease(&answer, &grant.name)?;
    let creds = lease.creds.clone();
    if let Ok(mut held) = leases().lock() {
        held.insert(grant.name.clone(), lease);
    }
    Ok(creds)
}

/// The request that asks for the role.
fn assume(grant: &Grant) -> Query {
    Query::action("AssumeRole")
        .version(STS_API_VERSION)
        .set("RoleArn", grant.role_arn.as_str())
        .set("RoleSessionName", SESSION_NAME)
        // The half a stranger cannot supply. Without it the request is simply a
        // request for a role by name, which is a thing anybody who read the ARN
        // could make.
        .set("ExternalId", grant.external_id.as_str())
        .set("DurationSeconds", SESSION_SECONDS.to_string())
}

/// Which host serves STS in a region.
///
/// The regional endpoint rather than the global one. Two reasons and both are
/// the customer's: the request is then made in the region their machines are in
/// and lands in the audit log they are already watching, and a regional endpoint
/// keeps working when the global one is having an afternoon.
fn host_for(region: &str) -> String {
    format!("sts.{region}.amazonaws.com")
}

/// Read the session out of the account's answer.
fn read_lease(xml: &str, name: &str) -> Result<Lease, String> {
    let complaint = format!("the account {name:?} answered Aura's request for the role");
    let Some(held) = parse::element(xml, "Credentials") else {
        return Err(format!("{complaint} and sent nothing to act with"));
    };
    let (Some(access_key_id), Some(secret_access_key)) = (
        parse::text(held, "AccessKeyId"),
        parse::text(held, "SecretAccessKey"),
    ) else {
        return Err(format!("{complaint} in a shape Aura couldn't read"));
    };
    // Assumed-role credentials always carry one, and a request signed without it
    // is refused with a message about the signature. Refusing here instead means
    // the sentence names the thing that is actually missing.
    let Some(session_token) = parse::text(held, "SessionToken") else {
        return Err(format!("{complaint} without the token that goes with it"));
    };
    Ok(Lease {
        until: expiry(parse::text(held, "Expiration").as_deref()),
        creds: AwsCredentials {
            access_key_id,
            secret_access_key,
            session_token: Some(session_token),
        },
    })
}

/// When the account says the session ends, or when we asked for it to.
///
/// The account's own answer is preferred because it is the one that decides.
/// The fallback is what we asked for, which can never be longer — so an answer
/// we cannot read produces a session held for too short a time rather than one
/// held past the point it works.
fn expiry(said: Option<&str>) -> i64 {
    said.and_then(|when| chrono::DateTime::parse_from_rfc3339(when).ok())
        .map(|when| when.timestamp())
        .unwrap_or_else(|| now() + i64::from(SESSION_SECONDS))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The sessions in hand, by the account they are for.
///
/// In memory and nowhere else. These are credentials; they are short-lived on
/// purpose, and a copy on disk would be a copy that outlives both the process
/// and its own usefulness.
fn leases() -> &'static Mutex<HashMap<String, Lease>> {
    static LEASES: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The session for this account, if there is one with time left on it.
fn still_good(name: &str) -> Option<AwsCredentials> {
    let held = leases().lock().ok()?;
    let lease = held.get(name)?;
    (lease.until - now() > REFRESH_MARGIN_SECONDS).then(|| lease.creds.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grant with everything filled in. The account number is a documentation
    /// one and the id is plainly a fixture.
    fn grant(name: &str) -> Grant {
        Grant {
            name: name.to_string(),
            substrate: super::super::settings::AWS_EC2.to_string(),
            region: "eu-central-1".into(),
            role_arn: "arn:aws:iam::000000000000:role/AuraLifecycle".into(),
            external_id: "fixture-external-id-not-a-real-one".into(),
        }
    }

    /// What STS answers with, trimmed to what is read.
    fn answered(expires: &str) -> String {
        format!(
            "<AssumeRoleResponse><AssumeRoleResult><Credentials>\
             <AccessKeyId>ASIAFIXTURE0000000</AccessKeyId>\
             <SecretAccessKey>fixture-secret-not-a-real-one</SecretAccessKey>\
             <SessionToken>fixture-session-token</SessionToken>\
             <Expiration>{expires}</Expiration>\
             </Credentials></AssumeRoleResult></AssumeRoleResponse>"
        )
    }

    #[test]
    fn the_request_presents_the_thing_a_stranger_could_not_know() {
        // The whole defence. Without the external id the request is a request
        // for a role by name, which anybody who read the ARN could make.
        let body = assume(&grant("acme-eu")).body();
        assert!(body.contains("Action=AssumeRole"), "{body}");
        assert!(body.contains("ExternalId=fixture-external-id-not-a-real-one"), "{body}");
        assert!(
            body.contains("RoleArn=arn%3Aaws%3Aiam%3A%3A000000000000%3Arole%2FAuraLifecycle"),
            "{body}"
        );
    }

    #[test]
    fn the_session_is_named_so_the_customers_own_log_says_who_did_it() {
        // A customer wondering who stopped a machine at 2am reads this name in
        // their own audit log. A generated id would be an answer they cannot use.
        let body = assume(&grant("acme-eu")).body();
        assert!(body.contains(&format!("RoleSessionName={SESSION_NAME}")), "{body}");
    }

    #[test]
    fn the_shortest_session_aws_allows_is_the_one_asked_for() {
        // A role's own maximum can refuse a long ask and cannot refuse this one,
        // so a customer who hardened their role does not find Aura has stopped
        // working. Fifteen minutes is far more than any sleep or wake needs.
        assert_eq!(SESSION_SECONDS, 900);
        let body = assume(&grant("acme-eu")).body();
        assert!(body.contains("DurationSeconds=900"), "{body}");
    }

    #[test]
    fn the_request_goes_to_the_customers_own_region_and_under_stss_own_version() {
        // Read under EC2's version, the answer comes back in shapes this file
        // does not know, and the failure lands nowhere near here.
        assert_eq!(host_for("eu-central-1"), "sts.eu-central-1.amazonaws.com");
        let body = assume(&grant("acme-eu")).body();
        assert!(body.contains(&format!("Version={STS_API_VERSION}")), "{body}");
    }

    #[test]
    fn a_whole_answer_becomes_a_session_with_an_end_on_it() {
        let lease = read_lease(&answered("2030-01-01T00:15:00Z"), "acme-eu").expect("a session");
        assert_eq!(lease.creds.access_key_id, "ASIAFIXTURE0000000");
        assert_eq!(lease.creds.session_token.as_deref(), Some("fixture-session-token"));
        // The account's own answer decides, because it is the one that does.
        assert_eq!(lease.until, 1_893_456_900);
    }

    #[test]
    fn an_answer_with_no_end_on_it_is_held_for_no_longer_than_we_asked() {
        // The fallback can never be longer than the ask, so an answer we cannot
        // read produces a session held too briefly rather than one used past the
        // point it works — and the second of those is a refusal that looks like
        // a permissions problem.
        let lease = read_lease(&answered("the day after tomorrow"), "acme-eu").expect("a session");
        assert!(lease.until <= now() + i64::from(SESSION_SECONDS));
        assert!(lease.until > now());
    }

    #[test]
    fn half_an_answer_is_refused_by_the_part_that_is_missing() {
        // Each of these would otherwise be signed into a request and refused
        // with a message about signatures, which names none of it.
        for (broken, expected) in [
            ("<AssumeRoleResponse/>", "sent nothing to act with"),
            (
                "<Credentials><AccessKeyId>ASIAFIXTURE0000000</AccessKeyId></Credentials>",
                "a shape Aura couldn't read",
            ),
            (
                "<Credentials><AccessKeyId>ASIAFIXTURE0000000</AccessKeyId>\
                 <SecretAccessKey>fixture-secret-not-a-real-one</SecretAccessKey></Credentials>",
                "without the token that goes with it",
            ),
        ] {
            let why = read_lease(broken, "acme-eu").err().expect("a complaint");
            assert!(why.contains(expected), "{broken}\ngave: {why}");
            assert!(why.contains("acme-eu"), "{why}");
        }
    }

    #[test]
    fn a_session_is_reused_until_it_is_nearly_over_and_then_it_is_not() {
        // The reason anything is held: a wake is two calls and a sleep sweep is
        // one per machine, and asking for the role each time would put a line in
        // somebody else's audit log for every poll.
        //
        // The names are unique to this test because the sessions in hand are
        // process-wide, exactly as they are in a running app.
        let good = read_lease(&answered("2030-01-01T00:15:00Z"), "held").expect("a session");
        leases().lock().expect("the sessions in hand").insert("held-fresh".into(), good);
        assert!(still_good("held-fresh").is_some());

        let nearly = Lease {
            creds: AwsCredentials {
                access_key_id: "ASIAFIXTURE0000000".into(),
                secret_access_key: "fixture-secret-not-a-real-one".into(),
                session_token: Some("fixture-session-token".into()),
            },
            // Inside the margin. A request signed now would arrive after it
            // expires, and be refused for what looks like a permissions problem.
            until: now() + REFRESH_MARGIN_SECONDS - 1,
        };
        leases().lock().expect("the sessions in hand").insert("held-stale".into(), nearly);
        assert!(still_good("held-stale").is_none());

        // And an account nobody has asked about has nothing in hand.
        assert!(still_good("held-never").is_none());
    }
}
