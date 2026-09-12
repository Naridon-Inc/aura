//! Asking a place what is listening, and reading the answer.
//!
//! One script for every place. It prefers `ss`, which every Linux box Aura
//! makes has, and falls back to `lsof`, which is what this Mac has and what
//! an older or stranger box may have instead. The script says which one
//! answered on its first line, so the parser never has to guess from the
//! shape of the rows — and the parsers are plain functions over text, so the
//! shapes are held by tests rather than by a box being up.
//!
//! What is kept: TCP listeners bound to every interface or to loopback — the
//! ones a `-L` forward to `127.0.0.1` on the far side can actually reach. A
//! server bound only to one private address is left out rather than shown as
//! a link that would not open. The place's own `sshd` is left out because it
//! is the wire this is being asked over, and anything below 1024 is left out
//! unless a process the member can see owns it — a system daemon on 631 is
//! not the thing they just started.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::super::place::Place;

/// One TCP listener on the place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListeningPort {
    pub port: u16,
    /// Known only for a process the login can see — its own, or all of them
    /// as root. `None` is "somebody's", not "nobody's".
    pub pid: Option<u32>,
    pub process: Option<String>,
    /// As the place spelled it: `127.0.0.1`, `0.0.0.0`, `::`, or `*`.
    pub address: String,
}

/// The question, as one line of shell. Answers `#ss` or `#lsof` first so the
/// reader knows which tool spoke, and exits zero either way: a place with
/// nothing listening is an answer, not a failure.
pub const LISTEN_SCRIPT: &str = "out=$(ss -ltnpH 2>/dev/null) && [ -n \"$out\" ] && { echo '#ss'; printf '%s\\n' \"$out\"; exit 0; }; echo '#lsof'; lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null; exit 0";

/// How long a place gets to answer. It is one `ss`; a box that takes longer
/// than this is a box that is not answering.
const LISTEN_WAIT: Duration = Duration::from_secs(20);

/// The far side's own login daemon — the connection this is asked over.
const SSHD: &str = "sshd";

impl Place {
    /// What is listening on this place, worth showing.
    pub(crate) async fn listening_ports(&self) -> Result<Vec<ListeningPort>, String> {
        let out = self.sh(LISTEN_SCRIPT, LISTEN_WAIT).await?;
        Ok(parse(&out.stdout))
    }
}

/// Read whatever [`LISTEN_SCRIPT`] said into rows, deduplicated by port and
/// sorted.
pub fn parse(output: &str) -> Vec<ListeningPort> {
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(first) = lines.next() else {
        return vec![];
    };
    let body: Vec<&str> = lines.collect();
    let raw = match first {
        "#ss" => parse_ss(&body),
        "#lsof" => parse_lsof(&body),
        // No tag: somebody pasted a tool's output straight in. Read it by its
        // header rather than refusing it.
        _ if first.starts_with("COMMAND") => parse_lsof(&body),
        _ => {
            let mut all = vec![first];
            all.extend(body);
            parse_ss(&all)
        }
    };
    let mut by_port: BTreeMap<u16, ListeningPort> = BTreeMap::new();
    for p in raw.into_iter().filter(worth_showing) {
        // A v4 and a v6 socket on the same port are one server; keep whichever
        // row named a process.
        match by_port.get(&p.port) {
            Some(held) if held.process.is_some() || p.process.is_none() => {}
            _ => {
                by_port.insert(p.port, p);
            }
        }
    }
    by_port.into_values().collect()
}

/// `ss -ltnpH` rows:
///
/// ```text
/// LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))
/// LISTEN 0 128    [::]:22        [::]:*
/// ```
fn parse_ss(lines: &[&str]) -> Vec<ListeningPort> {
    lines
        .iter()
        .filter(|l| !l.starts_with("State"))
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            let local = tokens.iter().find(|t| split_port(t).is_some())?;
            let (address, port) = split_port(local)?;
            let (process, pid) = tokens
                .iter()
                .find(|t| t.starts_with("users:"))
                .map(|t| ss_owner(t))
                .unwrap_or((None, None));
            Some(ListeningPort {
                port,
                pid,
                process,
                address,
            })
        })
        .collect()
}

/// `users:(("node",pid=1234,fd=20),("node",pid=1235,fd=21))` → the first.
fn ss_owner(field: &str) -> (Option<String>, Option<u32>) {
    let name = field
        .split('"')
        .nth(1)
        .map(str::to_string)
        .filter(|n| !n.is_empty());
    let pid = field
        .split("pid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|d| d.parse().ok());
    (name, pid)
}

/// `lsof -iTCP -sTCP:LISTEN -P -n` rows:
///
/// ```text
/// COMMAND  PID USER FD  TYPE DEVICE SIZE/OFF NODE NAME
/// node    1234 ubu  20u IPv4 0x1    0t0      TCP  127.0.0.1:3000 (LISTEN)
/// node    1234 ubu  21u IPv6 0x2    0t0      TCP  *:5173 (LISTEN)
/// ```
fn parse_lsof(lines: &[&str]) -> Vec<ListeningPort> {
    lines
        .iter()
        .filter(|l| !l.starts_with("COMMAND"))
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() < 3 {
                return None;
            }
            let name = tokens
                .iter()
                .rev()
                .find(|t| split_port(t).is_some())?;
            let (address, port) = split_port(name)?;
            Some(ListeningPort {
                port,
                pid: tokens[1].parse().ok(),
                process: Some(tokens[0].replace("\\x20", " ")),
                address,
            })
        })
        .collect()
}

/// `127.0.0.1:3000` → (`127.0.0.1`, 3000); `[::]:22` → (`::`, 22); `*:80` →
/// (`*`, 80). `None` for anything that does not end in a port, which is how
/// the other columns are told apart from the address.
fn split_port(token: &str) -> Option<(String, u16)> {
    let (addr, port) = token.rsplit_once(':')?;
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    // Interface suffixes (`fe80::1%eth0`) and brackets are not part of the
    // address a person reads.
    let addr = addr
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split('%')
        .next()
        .unwrap_or("")
        .to_string();
    if addr.is_empty() {
        return None;
    }
    Some((addr, port))
}

/// Reachable through a forward to `127.0.0.1` on the far side: every
/// interface, or loopback itself.
fn reachable_over_loopback(address: &str) -> bool {
    matches!(
        address,
        "*" | "0.0.0.0" | "::" | "::1" | "0:0:0:0:0:0:0:0" | "::ffff:127.0.0.1"
    ) || address.starts_with("127.")
}

fn worth_showing(p: &ListeningPort) -> bool {
    if !reachable_over_loopback(&p.address) {
        return false;
    }
    if p.port == 22 || p.process.as_deref().is_some_and(is_sshd) {
        return false;
    }
    p.port >= 1024 || p.process.is_some()
}

fn is_sshd(name: &str) -> bool {
    name == SSHD || name.starts_with("sshd:")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SS: &str = "#ss
LISTEN 0      4096       127.0.0.1:3000       0.0.0.0:*    users:((\"node\",pid=1234,fd=20))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:((\"sshd\",pid=800,fd=3))
LISTEN 0      511                *:5173             *:*    users:((\"node\",pid=2200,fd=21),(\"node\",pid=2201,fd=22))
LISTEN 0      128             [::]:22            [::]:*
LISTEN 0      4096           [::1]:5173         [::]:*
LISTEN 0      128         10.0.0.5:5432        0.0.0.0:*    users:((\"postgres\",pid=900,fd=5))
LISTEN 0      5          127.0.0.1:631         0.0.0.0:*
LISTEN 0      4096       127.0.0.1:80         0.0.0.0:*    users:((\"caddy\",pid=77,fd=9))
";

    #[test]
    fn ss_rows_become_ports_with_who_owns_them() {
        let got = parse(SS);
        let ports: Vec<u16> = got.iter().map(|p| p.port).collect();
        assert_eq!(ports, vec![80, 3000, 5173]);
        let node = got.iter().find(|p| p.port == 3000).unwrap();
        assert_eq!(node.pid, Some(1234));
        assert_eq!(node.process.as_deref(), Some("node"));
        assert_eq!(node.address, "127.0.0.1");
    }

    #[test]
    fn the_wire_this_is_asked_over_is_not_a_port_to_forward() {
        assert!(parse(SS).iter().all(|p| p.port != 22));
    }

    #[test]
    fn a_server_on_one_private_address_is_not_reachable_over_loopback() {
        assert!(parse(SS).iter().all(|p| p.port != 5432));
    }

    #[test]
    fn a_system_port_is_shown_only_when_somebody_visible_owns_it() {
        let got = parse(SS);
        assert!(got.iter().any(|p| p.port == 80), "caddy on 80 is the member's");
        assert!(got.iter().all(|p| p.port != 631), "cups on 631 is nobody's");
    }

    #[test]
    fn a_v4_and_a_v6_socket_on_one_port_are_one_row_and_keep_the_owner() {
        let got = parse(SS);
        let vite: Vec<_> = got.iter().filter(|p| p.port == 5173).collect();
        assert_eq!(vite.len(), 1);
        assert_eq!(vite[0].pid, Some(2200));
        assert_eq!(vite[0].address, "*");
    }

    #[test]
    fn an_ss_header_left_in_by_an_older_tool_is_skipped() {
        let got = parse(
            "#ss\nState Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 1 0.0.0.0:8080 0.0.0.0:*\n",
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].port, 8080);
        assert_eq!(got[0].pid, None);
    }

    const LSOF: &str = "#lsof
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    41234  mo   23u  IPv4 0xabc123      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    41234  mo   24u  IPv6 0xabc124      0t0  TCP *:5173 (LISTEN)
sshd      800 root   3u  IPv4 0xabc125      0t0  TCP *:22 (LISTEN)
Google\\x20Chrome 500 mo 9u IPv4 0xabc126 0t0 TCP 127.0.0.1:7000 (LISTEN)
postgres  900  mo    7u  IPv4 0xabc127      0t0  TCP 192.168.1.9:5432 (LISTEN)
";

    #[test]
    fn lsof_rows_become_the_same_ports() {
        let got = parse(LSOF);
        let ports: Vec<u16> = got.iter().map(|p| p.port).collect();
        assert_eq!(ports, vec![3000, 5173, 7000]);
        let chrome = got.iter().find(|p| p.port == 7000).unwrap();
        assert_eq!(chrome.process.as_deref(), Some("Google Chrome"));
        assert_eq!(chrome.pid, Some(500));
    }

    #[test]
    fn untagged_output_is_read_by_its_shape() {
        let bare_lsof = LSOF.trim_start_matches("#lsof\n");
        assert_eq!(parse(bare_lsof).len(), 3);
        let bare_ss = SS.trim_start_matches("#ss\n");
        assert_eq!(parse(bare_ss).len(), 3);
    }

    #[test]
    fn nothing_listening_is_an_empty_answer_not_an_error() {
        assert!(parse("#ss\n").is_empty());
        assert!(parse("#lsof\n").is_empty());
        assert!(parse("").is_empty());
    }

    #[test]
    fn a_port_is_split_off_an_address_of_any_shape() {
        assert_eq!(split_port("127.0.0.1:3000"), Some(("127.0.0.1".into(), 3000)));
        assert_eq!(split_port("[::]:22"), Some(("::".into(), 22)));
        assert_eq!(split_port("*:80"), Some(("*".into(), 80)));
        assert_eq!(split_port("[fe80::1%eth0]:9000"), Some(("fe80::1".into(), 9000)));
        assert_eq!(split_port("0.0.0.0:*"), None);
        assert_eq!(split_port("LISTEN"), None);
        assert_eq!(split_port("users:((\"node\",pid=1,fd=2))"), None);
    }

    #[test]
    fn the_script_says_which_tool_answered() {
        assert!(LISTEN_SCRIPT.contains("echo '#ss'"));
        assert!(LISTEN_SCRIPT.contains("echo '#lsof'"));
        assert!(LISTEN_SCRIPT.contains("ss -ltnpH"));
        assert!(LISTEN_SCRIPT.contains("lsof -iTCP -sTCP:LISTEN -P -n"));
        assert!(LISTEN_SCRIPT.ends_with("exit 0"));
    }
}
