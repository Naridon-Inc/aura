//! The claim, tested against the operating system rather than against a string.
//!
//! Everything else in this crate can be checked by reading what it produces —
//! is the deny before the allow, is every nftables rule scoped to the group, is
//! the port on the list. None of that proves the thing the feature is for. This
//! file starts a real process behind the real wall and watches it fail to leave,
//! and starts the same process without the wall and watches it succeed, because
//! **the difference between the two phases is the whole product** and a test that
//! only reads the profile would still pass if `sandbox-exec` ignored it.
//!
//! ## How a test gets a process behind the wall
//!
//! It re-runs itself. `current_exe()` is this test binary, and running it with
//! `--exact probe` and `AURA_EGRESS_PROBE` set makes it do one socket operation
//! and print the result. That is a great deal less machinery than shipping a
//! second helper binary, and it means the probe is compiled by the same
//! `cargo test` that runs the assertions — there is no separate thing to keep in
//! step.
//!
//! ## What runs where
//!
//! The live wall is macOS's, because that is the one a test can put up: it needs
//! no root, no daemon and leaves nothing behind. Linux's needs `nft`, a group,
//! and root to create both — which is right for a runner and impossible for a
//! unit test — so what a Linux run checks is the ruleset it *would* install
//! (`wall::tests`), and it says so out loud rather than passing quietly.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::process::Command;
use std::time::Duration;

use aura_egress::journal::Journal;
use aura_egress::policy::{Allowed, Egress, Endpoint, Reason};
use aura_egress::{wall, Broker, Report};

/// One socket operation, run in whatever process the caller put it in.
///
/// This is a `#[test]` so the harness will run it by name; with nothing in the
/// environment it is a no-op, which is what it does during an ordinary run of
/// the suite.
#[test]
fn probe() {
    let Ok(spec) = std::env::var("AURA_EGRESS_PROBE") else {
        return;
    };
    let parts: Vec<&str> = spec.split_whitespace().collect();
    let (kind, host, port) = (
        parts[0],
        parts[1],
        parts[2].parse::<u16>().expect("a port to probe"),
    );
    println!("PROBE {}", attempt(kind, host, port));
}

/// The result of one attempt, in a word the outer test can assert on.
///
/// `denied` is kept apart from every other failure deliberately. A connection
/// the kernel refuses on the wall's say-so comes back `EPERM`; one that failed
/// because nothing was listening, or because the address is unroutable, comes
/// back as something else. Collapsing the two would let a test pass on a laptop
/// with no network at all, which is precisely the wrong thing to be relaxed
/// about.
fn attempt(kind: &str, host: &str, port: u16) -> String {
    let outcome = match kind {
        "tcp" => TcpStream::connect_timeout(
            &format!("{host}:{port}").parse().expect("an address"),
            Duration::from_secs(2),
        )
        .map(|_| ()),
        "udp" => UdpSocket::bind("127.0.0.1:0")
            .and_then(|s| s.send_to(b"quic-would-go-here", (host, port)))
            .map(|_| ()),
        // Out through the broker, the way anything behind the wall has to go.
        "proxy" => return through_the_broker(port, host),
        other => panic!("{other} is not a probe"),
    };
    match outcome {
        Ok(()) => "reached".to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "denied".to_string(),
        Err(e) => format!("failed:{:?}", e.kind()),
    }
}

/// Ask the broker on `broker_port` for `target`, and report the status it gave.
fn through_the_broker(broker_port: u16, target: &str) -> String {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", broker_port)) else {
        return "unreachable-broker".to_string();
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    if stream
        .write_all(format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes())
        .is_err()
    {
        return "unwritable-broker".to_string();
    }
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer
        .split_whitespace()
        .nth(1)
        .unwrap_or("no-answer")
        .to_string()
}

/// Run the probe in a fresh process, optionally behind the wall.
fn probe_in(phase: Phase, kind: &str, host: &str, port: u16) -> String {
    let exe = std::env::current_exe().expect("this test binary");
    let mut command = match phase {
        Phase::Setup => Command::new(&exe),
        Phase::Agent { ref profile } => {
            let mut c = Command::new("sandbox-exec");
            c.arg("-f").arg(profile).arg(&exe);
            c
        }
    };
    let out = command
        .args(["probe", "--exact", "--nocapture"])
        .env("AURA_EGRESS_PROBE", format!("{kind} {host} {port}"))
        .output()
        .expect("a probe");
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find_map(|l| l.strip_prefix("PROBE "))
        .unwrap_or_else(|| panic!("the probe said nothing: {text}{}", String::from_utf8_lossy(&out.stderr)))
        .trim()
        .to_string()
}

enum Phase {
    Setup,
    Agent { profile: std::path::PathBuf },
}

/// The agent phase's wall, written where `sandbox-exec` can read it.
fn wall_up() -> Option<Phase> {
    if !cfg!(target_os = "macos") || which("sandbox-exec").is_none() {
        eprintln!(
            "note: the live wall is only put up on macOS, where it needs no root. \
             On this machine the agent phase is covered by `wall::tests` — the ruleset \
             that would be installed — and not by a running process."
        );
        return None;
    }
    let profile = std::env::temp_dir().join(format!("aura-egress-{}.sb", std::process::id()));
    std::fs::write(&profile, wall::seatbelt_profile()).expect("a profile");
    Some(Phase::Agent { profile })
}

fn which(bin: &str) -> Option<()> {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {bin}"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| ())
}

/// A machine that answers, standing in for whatever the work talks to.
fn origin() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("an origin");
    let port = listener.local_addr().expect("an address").port();
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(mut stream) = incoming else { continue };
            std::thread::spawn(move || {
                let mut chunk = [0u8; 512];
                let _ = stream.read(&mut chunk);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
            });
        }
    });
    port
}

/// A UDP socket that is listening, so a refusal is the wall's doing and not the
/// absence of anything to talk to.
fn udp_origin() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("a udp origin");
    let port = socket.local_addr().expect("an address").port();
    std::thread::spawn(move || {
        let mut buf = [0u8; 64];
        while socket.recv_from(&mut buf).is_ok() {}
    });
    port
}

/// An address on no route out of here: what an exfiltration attempt looks like
/// to a test that must not touch the internet.
const ELSEWHERE: &str = "169.254.169.254";

#[test]
fn the_setup_phase_installs_and_the_agent_phase_cannot_exfiltrate() {
    let registry = origin();
    let Some(agent) = wall_up() else { return };

    // --- setup phase: the network, because installing is what a network is for.
    assert_eq!(
        probe_in(Phase::Setup, "tcp", "127.0.0.1", registry),
        "reached",
        "the setup phase could not reach the machine it installs from"
    );

    // --- agent phase: the same call, and it does not leave.
    //
    // Not "it failed" — denied, which is EPERM, which is the wall. A machine
    // with no network would have failed here too and proved nothing.
    assert_eq!(
        probe_in(agent_of(&agent), "tcp", ELSEWHERE, 443),
        "denied",
        "the agent phase reached a machine that was not on the list"
    );
    // …and in the setup phase that same address fails for some *other* reason,
    // which is what makes the line above about the wall rather than the route.
    assert_ne!(probe_in(Phase::Setup, "tcp", ELSEWHERE, 443), "denied");

    // --- the way out that is left open, so the allowlist has something to be
    // consulted about at all.
    assert_eq!(
        probe_in(agent_of(&agent), "tcp", "127.0.0.1", registry),
        "reached",
        "the agent phase could not reach loopback, so it cannot reach its broker"
    );
}

#[test]
fn quic_cannot_go_around_the_allowlist() {
    let listening = udp_origin();
    let Some(agent) = wall_up() else { return };

    // A domain allowlist is an HTTP proxy, and HTTP/3 is QUIC is UDP: a client
    // that speaks it goes *around* the proxy without noticing, and the list
    // would still be there, correct, and consulted about nothing.
    assert_eq!(
        probe_in(Phase::Setup, "udp", "127.0.0.1", listening),
        "reached"
    );
    assert_eq!(
        probe_in(agent_of(&agent), "udp", "127.0.0.1", listening),
        "denied",
        "UDP left the agent phase — QUIC would have gone around the whole allowlist"
    );
}

#[test]
fn behind_the_wall_the_only_way_out_is_the_list() {
    let registry = origin();
    let Some(agent) = wall_up() else { return };

    let journal = std::env::temp_dir().join(format!("aura-egress-e2e-{}.jsonl", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let egress = Egress::of(vec![Allowed {
        endpoint: Endpoint::new("127.0.0.1", registry),
        reason: Reason::Declared,
    }]);
    let broker = Broker::bind(egress.clone(), Journal::at(&journal)).expect("a broker");
    let broker_port = broker.port().expect("a port");
    std::thread::spawn(move || {
        let _ = broker.serve();
    });

    // The declared machine, through the only door there is.
    assert_eq!(
        probe_in(
            agent_of(&agent),
            "proxy",
            &format!("127.0.0.1:{registry}"),
            broker_port
        ),
        "200"
    );
    // Anywhere else, twice, because a client that has been talked into leaving
    // tends to retry.
    for _ in 0..2 {
        assert_eq!(
            probe_in(
                agent_of(&agent),
                "proxy",
                "exfil.example.com:443",
                broker_port
            ),
            "403"
        );
    }

    // And the person who started the run can read what happened.
    let text = std::fs::read_to_string(&journal).expect("a journal");
    let report = Report::read("e2e", &egress, &text);
    assert!(!report.clean());
    assert_eq!(
        report.headline(),
        "The allowlist stopped this run reaching exfil.example.com."
    );
    assert_eq!(report.refusals(), vec!["wanted exfil.example.com:443 2 times"]);
    let _ = std::fs::remove_file(&journal);
}

/// The same wall, borrowed for one more probe.
fn agent_of(phase: &Phase) -> Phase {
    match phase {
        Phase::Agent { profile } => Phase::Agent {
            profile: profile.clone(),
        },
        Phase::Setup => Phase::Setup,
    }
}
