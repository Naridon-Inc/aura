//! Making sure the memory ceiling has something underneath it.
//!
//! The other half of the limits [`crate::manager::brain::place_account`]
//! provisions. A per-member `MemoryMax=` (see the CLI's `runner_limits`) is what
//! stops one member taking the whole box — but a ceiling on a machine with no
//! swap is a wall, not a brake. The build reaches it and is killed; there is
//! nowhere for the kernel to move cold pages to first.
//!
//! That is not hypothetical. On 2026-08-04 a swapless 8 GB box locked up
//! mid-run while its health check still reported it fine. The two fixes are one
//! fix: a ceiling so no member can take everything, and swap so reaching the
//! ceiling degrades instead of detonating.
//!
//! ## Why here rather than in the runner installer
//!
//! Because of who is root, and when. `aura runner install --user` is run *by a
//! member*, on purpose — that is what lets somebody who does not administer the
//! machine set themselves up — and a member cannot `mkswap`. Provisioning an
//! account can: it is already the one step that needs root (`useradd`), it runs
//! over the same single ssh door, and it runs identically for a box somebody
//! brought and a place Aura provisions. Putting swap anywhere else would have
//! given it to one of those two and not the other.
//!
//! ## Why it reports rather than insists
//!
//! Plenty of real boxes cannot take a swapfile: a read-only root, a ZFS root
//! where a swapfile deadlocks, a disk with no room, a container with no
//! privileges. None of those is a reason to fail provisioning an account — the
//! member still wants their account, and their limits still work. So every
//! outcome is a state the surface can say out loud, and the honest ones
//! ([`NONE`]) are the ones the wizard turns into a sentence about what the
//! operator should do.

use crate::cloudbox::script::quote;

/// Where the swapfile goes. The conventional path, deliberately: an operator
/// looking for why their box grew a few gigabytes should find it where every
/// other tool would have put it, and a box that already has `/swapfile` is
/// adopted rather than given a second one under an Aura-specific name.
pub const SWAPFILE: &str = "/swapfile";

/// The comment written beside our `/etc/fstab` line. Matched for idempotence —
/// verifying an account must not append a second entry every time, which is how
/// an fstab ends up mounting the same file four times and failing to boot.
///
/// Free of apostrophes for the same reason [`super::place_toolchain::MARK`] is:
/// it is carried into the provisioning script inside single quotes.
pub const MARK: &str = "aura: swap so a memory limit slows a build instead of killing it";

/// The box already had swap before Aura looked. Nothing was changed.
pub const PRESENT: &str = "present";
/// This call created a swapfile and turned it on.
pub const ADDED: &str = "added";
/// The box has no swap and could not be given any — no root, no room, or a
/// filesystem that will not hold one. The state the operator has to hear about.
pub const NONE: &str = "none";
/// We could not tell. Not Linux, or no readable `/proc/meminfo` — which is what
/// this laptop answers, and is the truthful answer for a place that is a Mac.
pub const UNAVAILABLE: &str = "unavailable";

/// Largest swapfile we will make, in mebibytes.
///
/// Sized as "enough to absorb a build that overshot", not as the old
/// twice-your-RAM hibernation rule — nothing here hibernates, and a wizard that
/// sits writing 32 GB of zeroes to a new box has turned a setup step into a
/// coffee break. Four gigabytes is the give under the ceiling; the ceiling is
/// what does the actual work.
const MAX_MIB: u64 = 4096;

/// Smallest worth making. Below this the page cache alone can consume it during
/// one link step, and the box is swapless again at the moment it matters.
const MIN_MIB: u64 = 1024;

/// Room left free on the disk after the swapfile, in mebibytes. Filling a disk
/// to make swap would trade one way of wedging a box for another.
const KEEP_FREE_MIB: u64 = 2048;

/// The shell that ensures this box has somewhere to swap to.
///
/// POSIX `sh`, and written to run *inside* [`super::place_account::provision_script`]
/// — it uses that script's `PROVISION` flag, its `PRIV` verdict and its
/// `as_root` helper rather than re-deciding any of them. Two implementations of
/// "may I change this machine" would disagree on the first box where sudo needs
/// a password.
///
/// Sets `SWAP` to one of [`PRESENT`], [`ADDED`], [`NONE`] or [`UNAVAILABLE`].
///
/// The order of attempts is deliberate. `fallocate` is instant on ext4 and xfs,
/// which is nearly every cloud image, but on btrfs it produces a file with holes
/// that `swapon` refuses — so a failure anywhere in the chain removes the
/// partial file and retries by writing real zeroes with `dd`. Writing zeroes
/// first would be correct everywhere and slow everywhere.
pub fn provision_snippet() -> String {
    let f = quote(SWAPFILE);
    let mark = quote(MARK);
    format!(
        r#"
# --- swap ---------------------------------------------------------------
# A per-member MemoryMax with no swap under it turns "this build overshot"
# into "this build was killed". See `place_swap`.
SWAP={unavailable}
if [ -r /proc/meminfo ]; then
  SWAP_KB=$(awk '/^SwapTotal:/{{print $2; exit}}' /proc/meminfo 2>/dev/null)
  MEM_KB=$(awk '/^MemTotal:/{{print $2; exit}}' /proc/meminfo 2>/dev/null)
  # A non-numeric answer is no answer. Left as a string it would make every
  # arithmetic test below a syntax error and abandon the whole block.
  case "$SWAP_KB" in ''|*[!0-9]*) SWAP_KB=0 ;; esac
  case "$MEM_KB" in ''|*[!0-9]*) MEM_KB=0 ;; esac

  # A swapfile that exists but is not on — a reboot before fstab was written,
  # or an operator who turned it off — is switched back on before we consider
  # making a second one.
  if [ "$SWAP_KB" -eq 0 ] && [ -e {f} ]; then
    as_root swapon {f} >/dev/null 2>&1 || true
    SWAP_KB=$(awk '/^SwapTotal:/{{print $2; exit}}' /proc/meminfo 2>/dev/null)
    case "$SWAP_KB" in ''|*[!0-9]*) SWAP_KB=0 ;; esac
  fi

  if [ "$SWAP_KB" -gt 0 ]; then
    SWAP={present}
  else
    SWAP={none}
    # As much as the box has memory, bounded both ways: enough to absorb an
    # overshoot, never so much that provisioning stops to write 32 GB.
    SIZE_MB=$(( MEM_KB / 1024 ))
    [ "$SIZE_MB" -gt {max_mib} ] && SIZE_MB={max_mib}
    [ "$SIZE_MB" -lt {min_mib} ] && SIZE_MB={min_mib}
    # Room to put it, with room left over. `df -P` is the portable output
    # format; without -P a long device name wraps onto its own line and the
    # field we want moves.
    FREE_MB=$(df -Pk / 2>/dev/null | awk 'NR==2{{print int($4/1024)}}')
    case "$FREE_MB" in ''|*[!0-9]*) FREE_MB=0 ;; esac
    if [ "$PROVISION" = yes ] && [ "$PRIV" != none ] && [ ! -e {f} ] \
       && [ "$FREE_MB" -gt $(( SIZE_MB + {keep_free} )) ]; then
      # Instant on ext4/xfs. On btrfs it makes a file with holes that swapon
      # rejects, which is why the whole chain is retried below rather than
      # only the allocation.
      if ! ( as_root fallocate -l "${{SIZE_MB}}M" {f} >/dev/null 2>&1 \
             && as_root chmod 600 {f} >/dev/null 2>&1 \
             && as_root mkswap {f} >/dev/null 2>&1 \
             && as_root swapon {f} >/dev/null 2>&1 ); then
        as_root swapoff {f} >/dev/null 2>&1 || true
        as_root rm -f {f} >/dev/null 2>&1 || true
        as_root sh -c "dd if=/dev/zero of={f} bs=1M count=$SIZE_MB" >/dev/null 2>&1 \
          && as_root chmod 600 {f} >/dev/null 2>&1 \
          && as_root mkswap {f} >/dev/null 2>&1 \
          && as_root swapon {f} >/dev/null 2>&1 \
          || as_root rm -f {f} >/dev/null 2>&1
      fi
      # What the box says now, not what we asked for. Every other field in
      # this report is read back the same way, and for the same reason.
      SWAP_KB=$(awk '/^SwapTotal:/{{print $2; exit}}' /proc/meminfo 2>/dev/null)
      case "$SWAP_KB" in ''|*[!0-9]*) SWAP_KB=0 ;; esac
      if [ "$SWAP_KB" -gt 0 ]; then
        SWAP={added}
        # Survive the reboot. Without this the box is swapless again the next
        # time it comes up, which is exactly when nobody is watching.
        if ! grep -q {f} /etc/fstab 2>/dev/null; then
          as_root sh -c "printf '\n# %s\n%s none swap sw 0 0\n' {mark} {f} >> /etc/fstab" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
fi
"#,
        f = f,
        mark = mark,
        present = PRESENT,
        added = ADDED,
        none = NONE,
        unavailable = UNAVAILABLE,
        max_mib = MAX_MIB,
        min_mib = MIN_MIB,
        keep_free = KEEP_FREE_MIB,
    )
}

/// Narrow whatever the box printed to one of the four states.
///
/// Anything unrecognised is [`UNAVAILABLE`] rather than [`NONE`]: "we could not
/// tell" and "this box has no swap" lead to different sentences, and reporting
/// the second when we mean the first would send an operator to fix a machine
/// that is fine.
pub fn state_of(raw: &str) -> String {
    match raw.trim() {
        PRESENT => PRESENT.to_string(),
        ADDED => ADDED.to_string(),
        NONE => NONE.to_string(),
        _ => UNAVAILABLE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_never_changes_a_box_it_was_told_not_to_change() {
        // `may_provision: no` is what this laptop and every read-only check
        // get. A `mkswap` behind a question about somebody's account would be
        // the wizard reformatting part of a disk nobody offered it.
        let s = provision_snippet();
        assert!(s.contains(r#"[ "$PROVISION" = yes ]"#));
        // And it never reaches for root on its own — it uses the one verdict
        // the enclosing script already reached.
        assert!(s.contains(r#"[ "$PRIV" != none ]"#));
        assert!(!s.contains("sudo "), "swap must go through as_root, not its own sudo");
    }

    #[test]
    fn a_box_that_already_swaps_is_left_alone() {
        // Adopting an existing swapfile rather than adding a second one, and
        // reporting `present` rather than claiming credit for it.
        let s = provision_snippet();
        assert!(s.contains(&format!("SWAP={PRESENT}")));
        assert!(s.contains("[ ! -e '/swapfile' ]"));
    }

    #[test]
    fn a_swapfile_that_exists_but_is_off_is_switched_on_before_making_another() {
        // The state a box lands in after a reboot that predates the fstab line.
        // Without this we would find `/swapfile`, refuse to make a second, and
        // report `none` on a box holding four unused gigabytes.
        assert!(provision_snippet().contains("as_root swapon '/swapfile'"));
    }

    #[test]
    fn allocation_falls_back_to_real_zeroes_when_the_fast_path_will_not_swap() {
        // btrfs: `fallocate` succeeds and `swapon` then refuses the holes it
        // left. Retrying only the allocation would loop on the same file, so
        // the partial is removed and the whole chain runs again with `dd`.
        let s = provision_snippet();
        assert!(s.contains("fallocate -l"));
        assert!(s.contains("dd if=/dev/zero"));
        assert!(s.contains("as_root rm -f '/swapfile'"));
    }

    #[test]
    fn swap_is_persisted_so_the_box_is_not_swapless_again_after_a_reboot() {
        // Which is precisely when nobody is watching it.
        let s = provision_snippet();
        assert!(s.contains("/etc/fstab"));
        assert!(s.contains("none swap sw 0 0"));
        // Idempotent: verifying an account twice must not mount it twice.
        assert!(s.contains("grep -q '/swapfile' /etc/fstab"));
    }

    #[test]
    fn making_swap_never_fills_the_disk_it_is_written_to() {
        // Trading a memory wedge for a disk wedge is not a fix.
        let s = provision_snippet();
        assert!(s.contains("df -Pk /"));
        assert!(s.contains(&format!("SIZE_MB + {KEEP_FREE_MIB}")));
    }

    #[test]
    fn the_swapfile_is_bounded_at_both_ends() {
        let s = provision_snippet();
        assert!(s.contains(&format!("SIZE_MB={MAX_MIB}")));
        assert!(s.contains(&format!("SIZE_MB={MIN_MIB}")));
        // A wizard that sat writing 32 GB of zeroes would have turned a setup
        // step into a coffee break.
        assert!(MAX_MIB <= 4096);
    }

    #[test]
    fn a_swapfile_can_only_be_read_by_root() {
        // It holds whatever was in memory — other members' agent transcripts,
        // tokens, keys. World-readable, it is every secret on the box.
        assert!(provision_snippet().contains("chmod 600 '/swapfile'"));
    }

    #[test]
    fn a_number_the_box_would_not_give_us_does_not_break_the_arithmetic() {
        // Left as a string, `SWAP_KB` makes every `-gt` below it a syntax error
        // and abandons the block — silently, on exactly the odd boxes that most
        // need looking at.
        let s = provision_snippet();
        assert!(s.contains(r#"case "$SWAP_KB" in ''|*[!0-9]*) SWAP_KB=0 ;; esac"#));
        assert!(s.contains(r#"case "$FREE_MB" in ''|*[!0-9]*) FREE_MB=0 ;; esac"#));
    }

    /// Run the block under a real `sh`, with the enclosing script's helpers
    /// stubbed so every call to root is recorded instead of made.
    ///
    /// Substring assertions cannot tell a block that takes the right branch
    /// from one that parses and then does the wrong thing. This can.
    fn run_block(provision: &str, priv_level: &str) -> (String, String) {
        let script = format!(
            r#"set -u
PROVISION={provision}
PRIV={priv_level}
as_root() {{
  [ "$PROVISION" = yes ] || return 1
  case "$PRIV" in root|sudo) printf 'ROOT: %s\n' "$*" >&2 ;; *) return 1 ;; esac
}}
{block}
printf '%s' "$SWAP"
"#,
            block = provision_snippet()
        );
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .output()
            .expect("run the swap block");
        assert!(
            out.status.success(),
            "the block exited non-zero: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        (
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }

    #[test]
    fn a_machine_that_cannot_be_measured_is_reported_honestly_and_left_alone() {
        // Executed for real, on whatever this is running on. A Mac has no
        // `/proc/meminfo`, which is the same shape as any place that is not a
        // Linux box — and the answer must be "we could not tell", with nothing
        // attempted. Reporting `none` here would send an operator to add swap
        // to a machine that has its own memory management.
        //
        // Skipped on Linux, where the machine genuinely can answer and the
        // branch under test is not the one that runs.
        if std::path::Path::new("/proc/meminfo").exists() {
            return;
        }
        let (state, root_calls) = run_block("yes", "root");
        assert_eq!(state, UNAVAILABLE);
        assert_eq!(
            root_calls, "",
            "a box we cannot measure had root used on it anyway"
        );
    }

    #[test]
    fn a_place_told_to_change_nothing_reaches_for_root_on_no_branch() {
        // What this laptop gets, and what any read-only "is my place still
        // mine?" check gets. `mkswap` behind a question is the wizard
        // reformatting part of a disk nobody offered it.
        let (state, root_calls) = run_block("no", "none");
        assert!(state == UNAVAILABLE || state == PRESENT || state == NONE);
        assert_eq!(root_calls, "", "a read-only check tried to change the box");
    }

    #[test]
    fn what_we_could_not_measure_is_not_reported_as_a_box_with_no_swap() {
        // The two lead to different sentences: one sends an operator to add
        // swap, the other says we did not look. A Mac answers the second.
        assert_eq!(state_of("none"), NONE);
        assert_eq!(state_of("present"), PRESENT);
        assert_eq!(state_of("added"), ADDED);
        assert_eq!(state_of(""), UNAVAILABLE);
        assert_eq!(state_of("yes"), UNAVAILABLE);
        assert_eq!(state_of("  added  "), ADDED);
    }

    #[test]
    fn the_fstab_comment_carries_no_quote_that_would_end_its_own_quoting() {
        // The mark is spliced into the provisioning script as a single-quoted
        // shell word. One apostrophe in it hands the box a fragment to run.
        assert!(!MARK.contains('\''));
        assert!(!MARK.contains('\n'));
    }
}
