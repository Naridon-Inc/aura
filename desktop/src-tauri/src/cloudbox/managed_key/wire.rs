//! The agent protocol, as bytes.
//!
//! Pure: buffers in, buffers out, no socket and no network. It is here on its
//! own because the encoding is the part that is easy to get quietly wrong — a
//! length prefix counted from the wrong offset produces an agent that hangs
//! rather than one that fails, and the far side reports it as
//! `Permission denied (publickey)` either way.
//!
//! Only three messages matter, and this speaks exactly those:
//!
//!   * `REQUEST_IDENTITIES` → `IDENTITIES_ANSWER` — "what keys have you got?"
//!     One, always: the public half of the key the box already trusts.
//!   * `SIGN_REQUEST` → `SIGN_RESPONSE` — "sign this". The only message that
//!     needs the secret, which is why it is the only one that leaves this
//!     laptop.
//!   * anything else → `FAILURE`. Adding a key, removing one, locking the
//!     agent, the extension mechanism: every one of them is a write against a
//!     keyring, and this agent has no keyring to write to. Refusing them is not
//!     a limitation to be filled in later — an agent that could be *given* a key
//!     is an agent that could be made to hold one on disk.

/// The four bytes of length that start every message on this wire.
const HEADER: usize = 4;

/// The largest message this will read. A sign request carries a session
/// identifier and a public key — a few hundred bytes. The cap is what stops a
/// process on this laptop from making the agent allocate on a claimed length it
/// never intends to send.
pub const MAX_FRAME: usize = 256 * 1024;

pub const SSH_AGENT_FAILURE: u8 = 5;
pub const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
pub const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
pub const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
pub const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

/// What the far side asked for, once it is a message rather than bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// "What keys have you got?"
    Identities,
    /// "Sign this, with that key."
    Sign {
        /// Which key. Checked against ours rather than ignored — an agent that
        /// signs with whatever it has when asked for a key it does not hold is
        /// an agent that lies about which machine it is.
        key_blob: Vec<u8>,
        /// The bytes to sign. Not interpreted here, or anywhere: see the note
        /// on the server's signer for why parsing them would be the wrong
        /// guard.
        data: Vec<u8>,
    },
    /// Something this agent does not do. Every one of them is a keyring write.
    Unsupported,
}

/// How long a message claims to be, if the front of the buffer says.
///
/// `None` means "not yet" — the caller reads more and asks again. A length over
/// [`MAX_FRAME`] is an error rather than a wait, because waiting for the rest of
/// a message nobody is sending is how an agent socket ends up pinned open.
pub fn frame_len(buf: &[u8]) -> Result<Option<usize>, String> {
    if buf.len() < HEADER {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(format!("a message claiming {len} bytes is not one"));
    }
    Ok(Some(len))
}

/// One whole message, if the buffer holds it all.
pub fn take_frame(buf: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    let Some(len) = frame_len(buf)? else {
        return Ok(None);
    };
    if buf.len() < HEADER + len {
        return Ok(None);
    }
    let body = buf[HEADER..HEADER + len].to_vec();
    buf.drain(..HEADER + len);
    Ok(Some(body))
}

/// Read a message body as the question it is.
///
/// A malformed sign request reads as [`Ask::Unsupported`] rather than as an
/// error. The distinction matters on a socket: an error tears the connection
/// down and the far side reports the whole agent as broken, where a `FAILURE`
/// answer lets it move on to the next key it was going to try anyway.
pub fn read(body: &[u8]) -> Ask {
    let Some((&kind, rest)) = body.split_first() else {
        return Ask::Unsupported;
    };
    match kind {
        SSH_AGENTC_REQUEST_IDENTITIES => Ask::Identities,
        SSH_AGENTC_SIGN_REQUEST => {
            let Some((key_blob, rest)) = take_string(rest) else {
                return Ask::Unsupported;
            };
            let Some((data, _flags)) = take_string(rest) else {
                return Ask::Unsupported;
            };
            // The flags tail is deliberately dropped. It exists to pick between
            // an RSA key's hash algorithms, and an ed25519 key has exactly one
            // signature to give — so there is nothing here for a flag to
            // choose, and honouring one would mean pretending otherwise.
            Ask::Sign {
                key_blob: key_blob.to_vec(),
                data: data.to_vec(),
            }
        }
        _ => Ask::Unsupported,
    }
}

/// The one-key answer to "what have you got?".
pub fn identities_answer(key_blob: &[u8], comment: &str) -> Vec<u8> {
    let mut body = vec![SSH_AGENT_IDENTITIES_ANSWER];
    body.extend_from_slice(&1u32.to_be_bytes());
    push_string(&mut body, key_blob);
    push_string(&mut body, comment.as_bytes());
    framed(body)
}

/// A signature, in the envelope the protocol wants it in.
///
/// `signature` is already `string(algorithm) string(sig)` — the server built it
/// that way, and re-wrapping it here would be a second opinion about an
/// encoding only one side can be right about.
pub fn sign_response(signature: &[u8]) -> Vec<u8> {
    let mut body = vec![SSH_AGENT_SIGN_RESPONSE];
    push_string(&mut body, signature);
    framed(body)
}

/// No.
///
/// Said the same way whatever the reason — a message we do not implement, a key
/// we do not hold, a network that did not answer. The far side's next move is
/// identical in all three cases (try the next key, then give up), and spelling
/// them apart on this wire would only give a process on this laptop a way to
/// probe which places the member can reach.
pub fn failure() -> Vec<u8> {
    framed(vec![SSH_AGENT_FAILURE])
}

fn framed(body: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// A wire string: four bytes of big-endian length, then the bytes.
fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// One wire string off the front of a buffer, and what is left.
fn take_string(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.len() < HEADER {
        return None;
    }
    let (len, rest) = bytes.split_at(HEADER);
    let len = u32::from_be_bytes([len[0], len[1], len[2], len[3]]) as usize;
    if rest.len() < len {
        return None;
    }
    Some(rest.split_at(len))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sign request, built the way the far side builds one.
    fn sign_request(key_blob: &[u8], data: &[u8], flags: u32) -> Vec<u8> {
        let mut body = vec![SSH_AGENTC_SIGN_REQUEST];
        push_string(&mut body, key_blob);
        push_string(&mut body, data);
        body.extend_from_slice(&flags.to_be_bytes());
        body
    }

    #[test]
    fn a_sign_request_reads_as_the_key_and_the_bytes() {
        let ask = read(&sign_request(b"a-public-blob", b"the bytes to sign", 0));
        assert_eq!(
            ask,
            Ask::Sign {
                key_blob: b"a-public-blob".to_vec(),
                data: b"the bytes to sign".to_vec(),
            }
        );
    }

    #[test]
    fn the_flags_tail_changes_nothing() {
        // An ed25519 key has one signature to give. A request that asks for a
        // different hash is answered the same way rather than refused, because
        // the far side sets these flags speculatively for every key it tries.
        let plain = read(&sign_request(b"k", b"d", 0));
        let flagged = read(&sign_request(b"k", b"d", 0x02));
        assert_eq!(plain, flagged);
    }

    #[test]
    fn a_truncated_request_is_a_refusal_rather_than_a_torn_connection() {
        // Both halves matter: a body that stops mid-string, and one that has a
        // key but no data. Either would panic a naive parser, and a panic on
        // this socket takes the whole agent down mid-connection.
        assert_eq!(read(&[SSH_AGENTC_SIGN_REQUEST, 0, 0, 0]), Ask::Unsupported);
        let mut short = vec![SSH_AGENTC_SIGN_REQUEST];
        push_string(&mut short, b"only-a-key");
        assert_eq!(read(&short), Ask::Unsupported);
        assert_eq!(read(&[]), Ask::Unsupported);
    }

    #[test]
    fn a_string_longer_than_what_follows_it_is_refused() {
        // The length prefix is attacker-controlled once anything on this laptop
        // can open the socket. Believing it is how a parser reads past its own
        // buffer.
        let mut lying = vec![SSH_AGENTC_SIGN_REQUEST];
        lying.extend_from_slice(&99u32.to_be_bytes());
        lying.extend_from_slice(b"short");
        assert_eq!(read(&lying), Ask::Unsupported);
    }

    #[test]
    fn every_keyring_write_is_refused() {
        // Add, remove, remove-all, lock, unlock, the extension mechanism. This
        // agent holds no keyring, so there is nothing for any of them to mean —
        // and an agent that could be handed a key is one that could be made to
        // keep it.
        for keyring_write in [17u8, 18, 19, 20, 21, 22, 25, 26, 27] {
            assert_eq!(read(&[keyring_write]), Ask::Unsupported);
        }
    }

    #[test]
    fn the_identities_answer_is_one_key_and_its_name() {
        let answer = identities_answer(b"blob", "aura-managed");
        let mut buf = answer.clone();
        let body = take_frame(&mut buf).expect("well formed").expect("whole");
        assert!(buf.is_empty(), "the frame length covered more than the frame");
        assert_eq!(body[0], SSH_AGENT_IDENTITIES_ANSWER);
        assert_eq!(u32::from_be_bytes([body[1], body[2], body[3], body[4]]), 1);
        let (blob, rest) = take_string(&body[5..]).expect("a blob");
        assert_eq!(blob, b"blob");
        let (comment, tail) = take_string(rest).expect("a comment");
        assert_eq!(comment, b"aura-managed");
        assert!(tail.is_empty());
    }

    #[test]
    fn a_signature_goes_back_exactly_as_the_server_built_it() {
        // Re-wrapping would be a second opinion about an encoding only one side
        // can be right about — and the failure it produces is a box that
        // refuses the connection with no clue why.
        let signature = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x40sixty-four-bytes";
        let mut buf = sign_response(signature);
        let body = take_frame(&mut buf).expect("well formed").expect("whole");
        assert_eq!(body[0], SSH_AGENT_SIGN_RESPONSE);
        let (inner, tail) = take_string(&body[1..]).expect("a signature");
        assert_eq!(inner, signature);
        assert!(tail.is_empty());
    }

    #[test]
    fn a_message_arrives_a_byte_at_a_time_and_still_reads_whole() {
        // What a socket actually does. A parser that assumed one read per
        // message would work on a loopback socket and fail on a busy one.
        let whole = identities_answer(b"blob", "aura-managed");
        let mut buf: Vec<u8> = vec![];
        for (i, byte) in whole.iter().enumerate() {
            buf.push(*byte);
            let taken = take_frame(&mut buf).expect("well formed");
            if i + 1 < whole.len() {
                assert!(taken.is_none(), "a partial message read as whole at {i}");
            } else {
                assert!(taken.is_some(), "the last byte did not complete it");
            }
        }
    }

    #[test]
    fn two_messages_in_one_read_are_two_messages() {
        let mut buf = failure();
        buf.extend(identities_answer(b"blob", "c"));
        assert_eq!(
            take_frame(&mut buf).expect("well formed").expect("whole")[0],
            SSH_AGENT_FAILURE
        );
        assert_eq!(
            take_frame(&mut buf).expect("well formed").expect("whole")[0],
            SSH_AGENT_IDENTITIES_ANSWER
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn a_length_nobody_intends_to_send_is_refused_rather_than_waited_for() {
        let mut absurd = (MAX_FRAME as u32 + 1).to_be_bytes().to_vec();
        absurd.push(SSH_AGENTC_REQUEST_IDENTITIES);
        assert!(take_frame(&mut absurd).is_err());
        // Zero too: a message with no type byte is not a message, and treating
        // it as one would loop forever on a buffer that never shrinks.
        let mut empty = vec![0, 0, 0, 0];
        assert!(take_frame(&mut empty).is_err());
    }

    #[test]
    fn nothing_here_can_carry_a_private_key() {
        // The three answers this agent can ever give, checked as bytes. There is
        // no message in this module whose payload comes from anywhere but a
        // public blob, a comment, or a signature the server made.
        let answers = [
            identities_answer(b"a-public-blob", "aura-managed"),
            sign_response(b"a-signature"),
            failure(),
        ];
        for answer in answers {
            let text = String::from_utf8_lossy(&answer).to_ascii_uppercase();
            assert!(!text.contains("PRIVATE"));
            assert!(!text.contains("-----BEGIN"));
        }
    }
}
