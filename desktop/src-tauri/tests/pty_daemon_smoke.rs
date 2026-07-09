//! End-to-end smoke test for the PTY daemon (T3.1).
//!
//! Spins up the daemon's accept loop in-process (no separate binary
//! exec), opens a PTY child running `cat`, writes a line, and reads
//! it back via the subscribe channel. Validates the wire protocol
//! and the daemon's per-session reader thread + broadcast fan-out
//! at once.
//!
//! Tagged `serial` is unnecessary — each invocation overrides HOME
//! to a fresh tempdir, so the daemon's socket / pid paths are
//! isolated and parallel runs don't collide.

use aura_shell_lib::pty_daemon;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_roundtrips_a_pty_session() {
    // Isolate HOME so socket_path() lands in a tempdir.
    let tmp = tempfile::tempdir().expect("tempdir");
    // SAFETY: this test owns its tokio runtime; no other thread
    // reads HOME concurrently. If we add parallel HOME-reading tests
    // later, gate this on a Mutex.
    unsafe {
        std::env::set_var("HOME", tmp.path());
    }

    let reg = pty_daemon::server::Registry::new();
    let server_handle = tokio::spawn({
        let reg = reg.clone();
        async move {
            // serve_forever loops; we let the test runtime drop it
            // when this task is aborted at the end of the test.
            let _ = pty_daemon::server::serve_forever(reg).await;
        }
    });

    // Wait for socket to appear.
    let sock_path = pty_daemon::proto::socket_path().expect("HOME set above");
    for _ in 0..40 {
        if sock_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        sock_path.exists(),
        "daemon never bound socket at {}",
        sock_path.display()
    );

    // Ping → Pong.
    let mut sock = tokio::net::UnixStream::connect(&sock_path)
        .await
        .expect("connect");
    pty_daemon::client::send(&mut sock, &pty_daemon::proto::Request::Ping)
        .await
        .expect("send ping");
    let resp = pty_daemon::client::recv_response(&mut sock)
        .await
        .expect("recv pong");
    assert!(
        matches!(resp, pty_daemon::proto::Response::Pong),
        "expected Pong, got {resp:?}"
    );
    drop(sock);

    // Open a `cat` PTY.
    let session_id = pty_daemon::client::open_session(pty_daemon::proto::OpenReq {
        agent_id: "test".into(),
        repo_root: tmp.path().to_string_lossy().into_owned(),
        bin: "/bin/cat".into(),
        args: vec![],
        env: vec![],
        cols: 80,
        rows: 24,
        kind: pty_daemon::proto::SessionKind::Agent,
        label: None,
        cwd: None,
    })
    .await
    .expect("open cat session");
    assert!(!session_id.is_empty());

    // Subscribe BEFORE writing — `cat` echoes back when input ends
    // with newline; if we wrote first the reader thread might race
    // ahead of our subscribe.
    let mut sub = pty_daemon::client::subscribe(&session_id)
        .await
        .expect("subscribe");

    // Write "hello\n".
    pty_daemon::client::write_session(&session_id, b"hello\n")
        .await
        .expect("write");

    // Drain Bytes events until we see "hello" — `cat` echoes the
    // input, then waits for more. We bail after a few seconds so a
    // misbehaving daemon doesn't hang the test forever.
    let mut accumulated = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(250), pty_daemon::client::recv_event(&mut sub)).await {
            Ok(Ok(pty_daemon::proto::Event::Bytes { data, .. })) => {
                accumulated.extend_from_slice(&data);
                if accumulated.windows(5).any(|w| w == b"hello") {
                    break;
                }
            }
            Ok(Ok(pty_daemon::proto::Event::Exit { .. })) => {
                panic!("cat exited prematurely");
            }
            Ok(Err(e)) => panic!("subscribe recv: {e}"),
            Err(_) => {} // timeout, loop and try again
        }
    }
    assert!(
        accumulated.windows(5).any(|w| w == b"hello"),
        "expected echo of 'hello' in output; got {:?}",
        String::from_utf8_lossy(&accumulated),
    );

    // Close.
    pty_daemon::client::close_session(&session_id)
        .await
        .expect("close");

    server_handle.abort();
}
