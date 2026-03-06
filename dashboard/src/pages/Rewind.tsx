import { useState, useCallback } from 'react';
import { useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import { RotateCcw, Loader2, AlertCircle, CheckCircle, Info } from 'lucide-react';

export default function Rewind() {
  const [identifier, setIdentifier] = useState('');
  const [file, setFile] = useState('');
  const rewind = useMutation(
    useCallback((params: { identifier: string; file: string }) => api.rewind(params.identifier, params.file), [])
  );

  const handleRewind = async () => {
    if (!identifier.trim() || !file.trim()) return;
    try { await rewind.mutate({ identifier, file }); } catch {}
  };

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Rewind</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Surgically revert a single function, class, or AST node to its previous safe version — without touching any surrounding code.
          </p>
        </div>
        <div className="mt-auto p-4 border-t border-gray-100 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <Info size={12} /> <span className="font-medium text-gray-500">How rewind works</span>
          </div>
          <p className="leading-relaxed">Aura uses the Merkle-Graph to find the last known-good version of a function. It replaces only that function's source code, preserving all other changes you've made.</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-[720px] mx-auto space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-gray-900 mb-1">Surgical Rewind</h2>
              <p className="text-sm text-gray-500 leading-relaxed">
                Specify a function or node name and the file it lives in. Aura will look up the last safe version from the Merkle-Graph and surgically replace just that code, leaving everything else untouched.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Function / Node Name</label>
              <input
                type="text"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                placeholder="e.g. run_review, SemanticParser, handle_webhook"
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <p className="text-xs text-gray-400 mt-1">The name of the function, class, or struct you want to revert.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">File Path</label>
              <input
                type="text"
                value={file}
                onChange={e => setFile(e.target.value)}
                placeholder="e.g. src/pr.rs, src/server.rs"
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <p className="text-xs text-gray-400 mt-1">Relative path from the repo root to the file containing the node.</p>
            </div>

            <button
              onClick={handleRewind}
              disabled={rewind.loading || !identifier.trim() || !file.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 transition-colors"
            >
              {rewind.loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              Rewind Node
            </button>
          </div>

          {rewind.error && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-medium text-red-800">Rewind failed</div>
                <span className="text-sm text-red-700">{rewind.error}</span>
              </div>
            </div>
          )}

          {rewind.data?.status === 'ok' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle size={18} className="text-green-500 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-green-800">Rewind successful</div>
                  <span className="text-sm text-green-700">
                    Restored <code className="font-mono bg-green-100 px-1.5 py-0.5 rounded">{rewind.data.identifier}</code> in <code className="font-mono bg-green-100 px-1.5 py-0.5 rounded">{rewind.data.file}</code>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 bg-red-50 border-b border-red-100 text-sm font-medium text-red-600">Before (removed)</div>
                  <pre className="p-4 text-xs font-mono text-gray-700 overflow-auto max-h-64 leading-relaxed">{rewind.data.old_source}</pre>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 bg-green-50 border-b border-green-100 text-sm font-medium text-green-600">After (restored)</div>
                  <pre className="p-4 text-xs font-mono text-gray-700 overflow-auto max-h-64 leading-relaxed">{rewind.data.restored_source}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
