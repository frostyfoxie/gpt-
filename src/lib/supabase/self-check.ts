import { supabase, isSupabaseConfigured } from './vfs-sync';

export interface SupabaseSelfCheckResult {
  ok: boolean;
  issues: string[];
}

/**
 * Tables + the columns Theta actually reads/writes on them, used as a lightweight schema
 * smoke test. Kept intentionally small — this isn't meant to validate the whole schema,
 * just the two tables everything else depends on most directly: file locking
 * (shared_workspace_state — see engine/state-lock.ts) and rollback safety
 * (step_checkpoints — see lib/git/checkpoint.ts). A misconfigured/out-of-date backend on
 * either of these is exactly the class of failure that otherwise surfaces later as a
 * confusing "locked by another agent" or a checkpoint error nobody was watching the
 * console for.
 */
const EXPECTED_SCHEMA: Record<string, string[]> = {
  step_checkpoints: ['project_id', 'step_id', 'seq', 'is_snapshot', 'snapshot_tree', 'diff', 'created_at'],
  shared_workspace_state: ['key', 'value', 'locked_by', 'updated_at', 'project_id'],
};

/**
 * Runs on app load (see index.ts). Verifies Supabase is configured, reachable, and that
 * the tables above actually have the columns the app expects — instead of finding out mid
 * task when a write silently fails.
 */
export async function runSupabaseSelfCheck(): Promise<SupabaseSelfCheckResult> {
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      issues: [
        'Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing) — ' +
          'file locking, checkpoints, logs, autosave and commits will not persist.',
      ],
    };
  }

  const issues: string[] = [];

  for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
    try {
      const { error } = await supabase.from(table).select(columns.join(',')).limit(1);
      if (error) {
        issues.push(describeSchemaError(table, error));
      }
    } catch (err: any) {
      issues.push(`Could not reach Supabase while checking "${table}": ${err?.message || err}`);
    }
  }

  // The column check above only proves shared_workspace_state EXISTS — it says nothing about
  // whether the acquire_project_file_lock RPC from migration 009 was ever applied. That RPC is
  // called on every single write_file/edit_file a dev agent performs (see engine/state-lock.ts),
  // so a database that passes the table check above but is missing this migration doesn't fail
  // until the first real blueprint step runs, where every dev agent's first write throws — the
  // step fails immediately and the actual reason is buried in the Logs tab instead of being
  // visible before anyone hits "Run". Call the RPC with a canary (non-existent) project id: a
  // database with the migration applied raises a distinguishable "not owned by the authenticated
  // user" error from inside the function body; a database without it fails to resolve the
  // function at all (PGRST202 / "could not find function").
  try {
    const { error } = await supabase.rpc('acquire_project_file_lock', {
      p_project_id: '00000000-0000-0000-0000-000000000000',
      p_key: '__self_check__',
      p_agent_id: '__self_check__',
      p_file_path: '__self_check__',
      p_stale_after_seconds: 1,
    });
    if (error) {
      const code = (error as any)?.code;
      const message = error.message || String(error);
      const rpcMissing = code === 'PGRST202' || /could not find function|does not exist/i.test(message);
      const ownedRejection = /not owned by the authenticated user/i.test(message);
      if (rpcMissing) {
        issues.push(
          'File-lock RPC "acquire_project_file_lock" is missing — apply Supabase migration ' +
            '009_atomic_file_locks.sql. Without it, every dev agent write fails immediately and no ' +
            'blueprint step can complete (this is the single most common cause of a blueprint that ' +
            'never gets past Step 1).'
        );
      } else if (!ownedRejection) {
        // Any other error (permissions, unexpected shape, etc.) is unexpected enough to
        // surface — but "not owned by the authenticated user" is the RPC working correctly
        // against a canary id that legitimately doesn't belong to this user, not a real issue.
        issues.push(`Unexpected error probing "acquire_project_file_lock": ${message}`);
      }
    }
  } catch (err: any) {
    issues.push(`Could not reach Supabase while checking the file-lock RPC: ${err?.message || err}`);
  }

  return { ok: issues.length === 0, issues };
}

/** Turns a raw PostgREST error into a message that tells the user what to actually do about it. */
function describeSchemaError(table: string, error: any): string {
  const code = error?.code;
  const message = error?.message || String(error);

  // PostgREST: 42P01 = undefined_table, PGRST205 = table missing from the schema cache
  // (not created yet, or hidden entirely by RLS/permissions). 42703 = undefined_column.
  if (code === '42P01' || code === 'PGRST205') {
    return `Table "${table}" doesn't exist (or isn't visible to this key) — run Supabase/schema.sql against this project.`;
  }
  if (code === '42703') {
    return `Table "${table}" is missing an expected column — schema looks out of date. Re-run Supabase/schema.sql (it's idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).`;
  }
  return `Unexpected error checking "${table}": ${message}`;
}

const BANNER_ID = 'supabaseHealthBanner';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders (or updates) a banner directly under the top nav. Unlike a toast, this does NOT
 * auto-dismiss — a broken backend needs to stay visible until the user fixes it or
 * explicitly closes it, not disappear after 3 seconds like every other showToast() call in
 * this app.
 */
export function showStartupHealthBanner(issues: string[]): void {
  if (typeof document === 'undefined') return;

  let banner = document.getElementById(BANNER_ID);
  if (!banner) {
    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className =
      'w-full px-4 py-2 bg-rose-950/90 text-rose-200 border-b border-rose-800/50 text-xs flex items-center justify-between gap-3 z-40 shrink-0';

    const header = document.querySelector('header');
    if (header && header.parentElement) {
      header.parentElement.insertBefore(banner, header.nextSibling);
    } else {
      document.body.insertAdjacentElement('afterbegin', banner);
    }
  }

  const message = issues.map(escapeHtml).join(' &middot; ');
  banner.innerHTML = `
    <span class="flex-1">&#9888;&#65039; Supabase self-check failed — some features may fail silently until this is fixed: ${message}</span>
    <button id="${BANNER_ID}Dismiss" class="shrink-0 text-rose-300 hover:text-rose-100 font-medium">Dismiss</button>
  `;

  document.getElementById(`${BANNER_ID}Dismiss`)?.addEventListener('click', () => {
    banner?.remove();
  });
}
