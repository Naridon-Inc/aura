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

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cmd_device::{effective_identity, room_id_for_repo};

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

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("read {file_path}: {e}"))?;
    if bytes.is_empty() {
        return Err("file is empty".to_string());
    }
    const MAX: usize = 25 * 1024 * 1024;
    if bytes.len() > MAX {
        return Err(format!(
            "file too large: {} bytes (max {} bytes)",
            bytes.len(),
            MAX
        ));
    }

    let identity = effective_identity(Path::new(&repo_root))?;
    let room_id = room_id_for_repo(Path::new(&repo_root));
    let origin = room_origin();

    let url = format!("{origin}/api/v1/room/{room_id}/upload");

    let mime = guess_mime(&filename);
    let file_part = reqwest::multipart::Part::bytes(bytes.clone())
        .file_name(filename.clone())
        .mime_str(&mime)
        .map_err(|e| format!("mime: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .text("filename", filename.clone())
        .text("device_id", identity.device_id.clone())
        .part("file", file_part);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Attach the cloud bearer so uploads survive AURA_ROOMS_REQUIRE_AUTH.
    // `cloud_token` is the crate-wide accessor (cmd_team's copy is private).
    let mut req = client.post(&url).multipart(form);
    if let Some(token) = cloud_token(&read_credentials().unwrap_or_default()) {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("upload POST {url}: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err("file too large (server rejected, 25MB max)".to_string());
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
        size: parsed.size,
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
