//! Asking EC2 for something, in the one shape it takes.
//!
//! EC2's Query API is a single `POST /` whose body is a form-encoded list of
//! parameters — `Action=RunInstances&ImageId=…&Version=2016-11-15` — signed with
//! SigV4. That is the whole protocol, which is why this file is the whole
//! transport: a request is a map of names to values, and everything above it
//! only decides what goes in the map.
//!
//! Chosen over the AWS SDK on purpose. `aws-config` plus a smithy runtime is a
//! very large dependency tree, and the desktop already carries a SigV4 signer
//! for Bedrock ([`crate::aws_sigv4`]) that signs exactly this shape — one POST,
//! no query string, a form body. Five calls do not justify the tree; they do
//! justify reusing the signer rather than writing a second one.
//!
//! Nothing here interprets an answer. The body comes back as text and
//! [`super::parse`] reads it, so a response we cannot make sense of is one
//! failure with one message rather than a shape that half-decodes.

use std::collections::BTreeMap;

use crate::aws_sigv4::{sign_post, AwsCredentials};
use crate::provisioner::managed::driver::{DriverError, DriverResult};

use super::parse;

/// The API version every request pins.
///
/// Pinned rather than left to the service's default because the response shapes
/// [`super::parse`] reads are this version's. A silent bump on the far side
/// would change them under us, and the failure would arrive as "the cloud
/// answered in a shape we don't understand" long after anybody touched this
/// code.
const API_VERSION: &str = "2016-11-15";

/// The name SigV4 signs under. Not the host — a region's endpoint host varies,
/// the service name in the credential scope does not.
const SERVICE: &str = "ec2";

/// What EC2 wants a form body labelled as. Signed, so it cannot be swapped in
/// flight for one whose parsing rules differ.
const FORM: &str = "application/x-www-form-urlencoded; charset=utf-8";

/// One request's parameters.
///
/// A sorted map rather than a list, so the same request always produces the same
/// bytes. That matters for two reasons and neither is the signature: a
/// deterministic body is a body a test can assert on, and a body a person can
/// diff against what the console sent when a call is refused for a reason
/// nobody expected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    params: BTreeMap<String, String>,
}

impl Query {
    /// A request for one action.
    pub fn action(action: &str) -> Self {
        let mut params = BTreeMap::new();
        params.insert("Action".to_string(), action.to_string());
        params.insert("Version".to_string(), API_VERSION.to_string());
        Self { params }
    }

    /// Ask a different service's API version instead of EC2's.
    ///
    /// Every AWS Query service pins its own, and they are years apart — STS has
    /// been on `2011-06-15` for the life of the service. Spelled as its own
    /// method rather than a `set("Version", …)` at the call site so the pin
    /// stays as visible for a borrowed service as it is for the one this file
    /// was written for: read the wrong version's shapes and the failure arrives
    /// as "the cloud answered in a shape we don't understand".
    pub fn version(self, version: &str) -> Self {
        self.set("Version", version)
    }

    /// Add one parameter.
    pub fn set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }

    /// Add a numbered list — `Filter.1.Name`, `Filter.2.Name`, and so on.
    ///
    /// One-based, because that is what the API counts from. Zero-based would be
    /// accepted, silently ignored, and the filter would simply not apply — which
    /// comes back as "your account has no such thing" about a thing that is
    /// right there.
    pub fn list<I, S>(mut self, prefix: &str, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for (n, value) in values.into_iter().enumerate() {
            self.params
                .insert(format!("{prefix}.{}", n + 1), value.into());
        }
        self
    }

    /// The action this asks for, for a message that has to name it.
    pub fn what(&self) -> &str {
        self.params.get("Action").map(String::as_str).unwrap_or("")
    }

    /// The body as it goes on the wire.
    pub fn body(&self) -> String {
        self.params
            .iter()
            .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// Percent-encode a form value the way AWS wants it.
///
/// Not `application/x-www-form-urlencoded`'s own historical rules: a space is
/// `%20` and never `+`, and `~` is left alone. Both differences are the ones
/// that break a signature, because the signed bytes and the sent bytes have to
/// agree exactly and a `+` on one side is a space on the other.
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for &b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A signed, addressed EC2 endpoint in one region.
///
/// Deliberately **not** `Debug`. It holds a secret access key, and the one thing
/// that must never happen to a secret access key is being written down by
/// something that was only trying to be helpful — a `{:?}` in an error arm, a
/// derived `Debug` on a struct three levels up. Leaving the trait off makes that
/// a compile error rather than a habit.
pub struct Endpoint {
    region: String,
    /// The name SigV4 signs under. A field rather than the constant it usually
    /// is, because one other service speaks this exact dialect and is reached
    /// through this same transport: STS, which is how a role in somebody else's
    /// account is assumed. Copying the file to change one string would have been
    /// a second signer to keep in step.
    service: &'static str,
    host: String,
    creds: AwsCredentials,
    /// Held rather than made per call, so the five requests one provision makes
    /// share a connection pool instead of opening five TLS sessions.
    http: reqwest::Client,
}

impl Endpoint {
    pub fn new(region: &str, creds: AwsCredentials) -> Self {
        Self::for_service(SERVICE, region, host_for(region), creds)
    }

    /// An endpoint for another service that speaks the same dialect.
    ///
    /// The host is passed rather than derived: every service names its regional
    /// endpoint differently, and a second `*_for(region)` here would be a second
    /// pattern to keep in step with a service this file is not about.
    pub fn for_service(
        service: &'static str,
        region: &str,
        host: String,
        creds: AwsCredentials,
    ) -> Self {
        Self {
            region: region.to_string(),
            service,
            host,
            creds,
            http: reqwest::Client::new(),
        }
    }

    /// An EC2 endpoint on the credential this process was given.
    pub fn from_environment(region: &str) -> Result<Self, String> {
        Ok(Self::new(region, credentials_from_environment()?))
    }

    /// Send one request and hand back the body it answered with.
    pub async fn call(&self, query: Query) -> DriverResult<String> {
        let body = query.body();
        // Passed in rather than read inside the signer so the timestamp we sign
        // is byte-identical to the one we send.
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        // The path is `/` — one character, and already its own encoding.
        let signed = sign_post(
            &self.creds,
            &self.region,
            self.service,
            &self.host,
            "/",
            FORM,
            body.as_bytes(),
            &amz_date,
        );

        let mut request = self
            .http
            .post(format!("https://{}/", self.host))
            .header("content-type", FORM);
        for (name, value) in signed {
            request = request.header(name, value);
        }

        let answered = request.body(body).send().await.map_err(|e| {
            // The request never landed, so nothing was made and nothing is
            // billed. Distinct from a refusal on purpose: this one is worth
            // retrying and a refusal is not.
            DriverError::Unreachable(format!(
                "couldn't reach the cloud to {}: {e}",
                query.what()
            ))
        })?;
        let status = answered.status();
        let text = answered.text().await.map_err(|e| {
            DriverError::Unreachable(format!("the cloud's answer stopped partway through: {e}"))
        })?;

        if status.is_success() {
            Ok(text)
        } else {
            Err(refusal(status.as_u16(), &text))
        }
    }
}

/// Which host serves a region.
///
/// Built rather than configured: the pattern has been stable for the life of the
/// service, and a settings field for it would be one more thing to get wrong in
/// a file whose other fields already say which region this is.
fn host_for(region: &str) -> String {
    format!("ec2.{region}.amazonaws.com")
}

/// The credential this process will spend, from its environment.
///
/// The environment and not the settings file, which is the whole reason
/// [`super::super::settings`] can hold names in plain text: the file says which
/// account and which region, and the thing worth stealing is handed to the
/// process by whatever started it. A desktop with no such variables set is not
/// misconfigured — it simply has no cloud account to act in, and says so.
///
/// Named separately from [`Endpoint::from_environment`] because it is also the
/// starting point of the other thing this credential is for: asking a customer's
/// account for a role in it ([`crate::provisioner::grant`]). That is a different
/// service on a different host, and both begin with the same question.
pub fn credentials_from_environment() -> Result<AwsCredentials, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let (Some(access_key_id), Some(secret_access_key)) = (key, secret) else {
        return Err(
            "Aura has no credentials for the cloud account it would make the machine in."
                .to_string(),
        );
    };
    Ok(AwsCredentials {
        access_key_id,
        secret_access_key,
        // Only set for temporary credentials. Absent is the ordinary case and
        // not a problem to report.
        session_token: std::env::var("AWS_SESSION_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty()),
    })
}

/// Turn a refused response into the driver's own word for it.
///
/// The cloud's `Code` and `Message` are kept as they came. `Code` is the part
/// worth branching on (`InsufficientInstanceCapacity` and `UnauthorizedOperation`
/// are different afternoons) and `Message` is the part worth reading — it names
/// the group, the region or the permission, and no paraphrase of ours would.
///
/// A refusal whose body says neither still has to say something, so the status
/// stands in. "The cloud said no" with a number beats an empty string, which is
/// what a surface would otherwise show a person.
fn refusal(status: u16, body: &str) -> DriverError {
    let code = parse::text(body, "Code").unwrap_or_else(|| format!("HTTP {status}"));
    let message = parse::text(body, "Message")
        .unwrap_or_else(|| format!("the cloud refused the request and gave no reason ({status})"));
    DriverError::Refused { code, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_request_names_its_action_and_pins_a_version() {
        // The version is pinned because the shapes `parse` reads are this
        // version's. Left to the service's default, a bump on the far side
        // changes them under us and the failure lands nowhere near this file.
        let body = Query::action("RunInstances").body();
        assert!(body.contains("Action=RunInstances"), "{body}");
        assert!(body.contains(&format!("Version={API_VERSION}")), "{body}");
    }

    #[test]
    fn the_same_request_always_makes_the_same_bytes() {
        // Written in one order, sorted in the map, identical on the wire — so a
        // test can assert on a body and a person can diff one against what the
        // console sent.
        let a = Query::action("RunInstances")
            .set("ImageId", "ami-1")
            .set("MaxCount", "1")
            .body();
        let b = Query::action("RunInstances")
            .set("MaxCount", "1")
            .set("ImageId", "ami-1")
            .body();
        assert_eq!(a, b);
    }

    #[test]
    fn a_space_is_never_a_plus() {
        // The difference that breaks a signature rather than a request: the
        // signed bytes and the sent bytes have to agree exactly, and form
        // encoding's historical `+` is a space to one side and a plus to the
        // other. The failure is a 403 that names none of this.
        assert_eq!(encode("a b"), "a%20b");
        assert_eq!(encode("a+b"), "a%2Bb");
        // Unreserved, and `~` among them — the other classic disagreement.
        assert_eq!(encode("Aura-managed_1.0~x"), "Aura-managed_1.0~x");
        // Everything else goes as bytes, so a value we did not anticipate is
        // encoded rather than sent raw.
        assert_eq!(encode("/"), "%2F");
        assert_eq!(encode("é"), "%C3%A9");
    }

    #[test]
    fn a_list_is_numbered_from_one() {
        // Zero-based is accepted, silently ignored, and the filter simply does
        // not apply — which comes back as "no such thing in your account" about
        // a thing that is right there.
        let body = Query::action("DescribeInstances")
            .list("InstanceId", ["i-1", "i-2"])
            .body();
        assert!(body.contains("InstanceId.1=i-1"), "{body}");
        assert!(body.contains("InstanceId.2=i-2"), "{body}");
        assert!(!body.contains("InstanceId.0"), "{body}");
    }

    #[test]
    fn a_region_picks_its_own_endpoint() {
        assert_eq!(host_for("eu-central-1"), "ec2.eu-central-1.amazonaws.com");
    }

    #[test]
    fn a_refusal_keeps_the_clouds_own_words() {
        // The message names the group, the region or the permission. Ours would
        // name none of them, and it is the only sentence with a fix in it.
        let body = "<Response><Errors><Error><Code>InvalidGroup.NotFound</Code>\
                    <Message>The security group 'aura-managed' does not exist</Message>\
                    </Error></Errors></Response>";
        let DriverError::Refused { code, message } = refusal(400, body) else {
            panic!("a refused response was not read as a refusal");
        };
        assert_eq!(code, "InvalidGroup.NotFound");
        assert!(message.contains("aura-managed"), "{message}");
    }

    #[test]
    fn a_refusal_with_nothing_to_say_still_says_something() {
        // A gateway between us and the service answers with HTML, or with
        // nothing. An empty string is what a surface would then show a person.
        let DriverError::Refused { code, message } = refusal(503, "<html>nope</html>") else {
            panic!("a refused response was not read as a refusal");
        };
        assert!(code.contains("503"), "{code}");
        assert!(!message.is_empty());
    }

    #[test]
    fn no_credentials_is_a_sentence_rather_than_a_guess() {
        // An endpoint built with no credentials would sign every request with an
        // empty key and get a 403 whose message is about signatures. The honest
        // answer is that this install has no account to spend.
        //
        // The variables are read, never written: a test that set them would
        // change what every other test in this process sees.
        if std::env::var("AWS_ACCESS_KEY_ID").is_ok()
            && std::env::var("AWS_SECRET_ACCESS_KEY").is_ok()
        {
            // This machine has an account configured. Nothing to prove here,
            // and nothing is spent either way — building an endpoint sends no
            // request.
            assert!(Endpoint::from_environment("eu-central-1").is_ok());
            return;
        }
        let why = Endpoint::from_environment("eu-central-1")
            .err()
            .expect("no credentials should not produce an endpoint");
        assert!(why.contains("credentials"), "{why}");
    }
}
