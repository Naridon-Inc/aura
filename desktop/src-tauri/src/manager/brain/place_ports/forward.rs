//! Holding a port on a place open at `localhost` on this Mac.
//!
//! A forward is a child process — the place's own transport, told to carry
//! one port and run nothing — and the whole job here is to be honest about
//! that child: to know it came up before saying `localhost:3000` is the
//! place's 3000, to remember it so it can be let go, and to notice when it
//! died on its own so a dead forward is never listed as a live one.
//!
//! The book of held forwards is process-wide, keyed by (place, port). It is
//! not per surface, because the surfaces that close forwards are not the one
//! that opened them: a place going to sleep drops every forward to it, and so
//! does forgetting the place, and neither of those has a popover open.
//!
//! The same port number on this Mac when it is free, else the next free one
//! above it. Conductor's rule, and the right one: a member who saw `3000` on
//! the box should find it at `3000` here whenever this Mac allows it, and
//! find it one number up rather than somewhere random when it does not.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};

use super::super::place::Place;

/// A port on a place, answering on this Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forwarded {
    /// What to call the place in a sentence.
    pub place: String,
    /// The book's key, or `None` for this laptop, whose ports were never
    /// anywhere else.
    pub machine_id: Option<String>,
    pub remote_port: u16,
    pub local_port: u16,
    /// What to open: `http://localhost:<local_port>`.
    pub url: String,
    /// The child carrying it, for a surface that wants to say so. `None` on
    /// this laptop, where nothing is carried.
    pub pid: Option<u32>,
}

/// How long a forward gets to come up before it is called a failure. The
/// connection usually already exists — the place's calls are multiplexed —
/// so this is the cold case: a fresh handshake to a box across an ocean.
const ESTABLISH: Duration = Duration::from_secs(20);

/// How often to look while waiting for the listener.
const POLL: Duration = Duration::from_millis(100);

struct Held {
    local_port: u16,
    child: Child,
}

/// Every forward this process holds. `BTreeMap` because its constructor is
/// `const`, which is what lets this be a plain static rather than a lazy one.
static HELD: Mutex<BTreeMap<(String, u16), Held>> = Mutex::new(BTreeMap::new());

fn local_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// The first free port at or above `preferred`, by whatever `is_free` says.
///
/// Pure, so the rule is testable without binding anything: the caller hands
/// in the real check, and the test hands in a list.
pub fn pick_local_port(preferred: u16, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    (preferred.max(1)..=u16::MAX).find(|p| is_free(*p))
}

/// Can this Mac listen here right now? Binding is the only honest answer —
/// a port that looks unused in a table can be taken between the look and
/// the bind, and `ssh -L` itself will bind exactly this way a moment later.
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Drop every held forward whose child has already exited.
///
/// A forward dies when the place does — it sleeps, it reboots, the network
/// goes — and the child exits on its own. Nothing tells us, so every reader of
/// the book asks this first, and a forward that is gone is gone rather than
/// listed until somebody presses Stop on it.
pub fn reap() {
    let Ok(mut held) = HELD.lock() else {
        return;
    };
    let mut dead: Vec<(String, u16)> = vec![];
    for (key, h) in held.iter_mut() {
        if matches!(h.child.try_wait(), Ok(Some(_))) {
            dead.push(key.clone());
        }
    }
    for key in dead {
        if let Some(h) = held.remove(&key) {
            crate::child_reaper::forget(h.child.id());
        }
    }
}

/// The forward held for one port on one place, if any is live.
pub fn held(machine_id: &str, remote_port: u16) -> Option<u16> {
    reap();
    HELD.lock()
        .ok()?
        .get(&(machine_id.trim().to_string(), remote_port))
        .map(|h| h.local_port)
}

/// Let go of one forward. Answers whether there was one.
pub fn release(machine_id: &str, remote_port: u16) -> bool {
    let Ok(mut held) = HELD.lock() else {
        return false;
    };
    let Some(mut h) = held.remove(&(machine_id.trim().to_string(), remote_port)) else {
        return false;
    };
    let _ = h.child.start_kill();
    crate::child_reaper::forget(h.child.id());
    true
}

/// Let go of every forward to one place. Answers how many there were.
///
/// Called on the way into sleep and on the way out of the book: a child still
/// dialling a machine that is stopping, or an address the book no longer
/// holds, is a child that will sit there failing until the app quits.
pub fn release_all(machine_id: &str) -> usize {
    let Ok(mut held) = HELD.lock() else {
        return 0;
    };
    let id = machine_id.trim();
    let mine: Vec<(String, u16)> = held
        .keys()
        .filter(|(m, _)| m == id)
        .cloned()
        .collect();
    for key in &mine {
        if let Some(mut h) = held.remove(key) {
            let _ = h.child.start_kill();
            crate::child_reaper::forget(h.child.id());
        }
    }
    mine.len()
}

/// Every live forward to one place.
fn forwarded_to(place: &str, machine_id: &str) -> Vec<Forwarded> {
    reap();
    let Ok(held) = HELD.lock() else {
        return vec![];
    };
    let id = machine_id.trim();
    held.iter()
        .filter(|((m, _), _)| m == id)
        .map(|((m, remote), h)| Forwarded {
            place: place.to_string(),
            machine_id: Some(m.clone()),
            remote_port: *remote,
            local_port: h.local_port,
            url: local_url(h.local_port),
            pid: h.child.id(),
        })
        .collect()
}

/// The most useful line a failed child said — the last non-empty one.
fn last_line(said: &str) -> String {
    said.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("it gave no reason")
        .to_string()
}

impl Place {
    /// Bring one port here.
    ///
    /// On this laptop the port is already here, and the answer says so
    /// instead of failing — a surface that had to know which kind of place it
    /// held before it could offer "Open on your Mac" is a surface that will
    /// get it wrong somewhere.
    pub(crate) async fn forward_port(
        &self,
        remote_port: u16,
        local_port: Option<u16>,
    ) -> Result<Forwarded, String> {
        if remote_port == 0 {
            return Err("A port is a number between 1 and 65535.".to_string());
        }
        let machine = match self {
            Place::Here { .. } => {
                return Ok(Forwarded {
                    place: self.label().to_string(),
                    machine_id: None,
                    remote_port,
                    local_port: remote_port,
                    url: local_url(remote_port),
                    pid: None,
                });
            }
            Place::Box { machine, .. } => machine,
        };

        // Asked twice is answered once: the forward in hand is the forward.
        if let Some(local) = held(&machine.id, remote_port) {
            return Ok(Forwarded {
                place: self.label().to_string(),
                machine_id: Some(machine.id.clone()),
                remote_port,
                local_port: local,
                url: local_url(local),
                pid: None,
            });
        }

        // A place Aura stopped comes back on a different address; reaching it
        // through the row in hand would dial whatever answers there now. Same
        // step every other remote verb takes, for the same reason.
        let woken;
        let machine = match super::super::place_wake::before_reaching(machine).await? {
            Some(up) => {
                woken = up;
                &woken
            }
            None => machine,
        };

        let want = local_port.unwrap_or(remote_port);
        let local = pick_local_port(want, port_is_free)
            .ok_or_else(|| "There is no free port left on this Mac.".to_string())?;

        let (program, args) = crate::cloudbox::forward_argv(machine, local, remote_port);
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Couldn't start the forward to {}: {e}", machine.name))?;
        crate::child_reaper::track(child.id(), "port forward");

        // Not "spawned", but "answering": the address is only worth handing
        // to a browser once something on this Mac accepts a connection on it.
        let deadline = Instant::now() + ESTABLISH;
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                let said = match child.stderr.take() {
                    Some(err) => {
                        let mut lines = tokio::io::BufReader::new(err).lines();
                        let mut all = String::new();
                        while let Ok(Some(l)) = lines.next_line().await {
                            all.push_str(&l);
                            all.push('\n');
                        }
                        all
                    }
                    None => String::new(),
                };
                crate::child_reaper::forget(child.id());
                return Err(format!(
                    "{} wouldn't carry port {remote_port}: {}",
                    machine.name,
                    last_line(&said)
                ));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", local))
                .await
                .is_ok()
            {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.start_kill();
                crate::child_reaper::forget(child.id());
                return Err(format!(
                    "{} didn't bring port {remote_port} up within {}s.",
                    machine.name,
                    ESTABLISH.as_secs()
                ));
            }
            tokio::time::sleep(POLL).await;
        }

        // Anything the child says from here on — a connection the far side
        // refused, a reconnect — goes to the log rather than into a pipe
        // nobody reads, which would eventually stall it.
        if let Some(err) = child.stderr.take() {
            let name = machine.name.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(place = %name, port = remote_port, "forward: {line}");
                }
            });
        }

        let pid = child.id();
        if let Ok(mut held) = HELD.lock() {
            held.insert(
                (machine.id.clone(), remote_port),
                Held {
                    local_port: local,
                    child,
                },
            );
        }
        Ok(Forwarded {
            place: self.label().to_string(),
            machine_id: Some(machine.id.clone()),
            remote_port,
            local_port: local,
            url: local_url(local),
            pid,
        })
    }

    /// Let go of one forward. Nothing to let go of is not a failure.
    pub(crate) fn release_port(&self, remote_port: u16) -> bool {
        match self {
            Place::Here { .. } => false,
            Place::Box { machine, .. } => release(&machine.id, remote_port),
        }
    }

    /// Every live forward to this place. Empty for this laptop.
    pub(crate) fn forwarded_ports(&self) -> Vec<Forwarded> {
        match self {
            Place::Here { .. } => vec![],
            Place::Box { machine, .. } => forwarded_to(self.label(), &machine.id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_number_wins_when_this_mac_has_it_free() {
        assert_eq!(pick_local_port(3000, |_| true), Some(3000));
    }

    #[test]
    fn the_next_free_number_above_wins_when_it_does_not() {
        let taken = [3000u16, 3001];
        assert_eq!(pick_local_port(3000, |p| !taken.contains(&p)), Some(3002));
    }

    #[test]
    fn nothing_below_the_asked_for_port_is_ever_chosen() {
        let got = pick_local_port(5000, |p| p != 5000).unwrap();
        assert!(got > 5000);
    }

    #[test]
    fn a_mac_with_no_port_left_says_so_rather_than_answering_zero() {
        assert_eq!(pick_local_port(65535, |_| false), None);
        assert_eq!(pick_local_port(0, |_| false), None);
    }

    #[test]
    fn port_zero_is_never_an_answer() {
        assert_eq!(pick_local_port(0, |_| true), Some(1));
    }

    #[test]
    fn a_port_this_process_is_listening_on_is_not_free() {
        let hold = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = hold.local_addr().unwrap().port();
        assert!(!port_is_free(taken));
        drop(hold);
        assert!(port_is_free(taken));
    }

    #[test]
    fn the_url_is_what_a_browser_opens() {
        assert_eq!(local_url(3000), "http://localhost:3000");
    }

    #[test]
    fn a_failure_is_reported_in_the_last_thing_said() {
        assert_eq!(
            last_line("Warning: something\nbind [127.0.0.1]:3000: Address already in use\n\n"),
            "bind [127.0.0.1]:3000: Address already in use"
        );
        assert_eq!(last_line("   \n"), "it gave no reason");
    }

    #[test]
    fn letting_go_of_a_forward_nobody_holds_is_not_a_failure() {
        assert!(!release("nobody@nowhere", 3000));
        assert_eq!(release_all("nobody@nowhere"), 0);
        assert_eq!(held("nobody@nowhere", 3000), None);
    }

    #[test]
    fn this_laptop_answers_its_own_port_without_carrying_anything() {
        let here = Place::Here {
            root: "/tmp".into(),
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let got = rt.block_on(here.forward_port(3000, None)).unwrap();
        assert_eq!(got.local_port, 3000);
        assert_eq!(got.url, "http://localhost:3000");
        assert_eq!(got.machine_id, None);
        assert!(here.forwarded_ports().is_empty());
        assert!(!here.release_port(3000));
    }

    #[test]
    fn port_zero_is_refused_before_anything_is_dialled() {
        let here = Place::Here {
            root: "/tmp".into(),
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(rt.block_on(here.forward_port(0, None)).is_err());
    }
}
