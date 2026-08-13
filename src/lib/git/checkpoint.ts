import { supabase } from '../supabase/vfs-sync';
import { logReActStep } from '../supabase/logger';
import { getActiveProjectId } from '../../engine/active-project';
import { computeTreeDiff, reconstructTreeFromChain, type TreeDiff, type DiffChainRow } from '../diff';

export interface CheckpointSnapshot {
  stepId: number;
  snapshotTree: Record<string, any>;
  createdAt: string;
}

/** Every Nth checkpoint (by sequence, not step_id — steps can be re-run/retried out of numeric order) stores a full tree copy as a fast-restore anchor; every other checkpoint stores only a diff against the tree produced by the previous checkpoint. */
const ANCHOR_INTERVAL = 10;

/**
 * Shadow checkpoint layer for in-flight execution steps (rollback on cancel/failure).
 * Same diff-based storage strategy as CommitManager (see src/engine/commits.ts): checkpoints
 * form a sequence (`seq`), every ANCHOR_INTERVAL-th one is a full-tree anchor, and the rest
 * store only a diff against the previous checkpoint's tree, replayed forward on restore.
 */
function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

export class CheckpointEngine {
  /**
   * Creates a shadow checkpoint snapshot before an execution step begins. Upserts on
   * step_id like before — if this step already has a checkpoint (e.g. a retried step), its
   * existing position in the sequence is kept and its diff/snapshot is simply recomputed
   * against the same base.
   */
  public static async createCheckpoint(stepId: number): Promise<boolean> {
    const projectId = requireProjectId();
    const rawTree = typeof window !== 'undefined' ? (window as any).rootProject || {} : {};
    // Deep clone to prevent accidental in-memory mutations from corrupting snapshot state
    const currentTree = JSON.parse(JSON.stringify(rawTree));

    try {
      const { data: existingRow } = await supabase
        .from('step_checkpoints')
        .select('id, seq, is_snapshot')
        .eq('project_id', projectId)
        .eq('step_id', stepId)
        .maybeSingle();

      let seq: number;
      let isSnapshot: boolean;
      if (existingRow && typeof existingRow.seq === 'number') {
        // Re-checkpointing the same step: keep its existing place in the sequence.
        seq = existingRow.seq;
        isSnapshot = existingRow.is_snapshot;
      } else {
        const { data: maxRow } = await supabase
          .from('step_checkpoints')
          .select('seq')
          .eq('project_id', projectId)
          .order('seq', { ascending: false })
          .limit(1)
          .maybeSingle();
        seq = maxRow && typeof maxRow.seq === 'number' ? maxRow.seq + 1 : 0;
        isSnapshot = seq % ANCHOR_INTERVAL === 0;
      }

      let diff: TreeDiff | null = null;
      let snapshotTree: any = null;
      if (isSnapshot) {
        snapshotTree = currentTree;
      } else {
        const baseTree = await CheckpointEngine.fetchTreeAtSeq(seq - 1, projectId);
        diff = computeTreeDiff(baseTree, currentTree);
      }

      let error: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const payload = {
          project_id: projectId, step_id: stepId, seq, is_snapshot: isSnapshot,
          snapshot_tree: snapshotTree, diff, created_at: new Date().toISOString(),
        };
        const result = existingRow?.id
          ? await supabase.from('step_checkpoints').update(payload).eq('id', existingRow.id)
          : await supabase.from('step_checkpoints').insert(payload);
        error = result.error;
        if (!error) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }

      if (error) {
        // IMPORTANT: a temporary Supabase checkpoint failure must NEVER prevent the
        // developer agents from starting. The checkpoint is a recovery mechanism, not
        // an execution gate. Save a local project-scoped emergency snapshot for ANY
        // step, report the degraded durability honestly, and let the step run.
        //
        // The previous implementation only did this for stepId < 0 (the baseline), which
        // meant Step 1 could fail before ReActExecutionLoop was even constructed. That is
        // exactly the failure mode where the UI appears to show "dev agents" doing nothing.
        if (typeof window !== 'undefined') {
          try {
            const localKey = stepId < 0
              ? `theta_baseline_checkpoint_${projectId}`
              : `theta_step_checkpoint_${projectId}_${stepId}`;

            localStorage.setItem(localKey, JSON.stringify({
              projectId,
              stepId,
              snapshotTree: currentTree,
              createdAt: new Date().toISOString(),
              durable: false,
              remoteError: error?.message || String(error),
            }));
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('theta:persistence', { detail: { status: 'degraded', stepId, projectId } }));

            await logReActStep({
              stepId,
              agentId: 'chief',
              thought:
                `Remote checkpoint for Step ${stepId} failed (${error?.message || error}). ` +
                `Saved a local emergency snapshot and continued execution. ` +
                `Durable Supabase checkpointing is unavailable until the database/API issue is fixed.`,
              action: 'create_checkpoint',
              status: 'skipped',
            });

            return true;
          } catch {}
        }
        // If this project's Supabase schema still has the OLD `snapshot_tree JSONB NOT
        // NULL` constraint (i.e. the Phase-3 migration ALTER statements in
        // Supabase/schema.sql — the ones that DROP NOT NULL and add seq/is_snapshot/diff —
        // were never re-run against this database), every diff-only checkpoint (9 out of
        // every 10, since only every ANCHOR_INTERVAL-th one is a full snapshot) sends
        // `snapshot_tree: null` and gets rejected outright. Fall back once to writing a
        // full snapshot for THIS row instead of a diff — checkpointing still works (just
        // without the storage savings) instead of silently failing every single time on an
        // unmigrated database.
        if (!isSnapshot) {
          const fallbackPayload = {
            project_id: projectId,
            step_id: stepId,
            seq,
            is_snapshot: true,
            snapshot_tree: currentTree,
            diff: null,
            created_at: new Date().toISOString(),
          };
          const retryResult = existingRow?.id
            ? await supabase.from('step_checkpoints').update(fallbackPayload).eq('id', existingRow.id)
            : await supabase.from('step_checkpoints').insert(fallbackPayload);
          const retryError = retryResult.error;
          if (!retryError) {
            await logReActStep({
              stepId,
              agentId: 'chief',
              thought:
                `Created checkpoint for Step ${stepId} as a full snapshot after the diff write was rejected ` +
                `(${error.message || error}). If this keeps happening, re-run the full Supabase/schema.sql — ` +
                `the Phase-3 migration section (seq/is_snapshot/diff columns, DROP NOT NULL on snapshot_tree) ` +
                `may not have been applied to this database yet.`,
              action: 'create_checkpoint',
              status: 'success',
            });
            return true;
          }
        }

        // Genuinely failed — this used to only go to console.error, so the toast telling
        // the user to "check console/Logs tab" pointed at a Logs tab that had nothing in
        // it. Log the real failure so that claim is actually true.
        console.error(`[Checkpoint Error] Failed to create checkpoint for Step ${stepId}:`, error);
        await logReActStep({
          stepId,
          agentId: 'chief',
          thought: `Checkpoint creation FAILED for Step ${stepId}: ${error.message || error}`,
          action: 'create_checkpoint',
          status: 'failed',
        });
        return false;
      }
    } catch (err: any) {
      console.error(`[Checkpoint Error] Failed to create checkpoint for Step ${stepId}:`, err);
      await logReActStep({
        stepId,
        agentId: 'chief',
        thought: `Checkpoint creation threw for Step ${stepId}: ${err?.message || err}`,
        action: 'create_checkpoint',
        status: 'failed',
      });
      return false;
    }

    const { data: verified } = await supabase.from('step_checkpoints').select('step_id,seq,is_snapshot').eq('project_id', projectId).eq('step_id', stepId).maybeSingle();
    if (!verified) {
      // Preserve the local emergency snapshot if read-after-write failed. A step should not
      // be blocked solely because the remote verification round-trip is temporarily broken.
      if (typeof window !== 'undefined') {
        try {
          const localKey = stepId < 0
            ? `theta_baseline_checkpoint_${projectId}`
            : `theta_step_checkpoint_${projectId}_${stepId}`;
          localStorage.setItem(localKey, JSON.stringify({
            projectId,
            stepId,
            snapshotTree: currentTree,
            createdAt: new Date().toISOString(),
            durable: false,
            remoteError: 'Checkpoint write succeeded but read-back verification failed.',
          }));
        } catch {}
      }
      await logReActStep({
        stepId,
        agentId: 'chief',
        thought: `Remote checkpoint write for Step ${stepId} could not be read back. Saved local emergency snapshot and continued.`,
        action: 'create_checkpoint',
        status: 'skipped',
      });
      return true;
    }

    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('theta:persistence', { detail: { status: 'healthy', stepId, projectId } }));
    CheckpointEngine.clearLocalEmergencyCheckpoint(stepId, projectId);

    await logReActStep({
      stepId,
      agentId: 'chief',
      thought: `Created shadow checkpoint snapshot for Step ${stepId}.`,
      action: 'create_checkpoint',
      status: 'success',
    });

    return true;
  }

  /**
   * Restores project state back to a previous checkpoint snapshot, replaying diffs forward
   * from the nearest anchor at or before that checkpoint's place in the sequence.
   */
  public static async restoreCheckpoint(stepId: number): Promise<boolean> {
    const projectId = requireProjectId();
    const { data, error } = await supabase
      .from('step_checkpoints')
      .select('seq')
      .eq('project_id', projectId)
      .eq('step_id', stepId)
      .maybeSingle();

    if (error || !data || typeof data.seq !== 'number') {
      // Remote checkpoint may be unavailable. Restore from the local emergency snapshot
      // saved by createCheckpoint() for this exact project/step.
      if (typeof window !== 'undefined') {
        try {
          const localKey = stepId < 0
            ? `theta_baseline_checkpoint_${projectId}`
            : `theta_step_checkpoint_${projectId}_${stepId}`;
          const raw = localStorage.getItem(localKey);
          const localCheckpoint = raw ? JSON.parse(raw) : null;
          if (localCheckpoint?.snapshotTree) {
            (window as any).rootProject = localCheckpoint.snapshotTree;
            (window as any).renderFileTree?.();
            (window as any).refreshOpenTabsAfterRestore?.();
            (window as any).scheduleWorkspaceAutosave?.(true);
            await logReActStep({
              stepId,
              agentId: 'chief',
              thought: `Restored local emergency checkpoint for Step ${stepId}.`,
              action: 'restore_checkpoint',
              status: 'success',
            });
            return true;
          }
        } catch {}
      }
      console.error(`[Checkpoint Error] No valid checkpoint found for Step ${stepId}`);
      return false;
    }

    const restoredTree = await CheckpointEngine.fetchTreeAtSeq(data.seq, projectId);
    if (!restoredTree) {
      console.error(`[Checkpoint Error] Could not reconstruct tree for Step ${stepId}`);
      return false;
    }

    if (typeof window !== 'undefined') {
      (window as any).rootProject = restoredTree;

      if (typeof (window as any).renderFileTree === 'function') {
        (window as any).renderFileTree();
      }
      // Open tabs may reference node ids that no longer exist in the restored tree —
      // same cleanup CommitManager.restoreCommit() does after a commit restore.
      if (typeof (window as any).refreshOpenTabsAfterRestore === 'function') {
        (window as any).refreshOpenTabsAfterRestore();
      }
      // Persist the restored tree back to Supabase (falls back to localStorage) so the
      // rollback survives a refresh — mirrors CommitManager.restoreCommit()'s own call.
      if (typeof (window as any).scheduleWorkspaceAutosave === 'function') {
        (window as any).scheduleWorkspaceAutosave(true);
      }
    }

    await logReActStep({
      stepId,
      agentId: 'chief',
      thought: `System state rolled back to Step ${stepId} checkpoint successfully.`,
      action: 'restore_checkpoint',
      status: 'success',
    });

    return true;
  }

  /**
   * Removes local emergency checkpoints for a project/step once a durable checkpoint exists.
   */
  private static clearLocalEmergencyCheckpoint(stepId: number, projectId: string): void {
    if (typeof window === 'undefined') return;
    try {
      const key = stepId < 0
        ? `theta_baseline_checkpoint_${projectId}`
        : `theta_step_checkpoint_${projectId}_${stepId}`;
      localStorage.removeItem(key);
    } catch {}
  }

  /**
   * Reconstructs the file tree exactly as it was right before a given step started
   * executing — i.e. the tree that step's own checkpoint row snapshots/diffs against
   * (createCheckpoint(stepId) is always called first, before any subtask writes anything).
   * Used by the Phase 4 diff view to compute a step's before/after file diff: this is the
   * "before" side, and the live `window.rootProject` (or, once the step is long finished,
   * a later checkpoint/commit) is the "after" side. Returns null if this step never got a
   * checkpoint (e.g. an unknown/garbage stepId).
   */
  public static async getStepBeforeTree(stepId: number): Promise<any | null> {
    const projectId = requireProjectId();
    const { data, error } = await supabase
      .from('step_checkpoints')
      .select('seq')
      .eq('project_id', projectId)
      .eq('step_id', stepId)
      .maybeSingle();
    if (error || !data || typeof data.seq !== 'number') return null;
    return CheckpointEngine.fetchTreeAtSeq(data.seq, projectId);
  }

  /** Reconstructs the file tree as of a given checkpoint `seq`, by fetching the nearest anchor at or before it and replaying every diff since. */
  private static async fetchTreeAtSeq(targetSeq: number, projectId = getActiveProjectId()!): Promise<any> {
    if (targetSeq < 0) return { id: 'root', name: 'project', type: 'folder', expanded: true, children: [] };

    const { data: anchorRow, error: anchorErr } = await supabase
      .from('step_checkpoints')
      .select('seq, snapshot_tree')
      .eq('project_id', projectId)
      .eq('is_snapshot', true)
      .lte('seq', targetSeq)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (anchorErr || !anchorRow) return { id: 'root', name: 'project', type: 'folder', expanded: true, children: [] };

    const { data: chainRows, error: chainErr } = await supabase
      .from('step_checkpoints')
      .select('seq, is_snapshot, snapshot_tree, diff')
      .eq('project_id', projectId)
      .gte('seq', anchorRow.seq)
      .lte('seq', targetSeq)
      .order('seq', { ascending: true });
    if (chainErr || !chainRows || chainRows.length === 0) {
      return anchorRow.snapshot_tree
        ? JSON.parse(JSON.stringify(anchorRow.snapshot_tree))
        : { id: 'root', name: 'project', type: 'folder', expanded: true, children: [] };
    }

    return reconstructTreeFromChain(chainRows as DiffChainRow[]);
  }
}
