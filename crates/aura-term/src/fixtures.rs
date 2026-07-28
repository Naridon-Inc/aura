use crate::theme;

#[derive(Clone, Debug, PartialEq)]
pub enum SessionType {
    Shell,
    Agent,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BlockState {
    Proposed,
    Gated,
    Running,
    Completed,
    Failed,
    RolledBack,
    Suspended,
    Superseded,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PolicyDecision {
    Auto,
    Approved,
    Denied,
    Escalated,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentIdentity {
    Human,
    Claude,
    Codex,
    Gemini,
    Review,
    Security,
    Builtin,
}

#[derive(Clone, Debug)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub avatar_letter: char,
    pub last_opened: u64,
    pub accent: iced::Color,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub state: BlockState,
    pub timestamp_str: String,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug)]
pub struct Block {
    pub id: String,
    pub title: String,
    pub state: BlockState,
    pub intent: String,
    pub policy_decision: Option<PolicyDecision>,
    pub author: AgentIdentity,
    pub lines_of_output: usize,
    pub full_output: String,
}

pub fn empty_workspace() -> Vec<Workspace> {
    vec![]
}

pub fn mock_workspaces() -> Vec<Workspace> {
    vec![
        Workspace {
            id: "ws-1".to_string(),
            name: "aura".to_string(),
            path: "~/Documents/aura".to_string(),
            avatar_letter: 'A',
            last_opened: 1713000000,
            accent: iced::Color::from_rgb(0xa8 as f32 / 255.0, 0x6d as f32 / 255.0, 0xff as f32 / 255.0),
        },
        Workspace {
            id: "ws-2".to_string(),
            name: "enricher".to_string(),
            path: "~/Documents/enricher".to_string(),
            avatar_letter: 'E',
            last_opened: 1712000000,
            accent: iced::Color::from_rgb(0xe8 as f32 / 255.0, 0x6f as f32 / 255.0, 0x8f as f32 / 255.0),
        },
    ]
}

pub fn mock_sessions() -> Vec<Session> {
    vec![
        Session {
            id: "sess-1".to_string(),
            name: "npm install && npm start".to_string(),
            session_type: SessionType::Shell,
            state: BlockState::Running,
            timestamp_str: "Now".to_string(),
            blocks: vec![],
        },
        Session {
            id: "sess-2".to_string(),
            name: "Refactor auth middleware".to_string(),
            session_type: SessionType::Agent,
            state: BlockState::Completed,
            timestamp_str: "2h ago".to_string(),
            blocks: vec![],
        },
        Session {
            id: "sess-3".to_string(),
            name: "Orchestration (2 active)".to_string(),
            session_type: SessionType::Agent,
            state: BlockState::Running,
            timestamp_str: "10m ago".to_string(),
            blocks: vec![],
        },
    ]
}

#[derive(Clone, Debug, PartialEq)]
pub enum FileKind {
    Dir { expanded: bool },
    File,
}

#[derive(Clone, Debug)]
pub struct FileNode {
    pub name: String,
    pub kind: FileKind,
    pub depth: u8,
}

pub fn mock_file_tree() -> Vec<FileNode> {
    let dir_expanded = FileKind::Dir { expanded: true };
    let dir_collapsed = FileKind::Dir { expanded: false };
    vec![
        FileNode { name: "src".into(),        kind: dir_expanded.clone(),  depth: 0 },
        FileNode { name: "main.rs".into(),    kind: FileKind::File,        depth: 1 },
        FileNode { name: "fixtures.rs".into(),kind: FileKind::File,        depth: 1 },
        FileNode { name: "ui".into(),         kind: dir_expanded.clone(),  depth: 1 },
        FileNode { name: "sidebar.rs".into(), kind: FileKind::File,        depth: 2 },
        FileNode { name: "topbar.rs".into(),  kind: FileKind::File,        depth: 2 },
        FileNode { name: "theme.rs".into(),   kind: FileKind::File,        depth: 1 },
        FileNode { name: "Cargo.toml".into(), kind: FileKind::File,        depth: 0 },
        FileNode { name: "target".into(),     kind: dir_collapsed,          depth: 0 },
    ]
}

#[derive(Clone, Debug)]
pub struct GitCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
}

pub fn mock_git_commits() -> Vec<GitCommit> {
    vec![
        GitCommit { hash: "a8f3c21".into(), subject: "Add sidebar tabs scaffolding".into(),    author: "Muhammed".into(), relative_time: "2m".into() },
        GitCommit { hash: "b1e90df".into(), subject: "Wire project_header plumbing".into(),    author: "Muhammed".into(), relative_time: "1h".into() },
        GitCommit { hash: "c44d018".into(), subject: "Fix rail hover glitch".into(),           author: "Muhammed".into(), relative_time: "3h".into() },
        GitCommit { hash: "d9021ab".into(), subject: "Introduce team/zone fixtures".into(),    author: "Muhammed".into(), relative_time: "yesterday".into() },
        GitCommit { hash: "e7712f6".into(), subject: "Bump iced to 0.14".into(),               author: "Muhammed".into(), relative_time: "2d".into() },
    ]
}

pub fn mock_git_branches() -> Vec<String> {
    vec!["feat/aura-gui".into(), "main".into(), "feat/rail-polish".into()]
}

pub fn current_branch() -> &'static str {
    "feat/aura-gui"
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitChangeStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
    Conflict,
}

impl GitChangeStatus {
    pub fn letter(&self) -> &'static str {
        match self {
            GitChangeStatus::Modified => "M",
            GitChangeStatus::Added => "A",
            GitChangeStatus::Deleted => "D",
            GitChangeStatus::Untracked => "U",
            GitChangeStatus::Renamed => "R",
            GitChangeStatus::Conflict => "!",
        }
    }

    pub fn color(&self) -> iced::Color {
        match self {
            GitChangeStatus::Modified => theme::AMBER,
            GitChangeStatus::Added | GitChangeStatus::Untracked => theme::CHANGE_ADDED,
            GitChangeStatus::Deleted => theme::RED,
            GitChangeStatus::Renamed => theme::VIOLET,
            GitChangeStatus::Conflict => theme::RED,
        }
    }
}

#[derive(Clone, Debug)]
pub struct GitChange {
    pub file: String,
    pub folder: String,
    pub status: GitChangeStatus,
}

pub fn mock_git_staged() -> Vec<GitChange> {
    vec![
        GitChange { file: "sidebar_tab_git.rs".into(), folder: "src/ui".into(),   status: GitChangeStatus::Added },
        GitChange { file: "fixtures.rs".into(),        folder: "src".into(),      status: GitChangeStatus::Modified },
    ]
}

// ─── Git railway graph ─────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct GitTag {
    pub label: String,
    pub kind: GitTagKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitTagKind {
    /// Local branch — dashed outline pill.
    Branch,
    /// Remote tracking ref — filled pill (e.g. `origin/main`).
    Remote,
}

#[derive(Clone, Debug)]
pub struct GitGraphRow {
    pub subject: String,
    /// x-index of this commit's dot (0 = leftmost lane).
    pub dot_lane: u8,
    /// Index into graph_lane_colors() for the dot + its originating edges.
    pub color_idx: u8,
    /// Merge commits render as a hollow ring with an inner dot.
    pub is_merge: bool,
    pub tag: Option<GitTag>,
}

#[derive(Clone, Debug)]
pub struct GitGraphEdge {
    pub from_row: usize,
    pub to_row: usize,
    pub from_lane: u8,
    pub to_lane: u8,
    pub color_idx: u8,
}

#[derive(Clone, Debug)]
pub struct GitGraph {
    pub rows: Vec<GitGraphRow>,
    pub edges: Vec<GitGraphEdge>,
    pub lane_count: u8,
}

pub fn graph_lane_colors() -> Vec<iced::Color> {
    vec![
        theme::VIOLET,
        theme::AMBER,
        theme::CARET_ORANGE,
        theme::ACCENT,
        theme::CHANGE_ADDED,
    ]
}

pub fn mock_git_graph() -> GitGraph {
    // Lane assignment: 0=purple/main, 1=amber, 2=orange, 3=teal, 4=green.
    let rows = vec![
        GitGraphRow { subject: "Merge pull request #481 from naridon/main".into(),
            dot_lane: 0, color_idx: 0, is_merge: true,
            tag: Some(GitTag { label: "origin/main".into(), kind: GitTagKind::Remote }) },
        GitGraphRow { subject: "Merge branch 'main' of github.com/naridon/aura".into(),
            dot_lane: 1, color_idx: 1, is_merge: true, tag: None },
        GitGraphRow { subject: "fix: fixes user experience on checkout".into(),
            dot_lane: 2, color_idx: 2, is_merge: false, tag: None },
        GitGraphRow { subject: "Merge pull request #478 from pricing-revamp".into(),
            dot_lane: 0, color_idx: 0, is_merge: true, tag: None },
        GitGraphRow { subject: "fix(backend, infra): widen retry window".into(),
            dot_lane: 2, color_idx: 2, is_merge: false, tag: None },
        GitGraphRow { subject: "Merge branch 'main' into feat/pricing".into(),
            dot_lane: 1, color_idx: 1, is_merge: true, tag: None },
        GitGraphRow { subject: "Merge pull request #476 from hotfix/oauth".into(),
            dot_lane: 2, color_idx: 2, is_merge: true, tag: None },
        GitGraphRow { subject: "Merge branch 'main' into pricing-revamp".into(),
            dot_lane: 1, color_idx: 1, is_merge: true, tag: None },
        GitGraphRow { subject: "Merge pull request #473 from feat/db-migration".into(),
            dot_lane: 2, color_idx: 2, is_merge: true, tag: None },
        GitGraphRow { subject: "fix(db): add migration for pricing schema".into(),
            dot_lane: 2, color_idx: 2, is_merge: false, tag: None },
        GitGraphRow { subject: "fix(web): pricing auth callback".into(),
            dot_lane: 2, color_idx: 2, is_merge: false, tag: None },
        GitGraphRow { subject: "Merge remote-tracking branch 'origin/main'".into(),
            dot_lane: 1, color_idx: 1, is_merge: true, tag: None },
        GitGraphRow { subject: "Merge pull request #470 from feat/pricing".into(),
            dot_lane: 0, color_idx: 0, is_merge: true, tag: None },
        GitGraphRow { subject: "fix(pricing): add missing fallback copy".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
        GitGraphRow { subject: "refactor(pricing): reorganise tiers module".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
        GitGraphRow { subject: "fix(pricing): platform detection".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
        GitGraphRow { subject: "feat(pricing): mount tier selector".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
        GitGraphRow { subject: "feat(pricing): cap-per-seat billing".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
        GitGraphRow { subject: "feat(pricing): abuse protection hooks".into(),
            dot_lane: 3, color_idx: 3, is_merge: false, tag: None },
    ];

    // Edges — each connects a parent commit (below) to a child commit (above).
    // Expressed as (from_row, to_row, from_lane, to_lane, color_idx).
    let e = |from_row, to_row, from_lane, to_lane, color_idx| GitGraphEdge {
        from_row, to_row, from_lane, to_lane, color_idx,
    };
    let edges = vec![
        // main spine (purple, lane 0) runs through every row
        e(1,  0, 0, 0, 0),
        e(2,  1, 0, 0, 0),
        e(3,  2, 0, 0, 0),
        e(4,  3, 0, 0, 0),
        e(5,  4, 0, 0, 0),
        e(6,  5, 0, 0, 0),
        e(7,  6, 0, 0, 0),
        e(8,  7, 0, 0, 0),
        e(9,  8, 0, 0, 0),
        e(10, 9, 0, 0, 0),
        e(11,10, 0, 0, 0),
        e(12,11, 0, 0, 0),

        // amber branch (lane 1) — loops in and out of main
        e(1,  0, 1, 0, 1),   // row 1 merges into row 0
        e(2,  1, 1, 1, 1),
        e(3,  2, 1, 1, 1),
        e(4,  3, 1, 1, 1),
        e(5,  4, 1, 1, 1),
        e(5,  3, 1, 0, 1),   // amber merges into purple at row 3
        e(7,  6, 1, 1, 1),
        e(8,  7, 1, 1, 1),
        e(11,10, 1, 1, 1),
        e(11, 9, 1, 2, 1),   // amber touches orange

        // orange branch (lane 2)
        e(3,  2, 2, 2, 2),
        e(4,  3, 2, 2, 2),
        e(5,  4, 2, 2, 2),
        e(6,  5, 2, 2, 2),
        e(7,  6, 2, 2, 2),
        e(8,  7, 2, 2, 2),
        e(9,  8, 2, 2, 2),
        e(10, 9, 2, 2, 2),
        e(11,10, 2, 2, 2),
        e(12,11, 2, 0, 2),   // orange merges back to main at row 11→12 (into lane 0)
        e(6,  3, 2, 0, 2),   // orange merges into main at row 3

        // teal branch (lane 3) — only appears rows 13..19
        e(14,13, 3, 3, 3),
        e(15,14, 3, 3, 3),
        e(16,15, 3, 3, 3),
        e(17,16, 3, 3, 3),
        e(18,17, 3, 3, 3),
        e(13,12, 3, 0, 3),   // teal's tip rises into row 12 merge (lane 0)
    ];

    GitGraph { rows, edges, lane_count: 4 }
}

pub fn mock_git_changes() -> Vec<GitChange> {
    vec![
        GitChange { file: "sidebar.rs".into(),    folder: "src/ui".into(),       status: GitChangeStatus::Modified },
        GitChange { file: "main.rs".into(),       folder: "src".into(),          status: GitChangeStatus::Modified },
        GitChange { file: "theme.rs".into(),      folder: "src".into(),          status: GitChangeStatus::Modified },
        GitChange { file: "composer/mod.rs".into(),folder: "src/ui".into(),      status: GitChangeStatus::Modified },
        GitChange { file: "old_hero.rs".into(),   folder: "src/ui/legacy".into(),status: GitChangeStatus::Deleted },
        GitChange { file: "diff_view.rs".into(),  folder: "src/ui".into(),       status: GitChangeStatus::Untracked },
    ]
}

#[derive(Clone, Debug, PartialEq)]
pub enum SemKind {
    Fn,
    Struct,
    Impl,
    Enum,
}

#[derive(Clone, Debug, PartialEq)]
pub enum IntentStatus {
    Tracked,
    Dirty,
    Missing,
}

#[derive(Clone, Debug)]
pub struct SemNode {
    pub name: String,
    pub kind: SemKind,
    pub status: IntentStatus,
    pub file: String,
}

pub fn mock_semantic_nodes() -> Vec<SemNode> {
    vec![
        SemNode { name: "main".into(),        kind: SemKind::Fn,     status: IntentStatus::Tracked, file: "src/main.rs".into() },
        SemNode { name: "App".into(),   kind: SemKind::Struct, status: IntentStatus::Tracked, file: "src/main.rs".into() },
        SemNode { name: "Message".into(),     kind: SemKind::Enum,   status: IntentStatus::Dirty,   file: "src/main.rs".into() },
        SemNode { name: "view".into(),        kind: SemKind::Fn,     status: IntentStatus::Dirty,   file: "src/ui/sidebar.rs".into() },
        SemNode { name: "tab_bar".into(),     kind: SemKind::Fn,     status: IntentStatus::Missing, file: "src/ui/sidebar.rs".into() },
        SemNode { name: "Session".into(),     kind: SemKind::Struct, status: IntentStatus::Tracked, file: "src/fixtures.rs".into() },
        SemNode { name: "mock_sessions".into(), kind: SemKind::Fn,   status: IntentStatus::Tracked, file: "src/fixtures.rs".into() },
        SemNode { name: "Workspace".into(),   kind: SemKind::Struct, status: IntentStatus::Tracked, file: "src/fixtures.rs".into() },
    ]
}

#[derive(Clone, Debug)]
pub struct TeamMember {
    pub name: String,
    pub avatar_letter: char,
    pub accent: iced::Color,
    pub editing: Option<String>,
}

pub fn mock_team_members() -> Vec<TeamMember> {
    vec![
        TeamMember { name: "Muhammed".into(), avatar_letter: 'M', accent: theme::CARET_ORANGE,  editing: Some("src/ui/sidebar.rs".into()) },
        TeamMember { name: "Claude".into(),   avatar_letter: 'C', accent: theme::AGENT_CLAUDE,  editing: Some("src/ui/sidebar_tab_files.rs".into()) },
        TeamMember { name: "Gemini".into(),   avatar_letter: 'G', accent: theme::AGENT_GEMINI,  editing: None },
    ]
}

#[derive(Clone, Debug)]
pub struct ZoneClaim {
    pub file: String,
    pub owner_initial: char,
    pub owner_accent: iced::Color,
    pub expires_in: String,
}

pub fn mock_zone_claims() -> Vec<ZoneClaim> {
    vec![
        ZoneClaim { file: "src/ui/sidebar.rs".into(),  owner_initial: 'M', owner_accent: theme::CARET_ORANGE, expires_in: "12m left".into() },
        ZoneClaim { file: "src/fixtures.rs".into(),    owner_initial: 'C', owner_accent: theme::AGENT_CLAUDE, expires_in: "3m left".into() },
    ]
}

#[derive(Clone, Debug)]
pub struct SearchHit {
    pub file: String,
    pub line: u32,
    pub snippet: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Keyword,
    Type,
    Fn,
    String,
    Number,
    Comment,
    Ident,
    Punct,
}

#[derive(Clone, Debug)]
pub struct Span {
    pub text: String,
    pub kind: TokenKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Modified,
}

#[derive(Clone, Debug)]
pub struct CodeLine {
    pub spans: Vec<Span>,
    pub change: Option<ChangeKind>,
}

#[derive(Clone, Debug)]
pub struct OpenFile {
    pub name: String,
    pub path: String,
    pub language: String,
    pub lines: Vec<CodeLine>,
    pub current_line: u32, // 1-based
}

fn sp(text: &str, kind: TokenKind) -> Span {
    Span { text: text.to_string(), kind }
}

pub fn mock_open_file() -> OpenFile {
    use TokenKind::*;
    let lines: Vec<CodeLine> = vec![
        CodeLine { change: None,                      spans: vec![sp("use ", Keyword), sp("iced", Ident), sp("::", Punct), sp("widget", Ident), sp("::{", Punct), sp("column", Fn), sp(", ", Punct), sp("container", Fn), sp(", ", Punct), sp("row", Fn), sp(", ", Punct), sp("text", Fn), sp("};", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("use ", Keyword), sp("iced", Ident), sp("::{", Punct), sp("Element", Type), sp(", ", Punct), sp("Length", Type), sp("};", Punct)] },
        CodeLine { change: None,                      spans: vec![] },
        CodeLine { change: None,                      spans: vec![sp("use ", Keyword), sp("crate", Keyword), sp("::{", Punct), sp("theme", Ident), sp(", ", Punct), sp("App", Type), sp(", ", Punct), sp("Message", Type), sp(", ", Punct), sp("SidebarTab", Type), sp("};", Punct)] },
        CodeLine { change: None,                      spans: vec![] },
        CodeLine { change: Some(ChangeKind::Added),    spans: vec![sp("// Renders the project sidebar with tab bar below the header.", Comment)] },
        CodeLine { change: None,                      spans: vec![sp("pub ", Keyword), sp("fn ", Keyword), sp("view", Fn), sp("<'a>(", Punct), sp("state", Ident), sp(": &'a ", Punct), sp("App", Type), sp(") -> ", Punct), sp("Element", Type), sp("<'a, ", Punct), sp("Message", Type), sp("> {", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("    ", Ident), sp("if let ", Keyword), sp("Some", Type), sp("(", Punct), sp("ws", Ident), sp(") = ", Punct), sp("state", Ident), sp(".", Punct), sp("current_workspace", Ident), sp(".", Punct), sp("as_ref", Fn), sp("() {", Punct)] },
        CodeLine { change: Some(ChangeKind::Modified), spans: vec![sp("        ", Ident), sp("let ", Keyword), sp("body", Ident), sp(" = ", Punct), sp("match ", Keyword), sp("state", Ident), sp(".", Punct), sp("sidebar_tab", Ident), sp(" {", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("            ", Ident), sp("SidebarTab", Type), sp("::", Punct), sp("Files", Ident), sp(" => ", Punct), sp("sidebar_tab_files", Ident), sp("::", Punct), sp("view", Fn), sp("(", Punct), sp("state", Ident), sp("),", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("            ", Ident), sp("SidebarTab", Type), sp("::", Punct), sp("Git", Ident), sp(" => ", Punct), sp("sidebar_tab_git", Ident), sp("::", Punct), sp("view", Fn), sp("(", Punct), sp("state", Ident), sp("),", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("            ", Ident), sp("SidebarTab", Type), sp("::", Punct), sp("Sessions", Ident), sp(" => ", Punct), sp("sidebar_tab_sessions", Ident), sp("::", Punct), sp("view", Fn), sp("(", Punct), sp("state", Ident), sp("),", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("            ", Ident), sp("_", Keyword), sp(" => ", Punct), sp("container", Fn), sp("(", Punct), sp("text", Fn), sp("(", Punct), sp("\"TODO\"", String), sp(")).", Punct), sp("into", Fn), sp("(),", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("        };", Punct)] },
        CodeLine { change: None,                      spans: vec![] },
        CodeLine { change: None,                      spans: vec![sp("        ", Ident), sp("let ", Keyword), sp("gap", Ident), sp(" = ", Punct), sp("theme", Ident), sp("::", Punct), sp("P_SM", Ident), sp(";", Punct), sp(" // 8px", Comment)] },
        CodeLine { change: None,                      spans: vec![sp("        ", Ident), sp("let ", Keyword), sp("tabs", Ident), sp(" = ", Punct), sp("tab_bar", Fn), sp("(", Punct), sp("state", Ident), sp(".", Punct), sp("sidebar_tab", Ident), sp(");", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("        ", Ident), sp("let ", Keyword), sp("stack", Ident), sp(" = ", Punct), sp("column!", Fn), sp("[", Punct), sp("header", Ident), sp(", ", Punct), sp("tabs", Ident), sp(", ", Punct), sp("body", Ident), sp("];", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("        ", Ident), sp("return ", Keyword), sp("container", Fn), sp("(", Punct), sp("stack", Ident), sp(").", Punct), sp("width", Fn), sp("(", Punct), sp("Length", Type), sp("::", Punct), sp("Fill", Ident), sp(").", Punct), sp("into", Fn), sp("();", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("    }", Punct)] },
        CodeLine { change: None,                      spans: vec![] },
        CodeLine { change: None,                      spans: vec![sp("    ", Ident), sp("let ", Keyword), sp("placeholder", Ident), sp(" = ", Punct), sp("text", Fn), sp("(", Punct), sp("\"No projects open\"", String), sp(");", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("    ", Ident), sp("container", Fn), sp("(", Punct), sp("placeholder", Ident), sp(").", Punct), sp("center_x", Fn), sp("(", Punct), sp("Length", Type), sp("::", Punct), sp("Fill", Ident), sp(").", Punct), sp("into", Fn), sp("()", Punct)] },
        CodeLine { change: None,                      spans: vec![sp("}", Punct)] },
        CodeLine { change: None,                      spans: vec![] },
        CodeLine { change: Some(ChangeKind::Added),    spans: vec![sp("fn ", Keyword), sp("tab_bar", Fn), sp("<'a>(", Punct), sp("active", Ident), sp(": ", Punct), sp("SidebarTab", Type), sp(") -> ", Punct), sp("Element", Type), sp("<'a, ", Punct), sp("Message", Type), sp("> {", Punct)] },
        CodeLine { change: Some(ChangeKind::Added),    spans: vec![sp("    ", Ident), sp("let ", Keyword), sp("tabs", Ident), sp(" = ", Punct), sp("row!", Fn), sp("[](", Punct), sp(");", Punct)] },
        CodeLine { change: Some(ChangeKind::Added),    spans: vec![sp("    ", Ident), sp("container", Fn), sp("(", Punct), sp("tabs", Ident), sp(").", Punct), sp("into", Fn), sp("()", Punct)] },
        CodeLine { change: Some(ChangeKind::Added),    spans: vec![sp("}", Punct)] },
    ];

    OpenFile {
        name: "sidebar.rs".into(),
        path: "src/ui/sidebar.rs".into(),
        language: "rust".into(),
        lines,
        current_line: 9,
    }
}

pub fn mock_open_tabs() -> Vec<String> {
    vec!["sidebar.rs".into(), "main.rs".into(), "theme.rs".into()]
}

pub fn mock_search_hits(query: &str) -> Vec<SearchHit> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let all: Vec<SearchHit> = vec![
        SearchHit { file: "src/ui/sidebar.rs".into(), line: 11,  snippet: ".padding(iced::Padding { top: 0.0, right: 18.0,".into() },
        SearchHit { file: "src/ui/topbar.rs".into(),  line: 115, snippet: "let input = text_input(&placeholder, query)".into() },
        SearchHit { file: "src/main.rs".into(),       line: 108, snippet: "SearchInput(String),".into() },
        SearchHit { file: "Cargo.toml".into(),        line: 8,   snippet: "iced = { version = \"0.14\",".into() },
    ];
    let q = query.to_lowercase();
    all.into_iter()
        .filter(|h| h.file.to_lowercase().contains(&q) || h.snippet.to_lowercase().contains(&q))
        .collect()
}
