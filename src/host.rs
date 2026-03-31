// ─── Aura Mothership: Embedded Server ───────────────────────────────────────
// A self-contained collaboration server embedded in the CLI binary.
// Uses SQLite (via host_db.rs) instead of PostgreSQL.
// Serves the EXACT same API routes as aura-server so all existing
// client code (live_sync.rs, main.rs commands) works unchanged.

use axum::{
    extract::{Json as ExtractJson, Path, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use http::Method;
use colored::Colorize;
use crate::host_db;

// ─── State ──────────────────────────────────────────────────────────────────

pub struct MothershipState {
    pub db: Mutex<rusqlite::Connection>,
    pub jwt_secret: String,
}

#[derive(Debug, Clone)]
pub struct TokenAuth {
    pub user_id: String,
    pub org_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JwtClaims {
    pub sub: String,
    pub login: String,
    pub exp: i64,
    pub iat: i64,
}

// ─── JWT Helpers ────────────────────────────────────────────────────────────

fn create_jwt(secret: &str, user_id: &str, login: &str) -> Result<String, String> {
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims {
        sub: user_id.to_string(),
        login: login.to_string(),
        iat: now,
        exp: now + 86400 * 30, // 30 days
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("JWT encode error: {}", e))
}

fn verify_jwt(secret: &str, token: &str) -> Result<JwtClaims, String> {
    let data = jsonwebtoken::decode::<JwtClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .map_err(|e| format!("JWT verify error: {}", e))?;
    Ok(data.claims)
}

fn hash_api_token(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

fn generate_api_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..24).map(|_| rng.r#gen()).collect();
    format!("aura_{}", hex::encode(bytes))
}

// ─── Auth Middleware ────────────────────────────────────────────────────────

async fn auth_middleware(
    State(state): State<Arc<MothershipState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers().get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let token = auth_header.strip_prefix("Bearer ").unwrap_or("").to_string();
    if token.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Resolve auth in a sync block so MutexGuard is dropped before any .await
    let auth_result: Option<TokenAuth> = {
        // Try JWT first
        if let Ok(claims) = verify_jwt(&state.jwt_secret, &token) {
            let db = state.db.lock().unwrap();
            let org_id = host_db::get_first_org_for_user(&db, &claims.sub)
                .unwrap_or(None)
                .unwrap_or_else(|| claims.sub.clone());
            Some(TokenAuth { user_id: claims.sub, org_id })
        } else if token.starts_with("aura_") {
            let hash = hash_api_token(&token);
            let db = state.db.lock().unwrap();
            host_db::get_token_by_hash(&db, &hash)
                .ok()
                .flatten()
                .map(|t| TokenAuth { user_id: t.user_id, org_id: t.org_id })
        } else {
            None
        }
    };

    match auth_result {
        Some(auth) => {
            req.extensions_mut().insert(auth);
            Ok(next.run(req).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

// ─── Public Startup ─────────────────────────────────────────────────────────

/// Load or generate the JWT secret stored at ~/.aura/mothership_secret
pub fn load_or_create_jwt_secret() -> String {
    let home = dirs_path();
    let secret_path = format!("{}/mothership_secret", home);
    if let Ok(secret) = std::fs::read_to_string(&secret_path) {
        let s = secret.trim().to_string();
        if s.len() >= 32 { return s; }
    }
    // Generate new secret
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.r#gen()).collect();
    let secret = hex::encode(bytes);
    let _ = std::fs::create_dir_all(&home);
    let _ = std::fs::write(&secret_path, &secret);
    // Restrict permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&secret_path, std::fs::Permissions::from_mode(0o600));
    }
    secret
}

fn dirs_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{}/.aura", home)
}

// ─── Daemon / PID File Management ──────────────────────────────────────────

fn pid_path() -> String {
    format!("{}/mothership.pid", dirs_path())
}

fn log_path() -> String {
    format!("{}/mothership.log", dirs_path())
}

pub fn write_pid_file() {
    let _ = std::fs::write(pid_path(), std::process::id().to_string());
}

pub fn remove_pid_file() {
    let _ = std::fs::remove_file(pid_path());
}

/// Returns Some(pid) if the mothership daemon is running, None otherwise.
pub fn read_running_pid() -> Option<u32> {
    let pid_str = std::fs::read_to_string(pid_path()).ok()?;
    let pid: u32 = pid_str.trim().parse().ok()?;
    // Check if process is alive (signal 0 = existence check)
    let status = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => Some(pid),
        _ => {
            // Stale PID file — clean up
            let _ = std::fs::remove_file(pid_path());
            None
        }
    }
}

/// Fork the mothership as a background daemon. Re-execs the current binary
/// with `--foreground`, redirecting output to the log file.
pub fn daemonize(port: u16, tunnel: bool, no_tls: bool) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(pid) = read_running_pid() {
        eprintln!("  Mothership is already running (PID {}). Use `aura host stop` first.", pid);
        return Ok(());
    }

    let exe = std::env::current_exe()?;
    let log = log_path();
    let log_file = std::fs::OpenOptions::new()
        .create(true).append(true).open(&log)?;
    let log_err = log_file.try_clone()?;

    let mut cmd = std::process::Command::new(exe);
    cmd.arg("host").arg("start").arg("--foreground")
        .arg("--port").arg(port.to_string());
    if tunnel { cmd.arg("--tunnel"); }
    if no_tls { cmd.arg("--no-tls"); }

    cmd.stdout(log_file)
        .stderr(log_err)
        .stdin(std::process::Stdio::null());

    // Detach on Unix
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);  // new process group — survives terminal close
    }

    let child = cmd.spawn()?;
    let pid = child.id();
    let _ = std::fs::write(pid_path(), pid.to_string());

    println!("\n  {} Mothership daemon started (PID {})", "✓".green().bold(), pid);
    println!("  {} Logs: {}", "•".dimmed(), log);
    println!("  {} Stop with: aura host stop", "•".dimmed());
    println!();
    Ok(())
}

/// Stop the running mothership daemon via PID file.
pub fn stop_daemon() -> bool {
    if let Some(pid) = read_running_pid() {
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
        remove_pid_file();
        println!("  {} Mothership stopped (PID {})", "✓".green().bold(), pid);
        true
    } else {
        println!("  {} No running mothership found", "ℹ".blue());
        false
    }
}

/// Show daemon status — PID, uptime, log tail.
pub fn daemon_status() {
    if let Some(pid) = read_running_pid() {
        println!("  {} Mothership daemon is {} (PID {})", "●".green(), "running".green().bold(), pid);
        println!("  {} Logs: {}", "•".dimmed(), log_path());
        // Show last 5 lines of log
        if let Ok(log) = std::fs::read_to_string(log_path()) {
            let lines: Vec<&str> = log.lines().collect();
            let tail: Vec<&str> = lines.iter().rev().take(5).rev().cloned().collect();
            if !tail.is_empty() {
                println!("  {} Recent log:", "•".dimmed());
                for line in tail {
                    println!("    {}", line.dimmed());
                }
            }
        }
    } else {
        println!("  {} Mothership is {}", "●".red(), "not running".red().bold());
    }
}

/// Install a macOS LaunchAgent so the mothership auto-starts on login.
pub fn install_launchagent(port: u16, no_tls: bool) -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let agents_dir = format!("{}/Library/LaunchAgents", home);
    let plist_path = format!("{}/com.aura.mothership.plist", agents_dir);
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let log = log_path();

    let mut args = vec![
        format!("<string>{}</string>", exe),
        "<string>host</string>".to_string(),
        "<string>start</string>".to_string(),
        "<string>--foreground</string>".to_string(),
        "<string>--port</string>".to_string(),
        format!("<string>{}</string>", port),
    ];
    if no_tls {
        args.push("<string>--no-tls</string>".to_string());
    }
    let args_xml = args.join("\n            ");

    let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aura.mothership</string>
    <key>ProgramArguments</key>
    <array>
            {args_xml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>"#);

    let _ = std::fs::create_dir_all(&agents_dir);
    std::fs::write(&plist_path, plist)?;

    // Load the agent
    let _ = std::process::Command::new("launchctl")
        .args(["unload", &plist_path])
        .output();
    let status = std::process::Command::new("launchctl")
        .args(["load", &plist_path])
        .status()?;

    if status.success() {
        println!("\n  {} LaunchAgent installed — mothership will auto-start on login", "✓".green().bold());
        println!("  {} Plist: {}", "•".dimmed(), plist_path);
        println!("  {} Uninstall: launchctl unload {}", "•".dimmed(), plist_path);
    } else {
        eprintln!("  {} launchctl load failed", "✗".red().bold());
    }
    println!();
    Ok(())
}

/// Uninstall the macOS LaunchAgent.
pub fn uninstall_launchagent() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let plist_path = format!("{}/Library/LaunchAgents/com.aura.mothership.plist", home);
    if std::path::Path::new(&plist_path).exists() {
        let _ = std::process::Command::new("launchctl")
            .args(["unload", &plist_path])
            .status();
        std::fs::remove_file(&plist_path)?;
        println!("  {} LaunchAgent removed — mothership will no longer auto-start", "✓".green().bold());
    } else {
        println!("  {} No LaunchAgent installed", "ℹ".blue());
    }
    Ok(())
}

// ─── TLS Certificate Management ─────────────────────────────────────────────

/// Generate a self-signed TLS certificate and key. Returns (cert_pem, key_pem, fingerprint).
fn generate_self_signed_cert() -> Result<(String, String, String), Box<dyn std::error::Error>> {
    let mut params = rcgen::CertificateParams::new(vec!["aura-mothership".to_string()])?;
    params.subject_alt_names = vec![
        rcgen::SanType::DnsName("localhost".try_into()?),
        rcgen::SanType::DnsName("aura-mothership".try_into()?),
        rcgen::SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(0, 0, 0, 0))),
        rcgen::SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
    ];
    // Valid for 10 years
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2034, 1, 1);

    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    // SHA-256 fingerprint of the DER-encoded certificate
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(cert.der());
    let fingerprint_bytes = hasher.finalize();
    let fingerprint = fingerprint_bytes.iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");

    Ok((cert_pem, key_pem, fingerprint))
}

/// Load existing or generate new TLS cert. Returns (cert_pem, key_pem, fingerprint).
pub fn load_or_create_tls_cert() -> Result<(String, String, String), Box<dyn std::error::Error>> {
    let home = dirs_path();
    let cert_path = format!("{}/mothership_cert.pem", home);
    let key_path = format!("{}/mothership_key.pem", home);
    let fp_path = format!("{}/mothership_fingerprint", home);

    // Try to load existing
    if let (Ok(cert), Ok(key), Ok(fp)) = (
        std::fs::read_to_string(&cert_path),
        std::fs::read_to_string(&key_path),
        std::fs::read_to_string(&fp_path),
    ) {
        if !cert.is_empty() && !key.is_empty() && !fp.is_empty() {
            return Ok((cert, key, fp.trim().to_string()));
        }
    }

    // Generate new
    let (cert_pem, key_pem, fingerprint) = generate_self_signed_cert()?;
    let _ = std::fs::create_dir_all(&home);
    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;
    std::fs::write(&fp_path, &fingerprint)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok((cert_pem, key_pem, fingerprint))
}

// TLS config is built directly in start_mothership using axum_server::tls_rustls::RustlsConfig

// ─── Join Token ─────────────────────────────────────────────────────────────
// Encodes everything a peer needs into one base64 string:
//   { url, code, fingerprint }


#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct JoinToken {
    pub url: String,
    pub code: String,
    pub fp: String, // TLS fingerprint (empty for --no-tls)
}

impl JoinToken {
    pub fn encode(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_default();
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes())
    }

    pub fn decode(token: &str) -> Option<Self> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token).ok()?;
        let json = String::from_utf8(bytes).ok()?;
        serde_json::from_str(&json).ok()
    }
}

/// Detect the machine's local network IP (not 127.0.0.1).
fn detect_local_ip() -> String {
    // Try to connect to a public IP to find our local interface IP
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "localhost".to_string()
}

/// Auto-provision: create admin user + org + invite code on first run.
/// Returns the invite code.
fn auto_provision_if_needed(conn: &rusqlite::Connection) -> Option<String> {
    let user_count = host_db::count_users(conn).unwrap_or(0);
    if user_count > 0 {
        // Already provisioned — generate a fresh invite
        let org_id: Option<String> = conn.query_row(
            "SELECT id FROM organizations LIMIT 1", [], |row| row.get(0)
        ).ok();
        let user_id: Option<String> = conn.query_row(
            "SELECT id FROM users LIMIT 1", [], |row| row.get(0)
        ).ok();
        if let (Some(oid), Some(uid)) = (org_id, user_id) {
            if let Ok(invite) = host_db::create_invite_code(conn, &oid, &uid, 10, 168, None) {
                return Some(invite.code);
            }
        }
        return None;
    }

    // First run — create admin user with random password, org, and invite
    use rand::Rng;
    let admin_pass: String = {
        let mut rng = rand::thread_rng();
        (0..16).map(|_| {
            let idx = rng.gen_range(0..36u8);
            if idx < 10 { (b'0' + idx) as char } else { (b'a' + idx - 10) as char }
        }).collect()
    };
    let password_hash = bcrypt::hash(&admin_pass, 12).unwrap_or_default();
    eprintln!("  First run — admin account created:");
    eprintln!("    Username: mothership");
    eprintln!("    Password: {}", admin_pass);
    eprintln!("    (save this — it won't be shown again)\n");
    let user = host_db::create_user(conn, "mothership", &password_hash, None).ok()?;
    let org = host_db::create_org(conn, "team", "Team").ok()?;
    let _ = host_db::add_org_member(conn, &org.id, &user.id, "owner");

    let raw_token = generate_api_token();
    let token_hash = hash_api_token(&raw_token);
    let _ = host_db::create_api_token(conn, &user.id, &org.id, &token_hash, "default");

    let invite = host_db::create_invite_code(conn, &org.id, &user.id, 10, 168, None).ok()?;
    Some(invite.code)
}

// ─── Tunnel Support ─────────────────────────────────────────────────────────

/// Spawn a tunnel subprocess and return the public URL.
pub fn spawn_tunnel(port: u16, tls: bool) -> Option<(std::process::Child, String)> {
    let scheme = if tls { "https" } else { "http" };
    let local_url = format!("{}://localhost:{}", scheme, port);

    // Priority 1: bore (open source, Rust, self-hostable relay)
    if let Ok(output) = std::process::Command::new("which").arg("bore").output() {
        if output.status.success() {
            eprintln!("  Tunnel: starting bore...");
            // bore local <port> --to bore.pub
            if let Ok(child) = std::process::Command::new("bore")
                .args(["local", &port.to_string(), "--to", "bore.pub"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                // bore prints the URL to stderr, give it a moment
                std::thread::sleep(std::time::Duration::from_secs(2));
                // bore assigns a random port on bore.pub
                // Format: bore.pub:<assigned_port>
                // We can't easily parse it from the running process,
                // so we'll read stderr
                return Some((child, "bore.pub:<check-output>".to_string()));
            }
        }
    }

    // Priority 2: cloudflared (Cloudflare, free, no account needed for quick tunnels)
    if let Ok(output) = std::process::Command::new("which").arg("cloudflared").output() {
        if output.status.success() {
            eprintln!("  Tunnel: starting cloudflared...");
            if let Ok(child) = std::process::Command::new("cloudflared")
                .args(["tunnel", "--url", &local_url])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                // cloudflared takes a few seconds to establish the tunnel
                std::thread::sleep(std::time::Duration::from_secs(4));
                return Some((child, "cloudflared (check output for URL)".to_string()));
            }
        }
    }

    None
}

// ─── Server Startup ─────────────────────────────────────────────────────────

fn build_app(state: Arc<MothershipState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any);

    let authed_routes = Router::new()
        .route("/auth/token", post(create_token))
        .route("/orgs", get(list_orgs).post(create_org))
        .route("/orgs/{slug}/members", post(add_member))
        .route("/orgs/{slug}/repos", get(list_repos).post(register_repo))
        .route("/live/events", post(ingest_live_events))
        .route("/live/heartbeat", post(heartbeat))
        .route("/live/presence", get(get_presence))
        .route("/live/impacts", get(get_impacts))
        .route("/live/impacts/resolve", post(resolve_impact))
        .route("/live/activity", get(get_activity))
        .route("/live/messages", get(get_messages).post(send_message))
        .route("/live/sync/push", post(sync_push))
        .route("/live/sync/pull", get(sync_pull))
        .route("/live/sync/status", get(sync_status))
        .route("/live/zones", get(get_zones).post(create_zone_handler))
        .route("/live/zones/check", get(check_zone))
        .route("/live/zones/{zone_id}", axum::routing::delete(delete_zone_handler))
        .route("/live/knowledge", get(query_knowledge_handler).post(store_knowledge_handler))
        .route("/live/knowledge/{id}/upvote", post(upvote_knowledge_handler))
        .route("/live/history", get(get_function_history))
        .route("/live/trace", get(trace_function_handler))
        .route("/live/merge", get(merge_branch_handler))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    Router::new()
        .route("/health", get(health_check))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/join", post(join_with_code))
        .route("/fingerprint", get(get_fingerprint))
        .nest("/api/v1", authed_routes)
        .with_state(state)
        .layer(cors)
}

/// Start the mothership server. Blocks until Ctrl+C.
/// - Always serves HTTPS with auto-generated self-signed cert
/// - If `tunnel` is true, spawns bore/cloudflared for NAT traversal
/// - If `no_tls` is true, falls back to plain HTTP (for local dev/testing)
pub async fn start_mothership(port: u16, tunnel: bool, no_tls: bool) -> Result<(), Box<dyn std::error::Error>> {
    // Write PID so `aura host stop` and `aura host status` can find us
    write_pid_file();

    // Clean up PID on graceful shutdown
    struct PidGuard;
    impl Drop for PidGuard { fn drop(&mut self) { remove_pid_file(); } }
    let _pid_guard = PidGuard;

    let db_path = format!("{}/mothership.db", dirs_path());
    let _ = std::fs::create_dir_all(&dirs_path());

    let conn = host_db::init_db(&db_path)?;
    let jwt_secret = load_or_create_jwt_secret();

    let state = Arc::new(MothershipState {
        db: Mutex::new(conn),
        jwt_secret,
    });

    // Auto-provision admin + invite on first run
    let invite_code = {
        let db = state.db.lock().unwrap();
        auto_provision_if_needed(&db)
    };

    let app = build_app(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let local_ip = detect_local_ip();

    if no_tls {
        // Plain HTTP mode
        let listener = tokio::net::TcpListener::bind(&addr).await?;

        let scheme = "http";
        let url = format!("{}://{}:{}", scheme, local_ip, port);

        println!("\n  Aura Mothership v0.10.0 online");
        println!("  Listening on 0.0.0.0:{}", port);
        println!("  Database: {}", db_path);
        println!("  WARNING: No encryption. Use TLS for internet.\n");

        if let Some(code) = &invite_code {
            let token = JoinToken { url: url.clone(), code: code.clone(), fp: String::new() };
            println!("  Peers join with:\n");
            println!("    aura join {}\n", token.encode());
        }

        if tunnel { let _tunnel_child = spawn_tunnel(port, false); }

        axum::serve(listener, app).await?;
    } else {
        // TLS mode (default)
        let (_cert_pem, _key_pem, fingerprint) = load_or_create_tls_cert()?;
        let cert_path = format!("{}/mothership_cert.pem", dirs_path());
        let key_path = format!("{}/mothership_key.pem", dirs_path());
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path).await?;

        let scheme = "https";
        let url = format!("{}://{}:{}", scheme, local_ip, port);

        println!("\n  Aura Mothership v0.10.0 online (TLS encrypted)");
        println!("  Listening on 0.0.0.0:{}", port);
        println!("  Database: {}", db_path);
        println!("  Fingerprint: {}\n", fingerprint);

        if let Some(code) = &invite_code {
            let token = JoinToken { url: url.clone(), code: code.clone(), fp: fingerprint.clone() };
            println!("  Peers join with:\n");
            println!("    aura join {}\n", token.encode());
        } else {
            println!("  Generate a join token: aura host invite\n");
        }

        if tunnel { let _tunnel_child = spawn_tunnel(port, true); }

        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service())
            .await?;
    }

    Ok(())
}

// ─── Fingerprint Endpoint ───────────────────────────────────────────────────

async fn get_fingerprint() -> Result<Json<serde_json::Value>, StatusCode> {
    let fp_path = format!("{}/mothership_fingerprint", dirs_path());
    let fingerprint = std::fs::read_to_string(&fp_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    Ok(Json(serde_json::json!({ "fingerprint": fingerprint })))
}

// ─── Health Check ───────────────────────────────────────────────────────────

async fn health_check() -> &'static str {
    "Aura Mothership is online."
}

// ─── Auth Endpoints ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
    password: String,
    email: Option<String>,
}

async fn register(
    State(state): State<Arc<MothershipState>>,
    ExtractJson(payload): ExtractJson<RegisterRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if payload.username.len() < 2 || payload.password.len() < 6 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state.db.lock().unwrap();

    if let Ok(Some(_)) = host_db::get_user_by_username(&db, &payload.username) {
        return Err(StatusCode::CONFLICT);
    }

    let password_hash = bcrypt::hash(&payload.password, 12)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = host_db::create_user(&db, &payload.username, &password_hash, payload.email.as_deref())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let slug = payload.username.to_lowercase();
    let org = host_db::create_org(&db, &slug, &payload.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _ = host_db::add_org_member(&db, &org.id, &user.id, "owner");

    let jwt = create_jwt(&state.jwt_secret, &user.id, &user.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let raw_token = generate_api_token();
    let token_hash = hash_api_token(&raw_token);
    let _ = host_db::create_api_token(&db, &user.id, &org.id, &token_hash, "default");

    Ok(Json(serde_json::json!({
        "status": "ok",
        "user_id": user.id,
        "username": user.username,
        "org_slug": slug,
        "jwt": jwt,
        "api_token": raw_token,
    })))
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<Arc<MothershipState>>,
    ExtractJson(payload): ExtractJson<LoginRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let user = host_db::get_user_by_username(&db, &payload.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let valid = bcrypt::verify(&payload.password, &user.password_hash)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !valid {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let jwt = create_jwt(&state.jwt_secret, &user.id, &user.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "status": "ok",
        "user_id": user.id,
        "username": user.username,
        "jwt": jwt,
    })))
}

// ─── Join with Invite Code (NEW) ────────────────────────────────────────────

#[derive(Deserialize)]
struct JoinRequest {
    code: String,
    username: String,
    password: String,
}

async fn join_with_code(
    State(state): State<Arc<MothershipState>>,
    ExtractJson(payload): ExtractJson<JoinRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if payload.username.len() < 2 || payload.password.len() < 6 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state.db.lock().unwrap();

    // Validate invite code
    let invite = host_db::validate_invite_code(&db, &payload.code)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // If invite is locked to a specific username, enforce it
    if let Some(ref required_name) = invite.for_username {
        if required_name != &payload.username {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    // Create user or get existing
    let user = if let Ok(Some(existing)) = host_db::get_user_by_username(&db, &payload.username) {
        // Verify password for existing user
        let valid = bcrypt::verify(&payload.password, &existing.password_hash)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !valid {
            return Err(StatusCode::UNAUTHORIZED);
        }
        existing
    } else {
        let password_hash = bcrypt::hash(&payload.password, 12)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        host_db::create_user(&db, &payload.username, &password_hash, None)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    // Add to invite's org
    let _ = host_db::add_org_member(&db, &invite.org_id, &user.id, "member");

    // Increment invite uses
    let _ = host_db::increment_invite_uses(&db, &payload.code);

    // Get org slug for response
    let org_slug = {
        let mut stmt = db.prepare("SELECT slug FROM organizations WHERE id = ?1").unwrap();
        let mut rows = stmt.query(rusqlite::params![invite.org_id]).unwrap();
        rows.next().unwrap().map(|r| r.get::<_, String>(0).unwrap_or_default()).unwrap_or_default()
    };

    // Generate JWT + API token
    let jwt = create_jwt(&state.jwt_secret, &user.id, &user.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let raw_token = generate_api_token();
    let token_hash = hash_api_token(&raw_token);
    let _ = host_db::create_api_token(&db, &user.id, &invite.org_id, &token_hash, "default");

    Ok(Json(serde_json::json!({
        "status": "ok",
        "user_id": user.id,
        "username": user.username,
        "org_slug": org_slug,
        "jwt": jwt,
        "api_token": raw_token,
    })))
}

// ─── Org/Repo Management ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateOrgRequest {
    slug: String,
    name: Option<String>,
}

async fn create_org(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<CreateOrgRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let name = payload.name.as_deref().unwrap_or(&payload.slug);
    let org = host_db::create_org(&db, &payload.slug, name)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = host_db::add_org_member(&db, &org.id, &auth.user_id, "owner");
    Ok(Json(serde_json::json!({ "status": "ok", "org": org })))
}

async fn list_orgs(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let orgs = host_db::get_user_orgs(&db, &auth.user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total = orgs.len();
    Ok(Json(serde_json::json!({ "orgs": orgs, "total": total })))
}

#[derive(Deserialize)]
struct AddMemberRequest {
    username: String,
    role: Option<String>,
}

async fn add_member(
    State(state): State<Arc<MothershipState>>,
    _auth: axum::Extension<TokenAuth>,
    Path(slug): Path<String>,
    ExtractJson(payload): ExtractJson<AddMemberRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let org = host_db::get_org_by_slug(&db, &slug)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let user = host_db::get_user_by_username(&db, &payload.username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let role = payload.role.as_deref().unwrap_or("member");
    let _ = host_db::add_org_member(&db, &org.id, &user.id, role);
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": format!("Added {} to {} as {}", payload.username, slug, role),
    })))
}

#[derive(Deserialize)]
struct RegisterRepoRequest {
    repo_name: String,
}

async fn register_repo(
    State(state): State<Arc<MothershipState>>,
    _auth: axum::Extension<TokenAuth>,
    Path(slug): Path<String>,
    ExtractJson(payload): ExtractJson<RegisterRepoRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let org = host_db::get_org_by_slug(&db, &slug)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let repo = host_db::upsert_repo(&db, &org.id, &payload.repo_name)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "status": "ok", "repo": repo })))
}

async fn list_repos(
    State(state): State<Arc<MothershipState>>,
    _auth: axum::Extension<TokenAuth>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let org = host_db::get_org_by_slug(&db, &slug)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let repos = host_db::get_org_repos(&db, &org.id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total = repos.len();
    Ok(Json(serde_json::json!({ "repos": repos, "total": total })))
}

#[derive(Deserialize)]
struct CreateTokenRequest {
    org_slug: String,
    label: Option<String>,
}

async fn create_token(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<CreateTokenRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let org = host_db::get_org_by_slug(&db, &payload.org_slug)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let raw_token = generate_api_token();
    let token_hash = hash_api_token(&raw_token);
    let label = payload.label.as_deref().unwrap_or("cli");
    let _ = host_db::create_api_token(&db, &auth.user_id, &org.id, &token_hash, label);
    Ok(Json(serde_json::json!({ "status": "ok", "token": raw_token })))
}

// ─── Live Event Ingestion + Impact Detection ────────────────────────────────

#[derive(Debug, Deserialize)]
struct LiveEventsRequest {
    repo_full_name: String,
    events: Vec<LiveEventData>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
struct LiveEventData {
    #[allow(dead_code)]
    event_id: Option<String>,
    branch: String,
    file_path: String,
    changes: Vec<FunctionChangeData>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
struct FunctionChangeData {
    name: String,
    kind: String,
    change_type: String,
    #[allow(dead_code)]
    old_hash: Option<String>,
    #[allow(dead_code)]
    new_hash: Option<String>,
    dependencies: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
struct ActiveFunctionData {
    name: String,
    kind: String,
    file_path: String,
    change_type: Option<String>,
}

async fn ingest_live_events(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<LiveEventsRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo = host_db::get_repo_by_name_and_org(&db, &payload.repo_full_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut ingested = 0;

    for event in &payload.events {
        let changes_json = serde_json::to_string(&event.changes).unwrap_or_default();

        if host_db::insert_live_event(&db, &auth.user_id, &repo.id, &event.branch, &event.file_path, &changes_json).is_ok() {
            ingested += 1;
        }

        // Update live_session presence
        let active_fns: Vec<ActiveFunctionData> = event.changes.iter().map(|c| {
            ActiveFunctionData {
                name: c.name.clone(), kind: c.kind.clone(),
                file_path: event.file_path.clone(), change_type: Some(c.change_type.clone()),
            }
        }).collect();
        let active_fns_json = serde_json::to_string(&active_fns).unwrap_or_default();
        let _ = host_db::upsert_live_session(&db, &auth.user_id, &auth.org_id, &repo.id, &event.branch, &active_fns_json);
    }

    // Impact detection
    let mut alerts_created = 0;
    for event in &payload.events {
        for change in &event.changes {
            if change.change_type != "modified" && change.change_type != "deleted" {
                continue;
            }

            let impacted = host_db::find_impacted_events(&db, &repo.id, &auth.user_id, &event.branch, &change.name)
                .unwrap_or_default();

            for (affected_user_id, affected_branch, _file_path, their_changes_str) in &impacted {
                let their_fns: Vec<FunctionChangeData> = serde_json::from_str(their_changes_str).unwrap_or_default();
                let mut affected_fns = Vec::new();

                for their_fn in &their_fns {
                    if let Some(deps) = &their_fn.dependencies {
                        if deps.iter().any(|d| d == &change.name) {
                            affected_fns.push(serde_json::json!({
                                "name": their_fn.name, "kind": their_fn.kind, "depends_on": change.name,
                            }));
                        }
                    }
                }

                if affected_fns.is_empty() { continue; }

                let existing = host_db::count_existing_alerts(&db, &repo.id, &auth.user_id, affected_user_id, &change.name)
                    .unwrap_or(0);
                if existing > 0 { continue; }

                let affected_fns_json = serde_json::to_string(&affected_fns).unwrap_or_default();
                let impact_type = if change.change_type == "deleted" { "deleted" } else { "modified" };

                if host_db::insert_impact_alert(&db, &repo.id, &auth.user_id, &event.branch, &change.name,
                    affected_user_id, affected_branch, &affected_fns_json, impact_type).is_ok()
                {
                    alerts_created += 1;
                }
            }
        }
    }

    Ok(Json(serde_json::json!({
        "status": "ok", "ingested": ingested, "impact_alerts": alerts_created,
    })))
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct HeartbeatRequest {
    repo_full_name: String,
    branch: String,
    active_functions: Option<Vec<ActiveFunctionData>>,
}

async fn heartbeat(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<HeartbeatRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo = host_db::get_repo_by_name_and_org(&db, &payload.repo_full_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let active_fns_json = payload.active_functions
        .as_ref()
        .map(|f| serde_json::to_string(f).unwrap_or_default())
        .unwrap_or_else(|| "[]".to_string());

    let _ = host_db::upsert_live_session(&db, &auth.user_id, &auth.org_id, &repo.id, &payload.branch, &active_fns_json);

    let pending_impacts = host_db::count_pending_impacts(&db, &auth.user_id).unwrap_or(0);
    let unread_messages = host_db::count_unread_messages(&db, &auth.user_id, &repo.id).unwrap_or(0);
    let sync_pending = host_db::count_sync_pending_for_heartbeat(&db, &repo.id, &payload.branch, &auth.user_id).unwrap_or(0);

    Ok(Json(serde_json::json!({
        "status": "ok",
        "pending_impacts": pending_impacts,
        "unread_messages": unread_messages,
        "sync_pending": sync_pending,
    })))
}

// ─── Presence ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PresenceQuery {
    repo: Option<String>,
}

async fn get_presence(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<PresenceQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let rows = host_db::get_presence(&db, &auth.org_id, params.repo.as_deref())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let developers: Vec<serde_json::Value> = rows.iter().map(|r| {
        let active_fns: serde_json::Value = serde_json::from_str(&r.active_functions).unwrap_or(serde_json::json!([]));
        serde_json::json!({
            "user_id": r.user_id, "username": r.username, "branch": r.branch,
            "repo": r.repo, "active_functions": active_fns,
            "last_seen": r.last_heartbeat, "started_at": r.started_at,
        })
    }).collect();
    let total = developers.len();

    Ok(Json(serde_json::json!({ "developers": developers, "total_active": total })))
}

// ─── Impacts ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ImpactsQuery {
    repo: Option<String>,
}

async fn get_impacts(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<ImpactsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let rows = host_db::get_impacts(&db, &auth.user_id, params.repo.as_deref())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let alerts: Vec<serde_json::Value> = rows.iter().map(|r| {
        let affected_fns: serde_json::Value = serde_json::from_str(&r.affected_functions).unwrap_or(serde_json::json!([]));
        let affected_names: Vec<String> = affected_fns.as_array()
            .map(|arr| arr.iter().filter_map(|f| f["name"].as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let suggestion = match r.impact_type.as_str() {
            "deleted" => format!(
                "Function '{}' was DELETED on branch '{}'. Your function(s) [{}] depend on it.",
                r.source_function, r.source_branch, affected_names.join(", ")
            ),
            _ => format!(
                "Function '{}' was modified on branch '{}'. Your function(s) [{}] depend on it.",
                r.source_function, r.source_branch, affected_names.join(", ")
            ),
        };
        serde_json::json!({
            "id": r.id, "source_user": r.source_user, "source_branch": r.source_branch,
            "source_function": r.source_function, "affected_functions": affected_fns,
            "impact_type": r.impact_type, "suggestion": suggestion, "created_at": r.created_at,
        })
    }).collect();
    let total = alerts.len();

    Ok(Json(serde_json::json!({ "alerts": alerts, "total": total })))
}

#[derive(Deserialize)]
struct ResolveAlertRequest {
    alert_id: String,
}

async fn resolve_impact(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<ResolveAlertRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let resolved = host_db::resolve_impact(&db, &payload.alert_id, &auth.user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !resolved { return Err(StatusCode::NOT_FOUND); }
    Ok(Json(serde_json::json!({ "status": "ok", "resolved": payload.alert_id })))
}

// ─── Activity ───────────────────────────────────────────────────────────────

async fn get_activity(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let rows = host_db::get_activity(&db, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let events: Vec<serde_json::Value> = rows.iter().map(|r| {
        let changes: serde_json::Value = serde_json::from_str(&r.changes).unwrap_or(serde_json::json!([]));
        serde_json::json!({
            "id": r.id, "user": r.username, "branch": r.branch,
            "file_path": r.file_path, "changes": changes, "created_at": r.created_at,
        })
    }).collect();
    let total = events.len();

    Ok(Json(serde_json::json!({ "events": events, "total": total })))
}

// ─── Messages ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SendMessageRequest {
    repo_full_name: String,
    branch: String,
    message: String,
    to: Option<String>,
}

async fn send_message(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<SendMessageRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo = host_db::get_repo_by_name_and_org(&db, &payload.repo_full_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let to_user_id: Option<String> = if let Some(ref username) = payload.to {
        host_db::get_user_by_username(&db, username)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map(|u| u.id)
    } else {
        None
    };

    let msg_id = host_db::send_message(&db, &repo.id, &auth.org_id, &auth.user_id, to_user_id.as_deref(), &payload.branch, &payload.message, false)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "id": msg_id })))
}

#[derive(Deserialize)]
struct MessagesQuery {
    repo: Option<String>,
    limit: Option<i64>,
}

async fn get_messages(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<MessagesQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let limit = params.limit.unwrap_or(20);

    let rows = host_db::get_messages(&db, &auth.org_id, &auth.user_id, params.repo.as_deref(), limit)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Mark as read
    let msg_ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    if !msg_ids.is_empty() {
        let _ = host_db::mark_messages_read(&db, &msg_ids, &auth.user_id);
    }

    let messages: Vec<serde_json::Value> = rows.iter().map(|r| {
        let mut msg = serde_json::json!({
            "id": r.id, "from": r.from_username, "branch": r.branch,
            "message": r.message, "is_agent": r.is_agent, "created_at": r.created_at,
        });
        if let Some(ref to) = r.to_username {
            msg["to"] = serde_json::json!(to);
        }
        msg
    }).collect();
    let total = messages.len();

    Ok(Json(serde_json::json!({ "messages": messages, "total": total })))
}

// ─── Function-Level Code Sync ───────────────────────────────────────────────

#[derive(Deserialize)]
struct SyncPushRequest {
    repo_full_name: String,
    branch: String,
    functions: Vec<SyncFunctionBody>,
}

#[derive(Deserialize)]
struct SyncFunctionBody {
    file_path: String,
    function_name: String,
    function_kind: String,
    content_hash: String,
    body: String,
}

async fn sync_push(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<SyncPushRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo = host_db::get_repo_by_name_and_org(&db, &payload.repo_full_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let mut upserted = 0;
    for func in &payload.functions {
        if host_db::upsert_function_body(
            &db, &repo.id, &payload.branch, &func.file_path,
            &func.function_name, &func.function_kind, &func.content_hash,
            &func.body, &auth.user_id,
        ).is_ok() {
            upserted += 1;
        }
    }

    Ok(Json(serde_json::json!({ "status": "ok", "pushed": upserted })))
}

#[derive(Deserialize)]
struct SyncPullQuery {
    repo: Option<String>,
    branch: Option<String>,
    since: Option<String>,
}

async fn sync_pull(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<SyncPullQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let branch = params.branch.as_deref().unwrap_or("main");

    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let cursor_time = if let Some(ref since) = params.since {
        since.clone()
    } else {
        host_db::get_sync_cursor(&db, &auth.user_id, &repo.id, branch)
            .unwrap_or(None)
            .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string())
    };

    let rows = host_db::pull_functions(&db, &repo.id, branch, &auth.user_id, &cursor_time)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let functions: Vec<serde_json::Value> = rows.iter().map(|r| {
        serde_json::json!({
            "id": r.id, "file_path": r.file_path, "function_name": r.function_name,
            "function_kind": r.function_kind, "content_hash": r.content_hash,
            "body": r.body, "pushed_by": r.pushed_by, "pushed_at": r.pushed_at,
        })
    }).collect();
    let total = functions.len();

    let now = chrono::Utc::now().to_rfc3339();
    let _ = host_db::upsert_sync_cursor(&db, &auth.user_id, &repo.id, branch, &now);

    Ok(Json(serde_json::json!({
        "status": "ok", "functions": functions, "total": total, "cursor": now,
    })))
}

#[derive(Deserialize)]
struct SyncStatusQuery {
    repo: Option<String>,
    branch: Option<String>,
}

async fn sync_status(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<SyncStatusQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let branch = params.branch.as_deref().unwrap_or("main");

    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let cursor_time = host_db::get_sync_cursor(&db, &auth.user_id, &repo.id, branch)
        .unwrap_or(None)
        .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string());

    let pending = host_db::count_pending_sync(&db, &repo.id, branch, &auth.user_id, &cursor_time).unwrap_or(0);
    let total = host_db::count_total_functions(&db, &repo.id, branch).unwrap_or(0);
    let active_pushers = host_db::count_active_pushers(&db, &repo.id, branch).unwrap_or(0);

    Ok(Json(serde_json::json!({
        "status": "ok",
        "pending_changes": pending,
        "total_synced_functions": total,
        "active_pushers": active_pushers,
        "cursor": cursor_time,
    })))
}

// ─── Sentinel Zone Handlers ────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateZoneRequest {
    repo_full_name: String,
    patterns: Vec<String>,
    #[serde(default = "default_zone_mode")]
    mode: String,
    label: Option<String>,
}
fn default_zone_mode() -> String { "warn".to_string() }

#[derive(Deserialize)]
struct ZoneQuery {
    repo: Option<String>,
}

#[derive(Deserialize)]
struct ZoneCheckQuery {
    repo: Option<String>,
    file_path: Option<String>,
}

async fn create_zone_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<CreateZoneRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo = host_db::get_repo_by_name_and_org(&db, &payload.repo_full_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let id = host_db::create_zone(&db, &auth.org_id, &repo.id, &auth.user_id, &payload.patterns, &payload.mode, payload.label.as_deref())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "zone_id": id })))
}

async fn get_zones(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<ZoneQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let zones = host_db::get_zones(&db, &repo.id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "zones": zones })))
}

async fn check_zone(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<ZoneCheckQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let file_path = params.file_path.as_deref().unwrap_or("");
    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let conflicts = host_db::check_zone_conflict(&db, &repo.id, &auth.user_id, file_path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let blocked = conflicts.iter().any(|z| z.mode == "block");

    Ok(Json(serde_json::json!({
        "status": "ok",
        "conflicts": conflicts,
        "blocked": blocked,
    })))
}

async fn delete_zone_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Path(zone_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let deleted = host_db::delete_zone(&db, &zone_id, &auth.user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "status": "ok", "deleted": deleted })))
}

// ─── Team Knowledge Handlers ───────────────────────────────────────────────

#[derive(Deserialize)]
struct StoreKnowledgeRequest {
    repo_full_name: Option<String>,
    category: Option<String>,
    question: String,
    answer: String,
    #[serde(default = "default_knowledge_source")]
    source: String,
    #[serde(default)]
    tags: Vec<String>,
}
fn default_knowledge_source() -> String { "agent".to_string() }

#[derive(Deserialize)]
struct KnowledgeQuery {
    search: Option<String>,
    category: Option<String>,
    repo: Option<String>,
    #[serde(default = "default_knowledge_limit")]
    limit: i64,
}
fn default_knowledge_limit() -> i64 { 20 }

async fn store_knowledge_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    ExtractJson(payload): ExtractJson<StoreKnowledgeRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo_id = if let Some(ref name) = payload.repo_full_name {
        host_db::get_repo_by_name_and_org(&db, name, &auth.org_id)
            .ok().flatten().map(|r| r.id)
    } else {
        None
    };

    let category = payload.category.as_deref().unwrap_or("general");
    let id = host_db::store_knowledge(&db, &auth.org_id, repo_id.as_deref(), &auth.user_id, category, &payload.question, &payload.answer, &payload.source, &payload.tags)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "id": id })))
}

async fn query_knowledge_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<KnowledgeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();

    let repo_id = if let Some(ref name) = params.repo {
        host_db::get_repo_by_name_and_org(&db, name, &auth.org_id)
            .ok().flatten().map(|r| r.id)
    } else {
        None
    };

    let results = host_db::query_knowledge(&db, &auth.org_id, params.search.as_deref(), params.category.as_deref(), repo_id.as_deref(), params.limit)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "results": results, "total": results.len() })))
}

async fn upvote_knowledge_handler(
    State(state): State<Arc<MothershipState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let upvoted = host_db::upvote_knowledge(&db, &id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "status": "ok", "upvoted": upvoted })))
}

// ─── Function History Handlers ─────────────────────────────────────────────

#[derive(Deserialize)]
struct HistoryQuery {
    repo: Option<String>,
    file: Option<String>,
    #[serde(default = "default_history_limit")]
    limit: i64,
}
fn default_history_limit() -> i64 { 50 }

async fn get_function_history(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let entries = host_db::query_function_history(&db, &repo.id, params.file.as_deref(), params.limit)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "entries": entries, "total": entries.len() })))
}

#[derive(Deserialize)]
struct TraceQuery {
    repo: Option<String>,
    function: Option<String>,
}

async fn trace_function_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<TraceQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let function_name = params.function.as_deref().unwrap_or("");
    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let entries = host_db::trace_function(&db, &repo.id, function_name)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "status": "ok", "entries": entries, "total": entries.len() })))
}

// ─── Merge Handler ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct MergeQuery {
    repo: Option<String>,
    source_branch: Option<String>,
}

async fn merge_branch_handler(
    State(state): State<Arc<MothershipState>>,
    auth: axum::Extension<TokenAuth>,
    Query(params): Query<MergeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().unwrap();
    let repo_name = params.repo.as_deref().unwrap_or("");
    let source_branch = params.source_branch.as_deref().unwrap_or("");
    let repo = host_db::get_repo_by_name_and_org(&db, repo_name, &auth.org_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let functions = host_db::pull_all_functions_on_branch(&db, &repo.id, source_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "status": "ok",
        "source_branch": source_branch,
        "functions": functions,
        "total": functions.len(),
    })))
}
