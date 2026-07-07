'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Pencil, Plus, Trash2, Upload, RefreshCw, FolderOpen, Play, Save, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import type { Project } from '@/lib/project-types';
import { resolveProjectWorkspace } from '@/lib/project-types';
import GrokChatPanel from '@/components/grok-chat-panel';
import FolderBrowseModal from '@/components/folder-browse-modal';
import PreviewRail from '@/components/preview-rail';
import WorkspaceDiffPanel from '@/components/workspace-diff-panel';
import type { GrokModel, Agent, AgentRun } from '@/lib/types';
import type { TraceStep } from '@/lib/types';

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local' };

interface ProjectsPanelProps {
  chatModel: string;
  onChatModelChange: (model: string) => void;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  agents: Agent[];
  defaultWorkspace: string;
  activeRun: AgentRun | null;
  liveTrace: TraceStep[];
  previewSelectedIdx: number | null;
  onPreviewSelect: (idx: number) => void;
  onBuildWithAgent: (project: Project, agentId: string, prompt: string) => Promise<void>;
  onProjectSelect?: (projectId: string | null) => void;
  /** Notifies the shell that the project count changed (nav badges are load-once). */
  onStatsChange?: () => void;
}

export default function ProjectsPanel({
  chatModel,
  onChatModelChange,
  availableModels,
  modelsLoading,
  modelsError,
  onRefreshModels,
  agents,
  defaultWorkspace,
  activeRun,
  liveTrace,
  previewSelectedIdx,
  onPreviewSelect,
  onBuildWithAgent,
  onProjectSelect,
  onStatsChange,
}: ProjectsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [buildPrompt, setBuildPrompt] = useState('Implement the project goals in the workspace. Start by exploring the repo, then make focused changes.');
  const [buildAgentId, setBuildAgentId] = useState('');
  const [building, setBuilding] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const [setupInstructions, setSetupInstructions] = useState('');
  const [setupWorkspace, setSetupWorkspace] = useState('');
  const [setupDefaultAgent, setSetupDefaultAgent] = useState('');

  const [projectsLoaded, setProjectsLoaded] = useState(false);

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

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
    setBuildAgentId(selectedProject.defaultAgentId || agents[0]?.id || '');
  }, [selectedProject?.id, selectedProject?.instructions, selectedProject?.workspacePath, selectedProject?.defaultAgentId, agents]);

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

  async function runProjectBuild() {
    if (!selectedProject || !selectedId) return;
    const agentId = buildAgentId || setupDefaultAgent || agents[0]?.id;
    if (!agentId) {
      toast.error('Create an agent first, or pick a default agent in project setup.');
      return;
    }
    const prompt = buildPrompt.trim();
    if (!prompt) {
      toast.error('Enter build instructions.');
      return;
    }
    setBuilding(true);
    try {
      const saved = await saveProjectSetup(true);
      if (!saved) return;
      await onBuildWithAgent(saved, agentId, prompt);
    } finally {
      setBuilding(false);
    }
  }

  const projectActiveRun = activeRun?.projectId === selectedId ? activeRun : null;
  const projectLiveTrace = activeRun?.projectId === selectedId ? liveTrace : [];

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
      message: 'All project files and chat history are permanently deleted.',
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

  return (
    <div className="projects-page flex flex-col lg:flex-row gap-4 min-h-[calc(100vh-120px)]">
      <div className="grok-card p-4 w-full lg:w-64 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold flex items-center gap-2">
            <FolderKanban size={16} />
            Projects
          </div>
          <button type="button" onClick={createProject} disabled={loading} className="grok-btn grok-btn-ghost text-xs p-1" title="New project">
            <Plus size={16} />
          </button>
        </div>
        <div className="text-[10px] text-dim mb-3">Configure workspace + agent, then chat or build.</div>
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
                  {p.files.length} file{p.files.length === 1 ? '' : 's'} · {p.messages.length} msg{p.messages.length === 1 ? '' : 's'}
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
              <div className="text-sm">Select a project or create one to configure workspace, instructions, and autonomous builds.</div>
            </div>
          </div>
        ) : (
          <>
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
                    Build runs use: <span className="font-mono">{effectiveWorkspace}</span>
                  </div>
                </div>
                <div>
                  <div className="grok-label text-xs">Default agent</div>
                  <select
                    className="grok-select w-full text-xs mt-1"
                    value={setupDefaultAgent}
                    onChange={(e) => setSetupDefaultAgent(e.target.value)}
                  >
                    <option value="">— Select agent —</option>
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

            <div className="grok-card p-4">
              <div className="font-semibold text-sm mb-3 flex items-center gap-2">
                <Play size={16} /> Build with agent
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                <select
                  className="grok-select text-xs min-w-[160px]"
                  value={buildAgentId}
                  onChange={(e) => setBuildAgentId(e.target.value)}
                >
                  {agents.length === 0 && <option value="">No agents — create one in Agents tab</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <textarea
                className="grok-input text-xs min-h-[72px] mb-2"
                value={buildPrompt}
                onChange={(e) => setBuildPrompt(e.target.value)}
                placeholder="What should the agent build or change?"
              />
              <button
                type="button"
                onClick={() => void runProjectBuild()}
                disabled={building || agents.length === 0}
                className="grok-btn grok-btn-primary text-xs"
              >
                <Play size={14} /> {building ? 'Building…' : 'Run autonomous build'}
              </button>
            </div>

            {projectLiveTrace.length > 0 && selectedId && (
              <div className="grok-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Terminal size={16} />
                  <div className="font-medium text-sm">Build trace</div>
                  {projectActiveRun && <span className="badge">{projectActiveRun.status}</span>}
                </div>
                <div className="font-mono text-xs overflow-auto max-h-[280px] bg-black/40 p-3 rounded">
                  {projectLiveTrace.map((step, idx) => (
                    <div key={step.id || idx} className={`trace-step mb-3 ${step.type}`}>
                      <div className="text-[10px] text-dim">{step.ts ? new Date(step.ts).toLocaleTimeString() : ''} — {step.type.toUpperCase()}</div>
                      <div className="mt-0.5">{step.content}</div>
                    </div>
                  ))}
                </div>
                <PreviewRail trace={projectLiveTrace} selectedIdx={previewSelectedIdx} onSelect={onPreviewSelect} />
                {projectActiveRun?.status !== 'running' && (
                  <WorkspaceDiffPanel workspaceDir={projectActiveRun?.workspaceSnapshot} runId={projectActiveRun?.id} />
                )}
              </div>
            )}

            <div className="grok-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-lg">{selectedProject.name}</div>
                  {selectedProject.description && (
                    <div className="text-xs text-dim mt-1">{selectedProject.description}</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => loadProject(selectedProject.id)} className="grok-btn grok-btn-ghost text-xs">
                    <RefreshCw size={14} />
                  </button>
                  <button type="button" onClick={() => deleteProject(selectedProject.id)} className="grok-btn grok-btn-ghost text-xs text-error">
                    <Trash2 size={14} />
                  </button>
                  <label className="grok-btn grok-btn-secondary text-xs cursor-pointer">
                    <Upload size={14} /> Add files
                    <input type="file" multiple className="hidden" onChange={(e) => e.target.files && uploadToProject(e.target.files)} />
                  </label>
                </div>
              </div>

              <div
                className={`workspace-dropzone mt-3 py-6 ${dragOver ? 'workspace-dropzone-active' : ''}`}
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

            <div className="flex-1 min-h-0">
              <GrokChatPanel
                chatModel={chatModel}
                onChatModelChange={(m) => onChatModelChange(m as GrokModel)}
                availableModels={availableModels}
                modelsLoading={modelsLoading}
                modelsError={modelsError}
                onRefreshModels={onRefreshModels}
                agents={agents}
                project={selectedProject}
                onProjectUpdated={() => loadProject(selectedProject.id)}
              />
            </div>
          </>
        )}
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