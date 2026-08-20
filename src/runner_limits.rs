//! What one member's share of a box is, worked out by the box itself.
//!
//! [`super::runner_service`] has been able to render `CPUQuota=` and
//! `MemoryMax=` since the unit was first written. Both defaulted to unset, and
//! nothing that installs a runner ever passed them — so every box set up
//! through the connect wizard got a unit with no limits at all, on the very
//! flag (`--user`) whose entire promise is that one member cannot starve
//! another. The isolation was rendered, and never switched on.
//!
//! What that cost: on 2026-08-04 a swapless 8 GB box locked up mid-run. One
//! build took every page of memory, the kernel had nowhere to reclaim to, and
//! the machine stopped answering ssh while its health check still reported it
//! fine. Nothing was over quota, because nothing had a quota.
//!
//! ## Why the numbers are derived here and not chosen on the laptop
//!
//! The connect wizard runs on somebody's Mac and is typing into a box it has
//! never measured. A constant picked there ("8G") is wrong in both directions:
//! it is most of a small box's memory, and a rounding error on a large one. So
//! the wizard passes [`AUTO`] and the box answers, because the box is the only
//! participant that knows how big it is and how many people are on it.
//!
//! That also settles the parity rule this programme runs under. Every way of
//! getting a runner — the wizard, a place Aura provisions, an operator typing
//! `aura runner install` over ssh — ends at the same command on the same
//! machine, so all three derive the same limits from the same measurement. A
//! number computed in the wizard would have been a number the other two ways
//! never got.
//!
//! ## What these limits do and do not promise
//!
//! They promise that **no one member's runner can take the whole box**: the
//! memory the kernel and sshd need is outside every member's cap, so a machine
//! under a hostile build stays a machine you can log into and look at. That is
//! the wedge, and it is the thing that is fixed.
//!
//! They do not promise that N members running flat out sum to less than the
//! box. They cannot: a unit is written once, at install time, and a member who
//! joins later does not rewrite the units of the members already here. Caps are
//! ceilings rather than reservations, and what happens when several members
//! push against theirs at once is contention — slower builds, pages moving to
//! swap — not the hard stall that has no way out. [`derive`] deliberately
//! leaves the headroom outside every share so that contention has somewhere to
//! happen.

use std::path::Path;

/// What the caller passes instead of a systemd value when it wants the box to
/// decide. Spelled as a value of the existing `--cpu-quota` / `--memory-max`
/// flags rather than as a separate `--auto` switch, so that "let the box
/// choose" and "I know exactly what I want" stay one flag with one meaning
/// each, and an operator can mix them freely.
pub const AUTO: &str = "auto";

/// Is this flag value a request for the box to size itself?
///
/// Case-insensitive because it is typed by hand as often as it is rendered by
/// the wizard, and refusing `AUTO` on a shared box would silently install the
/// unlimited unit this module exists to stop.
pub fn is_auto(v: &str) -> bool {
    v.trim().eq_ignore_ascii_case(AUTO)
}

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// How big the box is, and how many people are on it.
///
/// Every field is measured rather than configured. A struct instead of five
/// arguments so [`derive`] is a pure function of a machine's description, and
/// the sizing can be tested against boxes nobody has to rent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxSize {
    /// Hardware threads the scheduler will hand out.
    pub cores: u32,
    /// `MemTotal`, in bytes.
    pub mem_bytes: u64,
    /// `SwapTotal`, in bytes. Zero is the shape of the box that wedged, and is
    /// reported rather than assumed away — see [`Limits::swapless`].
    pub swap_bytes: u64,
    /// Capacity of the filesystem the member's home sits on, in bytes.
    pub disk_bytes: u64,
    /// How many people share this machine, counted from its own account list.
    /// Never zero; see [`count_members`].
    pub members: u32,
}

/// One member's share, in the syntax systemd reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// `CPUQuota=`, e.g. `"700%"` for seven cores' worth.
    pub cpu_quota: String,
    /// `MemoryMax=` — the hard ceiling this member's runner is killed at.
    pub memory_max: String,
    /// `MemorySwapMax=` — how much this member may push out to swap *on top of*
    /// [`Self::memory_max`], which is systemd's own arithmetic and not a typo:
    /// the two add up rather than the second being part of the first.
    pub memory_swap_max: String,
    /// `TasksMax=` — processes and threads together. A fork bomb is the other
    /// way to wedge a box, and it needs no memory at all.
    pub tasks_max: u32,
    /// `LimitFSIZE=` — the largest single file this member's runner may write.
    /// See [`derive`] for what this does and does not bound.
    pub max_file_size: u64,
    /// Did the box report no swap at all? Carried on the result rather than
    /// left in [`BoxSize`] because it is the one thing the caller has to *say*
    /// to the operator: a memory ceiling with no swap under it means a build
    /// that reaches the ceiling is killed where it could have been slowed.
    pub swapless: bool,
}

/// Bytes as systemd syntax, rounded **down** to whole mebibytes.
///
/// Down, always: rounding a share up is how a set of limits that looks correct
/// in a unit file adds up to more than the machine has. Mebibytes rather than
/// raw bytes because a person reads these in `systemctl cat` and `6656M` is a
/// size, where `6979321856` is a number to go and divide.
fn mib(bytes: u64) -> String {
    format!("{}M", (bytes / MIB).max(1))
}

/// The memory that belongs to the box rather than to anyone on it.
///
/// An eighth, floored at 768 MiB and capped at 4 GiB. The floor is what makes
/// this work on the small boxes people actually bring — on a 1 GB VM an eighth
/// is 128 MB, which is not enough for sshd, systemd and a shell to coexist with
/// a build that is allowed everything else. The cap is because a 128 GB box
/// does not need 16 GB set aside to stay loginable, and taking it would be this
/// module quietly deciding the operator bought too much machine.
///
/// Never more than half of memory, which only binds on boxes under 1.5 GB and
/// keeps the arithmetic from handing a member a share of nothing.
fn headroom(mem_bytes: u64) -> u64 {
    (mem_bytes / 8).clamp(768 * MIB, 4 * GIB).min(mem_bytes / 2)
}

/// Turn a measured box into one member's share of it.
///
/// **CPU.** One core's worth is left to the box before anything is divided, so
/// the operator's own ssh session is never competing with a runner for the last
/// scheduler slot — this is the difference between a slow box and one you
/// cannot get into to find out why it is slow. What remains is split by member
/// count and floored at half a core, because a runner throttled below that is
/// not a runner, it is a timeout.
///
/// **Memory.** [`headroom`] comes off the top and is never inside anyone's
/// share. The rest divides by member count. The floor is 256 MiB: a share
/// smaller than that cannot start an agent CLI, and installing a unit that
/// cannot start is worse than installing one that is too generous.
///
/// **Swap.** As much again as the memory cap. Swap is what turns "this build
/// hit its ceiling and was killed" into "this build got slow", and the box that
/// wedged had none — so the ceiling exists to be leaned on, and this is the
/// give underneath it. Capped by what the box actually has, since promising a
/// member 6 GB of swap on a box holding 2 GB of it is arithmetic, not memory.
///
/// **Tasks.** 1024 per core, split by member, floored at 512. High enough that
/// no real build notices, low enough that a runaway `fork()` hits a wall while
/// the box is still answering.
///
/// **File size.** The member's share of the disk, floored at 4 GiB. This bounds
/// a single runaway file — the log that never rotates, a core dump, a `dd` with
/// a typo in it — which is the disk failure that arrives in minutes. It does
/// not bound the sum of a member's files; that needs filesystem quotas, which
/// need a mount option nobody's cloud image sets. Claiming it as a disk budget
/// would be claiming more than it does.
pub fn derive(size: BoxSize) -> Limits {
    let share = size.members.max(1) as u64;

    // Reserve a core for the box, so the operator's ssh is never competing for
    // the last scheduler slot. A single-core box has nothing to reserve *from*
    // — taking half of its only core would halve the machine to guard against
    // a failure the scheduler does not actually have. CPU starvation slows a
    // box; it does not stop it answering, which is what `Nice=5` on the unit is
    // already for. Memory is the one that wedges, and memory is bounded below.
    let usable_cpu = match size.cores.max(1) {
        1 => 100,
        n => n as u64 * 100 - 100,
    };
    let cpu_pct = (usable_cpu / share).max(50);

    let usable_mem = size.mem_bytes.saturating_sub(headroom(size.mem_bytes));
    let member_mem = (usable_mem / share).max(256 * MIB);

    // Never more than the box holds: a member cannot be given swap that does
    // not exist, and writing a bigger number would make the unit read as a
    // promise the kernel never made.
    let member_swap = member_mem.min(size.swap_bytes);

    let tasks_max = ((size.cores.max(1) as u64 * 1024) / share).max(512) as u32;

    // A tenth of the disk, or 2 GiB, is left for everything that is not a
    // member's workspace — the OS, the package cache, the logs.
    let disk_reserve = (size.disk_bytes / 10).max(2 * GIB).min(20 * GIB);
    let usable_disk = size.disk_bytes.saturating_sub(disk_reserve);
    let max_file_size = (usable_disk / share).max(4 * GIB);

    Limits {
        cpu_quota: format!("{cpu_pct}%"),
        memory_max: mib(member_mem),
        // A plain `0` on a box with no swap, which is what systemd spells "may
        // use none" — and is the truth. `mib()` floors at one mebibyte because
        // a *memory* ceiling of zero would refuse to start anything; a swap
        // ceiling of zero is a correct description of a swapless machine.
        memory_swap_max: if member_swap == 0 {
            "0".to_string()
        } else {
            mib(member_swap)
        },
        tasks_max,
        max_file_size,
        swapless: size.swap_bytes == 0,
    }
}

/// Read `MemTotal` and `SwapTotal` out of `/proc/meminfo`.
///
/// Returns `None` off Linux and on anything without procfs, which is the honest
/// answer rather than a guess: a box we cannot measure is one we must not
/// invent limits for, and the caller falls back to installing the unit
/// unlimited with a warning rather than to a number nobody checked.
fn meminfo() -> Option<(u64, u64)> {
    let raw = std::fs::read_to_string("/proc/meminfo").ok()?;
    // Values are in kB, whatever the unit column says — that is procfs's own
    // long-standing lie and every parser of this file accounts for it.
    let field = |key: &str| -> Option<u64> {
        raw.lines()
            .find_map(|l| {
                l.strip_prefix(key)?
                    .trim()
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
            .map(|kb| kb * 1024)
    };
    let mem = field("MemTotal:")?;
    // A kernel built without swap support omits the line entirely, and that is
    // a real zero rather than a failure to read.
    Some((mem, field("SwapTotal:").unwrap_or(0)))
}

/// Capacity of the filesystem holding `path`.
///
/// `statvfs` rather than shelling out to `df`: this runs during an install that
/// may be happening over a wizard's ssh session, and a subprocess whose output
/// format varies by distro is a parse waiting to be wrong on somebody's box.
fn filesystem_bytes(path: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    // SAFETY: `stat` is fully initialised by `statvfs` before we read it, and
    // `c` is a NUL-terminated string that outlives the call.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
            return None;
        }
        // `f_frsize` is the fragment size blocks are counted in. `f_bsize` is
        // the preferred I/O size and is NOT the same number on every
        // filesystem — using it here is the classic way to report a disk
        // several times its real size.
        Some(stat.f_blocks as u64 * stat.f_frsize as u64)
    }
}

/// How many people share this box.
///
/// Counted from `/etc/passwd`, not asked of the caller. The wizard cannot
/// answer it — a member connecting today does not know who will be added
/// tomorrow — and a place Aura provisions would have to be told separately,
/// which is how the two modes drift apart. The box already holds the answer,
/// because [`crate::runner_service`]'s whole shared-box shape rests on each
/// member being a real Unix account.
///
/// Ordinary accounts only: uid 1000 and above is the Linux convention for a
/// person, and `nobody` (65534) is nobody. The bootstrap login the image came
/// with — `ubuntu`, `ec2-user` — is counted, which over-counts a box of one by
/// exactly nothing (it *is* that box's one account) and over-counts a shared
/// box by one. Over-counting shrinks every share, so the error is on the side
/// that cannot wedge a machine.
///
/// Falls back to 1, which yields the limits a box of your own should have:
/// everything except the headroom. That is still the fix — the wedge was one
/// build taking memory the kernel needed, and 1 member with headroom reserved
/// cannot do that.
pub fn count_members() -> u32 {
    let Ok(raw) = std::fs::read_to_string("/etc/passwd") else {
        return 1;
    };
    let n = raw
        .lines()
        .filter_map(|l| {
            let mut f = l.split(':');
            let _login = f.next()?;
            let _passwd = f.next()?;
            let uid: u32 = f.next()?.parse().ok()?;
            let shell = l.rsplit(':').next().unwrap_or("");
            // A uid in the human range whose shell is a refusal is a service
            // account somebody gave a high uid — a database, a CI daemon. It
            // is not a member and must not shrink anyone's share.
            let usable_shell = !shell.contains("nologin") && !shell.ends_with("/false");
            (uid >= 1000 && uid < 65534 && usable_shell).then_some(())
        })
        .count();
    (n as u32).max(1)
}

/// Measure this box.
///
/// `None` when the machine will not say how big it is, which off Linux is
/// always — this is a systemd installer, so the caller is already on a box
/// where that is the same conversation.
pub fn measure(home: &Path) -> Option<BoxSize> {
    let (mem_bytes, swap_bytes) = meminfo()?;
    Some(BoxSize {
        cores: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
        mem_bytes,
        swap_bytes,
        // A disk we cannot measure falls back to a size that makes the file
        // ceiling the 4 GiB floor rather than dropping the ceiling entirely.
        disk_bytes: filesystem_bytes(home).unwrap_or(0),
        members: count_members(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The box that wedged: 8 GB, two cores, no swap, one 100 GB disk.
    fn wedged_box() -> BoxSize {
        BoxSize {
            cores: 2,
            mem_bytes: 8 * GIB,
            swap_bytes: 0,
            disk_bytes: 100 * GIB,
            members: 1,
        }
    }

    #[test]
    fn the_memory_the_box_needs_to_stay_loginable_is_outside_every_share() {
        // The whole fix, stated as the one property that has to hold for every
        // box shape: whatever else is true, a member's ceiling is never the
        // machine's memory. If this ever passes at equality, a build that
        // reaches its cap has taken the pages sshd needed to let anyone in and
        // find out.
        for mem_gb in [1u64, 2, 4, 8, 16, 64, 128] {
            for members in [1u32, 2, 5, 20] {
                let size = BoxSize {
                    mem_bytes: mem_gb * GIB,
                    members,
                    ..wedged_box()
                };
                let l = derive(size);
                let cap: u64 = l.memory_max.trim_end_matches('M').parse().unwrap();
                assert!(
                    cap * MIB < size.mem_bytes,
                    "{mem_gb}GB / {members} members: a member may take {cap}M of {}M",
                    size.mem_bytes / MIB
                );
            }
        }
    }

    #[test]
    fn a_box_of_your_own_gets_everything_except_the_headroom() {
        // One member is not a reason to skip the limits — it is the 8 GB box
        // that wedged. It keeps its whole machine minus the part the kernel
        // needed all along.
        let l = derive(wedged_box());
        assert_eq!(l.memory_max, mib(8 * GIB - GIB));
        // Two cores, one left for the box.
        assert_eq!(l.cpu_quota, "100%");
    }

    #[test]
    fn a_shared_box_divides_what_is_left_between_the_people_on_it() {
        let l = derive(BoxSize {
            cores: 8,
            mem_bytes: 32 * GIB,
            swap_bytes: 8 * GIB,
            disk_bytes: 500 * GIB,
            members: 4,
        });
        // 32 GiB less a 4 GiB headroom, quartered.
        assert_eq!(l.memory_max, mib(7 * GIB));
        // Eight cores less one for the box, quartered.
        assert_eq!(l.cpu_quota, "175%");
    }

    #[test]
    fn one_member_can_never_be_promised_swap_the_box_does_not_have() {
        // A `MemorySwapMax` larger than `SwapTotal` reads as give that is not
        // there — the unit would look like it had somewhere to spill to.
        let l = derive(BoxSize {
            swap_bytes: 512 * MIB,
            ..wedged_box()
        });
        assert_eq!(l.memory_swap_max, mib(512 * MIB));
        assert!(!l.swapless);
    }

    #[test]
    fn a_box_with_no_swap_says_so_rather_than_pretending_to_have_some() {
        // This is the flag the installer turns into a sentence for the
        // operator. Silently emitting `MemorySwapMax=0` would be correct and
        // useless: it is the state that made a ceiling fatal instead of slow.
        let l = derive(wedged_box());
        assert!(l.swapless);
        assert_eq!(l.memory_swap_max, "0", "a swapless box may use no swap, and says so");
    }

    #[test]
    fn a_tiny_box_still_gets_a_share_it_can_actually_start_a_runner_in() {
        // 1 GB VM, five members. Dividing honestly gives 100 MB each, which
        // cannot start an agent CLI — and a unit that cannot start is a worse
        // outcome than one that is too generous, because it fails at 3am
        // looking like a broken install rather than like a small box.
        let l = derive(BoxSize {
            cores: 1,
            mem_bytes: GIB,
            members: 5,
            ..wedged_box()
        });
        assert_eq!(l.memory_max, mib(256 * MIB));
        // Half a core, never zero: a runner throttled below this is a timeout.
        assert_eq!(l.cpu_quota, "50%");
    }

    #[test]
    fn cpu_leaves_the_operator_a_core_to_log_in_with() {
        for (cores, want) in [(1u32, "100%"), (2, "100%"), (4, "300%"), (16, "1500%")] {
            let l = derive(BoxSize {
                cores,
                members: 1,
                ..wedged_box()
            });
            assert_eq!(l.cpu_quota, want, "{cores} cores");
        }
    }

    #[test]
    fn a_fork_bomb_hits_a_wall_while_the_box_is_still_answering() {
        // The other way to wedge a machine, and it needs no memory at all, so
        // `MemoryMax` alone would not have caught it.
        assert_eq!(derive(wedged_box()).tasks_max, 2048);
        let shared = derive(BoxSize {
            cores: 8,
            members: 4,
            ..wedged_box()
        });
        assert_eq!(shared.tasks_max, 2048);
        // Never so low that a real build's thread pool trips it.
        assert!(derive(BoxSize { cores: 1, members: 20, ..wedged_box() }).tasks_max >= 512);
    }

    #[test]
    fn the_file_ceiling_is_a_share_of_the_disk_with_a_floor_under_it() {
        // 100 GB disk, 10 GB reserved, one member.
        assert_eq!(derive(wedged_box()).max_file_size, 90 * GIB);
        // A small disk split many ways would otherwise produce a ceiling a
        // legitimate build trips over, which reads as data corruption rather
        // than as a quota.
        let tight = derive(BoxSize {
            disk_bytes: 20 * GIB,
            members: 8,
            ..wedged_box()
        });
        assert_eq!(tight.max_file_size, 4 * GIB);
    }

    #[test]
    fn a_disk_the_box_would_not_report_still_leaves_a_ceiling() {
        // `statvfs` failing must not turn into "unlimited": the floor is what
        // the member gets, and it is still a bound.
        assert_eq!(derive(BoxSize { disk_bytes: 0, ..wedged_box() }).max_file_size, 4 * GIB);
    }

    #[test]
    fn asking_the_box_to_choose_is_recognised_however_it_is_typed() {
        assert!(is_auto("auto"));
        assert!(is_auto("  AUTO "));
        assert!(is_auto("Auto"));
        // Anything else is a systemd value the operator meant literally, and
        // must reach the unit untouched.
        assert!(!is_auto("400%"));
        assert!(!is_auto("8G"));
        assert!(!is_auto(""));
    }

    #[test]
    fn sizes_round_down_so_shares_never_add_up_to_more_than_the_box() {
        // Rounding up is how a unit file full of plausible numbers overcommits
        // a machine by a megabyte per member.
        assert_eq!(mib(6 * GIB), "6144M");
        assert_eq!(mib(GIB + MIB - 1), "1024M");
        // Never `0M`, which systemd reads as "this service may have no memory"
        // and which would refuse to start anything at all.
        assert_eq!(mib(0), "1M");
    }

    #[test]
    fn headroom_scales_with_the_box_but_only_so_far() {
        assert_eq!(headroom(8 * GIB), GIB);
        // Floored, or a 1 GB VM keeps 128 MB and cannot run sshd beside a build.
        assert_eq!(headroom(GIB), 512 * MIB);
        // Capped, or a 128 GB box sets aside 16 GB to stay loginable.
        assert_eq!(headroom(128 * GIB), 4 * GIB);
    }
}
