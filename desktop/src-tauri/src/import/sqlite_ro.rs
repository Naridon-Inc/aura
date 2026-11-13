//! Opening another app's SQLite database without touching it.
//!
//! These files belong to apps that may be running right now. We are a
//! reader and nothing else: the connection is read-only at the OS level, the
//! session is `query_only`, and no `-wal`/`-shm` file is ever created.
//!
//! Which flavour of read-only depends on the file:
//!
//! * A live WAL beside the database (non-empty `<db>-wal`) means the newest
//!   rows are still in the log. `mode=ro` reads through it the way any other
//!   reader would, so we see what the app sees.
//! * No WAL (or an empty one) means the database file is the whole truth.
//!   `immutable=1` reads it with no locking at all, so even an app holding a
//!   write lock is never blocked or noticed.
//!
//! If the first choice fails (a WAL that would need recovery, a missing
//! `-shm` we are not allowed to create) the other is tried.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// Percent-encode a filesystem path for a `file:` URI. "Application Support"
/// has a space; a path can hold `?` or `#`, which would end the path early.
fn uri_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len() + 8);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn has_live_wal(path: &Path) -> bool {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    std::fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false)
}

fn open_uri(uri: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(1500))?;
    conn.pragma_update(None, "query_only", true)?;
    // A cheap read proves the file is a database we can actually use; an open
    // alone succeeds on almost anything.
    conn.query_row("select count(*) from sqlite_master", [], |r| r.get::<_, i64>(0))?;
    Ok(conn)
}

/// Open `path` read-only, choosing `mode=ro` or `immutable=1` as above.
pub fn open(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(format!("{} isn't there", path.display()));
    }
    let base = format!("file:{}", uri_path(path));
    let ro = format!("{base}?mode=ro");
    let immutable = format!("{base}?immutable=1");
    let (first, second) = if has_live_wal(path) { (ro, immutable) } else { (immutable, ro) };
    open_uri(&first)
        .or_else(|_| open_uri(&second))
        .map_err(|e| format!("couldn't read {}: {e}", path.display()))
}

/// The table's column names, for sources whose schema has grown over time.
pub fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(&format!("pragma table_info(\"{}\")", table.replace('"', ""))) else {
        return Vec::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(1))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

pub fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "select 1 from sqlite_master where type = 'table' and name = ?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}
