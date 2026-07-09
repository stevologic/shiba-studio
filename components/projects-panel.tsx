'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderKanban, Pencil, Plus, Trash2, Upload, RefreshCw, FolderOpen, Save,
  MessageSquare, Bot, Globe, FileText, Layers, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import type { Project } from '@/lib/project-types';
import { resolveProjectWorkspace } from '@/lib/project-types';
import FolderBrowseModal from '@/components/folder-browse-modal';
import type { Agent } from '@/lib/types';
import InfoHint from '@/components/info-hint';

interface GlobalUploadSummary {
  name: string;
  size: number;
  uploadedAt?: string;
}

interface ProjectsPanelProps {
  agents: Agent[];
  defaultWorkspace: string;
  defaultChatModel: string;
  onProjectSelect?: (projectId: string | null) => void;
  onStatsChange?: () => void;
  /** Create a chat session linked to the project and open it. */
  onOpenProjectChat: (sessionId: string) => void;
  /** Open the agent editor pre-filled from this project. */
  onCreateAgentFromProject: (project: Project) => void;
}

export default function ProjectsPanel({
  agents,
  defaultWorkspace,
  defaultChatModel,
  onProjectSelect,
  onStatsChange,
  onOpenProjectChat,
  onCreateAgentFromProject,
}: ProjectsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const [setupInstructions, setSetupInstructions] = useState('');
  const [setupWorkspace, setSetupWorkspace] = useState('');
  const [setupDefaultAgent, setSetupDefaultAgent] = useState('');

  const [projectsLoaded, setProjectsLoaded] = useState(false);

  // Studio-wide context that is always injected into project chats / agent runs.
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [useAgentsMd, setUseAgentsMd] = useState(true);
  const [globalUploads, setGlobalUploads] = useState<GlobalUploadSummary[]>([]);
  const [globalUploadsPath, setGlobalUploadsPath] = useState('');
  const [globalCtxLoading, setGlobalCtxLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.ok) setProjects(data.projects || []);
      setProjectsLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);

  const loadProject = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.ok && data.project) {
        setSelectedProject(data.project);
        setProjects((prev) => prev.map((p) => (p.id === id ? data.project : p)));
        return data.project as Project;
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const loadGlobalContext = useCallback(async () => {
    setGlobalCtxLoading(true);
    try {
      const [cfgRes, syncRes] = await Promise.all([
        fetch('/api/config').then((r) => r.json()).catch(() => null),
        fetch('/api/workspace/sync').then((r) => r.json()).catch(() => null),
      ]);
      // GET /api/config returns the config object directly (not { ok, config }).
      if (cfgRes && typeof cfgRes === 'object') {
        setGlobalInstructions(String(cfgRes.globalInstructions || ''));
        setUseAgentsMd(cfgRes.useAgentsMd !== false);
      }
      if (syncRes?.ok) {
        setGlobalUploads(
          (syncRes.uploads || []).map((u: { name: string; size: number; uploadedAt?: string }) => ({
            name: u.name,
            size: u.size,
            uploadedAt: u.uploadedAt,
          })),
        );
        setGlobalUploadsPath(String(syncRes.uploadsPath || ''));
      }
    } finally {
      setGlobalCtxLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadGlobalContext();
  }, [loadProjects, loadGlobalContext]);

  useEffect(() => {
    onProjectSelect?.(selectedId);
    if (selectedId) void loadProject(selectedId);
    else setSelectedProject(null);
  }, [selectedId, loadProject, onProjectSelect]);

  useEffect(() => {
    if (!selectedProject) return;
    setSetupInstructions(selectedProject.instructions || '');
    setSetupWorkspace(selectedProject.workspacePath || '');
    setSetupDefaultAgent(selectedProject.defaultAgentId || '');
  }, [selectedProject?.id, selectedProject?.instructions, selectedProject?.workspacePath, selectedProject?.defaultAgentId]);

  const effectiveWorkspace = selectedProject
    ? resolveProjectWorkspace(selectedProject, defaultWorkspace)
    : defaultWorkspace;

  async function createProject() {
    const name = await promptDialog({
      title: 'New project',
      placeholder: 'Project name',
      defaultValue: 'New Project',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: name.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await loadProjects();
      setSelectedId(data.project.id);
      toast.success(`Project "${data.project.name}" created`);
      onStatsChange?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project');
    }
    setLoading(false);
  }

  async function saveProjectSetup(silent = false): Promise<Project | null> {
    if (!selectedId) return null;
    setSavingSetup(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: selectedId,
          instructions: setupInstructions,
          workspacePath: setupWorkspace,
          defaultAgentId: setupDefaultAgent,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSelectedProject(data.project);
      await loadProjects();
      if (!silent) toast.success('Project setup saved');
      return data.project as Project;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
      return null;
    } finally {
      setSavingSetup(false);
    }
  }

  async function openProjectChat() {
    if (!selectedProject) return;
    setOpeningChat(true);
    try {
      // Persist setup first so the chat sees current instructions/workspace.
      await saveProjectSetup(true);
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          defaults: {
            title: selectedProject.name,
            chatModel: defaultChatModel,
            projectId: selectedProject.id,
            chatTarget: selectedProject.defaultAgentId || setupDefaultAgent || 'grok',
          },
        }),
      });
      const data = await res.json();
      if (!data.ok || !data.session) throw new Error(data.error || 'Could not open chat');
      toast.success('Project chat ready');
      onOpenProjectChat(data.session.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not open project chat');
    } finally {
      setOpeningChat(false);
    }
  }

  async function createAgentFromProject() {
    if (!selectedProject) return;
    const saved = await saveProjectSetup(true);
    onCreateAgentFromProject(saved || selectedProject);
  }

  async function renameProject(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const current = projects.find((p) => p.id === id);
    const name = await promptDialog({
      title: 'Rename project',
      defaultValue: current?.name || '',
      placeholder: 'Project name',
      confirmLabel: 'Rename',
    });
    if (!name || name === current?.name) return;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id, name }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.project && selectedId === id) setSelectedProject(data.project);
      await loadProjects();
      toast.success('Project renamed');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  async function deleteProject(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const current = projects.find((p) => p.id === id);
    const ok = await confirmDialog({
      title: `Delete ${current?.name || 'this project'}?`,
      message: 'All project files are permanently deleted. Linked chats keep their history but lose the project link.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedProject(null);
      }
      await loadProjects();
      toast.success('Project deleted');
      onStatsChange?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function deleteProjectFile(fileId: string, fileName: string) {
    if (!selectedId) return;
    const ok = await confirmDialog({
      title: `Remove "${fileName}"?`,
      message: 'The file is removed from this project and its chat context.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteFile', id: selectedId, fileId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.project) setSelectedProject(data.project);
      await loadProjects();
      toast.success(`Removed ${fileName}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function uploadToProject(files: FileList | File[]) {
    if (!selectedId) return;
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('projectId', selectedId);
      list.forEach((f) => fd.append('files', f));
      const res = await fetch('/api/projects/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.errors?.length) toast.error(data.errors.join('; '));
      toast.success(`Added ${data.saved?.length || 0} file(s) to project`);
      if (data.project) setSelectedProject(data.project);
      await loadProjects();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    }
    setUploading(false);
  }

  const defaultAgentName = agents.find((a) => a.id === (setupDefaultAgent || selectedProject?.defaultAgentId))?.name;

  return (
    <div className="projects-page page-content">
      <div className="page-title">
        Projects
        <InfoHint text="Each project packages a workspace folder, instructions, and reference files you can open in chat or hand to a new agent." />
      </div>
      <div className="page-subtitle">
        Bundle a workspace, instructions, and reference files — then open a chat or spin up an agent from them.
      </div>

      <div className="projects-page-body flex flex-col lg:flex-row gap-4 min-h-[calc(100vh-220px)]">
      <div className="grok-card p-4 w-full lg:w-64 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium text-sm text-muted">All projects</div>
          <button type="button" onClick={createProject} disabled={loading} className="grok-btn grok-btn-ghost text-xs p-1" title="New project">
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto space-y-1 min-h-[120px]">
          {!projectsLoaded && (
            <div className="data-loading-row py-1"><span className="data-spinner" /> Loading projects…</div>
          )}
          {projectsLoaded && projects.length === 0 && <div className="text-xs text-dim">No projects yet.</div>}
          {projects.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedId(p.id);
                }
              }}
              className={`projects-list-item projects-list-item-row w-full text-left ${selectedId === p.id ? 'active' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{p.name}</div>
                <div className="text-[10px] text-dim mt-0.5">
                  {p.files.length} file{p.files.length === 1 ? '' : 's'}
                  {p.workspacePath ? ' · workspace set' : ''}
                </div>
              </div>
              <span className="projects-list-item-actions">
                <button
                  type="button"
                  className="projects-list-action"
                  onClick={(e) => void renameProject(p.id, e)}
                  title="Rename project"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="projects-list-action projects-list-action-danger"
                  onClick={(e) => void deleteProject(p.id, e)}
                  title="Delete project"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {!selectedProject ? (
          <div className="grok-card p-8 text-center text-dim flex-1 flex items-center justify-center">
            <div>
              <FolderKanban size={40} className="mx-auto mb-3 opacity-30" />
              <div className="text-sm max-w-md mx-auto leading-relaxed">
                Select a project or create one. Each project packages a workspace folder, instructions, and reference files you can open in chat or hand to a new agent.
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Header + primary actions */}
            <div className="grok-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-lg tracking-tight">{selectedProject.name}</div>
                  {selectedProject.description && (
                    <div className="text-xs text-dim mt-1">{selectedProject.description}</div>
                  )}
                  <div className="text-[11px] text-dim mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    <span>{selectedProject.files.length} reference file{selectedProject.files.length === 1 ? '' : 's'}</span>
                    {defaultAgentName && <span>Default agent: {defaultAgentName}</span>}
                    <span className="font-mono truncate max-w-[280px]" title={effectiveWorkspace}>
                      {effectiveWorkspace}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => loadProject(selectedProject.id)} className="grok-btn grok-btn-ghost text-xs" title="Refresh">
                    <RefreshCw size={14} />
                  </button>
                  <button type="button" onClick={() => deleteProject(selectedProject.id)} className="grok-btn grok-btn-ghost text-xs text-error" title="Delete project">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="project-action-row mt-4">
                <button
                  type="button"
                  onClick={() => void openProjectChat()}
                  disabled={openingChat}
                  className="project-action-card project-action-card-primary"
                >
                  <span className="project-action-icon">
                    <MessageSquare size={18} />
                  </span>
                  <span className="project-action-copy">
                    <span className="project-action-title">
                      {openingChat ? 'Opening chat…' : 'Open project chat'}
                    </span>
                    <span className="project-action-sub">
                      Start a Grok conversation with this project&apos;s instructions, files, and workspace already loaded as context.
                    </span>
                  </span>
                  <Sparkles size={14} className="project-action-spark" />
                </button>
                <button
                  type="button"
                  onClick={() => void createAgentFromProject()}
                  className="project-action-card project-action-card-secondary"
                >
                  <span className="project-action-icon">
                    <Bot size={18} />
                  </span>
                  <span className="project-action-copy">
                    <span className="project-action-title">Build an agent from this project</span>
                    <span className="project-action-sub">
                      Create a new agent pre-filled with this workspace and project instructions — ready to schedule or run.
                    </span>
                  </span>
                </button>
              </div>
            </div>

            {/* Global context */}
            <div className="grok-card p-4">
              <div className="flex items-center gap-2 mb-1">
                <Globe size={16} className="text-accent" />
                <div className="font-semibold text-sm">Global context always included</div>
                <InfoHint text="Studio-wide materials are injected into every project chat and agent run, alongside this project's own setup. Manage them under Workspace (uploads) and Settings (instructions)." />
              </div>
              <div className="text-[11px] text-dim mb-3 leading-relaxed">
                These ride along automatically with any chat or agent you launch from this project — you do not need to re-attach them.
              </div>

              {globalCtxLoading ? (
                <div className="data-loading-row py-2"><span className="data-spinner" /> Loading global context…</div>
              ) : (
                <div className="project-global-grid">
                  <div className="project-global-tile">
                    <div className="project-global-tile-head">
                      <FileText size={14} />
                      <span>Studio instructions</span>
                    </div>
                    {globalInstructions.trim() ? (
                      <pre className="project-global-snippet">{globalInstructions.trim().slice(0, 480)}{globalInstructions.trim().length > 480 ? '…' : ''}</pre>
                    ) : (
                      <div className="text-xs text-dim leading-relaxed">
                        No global instructions set. Add them in Settings so every chat and agent shares the same house rules.
                      </div>
                    )}
                    <div className="text-[10px] text-dim mt-2">
                      {useAgentsMd ? 'AGENTS.md from the repo is also applied when present.' : 'AGENTS.md injection is disabled in Settings.'}
                    </div>
                  </div>

                  <div className="project-global-tile">
                    <div className="project-global-tile-head">
                      <Layers size={14} />
                      <span>Global uploads</span>
                      <span className="project-global-count">{globalUploads.length}</span>
                    </div>
                    {globalUploads.length === 0 ? (
                      <div className="text-xs text-dim leading-relaxed">
                        No shared files yet. Drop docs into Workspace → Global uploads and they become available to all projects, chats, and agents.
                      </div>
                    ) : (
                      <ul className="project-global-file-list">
                        {globalUploads.slice(0, 8).map((f) => (
                          <li key={f.name}>
                            <span className="font-mono truncate">{f.name}</span>
                            <span className="text-dim shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
                          </li>
                        ))}
                        {globalUploads.length > 8 && (
                          <li className="text-dim">+{globalUploads.length - 8} more in Workspace</li>
                        )}
                      </ul>
                    )}
                    {globalUploadsPath && (
                      <div className="text-[10px] text-dim mt-2 font-mono truncate" title={globalUploadsPath}>
                        {globalUploadsPath}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Project setup */}
            <div className="grok-card p-4">
              <div className="font-semibold text-sm mb-3">Project setup</div>
              <div className="space-y-3">
                <div>
                  <div className="grok-label text-xs">Instructions</div>
                  <textarea
                    className="grok-input text-xs min-h-[80px] mt-1"
                    placeholder="What should this project accomplish? Architecture, constraints, priorities…"
                    value={setupInstructions}
                    onChange={(e) => setSetupInstructions(e.target.value)}
                  />
                </div>
                <div>
                  <div className="grok-label text-xs">Workspace folder</div>
                  <div className="flex gap-2 mt-1">
                    <input
                      className="grok-input flex-1 font-mono text-xs"
                      placeholder={defaultWorkspace}
                      value={setupWorkspace}
                      onChange={(e) => setSetupWorkspace(e.target.value)}
                    />
                    <button type="button" onClick={() => setBrowseOpen(true)} className="grok-btn grok-btn-secondary text-xs shrink-0">
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                  <div className="text-[10px] text-dim mt-1">
                    Effective path: <span className="font-mono">{effectiveWorkspace}</span>
                  </div>
                </div>
                <div>
                  <div className="grok-label text-xs">Default agent (optional)</div>
                  <select
                    className="grok-select w-full text-xs mt-1"
                    value={setupDefaultAgent}
                    onChange={(e) => setSetupDefaultAgent(e.target.value)}
                  >
                    <option value="">Grok (default) — or pick an agent for project chats</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <button type="button" onClick={() => void saveProjectSetup(false)} disabled={savingSetup} className="grok-btn grok-btn-primary text-xs">
                  <Save size={14} /> Save setup
                </button>
              </div>
            </div>

            {/* Project files */}
            <div className="grok-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="font-semibold text-sm flex items-center gap-2">
                  <Upload size={15} />
                  Project reference files
                </div>
                <label className="grok-btn grok-btn-secondary text-xs cursor-pointer">
                  <Upload size={14} /> Add files
                  <input type="file" multiple className="hidden" onChange={(e) => e.target.files && uploadToProject(e.target.files)} />
                </label>
              </div>
              <div className="text-[11px] text-dim mb-3 leading-relaxed">
                Files here are project-scoped context (specs, designs, samples). Global uploads above apply to the whole studio.
              </div>

              <div
                className={`workspace-dropzone py-6 ${dragOver ? 'workspace-dropzone-active' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files?.length) uploadToProject(e.dataTransfer.files);
                }}
              >
                <Upload size={22} className="mx-auto opacity-40 mb-1" />
                <div className="text-xs">{uploading ? 'Uploading…' : 'Drop reference files into this project'}</div>
              </div>

              {selectedProject.files.length > 0 && (
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {selectedProject.files.map((f) => (
                    <div key={f.id} className="workspace-upload-item">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-mono text-xs truncate min-w-0 flex-1">{f.name}</div>
                        <button type="button" className="workspace-upload-delete grok-btn grok-btn-ghost text-error p-0.5 shrink-0" onClick={() => deleteProjectFile(f.id, f.name)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="text-[10px] text-dim mt-1">{(f.size / 1024).toFixed(1)} KB</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      </div>

      <FolderBrowseModal
        open={browseOpen}
        title="Select project workspace folder"
        initialPath={setupWorkspace || defaultWorkspace}
        onClose={() => setBrowseOpen(false)}
        onSelect={(path) => {
          setSetupWorkspace(path);
          setBrowseOpen(false);
        }}
      />
    </div>
  );
}
