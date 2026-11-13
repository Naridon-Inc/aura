import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-settings-section">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      <div>{children}</div>
    </section>
  );
}
export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
}
export function SettingsRow({
  title,
  description,
  control,
  htmlFor,
  help,
  children,
  className,
  ...props
}: SettingsRowProps) {
  return (
    <div className={cn("ui-settings-row", className)} {...props}>
      <div className="ui-settings-row-main">
        <div>
          {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
          {description && <p>{description}</p>}
          {help && <div className="ui-settings-help">{help}</div>}
        </div>
        <div className="ui-settings-control">{control}</div>
      </div>
      {children && <div className="ui-settings-preview">{children}</div>}
    </div>
  );
}
