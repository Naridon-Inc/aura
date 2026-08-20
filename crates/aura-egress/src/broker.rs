//! The allowlist itself: a proxy on loopback that the confined work is the only
//! thing able to reach.
//!
//! ## Why the list is held here and not by the kernel
//!
//! A firewall allows *addresses*. An allowlist is written in *names*, and the
//! two are not the same thing for any host worth naming: `api.anthropic.com` is
//! a dozen addresses that change under you, and a rule pinned to the ones that
//! answered at half past nine is a rule that breaks at ten and — worse — permits
//! whatever else moves onto that address later. Every one of the hosts a project
//! declares sits behind a CDN, which is to say behind addresses shared with the
//! rest of the internet.
//!
//! So the wall the machine puts up is deliberately stupid: **nothing leaves,
//! except to loopback**. The interesting decision — is this host on the list —
//! is made here, in one place, in a process that knows what was declared,
//! against the name the work actually asked for. That also makes the refusal
//! *answerable*: the work is told `403` with a sentence it can print, instead of
//! a connection that hangs and a person guessing.
//!
//! ## What it does not do
//!
//! It does not terminate TLS. There is no certificate to install, nothing to
//! trust, and no window in which the model's traffic is readable by us — the
//! request line of a `CONNECT` names a host and nothing else, which is exactly
//! the amount this needs to know. An inspecting proxy would have been a more
//! capable filter and a far worse thing to have running on somebody's laptop.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::journal::{Journal, Via};
use crate::policy::Egress;

/// How long the work has to send its request line before the connection is
/// dropped. Generous: the point is to not leak a thread per idle socket.
const HEAD_WAIT: Duration = Duration::from_secs(30);

/// How long to spend reaching a host that *is* allowed.
const DIAL_WAIT: Duration = Duration::from_secs(20);

/// The most a request head may be. Anything larger is not a request head.
const HEAD_MAX: usize = 64 * 1024;

/// A proxy holding one run's allowlist.
pub struct Broker {
    listener: TcpListener,
    egress: Arc<Egress>,
    journal: Arc<Journal>,
}

impl Broker {
    /// Listen on loopback, on a port the operating system picks.
    ///
    /// Loopback only, and never a fixed port: this is reachable by anything
    /// already running as this member on this machine, and the answer to that is
    /// that it grants strictly *less* than they already have — every one of
    /// those processes has the whole network. The only thing that gains by
    /// reaching it is something that has been walled off, and the wall is what
    /// decides that, not a password.
    pub fn bind(egress: Egress, journal: Journal) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        Ok(Broker {
            listener,
            egress: Arc::new(egress),
            journal: Arc::new(journal),
        })
    }

    pub fn port(&self) -> io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    /// Write the port where the guard script is waiting to read it.
    ///
    /// Written to a temporary name and renamed, so the script never reads a file
    /// that exists but is empty — it waits for the file, and a half-written one
    /// would send the work at port `4`.
    pub fn announce(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let staging = path.with_extension("port.part");
        std::fs::write(&staging, format!("{}\n", self.port()?))?;
        std::fs::rename(&staging, path)
    }

    /// Serve until the process is killed, which is what the guard script does
    /// when the work it was holding finishes.
    pub fn serve(&self) -> io::Result<()> {
        for incoming in self.listener.incoming() {
            let Ok(stream) = incoming else { continue };
            let egress = Arc::clone(&self.egress);
            let journal = Arc::clone(&self.journal);
            // A thread per connection. An async runtime would hold more of them
            // and would be a dependency on every machine the work runs on; the
            // number of connections one agent opens is two figures.
            std::thread::spawn(move || serve_one(stream, &egress, &journal));
        }
        Ok(())
    }
}

/// One connection, from its request line to whichever of the two endings it
/// gets.
fn serve_one(mut client: TcpStream, egress: &Egress, journal: &Journal) {
    let _ = client.set_read_timeout(Some(HEAD_WAIT));
    let Ok((head, rest)) = read_head(&mut client) else {
        return;
    };
    let Some(asked) = Asked::of(&head) else {
        respond(&mut client, 400, "That is not a request this can forward.");
        return;
    };

    if !egress.permits(&asked.host, asked.port) {
        journal.refused(&asked.host, asked.port, asked.via);
        respond(&mut client, 403, &refusal_text(&asked.host, asked.port));
        return;
    }

    let Some(address) = resolve(&asked.host, asked.port) else {
        respond(
            &mut client,
            502,
            &format!(
                "{}:{} is allowed, but this machine cannot resolve it.",
                asked.host, asked.port
            ),
        );
        return;
    };
    let Ok(mut upstream) = TcpStream::connect_timeout(&address, DIAL_WAIT) else {
        respond(
            &mut client,
            502,
            &format!(
                "{}:{} is allowed, but did not answer.",
                asked.host, asked.port
            ),
        );
        return;
    };

    // Past here it is two sockets and no opinions. Long-lived streams — a model
    // answering a token at a time — must not be cut off by the head timeout.
    let _ = client.set_read_timeout(None);
    let _ = upstream.set_read_timeout(None);

    match asked.via {
        Via::Connect => {
            if client
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .is_err()
            {
                return;
            }
            // Anything the client sent before it was told to go ahead.
            if !rest.is_empty() && upstream.write_all(&rest).is_err() {
                return;
            }
        }
        Via::Http => {
            // Forwarded unchanged. RFC 7230 requires an origin server to accept
            // the absolute form, so there is nothing to rewrite — and rewriting
            // is how a proxy grows opinions about somebody else's request.
            if upstream.write_all(&head).is_err() || upstream.write_all(&rest).is_err() {
                return;
            }
        }
    }
    splice(client, upstream);
}

/// What the work asked for.
struct Asked {
    host: String,
    port: u16,
    via: Via,
}

impl Asked {
    /// The host and port out of a request head, or nothing if that is not what
    /// this is.
    fn of(head: &[u8]) -> Option<Asked> {
        let text = String::from_utf8_lossy(head);
        let line = text.lines().next()?.trim();
        let mut parts = line.split_whitespace();
        let method = parts.next()?;
        let target = parts.next()?;

        if method.eq_ignore_ascii_case("CONNECT") {
            let (host, port) = split_host_port(target, 443)?;
            return Some(Asked {
                host,
                port,
                via: Via::Connect,
            });
        }

        // Absolute form: the only shape a proxied plain request comes in.
        let (scheme, rest) = target.split_once("://")?;
        let authority = rest.split('/').next().unwrap_or_default();
        let default = if scheme.eq_ignore_ascii_case("https") {
            443
        } else {
            80
        };
        let (host, port) = split_host_port(authority.rsplit('@').next()?, default)?;
        Some(Asked {
            host,
            port,
            via: Via::Http,
        })
    }
}

fn split_host_port(authority: &str, default: u16) -> Option<(String, u16)> {
    let text = authority.trim();
    if text.is_empty() {
        return None;
    }
    let (host, port) = match text.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (text, default),
    };
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

/// Read up to the end of the request head, keeping whatever arrived after it.
fn read_head(client: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = client.read(&mut chunk)?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "no request"));
        }
        buf.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_head_end(&buf) {
            let rest = buf.split_off(end);
            return Ok((buf, rest));
        }
        if buf.len() > HEAD_MAX {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
        }
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// The first address a name answers on.
fn resolve(host: &str, port: u16) -> Option<SocketAddr> {
    (host, port).to_socket_addrs().ok()?.next()
}

/// The sentence the work is given when it is refused.
///
/// Written to be read by whoever is looking at the agent's own output, which is
/// often the agent: it says what happened, why, and the one edit that would
/// change it. "Connection reset by peer" says none of those.
fn refusal_text(host: &str, port: u16) -> String {
    format!(
        "Aura stopped this: {host}:{port} is not on this project's allowlist.\n\
         \n\
         The setup phase of this run had the network and installed with it. The \
         agent phase does not: it can reach only what the project declared in \
         `[env.network]` of .aura/settings.toml, plus the agent's own model and \
         the remote this checkout came from.\n\
         \n\
         If the work genuinely needs {host}, add it to that list, sign the spec \
         again (`aura env sign`), and start the run over. If you did not expect \
         this, something in the context asked for it — that is what the list is \
         for.\n"
    )
}

/// Answer with a status and a sentence, and end the connection.
///
/// The body is sent for every status, including the ones a `CONNECT` client will
/// throw away: `curl` prints the status, `undici` raises it, and a person
/// reading a terminal gets the words.
fn respond(client: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        _ => "Bad Gateway",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    let _ = client.write_all(head.as_bytes());
    let _ = client.write_all(body.as_bytes());
    let _ = client.flush();
    let _ = client.shutdown(Shutdown::Both);
}

/// Both directions, until either end stops.
fn splice(client: TcpStream, upstream: TcpStream) {
    let (Ok(client_read), Ok(upstream_read)) = (client.try_clone(), upstream.try_clone()) else {
        return;
    };
    let up = std::thread::spawn(move || {
        let mut from = client_read;
        let mut to = upstream;
        let _ = io::copy(&mut from, &mut to);
        let _ = to.shutdown(Shutdown::Write);
    });
    let mut from = upstream_read;
    let mut to = client;
    let _ = io::copy(&mut from, &mut to);
    let _ = to.shutdown(Shutdown::Write);
    let _ = up.join();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Allowed, Reason};

    /// A stand-in for a machine on the allowlist: says hello and hangs up.
    fn origin() -> (String, u16) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("an origin");
        let port = listener.local_addr().expect("an address").port();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { continue };
                std::thread::spawn(move || {
                    let mut chunk = [0u8; 512];
                    let _ = stream.read(&mut chunk);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
        });
        ("127.0.0.1".to_string(), port)
    }

    /// A broker holding exactly the endpoints given, journalling to a fresh file.
    fn broker(allow: &[(&str, u16)]) -> (u16, std::path::PathBuf) {
        let egress = Egress::of(
            allow
                .iter()
                .map(|(h, p)| Allowed {
                    endpoint: crate::policy::Endpoint::new(*h, *p),
                    reason: Reason::Declared,
                })
                .collect(),
        );
        let path = std::env::temp_dir().join(format!(
            "aura-egress-broker-{}-{:?}.jsonl",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let broker = Broker::bind(egress, Journal::at(&path)).expect("a broker");
        let port = broker.port().expect("a port");
        std::thread::spawn(move || {
            let _ = broker.serve();
        });
        (port, path)
    }

    /// Send one request head at the broker and read what comes back.
    fn ask(port: u16, head: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("the broker");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("a timeout");
        stream.write_all(head.as_bytes()).expect("a request");
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    fn journal_of(path: &std::path::Path) -> Vec<crate::journal::Refusal> {
        crate::journal::Refusal::read(&std::fs::read_to_string(path).unwrap_or_default())
    }

    #[test]
    fn a_host_on_the_list_is_reached() {
        let (host, port) = origin();
        let (proxy, _) = broker(&[(&host, port)]);
        // The `ping` rides in the same write as the head — a client that starts
        // its TLS handshake without waiting to be told to go ahead, which is
        // most of them. Those bytes must arrive, and arrive first.
        let answer = ask(proxy, &format!("CONNECT {host}:{port} HTTP/1.1\r\n\r\nping"));
        assert!(
            answer.starts_with("HTTP/1.1 200 Connection established"),
            "{answer}"
        );
        // …and the tunnel is a tunnel: the origin's own answer comes through it.
        assert!(answer.contains("hello"), "{answer}");
    }

    #[test]
    fn a_host_that_is_not_on_the_list_is_refused_in_words() {
        let (host, port) = origin();
        let (proxy, journal) = broker(&[("api.anthropic.com", 443)]);
        let answer = ask(proxy, &format!("CONNECT {host}:{port} HTTP/1.1\r\n\r\n"));
        assert!(answer.starts_with("HTTP/1.1 403 Forbidden"), "{answer}");
        // The work is told what happened and what would change it — the whole
        // difference between this and a connection that hangs.
        assert!(answer.contains("is not on this project's allowlist"), "{answer}");
        assert!(answer.contains("[env.network]"), "{answer}");
        assert!(!answer.contains("hello"), "the tunnel opened anyway: {answer}");

        let rows = journal_of(&journal);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].host, "127.0.0.1");
        assert_eq!(rows[0].port, port);
        assert_eq!(rows[0].via, Via::Connect);
    }

    #[test]
    fn the_port_is_part_of_the_permission_here_too() {
        // The list is the policy; the broker must not soften it by matching on
        // host alone. A machine allowed on 443 is not allowed on 22.
        let (host, port) = origin();
        let (proxy, _) = broker(&[(&host, port + 1)]);
        let answer = ask(proxy, &format!("CONNECT {host}:{port} HTTP/1.1\r\n\r\n"));
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    }

    #[test]
    fn a_plain_request_names_its_host_in_the_request_line() {
        let (host, port) = origin();
        let (proxy, journal) = broker(&[]);
        let answer = ask(
            proxy,
            &format!("GET http://{host}:{port}/x HTTP/1.1\r\nHost: {host}\r\n\r\n"),
        );
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
        // The body is readable by whoever is looking at the agent's output.
        assert!(answer.contains("Aura stopped this"), "{answer}");
        assert_eq!(journal_of(&journal)[0].via, Via::Http);
    }

    #[test]
    fn a_plain_request_to_a_permitted_host_is_forwarded_whole() {
        let (host, port) = origin();
        let (proxy, _) = broker(&[(&host, port)]);
        let answer = ask(
            proxy,
            &format!("GET http://{host}:{port}/x HTTP/1.1\r\nHost: {host}\r\n\r\n"),
        );
        assert!(answer.contains("hello"), "{answer}");
    }

    #[test]
    fn an_empty_allowlist_reaches_nothing() {
        let (host, port) = origin();
        let (proxy, _) = broker(&[]);
        let answer = ask(proxy, &format!("CONNECT {host}:{port} HTTP/1.1\r\n\r\n"));
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    }

    #[test]
    fn something_that_is_not_a_request_is_not_forwarded_anywhere() {
        let (proxy, _) = broker(&[("api.anthropic.com", 443)]);
        let answer = ask(proxy, "\x16\x03\x01hello there\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
    }

    #[test]
    fn the_port_is_announced_only_once_it_can_be_read_whole() {
        let dir = std::env::temp_dir().join(format!("aura-egress-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let broker = Broker::bind(Egress::default(), Journal::at(dir.join("j.jsonl")))
            .expect("a broker");
        let path = dir.join("run.port");
        broker.announce(&path).expect("announced");

        let text = std::fs::read_to_string(&path).expect("a port file");
        let read: u16 = text.trim().parse().expect("a number");
        assert_eq!(read, broker.port().expect("a port"));
        // The staging file is gone: the script waits on this path existing, and
        // a leftover would be read next run.
        assert!(!path.with_extension("port.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refusal_says_which_machine_it_was_and_is_read_back_by_line() {
        let (proxy, journal) = broker(&[]);
        for host in ["evil.example.com", "evil.example.com", "other.example.com"] {
            let _ = ask(proxy, &format!("CONNECT {host}:443 HTTP/1.1\r\n\r\n"));
        }
        let rows = journal_of(&journal);
        assert_eq!(rows.len(), 3);
        let tally = crate::journal::tally(&rows);
        assert_eq!(tally[0].plainly(), "wanted evil.example.com:443 2 times");

        // Whole lines, always: the reader splits on newlines.
        let text = std::fs::read_to_string(&journal).expect("a journal");
        assert_eq!(text.lines().count(), 3);
        assert!(text.lines().all(|l| l.trim_start().starts_with('{')));
    }
}
