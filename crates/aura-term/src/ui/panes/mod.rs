//! Work-surface panes — one module per `App::Pane` variant. Each pane
//! owns a `Model` loaded from repo state plus a `view(...)` fn that
//! returns an `Element<M>`. The app routes `state.active_pane` into the
//! matching pane's view (see `ui::active::view`).
//!
//! Library (term's file-browser pane) is intentionally absent — proto's
//! nav_rail + sidebar_tab_files already cover that surface.

use std::path::{Path, PathBuf};

pub mod conflict;
pub mod doctor;
pub mod impacts;
pub mod memory;
pub mod orchestration;
pub mod plan;
pub mod proof;
pub mod team;
pub mod timeline;
pub mod work;

/// Aggregate of every pane's Model. Loaded once at App::new from the repo
/// root; refreshed on demand by the app when state changes (e.g. after a
/// command finishes → reload Work + Timeline).
pub struct Panes {
    pub root: PathBuf,
    pub plan: plan::Model,
    pub impacts: impacts::Model,
    pub team: team::Model,
    pub timeline: timeline::Model,
    pub proof: proof::Model,
    pub memory: memory::Model,
    pub doctor: doctor::Model,
    pub conflict: conflict::Model,
    pub orchestration_tiles: Vec<crate::ui::orchestration::Tile>,
    pub orchestration_plan: Option<String>,
}

impl Panes {
    pub fn load(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            plan: plan::Model::load(root),
            impacts: impacts::Model::load(root),
            team: team::Model::load(root),
            timeline: timeline::Model::load(root),
            proof: proof::Model::default(),
            memory: memory::Model::load(),
            doctor: doctor::Model::load(root),
            conflict: conflict::Model::load(root),
            orchestration_tiles: orchestration::load_tiles_from_disk(root),
            orchestration_plan: orchestration::active_plan_name(root),
        }
    }

    pub fn reload_volatile(&mut self) {
        self.plan = plan::Model::load(&self.root);
        self.impacts = impacts::Model::load(&self.root);
        self.team = team::Model::load(&self.root);
        self.timeline = timeline::Model::load(&self.root);
        self.doctor = doctor::Model::load(&self.root);
        self.conflict = conflict::Model::load(&self.root);
        self.orchestration_tiles = orchestration::load_tiles_from_disk(&self.root);
        self.orchestration_plan = orchestration::active_plan_name(&self.root);
    }
}
