import { type ReactNode } from "react";

import { SettingsSection } from "../ui/settings-row";
import { type FoldedPageId, foldLabel } from "./nav";
import "./settings-fold.css";

/** A part of a settings page a link can name, under its own heading, where
 *  that link lands. Most sit in the page's Advanced. `bare` is for a part
 *  that already draws its own heading. */
export function Fold({
  id,
  bare = false,
  children,
}: {
  id: FoldedPageId;
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ui-settings-fold" data-fold={id}>
      {bare ? children : <SettingsSection title={foldLabel(id)}>{children}</SettingsSection>}
    </div>
  );
}
