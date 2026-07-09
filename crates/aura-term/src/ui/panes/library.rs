//! Library pane — delegates to the existing `sidebar` module.
//!
//! The Library pane surfaces MCP servers, rules, skills, and workflows.
//! Rather than duplicate the filesystem scanning and rendering already
//! implemented in `ui::sidebar`, we reuse it verbatim — the 4-tab sidebar
//! knows how to render a Library view, and the app forces its active tab
//! to `Library` when the user clicks the Library rail slot.
//!
//! Once all of the old 4-tab content is migrated into dedicated panes we
//! can collapse `sidebar.rs` down to a library-only renderer; for now we
//! keep it as-is to avoid churn.

use aura_blocks::Block;
use iced::Element;

use crate::ui::sidebar;

pub fn view<'a, M: 'a + Clone>(
    state: &'a sidebar::State,
    blocks: &'a [(Block, Vec<u8>)],
    callbacks: sidebar::Callbacks<M>,
) -> Element<'a, M> {
    sidebar::view(state, blocks, callbacks)
}
