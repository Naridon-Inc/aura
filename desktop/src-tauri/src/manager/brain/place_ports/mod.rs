//! What a place is serving, brought to this Mac.
//!
//! Work on a box starts a dev server the way work here does — `bun run dev`,
//! and something is listening on port 3000. Here you open it. There you could
//! not: the port was on a machine across the wire, the app knew nothing about
//! it, and the member's options were to type an ssh line by hand or to give
//! up on previewing anything they ran remotely. The one tunnel the app had
//! went the other way — it hands a port on THIS Mac to teammates.
//!
//! This is the missing direction. Three verbs, one seam:
//!
//! * [`detect`] — ask the place what is listening (`ss`, or `lsof` where
//!   there is no `ss`), and read the answer into rows.
//! * [`forward`] — hold a port on the place open at `localhost:<port>` on this
//!   Mac, remember the child that does it, and let it go on request, when
//!   the place sleeps, and when the place is forgotten.
//! * [`policy`] — whether a place gets its new ports forwarded without being
//!   asked, recorded per place because that is a decision about one machine.
//!
//! Every verb is a [`Place`] method, so this laptop answers the same questions
//! a box does: the laptop's ports are already local, and it says so instead
//! of failing. The transport is the one every other place verb uses — the
//! forward's argv is derived from [`crate::cloudbox::forward_argv`], beside
//! the argv that answers every other call, and `cloudbox::sole_ssh` fails the
//! build if a second spelling appears.
//!
//! The `place_*` commands here are the fifteenth family the parity gate lists,
//! and the one with a listener on this Mac at the end of it: a version that
//! found its own machine would open `localhost:3000` onto a box nobody checked
//! was the one on screen.

pub mod detect;
pub mod forward;
pub mod policy;

use serde::{Deserialize, Serialize};

use super::place::Place;
pub use forward::Forwarded;
pub use policy::PortsPolicy;

/// One listening port on the place, with where it is on this Mac if it has
/// been brought over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortRow {
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
    /// The address it is bound to over there, as the place spelled it.
    pub address: String,
    /// Where it answers on this Mac, or `None` while it has not been forwarded.
    pub local_port: Option<u16>,
    pub url: Option<String>,
}

/// Everything the Ports surface draws, in one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortsReport {
    /// What to call the place in a sentence.
    pub place: String,
    /// The book's key, or `None` for this laptop.
    pub machine_id: Option<String>,
    pub ports: Vec<PortRow>,
    /// Every forward held for this place, including ones whose remote port has
    /// since stopped listening — a row a member opened is theirs to close.
    pub forwarded: Vec<Forwarded>,
    pub auto_forward: bool,
    /// Ports this call forwarded on its own because `auto_forward` is on, so a
    /// surface can say so rather than have a link appear from nowhere.
    pub auto_forwarded: Vec<u16>,
}

/// The book's key for a place, or `None` for this laptop.
fn key_of(place: &Place) -> Option<String> {
    match place {
        Place::Here { .. } => None,
        Place::Box { machine, .. } => Some(machine.id.clone()),
    }
}

impl Place {
    /// What is listening here, what has been brought over, and — when the
    /// place asked for it — anything newly seen brought over on the way past.
    pub(crate) async fn ports_report(&self) -> Result<PortsReport, String> {
        let ports = self.listening_ports().await?;
        let key = key_of(self);
        let policy = key
            .as_deref()
            .map(policy::read)
            .unwrap_or_default();
        let mut auto_forwarded = vec![];
        if policy.auto_forward && self.is_remote() {
            for p in &ports {
                let already = key
                    .as_deref()
                    .and_then(|id| forward::held(id, p.port))
                    .is_some();
                if already {
                    continue;
                }
                // One port that will not come over is not a reason to stop
                // bringing the rest: the row shows it unforwarded, and the
                // member can try it by hand and read the reason.
                if self.forward_port(p.port, None).await.is_ok() {
                    auto_forwarded.push(p.port);
                }
            }
        }
        let forwarded = self.forwarded_ports();
        let rows = ports
            .into_iter()
            .map(|p| {
                let held = forwarded.iter().find(|f| f.remote_port == p.port);
                PortRow {
                    port: p.port,
                    pid: p.pid,
                    process: p.process,
                    address: p.address,
                    local_port: held.map(|f| f.local_port),
                    url: held.map(|f| f.url.clone()),
                }
            })
            .collect();
        Ok(PortsReport {
            place: self.label().to_string(),
            machine_id: key,
            ports: rows,
            forwarded,
            auto_forward: policy.auto_forward,
            auto_forwarded,
        })
    }
}

/// What is listening on a place, and what of it is already on this Mac.
///
/// A box by id, or this laptop when none is named — the same reading as
/// `place_sleeping`. Applies the place's auto-forward policy on the way: a
/// surface refreshing this every few seconds is how "forward new ports
/// automatically" happens, without a second timer anywhere.
#[tauri::command]
pub async fn place_ports_list(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<PortsReport, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    place.ports_report().await
}

/// Bring one port on the place to `localhost` on this Mac.
///
/// The same number when it is free here, else the next free one above it.
/// Asking twice for the same port answers with the forward already held.
#[tauri::command]
pub async fn place_port_forward(
    machine_id: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<Forwarded, String> {
    let place = Place::at_machine(&machine_id)?;
    place.forward_port(remote_port, local_port).await
}

/// Let one forward go. Answers with what is still held for the place.
#[tauri::command]
pub async fn place_port_release(
    machine_id: String,
    remote_port: u16,
) -> Result<Vec<Forwarded>, String> {
    let place = Place::at_machine(&machine_id)?;
    place.release_port(remote_port);
    Ok(place.forwarded_ports())
}

/// Every forward held for a place right now. Reaps first, so a forward whose
/// connection died is not reported as open.
#[tauri::command]
pub async fn place_ports_forwarded(machine_id: String) -> Result<Vec<Forwarded>, String> {
    let place = Place::at_machine(&machine_id)?;
    Ok(place.forwarded_ports())
}

/// Does this place get its new ports forwarded without being asked?
#[tauri::command]
pub async fn place_ports_policy(machine_id: String) -> Result<PortsPolicy, String> {
    let place = Place::at_machine(&machine_id)?;
    Ok(key_of(&place)
        .as_deref()
        .map(policy::read)
        .unwrap_or_default())
}

/// Turn automatic forwarding on or off for one place.
#[tauri::command]
pub async fn place_ports_policy_set(
    machine_id: String,
    auto_forward: bool,
) -> Result<PortsPolicy, String> {
    let place = Place::at_machine(&machine_id)?;
    let Some(id) = key_of(&place) else {
        return Ok(PortsPolicy::default());
    };
    policy::write(&id, PortsPolicy { auto_forward })
}
