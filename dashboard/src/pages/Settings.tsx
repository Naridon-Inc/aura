import { useState, useCallback, useEffect } from 'react';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import { Save, Loader2, CheckCircle, Eye, EyeOff, Info } from 'lucide-react';
import type { ConfigUpdate } from '../lib/types';

export default function Settings() {
  const { data, loading, refetch } = useApi(useCallback(() => api.getConfig(), []));
  const save = useMutation(useCallback((updates: Partial<ConfigUpdate>) => api.setConfig(updates), []));

  const [form, setForm] = useState<Partial<ConfigUpdate>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const config = data?.config;

  useEffect(() => {
    if (config) {
      setForm({
        ai_provider: config.ai_provider || undefined,
        provider_architect: config.provider_architect || undefined,
        provider_researcher: config.provider_researcher || undefined,
        provider_auditor: config.provider_auditor || undefined,
        provider_arbitrator: config.provider_arbitrator || undefined,
        model_architect: config.model_architect || undefined,
        model_researcher: config.model_researcher || undefined,
        model_auditor: config.model_auditor || undefined,
        model_arbitrator: config.model_arbitrator || undefined,
        strict_gatekeeper_mode: config.strict_gatekeeper_mode,
        use_local_embeddings: config.use_local_embeddings,
        dev_mode: config.dev_mode,
        telemetry_enabled: config.telemetry_enabled,
      });
    }
  }, [config]);

  const handleSave = async () => {
    await save.mutate(form);
    refetch();
  };

  const providers = ['gemini', 'anthropic', 'openai', 'mercury'];

  if (loading) return (
    <div className="flex h-full">
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col" />
      <div className="flex-1 p-8"><div className="max-w-[720px] mx-auto h-64 bg-white border border-gray-200 rounded-lg animate-pulse" /></div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Settings</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Configure Aura's AI providers, API keys, model overrides, and behavior settings. Changes are saved to your local Aura config.
          </p>
        </div>
        <div className="px-3 space-y-0.5">
          <SidebarItem label="AI Provider" active />
          <SidebarItem label="Labor Overrides" />
          <SidebarItem label="Model Overrides" />
          <SidebarItem label="API Keys" />
          <SidebarItem label="Behavior" />
        </div>
        <div className="mt-auto p-4 border-t border-gray-100 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <Info size={12} /> <span className="font-medium text-gray-500">Config location</span>
          </div>
          <p className="leading-relaxed font-mono">~/.config/aura/config.json</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-[720px] mx-auto space-y-5">
          {save.data?.status === 'ok' && (
            <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              <CheckCircle size={16} /> Settings saved successfully
            </div>
          )}

          {/* Provider */}
          <Section
            title="AI Provider"
            desc="Choose the default AI provider for all Aura operations. You can override this per-labor below."
            action={<SaveBtn loading={save.loading} onClick={handleSave} />}
          >
            <SelectField label="Default Provider" value={form.ai_provider || ''} options={providers} onChange={v => setForm(f => ({ ...f, ai_provider: v }))} desc="Used for all labors unless overridden" />
          </Section>

          {/* Per-Labor Overrides */}
          <Section title="Labor Provider Overrides" desc="Optionally assign different AI providers to each labor role. Leave blank to use the default provider.">
            <div className="grid grid-cols-2 gap-4">
              <SelectField label="Architect" value={form.provider_architect || ''} options={['', ...providers]} onChange={v => setForm(f => ({ ...f, provider_architect: v || undefined }))} desc="Plans features and architecture" />
              <SelectField label="Researcher" value={form.provider_researcher || ''} options={['', ...providers]} onChange={v => setForm(f => ({ ...f, provider_researcher: v || undefined }))} desc="Gathers context from codebase" />
              <SelectField label="Auditor" value={form.provider_auditor || ''} options={['', ...providers]} onChange={v => setForm(f => ({ ...f, provider_auditor: v || undefined }))} desc="Reviews code for bugs/security" />
              <SelectField label="Arbitrator" value={form.provider_arbitrator || ''} options={['', ...providers]} onChange={v => setForm(f => ({ ...f, provider_arbitrator: v || undefined }))} desc="Resolves conflicts between labors" />
            </div>
          </Section>

          {/* Models */}
          <Section title="Model Overrides" desc="Specify exact model IDs per labor. Leave blank for the provider's default model.">
            <div className="grid grid-cols-2 gap-4">
              <TextField label="Architect" value={form.model_architect || ''} placeholder="claude-sonnet-4-6" onChange={v => setForm(f => ({ ...f, model_architect: v || undefined }))} />
              <TextField label="Researcher" value={form.model_researcher || ''} placeholder="gemini-2.0-flash" onChange={v => setForm(f => ({ ...f, model_researcher: v || undefined }))} />
              <TextField label="Auditor" value={form.model_auditor || ''} placeholder="gpt-4o" onChange={v => setForm(f => ({ ...f, model_auditor: v || undefined }))} />
              <TextField label="Arbitrator" value={form.model_arbitrator || ''} placeholder="claude-opus-4-6" onChange={v => setForm(f => ({ ...f, model_arbitrator: v || undefined }))} />
            </div>
          </Section>

          {/* API Keys */}
          <Section title="API Keys" desc="Enter your API keys for each provider. Keys are stored locally and never sent to Aura's servers.">
            <div className="space-y-4">
              <KeyField label="Gemini" hasKey={config?.has_gemini_key} show={showKeys.gemini} onToggle={() => setShowKeys(s => ({ ...s, gemini: !s.gemini }))} onChange={v => setForm(f => ({ ...f, gemini_api_key: v }))} />
              <KeyField label="Anthropic" hasKey={config?.has_anthropic_key} show={showKeys.anthropic} onToggle={() => setShowKeys(s => ({ ...s, anthropic: !s.anthropic }))} onChange={v => setForm(f => ({ ...f, anthropic_api_key: v }))} />
              <KeyField label="OpenAI" hasKey={config?.has_openai_key} show={showKeys.openai} onToggle={() => setShowKeys(s => ({ ...s, openai: !s.openai }))} onChange={v => setForm(f => ({ ...f, openai_api_key: v }))} />
              <KeyField label="Mercury" hasKey={config?.has_mercury_key} show={showKeys.mercury} onToggle={() => setShowKeys(s => ({ ...s, mercury: !s.mercury }))} onChange={v => setForm(f => ({ ...f, mercury_api_key: v }))} />
            </div>
          </Section>

          {/* Toggles */}
          <Section title="Behavior" desc="Control how Aura operates. These settings affect commit gating, embedding strategy, and development workflow.">
            <div className="space-y-4">
              <Toggle label="Strict Gatekeeper" desc="Block commits that violate architectural invariants. Recommended for production codebases." checked={form.strict_gatekeeper_mode ?? false} onChange={v => setForm(f => ({ ...f, strict_gatekeeper_mode: v }))} />
              <Toggle label="Local Embeddings" desc="Use sovereign offline embeddings instead of cloud APIs. Slower but fully private." checked={form.use_local_embeddings ?? false} onChange={v => setForm(f => ({ ...f, use_local_embeddings: v }))} />
              <Toggle label="Dev Mode" desc="Skip heavy infrastructure checks for faster local development iteration." checked={form.dev_mode ?? false} onChange={v => setForm(f => ({ ...f, dev_mode: v }))} />
              <Toggle label="Telemetry" desc="Send anonymous usage analytics to help improve Aura. No code or keys are ever transmitted." checked={form.telemetry_enabled ?? true} onChange={v => setForm(f => ({ ...f, telemetry_enabled: v }))} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ label, active }: { label: string; active?: boolean }) {
  return (
    <div className={`px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${active ? 'bg-gray-50 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}>
      {label}
    </div>
  );
}

function Section({ title, desc, action, children }: { title: string; desc?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <span className="text-base font-semibold text-gray-900">{title}</span>
          {desc && <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function SaveBtn({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0">
      {loading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
    </button>
  );
}

function SelectField({ label, value, options, onChange, desc }: { label: string; value: string; options: string[]; onChange: (v: string) => void; desc?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
        {options.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
      </select>
      {desc && <p className="text-xs text-gray-400 mt-1">{desc}</p>}
    </div>
  );
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
    </div>
  );
}

function KeyField({ label, hasKey, show, onToggle, onChange }: { label: string; hasKey?: boolean; show?: boolean; onToggle: () => void; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
        {label}
        {hasKey && <span className="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">(configured)</span>}
      </label>
      <div className="flex gap-2">
        <input type={show ? 'text' : 'password'} onChange={e => onChange(e.target.value)} placeholder={hasKey ? '........' : 'Enter API key'} className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
        <button onClick={onToggle} className="px-2 text-gray-400 hover:text-gray-600 transition-colors">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <div className="text-sm font-medium text-gray-700">{label}</div>
        <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</div>
      </div>
      <button onClick={() => onChange(!checked)} className={`relative w-10 h-5.5 rounded-full transition-colors shrink-0 ml-4 ${checked ? 'bg-blue-600' : 'bg-gray-300'}`} style={{ width: 40, height: 22 }}>
        <div className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full transition-transform shadow-sm ${checked ? 'translate-x-[18px]' : ''}`} />
      </button>
    </div>
  );
}
