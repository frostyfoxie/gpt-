import { supabase, isSupabaseConfigured } from './vfs-sync';
import { getActiveProjectId } from '../../engine/active-project';

export type ConversationAgentId = 'chief' | 'miko';
const LOCAL_FALLBACK_PREFIX = 'theta_local_conversation_';

function workspaceKey(agentId: ConversationAgentId): string {
  return `${agentId}_conversation`;
}

function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

export class ConversationSync {
  public static async save(agentId: ConversationAgentId, conversation: string[]): Promise<void> {
    const projectId = requireProjectId();
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('shared_workspace_state').upsert(
        {
          project_id: projectId,
          key: workspaceKey(agentId),
          value: conversation,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id,key' }
      );
      if (!error) return;
      console.warn(`[ConversationSync] Supabase save failed for ${agentId}, falling back to localStorage:`, error);
    }
    try {
      localStorage.setItem(`${LOCAL_FALLBACK_PREFIX}${projectId}_${agentId}`, JSON.stringify(conversation));
    } catch (err) {
      console.warn(`[ConversationSync] localStorage save failed for ${agentId} (quota?):`, err);
    }
  }

  public static async load(agentId: ConversationAgentId): Promise<string[]> {
    const projectId = requireProjectId();
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('shared_workspace_state')
          .select('value')
          .eq('project_id', projectId)
          .eq('key', workspaceKey(agentId))
          .maybeSingle();
        if (!error && data && Array.isArray(data.value)) return data.value as string[];
        if (error) console.warn(`[ConversationSync] Supabase load failed for ${agentId}, checking localStorage:`, error);
      } catch (err) {
        console.warn(`[ConversationSync] Supabase load threw for ${agentId}, checking localStorage:`, err);
      }
    }
    try {
      const local = localStorage.getItem(`${LOCAL_FALLBACK_PREFIX}${projectId}_${agentId}`);
      const parsed = local ? JSON.parse(local) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
