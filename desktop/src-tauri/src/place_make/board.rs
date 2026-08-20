//! Putting a machine Aura made onto the org's board.
//!
//! A box that exists in a cloud account and nowhere else is not a place. What
//! makes it one is the row in the org's runner registry — that row is what
//! every member's places list reads, it is what carries the address so somebody
//! else's laptop can dial it, and it is what the server's entitlement check
//! hangs off. Until this call lands, the admin has bought a machine and given
//! their team nothing.
//!
//! It is also the real gate. `POST /api/v2/runners` goes through
//! `runners::require_org_admin`, which reads the caller's role out of the
//! database at the moment of the request. [`super::authority`] asks the same
//! question first so we do not spend money on a request that is going to be
//! refused, but that is a courtesy; this is the check that counts, and a member
//! who was promoted-then-demoted between the two gets refused here.
//!
//! ## The address goes up; the key does not
//!
//! All four address columns are sent, and `key_ref` is a reference — for an
//! Aura-made box, `managed:<id>`, which names a key the server holds and the
//! member never sees. The server refuses anything that looks like key material
//! with a 400 (`runners::key_ref_rejection`) and a CHECK constraint catches what
//! never went through the handler. Nothing in this module can produce key bytes
//! to send, because it only ever forwards what the provisioner put in
//! [`TargetAddress::key_ref`], and the managed driver puts a handle there.

use std::time::Duration;

use crate::cloud_org::OrgScoped;
use crate::provisioner::TargetAddress;

/// Registration mints a credential and creates a row, so it gets longer than a
/// read would — but not unbounded. A create that has not answered in half a
/// minute has left the admin looking at a machine that is running and unowned,
/// and the honest move then is to say so and tear it down rather than keep
/// waiting.
const TIMEOUT: Duration = Duration::from_secs(30);

/// What the box will run. One kind, the same default `aura runner register`
/// uses, because the box Aura makes is the box that CLI would have made and a
/// second opinion about the fleet's capabilities helps nobody.
const AGENT_KINDS: [&str; 1] = ["claude"];

/// A machine that is now a place.
pub struct Listed {
    /// The registry row's id — the place id every other surface holds.
    pub place_id: String,
    /// The one-time runner credential, minted here and recoverable nowhere.
    ///
    /// Carried out of this module for the same reason `runner_provision` carries
    /// it out of the BYO wizard's command: it is the same credential, from the
    /// same route, and the surface that arms a box already knows what to do with
    /// it. Dropping it would leave a place that can never take work without
    /// registering a *second* row for the same machine, which is a duplicate on
    /// everybody's board.
    pub runner_token: String,
}

/// Why a machine could not be listed.
///
/// The distinction that matters to the caller is whether the org has a row now.
/// A refusal means it does not, and the machine that was made for it has to go
/// back — see [`super::unmake`]. Anything else may have created a row we did not
/// get to read, and tearing down under that would orphan it.
pub struct NotListed {
    /// True when the server made no row: a refusal or a rejected request.
    pub definitely_refused: bool,
    pub said: String,
}

/// Register a made machine as an org place.
pub async fn list_it(
    origin: &str,
    token: &str,
    name: &str,
    address: &TargetAddress,
) -> Result<Listed, NotListed> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| NotListed {
            // Nothing was sent, so nothing was made.
            definitely_refused: true,
            said: format!("This build couldn't open a connection to Aura: {e}"),
        })?;

    let body = serde_json::json!({
        "name": name,
        "agent_kinds": AGENT_KINDS,
        "host": address.host,
        "ssh_user": address.ssh_user,
        "key_ref": address.key_ref,
        "repo_path": address.repo_path,
    });

    let resp = client
        .post(format!("{origin}/api/v2/runners"))
        .bearer_auth(token)
        .org_scoped()
        .json(&body)
        .send()
        .await
        .map_err(|e| NotListed {
            // A request that never got an answer may still have landed. Treating
            // that as a refusal would tear down a machine the org owns a row for.
            definitely_refused: false,
            said: format!("Aura didn't answer while adding the machine to your team: {e}"),
        })?;

    let status = resp.status();
    let said = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(refusal(status.as_u16(), &said));
    }
    read(&said).map_err(|said| NotListed {
        // A 200 we could not read means the row exists. We just cannot say what
        // its id is, which is a worse outcome than a refusal and must not be
        // compensated for by deleting somebody's machine.
        definitely_refused: false,
        said,
    })
}

/// Turn a status code into the sentence the admin should read.
///
/// The server answers a non-admin with a bare 403 and no body — deliberately,
/// since a gate that explains itself is a gate that enumerates roles. That
/// leaves this the only place the sentence can come from.
fn refusal(status: u16, body: &str) -> NotListed {
    let said = match status {
        401 => "Your Aura sign-in has expired. Sign in again and try once more.".to_string(),
        403 => "Aura wouldn't add the machine: only an owner or admin of this team can. \
                The machine has been removed."
            .to_string(),
        400 => format!(
            "Aura wouldn't accept the machine's details. {}",
            plainly(body)
        ),
        409 => "A machine with that name is already on your team's board. \
                Pick a different name."
            .to_string(),
        500..=599 => format!("Aura had a problem adding the machine. {}", plainly(body)),
        _ => format!("Aura answered {status} while adding the machine. {}", plainly(body)),
    };
    NotListed {
        // Every one of these is the server declining to write a row. A 5xx is
        // the arguable one, and it is grouped here because these handlers do
        // their INSERT last: a 500 is a failure to get that far.
        definitely_refused: true,
        said,
    }
}

/// The server's own words when it sent any, and nothing when it did not.
///
/// Servers answer these routes with `{"error": "..."}`, and the sentence inside
/// says what to fix where ours would only say that something went wrong. A body
/// that is not that shape — an HTML error page from something in front of the
/// server — is dropped rather than pasted at somebody.
fn plainly(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Read the create response.
///
/// Apart from the request so the shape is pinned by a test. Both fields are
/// required: a row with no id cannot be pointed at, and a create with no token
/// has minted a credential that reached nobody.
fn read(body: &str) -> Result<Listed, String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "Aura's answer didn't make sense.".to_string())?;
    let place_id = parsed
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Aura added the machine but didn't say which row it made.".to_string())?;
    let runner_token = parsed
        .get("token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Aura added the machine but didn't hand back its credential.".to_string()
        })?;
    Ok(Listed {
        place_id: place_id.to_string(),
        runner_token: runner_token.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CreateResponse` flattens a `RunnerView`, which flattens a `Runner` —
    /// so the id sits at the top level next to the token rather than nested.
    /// This is the envelope, trimmed to what is read.
    const CREATED: &str = r#"{
      "id":"11111111-2222-3333-4444-555555555555",
      "org_id":"aaaaaaaa-0000-0000-0000-000000000000",
      "name":"design-box","agent_kinds":["claude"],"status":"offline",
      "host":"box.internal","ssh_user":"aura","key_ref":"managed:abc","repo_path":null,
      "online":false,
      "token":"placeholder-not-a-credential",
      "message":"Save this token now — it will not be shown again."
    }"#;

    #[test]
    fn a_created_row_gives_up_its_id_and_its_credential() {
        let listed = read(CREATED).expect("the real envelope reads");
        assert_eq!(listed.place_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(listed.runner_token, "placeholder-not-a-credential");
    }

    /// The two halves are both load-bearing and neither may be assumed. A row
    /// with no id is a place nothing can point at; a token that never arrived
    /// is a credential that exists only as a hash on the server.
    #[test]
    fn half_an_answer_is_not_a_listing() {
        assert!(read(r#"{"token":"t"}"#).is_err(), "no id");
        assert!(read(r#"{"id":"r-1"}"#).is_err(), "no token");
        assert!(read(r#"{"id":"  ","token":"t"}"#).is_err(), "blank id");
        assert!(read("<html>502</html>").is_err());
    }

    /// The one refusal this flow exists to handle. A non-admin gets a bare 403,
    /// so the sentence has to come from here, and it has to say the machine is
    /// gone — otherwise the admin goes looking for a box to clean up that Aura
    /// already removed.
    #[test]
    fn a_non_admin_is_told_why_and_told_the_machine_went_back() {
        let refused = refusal(403, "");
        assert!(refused.definitely_refused);
        assert!(refused.said.contains("owner or admin"), "{}", refused.said);
        assert!(refused.said.contains("removed"), "{}", refused.said);
    }

    /// A refusal decides whether a machine gets torn down, so the flag is the
    /// most dangerous value in this file. Every answer the server gives means
    /// "no row was written"; the ones that do NOT are the ones where we never
    /// heard back, and those are built at the call site, not here.
    #[test]
    fn every_answer_from_the_server_means_no_row_was_written() {
        for status in [400, 401, 403, 409, 418, 500, 503] {
            assert!(
                refusal(status, "").definitely_refused,
                "{status} left the caller unsure"
            );
        }
    }

    /// A 400 is the server telling us the details are wrong — which detail is
    /// in its body, and repeating our own vague version of it would send an
    /// admin to guess.
    #[test]
    fn the_servers_own_sentence_survives() {
        let said = refusal(400, r#"{"error":"key_ref must not contain key material"}"#).said;
        assert!(said.contains("key_ref must not contain key material"), "{said}");
    }

    /// An error page from something in front of the server is not a sentence
    /// for a person, and pasting HTML at somebody is worse than saying less.
    #[test]
    fn a_body_that_isnt_the_servers_is_dropped_rather_than_pasted() {
        assert_eq!(plainly("<html><body>502 Bad Gateway</body></html>"), "");
        assert_eq!(plainly(""), "");
        assert_eq!(plainly(r#"{"error":"   "}"#), "");
        let said = refusal(500, "<html>502</html>").said;
        assert!(!said.contains("<html>"), "{said}");
    }

    /// One kind, and it is the CLI's. If these ever part company, a box made in
    /// the app and a box registered from a terminal advertise different
    /// capabilities and the crew board sends them different work.
    #[test]
    fn the_box_advertises_what_the_cli_would_advertise() {
        assert_eq!(AGENT_KINDS, ["claude"]);
    }
}
