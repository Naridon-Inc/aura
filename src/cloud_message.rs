//! `aura message` — send one message, exactly once (AURA-1437, item 8).
//!
//! `aura workspace prompt` already sends a prompt and is the verb a person
//! reaches for. This noun exists for the caller that is not a person: it
//! returns the message as an object, it can fetch one back by id, and it takes
//! `--message-id`, a key you choose that makes a retry safe.
//!
//! ## What the key is for
//!
//! A send that times out tells you nothing. The request may never have
//! arrived, or it may have arrived and started a turn whose answer you lost.
//! Retrying without a key risks two turns; not retrying risks none. With a
//! key, the retry is free — the first message comes back, labelled
//! `(already sent)`, and nothing else happens.
//!
//! Use something that identifies the *intent* of the send and not the attempt:
//! `--message-id "review-pr-412"` is right, a fresh uuid per attempt defeats
//! the point.
//!
//! ## Exit codes
//!
//! The contract in [`crate::cloud_contract`]: 0 sent, 2 for a usage mistake
//! caught here (no text, an empty key), 3 for a key the server refuses, 1 for
//! anything else — a workspace that does not exist, an archived one, an
//! unreachable server.

use clap::Subcommand;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::Client;
use crate::workspace_api::output;

#[derive(Subcommand, Debug)]
pub enum MessageCmd {
    /// Send a message to a workspace.
    Create {
        /// The workspace to send to.
        #[arg(long)]
        workspace: String,
        /// What to say. `-` reads it from stdin.
        #[arg(long)]
        text: String,
        /// Your own name for this message. Send the same one again and the
        /// first message comes back instead of a second being created. Name
        /// the intent, not the attempt.
        #[arg(long = "message-id")]
        message_id: Option<String>,
        /// Model override for this turn only.
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Read one message back by the id a send returned.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

/// Read the text, honouring `-` for stdin.
///
/// Same shape as `routine create --prompt-file -`: a long prompt belongs in a
/// pipe, not in a shell argument that a quoting mistake can truncate.
fn read_text(raw: &str) -> Result<String, String> {
    if raw != "-" {
        return Ok(raw.to_string());
    }
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("could not read the message from stdin: {e}"))?;
    Ok(buf)
}

pub fn run(cmd: &MessageCmd) -> i32 {
    match execute(cmd) {
        Ok(code) => code,
        Err(e) => {
            output::print_error(&e);
            e.exit_code()
        }
    }
}

fn execute(cmd: &MessageCmd) -> Result<i32, crate::workspace_api::client::ApiError> {
    match cmd {
        MessageCmd::Create {
            workspace,
            text,
            message_id,
            model,
            json,
        } => {
            // Caught before the request so a mistake costs no round trip and
            // exits 2 like every other usage error. The server checks again,
            // because it stays the authority for every other client.
            let body = match read_text(text) {
                Ok(t) => t,
                Err(why) => {
                    eprintln!("  ✗ {why}");
                    return Ok(ExitCode::Runtime.code());
                }
            };
            if body.trim().is_empty() {
                eprintln!("  ✗ --text needs something to say");
                return Ok(ExitCode::Usage.code());
            }
            if let Some(k) = message_id {
                if k.trim().is_empty() {
                    eprintln!("  ✗ --message-id was empty — leave it out, or pass a key");
                    return Ok(ExitCode::Usage.code());
                }
            }
            let c = Client::from_env()?;
            let v = c.create_message(
                workspace,
                body.trim(),
                model.as_deref(),
                message_id.as_deref().map(str::trim),
            )?;
            output::emit(*json, &v, output::render_message);
            Ok(0)
        }
        MessageCmd::Get { id, json } => {
            let c = Client::from_env()?;
            let v = c.message(id)?;
            output::emit(*json, &v, output::render_message);
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_passed_through_unless_it_is_the_stdin_marker() {
        assert_eq!(read_text("Summarise the parser").unwrap(), "Summarise the parser");
    }

    #[test]
    fn a_dash_is_the_only_thing_that_means_stdin() {
        // "-x" and " - " are messages, not redirections. Guessing wider here
        // would make a message starting with a dash unsendable.
        assert_eq!(read_text("-x").unwrap(), "-x");
        assert_eq!(read_text(" - ").unwrap(), " - ");
    }
}
