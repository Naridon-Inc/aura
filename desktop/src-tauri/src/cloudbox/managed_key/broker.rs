//! Asking Aura for a connection, and spending it one signature at a time.
//!
//! Two calls, and neither of them is "give me the key":
//!
//!   * `POST /api/v2/places/{place_id}/connection` — an address, the public half
//!     of the key the box already trusts, and a short-lived grant.
//!   * `POST /api/v2/places/connection/sign` — one signature, bought with that
//!     grant.
//!
//! Everything this laptop ever holds is in [`Connection`], and none of it is
//! secret in the way a key is: the public blob is what the box publishes about
//! itself, and the grant is a few minutes of bounded signing against one machine
//! as one member, revocable from the other side while it is in use.
//!
//! ## Nothing here is written down
//!
//! A [`Connection`] lives in memory for as long as the process does and is never
//! serialised to disk — not to the machine book, not to a cache, not to a log
//! line. That is the whole difference between this and a key file, so it is not
//! left to habit: [`Connection`] deliberately does not derive `Serialize`, which
//! makes writing one out a compile error rather than a decision somebody makes
//! at four in the afternoon.

use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

use crate::cloud_org::OrgScoped;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// Somebody is waiting on a terminal opening, so both calls are on a short
/// leash. Ten seconds is generous for a request that does no work beyond a row
/// lookup and a signature, and short enough that a cloud having a bad minute
/// shows up as a named failure rather than as a machine that hangs.
const TIMEOUT: Duration = Duration::from_secs(10);

/// What the far side needs to authenticate, and nothing it could reuse.
///
/// No `Serialize`, on purpose — see the module note.
#[derive(Debug, Clone)]
pub struct Connection {
    /// The place this opens, as the registry knows it.
    pub place_id: String,
    /// The public half, in the encoding the agent protocol hands over: this is
    /// what the box has in its `authorized_keys`, and it is public.
    pub public_blob: Vec<u8>,
    /// What to call the key when the far side asks what we have. A name, so a
    /// person reading a verbose log can tell which agent answered.
    pub comment: String,
    /// The grant. Short-lived, use-capped, and bound to one place and one
    /// member — see the server's `places::custody::grants`.
    pub grant: String,
    /// Where to spend it. Built from the origin this laptop is signed in to and
    /// the path the answer named, never from a URL the answer chose.
    pub sign_url: String,
    /// How many signatures are left on it, as far as this side knows. Counted
    /// down locally so a connection that has run out is renewed before it is
    /// asked, rather than after a failed authentication the member sees.
    pub signatures_left: i32,
}

/// The answer shape, as the server sends it. Only the fields this side uses —
/// a field added later arrives without a change here.
#[derive(Debug, Deserialize)]
struct Brokered {
    key_ref: String,
    public_key: String,
    grant: String,
    sign_path: String,
    signatures_left: i32,
}

/// The server's named refusal. Carried through verbatim rather than replaced
/// with "couldn't open the place": each `reason` has a different person who can
/// do something about it, and flattening them is how a member ends up
/// re-running a wizard because an admin has not granted them cloud.
#[derive(Debug, Deserialize)]
struct NoConnection {
    reason: String,
    detail: String,
}

/// Ask Aura for a connection to a place, by the name the board knows it as.
///
/// The board lookup is not incidental: a machine row on this laptop is matched
/// to a registry row by name everywhere else in the app, and inventing a second
/// mapping here is how the two drift into disagreeing about which box is which.
/// An ambiguous name is refused rather than guessed — picking one of two boxes
/// called `builder` would open a terminal on the wrong machine and look like it
/// worked.
pub async fn connect(machine_name: &str) -> Result<Connection, String> {
    let place_id = place_id_for(machine_name).await?;
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds)
        .ok_or_else(|| "Sign in to Aura to open a machine Aura is looking after.".to_string())?;
    let origin = cloud_origin(&creds);

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("this laptop couldn't open a connection: {e}"))?;

    let resp = client
        .post(format!("{origin}/api/v2/places/{place_id}/connection"))
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("Aura didn't answer about {machine_name}: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(refusal(machine_name, status, &body));
    }
    let answer: Brokered = serde_json::from_str(&body)
        .map_err(|e| format!("Aura's answer about {machine_name} didn't make sense: {e}"))?;

    Ok(Connection {
        place_id,
        public_blob: public_blob(&answer.public_key)?,
        comment: key_comment(&answer.public_key, &answer.key_ref),
        grant: answer.grant,
        sign_url: sign_url(&origin, &answer.sign_path)?,
        signatures_left: answer.signatures_left,
    })
}

/// Buy one signature.
///
/// The blob goes up as base64 and comes back as base64, because it is arbitrary
/// bytes on both legs and a JSON string is not. Nothing on this side looks
/// inside it in either direction.
pub async fn sign(connection: &Connection, blob: &[u8]) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("this laptop couldn't open a connection: {e}"))?;

    let resp = client
        .post(&connection.sign_url)
        // No bearer token: the grant IS the credential on this call, and it is
        // the only one the far side needs. Sending the member's session as well
        // would put a long-lived credential on the hot path of every
        // authentication for no gain.
        .org_scoped()
        .json(&serde_json::json!({
            "grant": connection.grant,
            "blob": base64::engine::general_purpose::STANDARD.encode(blob),
        }))
        .send()
        .await
        .map_err(|e| format!("Aura didn't answer the signing request: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 401 {
        // The grant is expired, spent or revoked. The caller renews and tries
        // once more; saying which of the three it was is something the server
        // deliberately does not tell anybody, including us.
        return Err(SPENT.to_string());
    }
    if status != 200 {
        return Err(refusal("this machine", status, &body));
    }

    #[derive(Deserialize)]
    struct Signed {
        signature: String,
    }
    let signed: Signed = serde_json::from_str(&body)
        .map_err(|e| format!("Aura's signature didn't make sense: {e}"))?;
    base64::engine::general_purpose::STANDARD
        .decode(signed.signature.trim())
        .map_err(|e| format!("Aura's signature didn't decode: {e}"))
}

/// What [`sign`] says when the grant is no longer live. Matched on by the agent
/// to decide whether renewing is worth a try, so it is a constant rather than a
/// sentence somebody re-words.
pub const SPENT: &str = "that connection grant is no longer live";

/// The registry id behind a board name.
///
/// Reuses the board read the rest of the app already does, rather than adding a
/// second one — `cloud_runners` is already narrowed to the org being acted as,
/// which is exactly the narrowing this needs and would otherwise be re-derived.
async fn place_id_for(machine_name: &str) -> Result<String, String> {
    let wanted = machine_name.trim();
    let board = crate::cmd_cloud_runners::cloud_runners().await?;
    let mut named: Vec<&str> = board
        .iter()
        .filter(|r| r.name.trim() == wanted)
        .map(|r| r.id.as_str())
        .collect();
    match named.len() {
        1 => Ok(named.remove(0).to_string()),
        0 => Err(format!(
            "{wanted} isn't on your machine board, so Aura has nothing to open."
        )),
        n => Err(format!(
            "There are {n} machines called {wanted} on your board. Rename one so Aura \
             knows which to open."
        )),
    }
}

/// The public blob out of an `authorized_keys` line.
///
/// The line is `algorithm base64 comment`; the middle field is the blob, and it
/// is exactly what the agent protocol hands the far side. Decoding it here
/// rather than asking the server for a second, pre-decoded copy keeps one
/// encoding of the public half on the wire — two would eventually disagree, and
/// the disagreement shows up as a box refusing a key it is holding.
fn public_blob(line: &str) -> Result<Vec<u8>, String> {
    let body = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Aura sent a public key this laptop couldn't read.".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "Aura sent a public key this laptop couldn't read.".to_string())
}

/// What to call the key. The line's own comment when it has one, the reference
/// otherwise — either way a name, and never the key.
fn key_comment(line: &str, key_ref: &str) -> String {
    line.split_whitespace()
        .nth(2)
        .map(str::to_string)
        .unwrap_or_else(|| key_ref.to_string())
}

/// Where to spend a grant, built from the origin we are signed in to.
///
/// The path comes from the answer and the origin does not, which is the point:
/// an answer that could name its own host would be an answer that can send this
/// laptop's signing requests somewhere else. A path that is not a path is
/// refused rather than repaired.
fn sign_url(origin: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    // `//host/…` is a URL with the scheme left off — it looks like a path and is
    // read as an authority by anything that resolves it. Refused with the rest,
    // because a rule that catches `https://` and not this one is a rule that
    // catches the spelling nobody would try.
    if !path.starts_with('/') || path.starts_with("//") || path.contains("://") {
        return Err("Aura pointed the signing request somewhere unexpected.".to_string());
    }
    Ok(format!("{}{path}", origin.trim_end_matches('/')))
}

/// The server's refusal, in the words it chose, with the ones it did not choose
/// filled in for the two cases every HTTP client has to handle itself.
fn refusal(machine_name: &str, status: u16, body: &str) -> String {
    if let Ok(named) = serde_json::from_str::<NoConnection>(body) {
        return match named.reason.as_str() {
            "not_entitled" => format!(
                "You haven't been given cloud access in this org yet, so {machine_name} \
                 won't open. An owner or admin can grant it."
            ),
            "not_a_managed_place" => format!(
                "{machine_name}'s key belongs to whoever brought the box, so Aura has \
                 none to offer."
            ),
            _ => format!("Aura wouldn't open {machine_name}: {}", named.detail),
        };
    }
    format!("Aura wouldn't open {machine_name} (HTTP {status}).")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real public blob — `string(algorithm) string(pubkey)` — so the fixture
    /// is the encoding the server actually sends rather than a plausible-looking
    /// run of base64.
    fn blob() -> Vec<u8> {
        let mut out = vec![];
        for field in [b"ssh-ed25519".as_slice(), &[7u8; 32]] {
            out.extend_from_slice(&(field.len() as u32).to_be_bytes());
            out.extend_from_slice(field);
        }
        out
    }

    fn line(comment: &str) -> String {
        format!(
            "ssh-ed25519 {}{comment}",
            base64::engine::general_purpose::STANDARD.encode(blob())
        )
    }

    #[test]
    fn the_public_half_comes_off_the_line_the_box_holds() {
        let line = line(" aura-managed");
        let blob = public_blob(&line).expect("a blob");
        // The blob starts with the algorithm as a wire string, which is what
        // makes it the thing the agent protocol hands over rather than a raw
        // public key.
        assert_eq!(&blob[..4], &[0, 0, 0, 11]);
        assert_eq!(&blob[4..15], b"ssh-ed25519");
        assert_eq!(blob, self::blob());
        assert_eq!(key_comment(&line, "managed:x"), "aura-managed");
    }

    #[test]
    fn a_line_with_no_comment_is_named_by_its_reference() {
        let bare = line("");
        assert_eq!(key_comment(&bare, "managed:abc"), "managed:abc");
        assert_eq!(public_blob(&bare).expect("a blob"), blob());
    }

    #[test]
    fn rubbish_where_a_public_key_should_be_is_refused() {
        assert!(public_blob("").is_err());
        assert!(public_blob("ssh-ed25519").is_err());
        assert!(public_blob("ssh-ed25519 not-base64!!!").is_err());
    }

    #[test]
    fn the_signing_request_goes_to_the_origin_we_are_signed_in_to() {
        assert_eq!(
            sign_url("https://api.example", "/api/v2/places/connection/sign").expect("a url"),
            "https://api.example/api/v2/places/connection/sign"
        );
        assert_eq!(
            sign_url("https://api.example/", "/x").expect("a url"),
            "https://api.example/x"
        );
    }

    #[test]
    fn an_answer_cannot_redirect_this_laptops_signing_requests() {
        // The one thing a compromised or spoofed answer would want: point the
        // sign call at a host that collects what it is asked to sign.
        for elsewhere in [
            "https://elsewhere.example/collect",
            "//elsewhere.example/collect",
            "http://elsewhere.example",
            "api/v2/places/connection/sign",
            "",
        ] {
            assert!(
                sign_url("https://api.example", elsewhere).is_err(),
                "{elsewhere} was accepted as a place to send a signing request"
            );
        }
    }

    #[test]
    fn a_connection_holds_nothing_a_thief_could_reuse_tomorrow() {
        // The acceptance criterion, on this side of the wire. Everything this
        // laptop keeps about a managed place is here, and none of it is a key.
        let held = Connection {
            place_id: "d290f1ee-6c54-4b01-90e6-d701748f0851".into(),
            public_blob: blob(),
            comment: "aura-managed".into(),
            grant: "aura_conn_".to_string() + &"a".repeat(64),
            sign_url: "https://api.example/api/v2/places/connection/sign".into(),
            signatures_left: 32,
        };
        let printed = format!("{held:?}").to_ascii_uppercase();
        assert!(!printed.contains("PRIVATE"));
        assert!(!printed.contains("-----BEGIN"));
        // And it cannot be written down: a `Connection` is not `Serialize`, so
        // a cache or a log line that tried to keep one would not compile. This
        // asserts the fact a person would otherwise have to remember.
        let src = include_str!("broker.rs");
        let declared = src
            .find("pub struct Connection")
            .expect("the connection is still here");
        let derive = src[..declared]
            .rfind("#[derive")
            .map(|at| &src[at..declared])
            .expect("it still derives something");
        assert!(
            !derive.contains("Serialize"),
            "a Connection became serialisable, so it can now be written to disk: {derive}"
        );
    }

    #[test]
    fn a_refusal_keeps_the_words_the_server_chose() {
        let named = r#"{"reason":"key_revoked","detail":"this place's key has been revoked"}"#;
        let said = refusal("builder", 409, named);
        assert!(said.contains("revoked"), "{said}");
        // A member who has not been granted cloud gets the sentence that names
        // who can fix it, not the server's shorter one.
        let gated = r#"{"reason":"not_entitled","detail":"the acting member may not open this place"}"#;
        assert!(refusal("builder", 403, gated).contains("owner or admin"));
        // And a body that is not the named shape still produces a sentence.
        assert!(refusal("builder", 502, "<html>").contains("502"));
    }

    #[test]
    fn a_spent_grant_is_one_recognisable_answer() {
        // The agent renews on exactly this string, so it has to be a constant
        // rather than a sentence that gets re-worded.
        assert!(SPENT.contains("no longer live"));
    }
}
