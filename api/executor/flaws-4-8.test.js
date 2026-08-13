import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const pathSafety = fs.readFileSync(new URL('api/executor/path-safety.js', root), 'utf8');
const executor = fs.readFileSync(new URL('api/executor/index.js', root), 'utf8');
const runtimeHelpers = fs.readFileSync(new URL('api/executor/runtime-helpers.js', root), 'utf8');
const lockMigration = fs.readFileSync(new URL('Supabase/migrations/012_execution_sandbox_locks.sql', root), 'utf8');

// Flaw 4: problematic filesystem names/control chars/overlong segments are rejected.
test('path safety rejects problematic filename content', () => {
  assert.match(pathSafety, /control characters/);
  assert.match(pathSafety, /segment is too long/);
  assert.match(pathSafety, /Reserved filename/);
});

// Flaw 5: distributed limiter fails closed instead of using a per-instance quota.
test('executor does not fall back to an in-memory rate limiter', () => {
  assert.doesNotMatch(executor, /const requestBuckets = new Map\(\)/);
  assert.match(executor, /EXECUTOR_RATE_LIMIT_UNAVAILABLE/);
  assert.match(executor, /acquire_execution_rate_limit/);
});

// Flaw 6: only explicit not-found responses permit sandbox recreation.
test('sandbox resume distinguishes not-found from other failures', () => {
  assert.match(executor, /status === 404/);
  assert.match(executor, /if \(notFound\) return null;/);
  assert.match(executor, /throw error;/);
});

// Flaw 7: external sandbox creation is serialized by a database lease.
test('sandbox initialization uses a distributed project lock', () => {
  assert.match(executor, /acquire_execution_sandbox_lock/);
  assert.match(executor, /release_execution_sandbox_lock/);
  assert.match(lockMigration, /execution_sandbox_locks/);
  assert.match(lockMigration, /on conflict \(project_id\)/i);
});

// Flaw 8: cleanup walks upward until the workspace boundary.
test('file deletion cleanup recursively removes newly-empty ancestors', () => {
  assert.match(runtimeHelpers, /while \[/);
  assert.match(runtimeHelpers, /dirname \"\$d\"/);
});
