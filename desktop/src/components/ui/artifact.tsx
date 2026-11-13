import { useState, type ReactNode } from "react";
import { Code2, Eye, Download, FileCode2, ChevronLeft, ChevronRight } from "lucide-react";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tab-panels";
export function ArtifactFrame({
  title,
  description,
  actions,
  children,
  onOpen,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <section className="ui-artifact-frame">
      <div className="ui-artifact-header">
        <FileCode2 size={16} />
        <button type="button" className="ui-artifact-name" onClick={onOpen} disabled={!onOpen}>
          <span>{title}</span>
          {description && <small>{description}</small>}
        </button>
        {actions}
      </div>
      <div className="ui-artifact-body">{children}</div>
    </section>
  );
}
export interface ArtifactVersion {
  content: string;
  label: string;
}
export function ArtifactView({
  title,
  versions,
  kind = "html",
  renderPreview,
  loading,
  error,
  onRetry,
}: {
  title: string;
  versions: ArtifactVersion[];
  kind?: "html" | "text";
  renderPreview?: (content: string) => ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const [selected, setSelected] = useState<number>();
  const [code, setCode] = useState(false);
  const index = Math.max(0, Math.min(selected ?? versions.length - 1, versions.length - 1));
  const content = versions[index]?.content ?? "";
  const save = () => {
    const url = URL.createObjectURL(
      new Blob([content], { type: kind === "html" ? "text/html" : "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^a-z0-9-]/gi, "-")}.${kind === "html" ? "html" : "txt"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Tabs
      className="ui-artifact-view"
      value={code ? "code" : "preview"}
      onValueChange={(value) => setCode(value === "code")}
    >
      <div className="ui-artifact-toolbar">
        <span>{title}</span>
        <TabsList aria-label="Artifact display">
          <TabsTrigger value="preview">
            <Eye size={14} />
            Preview
          </TabsTrigger>
          <TabsTrigger value="code">
            <Code2 size={14} />
            Code
          </TabsTrigger>
        </TabsList>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Download artifact"
          disabled={loading || !!error || !versions.length}
          onClick={save}
        >
          <Download />
        </Button>
      </div>
      <TabsContent value="code" className="ui-artifact-preview">
        {loading ? (
          <div className="ui-pattern-empty">
            <AsciiSpinner />
            Loading artifact…
          </div>
        ) : error || !versions.length ? (
          <div className="ui-pattern-empty" role="status">
            {error ?? "This artifact is no longer available."}
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <pre>{content}</pre>
        )}
      </TabsContent>
      <TabsContent value="preview" className="ui-artifact-preview">
        {loading ? (
          <div className="ui-pattern-empty">
            <AsciiSpinner />
            Loading artifact…
          </div>
        ) : error || !versions.length ? (
          <div className="ui-pattern-empty" role="status">
            {error ?? "This artifact is no longer available."}
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : renderPreview ? (
          renderPreview(content)
        ) : kind === "html" ? (
          <iframe title={title} srcDoc={content} sandbox="allow-scripts" />
        ) : (
          <pre>{content}</pre>
        )}
      </TabsContent>
      {versions.length > 1 && (
        <div className="ui-artifact-version">
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Previous artifact version"
            disabled={index === 0}
            onClick={() => setSelected(index - 1)}
          >
            <ChevronLeft />
          </Button>
          <label>
            Version{" "}
            <select value={index} onChange={(event) => setSelected(Number(event.target.value))}>
              {versions.map((version, i) => (
                <option key={i} value={i}>
                  {version.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Next artifact version"
            disabled={index === versions.length - 1}
            onClick={() => setSelected(index + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </Tabs>
  );
}
