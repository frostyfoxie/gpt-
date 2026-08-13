import { supabase } from './vfs-sync';
import { getCurrentUserId } from './auth';

export interface ProjectRecord {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

export class ProjectsRepo {
  static async listProjects(): Promise<ProjectRecord[]> {
    const userId = await getCurrentUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('projects')
      .select('id, user_id, name, created_at, updated_at, last_opened_at')
      .eq('user_id', userId)
      .order('last_opened_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ProjectRecord[];
  }

  static async createProject(name: string): Promise<ProjectRecord> {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('You must be signed in to create a project.');
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Project name cannot be empty.');

    const { data, error } = await supabase
      .from('projects')
      .insert({ user_id: userId, name: cleanName })
      .select('id, user_id, name, created_at, updated_at, last_opened_at')
      .single();
    if (error) throw error;
    return data as ProjectRecord;
  }

  static async deleteProject(id: string): Promise<void> {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw error;
  }

  static async touchProject(id: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('projects')
      .update({ last_opened_at: now, updated_at: now })
      .eq('id', id);
    if (error) throw error;
  }

  /** Autosave activity updates freshness without changing the user's last-opened timestamp. */
  static async touchUpdatedAt(id: string): Promise<void> {
    const { error } = await supabase
      .from('projects')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  static async renameProject(id: string, name: string): Promise<ProjectRecord> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Project name cannot be empty.');
    const { data, error } = await supabase
      .from('projects')
      .update({ name: cleanName })
      .eq('id', id)
      .select('id, user_id, name, created_at, updated_at, last_opened_at')
      .single();
    if (error) throw error;
    return data as ProjectRecord;
  }
}


export interface RecentProjectCommit {
  id: string;
  project_id: string;
  message: string;
  kind: 'manual' | 'auto';
  created_at: string;
  project_name: string;
}

export async function listRecentProjectCommits(projects: ProjectRecord[], limit = 20): Promise<RecentProjectCommit[]> {
  if (!projects.length) return [];
  const ids = projects.map((project) => project.id);
  const { data, error } = await supabase
    .from('commits')
    .select('id, project_id, message, kind, created_at')
    .in('project_id', ids)
    .gt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return (data ?? []).map((commit: any) => ({ ...commit, project_name: names.get(commit.project_id) || 'Unknown project' }));
}

export const projectsRepo = ProjectsRepo;

