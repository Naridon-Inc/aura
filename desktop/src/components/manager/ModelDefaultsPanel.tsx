// ModelDefaultsPanel — the standing model config, extracted from the composer's
// old standalone DefaultModelPicker chip (#17). The composer used to carry TWO
// look-alike chips, both labelled "Auto": the per-turn model picker and this.
// They read as duplicates, so this lives in Settings → Models, under the
// loadout the chat's model picker shows, and no two controls in this family
// share a name any more.
//
// A settings-grade axis, distinct from the per-turn override beside it: the
// model a fresh agent session opens with, which the new-session picker
// preselects. Reads/writes the same `useModelPrefs` store, so a change here
// is reflected instantly everywhere the pref is consumed.
//
// It used to carry a per-task table too (simple edits, chat, plans) that
// nothing routed by; a choice that changes nothing is not offered.
//
// A settings section of one settings row, answered by the shared select, so
// it sits in Settings → Models the way every other preference does.

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { MODEL_OPTIONS, setDefaultModel, useModelPrefs, type ModelId } from "../../lib/modelStore";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import "../ui/model-defaults.css";

/** Default model block. `defaultOpen` pins it open (Settings → Models
 *  does); without it the block starts folded behind one row that names the
 *  current default, so it reads as config rather than as another model. */
export function ModelDefaultsPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const prefs = useModelPrefs();
  const [open, setOpen] = useState(defaultOpen);

  const isAuto = prefs.default === "auto";
  const activeOpt = MODEL_OPTIONS.find((m) => m.id === prefs.default);
  // Trim the vendor prefix so the summary stays compact ("Opus 4.7", not the
  // full "Claude Opus 4.7").
  const defaultLabel = isAuto
    ? "the agent's own default"
    : (activeOpt?.label ?? "the agent's own default").replace(/^Claude\s+/, "");

  return (
    <div
      className="ui-model-defaults"
      // Keep a surrounding palette's keyboard nav (Arrow moves / Enter picks)
      // from firing while these controls are operated. Escape still bubbles
      // so it closes whatever this sits in.
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      {!defaultOpen && (
        <SettingsRow
          title="Default model"
          description={`New sessions start on ${defaultLabel}`}
          control={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide" : "Show"}
              <ChevronRight className="ui-model-defaults-chevron" data-open={open || undefined} />
            </Button>
          }
        />
      )}

      {open && (
        <SettingsSection title="New sessions start on">
          <SettingsRow
            title="Default model"
            description={activeOpt?.hint}
            htmlFor="setting-default-model"
            control={
              <Select
                id="setting-default-model"
                aria-label="Model new sessions start on"
                align="end"
                value={prefs.default}
                onChange={(next) => setDefaultModel(next as ModelId)}
                options={MODEL_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
              />
            }
          />
        </SettingsSection>
      )}
    </div>
  );
}
