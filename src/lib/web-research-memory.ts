import { supabase } from './supabase/vfs-sync';
import { getCurrentUserId } from './supabase/auth';

export interface ResearchMemoryPattern {
  pattern: string;
  evidence: string;
  applicability: string;
  novelty: 'low' | 'medium' | 'high';
}

export interface ResearchMemoryInput {
  projectId?: string;
  query: string;
  mode: string;
  summary: string;
  sources: Array<{ title: string; uri: string; domain: string }>;
  patterns?: ResearchMemoryPattern[];
  palette?: string[];
}

export class ResearchMemory {
  /**
   * Best-effort persistence. A failed memory write must never block coding/research.
   * Project-scoped findings remain attached to the current project; high-value "global"
   * patterns are tagged by novelty in the database and can later be promoted across projects.
   */
  public static async remember(input: ResearchMemoryInput): Promise<void> {
    try {
      const userId = await getCurrentUserId();

      const run = await supabase
        .from('research_runs')
        .insert({
          project_id: input.projectId ?? null,
          user_id: userId,
          query: input.query,
          mode: input.mode,
          summary: input.summary,
          palette: input.palette ?? [],
        })
        .select('id')
        .single();

      if (run.error || !run.data?.id) return;

      const runId = run.data.id;
      if (input.sources.length) {
        await supabase.from('research_sources').insert(
          input.sources.map((source) => ({
            run_id: runId,
            project_id: input.projectId ?? null,
            user_id: userId,
            title: source.title,
            uri: source.uri,
            domain: source.domain,
          }))
        );
      }

      const globalPatterns = (input.patterns ?? []).filter((p) => p.novelty === 'high');
      const projectPatterns = input.patterns ?? [];
      if (projectPatterns.length) {
        await supabase.from('research_patterns').insert(
          projectPatterns.map((pattern) => ({
            run_id: runId,
            project_id: input.projectId ?? null,
            user_id: userId,
            pattern: pattern.pattern,
            evidence: pattern.evidence,
            applicability: pattern.applicability,
            novelty: pattern.novelty,
            is_global_candidate: globalPatterns.includes(pattern),
          }))
        );
      }
    } catch {
      // Research is useful context, never a hard dependency for coding.
    }
  }
  public static async getContext(projectId?: string, limit = 8): Promise<string> {
    try {
      const userId = await getCurrentUserId();
      if (!userId) return '';

      const filters = projectId
        ? supabase
            .from('research_patterns')
            .select('pattern, evidence, applicability, novelty')
            .eq('project_id', projectId)
            .order('created_at', { ascending: false })
            .limit(limit)
        : supabase
            .from('research_patterns')
            .select('pattern, evidence, applicability, novelty')
            .eq('user_id', userId)
            .eq('is_global_candidate', true)
            .order('created_at', { ascending: false })
            .limit(limit);

      const { data, error } = await filters;
      if (error || !Array.isArray(data) || data.length === 0) return '';

      return data
        .map(
          (row: any) =>
            `- ${row.pattern} [novelty=${row.novelty}] Evidence: ${row.evidence} Applicability: ${row.applicability}`
        )
        .join('\n');
    } catch {
      return '';
    }
  }

}
