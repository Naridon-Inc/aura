// Chat file uploads — companion to `cmd_team.rs::chat_send`.
//
// The cloud upload endpoint (`POST /api/v1/room/{room_id}/upload`) is
// the same trust model as room messages: anyone who has cloned the
// repo derives the same `room_id` and may upload. We forward a
// multipart payload (`file`, `filename`, `device_id`) and surface the
// returned URL back to the renderer so the composer can fold it into
// the outgoing message body.
//
// Path conventions + the `cloud_origin()` resolver are reused verbatim
// from `cmd_team` (via the shared `cloud_session_sync` module + the
// `cmd_device` identity helpers) — no duplicate auth code.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cmd_device::{effective_identity, room_id_for_repo};
use crate::cloud_org::OrgScoped;

// Mirror of `cmd_team::room_origin` — kept here as well so the upload
// path doesn't reach into `cmd_team`'s private API. If you ever change
// the apex-vs-api host swap rule there, change it here too.
fn room_origin() -> String {
    let creds = read_credentials().unwrap_or_default();
    let origin = cloud_origin(&creds);
    if origin == "https://api.auravcs.com" {
        return "https://auravcs.com".to_string();
    }
    origin
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UploadedAttachment {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
    pub filename: String,
}

#[derive(Deserialize)]
struct CloudUploadResponse {
    url: String,
    sha256: String,
    size: u64,
    mime: String,
}

const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// Upload a single file to the cloud room attached to `repo_root` and
/// return the public URL + metadata the renderer needs to embed the
/// attachment in a chat message.
///
/// Failure modes return a human-readable string so the toast layer can
/// show "file too large" / "offline" / etc. verbatim.
#[tauri::command]
pub async fn chat_upload_attachment(
    repo_root: String,
    file_path: String,
) -> Result<UploadedAttachment, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("file not found: {file_path}"));
    }

    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();

    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("read metadata for {file_path}: {e}"))?;
    let size = metadata.len();
    if size == 0 {
        return Err("file is empty".to_string());
    }
    if size > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "file too large: {} bytes (max {} bytes)",
            size,
            MAX_ATTACHMENT_BYTES
        ));
    }

    let mime = guess_mime(&filename);
    upload_file_path(repo_root, filename, mime, path.to_path_buf(), size).await
}

/// Upload a browser-originated file that has no stable filesystem path. This
/// covers clipboard screenshots/files and HTML DataTransfer files while the
/// path-based command above remains the efficient streaming route for Finder
/// and Aura FileTree drops.
#[tauri::command]
pub async fn chat_upload_attachment_bytes(
    repo_root: String,
    bytes_base64: String,
    filename: String,
    mime: String,
) -> Result<UploadedAttachment, String> {
    let bytes = decode_base64_payload(&bytes_base64, "attachment")?;
    validate_payload_size(bytes.len(), "attachment")?;
    let safe_name = safe_filename(&filename, "attachment");
    let safe_mime = if mime.trim().is_empty() {
        guess_mime(&safe_name)
    } else {
        mime
    };
    upload_bytes(repo_root, safe_name, safe_mime, bytes).await
}

/// Upload a browser-recorded voice note without first materialising it as a
/// user-visible file. MediaRecorder sends base64 over the Tauri IPC boundary;
/// the cloud receives the same multipart shape as every other chat attachment.
#[tauri::command]
pub async fn chat_upload_voice_note(
    repo_root: String,
    bytes_base64: String,
    filename: String,
    mime: String,
) -> Result<UploadedAttachment, String> {
    let bytes = decode_base64_payload(&bytes_base64, "voice note")?;
    validate_payload_size(bytes.len(), "voice note")?;
    let safe_name = safe_filename(&filename, "voice-note.webm");
    let safe_mime = if mime.starts_with("audio/") {
        mime
    } else {
        "audio/webm".to_string()
    };
    upload_bytes(repo_root, safe_name, safe_mime, bytes).await
}

fn decode_base64_payload(encoded: &str, label: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("decode {label}: {e}"))
}

fn validate_payload_size(size: usize, label: &str) -> Result<(), String> {
    if size == 0 {
        return Err(format!("{label} is empty"));
    }
    if size as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{label} too large: {} bytes (max {} bytes)",
            size, MAX_ATTACHMENT_BYTES
        ));
    }
    Ok(())
}

fn safe_filename(filename: &str, fallback: &str) -> String {
    Path::new(filename.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

async fn upload_bytes(
    repo_root: String,
    filename: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<UploadedAttachment, String> {
    let size = bytes.len() as u64;
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(&mime)
        .map_err(|e| format!("mime: {e}"))?;
    upload_part(repo_root, filename, size, file_part).await
}

/// Stream a filesystem attachment into reqwest instead of materialising the
/// whole file as a Vec. This keeps attachment uploads from duplicating the
/// payload in the desktop process and prepares the client for resumable uploads.
async fn upload_file_path(
    repo_root: String,
    filename: String,
    mime: String,
    path: PathBuf,
    size: u64,
) -> Result<UploadedAttachment, String> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    let file_part = reqwest::multipart::Part::stream_with_length(body, size)
        .file_name(filename.clone())
        .mime_str(&mime)
        .map_err(|e| format!("mime: {e}"))?;
    upload_part(repo_root, filename, size, file_part).await
}

async fn upload_part(
    repo_root: String,
    filename: String,
    size: u64,
    file_part: reqwest::multipart::Part,
) -> Result<UploadedAttachment, String> {
    let identity = effective_identity(Path::new(&repo_root))?;
    let room_id = room_id_for_repo(Path::new(&repo_root));
    let origin = room_origin();

    let url = format!("{origin}/api/v1/room/{room_id}/upload");

    let form = reqwest::multipart::Form::new()
        .text("filename", filename.clone())
        .text("device_id", identity.device_id.clone())
        .part("file", file_part);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Keep authenticated room uploads working while streaming the payload
    // directly from disk instead of buffering it in the desktop process.
    let mut request = client.post(&url).multipart(form);
    if let Some(token) = cloud_token(&read_credentials().unwrap_or_default()) {
        request = request.bearer_auth(token).org_scoped();
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("upload POST {url}: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err("file too large (server rejected, 25 MB max)".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upload failed: HTTP {status}: {body}"));
    }

    let parsed: CloudUploadResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse upload response: {e}"))?;

    Ok(UploadedAttachment {
        url: parsed.url,
        sha256: parsed.sha256,
        size: if parsed.size > 0 { parsed.size } else { size },
        mime: parsed.mime,
        filename,
    })
}

/// Best-effort MIME guess off the trailing extension. The cloud has
/// its own (richer) table; this one is just to set a useful
/// Content-Type on the outgoing multipart part. Falls back to
/// `application/octet-stream`.
fn guess_mime(filename: &str) -> String {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" | "jsonl" => "application/json",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/x-typescript",
        "rs" => "text/x-rust",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "sh" | "bash" | "zsh" => "text/x-shellscript",
        "yaml" | "yml" => "text/x-yaml",
        "toml" => "text/x-toml",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}
