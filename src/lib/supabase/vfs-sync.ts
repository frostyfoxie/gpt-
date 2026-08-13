import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!isSupabaseConfigured) {
  console.warn(
    '[Theta Suite] Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing). ' +
    'Cross-agent sync, logs, checkpoints, file locking, autosave and commits will not persist until these are set in .env.local.'
  );
}

export const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder-anon-key'
);

const WORKSPACE_KEY = 'file_tree';
const LOCAL_FALLBACK_PREFIX = 'theta_local_workspace_snapshot_';
const LOCAL_STATE_PREFIX = 'theta_local_project_state_';

export class VFSSynchronizer {
  public readonly projectId: string;
  private realtimeChannel?: ReturnType<typeof supabase.channel>;

  constructor(projectId: string) {
    if (!projectId) throw new Error('VFSSynchronizer requires an active project id.');
    this.projectId = projectId;
    this.initRealtimeSubscription();
  }

  dispose(): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = undefined;
    }
  }

  private initRealtimeSubscription() {
    if (!isSupabaseConfigured) return;
    this.realtimeChannel = supabase
      .channel(`workspace-state-${this.projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shared_workspace_state',
          filter: `project_id=eq.${this.projectId}`,
        },
        (payload: any) => {
          if (payload.new && (payload.new as any).key === WORKSPACE_KEY) {
            const updatedTree = (payload.new as any).value;
            (window as any).rootProject = updatedTree;
            if (typeof (window as any).renderFileTree === 'function') {
              (window as any).renderFileTree();
            }
          }
        }
      )
      .subscribe();
  }

  public async saveFileContent(filePath: string, content: string): Promise<void> {
    const { error } = await supabase
      .from('file_history')
      .insert({
        project_id: this.projectId,
        file_path: filePath,
        content,
        modified_by: 'user',
        step_id: 0,
      });
    if (error) console.error('[Supabase VFS Error]:', error);
  }

  public async saveWorkspaceSnapshot(tree: any): Promise<void> {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').upsert(
        {
          project_id: this.projectId,
          key: WORKSPACE_KEY,
          value: tree,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id,key' }
      );
      if (!error) return;
      console.warn('[Supabase VFS] Snapshot save failed, falling back to localStorage:', error);
    }
    try {
      localStorage.setItem(this.localFallbackKey(), JSON.stringify(tree));
    } catch (err) {
      console.warn('[Supabase VFS] localStorage snapshot save failed (quota?):', err);
    }
  }

  public async loadWorkspaceSnapshot(): Promise<any | null> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('shared_workspace_state')
          .select('value')
          .eq('project_id', this.projectId)
          .eq('key', WORKSPACE_KEY)
          .maybeSingle();
        if (!error && data && data.value && Object.keys(data.value).length > 0) return data.value;
        if (error) console.warn('[Supabase VFS] Snapshot load failed, checking localStorage:', error);
      } catch (err) {
        console.warn('[Supabase VFS] Snapshot load failed, checking localStorage:', err);
      }
    }
    try {
      const local = localStorage.getItem(this.localFallbackKey());
      return local ? JSON.parse(local) : null;
    } catch {
      return null;
    }
  }



  /** Persist a small project-scoped JSON state blob in shared_workspace_state. */
  public async saveProjectState<T>(key: string, value: T): Promise<void> {
    if (!key || key === WORKSPACE_KEY) throw new Error('Invalid project-state key.');
    const payload = { project_id: this.projectId, key, value, updated_at: new Date().toISOString() };
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').upsert(payload, { onConflict: 'project_id,key' });
      if (!error) return;
      console.warn(`[Supabase VFS] Failed to save project state "${key}", using local fallback:`, error);
    }
    try { localStorage.setItem(`${LOCAL_STATE_PREFIX}${this.projectId}_${key}`, JSON.stringify(value)); } catch (err) {
      console.warn(`[Supabase VFS] Local project state save failed for ${key}:`, err);
    }
  }

  public async loadProjectState<T>(key: string): Promise<T | null> {
    if (!key || key === WORKSPACE_KEY) throw new Error('Invalid project-state key.');
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.from('shared_workspace_state').select('value').eq('project_id', this.projectId).eq('key', key).maybeSingle();
        if (!error && data?.value != null) return data.value as T;
        if (error) console.warn(`[Supabase VFS] Failed to load project state "${key}", checking local fallback:`, error);
      } catch (err) {
        console.warn(`[Supabase VFS] Project state load failed for ${key}:`, err);
      }
    }
    try {
      const raw = localStorage.getItem(`${LOCAL_STATE_PREFIX}${this.projectId}_${key}`);
      return raw ? JSON.parse(raw) as T : null;
    } catch { return null; }
  }

  public async deleteProjectState(key: string): Promise<void> {
    if (!key || key === WORKSPACE_KEY) throw new Error('Invalid project-state key.');
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').delete().eq('project_id', this.projectId).eq('key', key);
      if (error) console.warn(`[Supabase VFS] Failed to delete project state "${key}":`, error);
    }
    try { localStorage.removeItem(`${LOCAL_STATE_PREFIX}${this.projectId}_${key}`); } catch {}
  }

  private localFallbackKey(): string {
    return LOCAL_FALLBACK_PREFIX + this.projectId;
  }
}

export let vfsSync: VFSSynchronizer | null = null;

export function setVfsSynchronizer(projectId: string): VFSSynchronizer {
  vfsSync?.dispose();
  vfsSync = new VFSSynchronizer(projectId);
  return vfsSync;
}
