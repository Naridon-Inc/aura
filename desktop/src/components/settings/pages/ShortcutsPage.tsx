import { Kbd } from "../../ui/kbd";
import { SettingsSection } from "../../ui/settings-row";
import { Table, TableBody, TableCell, TableRow } from "../../ui/table";
import { SHORTCUT_GROUPS, comboKeys } from "../../../lib/shortcuts";

// Every key binding in the app, from the shared shortcut map the ⌘/ sheet
// also reads, so the two can never drift. Grouped, and each group carries
// where it applies: `Enter` opens a task on a focused card and builds a
// plan on a plan card, and side by side without a heading those look like
// a contradiction.

/** A combo as key caps. `comboKeys` knows that "Enter" is one key, not
 *  five letters. */
export function KbdCombo({ combo }: { combo: string }) {
  return <Kbd>{comboKeys(combo).join(" ")}</Kbd>;
}

export function ShortcutsPage({ query = "" }: { query?: string }) {
  const q = query.trim().toLowerCase();
  const matching = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !q || item.label.toLowerCase().includes(q)),
  })).filter((group) => group.items.length > 0);
  // A search that found this page by its own name, not by a binding,
  // still shows every binding.
  const groups = matching.length > 0 ? matching : SHORTCUT_GROUPS;
  return (
    <>
      {groups.map((group) => (
        <SettingsSection key={group.title} title={group.title} description={group.note}>
          <Table>
            <TableBody>
              {group.items.map((item) => (
                // Keyed by label: two groups bind Enter, two bind Esc.
                <TableRow key={item.label}>
                  <TableCell>{item.label}</TableCell>
                  <TableCell style={{ textAlign: "right" }}>
                    <KbdCombo combo={item.keys} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsSection>
      ))}
    </>
  );
}
