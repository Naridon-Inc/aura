//! `aura egress` — the agent phase's allowlist, on the machine the work runs on.
//!
//! ```text
//!   aura egress broker    hold this run's allowlist and be the only way out
//!   aura egress report    what the run was allowed, and what it wanted anyway
//! ```
//!
//! Neither of these is a verb a person types often. `broker` is started by the
//! guard script the desktop app delivers, and `report` is what that app shells
//! out to when it shows somebody why their agent could not reach something. They
//! are commands rather than private machinery for one reason: the machine the
//! work runs on is frequently a box somebody brought, reachable over ssh and
//! nothing else, and a person debugging a confined run needs to be able to ask
//! these questions while sitting on it.
//!
//! The setup phase has no command here, and that absence is the design. Setup
//! has the whole network — there is nothing to hold, nothing to consult and
//! nothing to report.

use std::path::PathBuf;

use aura_egress::{Broker, Egress, Journal, Report};
use colored::Colorize;

#[derive(clap::Subcommand)]
pub enum EgressSubcommands {
    /// Hold one run's allowlist on loopback. Started by Aura's guard script
    /// before the wall goes up; runs until it is killed.
    Broker {
        /// The endpoints this run may reach, as `host:port,host:port`.
        /// An empty list reaches nothing, which is the safe direction.
        #[arg(long, default_value = "")]
        allow: String,
        /// Where to append what was refused.
        #[arg(long)]
        journal: PathBuf,
        /// Where to write the port once it is listening, so the guard script
        /// knows when it is safe to start the work.
        #[arg(long)]
        port_file: Option<PathBuf>,
    },
    /// What one run was allowed to reach, and what it asked for anyway.
    Report {
        /// The journal that run left behind.
        #[arg(long)]
        journal: PathBuf,
        /// The list it was given, so the report can say "compared to what".
        #[arg(long, default_value = "")]
        allow: String,
        /// Name the run, for a report that is being filed rather than read.
        #[arg(long, default_value = "this run")]
        run: String,
        #[arg(long)]
        json: bool,
    },
}

pub fn handle(sub: &EgressSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        EgressSubcommands::Broker {
            allow,
            journal,
            port_file,
        } => broker(allow, journal, port_file.as_deref()),
        EgressSubcommands::Report {
            journal,
            allow,
            run,
            json,
        } => report(journal, allow, run, *json),
    }
}

/// Listen, announce, and serve until killed.
///
/// A list that will not parse is fatal, and deliberately so: the alternative is
/// a broker that came up holding fewer entries than the spec said and an agent
/// that spends an afternoon being refused things it was granted. The guard
/// script treats a broker that did not come up as a reason not to start the
/// work at all.
fn broker(
    allow: &str,
    journal: &std::path::Path,
    port_file: Option<&std::path::Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    let egress = Egress::from_arg(allow)?;
    let broker = Broker::bind(egress.clone(), Journal::at(journal))?;
    if let Some(path) = port_file {
        broker.announce(path)?;
    }
    // On stderr: stdout belongs to the work, and this process is started in the
    // background beside it.
    eprintln!(
        "aura egress: holding the agent phase to {} (port {})",
        egress.summary(),
        broker.port()?
    );
    broker.serve()?;
    Ok(())
}

/// Read a journal back and say what happened, in sentences.
fn report(
    journal: &std::path::Path,
    allow: &str,
    run: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let egress = Egress::from_arg(allow)?;
    let text = std::fs::read_to_string(journal).unwrap_or_default();
    let report = Report::read(run, &egress, &text);

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    let headline = report.headline();
    println!(
        "\n{}\n",
        if report.clean() {
            headline.green().bold()
        } else {
            headline.yellow().bold()
        }
    );
    if !report.clean() {
        println!("{}", "It wanted:".bold());
        for line in report.refusals() {
            println!("  {} {}", "·".yellow(), line);
        }
        println!(
            "\n{}\n",
            "If the work genuinely needs one of those, add it to `[env.network]` in \
             .aura/settings.toml and run `aura env sign`. If you did not expect it, something in \
             the run's context asked for it — that is what the list is for."
                .dimmed()
        );
    }
    if !report.permissions().is_empty() {
        println!("{}", "It was allowed:".bold());
        for line in report.permissions() {
            println!("  {} {}", "·".green(), line);
        }
    }
    println!();
    Ok(())
}
