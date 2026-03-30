// ─── Aura Mothership: SQLite Data Layer ─────────────────────────────────────
// Ported from aura-server (PostgreSQL/sqlx) to embedded rusqlite.
// Every table mirrors the aura-server schema but uses SQLite types:
//   UUID → TEXT, TIMESTAMPTZ → TEXT (ISO 8601), JSONB → TEXT, BOOLEAN → INTEGER

use chrono::Utc;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── Models ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub org_id: String,
    pub github_full_name: String,
    pub github_repo_id: Option<i64>,
    pub default_branch: String,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToken {
    pub id: String,
    pub user_id: String,
    pub org_id: String,
    pub token_hash: String,
    pub label: String,
    pub last_used: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteCode {
    pub id: String,
    pub code: String,
    pub org_id: String,
    pub created_by: String,
    pub max_uses: i32,
    pub uses: i32,
    pub expires_at: String,
    pub created_at: String,
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    email           TEXT,
    display_name    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
    org_id      TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    joined_at   TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS repos (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL,
    github_full_name TEXT NOT NULL,
    github_repo_id  INTEGER,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    UNIQUE (org_id, github_full_name)
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    org_id      TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL DEFAULT 'default',
    last_used   TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    org_id          TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    branch          TEXT NOT NULL,
    active_functions TEXT NOT NULL DEFAULT '[]',
    last_heartbeat  TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    UNIQUE (user_id, repo_id)
);

CREATE TABLE IF NOT EXISTS live_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    branch          TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    changes         TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impact_alerts (
    id              TEXT PRIMARY KEY,
    repo_id         TEXT NOT NULL,
    source_user_id  TEXT NOT NULL,
    source_branch   TEXT NOT NULL,
    source_function TEXT NOT NULL,
    affected_user_id TEXT NOT NULL,
    affected_branch TEXT NOT NULL,
    affected_functions TEXT NOT NULL DEFAULT '[]',
    impact_type     TEXT NOT NULL DEFAULT 'modified',
    resolved        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_messages (
    id              TEXT PRIMARY KEY,
    repo_id         TEXT NOT NULL,
    org_id          TEXT NOT NULL,
    from_user_id    TEXT NOT NULL,
    to_user_id      TEXT,
    branch          TEXT NOT NULL,
    message         TEXT NOT NULL,
    is_agent        INTEGER NOT NULL DEFAULT 0,
    read_by         TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS function_bodies (
    id              TEXT PRIMARY KEY,
    repo_id         TEXT NOT NULL,
    branch          TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    function_name   TEXT NOT NULL,
    function_kind   TEXT NOT NULL DEFAULT 'function',
    content_hash    TEXT NOT NULL,
    body            TEXT NOT NULL,
    pushed_by       TEXT NOT NULL,
    pushed_at       TEXT NOT NULL,
    UNIQUE (repo_id, branch, file_path, function_name)
);

CREATE TABLE IF NOT EXISTS sync_cursors (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    branch          TEXT NOT NULL,
    last_pulled_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
    UNIQUE (user_id, repo_id, branch)
);

CREATE TABLE IF NOT EXISTS invite_codes (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    org_id      TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    max_uses    INTEGER NOT NULL DEFAULT 5,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_repos_org ON repos(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_repo ON live_sessions(repo_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_org ON live_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_heartbeat ON live_sessions(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_live_events_repo ON live_events(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_events_user ON live_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impact_alerts_affected ON impact_alerts(affected_user_id, resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impact_alerts_repo ON impact_alerts(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_messages_repo ON team_messages(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_messages_to ON team_messages(to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_messages_org ON team_messages(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_function_bodies_repo_branch ON function_bodies(repo_id, branch);
CREATE INDEX IF NOT EXISTS idx_function_bodies_pushed_at ON function_bodies(pushed_at);
"#;

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_db(path: &str) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ─── User Queries ───────────────────────────────────────────────────────────

pub fn create_user(conn: &Connection, username: &str, password_hash: &str, email: Option<&str>) -> SqlResult<User> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO users (id, username, password_hash, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, username, password_hash, email, ts, ts],
    )?;
    Ok(User {
        id,
        username: username.to_string(),
        password_hash: password_hash.to_string(),
        email: email.map(|s| s.to_string()),
        display_name: None,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

pub fn get_user_by_username(conn: &Connection, username: &str) -> SqlResult<Option<User>> {
    let mut stmt = conn.prepare("SELECT id, username, password_hash, email, display_name, created_at, updated_at FROM users WHERE username = ?1")?;
    let mut rows = stmt.query(params![username])?;
    if let Some(row) = rows.next()? {
        Ok(Some(User {
            id: row.get(0)?,
            username: row.get(1)?,
            password_hash: row.get(2)?,
            email: row.get(3)?,
            display_name: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_user_by_id(conn: &Connection, id: &str) -> SqlResult<Option<User>> {
    let mut stmt = conn.prepare("SELECT id, username, password_hash, email, display_name, created_at, updated_at FROM users WHERE id = ?1")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(User {
            id: row.get(0)?,
            username: row.get(1)?,
            password_hash: row.get(2)?,
            email: row.get(3)?,
            display_name: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

// ─── Organization Queries ───────────────────────────────────────────────────

pub fn create_org(conn: &Connection, slug: &str, name: &str) -> SqlResult<Organization> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, updated_at = ?5",
        params![id, slug, name, ts, ts],
    )?;
    // Fetch back (may have been upserted with existing id)
    get_org_by_slug(conn, slug).map(|o| o.expect("org just created"))
}

pub fn get_org_by_slug(conn: &Connection, slug: &str) -> SqlResult<Option<Organization>> {
    let mut stmt = conn.prepare("SELECT id, slug, name, created_at, updated_at FROM organizations WHERE slug = ?1")?;
    let mut rows = stmt.query(params![slug])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Organization {
            id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_user_orgs(conn: &Connection, user_id: &str) -> SqlResult<Vec<Organization>> {
    let mut stmt = conn.prepare(
        "SELECT o.id, o.slug, o.name, o.created_at, o.updated_at FROM organizations o
         JOIN org_members om ON o.id = om.org_id WHERE om.user_id = ?1 ORDER BY o.name"
    )?;
    let rows = stmt.query_map(params![user_id], |row| {
        Ok(Organization {
            id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn add_org_member(conn: &Connection, org_id: &str, user_id: &str, role: &str) -> SqlResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, user_id) DO NOTHING",
        params![org_id, user_id, role, ts],
    )?;
    Ok(())
}

pub fn get_first_org_for_user(conn: &Connection, user_id: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT org_id FROM org_members WHERE user_id = ?1 LIMIT 1")?;
    let mut rows = stmt.query(params![user_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

// ─── Repo Queries ───────────────────────────────────────────────────────────

pub fn upsert_repo(conn: &Connection, org_id: &str, full_name: &str) -> SqlResult<Repo> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO repos (id, org_id, github_full_name, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, github_full_name) DO UPDATE SET github_full_name = excluded.github_full_name",
        params![id, org_id, full_name, ts],
    )?;
    get_repo_by_name_and_org(conn, full_name, org_id).map(|r| r.expect("repo just upserted"))
}

pub fn get_repo_by_name_and_org(conn: &Connection, full_name: &str, org_id: &str) -> SqlResult<Option<Repo>> {
    let mut stmt = conn.prepare(
        "SELECT id, org_id, github_full_name, github_repo_id, default_branch, is_active, created_at
         FROM repos WHERE github_full_name = ?1 AND org_id = ?2"
    )?;
    let mut rows = stmt.query(params![full_name, org_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Repo {
            id: row.get(0)?,
            org_id: row.get(1)?,
            github_full_name: row.get(2)?,
            github_repo_id: row.get(3)?,
            default_branch: row.get(4)?,
            is_active: row.get::<_, i32>(5)? != 0,
            created_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_org_repos(conn: &Connection, org_id: &str) -> SqlResult<Vec<Repo>> {
    let mut stmt = conn.prepare(
        "SELECT id, org_id, github_full_name, github_repo_id, default_branch, is_active, created_at
         FROM repos WHERE org_id = ?1 AND is_active = 1 ORDER BY github_full_name"
    )?;
    let rows = stmt.query_map(params![org_id], |row| {
        Ok(Repo {
            id: row.get(0)?,
            org_id: row.get(1)?,
            github_full_name: row.get(2)?,
            github_repo_id: row.get(3)?,
            default_branch: row.get(4)?,
            is_active: row.get::<_, i32>(5)? != 0,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

// ─── API Token Queries ──────────────────────────────────────────────────────

pub fn create_api_token(conn: &Connection, user_id: &str, org_id: &str, token_hash: &str, label: &str) -> SqlResult<ApiToken> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO api_tokens (id, user_id, org_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, user_id, org_id, token_hash, label, ts],
    )?;
    Ok(ApiToken {
        id,
        user_id: user_id.to_string(),
        org_id: org_id.to_string(),
        token_hash: token_hash.to_string(),
        label: label.to_string(),
        last_used: None,
        created_at: ts,
    })
}

pub fn get_token_by_hash(conn: &Connection, hash: &str) -> SqlResult<Option<ApiToken>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, org_id, token_hash, label, last_used, created_at FROM api_tokens WHERE token_hash = ?1"
    )?;
    let mut rows = stmt.query(params![hash])?;
    if let Some(row) = rows.next()? {
        let token = ApiToken {
            id: row.get(0)?,
            user_id: row.get(1)?,
            org_id: row.get(2)?,
            token_hash: row.get(3)?,
            label: row.get(4)?,
            last_used: row.get(5)?,
            created_at: row.get(6)?,
        };
        // Update last_used
        let _ = conn.execute("UPDATE api_tokens SET last_used = ?1 WHERE id = ?2", params![now(), token.id]);
        Ok(Some(token))
    } else {
        Ok(None)
    }
}

// ─── Live Session Queries ───────────────────────────────────────────────────

pub fn upsert_live_session(conn: &Connection, user_id: &str, org_id: &str, repo_id: &str, branch: &str, active_fns_json: &str) -> SqlResult<()> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO live_sessions (id, user_id, org_id, repo_id, branch, active_functions, last_heartbeat, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(user_id, repo_id) DO UPDATE SET
           branch = excluded.branch,
           active_functions = COALESCE(excluded.active_functions, live_sessions.active_functions),
           last_heartbeat = excluded.last_heartbeat",
        params![id, user_id, org_id, repo_id, branch, active_fns_json, ts, ts],
    )?;
    Ok(())
}

// ─── Live Event Queries ─────────────────────────────────────────────────────

pub fn insert_live_event(conn: &Connection, user_id: &str, repo_id: &str, branch: &str, file_path: &str, changes_json: &str) -> SqlResult<()> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO live_events (id, user_id, repo_id, branch, file_path, changes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, user_id, repo_id, branch, file_path, changes_json, ts],
    )?;
    Ok(())
}

/// Find events from other users on other branches that reference a function name (for impact detection).
/// Returns (user_id, branch, file_path, changes_json).
pub fn find_impacted_events(conn: &Connection, repo_id: &str, user_id: &str, branch: &str, fn_name: &str) -> SqlResult<Vec<(String, String, String, String)>> {
    let pattern = format!("%\"{}%", fn_name);
    let mut stmt = conn.prepare(
        "SELECT DISTINCT user_id, branch, file_path, changes FROM live_events
         WHERE repo_id = ?1 AND user_id != ?2 AND branch != ?3
           AND created_at > datetime('now', '-24 hours')
           AND changes LIKE ?4"
    )?;
    let rows = stmt.query_map(params![repo_id, user_id, branch, pattern], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    rows.collect()
}

pub fn count_existing_alerts(conn: &Connection, repo_id: &str, source_user_id: &str, affected_user_id: &str, source_fn: &str) -> SqlResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT COUNT(*) FROM impact_alerts
         WHERE repo_id = ?1 AND source_user_id = ?2 AND affected_user_id = ?3
           AND source_function = ?4 AND resolved = 0"
    )?;
    stmt.query_row(params![repo_id, source_user_id, affected_user_id, source_fn], |row| row.get(0))
}

pub fn insert_impact_alert(
    conn: &Connection, repo_id: &str, source_user_id: &str, source_branch: &str,
    source_fn: &str, affected_user_id: &str, affected_branch: &str,
    affected_fns_json: &str, impact_type: &str,
) -> SqlResult<()> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO impact_alerts (id, repo_id, source_user_id, source_branch, source_function,
         affected_user_id, affected_branch, affected_functions, impact_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, repo_id, source_user_id, source_branch, source_fn, affected_user_id, affected_branch, affected_fns_json, impact_type, ts],
    )?;
    Ok(())
}

// ─── Presence Queries ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PresenceRow {
    pub user_id: String,
    pub username: String,
    pub branch: String,
    pub repo: String,
    pub active_functions: String,
    pub last_heartbeat: String,
    pub started_at: String,
}

pub fn get_presence(conn: &Connection, org_id: &str, repo_name: Option<&str>) -> SqlResult<Vec<PresenceRow>> {
    let base = if let Some(rn) = repo_name {
        let mut stmt = conn.prepare(
            "SELECT ls.user_id, u.username, ls.branch, r.github_full_name, ls.active_functions, ls.last_heartbeat, ls.started_at
             FROM live_sessions ls
             JOIN users u ON u.id = ls.user_id
             JOIN repos r ON r.id = ls.repo_id
             WHERE ls.org_id = ?1 AND r.github_full_name = ?2
               AND ls.last_heartbeat > datetime('now', '-2 minutes')
             ORDER BY ls.last_heartbeat DESC"
        )?;
        let rows = stmt.query_map(params![org_id, rn], |row| {
            Ok(PresenceRow {
                user_id: row.get(0)?, username: row.get(1)?, branch: row.get(2)?,
                repo: row.get(3)?, active_functions: row.get(4)?,
                last_heartbeat: row.get(5)?, started_at: row.get(6)?,
            })
        })?;
        rows.collect::<SqlResult<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT ls.user_id, u.username, ls.branch, r.github_full_name, ls.active_functions, ls.last_heartbeat, ls.started_at
             FROM live_sessions ls
             JOIN users u ON u.id = ls.user_id
             JOIN repos r ON r.id = ls.repo_id
             WHERE ls.org_id = ?1
               AND ls.last_heartbeat > datetime('now', '-2 minutes')
             ORDER BY ls.last_heartbeat DESC"
        )?;
        let rows = stmt.query_map(params![org_id], |row| {
            Ok(PresenceRow {
                user_id: row.get(0)?, username: row.get(1)?, branch: row.get(2)?,
                repo: row.get(3)?, active_functions: row.get(4)?,
                last_heartbeat: row.get(5)?, started_at: row.get(6)?,
            })
        })?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };
    Ok(base)
}

// ─── Impact Queries ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ImpactRow {
    pub id: String,
    pub source_user: String,
    pub source_branch: String,
    pub source_function: String,
    pub affected_functions: String,
    pub impact_type: String,
    pub created_at: String,
}

pub fn get_impacts(conn: &Connection, user_id: &str, repo_name: Option<&str>) -> SqlResult<Vec<ImpactRow>> {
    if let Some(rn) = repo_name {
        let mut stmt = conn.prepare(
            "SELECT ia.id, u.username, ia.source_branch, ia.source_function,
                    ia.affected_functions, ia.impact_type, ia.created_at
             FROM impact_alerts ia
             JOIN users u ON u.id = ia.source_user_id
             JOIN repos r ON r.id = ia.repo_id
             WHERE ia.affected_user_id = ?1 AND ia.resolved = 0
               AND r.github_full_name = ?2
             ORDER BY ia.created_at DESC LIMIT 50"
        )?;
        let rows = stmt.query_map(params![user_id, rn], |row| {
            Ok(ImpactRow {
                id: row.get(0)?, source_user: row.get(1)?, source_branch: row.get(2)?,
                source_function: row.get(3)?, affected_functions: row.get(4)?,
                impact_type: row.get(5)?, created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    } else {
        let mut stmt = conn.prepare(
            "SELECT ia.id, u.username, ia.source_branch, ia.source_function,
                    ia.affected_functions, ia.impact_type, ia.created_at
             FROM impact_alerts ia
             JOIN users u ON u.id = ia.source_user_id
             WHERE ia.affected_user_id = ?1 AND ia.resolved = 0
             ORDER BY ia.created_at DESC LIMIT 50"
        )?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(ImpactRow {
                id: row.get(0)?, source_user: row.get(1)?, source_branch: row.get(2)?,
                source_function: row.get(3)?, affected_functions: row.get(4)?,
                impact_type: row.get(5)?, created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }
}

pub fn resolve_impact(conn: &Connection, alert_id: &str, user_id: &str) -> SqlResult<bool> {
    let changed = conn.execute(
        "UPDATE impact_alerts SET resolved = 1 WHERE id = ?1 AND affected_user_id = ?2",
        params![alert_id, user_id],
    )?;
    Ok(changed > 0)
}

pub fn count_pending_impacts(conn: &Connection, user_id: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM impact_alerts WHERE affected_user_id = ?1 AND resolved = 0",
        params![user_id],
        |row| row.get(0),
    )
}

// ─── Activity Queries ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ActivityRow {
    pub id: String,
    pub username: String,
    pub branch: String,
    pub file_path: String,
    pub changes: String,
    pub created_at: String,
}

pub fn get_activity(conn: &Connection, org_id: &str) -> SqlResult<Vec<ActivityRow>> {
    let mut stmt = conn.prepare(
        "SELECT le.id, u.username, le.branch, le.file_path, le.changes, le.created_at
         FROM live_events le
         JOIN users u ON u.id = le.user_id
         JOIN repos r ON r.id = le.repo_id
         WHERE r.org_id = ?1
         ORDER BY le.created_at DESC LIMIT 100"
    )?;
    let rows = stmt.query_map(params![org_id], |row| {
        Ok(ActivityRow {
            id: row.get(0)?, username: row.get(1)?, branch: row.get(2)?,
            file_path: row.get(3)?, changes: row.get(4)?, created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ─── Message Queries ────────────────────────────────────────────────────────

pub fn send_message(
    conn: &Connection, repo_id: &str, org_id: &str, from_user_id: &str,
    to_user_id: Option<&str>, branch: &str, message: &str, is_agent: bool,
) -> SqlResult<String> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO team_messages (id, repo_id, org_id, from_user_id, to_user_id, branch, message, is_agent, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, repo_id, org_id, from_user_id, to_user_id, branch, message, is_agent as i32, ts],
    )?;
    Ok(id)
}

#[derive(Debug, Serialize)]
pub struct MessageRow {
    pub id: String,
    pub from_username: String,
    pub to_username: Option<String>,
    pub branch: String,
    pub message: String,
    pub is_agent: bool,
    pub created_at: String,
}

pub fn get_messages(conn: &Connection, org_id: &str, user_id: &str, repo_name: Option<&str>, limit: i64) -> SqlResult<Vec<MessageRow>> {
    let limit = limit.min(100);
    if let Some(rn) = repo_name {
        let mut stmt = conn.prepare(
            "SELECT tm.id, u_from.username, u_to.username, tm.branch, tm.message, tm.is_agent, tm.created_at
             FROM team_messages tm
             JOIN users u_from ON u_from.id = tm.from_user_id
             LEFT JOIN users u_to ON u_to.id = tm.to_user_id
             JOIN repos r ON r.id = tm.repo_id
             WHERE tm.org_id = ?1 AND r.github_full_name = ?2
               AND (tm.to_user_id IS NULL OR tm.to_user_id = ?3 OR tm.from_user_id = ?3)
             ORDER BY tm.created_at DESC LIMIT ?4"
        )?;
        let rows = stmt.query_map(params![org_id, rn, user_id, limit], |row| {
            Ok(MessageRow {
                id: row.get(0)?, from_username: row.get(1)?, to_username: row.get(2)?,
                branch: row.get(3)?, message: row.get(4)?,
                is_agent: row.get::<_, i32>(5)? != 0, created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    } else {
        let mut stmt = conn.prepare(
            "SELECT tm.id, u_from.username, u_to.username, tm.branch, tm.message, tm.is_agent, tm.created_at
             FROM team_messages tm
             JOIN users u_from ON u_from.id = tm.from_user_id
             LEFT JOIN users u_to ON u_to.id = tm.to_user_id
             WHERE tm.org_id = ?1
               AND (tm.to_user_id IS NULL OR tm.to_user_id = ?2 OR tm.from_user_id = ?2)
             ORDER BY tm.created_at DESC LIMIT ?3"
        )?;
        let rows = stmt.query_map(params![org_id, user_id, limit], |row| {
            Ok(MessageRow {
                id: row.get(0)?, from_username: row.get(1)?, to_username: row.get(2)?,
                branch: row.get(3)?, message: row.get(4)?,
                is_agent: row.get::<_, i32>(5)? != 0, created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }
}

/// Mark messages as read by appending user_id to the read_by JSON array.
pub fn mark_messages_read(conn: &Connection, msg_ids: &[String], user_id: &str) -> SqlResult<()> {
    for msg_id in msg_ids {
        // Fetch current read_by
        let current: String = conn.query_row(
            "SELECT read_by FROM team_messages WHERE id = ?1",
            params![msg_id],
            |row| row.get(0),
        ).unwrap_or_else(|_| "[]".to_string());

        let mut readers: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
        if !readers.contains(&user_id.to_string()) {
            readers.push(user_id.to_string());
            let updated = serde_json::to_string(&readers).unwrap_or_else(|_| "[]".to_string());
            let _ = conn.execute(
                "UPDATE team_messages SET read_by = ?1 WHERE id = ?2",
                params![updated, msg_id],
            );
        }
    }
    Ok(())
}

pub fn count_unread_messages(conn: &Connection, user_id: &str, repo_id: &str) -> SqlResult<i64> {
    let pattern = format!("%\"{}%", user_id);
    conn.query_row(
        "SELECT COUNT(*) FROM team_messages
         WHERE repo_id = ?1 AND from_user_id != ?2
           AND (to_user_id IS NULL OR to_user_id = ?2)
           AND read_by NOT LIKE ?3
           AND created_at > datetime('now', '-24 hours')",
        params![repo_id, user_id, pattern],
        |row| row.get(0),
    )
}

// ─── Function Sync Queries ──────────────────────────────────────────────────

pub fn upsert_function_body(
    conn: &Connection, repo_id: &str, branch: &str, file_path: &str,
    fn_name: &str, fn_kind: &str, content_hash: &str, body: &str, pushed_by: &str,
) -> SqlResult<()> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO function_bodies (id, repo_id, branch, file_path, function_name, function_kind, content_hash, body, pushed_by, pushed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(repo_id, branch, file_path, function_name) DO UPDATE SET
           content_hash = excluded.content_hash,
           body = excluded.body,
           function_kind = excluded.function_kind,
           pushed_by = excluded.pushed_by,
           pushed_at = excluded.pushed_at",
        params![id, repo_id, branch, file_path, fn_name, fn_kind, content_hash, body, pushed_by, ts],
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct FunctionRow {
    pub id: String,
    pub file_path: String,
    pub function_name: String,
    pub function_kind: String,
    pub content_hash: String,
    pub body: String,
    pub pushed_by: String,
    pub pushed_at: String,
}

pub fn pull_functions(conn: &Connection, repo_id: &str, branch: &str, user_id: &str, cursor_time: &str) -> SqlResult<Vec<FunctionRow>> {
    let mut stmt = conn.prepare(
        "SELECT fb.id, fb.file_path, fb.function_name, fb.function_kind,
                fb.content_hash, fb.body, u.username, fb.pushed_at
         FROM function_bodies fb
         JOIN users u ON u.id = fb.pushed_by
         WHERE fb.repo_id = ?1 AND fb.branch = ?2 AND fb.pushed_by != ?3 AND fb.pushed_at > ?4
         ORDER BY fb.pushed_at ASC LIMIT 200"
    )?;
    let rows = stmt.query_map(params![repo_id, branch, user_id, cursor_time], |row| {
        Ok(FunctionRow {
            id: row.get(0)?, file_path: row.get(1)?, function_name: row.get(2)?,
            function_kind: row.get(3)?, content_hash: row.get(4)?, body: row.get(5)?,
            pushed_by: row.get(6)?, pushed_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_sync_cursor(conn: &Connection, user_id: &str, repo_id: &str, branch: &str, pulled_at: &str) -> SqlResult<()> {
    let id = new_id();
    conn.execute(
        "INSERT INTO sync_cursors (id, user_id, repo_id, branch, last_pulled_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, repo_id, branch) DO UPDATE SET last_pulled_at = excluded.last_pulled_at",
        params![id, user_id, repo_id, branch, pulled_at],
    )?;
    Ok(())
}

pub fn get_sync_cursor(conn: &Connection, user_id: &str, repo_id: &str, branch: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT last_pulled_at FROM sync_cursors WHERE user_id = ?1 AND repo_id = ?2 AND branch = ?3")?;
    let mut rows = stmt.query(params![user_id, repo_id, branch])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn count_pending_sync(conn: &Connection, repo_id: &str, branch: &str, user_id: &str, cursor_time: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM function_bodies
         WHERE repo_id = ?1 AND branch = ?2 AND pushed_by != ?3 AND pushed_at > ?4",
        params![repo_id, branch, user_id, cursor_time],
        |row| row.get(0),
    )
}

pub fn count_total_functions(conn: &Connection, repo_id: &str, branch: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM function_bodies WHERE repo_id = ?1 AND branch = ?2",
        params![repo_id, branch],
        |row| row.get(0),
    )
}

pub fn count_active_pushers(conn: &Connection, repo_id: &str, branch: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COUNT(DISTINCT pushed_by) FROM function_bodies
         WHERE repo_id = ?1 AND branch = ?2 AND pushed_at > datetime('now', '-5 minutes')",
        params![repo_id, branch],
        |row| row.get(0),
    )
}

/// Count sync pending using the COALESCE subquery pattern from the heartbeat handler.
pub fn count_sync_pending_for_heartbeat(conn: &Connection, repo_id: &str, branch: &str, user_id: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM function_bodies
         WHERE repo_id = ?1 AND branch = ?2 AND pushed_by != ?3
           AND pushed_at > COALESCE(
             (SELECT last_pulled_at FROM sync_cursors WHERE user_id = ?3 AND repo_id = ?1 AND branch = ?2),
             '1970-01-01T00:00:00+00:00'
           )",
        params![repo_id, branch, user_id],
        |row| row.get(0),
    )
}

// ─── Invite Code Queries ────────────────────────────────────────────────────

pub fn create_invite_code(conn: &Connection, org_id: &str, created_by: &str, max_uses: i32, expires_hours: i64) -> SqlResult<InviteCode> {
    use rand::Rng;
    let id = new_id();
    let ts = now();
    let code: String = {
        let mut rng = rand::thread_rng();
        (0..8).map(|_| {
            let idx = rng.gen_range(0..36);
            if idx < 10 { (b'0' + idx) as char } else { (b'a' + idx - 10) as char }
        }).collect()
    };
    let expires_at = (Utc::now() + chrono::Duration::hours(expires_hours)).to_rfc3339();
    conn.execute(
        "INSERT INTO invite_codes (id, code, org_id, created_by, max_uses, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, code, org_id, created_by, max_uses, expires_at, ts],
    )?;
    Ok(InviteCode {
        id, code, org_id: org_id.to_string(), created_by: created_by.to_string(),
        max_uses, uses: 0, expires_at, created_at: ts,
    })
}

pub fn validate_invite_code(conn: &Connection, code: &str) -> SqlResult<Option<InviteCode>> {
    let mut stmt = conn.prepare(
        "SELECT id, code, org_id, created_by, max_uses, uses, expires_at, created_at
         FROM invite_codes WHERE code = ?1 AND uses < max_uses AND expires_at > datetime('now')"
    )?;
    let mut rows = stmt.query(params![code])?;
    if let Some(row) = rows.next()? {
        Ok(Some(InviteCode {
            id: row.get(0)?, code: row.get(1)?, org_id: row.get(2)?,
            created_by: row.get(3)?, max_uses: row.get(4)?, uses: row.get(5)?,
            expires_at: row.get(6)?, created_at: row.get(7)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn increment_invite_uses(conn: &Connection, code: &str) -> SqlResult<()> {
    conn.execute("UPDATE invite_codes SET uses = uses + 1 WHERE code = ?1", params![code])?;
    Ok(())
}

/// Count total registered users (for status display).
pub fn count_users(conn: &Connection) -> SqlResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
}

/// Count total repos (for status display).
pub fn count_repos(conn: &Connection) -> SqlResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM repos", [], |row| row.get(0))
}
