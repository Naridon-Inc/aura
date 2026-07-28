//! Google service-account → OAuth2 access-token minting for the Vertex brain.
//!
//! Vertex AI authenticates with a short-lived OAuth2 Bearer token, not a
//! static API key. We take the service-account JSON the user pasted (the file
//! Google Cloud hands out for a service account), sign an RS256 JWT assertion
//! with its private key, and exchange it at the Google token endpoint for an
//! access token — the standard two-legged `jwt-bearer` grant. Tokens are
//! valid ~1h; the caller caches ours and refreshes before expiry.
//!
//! No GCP SDK: `jsonwebtoken` signs the assertion and `reqwest` performs the
//! exchange, keeping the dependency footprint to one small crate.
#![cfg(feature = "brain_vertex")]

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::{Deserialize, Serialize};

use super::types::BrainError;

/// Scope granting access to the Vertex AI (aiplatform) surface.
const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/// The subset of a Google service-account JSON we need to sign an assertion.
/// Parsed directly from the pasted file via serde; unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccount {
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    DEFAULT_TOKEN_URI.to_string()
}

impl ServiceAccount {
    /// Parse a service-account JSON string. Surfaces a precise error the
    /// settings UI can show if the paste is truncated or the wrong file.
    pub fn from_json(raw: &str) -> Result<Self, BrainError> {
        let sa: ServiceAccount = serde_json::from_str(raw).map_err(|e| BrainError::Other {
            message: format!(
                "service-account JSON is not valid ({e}) — paste the full key file from Google Cloud"
            ),
        })?;
        if sa.client_email.is_empty() || sa.private_key.is_empty() {
            return Err(BrainError::Other {
                message: "service-account JSON is missing client_email or private_key".into(),
            });
        }
        Ok(sa)
    }
}

#[derive(Debug, Serialize)]
struct Assertion<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: i64,
}

/// A minted access token plus the unix time it stops being usable.
#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub expires_at_unix: i64,
}

impl AccessToken {
    /// True when the token is within `skew` seconds of expiry (or past it),
    /// so callers refresh a little early rather than racing the boundary.
    pub fn is_expiring(&self, now_unix: i64, skew: i64) -> bool {
        now_unix + skew >= self.expires_at_unix
    }
}

/// Sign a JWT assertion for `sa` and exchange it for a Vertex access token.
pub async fn fetch_access_token(sa: &ServiceAccount) -> Result<AccessToken, BrainError> {
    let now = chrono::Utc::now().timestamp();
    let claims = Assertion {
        iss: &sa.client_email,
        scope: SCOPE,
        aud: &sa.token_uri,
        iat: now,
        // Google caps assertion lifetime at 1h; we mirror that.
        exp: now + 3600,
    };
    let key = EncodingKey::from_rsa_pem(sa.private_key.as_bytes()).map_err(|e| {
        BrainError::Other {
            message: format!("service-account private_key is not a valid RSA PEM: {e}"),
        }
    })?;
    let assertion = encode(&Header::new(Algorithm::RS256), &claims, &key).map_err(|e| {
        BrainError::Other {
            message: format!("failed to sign service-account assertion: {e}"),
        }
    })?;

    let client = reqwest::Client::new();
    let res = client
        .post(&sa.token_uri)
        .form(&[
            ("grant_type", JWT_BEARER_GRANT),
            ("assertion", &assertion),
        ])
        .send()
        .await
        .map_err(|e| BrainError::Network {
            message: format!("google token exchange: {e}"),
        })?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(BrainError::Api {
            status: status.as_u16(),
            message: format!("google token endpoint: {text}"),
        });
    }
    let tr: TokenResponse = res.json().await.map_err(|e| BrainError::Parse {
        message: format!("google token response: {e}"),
    })?;
    let ttl = if tr.expires_in > 0 { tr.expires_in } else { 3600 };
    Ok(AccessToken {
        token: tr.access_token,
        expires_at_unix: now + ttl,
    })
}
