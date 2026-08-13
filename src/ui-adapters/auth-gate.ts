import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase/vfs-sync';
import { signInWithGoogle, signInWithGithub, signOut, getSession, onAuthStateChange } from '../lib/supabase/auth';
import { ProjectsRepo, type ProjectRecord, listRecentProjectCommits } from '../lib/supabase/projects';
import { clearActiveProject, getRememberedActiveProjectId, setActiveProject } from '../engine/active-project';

function formatProjectDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export class AuthGate {
  private gate!: HTMLElement;
  private dashboard!: HTMLElement;
  private shell!: HTMLElement;
  private userChip!: HTMLElement;
  private userAvatar!: HTMLImageElement;
  private userInitial!: HTMLElement;
  private userLabel!: HTMLElement;
  private dashboardList!: HTMLElement;
  private dashboardTitle!: HTMLElement;
  private dashboardSubtitle!: HTMLElement;
  private renderingSession = false;
  private currentView: 'dashboard' | 'workspace' = 'dashboard';

  constructor() {
    if (typeof window === 'undefined') return;
    this.gate = document.getElementById('authGate')!;
    this.dashboard = document.getElementById('projectsDashboard')!;
    this.shell = document.getElementById('workspaceShell')!;
    this.userChip = document.getElementById('userMenuChip')!;
    this.userAvatar = document.getElementById('userMenuAvatar') as HTMLImageElement;
    this.userInitial = document.getElementById('userMenuInitial')!;
    this.userLabel = document.getElementById('userMenuLabel')!;
    this.dashboardList = document.getElementById('projectsDashboardList')!;
    this.dashboardTitle = document.getElementById('projectsDashboardTitle')!;
    this.dashboardSubtitle = document.getElementById('projectsDashboardSubtitle')!;

    if (!this.gate || !this.dashboard || !this.shell) {
      console.error('[Theta Suite] Auth/project gate markup is missing.');
      return;
    }

    this.bindEvents();
    onAuthStateChange((_event, session) => void this.render(session));
    void getSession().then(({ data: { session } }) => void this.render(session));
  }

  private bindEvents(): void {
    document.getElementById('authGoogleBtn')?.addEventListener('click', () => void this.handleOAuthClick(signInWithGoogle, 'Google'));
    document.getElementById('authGithubBtn')?.addEventListener('click', () => void this.handleOAuthClick(signInWithGithub, 'GitHub'));
    document.getElementById('userMenuSignOutBtn')?.addEventListener('click', () => void this.handleSignOut());
    document.getElementById('newProjectBtn')?.addEventListener('click', () => void this.handleCreateProject());
    document.getElementById('dashboardNewProjectBtn')?.addEventListener('click', () => void this.handleCreateProject());
    document.getElementById('projectsBackBtn')?.addEventListener('click', () => void this.showDashboard());
  }

  private async handleSignOut(): Promise<void> {
    clearActiveProject();
    try { localStorage.removeItem('theta.activeProjectId'); } catch {}
    await signOut();
  }

  private async handleOAuthClick(fn: () => ReturnType<typeof signInWithGoogle>, provider: string): Promise<void> {
    const { error } = await fn();
    if (error && typeof (window as any).showToast === 'function') {
      (window as any).showToast(`${provider} sign-in failed: ${error.message}`, 'error');
    }
  }

  private async render(session: Session | null): Promise<void> {
    if (this.renderingSession) return;
    this.renderingSession = true;
    try {
      if (!session) {
        clearActiveProject();
        this.currentView = 'dashboard';
        this.dashboard.classList.add('hidden');
        this.shell.classList.add('hidden');
        this.gate.classList.remove('hidden');
        return;
      }

      this.gate.classList.add('hidden');
      await this.hydrateUserChip(session);
      const projects = await ProjectsRepo.listProjects();
      const activeId = (window as any).activeProject?.id as string | undefined;
      const rememberedId = getRememberedActiveProjectId();
      const activeProject = activeId ? projects.find((project) => project.id === activeId) : null;
      const remembered = rememberedId ? projects.find((project) => project.id === rememberedId) : null;

      if (this.currentView === 'workspace' && activeProject) {
        this.dashboard.classList.add('hidden');
        this.shell.classList.remove('hidden');
        return;
      }

      if (!activeProject && remembered) {
        await this.openProject(remembered);
        return;
      }

      this.currentView = 'dashboard';
      this.shell.classList.add('hidden');
      this.dashboard.classList.remove('hidden');
      await this.renderProjects();
    } finally {
      this.renderingSession = false;
    }
  }

  private async hydrateUserChip(session: Session): Promise<void> {
    const authUser = session.user;
    const metaName = (authUser.user_metadata?.full_name || authUser.user_metadata?.name) as string | undefined;
    const metaAvatar = authUser.user_metadata?.avatar_url as string | undefined;
    let displayName = metaName || authUser.email || 'Signed in';
    let avatarUrl = metaAvatar;

    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name, avatar_url, email')
      .eq('id', authUser.id)
      .maybeSingle();

    if (profile) {
      displayName = profile.display_name || profile.email || displayName;
      avatarUrl = profile.avatar_url || avatarUrl;
    }

    this.userLabel.textContent = displayName;
    this.userChip.title = displayName;
    if (avatarUrl) {
      this.userAvatar.src = avatarUrl;
      this.userAvatar.classList.remove('hidden');
      this.userInitial.classList.add('hidden');
    } else {
      this.userAvatar.classList.add('hidden');
      this.userInitial.classList.remove('hidden');
      this.userInitial.textContent = displayName.slice(0, 2).toUpperCase();
    }
  }

  private async renderProjects(): Promise<void> {
    try {
      const projects = await ProjectsRepo.listProjects();
      this.dashboardTitle.textContent = projects.length ? 'Your Projects' : 'Create your first project';
      this.dashboardSubtitle.textContent = projects.length
        ? `${projects.length} project${projects.length === 1 ? '' : 's'} available`
        : 'Projects are private to your signed-in account.';
      this.dashboardList.innerHTML = '';

      if (!projects.length) {
        this.dashboardList.innerHTML = `
          <div class="col-span-full border border-dashed border-theta-border rounded-2xl bg-theta-panel/40 p-10 text-center">
            <div class="mx-auto w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
              <i data-lucide="folder-plus" class="w-5 h-5"></i>
            </div>
            <h3 class="text-sm font-semibold text-theta-text">No projects yet</h3>
            <p class="text-xs text-theta-muted mt-1 mb-4">Create a project to open the Theta workspace.</p>
            <button id="emptyNewProjectBtn" class="px-4 py-2 rounded-lg bg-theta-accent hover:bg-theta-accentHover text-white text-xs font-medium transition">New Project</button>
          </div>`;
        document.getElementById('emptyNewProjectBtn')?.addEventListener('click', () => void this.handleCreateProject());
      } else {
        for (const project of projects) this.dashboardList.appendChild(this.projectCard(project));
      }
      const activityHost = document.getElementById('recentProjectsActivity');
      if (activityHost) await this.renderRecentActivity(projects, activityHost);
      (window as any).lucide?.createIcons();
    } catch (error: any) {
      this.dashboardList.innerHTML = `<div class="col-span-full text-sm text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded-xl p-4">Failed to load projects: ${this.escapeHtml(error?.message || 'Unknown error')}</div>`;
    }
  }

  private relativeTime(value: string): string {
    const delta = Math.max(0, Date.now() - new Date(value).getTime());
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private async renderRecentActivity(projects: ProjectRecord[], host: HTMLElement): Promise<void> {
    if (!projects.length) { host.innerHTML = ''; return; }
    try {
      const commits = await listRecentProjectCommits(projects, 20);
      host.innerHTML = commits.length ? commits.map((commit) => `
        <div class="flex items-center justify-between gap-3 py-2 border-b border-theta-border/70 last:border-0">
          <div class="min-w-0"><div class="text-xs text-theta-text truncate">${this.escapeHtml(commit.message)}</div><div class="text-[10px] text-theta-muted mt-0.5">${this.escapeHtml(commit.project_name)} · ${commit.kind === 'auto' ? 'auto' : 'manual'}</div></div>
          <span class="text-[10px] text-theta-muted shrink-0">${this.relativeTime(commit.created_at)}</span>
        </div>`).join('') : '<div class="text-xs text-theta-muted py-3">No commits in the last 7 days.</div>';
    } catch (error) {
      console.warn('[Theta] Recent activity unavailable:', error);
      host.innerHTML = '<div class="text-xs text-theta-muted py-3">Recent activity is unavailable right now.</div>';
    }
  }

  private projectCard(project: ProjectRecord): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'text-left bg-theta-panel border border-theta-border rounded-xl p-4 hover:border-indigo-500/50 hover:-translate-y-0.5 transition-all shadow-sm';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <i data-lucide="folder" class="w-4 h-4 text-indigo-400 shrink-0"></i>
            <h3 class="font-semibold text-sm text-theta-text truncate"></h3>
          </div>
          <div class="text-[10px] text-theta-muted mt-2 space-y-0.5">
            <div>Created: <span data-project-created></span></div>
            <div>Last opened: <span data-project-last-opened></span></div>
            <div>Updated: <span data-project-updated></span></div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0"><i data-lucide="arrow-up-right" class="w-4 h-4 text-theta-muted"></i></div>
      </div>`;
    (card.querySelector('h3') as HTMLElement).textContent = project.name;
    (card.querySelector('[data-project-created]') as HTMLElement).textContent = formatProjectDate(project.created_at);
    (card.querySelector('[data-project-last-opened]') as HTMLElement).textContent = formatProjectDate(project.last_opened_at);
    (card.querySelector('[data-project-updated]') as HTMLElement).textContent = formatProjectDate(project.updated_at);
    card.addEventListener('click', () => void this.openProject(project));
    return card;
  }

  private async handleCreateProject(): Promise<void> {
    const input = window.prompt('Project name', 'Untitled Project');
    if (input == null) return;
    try {
      const project = await ProjectsRepo.createProject(input);
      await this.openProject(project);
    } catch (error: any) {
      (window as any).showToast?.(error?.message || 'Could not create project.', 'error');
    }
  }

  private async handleDeleteProject(project: ProjectRecord): Promise<void> {
    if (!window.confirm(`Permanently delete "${project.name}" and all of its files, commits, and history? This cannot be undone.`)) return;
    try {
      await ProjectsRepo.deleteProject(project.id);
      if ((window as any).activeProject?.id === project.id) {
        clearActiveProject();
        this.shell.classList.add('hidden');
        this.dashboard.classList.remove('hidden');
      }
      await this.renderProjects();
      (window as any).showToast?.(`Deleted ${project.name}.`, 'success');
    } catch (error: any) {
      (window as any).showToast?.(error?.message || 'Could not delete project.', 'error');
    }
  }

  private async openProject(project: ProjectRecord): Promise<void> {
    try {
      await setActiveProject(project.id, project.name);
      this.currentView = 'workspace';
      try { localStorage.setItem('theta.activeProjectId', project.id); } catch {}
      this.dashboard.classList.add('hidden');
      this.shell.classList.remove('hidden');
      (window as any).currentProjectName = project.name;
    } catch (error: any) {
      (window as any).showToast?.(error?.message || 'Could not open project.', 'error');
      await this.renderProjects();
    }
  }

  private showDashboard(): void {
    const cancel = (window as any).cancelWorkspaceAutosave;
    if (typeof cancel === 'function') cancel();
    this.shell.classList.add('hidden');
    this.dashboard.classList.remove('hidden');
    try { localStorage.removeItem('theta.activeProjectId'); } catch {}
    void this.renderProjects();
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
  }
}
