# Manual test: two dev agents contending on the same file

No test runner is configured in this project (no jest/vitest — see `package.json`), so this
is a manual verification plan rather than an automated test. Run it after any change to
`src/engine/react-loop.ts`, `src/engine/state-lock.ts`, or `src/tools/index.ts`.

## What this checks

Phase 9 lets any dev agent's `write_file`/`edit_file` tool call target ANY file path, not
just its assigned `targetFile` — so two agents can now legitimately try to write the same
file in the same step (e.g. both need to add an export to a shared `types.ts`). The per-file
lock (`state-lock.ts`) must still make that safe: no lost writes, no crash, and the loser of
the race retries instead of failing the whole subtask.

## Setup

1. `npm install`, fill in `.env.local` with a real Supabase project (locks are stored in
   `shared_workspace_state`, so this needs a real backend, not the localStorage fallback).
2. `npm run dev`, open the app, enter Gemini keys for at least `dev1` and `dev2` (can reuse
   one key for both, rate limits aside).
3. In the browser console, seed a project with an existing shared file both agents will
   contend on:
   ```js
   window.rootProject.children.push({
     id: 'node_shared', name: 'shared.ts', type: 'file',
     language: 'TypeScript', content: 'export const VERSION = 1;\n'
   });
   window.renderFileTree?.();
   ```

## Test 1 — simultaneous writes to the same file

1. In the browser console, directly construct two `ReActExecutionLoop` instances (bypassing
   Chief's planner, to force exact simultaneity) and kick off `executeTask` for both at once
   against `shared.ts`, e.g. via a scratch script that imports the compiled module, or by
   temporarily wiring a debug button that does:
   ```js
   const a = new ReActExecutionLoop('dev1');
   const b = new ReActExecutionLoop('dev2');
   Promise.all([
     a.executeTask(999, 'T1', 'Add an export named FOO to shared.ts', 'shared.ts'),
     b.executeTask(999, 'T2', 'Add an export named BAR to shared.ts', 'shared.ts'),
   ]).then(console.log);
   ```
2. **Expected:** both calls resolve `true`. `shared.ts` ends up containing exactly one of
   `FOO`/`BAR` added by whichever agent's write committed last (the other agent's model call,
   on seeing the file already has the requested change absent after its own write attempt,
   is not required to detect this in this basic test — the point here is lock safety, not
   merge semantics). Check the Logs tab / `agent_react_logs` table: you should see at least
   one `observation` containing `"is currently locked by another agent — try again next
   turn"` for whichever agent lost the initial race, followed by a later successful
   `write_file` log for that same agent.
3. **Fail conditions to watch for:** a thrown/unhandled error from either `executeTask` call;
   `shared_workspace_state`'s `lock:shared.ts` row left behind after both calls resolve
   (query it directly — it should be deleted by `releaseFileLock` in the `finally` block of
   `performVerifiedWrite`); either agent's promise hanging past `maxTurns * (LOCK_WAIT_ATTEMPTS
   * LOCK_WAIT_MS + one model call)` — call it stuck if it exceeds ~30s.

## Test 2 — stale lock recovery

1. Manually insert a stale lock row before starting a task:
   ```js
   await supabase.from('shared_workspace_state').upsert({
     key: 'lock:shared.ts',
     value: { filePath: 'shared.ts', lockedAt: new Date(Date.now() - 60_000).toISOString() },
     locked_by: 'dev3',
     updated_at: new Date().toISOString(),
   });
   ```
   (60s old — past the 30s `STALE_LOCK_TIMEOUT_MS` in `state-lock.ts`.)
2. Run `new ReActExecutionLoop('dev1').executeTask(999, 'T3', 'Add an export named BAZ to
   shared.ts', 'shared.ts')`.
3. **Expected:** the write succeeds without waiting out all `LOCK_WAIT_ATTEMPTS` — the stale
   lock should be treated as available on the first or second attempt, not the fifth.

## Test 3 — regression check on the common single-file case

Run a normal single-subtask task against a brand-new file (e.g. `index.html`) with no
contention. Confirm it completes in roughly 2 model calls (one `write_file` turn whose
automatic chain passes, one `finish` turn) — not meaningfully more than before Phase 9. Check
`agent_react_logs` turn count for that `stepId`/`subtaskId` to confirm.
