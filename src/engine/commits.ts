import { supabase, isSupabaseConfigured } from '../lib/supabase/vfs-sync';
import { computeTreeDiff, reconstructTreeFromChain, type TreeDiff, type DiffChainRow } from '../lib/diff';

export interface CommitRecord {
  id: string;
  message: string;
  kind: 'manual' | 'auto';
  created_at: string;
  seq: number;
  is_snapshot: boolean;
  snapshot_tree?: any; // only populated for anchor commits, and only when fetched individually for restore
  diff?: TreeDiff | null; // only populated for non-anchor commits, and only when fetched individually for restore
}

const LOCAL_FALLBACK_PREFIX = 'theta_local_commits_'; // used only if Supabase is unreachable/unconfigured
const LOCAL_FALLBACK_CAP = 50;
/** Every Nth commit (by sequence, not wall-clock) stores a full tree copy as a fast-restore anchor; every other commit stores only a diff against the tree produced by the previous commit. */
const ANCHOR_INTERVAL = 10;

/**
 * A lightweight "shadow git" layer: commits form a sequence (`seq`, 0-indexed, assigned in
 * commit order). Every ANCHOR_INTERVAL-th commit ("anchor") stores a full file-tree
 * snapshot; every other commit stores only a diff (via src/lib/diff, reusing the same
 * SearchReplaceBlock format/replay logic already used for agent-authored file edits)
 * against the tree produced by the previous commit. Restoring replays diffs forward from
 * the nearest anchor at or before the target commit. Falls back to localStorage if
 * Supabase isn't configured so commit/restore still works out of the box.
 */
export class CommitManager {
  private static current: CommitManager | null = null;
  public readonly projectId: string;

  constructor(projectId: string) {
    if (!projectId) throw new Error('CommitManager requires an active project id.');
    this.projectId = projectId;
    CommitManager.current = this;
  }

  private static getCurrent(): CommitManager {
    if (!CommitManager.current) throw new Error('No active project is selected.');
    return CommitManager.current;
  }

  public async createCommit(message: string, kind: 'manual' | 'auto' = 'manual'): Promise<CommitRecord | null> {
    const rawTree = typeof window !== 'undefined' ? (window as any).rootProject || {} : {};
    const currentTree = JSON.parse(JSON.stringify(rawTree));

    if (isSupabaseConfigured) {
      try {
        const record = await this.buildRemoteRecord(message, kind, currentTree);
        const { data, error } = await supabase
          .from('commits')
          .insert({ ...record, project_id: this.projectId })
          .select('id, message, kind, created_at, seq, is_snapshot')
          .single();
        if (!error && data) {
          this.notifyChanged();
          return data as CommitRecord;
        }
        console.warn('[CommitManager] Supabase commit insert failed, falling back to local storage:', error);
      } catch (err) {
        console.warn('[CommitManager] Supabase commit failed, falling back to local storage:', err);
      }
    }

    // Local fallback
    const existing = this.readLocalCommits(); // newest-first
    const nextSeq = existing.length ? Math.max(...existing.map((c) => c.seq ?? 0)) + 1 : 0;
    const isSnapshot = nextSeq % ANCHOR_INTERVAL === 0;

    let diff: TreeDiff | null = null;
    let snapshotTree: any = null;
    if (isSnapshot) {
      snapshotTree = currentTree;
    } else {
      const baseTree = this.reconstructLocalTreeAtSeq(existing, nextSeq - 1);
      diff = computeTreeDiff(baseTree, currentTree);
    }

    const localCommit: CommitRecord = {
      id: 'local_' + Date.now(),
      message,
      kind,
      seq: nextSeq,
      is_snapshot: isSnapshot,
      snapshot_tree: snapshotTree,
      diff,
      created_at: new Date().toISOString(),
    };
    existing.unshift(localCommit);
    localStorage.setItem(this.localFallbackKey(), JSON.stringify(this.trimLocalCommits(existing, LOCAL_FALLBACK_CAP)));
    this.notifyChanged();
    return localCommit;
  }

  public async listCommits(limit = 30): Promise<CommitRecord[]> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('commits')
        .select('id, message, kind, created_at, seq, is_snapshot')
        .eq('project_id', this.projectId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) return data as CommitRecord[];
      console.warn('[CommitManager] Supabase commit list failed, falling back to local storage:', error);
    }
    return this.readLocalCommits().slice(0, limit);
  }

  public async restoreCommit(commitId: string): Promise<boolean> {
    let tree: any = null;

    if (isSupabaseConfigured && !commitId.startsWith('local_')) {
      const { data, error } = await supabase.from('commits').select('seq').eq('project_id', this.projectId).eq('id', commitId).maybeSingle();
      if (!error && data && typeof data.seq === 'number') {
        tree = await this.fetchRemoteTreeAtSeq(data.seq);
      }
    }

    if (!tree) {
      const local = this.readLocalCommits();
      const target = local.find((c) => c.id === commitId);
      if (target) tree = this.reconstructLocalTreeAtSeq(local, target.seq);
    }

    if (!tree || typeof window === 'undefined') return false;

    (window as any).rootProject = tree;
    if (typeof (window as any).renderFileTree === 'function') {
      (window as any).renderFileTree();
    }
    if (typeof (window as any).refreshOpenTabsAfterRestore === 'function') {
      (window as any).refreshOpenTabsAfterRestore();
    }
    if (typeof (window as any).scheduleWorkspaceAutosave === 'function') {
      (window as any).scheduleWorkspaceAutosave(true);
    }
    return true;
  }

  /**
   * Reconstructs the file trees immediately before and after a given commit — the pair the
   * Phase 4 diff view needs to show what that commit actually changed. Works for both
   * Supabase-backed and local-fallback commits, mirroring the id-based lookup restoreCommit()
   * already does. Returns null if the commit can't be found.
   */
  public async getCommitDiffTrees(commitId: string): Promise<{ before: any; after: any } | null> {
    if (isSupabaseConfigured && !commitId.startsWith('local_')) {
      const { data, error } = await supabase.from('commits').select('seq').eq('project_id', this.projectId).eq('id', commitId).maybeSingle();
      if (!error && data && typeof data.seq === 'number') {
        const [before, after] = await Promise.all([
          this.fetchRemoteTreeAtSeq(data.seq - 1),
          this.fetchRemoteTreeAtSeq(data.seq),
        ]);
        return { before, after };
      }
    }

    const local = this.readLocalCommits();
    const target = local.find((c) => c.id === commitId);
    if (!target) return null;
    return {
      before: this.reconstructLocalTreeAtSeq(local, target.seq - 1),
      after: this.reconstructLocalTreeAtSeq(local, target.seq),
    };
  }

  public static async createCommit(message: string, kind: 'manual' | 'auto' = 'manual'): Promise<CommitRecord | null> {
    return CommitManager.getCurrent().createCommit(message, kind);
  }

  public static async listCommits(limit = 30): Promise<CommitRecord[]> {
    return CommitManager.getCurrent().listCommits(limit);
  }

  public static async restoreCommit(commitId: string): Promise<boolean> {
    return CommitManager.getCurrent().restoreCommit(commitId);
  }

  public static async getCommitDiffTrees(commitId: string): Promise<{ before: any; after: any } | null> {
    return CommitManager.getCurrent().getCommitDiffTrees(commitId);
  }

  /** Builds the row to insert for a new commit: decides anchor vs. diff, and (for diff commits) fetches+diffs against the previous commit's reconstructed tree. */
  private async buildRemoteRecord(message: string, kind: 'manual' | 'auto', currentTree: any) {
    const { data: maxRow } = await supabase
      .from('commits')
      .select('seq')
      .eq('project_id', this.projectId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSeq = maxRow && typeof maxRow.seq === 'number' ? maxRow.seq + 1 : 0;
    const isSnapshot = nextSeq % ANCHOR_INTERVAL === 0;

    let diff: TreeDiff | null = null;
    let snapshotTree: any = null;
    if (isSnapshot) {
      snapshotTree = currentTree;
    } else {
      const baseTree = await this.fetchRemoteTreeAtSeq(nextSeq - 1);
      diff = computeTreeDiff(baseTree, currentTree);
    }

    return {
      message,
      kind,
      seq: nextSeq,
      is_snapshot: isSnapshot,
      snapshot_tree: snapshotTree,
      diff,
      created_at: new Date().toISOString(),
    };
  }

  /** Reconstructs the file tree as of a given commit `seq`, by fetching the nearest anchor at or before it and replaying every diff since. */
  private async fetchRemoteTreeAtSeq(targetSeq: number): Promise<any> {
    if (targetSeq < 0) return this.emptyRoot();

    const { data: anchorRow, error: anchorErr } = await supabase
      .from('commits')
      .select('seq, snapshot_tree')
      .eq('project_id', this.projectId)
      .eq('is_snapshot', true)
      .lte('seq', targetSeq)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (anchorErr || !anchorRow) return this.emptyRoot();

    const { data: chainRows, error: chainErr } = await supabase
      .from('commits')
      .select('seq, is_snapshot, snapshot_tree, diff')
      .eq('project_id', this.projectId)
      .gte('seq', anchorRow.seq)
      .lte('seq', targetSeq)
      .order('seq', { ascending: true });
    if (chainErr || !chainRows || chainRows.length === 0) {
      return anchorRow.snapshot_tree ? JSON.parse(JSON.stringify(anchorRow.snapshot_tree)) : this.emptyRoot();
    }

    return reconstructTreeFromChain(chainRows as DiffChainRow[]);
  }

  /** Same reconstruction as fetchRemoteTreeAtSeq, but against the in-memory local-fallback commit list. */
  private reconstructLocalTreeAtSeq(commits: CommitRecord[], targetSeq: number): any {
    if (targetSeq < 0) return this.emptyRoot();
    const bySeq = new Map(commits.map((c) => [c.seq, c]));

    let anchorSeq = -1;
    for (let s = targetSeq; s >= 0; s--) {
      const row = bySeq.get(s);
      if (row && row.is_snapshot) {
        anchorSeq = s;
        break;
      }
    }
    if (anchorSeq === -1) return this.emptyRoot();

    const chain: DiffChainRow[] = [];
    for (let s = anchorSeq; s <= targetSeq; s++) {
      const row = bySeq.get(s);
      if (row) chain.push(row);
    }
    return reconstructTreeFromChain(chain);
  }

  /** Keeps the local fallback list bounded, but never cuts between an anchor and a diff commit that depends on it — always trims down to (at least) the nearest anchor among the oldest kept commits. */
  private trimLocalCommits(commits: CommitRecord[], cap: number): CommitRecord[] {
    if (commits.length <= cap) return commits;
    let cutoff = cap;
    while (cutoff < commits.length && !commits[cutoff - 1]?.is_snapshot) {
      cutoff++;
    }
    return commits.slice(0, cutoff);
  }

  private emptyRoot(): any {
    return { id: 'root', name: 'project', type: 'folder', expanded: true, children: [] };
  }

  private readLocalCommits(): CommitRecord[] {
    if (typeof window === 'undefined') return [];
    try {
      return JSON.parse(localStorage.getItem(this.localFallbackKey()) || '[]');
    } catch {
      return [];
    }
  }

  private localFallbackKey(): string {
    return `${LOCAL_FALLBACK_PREFIX}${this.projectId}`;
  }

  private notifyChanged() {
    if (typeof window !== 'undefined' && typeof (window as any).onCommitsChanged === 'function') {
      (window as any).onCommitsChanged();
    }
  }
}

if (typeof window !== 'undefined') {
  (window as any).CommitManager = CommitManager;
}
