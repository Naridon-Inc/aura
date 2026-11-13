//! Aura's Agent Client Protocol (ACP) client: one implementation shared by
//! the desktop chat, the manager brain, the CLI and the cloud box relay.
//!
//! Wire types, method names and error codes come from the protocol's own
//! schema crate (re-exported as [`schema`]); the transport, the session
//! driver and the gate hand-offs are Aura's, so a connection can survive a
//! dropped link to a remote box (see [`conn::Connection::reattach_at`]).

pub mod conn;
pub mod elicit;
pub mod permission;
pub mod profile;
pub mod registry;
pub mod rpc;
pub mod session;
pub mod update;

pub use agent_client_protocol_schema as schema;
pub use conn::{ConnOpts, Connection, Inbound, LinkState};
pub use profile::{AgentProfile, AuthMethod, ClientCaps, ClientInfo, ConfigOption, PROTOCOL_VERSION};
pub use rpc::RpcError;
pub use session::{AcpError, Driver, OpenRequest, Opened, PromptOutcome, Session};
pub use update::{Update, UpdateKind};
