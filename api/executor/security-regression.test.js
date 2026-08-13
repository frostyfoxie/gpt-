import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const schema = fs.readFileSync(new URL('Supabase/schema.sql', root), 'utf8');
const migration = fs.readFileSync(new URL('Supabase/migrations/002_auth_and_projects.sql', root), 'utf8');
const workflow = new URL('../../.github/workflows/theta-behavior-check.yml', import.meta.url);

test('baseline schema has RLS enabled without anonymous allow policies', () => {
  assert.match(schema, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(schema, /CREATE POLICY "Allow anon/);
  assert.doesNotMatch(schema, /USING \(true\)/);
});

test('auth migration contains project-owner scoping', () => {
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /project_id IN \(SELECT id FROM public\.projects/);
});

test('orphaned behavior-check workflow is not shipped', () => {
  assert.equal(fs.existsSync(workflow), false);
});
