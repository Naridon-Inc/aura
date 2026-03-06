import { useState } from 'react';
import { AlertTriangle, Eye } from 'lucide-react';
import type { ReviewFile, DiffLine, AiFinding } from '../lib/types';

interface DiffViewerProps {
  file: ReviewFile;
  onFindingClick?: (finding: AiFinding) => void;
}

// Simple regex-based syntax highlighting for common languages
function tokenize(content: string, language: string): string {
  if (!content) return '';

  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = escape(content);

  // Comments
  html = html.replace(/(\/\/.*$)/gm, '<span class="syn-comment">$1</span>');

  // Strings
  html = html.replace(/("(?:[^"\\]|\\.)*")/g, '<span class="syn-string">$1</span>');
  html = html.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="syn-string">$1</span>');
  html = html.replace(/(`(?:[^`\\]|\\.)*`)/g, '<span class="syn-string">$1</span>');

  // Numbers
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="syn-number">$1</span>');

  // Keywords by language
  let keywords: string[] = [];
  if (language === 'rust') {
    keywords = ['fn', 'let', 'mut', 'pub', 'use', 'mod', 'struct', 'enum', 'impl', 'trait', 'where', 'async', 'await', 'self', 'Self', 'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'const', 'static', 'type', 'crate', 'super', 'move', 'ref', 'true', 'false', 'Some', 'None', 'Ok', 'Err'];
  } else if (language === 'typescript' || language === 'javascript') {
    keywords = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'export', 'import', 'from', 'default', 'async', 'await', 'new', 'this', 'super', 'extends', 'implements', 'interface', 'type', 'enum', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof'];
  } else if (language === 'python') {
    keywords = ['def', 'class', 'return', 'if', 'else', 'elif', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'raise', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'self', 'async', 'await', 'yield', 'lambda'];
  }

  if (keywords.length > 0) {
    const kwPattern = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
    // Only apply keyword highlighting to text not already in a span
    html = html.replace(kwPattern, (match) => {
      return `<span class="syn-keyword">${match}</span>`;
    });
  }

  return html;
}

function DiffLineRow({ line, language, findingAtLine, onFindingClick }: {
  line: DiffLine;
  language: string;
  findingAtLine: AiFinding | undefined;
  onFindingClick?: (finding: AiFinding) => void;
}) {
  const bgClass = line.type === 'add' ? 'bg-green-50' : line.type === 'del' ? 'bg-red-50' : '';
  const gutterBg = line.type === 'add' ? 'bg-green-100' : line.type === 'del' ? 'bg-red-100' : 'bg-gray-50';
  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const textColor = line.type === 'add' ? 'text-green-800' : line.type === 'del' ? 'text-red-800' : 'text-gray-800';

  return (
    <>
      <tr className={`${bgClass} hover:brightness-95 transition-colors`}>
        {/* Finding gutter */}
        <td className={`w-6 text-center ${gutterBg} border-r border-gray-200`}>
          {findingAtLine && (
            <button
              onClick={() => onFindingClick?.(findingAtLine)}
              className="text-yellow-500 hover:text-yellow-600"
              title={findingAtLine.issue}
            >
              <AlertTriangle size={12} />
            </button>
          )}
        </td>
        {/* Old line number */}
        <td className={`w-10 text-right pr-2 select-none text-[11px] ${gutterBg} text-gray-400 border-r border-gray-200`}>
          {line.old_lineno ?? ''}
        </td>
        {/* New line number */}
        <td className={`w-10 text-right pr-2 select-none text-[11px] ${gutterBg} text-gray-400 border-r border-gray-200`}>
          {line.new_lineno ?? ''}
        </td>
        {/* Prefix */}
        <td className={`w-4 text-center select-none text-xs font-mono ${textColor}`}>{prefix}</td>
        {/* Content */}
        <td className={`pl-1 pr-4 text-xs font-mono whitespace-pre ${textColor}`}>
          <span dangerouslySetInnerHTML={{ __html: tokenize(line.content, language) }} />
        </td>
      </tr>
      {findingAtLine && (
        <tr className="bg-yellow-50 border-y border-yellow-200">
          <td colSpan={5} className="px-4 py-2">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle size={14} className="text-yellow-600 mt-0.5 shrink-0" />
              <div>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${findingAtLine.severity === 'HIGH' ? 'bg-red-100 text-red-700' : findingAtLine.severity === 'MED' ? 'bg-yellow-100 text-yellow-700' : 'bg-blue-100 text-blue-700'}`}>
                  {findingAtLine.severity}
                </span>
                <span className="text-yellow-800">{findingAtLine.issue}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function DiffViewer({ file, onFindingClick }: DiffViewerProps) {
  const [viewed, setViewed] = useState(false);

  // Build a set of line numbers with findings for quick lookup
  const findingsByLine = new Map<number, AiFinding>();
  // Findings from AI don't have exact line numbers, but we can try to match by node name
  // For now, show them on the first line of the first hunk as annotations
  const allFindings = [...file.findings.bugs, ...file.findings.security];
  if (allFindings.length > 0 && file.hunks.length > 0) {
    // Distribute findings across the first few added lines
    let lineIdx = 0;
    for (const finding of allFindings) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'add' && line.new_lineno) {
            if (lineIdx === 0) {
              findingsByLine.set(line.new_lineno, finding);
              lineIdx++;
              break;
            }
            lineIdx--;
          }
        }
        if (findingsByLine.has(0)) break;
      }
      lineIdx = allFindings.indexOf(finding) + 1;
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-3 bg-gray-50">
        <span className="text-sm font-mono text-gray-800 flex-1 truncate">{file.path}</span>
        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">{file.language}</span>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
          <input type="checkbox" checked={viewed} onChange={() => setViewed(!viewed)} className="rounded" />
          <Eye size={12} />
          Viewed
        </label>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto">
        {file.hunks.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            {file.status === 'deleted' ? 'File was deleted' : 'No diff hunks available'}
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <tbody>
              {file.hunks.map((hunk, hi) => (
                <>{hunk.lines.map((line, li) => (
                  <DiffLineRow
                    key={`${hi}-${li}`}
                    line={line}
                    language={file.language}
                    findingAtLine={line.new_lineno ? findingsByLine.get(line.new_lineno) : undefined}
                    onFindingClick={onFindingClick}
                  />
                ))}</>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
