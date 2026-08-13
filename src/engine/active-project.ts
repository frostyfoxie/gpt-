import { ProjectsRepo } from '../lib/supabase/projects';
import { setVfsSynchronizer, type VFSSynchronizer } from '../lib/supabase/vfs-sync';
import { CommitManager } from './commits';

export interface ActiveProject {
  id: string;
  name: string;
}

let activeProject: ActiveProject | null = null;
let activeVfsSync: VFSSynchronizer | null = null;
let activeCommitManager: CommitManager | null = null;
const projectChangeListeners = new Set<(project: ActiveProject) => void | Promise<void>>();
const ACTIVE_PROJECT_STORAGE_KEY = 'theta.activeProjectId';

export function getActiveProject(): ActiveProject | null {
  return activeProject ? { ...activeProject } : null;
}

export function getActiveProjectId(): string | null {
  return activeProject?.id ?? null;
}

export function getActiveVfsSync(): VFSSynchronizer | null {
  return activeVfsSync;
}

export function getActiveCommitManager(): CommitManager | null {
  return activeCommitManager;
}

export function onActiveProjectChanged(listener: (project: ActiveProject) => void | Promise<void>): () => void {
  projectChangeListeners.add(listener);
  return () => projectChangeListeners.delete(listener);
}

export async function setActiveProject(id: string, name: string): Promise<void> {
  if (!id) throw new Error('Active project id is required.');

  const previous = activeProject;
  if (previous && previous.id !== id) {
    const flush = (window as any).flushWorkspaceAutosaveForProject;
    if (typeof flush === 'function') await flush(previous.id);
    const cancel = (window as any).cancelWorkspaceAutosave;
    if (typeof cancel === 'function') cancel();
  }

  activeProject = { id, name };
  try { localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id); } catch {}
  activeVfsSync = setVfsSynchronizer(id);
  activeCommitManager = new CommitManager(id);

  (window as any).vfsSync = activeVfsSync;
  (window as any).CommitManager = activeCommitManager;
  (window as any).activeProject = activeProject;
  if ((window as any).rootProject) {
    (window as any).rootProject.name = name;
  }
  const label = document.getElementById('activeProjectName');
  if (label) label.textContent = name;

  await ProjectsRepo.touchProject(id);

  // Notify chat/history adapters only after the active project and its VFS are fully installed.
  // This fixes the startup race where adapters were constructed before a project was selected.
  window.dispatchEvent(new CustomEvent('theta:active-project-changed', { detail: { ...activeProject! } }));
  await Promise.allSettled([...projectChangeListeners].map((listener) => listener({ ...activeProject! })));

  if (typeof (window as any).restoreWorkspaceOnBoot === 'function') {
    await (window as any).restoreWorkspaceOnBoot();
  }
  (window as any).renderFileTree?.();
  (window as any).renderTabBar?.();
}

export function getRememberedActiveProjectId(): string | null {
  try { return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY); } catch { return null; }
}

export function clearActiveProject(): void {
  activeProject = null;
  try { localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY); } catch {}
  activeVfsSync?.dispose();
  activeVfsSync = null;
  activeCommitManager = null;
  (window as any).vfsSync = null;
  (window as any).CommitManager = null;
  (window as any).activeProject = null;
  window.dispatchEvent(new CustomEvent('theta:active-project-cleared'));
}
