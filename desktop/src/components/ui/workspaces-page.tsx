import { useEffect, type ReactNode } from "react";
import "./workspaces-page.css";

/** The ground a Workspaces page stands on. Escape steps back out of it, the
 *  way every full page in the app does. */
export function WorkspacesPage({
  onClose,
  label,
  children,
}: {
  onClose?: () => void;
  label: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A menu or dialog open on top owns its own Escape, and so does Aura's
      // panel beside Home: Escape there stops a reply or clears the composer,
      // it doesn't close the page under it.
      if (
        (e.target as HTMLElement | null)?.closest?.(
          '[role="menu"],[role="dialog"],[data-aura-panel]',
        )
      )
        return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section className="ui-workspaces-page" aria-label={label}>
      {children}
    </section>
  );
}

/** The 40px bar a page wears above its content: the page's name on the left,
 *  its actions on the right. */
export function WorkspacesPageHeader({
  leading,
  title,
  actions,
}: {
  leading?: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-workspaces-header">
      {leading}
      <span>{title}</span>
      <div className="ui-workspaces-header-space" />
      {actions}
    </header>
  );
}
