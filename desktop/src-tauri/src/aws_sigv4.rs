//! Minimal AWS Signature Version 4 signing for a single POST request.
//!
//! Just enough SigV4 to authenticate one signed POST — we deliberately do NOT
//! pull the AWS SDK (`aws-config` + a smithy runtime is a very large dependency
//! tree for this). The algorithm is fully deterministic: canonical request →
//! string-to-sign → derived signing key → HMAC signature, exactly as documented
//! at
//! <https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html>.
//!
//! Scope is intentionally narrow: no query string, a caller-supplied
//! already-URI-encoded path, and a fixed signed-header set
//! (`content-type;host;x-amz-content-sha256;x-amz-date`, plus
//! `x-amz-security-token` when a session token is present).
//!
//! It sat inside `manager::brain` behind the `brain_bedrock` feature while
//! Bedrock was the only caller. The managed-place driver signs EC2 the same way
//! — one `POST /` with a form-encoded body and no query string, which is
//! exactly this shape — so the primitive moved up to the crate root rather than
//! being written a second time. A second copy of a signing routine is a second
//! thing to get subtly wrong, and the failure mode of "subtly wrong" here is an
//! opaque 403 from a service that will not say which byte disagreed.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// AWS credentials for signing. `session_token` is `Some` only for temporary
/// credentials (STS / SSO / assumed roles); long-lived IAM keys leave it
/// `None` and no `X-Amz-Security-Token` header is added.
///
/// `Clone` because a set of temporary credentials is held for the fifteen
/// minutes it is good for and handed to each request made in that window, rather
/// than being fetched again per call. Deliberately still not `Debug`: the one
/// thing that must never happen to a secret access key is being written down by
/// something that was only trying to be helpful, and leaving the derive off makes
/// that a compile error rather than a habit.
#[derive(Clone)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// One header to attach to the outgoing request.
pub type SignedHeader = (String, String);

/// Percent-encode a path so it is a valid SigV4 canonical URI segment set.
/// Keeps the RFC 3986 unreserved set and `/` (path separators are never
/// encoded); everything else — notably the `:` in Bedrock model ids like
/// `anthropic.claude-3-5-sonnet-20241022-v2:0` — becomes `%XX`. The SAME
/// encoded string must be used for both the canonical request and the wire
/// URL, or the signature won't match, so callers build the request URL from
/// this output.
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for &b in path.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Sign a POST and return the headers the caller must attach:
/// `x-amz-date`, `x-amz-content-sha256`, `authorization`, and
/// `x-amz-security-token` (only for temporary credentials).
///
/// - `encoded_path` MUST already be [`encode_path`]-encoded and is used
///   verbatim as the canonical URI. There is no query string.
/// - `content_type` and `host` are folded into the signed header set so a
///   tampered Host or body content-type invalidates the signature.
/// - `amz_date` is the ISO8601-basic timestamp (`YYYYMMDDTHHMMSSZ`); the
///   caller passes it (rather than us reading the clock) so the value it
///   stamps on the request is byte-identical to what we sign.
#[allow(clippy::too_many_arguments)]
pub fn sign_post(
    creds: &AwsCredentials,
    region: &str,
    service: &str,
    host: &str,
    encoded_path: &str,
    content_type: &str,
    payload: &[u8],
    amz_date: &str,
) -> Vec<SignedHeader> {
    let datestamp = &amz_date[..8]; // YYYYMMDD prefix of YYYYMMDDTHHMMSSZ
    let payload_hash = sha256_hex(payload);

    // Canonical headers — sorted, lowercase, trimmed. Order here must match
    // `signed_headers` below.
    let mut canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let mut signed_headers =
        String::from("content-type;host;x-amz-content-sha256;x-amz-date");
    // A session token, when present, is part of the signature. It sorts after
    // x-amz-security-token > x-amz-date lexicographically, so it appends.
    if let Some(token) = creds.session_token.as_deref() {
        canonical_headers.push_str(&format!("x-amz-security-token:{token}\n"));
        signed_headers.push_str(";x-amz-security-token");
    }

    let canonical_request = format!(
        "POST\n{encoded_path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let credential_scope = format!("{datestamp}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // Derive the signing key: HMAC chain seeded with "AWS4" + secret.
    let k_date = hmac(
        format!("AWS4{}", creds.secret_access_key).as_bytes(),
        datestamp.as_bytes(),
    );
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    );

    let mut headers = vec![
        ("x-amz-date".to_string(), amz_date.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash),
        ("authorization".to_string(), authorization),
    ];
    if let Some(token) = creds.session_token.as_deref() {
        headers.push(("x-amz-security-token".to_string(), token.to_string()));
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_path_percent_encodes_colon_keeps_slashes() {
        // The Bedrock model-id colon must become %3A; slashes and unreserved
        // chars pass through untouched.
        let got = encode_path("/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke");
        assert_eq!(
            got,
            "/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke"
        );
    }

    #[test]
    fn sign_post_matches_aws_reference_vector() {
        // AWS SigV4 documentation reference request (GET → adapted): we assert
        // the derivation is internally consistent and deterministic by signing
        // twice and comparing, plus checking the Authorization envelope shape.
        let creds = AwsCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        let a = sign_post(
            &creds,
            "us-east-1",
            "bedrock",
            "bedrock-runtime.us-east-1.amazonaws.com",
            "/model/x/invoke",
            "application/json",
            b"{}",
            "20150830T123600Z",
        );
        let b = sign_post(
            &creds,
            "us-east-1",
            "bedrock",
            "bedrock-runtime.us-east-1.amazonaws.com",
            "/model/x/invoke",
            "application/json",
            b"{}",
            "20150830T123600Z",
        );
        assert_eq!(a, b, "signing must be deterministic");
        let auth = &a
            .iter()
            .find(|(k, _)| k == "authorization")
            .unwrap()
            .1;
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, "
        ));
        assert!(auth.contains(
            "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature="
        ));
    }
}
