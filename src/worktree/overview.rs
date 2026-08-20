//! The control plane: one picture of every checkout, who is working in it, and
//! where two of them are heading for the same code.
//!
//! Nothing here reaches the network. It joins three local sources that now all
//! live on the shared plane:
//!
//! * `git worktree list` — the checkouts that exist ([`super::discover`]).
//! * Sentinel claims + zones — what each agent has taken ([`crate::sentinel`]).
//! * The awareness feed — what each actor last announced.
//!
//! The join key is the checkout name, stamped onto every record at write time.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

use super::{discover, paths};
use crate::awareness::{store as awareness_store, AwarenessEvent};
use crate::sentinel::{FunctionClaim, SentinelClaims, SentinelManager, SentinelMessage, ZoneRule};

/// How many awareness events to keep per checkout.
const EVENTS_PER_TREE: usize = 5;
/// How many recent messages the plane carries.
const MESSAGE_LIMIT: usize = 20;

/// One agent session, and what it is holding.
#[derive(Debug, Clone, Serialize)]
pub struct AgentPresence {
    pub session_id: String,
    pub agent_id: String,
    pub pid: u32,
    /// Whether the process is still running. A dead pid with live claims is a
    /// crashed agent whose locks nobody has released.
    pub alive: bool,
    pub last_heartbeat: u64,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub claims: Vec<FunctionClaim>,
    pub zones: Vec<ZoneRule>,
}

/// A checkout plus everything happening inside it.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeCard {
    #[serde(flatten)]
    pub info: discover::WorktreeInfo,
    /// Addressable name: the worktree's, or `main` for the main checkout.
    pub token: String,
    pub agents: Vec<AgentPresence>,
    pub events: Vec<AwarenessEvent>,
    /// Messages waiting to be read by a session in this checkout.
    pub inbox: usize,
    /// True for the checkout the command was run from.
    pub is_here: bool,
}

/// One agent holding a symbol another agent also holds.
#[derive(Debug, Clone, Serialize)]
pub struct Holder {
    pub worktree: String,
    pub agent: String,
    pub session: String,
    pub alive: bool,
}

/// The same `(file, symbol)` claimed by two or more sessions.
#[derive(Debug, Clone, Serialize)]
pub struct Contention {
    pub file: String,
    pub function: String,
    pub holders: Vec<Holder>,
    /// Held from more than one checkout — two branches converging on the same
    /// code, which merge will have to reconcile. Within a single checkout it is
    /// instead two agents about to overwrite each other right now.
    pub cross_worktree: bool,
}

/// Everything the control plane knows.
#[derive(Debug, Clone, Serialize)]
pub struct ControlPlane {
    pub root: PathBuf,
    pub trunk: String,
    /// Token of the checkout the command ran from.
    pub here: String,
    pub worktrees: Vec<WorktreeCard>,
    pub contention: Vec<Contention>,
    /// Claims stamped with a checkout git no longer lists — an agent whose
    /// worktree was removed while it still held locks.
    pub stranded: Vec<AgentPresence>,
    pub messages: Vec<SentinelMessage>,
}

impl ControlPlane {
    pub fn total_agents(&self) -> usize {
        self.worktrees.iter().map(|c| c.agents.len()).sum::<usize>() + self.stranded.len()
    }

    pub fn live_agents(&self) -> usize {
        self.worktrees
            .iter()
            .flat_map(|c| c.agents.iter())
            .filter(|a| a.alive)
            .count()
    }
}

fn presence(c: SentinelClaims, zones: &[ZoneRule]) -> AgentPresence {
    AgentPresence {
        alive: SentinelManager::is_pid_alive(c.pid),
        zones: zones
            .iter()
            .filter(|z| z.session_id == c.session_id)
            .cloned()
            .collect(),
        session_id: c.session_id,
        agent_id: c.agent_id,
        pid: c.pid,
        last_heartbeat: c.last_heartbeat,
        worktree: c.worktree,
        branch: c.branch,
        claims: c.claims,
    }
}

/// Which checkout an awareness event belongs to.
///
/// Events emitted since the plane split carry their checkout. Older ones don't,
/// so they fall back to a branch match — git refuses to check the same branch
/// out twice, which makes the branch a reliable stand-in — and finally to the
/// main checkout, the meaning `None` has always had.
fn attribute_event(ev: &AwarenessEvent, branch_to_token: &BTreeMap<String, String>) -> String {
    if let Some(wt) = &ev.worktree {
        return wt.clone();
    }
    branch_to_token
        .get(&ev.branch)
        .cloned()
        .unwrap_or_else(|| "main".to_string())
}

/// Build the plane. `with_git_status` reads each checkout's working tree for a
/// dirty count and drift from trunk — accurate, but two git invocations per
/// checkout, so it is optional for callers that only want the roster.
pub fn assemble(with_git_status: bool) -> ControlPlane {
    let root = paths::repo_root().unwrap_or_else(|| PathBuf::from("."));
    let here = SentinelManager::worktree_token(paths::current_worktree().as_deref());

    // Stale claims are dropped first, so a crashed agent from last week isn't
    // reported as contention against work happening now.
    SentinelManager::cleanup_stale();

    let trees = if with_git_status {
        discover::list_with_status()
    } else {
        discover::list()
    };
    let trunk = discover::trunk(&root);

    let zones = SentinelManager::list_zones();
    let claims = SentinelManager::load_all_claims();
    let messages = SentinelManager::all_messages();
    let events = awareness_store::read_all();

    let branch_to_token: BTreeMap<String, String> = trees
        .iter()
        .filter_map(|t| {
            let b = t.branch.clone()?;
            Some((b, SentinelManager::worktree_token(t.name.as_deref())))
        })
        .collect();

    // Bucket agents and events by checkout token.
    let mut by_tree: BTreeMap<String, Vec<AgentPresence>> = BTreeMap::new();
    for c in claims {
        let token = SentinelManager::worktree_token(c.worktree.as_deref());
        by_tree.entry(token).or_default().push(presence(c, &zones));
    }

    let mut events_by_tree: BTreeMap<String, Vec<AwarenessEvent>> = BTreeMap::new();
    for ev in events {
        let token = attribute_event(&ev, &branch_to_token);
        events_by_tree.entry(token).or_default().push(ev);
    }
    for list in events_by_tree.values_mut() {
        list.sort_by(|a, b| b.ts.cmp(&a.ts));
        list.truncate(EVENTS_PER_TREE);
    }

    let mut worktrees: Vec<WorktreeCard> = trees
        .into_iter()
        .map(|info| {
            let token = SentinelManager::worktree_token(info.name.as_deref());
            let agents = by_tree.remove(&token).unwrap_or_default();
            let inbox = agents
                .iter()
                .map(|a| SentinelManager::get_unread_messages(&a.session_id).len())
                .sum();
            WorktreeCard {
                events: events_by_tree.remove(&token).unwrap_or_default(),
                is_here: token == here,
                token,
                agents,
                inbox,
                info,
            }
        })
        .collect();

    // Anything left in `by_tree` is a claim whose checkout git no longer lists.
    let mut stranded: Vec<AgentPresence> = by_tree.into_values().flatten().collect();
    stranded.sort_by(|a, b| b.last_heartbeat.cmp(&a.last_heartbeat));

    // Busiest checkout first, but the one you're standing in always leads.
    worktrees.sort_by(|a, b| {
        b.is_here
            .cmp(&a.is_here)
            .then(b.agents.len().cmp(&a.agents.len()))
            .then(a.token.cmp(&b.token))
    });

    let mut messages = messages;
    messages.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    messages.truncate(MESSAGE_LIMIT);

    let contention = contention(&worktrees, &stranded);

    ControlPlane {
        root,
        trunk,
        here,
        worktrees,
        contention,
        stranded,
        messages,
    }
}

/// Find every `(file, symbol)` held by more than one session.
fn contention(cards: &[WorktreeCard], stranded: &[AgentPresence]) -> Vec<Contention> {
    let mut index: BTreeMap<(String, String), Vec<Holder>> = BTreeMap::new();
    let mut trees: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();

    let all = cards
        .iter()
        .flat_map(|c| c.agents.iter().map(move |a| (c.token.clone(), a)))
        .chain(stranded.iter().map(|a| {
            (
                SentinelManager::worktree_token(a.worktree.as_deref()),
                a,
            )
        }));

    for (token, agent) in all {
        for claim in &agent.claims {
            let key = (claim.file_path.clone(), claim.function_name.clone());
            let holders = index.entry(key.clone()).or_default();
            // A session cannot contend with itself. Claim records can carry
            // the same symbol twice — a duplicate written by an older build,
            // or two writers racing — and counting both would report a false
            // collision, which is worse than reporting none: an alarm nobody
            // can act on teaches you to ignore the alarm.
            if holders.iter().any(|h| h.session == agent.session_id) {
                continue;
            }
            holders.push(Holder {
                worktree: token.clone(),
                agent: agent.agent_id.clone(),
                session: agent.session_id.clone(),
                alive: agent.alive,
            });
            let seen = trees.entry(key).or_default();
            if !seen.contains(&token) {
                seen.push(token.clone());
            }
        }
    }

    let mut out: Vec<Contention> = index
        .into_iter()
        .filter(|(_, holders)| holders.len() > 1)
        .map(|((file, function), holders)| {
            let cross = trees
                .get(&(file.clone(), function.clone()))
                .map(|t| t.len() > 1)
                .unwrap_or(false);
            Contention {
                file,
                function,
                holders,
                cross_worktree: cross,
            }
        })
        .collect();

    // Cross-checkout contention first: it is the one nobody would otherwise see.
    out.sort_by(|a, b| {
        b.cross_worktree
            .cmp(&a.cross_worktree)
            .then(b.holders.len().cmp(&a.holders.len()))
            .then(a.file.cmp(&b.file))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sentinel::ZoneMode;

    fn claim(file: &str, func: &str) -> FunctionClaim {
        FunctionClaim {
            file_path: file.into(),
            function_name: func.into(),
            node_id: None,
            claimed_at: 1,
        }
    }

    fn agent(session: &str, who: &str, wt: Option<&str>, claims: Vec<FunctionClaim>) -> AgentPresence {
        AgentPresence {
            session_id: session.into(),
            agent_id: who.into(),
            pid: 1,
            alive: true,
            last_heartbeat: 1,
            worktree: wt.map(|s| s.to_string()),
            branch: None,
            claims,
            zones: Vec::new(),
        }
    }

    fn card(token: &str, agents: Vec<AgentPresence>) -> WorktreeCard {
        WorktreeCard {
            info: discover::WorktreeInfo {
                name: if token == "main" { None } else { Some(token.into()) },
                path: PathBuf::from(format!("/repo/{token}")),
                head: "abc".into(),
                branch: Some(token.into()),
                is_main: token == "main",
                missing: false,
                locked: false,
                dirty_files: 0,
                ahead: 0,
                behind: 0,
                last_commit_at: None,
            },
            token: token.into(),
            agents,
            events: Vec::new(),
            inbox: 0,
            is_here: false,
        }
    }

    /// The whole reason the plane exists: two agents in two checkouts on the
    /// same symbol used to be invisible to both of them.
    #[test]
    fn the_same_symbol_in_two_checkouts_is_flagged_as_cross_worktree() {
        let cards = vec![
            card(
                "barcelona",
                vec![agent("s1", "claude", Some("barcelona"), vec![claim("src/auth.rs", "login")])],
            ),
            card(
                "granada",
                vec![agent("s2", "gemini", Some("granada"), vec![claim("src/auth.rs", "login")])],
            ),
        ];
        let found = contention(&cards, &[]);
        assert_eq!(found.len(), 1);
        assert!(found[0].cross_worktree);
        assert_eq!(found[0].function, "login");
        let who: Vec<&str> = found[0].holders.iter().map(|h| h.agent.as_str()).collect();
        assert_eq!(who, vec!["claude", "gemini"]);
    }

    #[test]
    fn two_agents_in_one_checkout_contend_but_are_not_cross_worktree() {
        let cards = vec![card(
            "barcelona",
            vec![
                agent("s1", "claude", Some("barcelona"), vec![claim("src/auth.rs", "login")]),
                agent("s2", "codex", Some("barcelona"), vec![claim("src/auth.rs", "login")]),
            ],
        )];
        let found = contention(&cards, &[]);
        assert_eq!(found.len(), 1);
        assert!(!found[0].cross_worktree, "same tree — not a merge problem");
    }

    /// A record that holds one symbol twice is one holder, not two. Reporting
    /// it as a collision is a false alarm against yourself.
    #[test]
    fn a_session_never_contends_with_itself() {
        let cards = vec![card(
            "barcelona",
            vec![agent(
                "s1",
                "claude",
                Some("barcelona"),
                vec![claim("src/auth.rs", "login"), claim("src/auth.rs", "login")],
            )],
        )];
        assert!(contention(&cards, &[]).is_empty());

        // ...but a second, real session on that symbol still contends.
        let mut cards = cards;
        cards.push(card(
            "granada",
            vec![agent("s2", "gemini", Some("granada"), vec![claim("src/auth.rs", "login")])],
        ));
        let found = contention(&cards, &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].holders.len(), 2, "one per session, not per claim row");
        assert!(found[0].cross_worktree);
    }

    #[test]
    fn distinct_symbols_are_not_contention() {
        let cards = vec![
            card("barcelona", vec![agent("s1", "claude", Some("barcelona"), vec![claim("src/auth.rs", "login")])]),
            card("granada", vec![agent("s2", "gemini", Some("granada"), vec![claim("src/auth.rs", "logout")])]),
        ];
        assert!(contention(&cards, &[]).is_empty());
        // ...and neither are the same symbol in different files.
        let cards = vec![
            card("barcelona", vec![agent("s1", "claude", Some("barcelona"), vec![claim("src/a.rs", "run")])]),
            card("granada", vec![agent("s2", "gemini", Some("granada"), vec![claim("src/b.rs", "run")])]),
        ];
        assert!(contention(&cards, &[]).is_empty());
    }

    #[test]
    fn a_stranded_agent_still_contends() {
        let cards = vec![card(
            "barcelona",
            vec![agent("s1", "claude", Some("barcelona"), vec![claim("src/auth.rs", "login")])],
        )];
        // Its checkout is gone from `git worktree list`, but it still holds the
        // symbol — exactly the case that used to be silently lost.
        let stranded = vec![agent("s9", "codex", Some("deleted-tree"), vec![claim("src/auth.rs", "login")])];
        let found = contention(&cards, &stranded);
        assert_eq!(found.len(), 1);
        assert!(found[0].cross_worktree);
        assert_eq!(found[0].holders.len(), 2);
    }

    #[test]
    fn cross_checkout_contention_is_reported_first() {
        let cards = vec![
            card(
                "barcelona",
                vec![
                    agent("s1", "claude", Some("barcelona"), vec![claim("src/local.rs", "same_tree")]),
                    agent("s2", "codex", Some("barcelona"), vec![claim("src/local.rs", "same_tree")]),
                ],
            ),
            card("granada", vec![agent("s3", "gemini", Some("granada"), vec![claim("src/wide.rs", "shared")])]),
            card("kyoto", vec![agent("s4", "claude", Some("kyoto"), vec![claim("src/wide.rs", "shared")])]),
        ];
        let found = contention(&cards, &[]);
        assert_eq!(found.len(), 2);
        assert!(found[0].cross_worktree, "the invisible one leads");
        assert_eq!(found[0].function, "shared");
    }

    #[test]
    fn an_unstamped_event_falls_back_to_its_branch() {
        let map: BTreeMap<String, String> =
            [("feat/thing".to_string(), "barcelona".to_string())].into_iter().collect();
        let mut ev = AwarenessEvent {
            id: "1".into(),
            actor: "claude".into(),
            is_agent: true,
            kind: crate::awareness::AwarenessKind::Editing,
            repo: "r".into(),
            branch: "feat/thing".into(),
            file: None,
            symbol: None,
            intent: None,
            impact: None,
            ts: 1,
            key_id: None,
            sig: None,
            pubkey: None,
            worktree: None,
        };
        assert_eq!(attribute_event(&ev, &map), "barcelona", "matched by branch");

        ev.branch = "some/other".into();
        assert_eq!(attribute_event(&ev, &map), "main", "unknown branch → main");

        // An explicit stamp always wins over the branch guess.
        ev.branch = "feat/thing".into();
        ev.worktree = Some("kyoto".into());
        assert_eq!(attribute_event(&ev, &map), "kyoto");
    }

    #[test]
    fn zones_attach_to_the_session_that_declared_them() {
        let zones = vec![
            ZoneRule {
                zone_id: "z1".into(),
                session_id: "s1".into(),
                patterns: vec!["aura-cli/".into()],
                mode: ZoneMode::Block,
                worktree: Some("barcelona".into()),
                claimed_at: 0,
            },
            ZoneRule {
                zone_id: "z2".into(),
                session_id: "s2".into(),
                patterns: vec!["aura-web/".into()],
                mode: ZoneMode::Warn,
                worktree: Some("granada".into()),
                claimed_at: 0,
            },
        ];
        let p = presence(
            SentinelClaims {
                session_id: "s1".into(),
                agent_id: "claude".into(),
                pid: std::process::id(),
                last_heartbeat: 1,
                claims: Vec::new(),
                worktree: Some("barcelona".into()),
                branch: None,
            },
            &zones,
        );
        assert_eq!(p.zones.len(), 1);
        assert_eq!(p.zones[0].zone_id, "z1");
        assert!(p.alive, "our own pid is alive");
    }
}
