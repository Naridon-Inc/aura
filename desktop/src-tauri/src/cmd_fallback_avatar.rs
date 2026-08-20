// A face for someone we have no picture of.
//
// The roster's last rung today is a deterministic animal monogram on a tinted
// disc — readable, but every teammate without a linked GitHub account wears an
// emoji. This adds a rung between the monogram and nothing: a generated portrait
// pulled once from tapback.co and then owned by this machine forever.
//
// The endpoint is NOT deterministic and NOT seedable — the same URL returns a
// different portrait on every call, and `?seed=` is ignored. So an <img src>
// pointed at it would give each person a new face on every render, which is
// worse than the monogram. The only way a person keeps one face is to fetch the
// bytes once, store them under that person's identity, and serve the stored
// copy from then on. That is the whole reason this file exists.
//
// Storage sits beside `avatars.json` (the photo a user picks for themselves) in
// `~/.aura/`, never inside a repo, so one face follows a person across every
// project on this machine and never lands in git history. One file per identity
// rather than one shared JSON map: several rows for several people resolve
// concurrently, and a shared map would mean a read-modify-write race where the
// last writer silently drops its neighbours' faces.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// The portrait source. What comes back is a random portrait we then assign.
const AVATAR_ENDPOINT: &str = "https://www.tapback.co/api/avatar.webp";

/// Why the URL carries a throwaway number.
///
/// The endpoint redirects to a portrait id, and that redirect is served from
/// Cloudflare with `max-age=31536000, immutable`. Measured on the live host: six
/// plain requests in a row returned the same portrait five times. A roster
/// resolving several faceless people in one sitting would therefore hand most of
/// them the SAME face — and because we then keep what we were given, that
/// collision would be permanent. Eight requests with a distinct value here
/// returned eight different portraits.
///
/// It is deliberately random and deliberately NOT derived from the identity.
/// Hashing someone's email into the query string would work just as well as a
/// cache-buster while shipping a stable pseudonymous id for that person to a
/// third-party host on every miss. This number says nothing about who the
/// portrait is for.
fn cache_buster() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A portrait is ~11 KB. Anything an order of magnitude past that is a redirect
/// gone wrong, not a face — refuse it rather than cache it and ride it over IPC.
const MAX_AVATAR_BYTES: usize = 512 * 1024;

/// One slow request must never hold a roster row. The fallback monogram is
/// already on screen, so giving up early costs nothing visible.
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

fn cache_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".aura").join("avatar-cache"))
        .ok_or_else(|| "could not resolve home directory".to_string())
}

/// Identity → the file its portrait lives in. Hashing keeps an email or a
/// display name (which may hold `/`, spaces, or non-ASCII) from deciding what
/// path we write to, and gives every key a fixed-width filename.
fn cache_path(key: &str) -> Result<PathBuf, String> {
    let digest = Sha256::digest(normalize(key).as_bytes());
    let name = format!("{:x}", digest);
    Ok(cache_dir()?.join(format!("{}.img", &name[..32])))
}

/// Fold the key so the same person hits the same file whatever case or padding
/// the calling surface happened to have. Mirrors `norm` in cmd_identity_avatar.
fn normalize(key: &str) -> String {
    key.trim().to_lowercase()
}

/// The media type these bytes actually are, read from their magic number rather
/// than from a header or a file extension we'd have to trust. `None` means the
/// response was not an image we're willing to store — HTML from a captive
/// portal, an error page, a truncated body.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Wrap stored bytes as a self-contained `data:` URL. The frontend hands this
/// straight to the existing `src` prop on `<Avatar/>`, so nothing needs asset
/// protocol wiring and a cached face renders with no request of any kind.
fn to_data_url(bytes: &[u8]) -> Option<String> {
    let mime = sniff_image_mime(bytes)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Read one identity's stored portrait. Touches disk only — a miss is a miss,
/// never a fetch, so a caller asking "what do I already have" cannot be turned
/// into a caller making network requests.
fn read_cached(key: &str) -> Option<String> {
    let path = cache_path(key).ok()?;
    let bytes = fs::read(path).ok()?;
    to_data_url(&bytes)
}

/// Write bytes to this identity's file. Goes through a temp file and a rename so
/// a second window fetching the same person at the same moment, or a crash
/// mid-write, can never leave a half-image that would then be served forever.
fn write_cached(key: &str, bytes: &[u8]) -> Result<(), String> {
    let path = cache_path(key)?;
    let dir = cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("img.part");
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("commit {}: {e}", path.display())
    })
}

/// Every portrait we already hold for these identities, keyed by the normalised
/// identity. Keys we've never fetched are simply absent — the frontend keeps its
/// monogram for those and decides on its own whether to go and get one.
///
/// This is the call the app makes on a cold start, and it never opens a socket:
/// a second launch draws every face it saw last time with the network untouched.
#[tauri::command]
pub fn fallback_avatar_cached(keys: Vec<String>) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for key in keys {
        let norm = normalize(&key);
        if norm.is_empty() || out.contains_key(&norm) {
            continue;
        }
        if let Some(url) = read_cached(&norm) {
            out.insert(norm, url);
        }
    }
    out
}

/// Claim a portrait for one identity and keep it.
///
/// Returns the stored copy when we already have one, so two windows racing on
/// the same person converge on one face instead of overwriting each other. Only
/// a genuine miss reaches the network, and only once per person per machine.
#[tauri::command]
pub async fn fallback_avatar_fetch(key: String) -> Result<String, String> {
    let norm = normalize(&key);
    if norm.is_empty() {
        return Err("no identity to attach a portrait to".to_string());
    }
    if let Some(existing) = read_cached(&norm) {
        return Ok(existing);
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(AVATAR_ENDPOINT)
        .query(&[("v", cache_buster())])
        .send()
        .await
        .map_err(|e| format!("fetch portrait: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch portrait: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read portrait: {e}"))?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(format!(
            "portrait is {} bytes — over the {MAX_AVATAR_BYTES} cap",
            bytes.len()
        ));
    }
    let data_url =
        to_data_url(&bytes).ok_or_else(|| "response was not an image we can store".to_string())?;

    // A cached face that can't be written still renders this session; losing the
    // disk copy costs one refetch next launch, not the portrait in front of us.
    if let Err(e) = write_cached(&norm, &bytes) {
        eprintln!("[fallback-avatar] could not cache {norm}: {e}");
    }
    Ok(data_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_person_maps_to_the_same_file_however_they_were_typed() {
        let a = cache_path("Mo@TouchStage.com ").unwrap();
        let b = cache_path("mo@touchstage.com").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn two_people_never_share_a_file() {
        let a = cache_path("mo@touchstage.com").unwrap();
        let b = cache_path("ashiq@touchstage.com").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn an_identity_cannot_choose_where_it_is_written() {
        // A display name is user-controlled text. It must not steer the path.
        let path = cache_path("../../../../etc/passwd").unwrap();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.ends_with(".img"));
        assert_eq!(name.len(), "0123456789abcdef0123456789abcdef.img".len());
        assert_eq!(path.parent().unwrap(), cache_dir().unwrap());
    }

    #[test]
    fn only_real_images_are_storable() {
        let webp = {
            let mut v = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
            v.extend_from_slice(&[0u8; 8]);
            v
        };
        assert_eq!(sniff_image_mime(&webp), Some("image/webp"));
        assert_eq!(
            sniff_image_mime(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x00"),
            Some("image/png")
        );
        // The failure that matters: an error page or a captive-portal login
        // form must never be cached as somebody's face.
        assert_eq!(sniff_image_mime(b"<!doctype html><html><head>"), None);
        assert_eq!(sniff_image_mime(b"tiny"), None);
    }

    #[test]
    fn two_people_asked_for_at_once_do_not_get_one_face() {
        // The edge cache serves the same portrait for a plain URL, so without a
        // fresh value here a whole roster would converge on one face and keep
        // it. Distinctness is the entire property.
        let a = cache_buster();
        let b = cache_buster();
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn the_cache_buster_says_nothing_about_who_it_is_for() {
        // It must never become a stable per-person id shipped to a third party.
        // Two calls for the same person differ, so there is nothing to correlate.
        let email = "mo@touchstage.com";
        let first = cache_buster();
        let second = cache_buster();
        assert_ne!(first, second);
        assert!(!first.contains(email));
        assert!(!first.contains("touchstage"));
        // And it is not the identity's cache key either, which IS stable.
        let keyed = cache_path(email).unwrap();
        let stem = keyed.file_stem().unwrap().to_string_lossy().to_string();
        assert_ne!(first, stem);
    }

    #[test]
    fn stored_bytes_come_back_as_a_renderable_url() {
        let mut webp = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        webp.extend_from_slice(&[0u8; 8]);
        let url = to_data_url(&webp).unwrap();
        assert!(url.starts_with("data:image/webp;base64,"));
        assert!(to_data_url(b"<!doctype html><html>").is_none());
    }
}
