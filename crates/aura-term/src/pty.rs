//! PTY layer — spawn a shell, stream its output, parse OSC 133 prompt markers.
//!
//! Uses `alacritty_terminal::tty` for the PTY primitive and the re-exported
//! `vte` parser for OSC sequence detection. Read side runs on a dedicated
//! blocking thread (File IO is not async on Unix); write side is a locked
//! cloned File descriptor so the UI main loop can inject keystrokes from any
//! tokio task.
//!
//! OSC 133 semantics we care about:
//!   * ESC ] 133 ; A ST         — prompt start
//!   * ESC ] 133 ; B ST         — command start (user input region begins)
//!   * ESC ] 133 ; C ST         — command execution start
//!   * ESC ] 133 ; D [; exit] ST — command complete
//!
//! The bridge (W4.T3) uses `CommandStart` → open a Block, `CommandEnd` →
//! transition it to Completed/Failed. Raw output between markers flows as
//! `PtyEvent::Output`.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::{self, Options, Shell};
use alacritty_terminal::vte::{Params, Parser, Perform};
use bytes::Bytes;
use tokio::sync::mpsc;

use crate::error::{Result, TermError};

const READ_BUF_BYTES: usize = 4096;
const EVENT_CHANNEL_CAPACITY: usize = 512;

#[derive(Debug, Clone)]
pub enum PtyEvent {
    Output(Bytes),
    Marker(Osc133),
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Osc133 {
    PromptStart,
    CommandStart,
    CommandExec,
    CommandEnd { exit: Option<i32> },
}

#[derive(Clone, Debug)]
pub struct PtyConfig<'a> {
    pub cwd: &'a Path,
    pub shell: &'a str,
    pub shell_args: &'a [&'a str],
    pub size: WindowSize,
    /// Extra environment to merge on top of the inherited env. Used e.g. for
    /// `ZDOTDIR` to point zsh at an aura-installed integration zshrc.
    pub extra_env: Vec<(String, String)>,
}

pub struct PtySession {
    events: Option<mpsc::Receiver<PtyEvent>>,
    writer: Arc<Mutex<File>>,
}

impl PtySession {
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock().map_err(|_| {
            TermError::Config("pty writer lock poisoned".into())
        })?;
        guard.write_all(bytes)?;
        Ok(())
    }

    /// Detach the event stream. The first caller gets the Receiver; subsequent
    /// calls return `None`. Used at App init time where the Receiver is moved
    /// into a subscription stream and the rest of the session (writer) is kept
    /// behind an `Arc` for write access.
    pub fn take_events(&mut self) -> Option<mpsc::Receiver<PtyEvent>> {
        self.events.take()
    }

    /// Resize the pseudo-terminal. `cols`/`rows` are cell counts; the pixel
    /// fields are optional hints (apps like `less` and `vim` mostly ignore
    /// them). Issues `TIOCSWINSZ` on the master fd we already hold in the
    /// writer — same mechanism alacritty uses, just driven from the UI
    /// thread instead of the read loop.
    pub fn resize(&self, cols: u16, rows: u16, px_w: u16, px_h: u16) -> Result<()> {
        let guard = self
            .writer
            .lock()
            .map_err(|_| TermError::Config("pty writer lock poisoned".into()))?;
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: px_w,
            ws_ypixel: px_h,
        };
        let ret = unsafe {
            libc::ioctl(guard.as_raw_fd(), libc::TIOCSWINSZ as _, &ws as *const _)
        };
        if ret != 0 {
            return Err(TermError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

/// Spawn a shell inside a PTY. Returns a session whose `events` channel
/// streams Output + Marker events until the child exits (Closed).
pub fn spawn(cfg: PtyConfig<'_>) -> Result<PtySession> {
    let mut env: std::collections::HashMap<String, String> = Default::default();
    for (k, v) in &cfg.extra_env {
        env.insert(k.clone(), v.clone());
    }
    let options = Options {
        shell: Some(Shell::new(
            cfg.shell.to_string(),
            cfg.shell_args.iter().map(|s| (*s).to_string()).collect(),
        )),
        working_directory: Some(PathBuf::from(cfg.cwd)),
        drain_on_exit: false,
        env,
    };

    let pty = tty::new(&options, cfg.size, 0)
        .map_err(|e| TermError::Config(format!("pty spawn: {e}")))?;

    let write_file = pty
        .file()
        .try_clone()
        .map_err(TermError::Io)?;

    let (ev_tx, ev_rx) = mpsc::channel::<PtyEvent>(EVENT_CHANNEL_CAPACITY);

    thread::Builder::new()
        .name("aura-term-pty-read".into())
        .spawn(move || read_loop(pty, ev_tx))
        .map_err(TermError::Io)?;

    Ok(PtySession {
        events: Some(ev_rx),
        writer: Arc::new(Mutex::new(write_file)),
    })
}

/// Drives the read side: owns the Pty (keeps the child alive), reads bytes,
/// feeds them through the vte parser to detect OSC 133, and emits PtyEvents.
fn read_loop(pty: tty::Pty, tx: mpsc::Sender<PtyEvent>) {
    let mut read_file = match pty.file().try_clone() {
        Ok(f) => f,
        Err(_) => {
            let _ = tx.blocking_send(PtyEvent::Closed);
            return;
        }
    };

    // alacritty_terminal sets O_NONBLOCK on the master fd for use with its
    // own poller. We drive reads from a dedicated blocking thread, so flip
    // the flag off on our view. F_SETFL on a dup'd fd alters the shared
    // file description — that is fine here since nothing else reads this
    // master concurrently.
    if let Err(e) = set_blocking(&read_file) {
        let _ = tx.blocking_send(PtyEvent::Closed);
        tracing::warn!(error = %e, "failed to clear O_NONBLOCK on pty master");
        drop(pty);
        return;
    }

    let mut parser = Parser::new();
    let mut handler = Osc133Handler::default();
    let mut buf = [0u8; READ_BUF_BYTES];

    loop {
        match read_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                handler.markers.clear();
                parser.advance(&mut handler, &buf[..n]);
                for marker in handler.markers.drain(..) {
                    if tx.blocking_send(PtyEvent::Marker(marker)).is_err() {
                        drop(pty);
                        return;
                    }
                }
                let bytes = Bytes::copy_from_slice(&buf[..n]);
                if tx.blocking_send(PtyEvent::Output(bytes)).is_err() {
                    drop(pty);
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }

    let _ = tx.blocking_send(PtyEvent::Closed);
    drop(pty);
}

#[derive(Default)]
struct Osc133Handler {
    markers: Vec<Osc133>,
}

impl Perform for Osc133Handler {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // OSC 133 ; <letter> [; <args>] ST
        if params.first().copied() != Some(b"133") {
            return;
        }
        let Some(letter) = params.get(1).and_then(|p| p.first().copied()) else {
            return;
        };
        let marker = match letter {
            b'A' => Osc133::PromptStart,
            b'B' => Osc133::CommandStart,
            b'C' => Osc133::CommandExec,
            b'D' => {
                let exit = params
                    .get(2)
                    .and_then(|p| std::str::from_utf8(p).ok())
                    .and_then(|s| s.parse::<i32>().ok());
                Osc133::CommandEnd { exit }
            }
            _ => return,
        };
        self.markers.push(marker);
    }

    fn print(&mut self, _c: char) {}
    fn execute(&mut self, _byte: u8) {}
    fn hook(
        &mut self,
        _params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
    }
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}
    fn csi_dispatch(
        &mut self,
        _params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
    }
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

fn set_blocking(file: &File) -> std::io::Result<()> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let cleared = flags & !libc::O_NONBLOCK;
    if cleared == flags {
        return Ok(());
    }
    let res = unsafe { libc::fcntl(fd, libc::F_SETFL, cleared) };
    if res == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub fn default_window_size() -> WindowSize {
    WindowSize {
        num_lines: 24,
        num_cols: 80,
        cell_width: 10,
        cell_height: 20,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_echo_emits_output_then_closed() {
        let cwd = env::current_dir().expect("cwd");
        let mut session = spawn(PtyConfig {
            cwd: &cwd,
            shell: "/bin/sh",
            shell_args: &["-c", "printf 'hello-aura'; sleep 0.05"],
            size: default_window_size(),
            extra_env: Vec::new(),
        })
        .expect("spawn");
        let mut events = session.take_events().expect("events");

        let mut collected = Vec::<u8>::new();
        let mut saw_closed = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
                Ok(Some(PtyEvent::Output(b))) => collected.extend_from_slice(&b),
                Ok(Some(PtyEvent::Marker(_))) => {}
                Ok(Some(PtyEvent::Closed)) | Ok(None) => {
                    saw_closed = true;
                    break;
                }
                Err(_) => {}
            }
        }

        let out = String::from_utf8_lossy(&collected);
        assert!(
            out.contains("hello-aura"),
            "expected output to contain 'hello-aura', got: {out:?}",
        );
        assert!(saw_closed, "expected Closed event within deadline");
    }

    #[test]
    fn osc133_handler_extracts_command_end_exit() {
        let mut parser = Parser::new();
        let mut handler = Osc133Handler::default();
        let seq = b"\x1b]133;D;0\x1b\\";
        parser.advance(&mut handler, seq);
        assert_eq!(
            handler.markers,
            vec![Osc133::CommandEnd { exit: Some(0) }]
        );
    }

    #[test]
    fn osc133_handler_detects_prompt_start() {
        let mut parser = Parser::new();
        let mut handler = Osc133Handler::default();
        let seq = b"\x1b]133;A\x1b\\";
        parser.advance(&mut handler, seq);
        assert_eq!(handler.markers, vec![Osc133::PromptStart]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resize_sets_new_winsize_on_master() {
        // Spawn a shell that reports the terminal rows×cols via `stty size`,
        // resize the PTY, ask again, and confirm the second size reflects
        // what we set. This verifies the ioctl actually hits the kernel.
        let cwd = env::current_dir().expect("cwd");
        let session = spawn(PtyConfig {
            cwd: &cwd,
            shell: "/bin/sh",
            shell_args: &["-c", "stty size; sleep 0.05; stty size"],
            size: default_window_size(),
            extra_env: Vec::new(),
        })
        .expect("spawn");

        // Give the child a moment to print the first size, then resize.
        tokio::time::sleep(Duration::from_millis(20)).await;
        session.resize(132, 40, 0, 0).expect("resize");

        let mut events = {
            let mut s = session;
            s.take_events().expect("events")
        };
        let mut collected = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
                Ok(Some(PtyEvent::Output(b))) => {
                    collected.push_str(&String::from_utf8_lossy(&b));
                }
                Ok(Some(PtyEvent::Closed)) | Ok(None) => break,
                _ => {}
            }
        }
        assert!(
            collected.contains("40 132"),
            "expected post-resize output '40 132', got: {collected:?}",
        );
    }

    #[test]
    fn osc133_ignores_other_osc_codes() {
        let mut parser = Parser::new();
        let mut handler = Osc133Handler::default();
        let seq = b"\x1b]0;window title\x1b\\";
        parser.advance(&mut handler, seq);
        assert!(handler.markers.is_empty());
    }
}
