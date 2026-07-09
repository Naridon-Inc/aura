//! aura-daemon-client — protocol types + client stub for aura-ipc v1.
//!
//! Tier 0. Depended on by aura-daemon (the server), aura-term, aura-proto,
//! and future thin CLIs. Wire format is CBOR (ciborium) over a framed
//! Unix-domain socket. Envelope shape tracks docs/plan/04-architecture.md.

pub mod envelope;
pub mod paths;
pub mod protocol;
pub mod client;
pub mod error;
pub mod events;

pub use client::Client;
pub use envelope::{Envelope, MessageKind, FRAME_MAX_BYTES, PROTOCOL_VERSION};
pub use error::{ProtocolError, ProtocolErrorKind};
pub use events::EventStream;
pub use protocol::{
    EventBody, HandshakeAck, HandshakeRequest, RequestBody, ResponseBody,
    SessionId, SubscribeFilter,
};
