//! "How big is the machine this workspace runs on, and how busy is it?" —
//! what the workspace's details say under CPU, Memory and Disk.
//!
//! Asked of the box itself over the same ssh every other `place_*` call
//! uses, in one round trip: the core count, two reads of the kernel's CPU
//! counters a second apart (one read is the total since boot, which says
//! nothing about now), the memory the kernel says is still available, and
//! `df` on the workspace's own folder — the disk the agent is filling, not
//! whichever one `/` happens to be.
//!
//! The box prints raw numbers and the arithmetic happens here, so a box with
//! a different `awk` or no `bc` gives the same answer, and so the parse can
//! be tested without a machine.

use serde::Serialize;

use super::{outcome, Place, Work};

/// Everything is printed as `<label> <numbers…>` so the parse never depends
/// on the order lines arrive in or on a locale's number format.
const PROBE: &str = r#"printf 'cores %s\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
head -n 1 /proc/stat
sleep 1
head -n 1 /proc/stat
awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "mem %s %s\n", t, a}' /proc/meminfo
df -Pk . | awk 'NR==2{printf "disk %s %s\n", $2, $3}'"#;

/// The machine behind one workspace, as its details show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MachineStats {
    pub cores: u32,
    /// Percent of the CPU busy over the last second, 0–100.
    pub cpu_used: f64,
    pub memory_kb: u64,
    /// Percent of memory not available to a new process, 0–100.
    pub memory_used: f64,
    /// Size of the filesystem holding the workspace's folder.
    pub disk_kb: u64,
    /// Percent of that filesystem in use, 0–100.
    pub disk_used: f64,
}

/// The box's answer, read. `None` when a part is missing — a machine with no
/// `/proc` (not Linux) or a `df` that printed nothing — because a row that
/// says `0% used` for a number nobody read is worse than no row.
pub(crate) fn parse(stdout: &str) -> Option<MachineStats> {
    let mut cores = None;
    let mut cpu: Vec<(u64, u64)> = Vec::new();
    let mut mem = None;
    let mut disk = None;
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let label = parts.next();
        let nums: Vec<u64> = parts.filter_map(|n| n.parse().ok()).collect();
        match label {
            Some("cores") => cores = nums.first().copied().filter(|c| *c > 0),
            // user nice system idle iowait irq softirq steal …: idle and
            // iowait are the CPU doing nothing; everything else is work.
            Some("cpu") if nums.len() >= 4 => {
                let total: u64 = nums.iter().take(8).sum();
                let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
                cpu.push((total, idle));
            }
            Some("mem") if nums.len() == 2 && nums[0] > 0 => mem = Some((nums[0], nums[1])),
            Some("disk") if nums.len() == 2 && nums[0] > 0 => disk = Some((nums[0], nums[1])),
            _ => {}
        }
    }
    let (t1, i1) = *cpu.first()?;
    let (t2, i2) = *cpu.get(1)?;
    let spent = t2.saturating_sub(t1);
    let idle = i2.saturating_sub(i1);
    let cpu_used = if spent == 0 { 0.0 } else { pct(spent.saturating_sub(idle), spent) };
    let (mem_total, mem_avail) = mem?;
    let (disk_total, disk_used) = disk?;
    Some(MachineStats {
        cores: u32::try_from(cores?).ok()?,
        cpu_used,
        memory_kb: mem_total,
        memory_used: pct(mem_total.saturating_sub(mem_avail), mem_total),
        disk_kb: disk_total,
        disk_used: pct(disk_used.min(disk_total), disk_total),
    })
}

/// `part / whole` as a percent with one decimal.
fn pct(part: u64, whole: u64) -> f64 {
    ((part as f64 / whole as f64) * 1000.0).round() / 10.0
}

/// The size and load of the machine a workspace runs on, read now.
#[tauri::command]
pub async fn place_work_stats(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
) -> Result<MachineStats, String> {
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let out = w.ask(PROBE).await?;
    let said = outcome(&out)?;
    parse(&said).ok_or_else(|| {
        format!(
            "{} didn't report its CPU, memory and disk — it may not be a Linux machine.",
            w.place.label()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str = "cores 8
cpu  1000 0 500 8000 500 0 0 0 0 0
cpu  1001 0 501 8196 502 0 0 0 0 0
mem 16384000 14811136
disk 67108864 27577876
";

    #[test]
    fn a_box_s_answer_reads_as_its_size_and_load() {
        let s = parse(ANSWER).expect("parsed");
        assert_eq!(s.cores, 8);
        // 200 ticks passed between the reads and 198 of them were idle.
        assert_eq!(s.cpu_used, 1.0);
        assert_eq!(s.memory_kb, 16_384_000);
        assert_eq!(s.memory_used, 9.6);
        assert_eq!(s.disk_kb, 67_108_864);
        assert_eq!(s.disk_used, 41.1);
    }

    #[test]
    fn cpu_is_the_busy_share_of_the_second_between_reads() {
        let s = parse("cores 2\ncpu 100 0 100 800 0\ncpu 110 0 110 980 0\nmem 10 5\ndisk 10 1\n").unwrap();
        // 200 ticks: 20 busy, 180 idle.
        assert_eq!(s.cpu_used, 10.0);
        assert_eq!(s.memory_used, 50.0);
        assert_eq!(s.disk_used, 10.0);
    }

    #[test]
    fn a_machine_that_did_not_say_gets_no_numbers() {
        // No /proc: macOS prints the cores and the disk and nothing else.
        assert_eq!(parse("cores 8\ndisk 100 50\n"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("cores 0\ncpu 1 1 1 1\ncpu 2 2 2 2\nmem 1 1\ndisk 1 1\n"), None);
    }
}
