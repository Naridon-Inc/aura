//! A terminal of its own for one agent sign-in, and the pipes for one that
//! needs none.
//!
//! Each child runs as the leader of its own process group, so stopping it
//! stops everything it started. Its output is read on a thread of its own and
//! handed over in chunks; nothing here keeps or prints what it says.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};

/// Wide enough that a long token is never wrapped.
const COLS: u16 = 1000;
const ROWS: u16 = 50;

/// A running sign-in: its output as it comes, and a way to type into it.
pub struct Running {
    pub output: Receiver<Vec<u8>>,
    input: Option<File>,
    child: Option<Child>,
}

fn reader(mut from: impl Read + Send + 'static, to: Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match from.read(&mut buf) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // A terminal whose other end has closed answers EIO: that is
                // its end, like a pipe's 0.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if to.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Run `cmd` in a new terminal.
pub fn in_terminal(mut cmd: Command) -> io::Result<Running> {
    let (mut master, mut slave): (libc::c_int, libc::c_int) = (-1, -1);
    let mut size = libc::winsize { ws_row: ROWS, ws_col: COLS, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: openpty writes two descriptors it opened into the two ints and
    // reads the window size; no name buffer or termios is passed.
    let rc = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both were just opened by openpty and are owned by nothing else.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // SAFETY: setting close-on-exec on a descriptor this process owns.
    unsafe {
        let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFD);
        libc::fcntl(master.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
    cmd.stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls between fork and exec. The child
    // leads a new session, so the terminal becomes its own and a group kill
    // reaches everything it starts.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            libc::ioctl(0, libc::TIOCSCTTY as _, 0);
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(cmd);
    let (tx, rx) = mpsc::channel();
    reader(File::from(master.try_clone()?), tx);
    Ok(Running { output: rx, input: Some(File::from(master)), child: Some(child) })
}

/// Run `cmd` with its output on pipes and nothing to type into.
pub fn on_pipes(mut cmd: Command) -> io::Result<Running> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = cmd.spawn()?;
    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        reader(err, tx);
    }
    Ok(Running { output: rx, input: None, child: Some(child) })
}

impl Running {
    /// Type into the terminal.
    pub fn type_in(&mut self, bytes: &[u8]) -> io::Result<()> {
        let w = self.input.as_mut().ok_or_else(|| io::Error::other("nothing to type into"))?;
        w.write_all(bytes)?;
        w.flush()
    }

    /// Whether it has exited, and how.
    pub fn exited(&mut self) -> Option<bool> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            _ => None,
        }
    }

    /// Stop it and everything it started. Our end of the terminal is closed
    /// before anything waits on it: a process killed with output still unread
    /// on its terminal cannot finish exiting on macOS, so a wait with the
    /// terminal open would never return. The reap happens off to the side.
    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else { return };
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: signalling the process group this child leads.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        self.input = None;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn gather(r: &Running, until: impl Fn(&str) -> bool) -> String {
        let end = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while Instant::now() < end {
            match r.output.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => seen.extend(chunk),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(_) => {}
            }
            if until(&String::from_utf8_lossy(&seen)) {
                break;
            }
        }
        String::from_utf8_lossy(&seen).into_owned()
    }

    #[test]
    fn a_terminal_is_wide_and_takes_what_is_typed() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "stty size; read line; echo \"got:$line\"; sleep 30"]);
        let mut r = in_terminal(cmd).expect("a terminal");
        assert!(gather(&r, |s| s.contains("50 1000")).contains("50 1000"), "50 rows, 1000 columns");
        r.type_in(b"hello\r").unwrap();
        assert!(gather(&r, |s| s.contains("got:hello")).contains("got:hello"));
        let t = Instant::now();
        r.stop();
        assert!(t.elapsed() < Duration::from_secs(2), "stopping never waits on the child");
        gather(&r, |_| false);
    }

    #[test]
    fn stopping_reaches_what_the_child_started() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("grandchild.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("sleep 30 & echo $! > {}; echo started; wait", marker.display()));
        let mut r = on_pipes(cmd).expect("pipes");
        assert!(gather(&r, |s| s.contains("started")).contains("started"));
        r.stop();
        let pid: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process is still there.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the grandchild is gone too");
    }
}
