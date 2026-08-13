import { supabase, isSupabaseConfigured } from './vfs-sync';
import { getActiveProjectId } from '../../engine/active-project';

export const BLUEPRINT_STATE_KEY = 'blueprint_state';
const LOCAL_PREFIX = 'theta_local_blueprint_';

export interface PersistedBlueprintState {
  blueprint: any[];
  mode: 'manual' | 'auto';
  awaitingBlueprintConfirmation: boolean;
  blueprintDecisionPending: boolean;
  cancelled: boolean;
  hasInitialCheckpoint: boolean;
  finalized: boolean;
  paused: boolean;
  pauseRequested: boolean;
}

function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

export class BlueprintSync {
  static async save(state: PersistedBlueprintState): Promise<void> {
    const projectId = requireProjectId();
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').upsert({
        project_id: projectId,
        key: BLUEPRINT_STATE_KEY,
        value: state,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'project_id,key' });
      if (!error) return;
      console.warn('[BlueprintSync] Supabase save failed; using local fallback:', error);
    }
    try { localStorage.setItem(`${LOCAL_PREFIX}${projectId}`, JSON.stringify(state)); } catch (err) {
      console.warn('[BlueprintSync] local save failed:', err);
    }
  }

  static async load(): Promise<PersistedBlueprintState | null> {
    const projectId = requireProjectId();
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.from('shared_workspace_state')
          .select('value').eq('project_id', projectId).eq('key', BLUEPRINT_STATE_KEY).maybeSingle();
        if (!error && data?.value && typeof data.value === 'object') return data.value as PersistedBlueprintState;
        if (error) console.warn('[BlueprintSync] Supabase load failed; using local fallback:', error);
      } catch (err) { console.warn('[BlueprintSync] Supabase load threw; using local fallback:', err); }
    }
    try {
      const raw = localStorage.getItem(`${LOCAL_PREFIX}${projectId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  static async clear(): Promise<void> {
    const projectId = requireProjectId();
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').delete()
        .eq('project_id', projectId).eq('key', BLUEPRINT_STATE_KEY);
      if (error) console.warn('[BlueprintSync] Supabase clear failed:', error);
    }
    try { localStorage.removeItem(`${LOCAL_PREFIX}${projectId}`); } catch { /* best effort */ }
  }
}
