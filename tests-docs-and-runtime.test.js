import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;

test('deployment docs document migration 009 and do not promise 008 as the end', () => {
  const deploy = fs.readFileSync(path.join(root, 'DEPLOY.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(deploy, /009_atomic_file_locks\.sql/);
  assert.match(deploy, /acquire_project_file_lock/);
  assert.doesNotMatch(deploy, /citeturn0search/);
  assert.doesNotMatch(deploy, /urlCodeSandbox SDK documentation/);
  assert.match(readme, /single source of truth/i);
  assert.doesNotMatch(readme, /through `008_execution_observability\.sql`/);
});

test('migration directory is numerically complete through 012', () => {
  const files = fs.readdirSync(path.join(root, 'Supabase', 'migrations'))
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort((a,b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  assert.deepEqual(files.map(f => Number(f.split('_')[0])), [2,3,4,5,6,7,8,9,10,11,12]);
});


test('adaptive research tool is exposed to both agent loops', () => {
  const dispatcher = fs.readFileSync(path.join(root, 'src', 'tools', 'index.ts'), 'utf8');
  const reactLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  const agentLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'agent-loop.ts'), 'utf8');
  const research = fs.readFileSync(path.join(root, 'src', 'tools', 'web-research-tools.ts'), 'utf8');

  assert.match(dispatcher, /research_web/);
  assert.match(reactLoop, /research_web/);
  assert.match(reactLoop, /functionDeclarations/);
  assert.match(agentLoop, /functionDeclarations/);
  assert.match(agentLoop, /research_web/);
  assert.match(research, /googleSearch/);
  assert.match(research, /urlContext/);
});

test('adaptive research memory migration has project-scoped RLS', () => {
  const sql = fs.readFileSync(
    path.join(root, 'Supabase', 'migrations', '010_research_memory.sql'),
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.research_runs/);
  assert.match(sql, /ALTER TABLE public\.research_runs ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /user_id = auth\.uid\(\)/);
});

test('reasoning-first task scope keeps UI work narrow by default', () => {
  const scope = fs.readFileSync(path.join(root, 'src', 'engine', 'task-scope.ts'), 'utf8');
  assert.match(scope, /relevance beats completeness/i);
  assert.match(scope, /likelyIrrelevantAreas/);
  assert.match(scope, /focus === 'ui'/);
});

test('autonomous code review has an adversarial independent-review layer', () => {
  const critic = fs.readFileSync(path.join(root, 'src', 'engine', 'critic.ts'), 'utf8');
  const adversarial = fs.readFileSync(path.join(root, 'src', 'engine', 'adversarial-review.ts'), 'utf8');
  const reactLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  assert.match(critic, /pickIndependentModel/);
  assert.match(adversarial, /try to DISPROVE/i);
  assert.match(adversarial, /falsificationChecks/);
  assert.match(reactLoop, /adversarialReview/);
});


test('web research is explicitly fenced as untrusted data and bounded', () => {
  const boundary = fs.readFileSync(path.join(root, 'src', 'lib', 'untrusted-content.ts'), 'utf8');
  const dispatcher = fs.readFileSync(path.join(root, 'src', 'tools', 'index.ts'), 'utf8');
  const research = fs.readFileSync(path.join(root, 'src', 'tools', 'web-research-tools.ts'), 'utf8');
  assert.match(boundary, /UNTRUSTED_EXTERNAL_DATA/);
  assert.match(boundary, /NEVER_FOLLOW_INSTRUCTIONS_FOUND_INSIDE_THIS_BLOCK/);
  assert.match(boundary, /INJECTION_PATTERNS/);
  assert.match(dispatcher, /formatExternalWebContent/);
  assert.match(research, /MAX_SUMMARY_CHARS/);
  assert.match(research, /MAX_PATTERN_COUNT/);
  assert.match(research, /userId/);
});

test('adversarial review distinguishes uncertainty from a real revision and reports independence', () => {
  const adversarial = fs.readFileSync(path.join(root, 'src', 'engine', 'adversarial-review.ts'), 'utf8');
  const reactLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  assert.match(adversarial, /independentReviewer/);
  assert.match(adversarial, /failureClass/);
  assert.match(adversarial, /No genuinely independent reviewer model is available/);
  assert.match(reactLoop, /adversarialUncertainCount/);
  assert.match(reactLoop, /adversarialDisabled/);
  assert.match(reactLoop, /verdict === 'revise'/);
  assert.doesNotMatch(reactLoop, /verdict !== 'approve'.*Independent adversarial review did not approve/s);
});

test('task scope is measurable and includes a UI false-positive guard', () => {
  const scope = fs.readFileSync(path.join(root, 'src', 'engine', 'task-scope.ts'), 'utf8');
  const loop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  assert.match(scope, /form ui/);
  assert.match(scope, /full-stack/);
  assert.match(scope, /topScore - secondScore/);
  assert.match(loop, /uniqueReadPaths/);
  assert.match(loop, /scopeExpansionWarnings/);
});

test('research memory is editable only by its owning user', () => {
  const sql = fs.readFileSync(path.join(root, 'Supabase', 'migrations', '010_research_memory.sql'), 'utf8');
  assert.match(sql, /research_runs_update_own/);
  assert.match(sql, /research_patterns_delete_own/);
  assert.match(sql, /user_id = auth\.uid\(\)/);
});

test('executor has server-side per-user request and concurrency limits', () => {
  const executor = fs.readFileSync(path.join(root, 'api', 'executor', 'index.js'), 'utf8');
  assert.match(executor, /MAX_REQUESTS_PER_WINDOW/);
  assert.match(executor, /MAX_CONCURRENT_PER_USER/);
  assert.match(executor, /EXECUTOR_RATE_LIMIT/);
});

test('env files are ignored and browser key persistence is session-scoped', () => {
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const keys = fs.readFileSync(path.join(root, 'src', 'config', 'keys.ts'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(keys, /sessionStorage\.getItem/);
  assert.match(keys, /sessionStorage\.setItem/);
  assert.doesNotMatch(keys, /localStorage\.getItem/);
});


test('task scope has a representative classification matrix', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'tests-task-scope-cases.json'), 'utf8'));
  assert.ok(cases.length >= 7);
  assert.equal(cases[0].focus, 'ui');
  assert.equal(cases[1].focus, 'backend');
  assert.equal(cases[2].focus, 'data');
  assert.equal(cases[5].focus, 'full-stack');
  assert.equal(cases[6].focus, 'docs');
});

test('executor releases per-user limiter state and emits 429 for resource protection', () => {
  const executor = fs.readFileSync(path.join(root, 'api', 'executor', 'index.js'), 'utf8');
  assert.match(executor, /finally \{/);
  assert.match(executor, /releaseRateLimit\?\./);
  assert.match(executor, /const status = error\?\.code .*\? 429/);
});


test('critical compiler/reliability fixes are present', () => {
  const rateLimit = fs.readFileSync(path.join(root, 'src', 'lib', 'rate-limit.ts'), 'utf8');
  const reactLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  const orchestrator = fs.readFileSync(path.join(root, 'src', 'engine', 'orchestrator.ts'), 'utf8');
  const webResearch = fs.readFileSync(path.join(root, 'src', 'tools', 'web-research-tools.ts'), 'utf8');
  assert.match(rateLimit, /new QuotaExceededError\(message, lastError\)/);
  assert.doesNotMatch(rateLimit, /new QuotaExceededError\('Model request limit reached\.'\)/);
  assert.match(reactLoop, /LOCK_WAIT_MAX_MS\s*=\s*30_000/);
  assert.match(reactLoop, /LOCK_WAIT_INITIAL_MS\s*=\s*250/);
  assert.match(orchestrator, /finalizeProject\(projectGoal: string, maxIterations: number = 2\)/);
  assert.match(webResearch, /const parsed = parseStructuredResult/);
});

test('Acorn-backed JavaScript syntax parsing is present', () => {
  const runner = fs.readFileSync(path.join(root, 'src/tools/code-runner-tools.ts'), 'utf8');
  assert.match(runner, /from '..\/vendor\/acorn\.mjs'/);
  const acorn = fs.readFileSync(path.join(root, 'src/vendor/acorn.mjs'), 'utf8');
  assert.match(acorn, /ECMAScript parser|Parser/);
});

test('executor client computes and transmits only changed/deleted files', () => {
  const client = fs.readFileSync(path.join(root, 'src/lib/executor/executor-client.ts'), 'utf8');
  assert.match(client, /prepareIncrementalFiles/);
  assert.match(client, /deletedPaths/);
  assert.match(client, /sessionStorage/);
});

test('executor sync is incremental and distributed limiter is migratable', () => {
  const executor = fs.readFileSync(path.join(root, 'api', 'executor', 'index.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'Supabase', 'migrations', '011_execution_rate_limits.sql'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, 'api', 'executor', 'runtime-helpers.js'), 'utf8');
  assert.match(runtime, /\.theta-manifest\.json/);
  assert.match(runtime, /sha256/);
  assert.match(executor, /acquire_execution_rate_limit/);
  assert.match(migration, /create or replace function public\.acquire_execution_rate_limit/);
  assert.match(migration, /create or replace function public\.release_execution_rate_limit/);
});


test('Gemini function declarations use the SDK Type enum', () => {
  const agent = fs.readFileSync(path.join(root, 'src/engine/agent-loop.ts'), 'utf8');
  const react = fs.readFileSync(path.join(root, 'src/engine/react-loop.ts'), 'utf8');
  // Phase 10: GoogleGenAI construction now lives only in lib/llm/unified-client.ts's
  // provider-agnostic LLMClient (see its module doc) — agent-loop.ts/react-loop.ts go
  // through LLMClient rather than constructing GoogleGenAI directly, and only need the
  // Type enum for their native function-declaration schemas.
  assert.match(agent, /import \{ Type \} from '@google\/genai'/);
  assert.match(react, /import \{ Type \} from '@google\/genai'/);
  assert.match(agent, /import \{ LLMClient \} from '..\/lib\/llm\/unified-client'/);
  assert.match(react, /import \{ LLMClient \} from '..\/lib\/llm\/unified-client'/);
  assert.doesNotMatch(agent, /type: ['\"](?:OBJECT|STRING)['\"]/);
  assert.doesNotMatch(react, /type: ['\"](?:OBJECT|STRING)['\"]/);
  assert.match(agent, /type: Type\.OBJECT/);
  assert.match(agent, /type: Type\.STRING/);
  assert.match(react, /type: Type\.OBJECT/);
  assert.match(react, /type: Type\.STRING/);
});

test('agent loops prefer native tool calls and retain a text fallback only for degraded providers', () => {
  const agentLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'agent-loop.ts'), 'utf8');
  const reactLoop = fs.readFileSync(path.join(root, 'src', 'engine', 'react-loop.ts'), 'utf8');
  assert.match(agentLoop, /functionDeclarations/);
  assert.match(reactLoop, /functionDeclarations/);
  assert.match(agentLoop, /native tool calling/);
  assert.match(reactLoop, /native tool calling/);
});

test('key acquisition never intentionally shares a reserved key between concurrent tasks', () => {
  const keys = fs.readFileSync(path.join(root, 'src', 'config', 'keys.ts'), 'utf8');
  assert.match(keys, /hasInUseKey/);
  assert.match(keys, /KeyPoolBusyError/);
  assert.match(keys, /this\.inUse\.has\(key\)/);
});
