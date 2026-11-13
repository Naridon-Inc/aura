import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Input } from "./input";
import { Sidebar, SidebarHeader, SidebarContent, SidebarItem } from "./sidebar";
import "./settings-nav.css";
export interface SettingsDestination {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Sub-pages drawn under the entry while it, or one of them, is open. */
  children?: SettingsDestination[];
}
export interface SettingsNavigationGroup {
  label: string;
  items: SettingsDestination[];
}
export interface SettingsLayoutProps {
  title: string;
  groups: SettingsNavigationGroup[];
  selected: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  account?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}
export function SettingsLayout({
  title,
  groups,
  selected,
  onSelect,
  onBack,
  query,
  onQueryChange,
  account,
  toolbar,
  children,
}: SettingsLayoutProps) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="ui-settings-layout">
      <Sidebar aria-label="Settings navigation">
        <SidebarHeader>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
        </SidebarHeader>
        {account && <div className="ui-settings-account">{account}</div>}
        <div className="ui-settings-search">
          <Input
            ref={search}
            suffix={<Kbd>⌘ F</Kbd>}
            prefix={<Search size={16} />}
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <SidebarContent>
          {groups.map((group) => (
            <section className="ui-settings-nav-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => (
                <SettingsNavEntry
                  key={item.id}
                  item={item}
                  selected={selected}
                  onSelect={onSelect}
                />
              ))}
            </section>
          ))}
        </SidebarContent>
      </Sidebar>
      <main className="ui-settings-main">
        <header className="ui-settings-toolbar">{toolbar}</header>
        <div className="ui-settings-scroll">
          <div className="ui-settings-page">
            <h1>{title}</h1>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
function SettingsNavEntry({
  item,
  selected,
  onSelect,
}: {
  item: SettingsDestination;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const sub = item.children ?? [];
  const open = selected === item.id || sub.some((child) => child.id === selected);
  return (
    <>
      <SidebarItem
        label={item.label}
        icon={item.icon}
        selected={selected === item.id && sub.length === 0}
        onClick={() => onSelect(sub[0]?.id ?? item.id)}
      />
      {open && sub.length > 0 && (
        <div className="ui-settings-nav-sub">
          {sub.map((child) => (
            <SidebarItem
              key={child.id}
              label={child.label}
              selected={selected === child.id}
              onClick={() => onSelect(child.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}
