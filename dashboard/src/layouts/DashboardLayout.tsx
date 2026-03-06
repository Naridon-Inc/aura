import { useState, useCallback, useRef, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import type { ProjectEntry } from '../lib/types';
import {
  LayoutDashboard, GitPullRequest, Clock, BarChart3,
  Map, RotateCcw, Settings, Search, Bell, HelpCircle, Menu,
  GitBranch, Folder, Wand2, Music, ChevronDown, Check, FolderOpen, GitMerge
} from 'lucide-react';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Overview', end: true },
  { to: '/reviews', icon: GitPullRequest, label: 'Reviews' },
  { to: '/checkpoints', icon: Clock, label: 'Checkpoints' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/plans', icon: Map, label: 'Plans' },
  { to: '/rewind', icon: RotateCcw, label: 'Rewind' },
  { to: '/prs', icon: GitMerge, label: 'Pull Requests' },
  { to: '/orchestrate', icon: Wand2, label: 'Orchestrate' },
  { to: '/symphony', icon: Music, label: 'Symphony' },
];

const bottomItems = [
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname);

  const { data: status, refetch: refetchStatus } = useApi(
    useCallback(() => api.getStatus(), []),
    [],
    { pollInterval: 15000 }
  );

  const { data: projectsData, refetch: refetchProjects } = useApi(
    useCallback(() => api.getProjects(), []),
    [],
    { pollInterval: 30000 }
  );

  const s = status?.data;
  const projects = projectsData?.projects || [];
  const activeProject = projectsData?.active || '';
  const activeProjectName = projects.find(p => p.path === activeProject)?.name || 'No project';

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSwitchProject = async (project: ProjectEntry) => {
    try {
      await api.switchProject(project.path);
      setProjectDropdownOpen(false);
      refetchProjects();
      refetchStatus();
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex h-screen bg-white text-gray-900">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/20 z-40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar — Graphite icon rail */}
      <aside className={`
        fixed md:relative z-50 h-full bg-white border-r border-gray-200
        flex flex-col w-[52px] shrink-0
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Logo */}
        <div className="flex items-center justify-center h-[52px] border-b border-gray-100">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center">
            <span className="text-white text-sm font-bold">A</span>
          </div>
        </div>

        {/* Main nav */}
        <nav className="flex-1 w-full flex flex-col items-center py-3 gap-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setMobileOpen(false)}
              title={item.label}
              className={({ isActive }) => `
                relative group w-10 h-10 flex items-center justify-center rounded-lg transition-colors
                ${isActive
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-400 hover:bg-gray-50 hover:text-gray-600'}
              `}
            >
              <item.icon size={20} strokeWidth={1.75} />
              <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-gray-900 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity shadow-lg">
                {item.label}
              </span>
            </NavLink>
          ))}
        </nav>

        {/* Bottom icons */}
        <div className="w-full flex flex-col items-center py-3 gap-1 border-t border-gray-100">
          <button title="Search" className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors group relative">
            <Search size={20} strokeWidth={1.75} />
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-gray-900 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity shadow-lg">Search</span>
          </button>
          <button title="Help" className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors group relative">
            <HelpCircle size={20} strokeWidth={1.75} />
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-gray-900 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity shadow-lg">Help</span>
          </button>
          {bottomItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={({ isActive }) => `
                relative group w-10 h-10 flex items-center justify-center rounded-lg transition-colors
                ${isActive
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-400 hover:bg-gray-50 hover:text-gray-600'}
              `}
            >
              <item.icon size={20} strokeWidth={1.75} />
              <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-gray-900 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity shadow-lg">
                {item.label}
              </span>
            </NavLink>
          ))}
          {/* Avatar */}
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center mt-1 mb-1 cursor-pointer hover:ring-2 hover:ring-gray-300 transition-all">
            <span className="text-xs font-medium text-gray-500">U</span>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-[52px] flex items-center justify-between px-6 border-b border-gray-200 bg-white shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileOpen(true)} className="md:hidden p-1.5 rounded hover:bg-gray-100">
              <Menu size={20} />
            </button>

            {/* Project switcher */}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-all"
              >
                <FolderOpen size={15} strokeWidth={1.75} className="text-violet-500" />
                <span className="text-sm font-semibold text-gray-900 max-w-[140px] truncate">{activeProjectName}</span>
                <ChevronDown size={14} className={`text-gray-400 transition-transform ${projectDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {projectDropdownOpen && projects.length > 0 && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 max-h-80 overflow-auto">
                  <div className="px-3 py-2 text-[11px] font-medium text-gray-400 uppercase tracking-wider">Projects</div>
                  {projects.map(project => (
                    <button
                      key={project.path}
                      onClick={() => handleSwitchProject(project)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50 transition-colors ${
                        project.path === activeProject ? 'bg-violet-50' : ''
                      }`}
                    >
                      <Folder size={14} className={project.path === activeProject ? 'text-violet-500' : 'text-gray-400'} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${project.path === activeProject ? 'text-violet-700' : 'text-gray-700'}`}>
                          {project.name}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{project.path}</div>
                      </div>
                      {project.path === activeProject && (
                        <Check size={14} className="text-violet-500 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="w-px h-5 bg-gray-200" />
            <h1 className="text-base font-semibold text-gray-900">{pageTitle}</h1>
          </div>

          {/* Repo + branch info */}
          <div className="flex items-center gap-3">
            {s && (
              <div className="flex items-center gap-2.5 text-sm">
                {s.repo_name && (
                  <div className="flex items-center gap-1.5 text-gray-500">
                    <Folder size={14} strokeWidth={1.75} />
                    <span className="font-mono text-xs">{s.repo_name}</span>
                  </div>
                )}
                <div className="w-px h-4 bg-gray-200" />
                <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 border border-gray-200 rounded-md">
                  <GitBranch size={14} strokeWidth={1.75} className="text-blue-500" />
                  <span className="font-mono text-xs text-gray-700">{s.branch}</span>
                </div>
                <span className="text-xs text-gray-400 font-mono hidden sm:inline" title={s.last_commit.message}>
                  {s.last_commit.id.slice(0, 7)}
                </span>
              </div>
            )}
            <button className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors">
              <Bell size={18} strokeWidth={1.75} />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-gray-50/40">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function getPageTitle(path: string): string {
  if (path === '/' || path === '') return 'Overview';
  const segment = path.split('/').filter(Boolean).pop() || '';
  if (path.includes('/reviews/') && path.split('/').length > 2) return 'Review';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}
