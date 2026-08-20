//! An agent that holds no key.
//!
//! This is the piece that lets a laptop with nothing on it open a connection
//! through the one spawn in [`super::super`]. `ssh` does not need a key *file* —
//! it needs something on the other end of an agent socket that can answer a
//! signing challenge. That is the same interface a hardware token uses, and it
//! is the reason a Yubikey works without the key ever being readable.
//!
//! So: a socket per place, served from this process, holding a public blob and a
//! grant. When the far side asks it to sign, it forwards the bytes to Aura,
//! which opens the sealed key and answers with 64 bytes. The signature crosses
//! the wire. The key does not, in either direction, ever.
//!
//! ## What an attacker who steals this laptop gets
//!
//! The socket, and whatever grants are still live behind it. There is no key
//! file to find, and there is nothing in this process's memory that would still
//! work tomorrow — a grant is minutes long, capped at a few dozen signatures,
//! bound to one place and one member, and revocable from the other side while it
//! is in use. An admin removing that member kills every one of them on the next
//! signature rather than at the next expiry.
//!
//! The socket itself is `0600` under `~/.aura/ssh`, not in `/tmp`: a socket
//! another local account can connect to is that account being able to open the
//! member's machines for as long as the grant lasts. That is a smaller window
//! than a stolen key file and it is still a window, so it is closed.
//!
//! ## Why the socket is bound before this function returns
//!
//! [`socket_for`] is called while argv is being assembled, and the far side
//! connects the instant that argv runs. Binding on a background task would be a
//! race that fails as "Error connecting to agent" on a fast machine and works on
//! a slow one — so the listener is bound synchronously and only the serving is
//! backgrounded.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use super::broker::{self, Connection};
use super::wire::{self, Ask};

/// How long a single agent connection may sit idle before it is dropped. The
/// far side opens one per authentication and asks its questions immediately; a
/// connection that has said nothing for this long is one nobody is coming back
/// to, and holding it open is a task pinned for the life of the process.
const IDLE: Duration = Duration::from_secs(60);

/// Sockets this process is already serving, by path. A place opened twice gets
/// the same socket rather than a second listener fighting for the same file.
fn listening() -> &'static Mutex<HashMap<String, ()>> {
    static LISTENING: OnceLock<Mutex<HashMap<String, ()>>> = OnceLock::new();
    LISTENING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The agent socket for a place, serving by the time this returns.
///
/// `None` means this laptop could not put one up — no home directory, a path too
/// long for a unix socket, a file in the way. The caller emits no identity at
/// all in that case rather than pointing the far side at a socket that is not
/// there, because "no key offered" is a clearer failure than "agent refused the
/// connection".
pub fn socket_for(machine_name: &str, key_ref: &str) -> Option<String> {
    let path = socket_path(key_ref)?;
    let mut open = listening().lock().ok()?;
    if open.contains_key(&path) {
        return Some(path);
    }

    // Anything at this path is ours from a previous run of this process — the
    // directory is Aura's own and mode 0700. A live socket would have been in
    // the map above, so what is here is a leftover, and bind fails on a file
    // that exists whether or not anything is listening on it.
    let _ = std::fs::remove_file(&path);
    let listener = std::os::unix::net::UnixListener::bind(&path).ok()?;
    listener.set_nonblocking(true).ok()?;
    // Before anything can connect: on both platforms this ships to, connecting
    // to a unix socket requires write permission on the file.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));

    let name = machine_name.to_string();
    let serving = path.clone();
    // Its own thread with its own runtime, rather than `tokio::spawn`: this is
    // reached from argv assembly, which is not async and has no runtime to
    // borrow. A place is opened rarely and the thread parks on `accept`, so the
    // cost is one idle thread per open place.
    std::thread::Builder::new()
        .name("aura-managed-key".into())
        .spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(serve(listener, name, serving));
        })
        .ok()?;

    open.insert(path.clone(), ());
    Some(path)
}

/// Where a place's socket lives.
///
/// Beside the ssh control sockets rather than in `/tmp`, for the same reason
/// those are: a socket in a world-writable directory is somebody else's
/// connection to take over.
///
/// Named by a hash of the reference rather than by the reference itself. A unix
/// socket path has a hard length limit — 104 bytes on macOS — that shows up as a
/// puzzling bind failure rather than a clear one, and `managed:` plus a uuid
/// plus a home directory is close enough to it to matter. A path that would
/// still be too long gives up here, and the caller says so.
fn socket_path(key_ref: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let dir = format!("{}/.aura/ssh", home.trim_end_matches('/'));
    std::fs::create_dir_all(&dir).ok()?;
    // The directory holds sockets that open machines. Nobody else's business.
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = format!("{dir}/k-{}.sock", short_hash(key_ref));
    (path.len() <= 92).then_some(path)
}

/// Sixteen hex characters that are stable for a reference and different for two
/// of them. Not a security boundary — the socket's permissions are that — just
/// a short, collision-shy name.
fn short_hash(of: &str) -> String {
    // FNV-1a, 64-bit. Written out rather than pulled in: it is four lines, and
    // the default hasher is explicitly not stable across releases, which would
    // silently orphan every socket on an upgrade.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in of.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Answer questions until the socket goes away.
async fn serve(listener: std::os::unix::net::UnixListener, machine_name: String, path: String) {
    let Ok(listener) = tokio::net::UnixListener::from_std(listener) else {
        return;
    };
    // One connection's worth of state, shared: two authentications in flight
    // should spend the same grant rather than mint one each.
    let held: Arc<AsyncMutex<Option<Connection>>> = Arc::new(AsyncMutex::new(None));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            // The socket is gone — the directory was cleared, or the file was
            // removed under us. Nothing to serve, and looping would spin. The
            // path comes off the register too, so the next open of this place
            // binds a fresh one instead of trusting a listener that has died.
            let _ = std::fs::remove_file(&path);
            if let Ok(mut open) = listening().lock() {
                open.remove(&path);
            }
            return;
        };
        let held = Arc::clone(&held);
        let name = machine_name.clone();
        tokio::spawn(async move {
            let _ = converse(stream, &name, &held).await;
        });
    }
}

/// One agent connection, from open to close.
async fn converse(
    mut stream: tokio::net::UnixStream,
    machine_name: &str,
    held: &AsyncMutex<Option<Connection>>,
) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        let body = match wire::take_frame(&mut buf) {
            Ok(Some(body)) => body,
            // Not a whole message yet: read more, or give up on a peer that has
            // stopped talking.
            Ok(None) => {
                let read = tokio::time::timeout(IDLE, stream.read(&mut chunk)).await;
                match read {
                    Ok(Ok(0)) | Err(_) => return Ok(()),
                    Ok(Ok(n)) => {
                        buf.extend_from_slice(&chunk[..n]);
                        continue;
                    }
                    Ok(Err(e)) => return Err(e),
                }
            }
            // A length that is not a length. Nothing further on this connection
            // can be trusted to be framed, so it ends rather than resynced.
            Err(_) => return Ok(()),
        };

        let answer = match wire::read(&body) {
            Ask::Identities => match live(held, machine_name, false).await {
                Some(c) => wire::identities_answer(&c.public_blob, &c.comment),
                None => wire::failure(),
            },
            Ask::Sign { key_blob, data } => match signature(held, machine_name, &key_blob, &data)
                .await
            {
                Some(signature) => wire::sign_response(&signature),
                None => wire::failure(),
            },
            Ask::Unsupported => wire::failure(),
        };
        stream.write_all(&answer).await?;
    }
}

/// A signature for one blob, renewing the grant once if it has run out.
///
/// The retry is not a nicety. A grant expires on a wall clock the far side knows
/// nothing about, and without this an authentication that happened to start six
/// minutes after the last one would fail as `Permission denied (publickey)` —
/// which reads as "the box does not trust this key" and sends somebody to
/// re-provision a machine that is working perfectly.
async fn signature(
    held: &AsyncMutex<Option<Connection>>,
    machine_name: &str,
    key_blob: &[u8],
    data: &[u8],
) -> Option<Vec<u8>> {
    let connection = live(held, machine_name, false).await?;
    // The far side asked for a key. Signing with a different one because it is
    // the one we happen to hold would be this agent lying about which machine it
    // opens.
    if connection.public_blob != key_blob {
        return None;
    }
    match broker::sign(&connection, data).await {
        Ok(signature) => {
            spend(held).await;
            Some(signature)
        }
        Err(why) if why == broker::SPENT => {
            let renewed = live(held, machine_name, true).await?;
            let signature = broker::sign(&renewed, data).await.ok()?;
            spend(held).await;
            Some(signature)
        }
        Err(_) => None,
    }
}

/// The connection this socket is currently spending, minting a new one when
/// there is none, when the last one is used up, or when the caller says so.
async fn live(
    held: &AsyncMutex<Option<Connection>>,
    machine_name: &str,
    renew: bool,
) -> Option<Connection> {
    let mut slot = held.lock().await;
    let stale = renew
        || slot
            .as_ref()
            .is_none_or(|c: &Connection| c.signatures_left <= 0);
    if stale {
        *slot = broker::connect(machine_name).await.ok();
    }
    slot.clone()
}

/// Count one signature off the budget this side believes it has.
async fn spend(held: &AsyncMutex<Option<Connection>>) {
    if let Some(connection) = held.lock().await.as_mut() {
        connection.signatures_left -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_is_named_for_its_place_and_not_after_it() {
        // Two places, two sockets. One place, the same socket every time — the
        // second open of a machine has to find the listener the first put up.
        let a = short_hash("managed:d290f1ee-6c54-4b01-90e6-d701748f0851");
        let b = short_hash("managed:550e8400-e29b-41d4-a716-446655440000");
        assert_ne!(a, b);
        assert_eq!(a, short_hash("managed:d290f1ee-6c54-4b01-90e6-d701748f0851"));
        assert_eq!(a.len(), 16);
        // And the reference is not spelled out in the path: a socket named
        // after a key is a key id in every `lsof` on the machine.
        assert!(!a.contains("managed"));
    }

    #[test]
    fn a_socket_path_stays_under_what_a_unix_socket_allows() {
        // The limit is 104 bytes on macOS and reports as a bind failure with no
        // useful words. A path that would breach it is refused here instead.
        let Some(path) = socket_path("managed:d290f1ee-6c54-4b01-90e6-d701748f0851") else {
            // No HOME in this environment: nothing to assert, and refusing is
            // exactly what the caller expects.
            return;
        };
        assert!(path.len() <= 92, "{path}");
        assert!(path.ends_with(".sock"), "{path}");
        assert!(path.contains("/.aura/ssh/"), "{path}");
    }

    #[test]
    fn the_socket_lives_beside_auras_own_state_and_not_in_tmp() {
        let Some(path) = socket_path("managed:x") else {
            return;
        };
        assert!(!path.starts_with("/tmp"), "{path}");
        assert!(!path.starts_with("/var/tmp"), "{path}");
        // The directory is Aura's, and it is created with the sockets in mind.
        let dir = std::path::Path::new(&path).parent().expect("a directory");
        let mode = std::fs::metadata(dir).expect("it exists").permissions().mode();
        assert_eq!(mode & 0o077, 0, "{dir:?} is readable by other accounts");
    }
}
