//! PTY subscription + keyboard-to-bytes plumbing for aura-proto.
//!
//! A single-slot `OnceLock` holds the `mpsc::Receiver<PtyEvent>` between
//! app init (where `pty::spawn` returns it) and the first poll of the iced
//! subscription stream (which is a `fn()` pointer and therefore must be
//! non-capturing). Pattern cribbed from aura-term/src/app.rs.

use std::sync::OnceLock;

use bytes::Bytes;
use futures::SinkExt;
use tokio::sync::mpsc;

use crate::pty::PtyEvent;
use crate::Message;

static PTY_EVENTS_SLOT: OnceLock<std::sync::Mutex<Option<mpsc::Receiver<PtyEvent>>>> =
    OnceLock::new();

pub fn install_receiver(rx: mpsc::Receiver<PtyEvent>) {
    let slot = PTY_EVENTS_SLOT.get_or_init(|| std::sync::Mutex::new(None));
    *slot.lock().unwrap() = Some(rx);
}

fn take_receiver() -> Option<mpsc::Receiver<PtyEvent>> {
    PTY_EVENTS_SLOT
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap()
        .take()
}

pub fn pty_event_stream() -> impl futures::Stream<Item = Message> {
    iced::stream::channel(512, async move |mut output: futures::channel::mpsc::Sender<Message>| {
        if let Some(mut rx) = take_receiver() {
            while let Some(ev) = rx.recv().await {
                if output.send(Message::PtyEvent(ev)).await.is_err() {
                    return;
                }
            }
        }
        std::future::pending::<()>().await;
    })
}

/// Map an iced key press to bytes to write to the PTY master. `None` means
/// the key should not be forwarded (unmapped named key, control-only modifier).
pub fn key_to_pty_bytes(
    key: &iced::keyboard::Key,
    modifiers: iced::keyboard::Modifiers,
    text: Option<&str>,
) -> Option<Bytes> {
    use iced::keyboard::{key::Named, Key};

    if modifiers.control() {
        if let Key::Character(c) = key {
            if let Some(ch) = c.chars().next() {
                let lower = ch.to_ascii_lowercase();
                if lower.is_ascii_alphabetic() {
                    return Some(Bytes::from(vec![(lower as u8) - b'a' + 1]));
                }
            }
        }
        return None;
    }

    match key {
        Key::Character(c) => Some(Bytes::from(
            text.unwrap_or(c.as_str()).as_bytes().to_vec(),
        )),
        Key::Named(named) => match named {
            Named::Enter => Some(Bytes::from_static(b"\r")),
            Named::Tab => Some(Bytes::from_static(b"\t")),
            Named::Space => Some(Bytes::from_static(b" ")),
            Named::Backspace => Some(Bytes::from_static(&[0x7f])),
            Named::Delete => Some(Bytes::from_static(b"\x1b[3~")),
            Named::Escape => Some(Bytes::from_static(b"\x1b")),
            Named::ArrowUp => Some(Bytes::from_static(b"\x1b[A")),
            Named::ArrowDown => Some(Bytes::from_static(b"\x1b[B")),
            Named::ArrowRight => Some(Bytes::from_static(b"\x1b[C")),
            Named::ArrowLeft => Some(Bytes::from_static(b"\x1b[D")),
            Named::Home => Some(Bytes::from_static(b"\x1b[H")),
            Named::End => Some(Bytes::from_static(b"\x1b[F")),
            Named::PageUp => Some(Bytes::from_static(b"\x1b[5~")),
            Named::PageDown => Some(Bytes::from_static(b"\x1b[6~")),
            _ => None,
        },
        _ => None,
    }
}
